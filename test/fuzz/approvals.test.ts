import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { FakeApprovalStore } from "../approvals-store.fake.js";
import { hostileString, params } from "./helpers.js";

vi.mock("../../src/db/audit.js", () => ({ audit: async () => undefined }));

const { ApprovalService } = await import("../../src/security/approvals.js");
const { parseLater } = await import("../../src/security/later.js");
const { ToolRegistry } = await import("../../src/agent/tools/registry.js");
const { defineTool, TurnState } = await import("../../src/agent/tools/types.js");
const { APPROVAL_LATER_GRACE_MS, APPROVAL_LATER_MAX_MS, APPROVAL_LATER_MIN_MS, MAX_SCHEDULED_APPROVALS } = await import(
  "../../src/config/limits.js"
);

/**
 * "ja, aber morgen um 8" (addendum D14 of 2026-10-08) at the trust boundary:
 * Alex's text is read by regex before a model sees it, and a
 * scheduled action is one that runs later without a new question. Fuzzed are
 * the parser on arbitrary text and the whole life cycle of a confirmation with
 * a random order of scheduling, approving, declining, cancelling,
 * kill switch, mailbox switch and clock.
 */

const NOW = new Date("2026-10-08T17:00:00Z");
// German and English consent words (src/i18n/messages/words.ts): only those two languages have "later".
const CONSENT = /^(ja|jo|jep|jap|ok|okay|mach|passt|yes|yep|yeah|yup|sure|go\s+ahead|do\s+it)\b/i;

const phrase = fc
  .tuple(
    fc.constantFrom("ja", "Ja", "ok", "okay", "passt", "mach"),
    fc.constantFrom("", ",", ", aber", " aber erst", " bitte"),
    fc.oneof(
      fc.tuple(fc.integer({ min: 1, max: 400 }), fc.constantFrom("min", "minuten", "h", "std", "stunden")).map(([n, unit]) => `in ${n} ${unit}`),
      fc
        .tuple(
          fc.constantFrom("", "heute ", "morgen ", "übermorgen ", "montag ", "am fr ", "so ", "am 12.10. ", "13.10.2026 "),
          fc.integer({ min: 0, max: 23 }),
          fc.option(fc.integer({ min: 0, max: 59 }), { nil: undefined }),
          fc.boolean(),
        )
        .map(([day, hour, minute, uhr]) =>
          minute === undefined ? `${day}um ${hour}${uhr ? " uhr" : ""}` : `${day}${uhr ? "um " : ""}${hour}:${String(minute).padStart(2, "0")}`,
        ),
    ),
    fc.constantFrom("", ".", "!", " "),
  )
  .map(([consent, filler, when, end]) => `${consent}${filler} ${when}${end}`);

describe("parseLater", () => {
  it("never throws, needs a consent word and keeps the bounds", () => {
    fc.assert(
      fc.property(fc.oneof(hostileString, phrase, phrase.map((text) => `${text} ${"x".repeat(5)}`)), fc.integer({ min: 0, max: 400 * 86_400_000 }), (text, offset) => {
        const now = new Date(NOW.getTime() + offset);
        const parsed = parseLater(text, now);
        if (!parsed) return;
        expect(CONSENT.test(text.trim()), text).toBe(true);
        expect(Number.isNaN(parsed.at.getTime())).toBe(false);
        const ahead = parsed.at.getTime() - now.getTime();
        if (parsed.ok) {
          expect(ahead).toBeGreaterThanOrEqual(APPROVAL_LATER_MIN_MS);
          expect(ahead).toBeLessThanOrEqual(APPROVAL_LATER_MAX_MS);
        }
      }),
      params(2_000),
    );
  });

  it("understands every form of the grammar", () => {
    fc.assert(
      fc.property(phrase, (text) => {
        expect(parseLater(text, NOW), text).not.toBeNull();
      }),
      params(1_000),
    );
  });

  it("stays fast on long text (ReDoS)", () => {
    for (const text of ["ja" + ", aber".repeat(20_000), "ja " + "1".repeat(50_000), "ja in " + "9".repeat(50_000) + " min", `ja ${" ".repeat(60_000)}um 8`]) {
      const started = performance.now();
      expect(parseLater(text, NOW)).toBeNull();
      expect(performance.now() - started).toBeLessThan(50);
    }
  });
});

