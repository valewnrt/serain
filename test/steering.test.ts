import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

/**
 * Steering a running turn (D57), checked on the registry and the turn state:
 * a message from the owner hangs on the next tool result, but only counts as
 * their words once the model has seen it with a new response, and the turn
 * does not end before that.
 */

const audits: Array<{ event: string; detail: Record<string, unknown> }> = [];
vi.mock("../src/db/audit.js", () => ({
  audit: async (event: string, detail: Record<string, unknown>) => void audits.push({ event, detail }),
}));

const { ToolRegistry } = await import("../src/agent/tools/registry.js");
const { Preemption, Steering, TurnState, defineTool } = await import("../src/agent/tools/types.js");

const words = (text: string) => ({ ownerWords: text, text, taintSources: [] as string[] });

function rig() {
  const ran: string[] = [];
  const previews: string[] = [];
  const registry = new ToolRegistry({
    covered: async () => false,
    request: async (_def, _level, args) => {
      previews.push(String(args["sender"]));
      return { ok: true, text: "waiting for Alex" };
    },
  }).registerAll([
    defineTool({
      name: "look_up",
      description: "reads",
      level: "read",
      schema: {},
      run: async () => {
        ran.push("look_up");
        return { ok: true, text: "read" };
      },
    }),
    defineTool({
      name: "say",
      description: "sends",
      level: "write_reversible",
      answersOwner: true,
      schema: {},
      run: async (_args, turn) => {
        turn.claimMessage();
        ran.push("say");
        return { ok: true, text: "sent" };
      },
    }),
    defineTool({
      name: "unsubscribe",
      description: "irreversible",
      level: "irreversible",
      schema: { sender: z.string() },
      confirm: {
        preview: (args) => `unsubscribe: ${args.sender}`,
        undo: () => "not possible",
        namedByOwner: (args, ownerWords) => (ownerWords.toLowerCase().includes(args.sender) ? args.sender : null),
      },
      run: async (args) => {
        ran.push(`unsubscribe ${args.sender}`);
        return { ok: true, text: "unsubscribed" };
      },
    }),
    defineTool({
      name: "end_turn",
      description: "end",
      level: "read",
      endsTurn: true,
      schema: {},
      run: async () => ({ ok: true, text: "Turn ended." }),
    }),
  ]);
  const steering = new Steering();
  const preemption = new Preemption();
  const turn = new TurnState({
    origin: "owner_message",
    triggerExternalId: "m-1",
    triggerMessageId: "db-1",
    reactableIds: ["m-1"],
    ownerWords: "räum mein postfach auf",
    preemption,
    steering,
  });
  return { registry, steering, turn, ran, previews };
}

