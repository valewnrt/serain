import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

// The audit writes to Supabase. The test only checks that it is called.
const auditMock = vi.fn(async () => undefined);
vi.mock("../src/db/audit.js", () => ({ audit: (...args: unknown[]) => auditMock(...(args as [])) }));

const { messagingTools } = await import("../src/agent/tools/messaging.js");
const { ToolRegistry, ToolBlockedError, assertExecutable } = await import(
  "../src/agent/tools/registry.js"
);
const { defineTool, TurnState } = await import("../src/agent/tools/types.js");
const { promisesFollowUp } = await import("../src/agent/promises.js");
type MessagePort = import("../src/agent/tools/messaging.js").MessagePort;

function fakePort(overrides: Partial<MessagePort> = {}): MessagePort & {
  sent: Array<{ text: string; kind: string; replyTo?: string; taintSources?: readonly string[] }>;
  reactions: Array<{ messageId: string; emoji: string }>;
} {
  const sent: Array<{ text: string; kind: string; replyTo?: string; taintSources?: readonly string[] }> = [];
  const reactions: Array<{ messageId: string; emoji: string }> = [];
  return {
    canReact: true,
    canReplyInThread: false,
    async send(text, opts) {
      sent.push({ text, ...opts });
      return true;
    },
    async react(messageId, emoji) {
      reactions.push({ messageId, emoji });
      return true;
    },
    sent,
    reactions,
    ...overrides,
  };
}

function turn(
  limits?: { maxMessages?: number; maxReactions?: number; maxSteps?: number },
  origin: "owner_message" | "untrusted" = "owner_message",
) {
  return new TurnState({
    origin,
    triggerExternalId: "m-1",
    triggerMessageId: "db-1",
    reactableIds: ["m-1", "m-2"],
    limits: {
      maxMessages: limits?.maxMessages ?? 4,
      maxReactions: limits?.maxReactions ?? 2,
      maxSteps: limits?.maxSteps ?? 8,
    },
  });
}

beforeEach(() => auditMock.mockClear());

describe("Lock for levels that need confirmation (D8.3)", () => {
  const dangerous = defineTool({
    name: "send_mail",
    description: "Sends a mail.",
    level: "irreversible",
    schema: { to: z.string() },
    async run() {
      throw new Error("must never run");
    },
  });

  it("does not let irreversible tools register", () => {
    expect(() => new ToolRegistry().register(dangerous)).toThrow(ToolBlockedError);
  });

  it("does not let money tools register", () => {
    const paying = defineTool({
      name: "buy_ticket",
      description: "Buys a ticket.",
      level: "money",
      schema: {},
      async run() {
        throw new Error("must never run");
      },
    });
    expect(() => new ToolRegistry().register(paying)).toThrow(ToolBlockedError);
  });

  it("blocks them at execution too, not only at registration", () => {
    expect(() => assertExecutable(dangerous)).toThrow(ToolBlockedError);
  });

  it("lets read and write_reversible through", () => {
    const registry = new ToolRegistry().registerAll(messagingTools(fakePort()));
    expect(registry.list().map((tool) => tool.name)).toEqual([
      "send_message",
      "reply_in_thread",
      "react",
      "end_turn",
    ]);
    for (const tool of registry.list()) {
      expect(["read", "write_reversible"]).toContain(tool.level);
    }
  });
});