type Op =
  | { kind: "request" }
  | { kind: "later"; target: number; text: string }
  | { kind: "decide"; target: number; decision: "approve" | "deny" }
  | { kind: "cancel"; target: number }
  | { kind: "kill" }
  | { kind: "switch" }
  | { kind: "wait"; minutes: number };

const op: fc.Arbitrary<Op> = fc.oneof(
  { weight: 3, arbitrary: fc.constant({ kind: "request" as const }) },
  { weight: 4, arbitrary: fc.record({ kind: fc.constant("later" as const), target: fc.nat(8), text: fc.oneof(
        { weight: 3, arbitrary: fc.integer({ min: 1, max: 80 }).map((n) => `ja in ${n} min`) },
        { weight: 2, arbitrary: phrase },
        { weight: 1, arbitrary: hostileString },
      ) }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("decide" as const), target: fc.nat(8), decision: fc.constantFrom("approve" as const, "deny" as const) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("cancel" as const), target: fc.nat(8) }) },
  { weight: 1, arbitrary: fc.constant({ kind: "kill" as const }) },
  { weight: 3, arbitrary: fc.constant({ kind: "switch" as const }) },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant("wait" as const), minutes: fc.integer({ min: 0, max: 90 }) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("wait" as const), minutes: fc.integer({ min: 0, max: 3 * 24 * 60 }) }) },
);

