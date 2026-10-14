import { beforeEach, describe, expect, it, vi } from "vitest";

const auditMock = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock("../src/db/audit.js", () => ({ audit: (...args: unknown[]) => auditMock(...args) }));

const { feedbackTools } = await import("../src/agent/tools/give-feedback.js");
const { ToolRegistry } = await import("../src/agent/tools/registry.js");
const { TurnState } = await import("../src/agent/tools/types.js");
const { FEEDBACK_MAX_PER_DAY } = await import("../src/config/limits.js");

/**
 * `give_feedback` (package 2 of 2026-10-08): an entry in the audit log under
 * `feedback`, with taint, capped per day, and never an answer to the owner.
 */

function rig(today = 0) {
  let count = today;
  const registry = new ToolRegistry().registerAll(feedbackTools({ countToday: async () => count }));
  const run = (args: Record<string, unknown>, origin: "owner_message" | "untrusted" = "owner_message", taintSources: string[] = []) =>
    registry.execute("give_feedback", args, new TurnState({ origin, triggerExternalId: "m-1", triggerMessageId: "db-1", reactableIds: [], taintSources }));
  return { run, setCount: (next: number) => void (count = next) };
}

const feedbackCalls = () => auditMock.mock.calls.filter(([event]) => event === "feedback");

beforeEach(() => auditMock.mockClear());

describe("give_feedback", () => {
  it("writes kind, description and origin into the audit log and tells the model it is no answer", async () => {
    const { run } = rig();
    const result = await run({ kind: "feature", description: "Kann keine PDF-Formulare ausfüllen, Alex wollte den Antrag." });
    expect(result.ok).toBe(true);
    expect(result.text).toContain("it replaces no answer");
    expect(feedbackCalls()).toEqual([
      ["feedback", { kind: "feature", description: "Kann keine PDF-Formulare ausfüllen, Alex wollte den Antrag.", origin: "owner_message", tainted: false }, "db-1"],
    ]);
  });

  it("works after untrusted content too and records the source", async () => {
    const { run } = rig();
    const result = await run({ kind: "bug", description: "mail_read lieferte den Anhang nicht mit." }, "owner_message", ["Mail von bahn.de"]);
    expect(result.ok).toBe(true);
    expect(feedbackCalls()[0]?.[1]).toMatchObject({ tainted: true, taint_sources: ["Mail von bahn.de"] });
  });

  it(`accepts at most ${FEEDBACK_MAX_PER_DAY} a day`, async () => {
    const { run } = rig(FEEDBACK_MAX_PER_DAY);
    const result = await run({ kind: "feature", description: "Noch ein Wunsch, der nicht mehr auf die Liste passt." });
    expect(result.ok).toBe(false);
    expect(feedbackCalls()).toHaveLength(0);
  });

  it("requires a real description and a known kind", async () => {
    const { run } = rig();
    expect((await run({ kind: "feature", description: "kurz" })).ok).toBe(false);
    expect((await run({ kind: "wunsch", description: "Eine Beschreibung, die lang genug ist." })).ok).toBe(false);
    expect(feedbackCalls()).toHaveLength(0);
  });
});