describe("Registry", () => {
  it("reports unknown tools instead of throwing", async () => {
    const registry = new ToolRegistry();
    const result = await registry.execute("gibt_es_nicht", {}, turn());
    expect(result.ok).toBe(false);
    expect(result.text).toContain("does not exist");
  });

  it("rejects a duplicate tool name", () => {
    const registry = new ToolRegistry().registerAll(messagingTools(fakePort()));
    expect(() => registry.registerAll(messagingTools(fakePort()))).toThrow();
  });

  it("checks the arguments against the schema", async () => {
    const port = fakePort();
    const registry = new ToolRegistry().registerAll(messagingTools(port));
    const result = await registry.execute("send_message", { text: "" }, turn());
    expect(result.ok).toBe(false);
    expect(port.sent).toHaveLength(0);
  });

  it("rejects unknown fields", async () => {
    const registry = new ToolRegistry().registerAll(messagingTools(fakePort()));
    const result = await registry.execute("send_message", { text: "hi", to: "+49…" }, turn());
    expect(result.ok).toBe(false);
  });

  it("writes every call to the audit (D8.6)", async () => {
    const registry = new ToolRegistry().registerAll(messagingTools(fakePort()));
    await registry.execute("send_message", { text: "moin" }, turn());
    expect(auditMock).toHaveBeenCalledWith(
      "tool_call",
      expect.objectContaining({ tool: "send_message", level: "write_reversible", ok: true }),
      "db-1",
    );
  });

  it("ends the turn when the step limit is hit", async () => {
    const registry = new ToolRegistry().registerAll(messagingTools(fakePort()));
    const state = turn({ maxSteps: 2 });
    await registry.execute("send_message", { text: "eins" }, state);
    await registry.execute("send_message", { text: "zwei" }, state);
    const third = await registry.execute("send_message", { text: "drei" }, state);
    expect(third.ok).toBe(false);
    expect(third.endsTurn).toBe(true);
    expect(state.stopReason).toBe("step_limit");
  });

  describe("Step limit before Alex has heard anything", () => {
    const lookup = defineTool({
      name: "look_up",
      description: "Reads something.",
      level: "read",
      schema: {},
      async run() {
        return { ok: true, text: "gelesen" };
      },
    });

    it("does not end silently: no more tools, but a message to Alex", async () => {
      const port = fakePort();
      const registry = new ToolRegistry().registerAll([lookup, ...messagingTools(port)]);
      const state = turn({ maxSteps: 2 });
      await registry.execute("look_up", {}, state);
      await registry.execute("look_up", {}, state);
      const denied = await registry.execute("look_up", {}, state);
      expect(denied.ok).toBe(false);
      expect(denied.endsTurn).toBe(false);
      expect(denied.text).toContain("send_message");
      expect(state.stopped).toBe(false);

      const answer = await registry.execute("send_message", { text: "sieben stehen, zwei fehlen noch" }, state);
      expect(answer.ok).toBe(true);
      expect(answer.endsTurn).toBe(true);
      expect(port.sent.map((entry) => entry.text)).toEqual(["sieben stehen, zwei fehlen noch"]);
      expect(state.stopReason).toBe("step_limit");
      expect(state.steps).toBe(2);
    });

    it("allows no more effects in the meantime and ends after the allowed refusals", async () => {
      const registry = new ToolRegistry().registerAll([lookup, ...messagingTools(fakePort())]);
      const state = turn({ maxSteps: 1 });
      await registry.execute("look_up", {}, state);
      const results = [];
      for (let i = 0; i < 10 && !state.stopped; i++) results.push(await registry.execute("look_up", {}, state));
      expect(results.every((result) => !result.ok)).toBe(true);
      expect(results.at(-1)?.endsTurn).toBe(true);
      expect(state.stopReason).toBe("step_limit");
      expect(results.length).toBeLessThanOrEqual(5);
    });

    it("does not apply to a tapback: it does not tell Alex what is missing", async () => {
      const port = fakePort();
      const registry = new ToolRegistry().registerAll([lookup, ...messagingTools(port)]);
      const state = turn({ maxSteps: 1 });
      await registry.execute("look_up", {}, state);
      const tapback = await registry.execute("react", { signal: "ok" }, state);
      expect(tapback.ok).toBe(false);
      expect(port.reactions).toHaveLength(0);
    });

    it("ends immediately in a turn Alex did not trigger", async () => {
      const registry = new ToolRegistry().registerAll([lookup, ...messagingTools(fakePort())]);
      const state = turn({ maxSteps: 1 }, "untrusted");
      await registry.execute("look_up", {}, state);
      const denied = await registry.execute("look_up", {}, state);
      expect(denied.endsTurn).toBe(true);
      expect(state.stopReason).toBe("step_limit");
    });
  });
});