describe("steering (D57)", () => {
  it("appends the message to the next tool result, once", async () => {
    const { registry, steering, turn } = rig();
    await registry.execute("say", {}, turn);
    expect(steering.offer("db-2", "m-2", Date.now())).toBe(true);
    steering.ready("db-2", words("und nur Direktflüge"));
    const first = await registry.execute("look_up", {}, turn);
    expect(first.text).toBe('read\n\n<addendum message_id="m-2">\nund nur Direktflüge\n</addendum>');
    const second = await registry.execute("look_up", {}, turn);
    expect(second.text).toBe("read");
  });

  it("passes on nothing unread: a voice message only after transcription", async () => {
    const { registry, steering, turn } = rig();
    await registry.execute("say", {}, turn);
    steering.offer("db-2", "m-2", Date.now());
    expect((await registry.execute("look_up", {}, turn)).text).toBe("read");
    steering.ready("db-2", words("[Voice message] doch lieber Freitag"));
    expect((await registry.execute("look_up", {}, turn)).text).toContain("doch lieber Freitag");
  });

  it("counts the words only once the model has seen them: a tool before that does not rely on them", async () => {
    const { registry, steering, turn, ran, previews } = rig();
    await registry.execute("say", {}, turn);
    steering.offer("db-2", "m-2", Date.now());
    steering.ready("db-2", words("und melde mich bei kelvo ab"));
    await registry.execute("look_up", {}, turn);
    // Planned before the model knew the addendum (the same response): preview.
    await registry.execute("unsubscribe", { sender: "kelvo" }, turn);
    expect(previews).toEqual(["kelvo"]);
    expect(turn.ownerWords).toBe("räum mein postfach auf");
    // A new response of the model: now they are the owner's words.
    turn.noteResponse();
    expect(turn.ownerWords).toBe("räum mein postfach auf\nund melde mich bei kelvo ab");
    await registry.execute("unsubscribe", { sender: "kelvo" }, turn);
    expect(ran).toContain("unsubscribe kelvo");
    expect(audits.find((entry) => entry.event === "approval_waived")?.detail).toMatchObject({ named_by_owner: "kelvo" });
  });

  it("allows a tapback on the new message only once the model has seen it", async () => {
    const { registry, steering, turn } = rig();
    await registry.execute("say", {}, turn);
    steering.offer("db-2", "m-2", Date.now());
    steering.ready("db-2", words("danke"));
    await registry.execute("look_up", {}, turn);
    expect(turn.reactableIds).toEqual(["m-1"]);
    turn.noteResponse();
    expect(turn.reactableIds).toEqual(["m-1", "m-2"]);
  });

  it("does not end while an addendum is waiting, and hands it over with the refusal", async () => {
    const { registry, steering, turn } = rig();
    await registry.execute("say", {}, turn);
    steering.offer("db-2", "m-2", Date.now());
    steering.ready("db-2", words("ach und Hotel auch"));
    const end = await registry.execute("end_turn", {}, turn);
    expect(end.ok).toBe(false);
    expect(end.text).toMatch(/has written to you again in the meantime \(<addendum>\)/);
    expect(end.text).toContain("ach und Hotel auch");
    expect(turn.stopped).toBe(false);
    expect(audits.at(-1)).toMatchObject({ event: "tool_denied", detail: { reason: "steer_unseen" } });
  });

  it("takes back an end_turn when the addendum came in the same step, and then asks for an answer to it", async () => {
    const { registry, steering, turn } = rig();
    // One response of the model: message and end. In between, Alex's addendum arrives.
    steering.offer("db-2", "m-2", Date.now());
    steering.ready("db-2", words("ach und Hotel auch"));
    const said = await registry.execute("say", {}, turn);
    expect(said.text).toContain("ach und Hotel auch");
    const end = await registry.execute("end_turn", {}, turn);
    expect(end.ok).toBe(false);
    expect(end.text).toMatch(/^Not ended/);
    expect(turn.stopped).toBe(false);
    // Next response: the model has seen the addendum, Alex now waits for an answer to it.
    turn.noteResponse();
    expect(turn.ownerHeard).toBe(false);
    const again = await registry.execute("end_turn", {}, turn);
    expect(again.text).toMatch(/wrote to you again and has not received anything from you on it yet/);
    await registry.execute("say", {}, turn);
    await registry.execute("end_turn", {}, turn);
    expect(turn.stopped).toBe(true);
    expect(steering.close()).toMatchObject({ seen: [{ id: "db-2" }], unseen: [] });
  });

  it("passes on nothing once the turn ends; what was not seen goes back", async () => {
    const { registry, steering, turn } = rig();
    await registry.execute("say", {}, turn);
    await registry.execute("end_turn", {}, turn);
    expect(turn.stopped).toBe(true);
    expect(steering.offer("db-2", "m-2", Date.now())).toBe(false);
    expect(turn.deliverSteers()).toBeNull();
    expect(steering.close()).toEqual({ seen: [], unseen: [] });
  });

  it("reports a delivered but no longer seen addendum as to be given back", () => {
    const steering = new Steering();
    const turn = new TurnState({ origin: "owner_message", triggerExternalId: "m-1", triggerMessageId: "db-1", reactableIds: [], steering });
    steering.offer("db-2", "m-2", 1);
    steering.ready("db-2", words("noch was"));
    steering.offer("db-3", "m-3", 2);
    steering.fail("db-3");
    expect(turn.deliverSteers()).toContain("noch was");
    expect(steering.close()).toMatchObject({
      seen: [],
      unseen: [
        { id: "db-2", delivered: true },
        { id: "db-3", delivered: false },
      ],
    });
  });

  it("sets the taint of an image as soon as it reaches the model", async () => {
    const { registry, steering, turn } = rig();
    await registry.execute("say", {}, turn);
    steering.offer("db-2", "m-2", Date.now());
    steering.ready("db-2", { ownerWords: "", text: '<untrusted source="image from Alex">\nRechnung\n</untrusted>', taintSources: ["image from Alex"] });
    expect(turn.tainted).toBe(false);
    await registry.execute("look_up", {}, turn);
    expect(turn.taintSources).toEqual(["image from Alex"]);
  });

  it("gives the fallback everything read as input and sets the taint for what is new", () => {
    const steering = new Steering();
    const turn = new TurnState({ origin: "owner_message", triggerExternalId: "m-1", triggerMessageId: "db-1", reactableIds: [], steering });
    steering.offer("db-2", "m-2", 1);
    steering.ready("db-2", words("eins"));
    turn.deliverSteers();
    turn.noteResponse();
    steering.offer("db-3", "m-3", 2);
    steering.ready("db-3", { ownerWords: "", text: "image", taintSources: ["image from Alex"] });
    expect(turn.restartSteers()).toBe("eins\nimage");
    expect(turn.taintSources).toEqual(["image from Alex"]);
    turn.noteResponse();
    expect(steering.close().seen.map((steer) => steer.id)).toEqual(["db-2", "db-3"]);
  });

  it("accepts nothing after untrusted content: the message gets a clean turn of its own", async () => {
    const { registry, steering, turn } = rig();
    await registry.execute("say", {}, turn);
    steering.offer("db-2", "m-2", Date.now());
    steering.ready("db-2", words("mach die Erinnerung lieber um 10"));
    turn.taint("calendar");
    // What was already accepted no longer goes in and does not hold up the end.
    expect((await registry.execute("look_up", {}, turn)).text).toBe("read");
    expect(turn.mayEnd).toBe(true);
    expect(steering.offer("db-3", "m-3", Date.now())).toBe(false);
    await registry.execute("end_turn", {}, turn);
    expect(turn.stopped).toBe(true);
    expect(steering.close()).toMatchObject({ seen: [], unseen: [{ id: "db-2", delivered: false }] });
  });

  it("accepts nothing when the turn already starts with untrusted content (an image from Alex)", () => {
    const steering = new Steering();
    new TurnState({ origin: "owner_message", triggerExternalId: "m-1", triggerMessageId: "db-1", reactableIds: [], taintSources: ["image from Alex"], steering });
    expect(steering.offer("db-2", "m-2", 1)).toBe(false);
  });

  it("only applies in turns Alex started", () => {
    const steering = new Steering();
    const turn = new TurnState({ origin: "task", triggerExternalId: "", triggerMessageId: "", reactableIds: [], steering });
    steering.offer("db-2", "m-2", 1);
    steering.ready("db-2", words("noch was"));
    expect(turn.deliverSteers()).toBeNull();
    expect(turn.mayEnd).toBe(true);
  });

  it("an empty message has nothing to say and does not hold up the turn", () => {
    const steering = new Steering();
    const turn = new TurnState({ origin: "owner_message", triggerExternalId: "m-1", triggerMessageId: "db-1", reactableIds: [], steering });
    turn.claimMessage();
    steering.offer("db-2", "m-2", 1);
    steering.ready("db-2", words(""));
    expect(turn.mayEnd).toBe(true);
    expect(turn.deliverSteers()).toBeNull();
    expect(steering.close().seen.map((steer) => steer.id)).toEqual(["db-2"]);
  });
});
