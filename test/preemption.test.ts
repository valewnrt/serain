import { describe, expect, it, vi } from "vitest";

/**
 * Preemption of a turn by a late message (D50), checked at the registry: the
 * turn commits before every tool with an effect, in the same synchronous
 * section as the check, and after that the turn can no longer be preempted.
 */

vi.mock("../src/db/audit.js", () => ({ audit: async () => undefined }));

const { ToolRegistry } = await import("../src/agent/tools/registry.js");
const { Preemption, TurnState, defineTool } = await import("../src/agent/tools/types.js");

function rig() {
  const ran: string[] = [];
  const registry = new ToolRegistry().registerAll([
    defineTool({
      name: "look_up",
      description: "only reads",
      level: "read",
      repeatable: true,
      schema: {},
      run: async () => {
        ran.push("look_up");
        return { ok: true, text: "read" };
      },
    }),
    defineTool({
      name: "start_job",
      description: "reads, but starts something",
      level: "read",
      schema: {},
      run: async () => {
        ran.push("start_job");
        return { ok: true, text: "started" };
      },
    }),
    defineTool({
      name: "say",
      description: "sends",
      level: "write_reversible",
      schema: {},
      run: async (_args, turn) => {
        turn.claimMessage();
        ran.push("say");
        return { ok: true, text: "sent" };
      },
    }),
  ]);
  const preemption = new Preemption();
  const turn = new TurnState({
    origin: "owner_message",
    triggerExternalId: "m-1",
    triggerMessageId: "db-1",
    reactableIds: ["m-1"],
    preemption,
  });
  return { registry, preemption, turn, ran };
}

describe("Preemption of a turn (D50)", () => {
  it("can still be preempted after a repeatable read tool, after that nothing runs", async () => {
    const { registry, preemption, turn, ran } = rig();
    await registry.execute("look_up", {}, turn);
    expect(preemption.cancel()).toBe(true);
    const result = await registry.execute("say", {}, turn);
    expect(result.ok).toBe(false);
    expect(result.endsTurn).toBe(true);
    expect(ran).toEqual(["look_up"]);
    expect(turn.preempted).toBe(true);
    await turn.untilStopped;
    expect(turn.stopReason).toBe("preempted");
  });

  it("commits as soon as a tool with an effect starts, even one of level read", async () => {
    const { registry, preemption, turn, ran } = rig();
    await registry.execute("start_job", {}, turn);
    expect(preemption.cancel()).toBe(false);
    await registry.execute("say", {}, turn);
    expect(ran).toEqual(["start_job", "say"]);
    expect(turn.preempted).toBe(false);
  });

  it("commits before the tool runs, not only afterwards", async () => {
    const { registry, preemption, turn } = rig();
    const running = registry.execute("say", {}, turn);
    // The call is under way; a message arriving now no longer preempts.
    await Promise.resolve();
    await Promise.resolve();
    expect(preemption.cancel()).toBe(false);
    expect((await running).ok).toBe(true);
  });

  it("without preemption every turn is committed immediately", () => {
    const turn = new TurnState({ origin: "task", triggerExternalId: "", triggerMessageId: "", reactableIds: [] });
    expect(turn.commit()).toBe(true);
    expect(turn.preempted).toBe(false);
  });

  it("the two transitions are mutually exclusive", () => {
    const committed = new Preemption();
    expect(committed.commit()).toBe(true);
    expect(committed.cancel()).toBe(false);
    const cancelled = new Preemption();
    expect(cancelled.cancel()).toBe(true);
    expect(cancelled.commit()).toBe(false);
    expect(cancelled.cancel()).toBe(true);
  });
});