describe("[D48] Effects and editing", () => {
  it("passes on one effect per turn and sends a second one without", async () => {
    const port = fakePort({ canUseEffects: true });
    const registry = new ToolRegistry().registerAll(messagingTools(port));
    const state = turn();
    await registry.execute("send_message", { text: "alles gute", effect: "confetti" }, state);
    const second = await registry.execute("send_message", { text: "nochmal", effect: "balloons" }, state);
    expect(port.sent.map((entry) => (entry as { effect?: string }).effect)).toEqual(["confetti", undefined]);
    expect(second.ok).toBe(true);
    expect(second.text).toContain("Without effect");
  });

  it("sends without effect when the channel cannot do effects", async () => {
    const port = fakePort();
    const registry = new ToolRegistry().registerAll(messagingTools(port));
    const result = await registry.execute("send_message", { text: "alles gute", effect: "confetti" }, turn());
    expect(port.sent.map((entry) => (entry as { effect?: string }).effect)).toEqual([undefined]);
    expect(result.text).toContain("Without effect");
  });

  it("rejects an effect that does not exist", async () => {
    const port = fakePort({ canUseEffects: true });
    const registry = new ToolRegistry().registerAll(messagingTools(port));
    const result = await registry.execute("send_message", { text: "hi", effect: "regenbogen" }, turn());
    expect(result.ok).toBe(false);
    expect(port.sent).toEqual([]);
  });

  it("offers edit_message only when the channel can edit", () => {
    const names = (port: MessagePort) => new ToolRegistry().registerAll(messagingTools(port)).list().map((tool) => tool.name);
    expect(names(fakePort())).not.toContain("edit_message");
    expect(names(fakePort({ edit: async () => ({ ok: true }) }))).toContain("edit_message");
  });

  it("edits only on Alex's message and no longer after untrusted content", async () => {
    const calls: Array<{ find: string; text: string }> = [];
    const port = fakePort({
      edit: async (find, text) => {
        calls.push({ find, text });
        return { ok: false, reason: "ambiguous" };
      },
    });
    const registry = new ToolRegistry().registerAll(messagingTools(port));
    const result = await registry.execute("edit_message", { find: "am montag", text: "am dienstag" }, turn());
    expect(calls).toEqual([{ find: "am montag", text: "am dienstag" }]);
    expect(result).toMatchObject({ ok: false, text: expect.stringContaining("several messages") });

    const tainted = turn();
    tainted.taint("Alex's Google Calendar");
    expect((await registry.execute("edit_message", { find: "am montag", text: "x" }, tainted)).ok).toBe(false);
    expect((await registry.execute("edit_message", { find: "am montag", text: "x" }, turn(undefined, "untrusted"))).ok).toBe(false);
    expect(calls).toHaveLength(1);
  });
});

