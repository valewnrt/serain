import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { FakeApprovalStore } from "./approvals-store.fake.js";
import { FakeScheduleStore } from "./schedule-store.fake.js";

const auditMock = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock("../src/db/audit.js", () => ({ audit: (...args: unknown[]) => auditMock(...args) }));

const { ApprovalService } = await import("../src/security/approvals.js");
const { parseLater, formatLater } = await import("../src/security/later.js");
const { ToolRegistry } = await import("../src/agent/tools/registry.js");
const { defineTool, TurnState } = await import("../src/agent/tools/types.js");
const { MAX_SCHEDULED_APPROVALS } = await import("../src/config/limits.js");
const { scheduleTools } = await import("../src/agent/tools/schedule.js");

/**
 * "ja, aber morgen um 8" ("yes, but tomorrow at 8", addendum D14 of 2026-10-08).
 * Mostly tested is what must not happen: running too early, running twice,
 * running after a cancellation or the kill switch, running with other
 * arguments or another mailbox, scheduling money.
 */

// Thursday, 08.10.2026, 19:00 in Berlin (summer time, UTC+2).
const THURSDAY_19 = new Date("2026-10-08T17:00:00Z");

const at = (iso: string) => new Date(iso).toISOString();

describe("parseLater", () => {
  const ok = (text: string, now = THURSDAY_19) => {
    const parsed = parseLater(text, now);
    expect(parsed?.ok, text).toBe(true);
    return parsed?.at.toISOString();
  };

  it("reads day and time in local wall time", () => {
    expect(ok("ja morgen um 8")).toBe(at("2026-10-09T06:00:00Z"));
    expect(ok("Ja, aber erst morgen um 8!")).toBe(at("2026-10-09T06:00:00Z"));
    expect(ok("ok übermorgen 9:30")).toBe(at("2026-10-10T07:30:00Z"));
    expect(ok("ja am 12.10. um 10")).toBe(at("2026-10-12T08:00:00Z"));
    expect(ok("passt, 12.10.2026 10:15 uhr")).toBe(at("2026-10-12T08:15:00Z"));
    expect(ok("ja bitte heute um 21 uhr")).toBe(at("2026-10-08T19:00:00Z"));
  });

  it("takes \"um 8\" as 08:00 and without a day the next such time", () => {
    expect(ok("ja um 8")).toBe(at("2026-10-09T06:00:00Z"));
    expect(ok("ok um 20 Uhr")).toBe(at("2026-10-08T18:00:00Z"));
    expect(ok("ja 22:45")).toBe(at("2026-10-08T20:45:00Z"));
  });

  it("takes the next weekday, today only if the time is still ahead", () => {
    expect(ok("ja montag um 7")).toBe(at("2026-10-12T05:00:00Z"));
    expect(ok("ja do um 20")).toBe(at("2026-10-08T18:00:00Z"));
    expect(ok("ja am donnerstag um 18")).toBe(at("2026-10-15T16:00:00Z"));
  });

  it("computes relative minutes and hours", () => {
    expect(ok("ja in 2 stunden")).toBe(at("2026-10-08T19:00:00Z"));
    expect(ok("ja in 45 min")).toBe(at("2026-10-08T17:45:00Z"));
    expect(ok("jo in 3h")).toBe(at("2026-10-08T20:00:00Z"));
  });

  it("computes across the clock change in wall time", () => {
    // Saturday, 24.10.2026, 12:00 summer time; on Sunday UTC+1 applies again.
    expect(ok("ja morgen um 8", new Date("2026-10-24T10:00:00Z"))).toBe(at("2026-10-25T07:00:00Z"));
  });

  it("says why a recognised time does not work", () => {
    expect(parseLater("ja heute um 8", THURSDAY_19)).toMatchObject({ ok: false, reason: "past" });
    expect(parseLater("ja in 1 min", THURSDAY_19)).toMatchObject({ ok: false, reason: "too_soon" });
    expect(parseLater("ja am 20.10. um 8", THURSDAY_19)).toMatchObject({ ok: false, reason: "too_far" });
    expect(parseLater("ja in 200 stunden", THURSDAY_19)).toMatchObject({ ok: false, reason: "too_far" });
  });

  it("is no decision for anything else", () => {
    for (const text of [
      "ja",
      "ja morgen",
      "ja morgen früh",
      "ja aber erst nach dem call",
      "morgen um 8",
      "ja 8",
      "ja um 25",
      "ja um 8:61",
      "ja immer morgen um 8",
      "ja am 31.02. um 8",
      "ja morgen um 8 und ändere den betreff",
      "nein morgen um 8",
      "ja in 0 min",
      // Otherwise valid, but too long: the regex never sees a long text.
      `ja,${" aber".repeat(16)} morgen um 8`,
    ]) {
      expect(parseLater(text, THURSDAY_19), text).toBeNull();
    }
  });

  it("writes the time the way Alex reads it", () => {
    expect(formatLater(new Date("2026-10-09T06:00:00Z"))).toBe("Fr., 09.10. um 08:00");
  });
});