describe("life cycle of a scheduled confirmation", () => {
  const coverage = { scheduled: 0, ranLater: 0, blockedLater: 0 };

  it("runs at most once, never too early, never after cancellation, denial or kill switch, never with another mailbox", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(op, { minLength: 1, maxLength: 30 }), async (ops) => {
        const clock = { now: NOW };
        let primary = "gmx";
        const runs: Array<{ n: number; at: number; account: string }> = [];
        const store = new FakeApprovalStore();
        let registry!: InstanceType<typeof ToolRegistry>;
        let previews = 0;
        const service = new ApprovalService({
          store,
          now: () => clock.now,
          async sendPreview() {
            previews += 1;
            return { externalId: `p-${previews}`, messageId: `db-${previews}` };
          },
          later: (tool) => registry.laterSpec(tool),
        });
        const send = defineTool({
          name: "send_mail",
          description: "x",
          level: "irreversible",
          schema: { n: z.number().int(), account: z.string().optional() },
          confirm: {
            preview: (args) => `Mail ${args.n}`,
            undo: () => "no",
            later: { pin: (args) => ({ account: args.account ?? primary }) },
          },
          async run(args) {
            runs.push({ n: args.n, at: clock.now.getTime(), account: args.account ?? primary });
            return { ok: true, text: "out" };
          },
        });
        registry = new ToolRegistry(service).registerAll([send]);
        const turn = () => new TurnState({ origin: "owner_message", triggerExternalId: "m", triggerMessageId: "d", reactableIds: [] });

        /** Per mail: when it may run at the earliest, whether it may no longer run at all, with which mailbox. */
        const plan = new Map<number, { earliest: number | null; dead: boolean; account: string | null }>();

        const runDue = async () => {
          for (const due of await service.dueLater()) {
            if (due.kind === "missed") continue;
            const result = await registry.executeApproved(due.approval, turn());
            coverage[result.ok ? "ranLater" : "blockedLater"] += 1;
            await service.complete(due.approval, result);
          }
        };

        for (const raw of ops) {
          // Mostly target the latest previews, so that the paths are actually taken.
          const step = "target" in raw ? { ...raw, target: previews === 0 ? raw.target : previews - (raw.target % previews) } : raw;
          switch (step.kind) {
            case "request":
              await registry.execute("send_mail", { n: previews + 1 }, turn());
              plan.set(previews, { earliest: null, dead: false, account: null });
              break;
            case "later": {
              const parse = parseLater(step.text, clock.now);
              if (!parse) break;
              const outcome = await service.scheduleLater({ previewExternalId: `p-${step.target}`, parse, decisionMessageId: null, taintSources: [] });
              if (outcome.kind === "scheduled") {
                coverage.scheduled += 1;
                const entry = plan.get(step.target);
                if (entry) Object.assign(entry, { earliest: outcome.at.getTime(), account: primary });
              }
              break;
            }
            case "decide": {
              const outcome = await service.decide({ previewExternalId: `p-${step.target}`, decision: step.decision, via: "thread_reply", decisionMessageId: null });
              const entry = plan.get(step.target);
              if (outcome.kind === "cancelled" || outcome.kind === "denied") {
                if (entry) entry.dead = true;
              } else if (outcome.kind === "approved") {
                if (entry) Object.assign(entry, { earliest: clock.now.getTime(), account: primary });
                const result = await registry.executeApproved(outcome.approval, turn());
                await service.complete(outcome.approval, result);
              }
              break;
            }
            case "cancel": {
              const row = store.rows.find((entry) => entry.previewExternalId === `p-${step.target}`);
              if (row && (await service.cancelScheduled(row.id, "cancel_schedule"))) {
                const entry = plan.get(step.target);
                if (entry) entry.dead = true;
              }
              break;
            }
            case "kill":
              await service.cancelAll("kill_switch");
              for (const [n, entry] of plan) {
                const row = store.rows.find((candidate) => candidate.previewExternalId === `p-${n}`);
                if (row?.status === "cancelled" || row?.status === "expired") entry.dead = true;
              }
              break;
            case "switch":
              primary = primary === "gmx" ? "gmail" : "gmx";
              break;
            case "wait":
              // In steps, like the tick: this also shows what still runs within the grace window.
              for (let left = step.minutes; left > 0; left -= 20) {
                clock.now = new Date(clock.now.getTime() + Math.min(left, 20) * 60_000);
                await runDue();
              }
              await service.expireDue();
              break;
          }
          expect(await store.countScheduled()).toBeLessThanOrEqual(MAX_SCHEDULED_APPROVALS);
        }

        // At the end the clock runs up to everything still scheduled.
        for (const row of await store.scheduled()) {
          const due = Date.parse(row.executeAt ?? "");
          if (due > clock.now.getTime()) clock.now = new Date(due);
          await runDue();
        }

        const seen = new Set<number>();
        for (const run of runs) {
          expect(seen.has(run.n), `mail ${run.n} twice`).toBe(false);
          seen.add(run.n);
          const entry = plan.get(run.n);
          expect(entry, `mail ${run.n} without preview`).toBeDefined();
          if (!entry) continue;
          expect(entry.dead, `mail ${run.n} after cancellation`).toBe(false);
          expect(entry.earliest, `mail ${run.n} without approval`).not.toBeNull();
          expect(run.at).toBeGreaterThanOrEqual(entry.earliest ?? Infinity);
          expect(run.at - (entry.earliest ?? 0)).toBeLessThanOrEqual(APPROVAL_LATER_GRACE_MS + 20 * 60_000);
          expect(run.account, `mail ${run.n} with another mailbox`).toBe(entry.account);
        }
        // Nothing got stuck in an intermediate state.
        expect(store.rows.some((row) => row.status === "approved")).toBe(false);
      }),
      params(300),
    );
    // The fuzzer should really take the paths, not just fail at the grammar.
    expect(coverage.scheduled).toBeGreaterThan(20);
    expect(coverage.ranLater).toBeGreaterThan(20);
    expect(coverage.blockedLater).toBeGreaterThan(0);
  });
});