describe("Messaging tools", () => {
  it("sends a message", async () => {
    const port = fakePort();
    const registry = new ToolRegistry().registerAll(messagingTools(port));
    const state = turn();
    const result = await registry.execute("send_message", { text: "alles klar" }, state);
    expect(result.ok).toBe(true);
    expect(port.sent).toEqual([
      { text: "alles klar", kind: "reply", origin: "owner_message", taintSources: [], editable: true, onUndelivered: expect.any(Function) },
    ]);
    expect(state.messagesSent).toBe(1);
  });

  it("gives a message after untrusted content that content's origin (D8.4)", async () => {
    const port = fakePort({ canReplyInThread: true });
    const registry = new ToolRegistry().registerAll(messagingTools(port));
    const state = turn();
    await registry.execute("send_message", { text: "vorher" }, state);
    state.taint("https://example.com/seite");
    await registry.execute("send_message", { text: "nachher" }, state);
    await registry.execute("reply_in_thread", { text: "im thread" }, state);
    expect(port.sent.map((entry) => entry.taintSources)).toEqual([
      [],
      ["https://example.com/seite"],
      ["https://example.com/seite"],
    ]);
  });

  it("allows several messages per turn", async () => {
    const port = fakePort();
    const registry = new ToolRegistry().registerAll(messagingTools(port));
    const state = turn();
    await registry.execute("send_message", { text: "eins" }, state);
    await registry.execute("send_message", { text: "zwei" }, state);
    expect(port.sent).toHaveLength(2);
    expect(state.messagesSent).toBe(2);
  });

  it("stops at the message limit", async () => {
    const port = fakePort();
    const registry = new ToolRegistry().registerAll(messagingTools(port));
    const state = turn({ maxMessages: 2 });
    await registry.execute("send_message", { text: "eins" }, state);
    await registry.execute("send_message", { text: "zwei" }, state);
    const third = await registry.execute("send_message", { text: "drei" }, state);
    expect(third.ok).toBe(false);
    expect(port.sent).toHaveLength(2);
    expect(state.stopReason).toBe("message_limit");
  });

  it("replies in the thread when the channel can", async () => {
    const port = fakePort({ canReplyInThread: true });
    const registry = new ToolRegistry().registerAll(messagingTools(port));
    const result = await registry.execute("reply_in_thread", { text: "dazu" }, turn());
    expect(result.ok).toBe(true);
    expect(port.sent[0]).toEqual({
      text: "dazu",
      kind: "reply_thread",
      replyTo: "m-1",
      origin: "owner_message",
      taintSources: [],
      editable: true,
      onUndelivered: expect.any(Function),
    });
  });

  it("still sends without a thread when the channel cannot do threads", async () => {
    const port = fakePort({ canReplyInThread: false });
    const registry = new ToolRegistry().registerAll(messagingTools(port));
    const result = await registry.execute("reply_in_thread", { text: "dazu" }, turn());
    expect(result.ok).toBe(true);
    expect(port.sent[0]).toEqual({ text: "dazu", kind: "reply", origin: "owner_message", taintSources: [], editable: true, onUndelivered: expect.any(Function) });
    expect(result.text).toContain("without a thread");
  });

  it("sets a tapback on the triggering message", async () => {
    const port = fakePort();
    const registry = new ToolRegistry().registerAll(messagingTools(port));
    const state = turn();
    const result = await registry.execute("react", { signal: "ok" }, state);
    expect(result.ok).toBe(true);
    expect(port.reactions).toEqual([{ messageId: "m-1", emoji: "👍" }]);
    expect(state.messagesSent).toBe(0);
  });

  it("does not react to other messages", async () => {
    const port = fakePort();
    const registry = new ToolRegistry().registerAll(messagingTools(port));
    const result = await registry.execute("react", { signal: "ok", message_id: "m-99" }, turn());
    expect(result.ok).toBe(false);
    expect(port.reactions).toHaveLength(0);
  });

  it("takes only signals from the table, and only the code sets 🔍, ✅, ❌ (addendum D23 of 2026-10-08)", async () => {
    const port = fakePort();
    const registry = new ToolRegistry().registerAll(messagingTools(port));
    for (const args of [{ signal: "danke" }, { signal: "working" }, { signal: "done" }, { emoji: "👍" }]) {
      expect((await registry.execute("react", args, turn())).ok).toBe(false);
    }
    expect(port.reactions).toHaveLength(0);
  });

  it("sets the emoji from the table for each signal", async () => {
    const port = fakePort();
    const registry = new ToolRegistry().registerAll(messagingTools(port));
    for (const signal of ["scheduled", "watching"]) {
      expect((await registry.execute("react", { signal }, turn())).ok).toBe(true);
    }
    expect(port.reactions.map((reaction) => reaction.emoji)).toEqual(["⏰", "👀"]);
  });

  it("does not offer react at all when the channel cannot do tapbacks", () => {
    const tools = messagingTools(fakePort({ canReact: false }));
    expect(tools.map((tool) => tool.name)).not.toContain("react");
  });

  it("ends the turn with end_turn", async () => {
    const registry = new ToolRegistry().registerAll(messagingTools(fakePort()));
    const state = turn();
    await registry.execute("send_message", { text: "passt" }, state);
    const result = await registry.execute("end_turn", {}, state);
    expect(result.endsTurn).toBe(true);
    expect(state.stopped).toBe(true);

    const after = await registry.execute("send_message", { text: "doch noch was" }, state);
    expect(after.ok).toBe(false);
    expect(state.messagesSent).toBe(1);
  });

  // Live finding 2026-09-21: the owner gave a task, the model only called
  // `end_turn`, and nothing reached them.
  it("refuses end_turn as long as Alex has received nothing for their message", async () => {
    const registry = new ToolRegistry().registerAll(messagingTools(fakePort()));
    const state = turn();
    const silent = await registry.execute("end_turn", {}, state);
    expect(silent.ok).toBe(false);
    expect(silent.endsTurn).toBe(false);
    expect(state.stopped).toBe(false);
    expect(auditMock).toHaveBeenCalledWith(
      "tool_denied",
      expect.objectContaining({ tool: "end_turn", reason: "owner_unanswered" }),
      "db-1",
    );

    await registry.execute("react", { signal: "ok" }, state);
    const done = await registry.execute("end_turn", {}, state);
    expect(done.ok).toBe(true);
    expect(state.stopped).toBe(true);
  });

  // A task that ends silently looks to the owner like one that is still running
  // (seen in other assistants: 2 of 5 results dropped without a word).
  it("refuses end_turn in a task's result turn until Alex has a message, even with an empty result", async () => {
    const port = fakePort();
    const registry = new ToolRegistry().registerAll(messagingTools(port));
    const result = new TurnState({ origin: "task", triggerExternalId: "m-1", triggerMessageId: "db-1", reactableIds: [], reportOwed: true });
    const silent = await registry.execute("end_turn", {}, result);
    expect(silent.ok).toBe(false);
    expect(silent.text).toContain("is waiting for the result of their task");
    await registry.execute("reply_in_thread", { text: "Hab dazu nichts gefunden." }, result);
    expect(result.messagesDelivered).toBe(1);
    expect((await registry.execute("end_turn", {}, result)).ok).toBe(true);

    // The executor turn itself has the same origin but owes the owner nothing.
    const executor = new TurnState({ origin: "task", triggerExternalId: "", triggerMessageId: "db-1", reactableIds: [] });
    expect((await registry.execute("end_turn", {}, executor)).ok).toBe(true);
  });

  // Live and reproduced 2026-10-02: after "tell the owner …" in the result the
  // model wrote the answer as text and called end_turn.
  it("reminds in every tool result that Alex has received nothing yet, until they get something", async () => {
    const lookup = defineTool({
      name: "lookup",
      description: "Test tool",
      level: "read",
      schema: {},
      run: async () => ({ ok: true, text: "Found. Tell Alex." }),
    });
    const registry = new ToolRegistry().registerAll([...messagingTools(fakePort()), lookup]);
    const state = turn();
    const before = await registry.execute("lookup", {}, state);
    expect(before.text).toMatch(/^Found\. Tell Alex\.\n\n\(Alex has not received anything from you .*send_message, reply_in_thread or react/s);

    await registry.execute("react", { signal: "ok" }, state);
    expect((await registry.execute("lookup", {}, state)).text).toBe("Found. Tell Alex.");

    // Turns the owner did not trigger may stay silent: no hint.
    const task = new TurnState({ origin: "task", triggerExternalId: "m-1", triggerMessageId: "db-1", reactableIds: [] });
    expect((await registry.execute("lookup", {}, task)).text).toBe("Found. Tell Alex.");
  });

  it("takes back an end_turn whose siblings did not reach Alex", async () => {
    const registry = new ToolRegistry().registerAll(messagingTools(fakePort()));
    const state = turn();
    await Promise.all([
      registry.execute("end_turn", {}, state),
      registry.execute("react", { signal: "kein signal" }, state),
    ]);
    expect(state.stopped).toBe(false);
    expect(state.endRequested).toBe(false);
  });

  it("does not let the turn after an approval end silently either: Alex is waiting for the result", async () => {
    const registry = new ToolRegistry().registerAll(messagingTools(fakePort()));
    const state = new TurnState({ origin: "approval", triggerExternalId: "m-1", triggerMessageId: "db-1", reactableIds: [] });
    const silent = await registry.execute("end_turn", {}, state);
    expect(silent.ok).toBe(false);
    expect(silent.text).toContain("is waiting for the result");
    await registry.execute("send_message", { text: "erledigt" }, state);
    expect((await registry.execute("end_turn", {}, state)).ok).toBe(true);
  });

  it("lets a turn nobody triggered end silently", async () => {
    const registry = new ToolRegistry().registerAll(messagingTools(fakePort()));
    const state = turn(undefined, "untrusted");
    const result = await registry.execute("end_turn", {}, state);
    expect(result.ok).toBe(true);
    expect(state.stopped).toBe(true);
  });
});

/**
 * Origin (D8.4). A tool whose justification is the owner's direct instruction
 * must not run when something else triggered the turn. At first there was only
 * `owner_message`; the lock was there anyway, because otherwise it would be
 * missing exactly on the day the first mail trigger arrives.
 */
describe("Turn origin (D8.4)", () => {
  const ownerOnly = defineTool({
    name: "forget_everything",
    description: "Pretends to delete.",
    level: "write_reversible",
    ownerOriginOnly: true,
    schema: {},
    async run() {
      ran += 1;
      return { ok: true, text: "ran" };
    },
  });

  const anyOrigin = defineTool({
    name: "harmless",
    description: "May run anywhere.",
    level: "read",
    schema: {},
    async run() {
      ran += 1;
      return { ok: true, text: "ran" };
    },
  });

  let ran = 0;

  beforeEach(() => {
    ran = 0;
  });

  it("lets the tool run in a turn from Alex", async () => {
    const registry = new ToolRegistry().registerAll([ownerOnly, anyOrigin]);
    const result = await registry.execute("forget_everything", {}, turn());
    expect(result.ok).toBe(true);
    expect(ran).toBe(1);
  });

  it("refuses it fail-closed for another origin, with audit", async () => {
    const registry = new ToolRegistry().registerAll([ownerOnly, anyOrigin]);
    const result = await registry.execute("forget_everything", {}, turn(undefined, "untrusted"));
    expect(result.ok).toBe(false);
    expect(ran).toBe(0);
    expect(auditMock).toHaveBeenCalledWith(
      "tool_denied",
      expect.objectContaining({ tool: "forget_everything", reason: "origin_not_owner", origin: "untrusted" }),
      "db-1",
    );
  });

  it("leaves tools without the property alone", async () => {
    const registry = new ToolRegistry().registerAll([ownerOnly, anyOrigin]);
    const result = await registry.execute("harmless", {}, turn(undefined, "untrusted"));
    expect(result.ok).toBe(true);
    expect(ran).toBe(1);
  });

  it("uses no tool step of the turn on a refusal", async () => {
    const registry = new ToolRegistry().registerAll([ownerOnly]);
    const state = turn(undefined, "untrusted");
    await registry.execute("forget_everything", {}, state);
    expect(state.steps).toBe(0);
    expect(state.stopped).toBe(false);
  });
});

describe("Kill switch in the registry (D8.2)", () => {
  it("lets no tool run anymore, not even in a turn already under way", async () => {
    let engaged = false;
    const port = fakePort();
    const registry = new ToolRegistry(undefined, () => engaged).registerAll(messagingTools(port));
    const state = turn();
    expect((await registry.execute("send_message", { text: "eins" }, state)).ok).toBe(true);
    engaged = true;
    const blocked = await registry.execute("send_message", { text: "zwei" }, state);
    expect(blocked).toMatchObject({ ok: false, endsTurn: true });
    expect(port.sent).toHaveLength(1);
    expect(state.stopReason).toBe("kill_switch");
    expect(auditMock).toHaveBeenCalledWith(
      "tool_denied",
      expect.objectContaining({ tool: "send_message", reason: "kill_switch" }),
      "db-1",
    );
  });
});

describe("[addendum D48 of 2026-10-08] Sources as link previews", () => {
  function previewSetup() {
    const links: Array<{ url: string; replyTo?: string }> = [];
    const port = fakePort({
      canReplyInThread: true,
      sendLink: async (url, opts) => (links.push({ url, ...(opts.replyTo ? { replyTo: opts.replyTo } : {}) }), true),
    });
    return { port, links, registry: new ToolRegistry().registerAll(messagingTools(port)) };
  }
  const resultTurn = (opened: string[]) =>
    new TurnState({ origin: "task", triggerExternalId: "q-1", triggerMessageId: "db-1", reactableIds: [], taintSources: ["executor report"], openedPages: opened });

  it("sends the preview after the text as its own bubble in the same thread, without tracking", async () => {
    const { port, links, registry } = previewSetup();
    const result = await registry.execute(
      "reply_in_thread",
      { text: "Student kostet 5,99.", links: ["https://www.spotify.com/de/student/"] },
      resultTurn(["https://www.spotify.com/de/student/?utm_campaign=x"]),
    );
    expect(result).toMatchObject({ ok: true });
    expect(result.text).toContain("With preview");
    expect(port.sent.map((entry) => entry.text)).toEqual(["Student kostet 5,99."]);
    expect(links).toEqual([{ url: "https://www.spotify.com/de/student/", replyTo: "q-1" }]);
  });

  it("rejects an unopened page before sending, without logging the address, and caps at two per turn", async () => {
    const { port, links, registry } = previewSetup();
    const state = resultTurn(["https://a.example/1", "https://b.example/2", "https://c.example/3"]);
    const denied = await registry.execute("send_message", { text: "Schau.", links: ["https://phish.example/login"] }, state);
    expect(denied.ok).toBe(false);
    expect(port.sent).toEqual([]);
    expect(JSON.stringify(auditMock.mock.calls)).not.toContain("phish.example");
    expect(auditMock).toHaveBeenCalledWith("tool_denied", { tool: "send_message", level: "write_reversible", reason: "unbacked_preview", links: 1 }, "db-1");
    expect((await registry.execute("send_message", { text: "Eins.", links: ["https://a.example/1", "https://b.example/2"] }, state)).ok).toBe(true);
    const third = await registry.execute("send_message", { text: "Drei.", links: ["https://c.example/3"] }, state);
    expect(third.ok).toBe(false);
    expect(third.text).toContain("no more than 2 previews");
    expect(links.map((entry) => entry.url)).toEqual(["https://a.example/1", "https://b.example/2"]);
  });

  it("sends no preview when the turn has a screenshot: one or the other (addendum D23 of 2026-10-08)", async () => {
    const { port, links, registry } = previewSetup();
    const state = new TurnState({
      origin: "task",
      triggerExternalId: "q-1",
      triggerMessageId: "db-1",
      reactableIds: [],
      taintSources: ["executor report"],
      openedPages: ["https://www.wetter.com/mainz"],
      screenshots: [{ id: "s1", jpeg: Buffer.from("x"), origin: "web", label: "wetter.com" }],
    });
    const denied = await registry.execute("reply_in_thread", { text: "so in mainz: 16°.", links: ["https://www.wetter.com/mainz"] }, state);
    expect(denied.ok).toBe(false);
    expect(denied.text).toContain("with a screenshot there is no preview");
    expect(port.sent).toEqual([]);
    expect(links).toEqual([]);
    expect(auditMock).toHaveBeenCalledWith("tool_denied", expect.objectContaining({ reason: "preview_with_screenshot" }), "db-1");
    expect((await registry.execute("reply_in_thread", { text: "so in mainz: 16°." }, state)).ok).toBe(true);
  });

  it("knows no preview in a clean turn and no parameter when the channel cannot do them", async () => {
    const { registry, port } = previewSetup();
    expect((await registry.execute("send_message", { text: "x", links: ["https://a.example/1"] }, turn())).ok).toBe(false);
    expect(port.sent).toEqual([]);
    const plain = messagingTools(fakePort()).find((def) => def.name === "send_message")!;
    expect(Object.keys(plain.schema)).not.toContain("links");
  });
});

describe("[addendum D23 of 2026-10-08] Values to copy as their own bubble", () => {
  const IBAN = "DE89 3704 0044 0532 0130 00";

  it("sends each value after the text as its own verbatim bubble in the same thread", async () => {
    const port = fakePort({ canReplyInThread: true });
    const registry = new ToolRegistry().registerAll(messagingTools(port));
    const result = await registry.execute("reply_in_thread", { text: "die iban von der hausverwaltung:", copy: [IBAN, "ab_cd_ef"] }, turn());
    expect(result).toMatchObject({ ok: true });
    expect(result.text).toContain("With 2 values separately");
    expect(port.sent.map(({ text, kind, replyTo }) => ({ text, kind, replyTo }))).toEqual([
      { text: "die iban von der hausverwaltung:", kind: "reply_thread", replyTo: "m-1" },
      { text: IBAN, kind: "copy", replyTo: "m-1" },
      { text: "ab_cd_ef", kind: "copy", replyTo: "m-1" },
    ]);
    expect(port.sent.slice(1).every((entry) => (entry as { verbatim?: boolean }).verbatim === true)).toBe(true);
  });

  it("takes at most three values, each as one line", async () => {
    const port = fakePort();
    const registry = new ToolRegistry().registerAll(messagingTools(port));
    expect((await registry.execute("send_message", { text: "x", copy: ["1", "2", "3", "4"] }, turn())).ok).toBe(false);
    expect((await registry.execute("send_message", { text: "x", copy: ["zeile\nzwei"] }, turn())).ok).toBe(false);
    expect(port.sent).toEqual([]);
  });

  it("checks links in the values after untrusted content like in the text", async () => {
    const port = fakePort();
    const registry = new ToolRegistry().registerAll(messagingTools(port));
    const tainted = new TurnState({ origin: "task", triggerExternalId: "q-1", triggerMessageId: "db-1", reactableIds: [], taintSources: ["Mail"] });
    const result = await registry.execute("send_message", { text: "hier:", copy: ["https://phish.example/login"] }, tainted);
    expect(result.ok).toBe(false);
    expect(port.sent).toEqual([]);
  });
});

// Addendum D33 of 2026-10-13: the promise to get back stood only in the chat, the
// mail came and fell through.
describe("The code holds promises to Alex", () => {
  it("recognises promises in Serain's tone, not requests to Alex", () => {
    for (const text of [
      "steht drin, ort und uhrzeit kommen noch vom veranstalter, meld ich mich dann nochmal.",
      "meld mich, sobald die antwort da ist",
      "ich melde mich, wenn ich was höre",
      "sag dir bescheid, wenn die tickets kommen",
      "geb dir dann sofort bescheid",
      "halt dich auf dem laufenden",
      "schreib dir, sobald die mail da ist",
      "sobald sie da ist, sag ich's dir",
    ]) {
      expect(promisesFollowUp(text), text).toBe(true);
    }
    for (const text of [
      "sag bescheid, wenn's raus soll",
      "meld dich, wenn du mehr weißt",
      "hab mich angemeldet",
      "die abmeldung lief durch",
      "steht drin, 27.10. um 18 uhr",
    ]) {
      expect(promisesFollowUp(text), text).toBe(false);
    }
  });

  const comesBack = defineTool({
    name: "expect_mail",
    description: "Holds a promise.",
    level: "write_reversible",
    origins: ["owner_message"],
    comesBack: true,
    schema: {},
    run: async () => ({ ok: true, text: "Held." }),
  });

  it("lets the turn end after a promise only once something holds it", async () => {
    const registry = new ToolRegistry().registerAll([...messagingTools(fakePort()), comesBack]);
    const state = turn();
    await registry.execute("send_message", { text: "ort und zeit kommen noch vom veranstalter, meld ich mich dann" }, state);
    const early = await registry.execute("end_turn", {}, state);
    expect(early.ok).toBe(false);
    expect(early.text).toContain("expect_mail");
    expect(state.stopped).toBe(false);
    expect(auditMock).toHaveBeenCalledWith("tool_denied", expect.objectContaining({ tool: "end_turn", reason: "promise_unheld" }), "db-1");

    await registry.execute("expect_mail", {}, state);
    const done = await registry.execute("end_turn", {}, state);
    expect(done.ok).toBe(true);
    expect(state.stopped).toBe(true);
  });

  it("reminds only once: on the second end_turn the turn ends anyway", async () => {
    const registry = new ToolRegistry().registerAll(messagingTools(fakePort()));
    const state = turn();
    await registry.execute("send_message", { text: "sag dir bescheid, wenn ich was höre" }, state);
    expect((await registry.execute("end_turn", {}, state)).ok).toBe(false);
    expect((await registry.execute("end_turn", {}, state)).ok).toBe(true);
    expect(state.stopped).toBe(true);
  });

  it("lets the turn end at once when something already holds the promise", async () => {
    const registry = new ToolRegistry().registerAll([...messagingTools(fakePort()), comesBack]);
    const state = turn();
    await registry.execute("expect_mail", {}, state);
    await registry.execute("send_message", { text: "meld mich, sobald der veranstalter schreibt" }, state);
    expect((await registry.execute("end_turn", {}, state)).ok).toBe(true);
  });

  it("applies only in Alex's turns: an event turn without expect_mail ends as before", async () => {
    const registry = new ToolRegistry().registerAll(messagingTools(fakePort()));
    const state = turn(undefined, "untrusted");
    await registry.execute("send_message", { text: "meld mich dann" }, state);
    expect((await registry.execute("end_turn", {}, state)).ok).toBe(true);
  });
});