/** What a mail is for testing: schema normalises, default mailbox, attachments. */
let sent: Array<Record<string, unknown>> = [];
let primary = { id: "gmx", address: "alex@gmx.example" };
let costsMoney = false;
let laterAllowed = true;

function mailTool() {
  return defineTool({
    name: "send_mail",
    description: "Sends a mail.",
    level: "irreversible",
    schema: {
      account: z.string().optional(),
      to: z.string().trim().toLowerCase(),
      body: z.string(),
      files: z.array(z.string()).default([]),
    },
    consequence: () => (costsMoney ? "money" : "irreversible"),
    confirm: {
      preview: (args) => `Mail von ${args.account ?? primary.address} an ${args.to}: ${args.body}`,
      undo: () => "gibt es nicht",
      ...(laterAllowed
        ? {
            later: {
              pin: (args: { account?: string | undefined }) =>
                args.account ? { account: args.account } : { account: primary.id, address: primary.address },
              refuse: (args: { files: string[] }) =>
                args.files.length > 0 ? { reason: "files", text: "Mit Anhang nur sofort." } : null,
            },
          }
        : {}),
    },
    async run(args) {
      sent.push(args);
      return { ok: true, text: "Mail is out." };
    },
  });
}

const pay = defineTool({
  name: "pay",
  description: "Pays.",
  level: "money",
  schema: { amount: z.number() },
  confirm: { preview: (args) => `Zahle ${args.amount} €`, undo: () => "nein", later: { pin: () => ({}) } },
  async run() {
    return { ok: true, text: "paid" };
  },
});

function rig() {
  const store = new FakeApprovalStore();
  const clock = { now: THURSDAY_19 };
  let previews = 0;
  let registry!: InstanceType<typeof ToolRegistry>;
  const service = new ApprovalService({
    store,
    now: () => clock.now,
    async sendPreview() {
      previews += 1;
      return { externalId: `preview-${previews}`, messageId: `db-preview-${previews}` };
    },
    later: (tool) => registry.laterSpec(tool),
  });
  registry = new ToolRegistry(service, () => halted).registerAll([mailTool(), pay]);
  return { store, service, registry, clock };
}

let halted = false;
const turn = () =>
  new TurnState({ origin: "owner_message", triggerExternalId: "m-1", triggerMessageId: "db-1", reactableIds: ["m-1"] });
const approvalTurn = () => new TurnState({ origin: "approval", triggerExternalId: "preview-1", triggerMessageId: "", reactableIds: [] });

beforeEach(() => {
  auditMock.mockClear();
  sent = [];
  primary = { id: "gmx", address: "alex@gmx.example" };
  costsMoney = false;
  laterAllowed = true;
  halted = false;
});

async function scheduled(text = "ja morgen um 8", args: Record<string, unknown> = { to: "hi@serain.example.com", body: "Test" }) {
  const r = rig();
  await r.registry.execute("send_mail", args, turn());
  const parse = parseLater(text, r.clock.now);
  if (!parse) throw new Error(`no time: ${text}`);
  const outcome = await r.service.scheduleLater({ previewExternalId: "preview-1", parse, decisionMessageId: "db-ja", taintSources: ["mail from x"] });
  return { ...r, outcome };
}

/** Runs the clock and executes what is due, like the runtime's tick. */
async function tick(r: Awaited<ReturnType<typeof scheduled>>, to: Date) {
  r.clock.now = to;
  const results = [];
  for (const due of await r.service.dueLater()) {
    if (due.kind === "missed") {
      results.push({ kind: "missed" as const });
      continue;
    }
    const result = await r.registry.executeApproved(due.approval, approvalTurn());
    await r.service.complete(due.approval, result);
    results.push({ kind: "due" as const, result });
  }
  return results;
}

describe("Scheduling", () => {
  it("schedules, states the resolved time and runs nothing before", async () => {
    const r = await scheduled();
    expect(r.outcome).toMatchObject({ kind: "scheduled", text: "ok, geht Fr., 09.10. um 08:00 raus. bis dahin reicht „nein“ hier im thread." });
    const row = r.store.rows[0];
    expect(row?.status).toBe("scheduled");
    expect(row?.executeAt).toBe(at("2026-10-09T06:00:00Z"));
    expect(row?.laterPin).toEqual({ account: "gmx", address: "alex@gmx.example" });
    expect(row?.taintSources).toEqual(["mail from x"]);
    expect(await tick(r, new Date("2026-10-09T05:59:59Z"))).toEqual([]);
    expect(sent).toHaveLength(0);
    expect(auditMock).toHaveBeenCalledWith("approval_scheduled", expect.objectContaining({ tool: "send_mail", execute_at: row?.executeAt }), "db-ja");
  });

  it("runs exactly the stored arguments exactly once at the time", async () => {
    const r = await scheduled();
    const [first] = await tick(r, new Date("2026-10-09T06:00:20Z"));
    expect(first).toMatchObject({ kind: "due", result: { ok: true } });
    expect(sent).toEqual([{ to: "hi@serain.example.com", body: "Test", files: [] }]);
    expect(r.store.rows[0]?.status).toBe("executed");
    expect(await tick(r, new Date("2026-10-09T06:01:00Z"))).toEqual([]);
    expect(sent).toHaveLength(1);
  });

  it("leaves missed what would be more than 30 min late", async () => {
    const r = await scheduled();
    expect(await tick(r, new Date("2026-10-09T06:31:00Z"))).toEqual([{ kind: "missed" }]);
    expect(sent).toHaveLength(0);
    expect(r.store.rows[0]?.status).toBe("failed");
    expect(auditMock).toHaveBeenCalledWith("approval_missed", expect.objectContaining({ tool: "send_mail" }));
  });

  it("cancels with \"nein\" in the thread, a \"ja\" after that does nothing", async () => {
    const r = await scheduled();
    const yes = await r.service.decide({ previewExternalId: "preview-1", decision: "approve", via: "thread_reply", decisionMessageId: null });
    expect(yes.kind).toBe("none");
    const no = await r.service.decide({ previewExternalId: "preview-1", decision: "deny", via: "thread_reply", decisionMessageId: "db-nein" });
    expect(no.kind).toBe("cancelled");
    expect(await tick(r, new Date("2026-10-09T06:05:00Z"))).toEqual([]);
    expect(sent).toHaveLength(0);
  });

  it("cancels via the id from the overview", async () => {
    const r = await scheduled();
    expect(await r.service.scheduled()).toHaveLength(1);
    expect(await r.service.cancelScheduled(r.store.rows[0]?.id ?? "", "cancel_schedule")).not.toBeNull();
    expect(await r.service.cancelScheduled(r.store.rows[0]?.id ?? "", "cancel_schedule")).toBeNull();
    expect(await r.service.scheduled()).toHaveLength(0);
  });

  it("cancels everything scheduled with the kill switch instead of pausing it", async () => {
    const r = await scheduled();
    expect(await r.service.cancelAll("kill_switch")).toEqual({ expired: 0, cancelled: 1 });
    expect(r.store.cancelledVia.get(r.store.rows[0]?.id ?? "")).toBe("kill_switch");
    expect(await tick(r, new Date("2026-10-09T06:00:20Z"))).toEqual([]);
    expect(sent).toHaveLength(0);
  });

  it("does not run when the kill switch engages in the second of execution", async () => {
    const r = await scheduled();
    halted = true;
    const [first] = await tick(r, new Date("2026-10-09T06:00:20Z"));
    expect(first).toMatchObject({ kind: "due", result: { ok: false } });
    expect(sent).toHaveLength(0);
  });

  it("does not run when the default mailbox has changed in the meantime", async () => {
    const r = await scheduled();
    primary = { id: "gmail", address: "alex@gmail.example" };
    const [first] = await tick(r, new Date("2026-10-09T06:00:20Z"));
    expect(first).toMatchObject({ kind: "due", result: { ok: false } });
    expect(sent).toHaveLength(0);
    expect(auditMock).toHaveBeenCalledWith("tool_denied", expect.objectContaining({ reason: "pin_changed" }), "");
  });

  it("does not run when the schema reads the arguments differently today", async () => {
    const r = await scheduled();
    const row = r.store.rows[0];
    if (row) row.args = { ...row.args, to: " HI@serain.example.com" };
    const [first] = await tick(r, new Date("2026-10-09T06:00:20Z"));
    expect(first).toMatchObject({ kind: "due", result: { ok: false } });
    expect(auditMock).toHaveBeenCalledWith("tool_denied", expect.objectContaining({ reason: "args_changed" }), "");
    expect(sent).toHaveLength(0);
  });

  it("does not run when it costs money by then", async () => {
    const r = await scheduled();
    costsMoney = true;
    const [first] = await tick(r, new Date("2026-10-09T06:00:20Z"));
    expect(first).toMatchObject({ kind: "due", result: { ok: false } });
    expect(auditMock).toHaveBeenCalledWith("tool_denied", expect.objectContaining({ reason: "money_later" }), "");
    expect(sent).toHaveLength(0);
  });

  it("does not run when the tool may only run immediately by then", async () => {
    const r = await scheduled();
    laterAllowed = false;
    r.registry.unregister(["send_mail"]);
    r.registry.register(mailTool());
    const [first] = await tick(r, new Date("2026-10-09T06:00:20Z"));
    expect(first).toMatchObject({ kind: "due", result: { ok: false } });
    expect(auditMock).toHaveBeenCalledWith("tool_denied", expect.objectContaining({ reason: "later_not_supported" }), "");
  });

  it("leaves the preview open when the time does not work, and says why", async () => {
    const r = await scheduled("ja heute um 8");
    expect(r.outcome).toMatchObject({ kind: "refused", reason: "past" });
    expect(r.outcome.kind === "refused" && r.outcome.text).toContain("ist schon vorbei");
    expect(r.store.rows[0]?.status).toBe("pending");
    const now = await r.service.decide({ previewExternalId: "preview-1", decision: "approve", via: "thread_reply", decisionMessageId: null });
    expect(now.kind).toBe("approved");
  });

  it("does not schedule with an attachment", async () => {
    const r = await scheduled("ja morgen um 8", { to: "hi@serain.example.com", body: "Test", files: ["f-1"] });
    expect(r.outcome).toMatchObject({ kind: "refused", reason: "files", text: "Mit Anhang nur sofort." });
    expect(r.store.rows[0]?.status).toBe("pending");
  });

  it("does not schedule a tool without `later`", async () => {
    laterAllowed = false;
    const r = await scheduled();
    expect(r.outcome).toMatchObject({ kind: "refused", reason: "not_supported" });
  });

  it("never schedules money, even if the tool names `later`", async () => {
    const r = rig();
    await r.registry.execute("pay", { amount: 5 }, turn());
    const parse = parseLater("ja morgen um 8", r.clock.now);
    if (!parse) throw new Error("no time");
    const outcome = await r.service.scheduleLater({ previewExternalId: "preview-1", parse, decisionMessageId: null, taintSources: [] });
    expect(outcome).toMatchObject({ kind: "refused", reason: "not_supported" });
    expect(r.store.rows[0]?.status).toBe("pending");
  });

  it("caps the scheduled ones", async () => {
    const r = rig();
    const parse = parseLater("ja morgen um 8", r.clock.now);
    if (!parse) throw new Error("no time");
    for (let i = 1; i <= MAX_SCHEDULED_APPROVALS + 1; i += 1) {
      await r.registry.execute("send_mail", { to: `a${i}@x.de`, body: "x" }, turn());
      const outcome = await r.service.scheduleLater({ previewExternalId: `preview-${i}`, parse, decisionMessageId: null, taintSources: [] });
      expect(outcome.kind).toBe(i <= MAX_SCHEDULED_APPROVALS ? "scheduled" : "refused");
      // Scheduled ones do not count against the open previews.
      if (i <= MAX_SCHEDULED_APPROVALS) expect(r.store.rows.filter((row) => row.status === "pending")).toHaveLength(0);
    }
  });

  it("no longer schedules an expired preview", async () => {
    const r = rig();
    await r.registry.execute("send_mail", { to: "a@x.de", body: "x" }, turn());
    r.clock.now = new Date(r.clock.now.getTime() + 31 * 60_000);
    const parse = parseLater("ja morgen um 8", r.clock.now);
    if (!parse) throw new Error("no time");
    const outcome = await r.service.scheduleLater({ previewExternalId: "preview-1", parse, decisionMessageId: null, taintSources: [] });
    expect(outcome.kind).toBe("none");
  });

  it("cancels via cancel_schedule, but only on Alex's word", async () => {
    const r = await scheduled();
    const tools = new ToolRegistry().registerAll(
      scheduleTools({
        store: new FakeScheduleStore(),
        cancelApproval: async (approvalId, messageId) => (await r.service.cancelScheduled(approvalId, "cancel_schedule", messageId)) !== null,
      }),
    );
    const uuid = "00000000-0000-4000-8000-000000000001";
    const row = r.store.rows[0];
    if (row) row.id = uuid;
    const mail = new TurnState({ origin: "untrusted", triggerExternalId: "", triggerMessageId: "", reactableIds: [] });
    expect((await tools.execute("cancel_schedule", { id: uuid }, mail)).ok).toBe(false);
    expect(r.store.rows[0]?.status).toBe("scheduled");
    const result = await tools.execute("cancel_schedule", { id: uuid }, turn());
    expect(result.ok).toBe(true);
    expect(result.text).toContain("Cancelled, it will not run.");
    expect(r.store.rows[0]?.status).toBe("cancelled");
  });
});
