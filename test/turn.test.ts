import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Turn loop with a mocked model: the "model" works through a script of tool
 * calls. What is checked is what really went out afterwards.
 */
interface ScriptedCall {
  tool: string;
  args: Record<string, unknown>;
}

/**
 * One step of the model. Several calls in one step correspond to what a model
 * sends as parallel tool calls; the SDK starts them simultaneously, not one
 * after another.
 */
type ScriptedStep = ScriptedCall[];

let script: ScriptedCall[] = [];
/** Set instead of `script` when a test needs parallel calls. */
let stepScript: ScriptedStep[] | null = null;
let finalText = "";
let seenTools: string[] = [];
let seenMaxSteps = 0;
let fallbackAllowedAtEnd = true;
/** Did the model layer learn that the turn is over? */
let stopSignalled = false;
/** Called on the signal; the test setup takes a snapshot there. */
let onStopSignal: (() => void) | null = null;

const auditMock = vi.fn(async () => undefined);
vi.mock("../src/db/audit.js", () => ({ audit: (...args: unknown[]) => auditMock(...(args as [])) }));

vi.mock("../src/agent/model.js", () => ({
  runModelTurn: async (req: {
    tools: Array<{ name: string }>;
    maxSteps: number;
    allowFallback?: () => boolean;
    stopSignal?: Promise<void>;
    execute: (name: string, args: Record<string, unknown>) => Promise<{ endsTurn: boolean }>;
  }) => {
    seenTools = req.tools.map((tool) => tool.name);
    seenMaxSteps = req.maxSteps;
    // This is how the Agent SDK path hooks its abort onto it: subscribe once and
    // abort at the first sound. Here we only record when the sound came.
    void req.stopSignal?.then(() => {
      stopSignalled = true;
      onStopSignal?.();
    });
    const steps: ScriptedStep[] = stepScript ?? script.map((call) => [call]);
    for (const step of steps) {
      // Just like the Vercel AI SDK: all calls of a step are started
      // simultaneously, only then the next step follows.
      const results = await Promise.all(
        step.map((call) => req.execute(call.tool, call.args)),
      );
      if (results.some((result) => result.endsTurn)) break;
    }
    fallbackAllowedAtEnd = req.allowFallback?.() ?? true;
    return { provider: "subscription", model: "sonnet", costUsd: 0, text: finalText };
  },
}));

const { runTurn } = await import("../src/agent/turn.js");
const { messagingTools } = await import("../src/agent/tools/messaging.js");
const { ToolRegistry } = await import("../src/agent/tools/registry.js");
const { TurnState } = await import("../src/agent/tools/types.js");
type MessagePort = import("../src/agent/tools/messaging.js").MessagePort;

/** While set, the channel aborts, like Photon on 2026-10-13 (addendum D52). */
let channelDown = false;

function fakePort() {
  const sent: Array<{ text: string; kind: string }> = [];
  const reactions: string[] = [];
  const port: MessagePort = {
    canReact: true,
    canReplyInThread: false,
    async send(text, opts) {
      if (channelDown) {
        opts.onUndelivered?.();
        return false;
      }
      sent.push({ text, kind: opts.kind });
      return true;
    },
    async react(_messageId, emoji) {
      reactions.push(emoji);
      return true;
    },
  };
  return { port, sent, reactions };
}

async function run(limits?: { maxMessages?: number; maxSteps?: number }, progress?: { committed: boolean; undelivered?: boolean }) {
  const { port, sent, reactions } = fakePort();
  // What had already gone out when the model layer learned of the end? That is
  // exactly what decides whether an abort swallows a message.
  let sentAtSignal: string[] | null = null;
  onStopSignal = () => {
    sentAtSignal = sent.map((entry) => entry.text);
  };
  const registry = new ToolRegistry().registerAll(messagingTools(port));
  const outcome = await runTurn(
    { registry, port },
    {
      system: "system",
      history: [],
      incoming: "hi",
      setup: {
        origin: "owner_message",
        triggerExternalId: "m-1",
        triggerMessageId: "db-1",
        reactableIds: ["m-1"],
        limits: {
          maxMessages: limits?.maxMessages ?? 4,
          maxReactions: 2,
          maxSteps: limits?.maxSteps ?? 8,
        },
        ...(progress ? { progress } : {}),
      },
    },
  );
  return { outcome, sent, reactions, sentAtSignal: () => sentAtSignal };
}

beforeEach(() => {
  script = [];
  stepScript = null;
  finalText = "";
  stopSignalled = false;
  onStopSignal = null;
  channelDown = false;
  auditMock.mockClear();
});

describe("Turn with messages as tools", () => {
  it("passes the registered tools and the step limit to the model", async () => {
    script = [{ tool: "end_turn", args: {} }];
    await run({ maxSteps: 5 });
    expect(seenTools).toEqual(["send_message", "reply_in_thread", "react", "end_turn"]);
    expect(seenMaxSteps).toBe(5);
  });

  it("may end a turn without any message", async () => {
    script = [{ tool: "end_turn", args: {} }];
    const { outcome, sent } = await run();
    expect(sent).toHaveLength(0);
    expect(outcome.messagesSent).toBe(0);
    expect(outcome.usedTextFallback).toBe(false);
  });

  it("sends a message", async () => {
    script = [
      { tool: "send_message", args: { text: "passt" } },
      { tool: "end_turn", args: {} },
    ];
    const { outcome, sent } = await run();
    expect(sent).toEqual([{ text: "passt", kind: "reply" }]);
    expect(outcome.messagesSent).toBe(1);
  });

  it("sends several messages in one turn", async () => {
    script = [
      { tool: "send_message", args: { text: "eins" } },
      { tool: "send_message", args: { text: "zwei" } },
      { tool: "end_turn", args: {} },
    ];
    const { outcome, sent } = await run();
    expect(sent.map((entry) => entry.text)).toEqual(["eins", "zwei"]);
    expect(outcome.messagesSent).toBe(2);
  });

  it("can answer with a reaction alone", async () => {
    script = [
      { tool: "react", args: { signal: "ok" } },
      { tool: "end_turn", args: {} },
    ];
    const { outcome, sent, reactions } = await run();
    expect(reactions).toEqual(["👍"]);
    expect(sent).toHaveLength(0);
    expect(outcome.reactionsSent).toBe(1);
    expect(outcome.usedTextFallback).toBe(false);
  });

  it("respects the message limit even when the model keeps going", async () => {
    script = Array.from({ length: 6 }, (_, i) => ({
      tool: "send_message",
      args: { text: `nachricht ${i}` },
    }));
    const { outcome, sent } = await run({ maxMessages: 2 });
    expect(sent).toHaveLength(2);
    expect(outcome.stopReason).toBe("message_limit");
  });

  it("respects the step limit", async () => {
    script = Array.from({ length: 10 }, (_, i) => ({
      tool: "send_message",
      args: { text: `nachricht ${i}` },
    }));
    const { outcome } = await run({ maxMessages: 99, maxSteps: 3 });
    expect(outcome.steps).toBe(3);
    expect(outcome.stopReason).toBe("step_limit");
  });

  it("sends the answer text when the model used no tool at all", async () => {
    script = [];
    finalText = "hätte ich fast vergessen";
    const { outcome, sent } = await run();
    expect(sent).toEqual([{ text: "hätte ich fast vergessen", kind: "text_fallback" }]);
    expect(outcome.usedTextFallback).toBe(true);
    expect(auditMock).toHaveBeenCalledWith(
      "turn_text_fallback",
      expect.objectContaining({ sent: true }),
      "db-1",
    );
  });

  it("[addendum D52 of 2026-10-13] remembers when the answer text fails at the channel", async () => {
    // Live finding 2026-10-13, 14:47: after a 4-minute tool only text, the channel aborted, and the message counted as done.
    script = [];
    finalText = "hier die übersicht";
    channelDown = true;
    const progress = { committed: false };
    const { outcome } = await run(undefined, progress);
    expect(outcome.usedTextFallback).toBe(false);
    expect(progress).toEqual({ committed: true, undelivered: true });
    expect(auditMock).toHaveBeenCalledWith("turn_text_fallback", expect.objectContaining({ sent: false, undelivered: true }), "db-1");
  });

  it("[addendum D52 of 2026-10-13] tells the model not to send again, and remembers it", async () => {
    script = [
      { tool: "send_message", args: { text: "steht wieder drin" } },
      { tool: "end_turn", args: {} },
    ];
    channelDown = true;
    const progress: { committed: boolean; undelivered?: boolean } = { committed: false };
    const { outcome } = await run(undefined, progress);
    expect(progress.undelivered).toBe(true);
    expect(outcome.messagesDelivered).toBe(0);
    // Counted as an attempt: the turn may end instead of sending on into the void.
    expect(outcome.messagesSent).toBe(1);
    expect(outcome.usedTextFallback).toBe(false);
  });

  it("treats text after end_turn as talking to itself and does not send it", async () => {
    // Live test 2026-09-20: after two previews and end_turn, a note to itself
    // ("all good, no further step needed") went to the owner as a message.
    script = [
      { tool: "react", args: { signal: "ok" } },
      { tool: "end_turn", args: {} },
    ];
    finalText = "Alles gut, kein weiterer Schritt nötig.";
    const { outcome, sent } = await run();
    expect(sent).toEqual([]);
    expect(outcome.usedTextFallback).toBe(false);
  });

  it("sends the answer text when the model would otherwise end silently", async () => {
    // Live finding 2026-09-21: only `end_turn` in response to a request from the
    // owner. The end does not count then, so the emergency exit applies again.
    script = [{ tool: "end_turn", args: {} }];
    finalText = "mach ich";
    const { outcome, sent } = await run();
    expect(sent.map((entry) => entry.text)).toEqual(["mach ich"]);
    expect(outcome.usedTextFallback).toBe(true);
  });

  it("does not send the answer text when a message has already gone out", async () => {
    script = [
      { tool: "send_message", args: { text: "schon gesagt" } },
      { tool: "end_turn", args: {} },
    ];
    finalText = "nochmal dasselbe";
    const { outcome, sent } = await run();
    expect(sent).toHaveLength(1);
    expect(outcome.usedTextFallback).toBe(false);
  });

  it("forbids the paid fallback as soon as something has reached Alex", async () => {
    script = [{ tool: "end_turn", args: {} }];
    await run();
    expect(fallbackAllowedAtEnd).toBe(true);

    script = [
      { tool: "send_message", args: { text: "schon raus" } },
      { tool: "end_turn", args: {} },
    ];
    await run();
    expect(fallbackAllowedAtEnd).toBe(false);

    script = [{ tool: "react", args: { signal: "ok" } }];
    await run();
    expect(fallbackAllowedAtEnd).toBe(false);
  });

  it("does not send the answer text when there was only a reaction", async () => {
    script = [{ tool: "react", args: { signal: "ok" } }];
    finalText = "ich habe reagiert";
    const { outcome, sent } = await run();
    expect(sent).toHaveLength(0);
    expect(outcome.usedTextFallback).toBe(false);
  });
});

/**
 * A model on the OpenRouter path called `send_message` and `end_turn` in
 * parallel in the same step. The semantics for that: all message tools of a
 * step run, in call order, after that the turn is over. The limits apply
 * unchanged.
 */
describe("end_turn in parallel with other tools", () => {
  it("sends the message even when end_turn comes first", async () => {
    stepScript = [
      [
        { tool: "end_turn", args: {} },
        { tool: "send_message", args: { text: "geht trotzdem raus" } },
      ],
    ];
    const { outcome, sent } = await run();
    expect(sent.map((entry) => entry.text)).toEqual(["geht trotzdem raus"]);
    expect(outcome.messagesSent).toBe(1);
    expect(outcome.stopReason).toBe("end_turn");
  });

  it("sends the message when end_turn comes after it", async () => {
    stepScript = [
      [
        { tool: "send_message", args: { text: "erst die Nachricht" } },
        { tool: "end_turn", args: {} },
      ],
    ];
    const { outcome, sent } = await run();
    expect(sent.map((entry) => entry.text)).toEqual(["erst die Nachricht"]);
    expect(outcome.stopReason).toBe("end_turn");
  });

  it("keeps the call order although the SDK starts in parallel", async () => {
    stepScript = [
      [
        { tool: "send_message", args: { text: "eins" } },
        { tool: "send_message", args: { text: "zwei" } },
        { tool: "react", args: { signal: "ok" } },
        { tool: "send_message", args: { text: "drei" } },
        { tool: "end_turn", args: {} },
      ],
    ];
    const { outcome, sent, reactions } = await run();
    expect(sent.map((entry) => entry.text)).toEqual(["eins", "zwei", "drei"]);
    expect(reactions).toEqual(["👍"]);
    expect(outcome.messagesSent).toBe(3);
  });

  it("enforces the limits in the step with end_turn too", async () => {
    stepScript = [
      [
        { tool: "send_message", args: { text: "eins" } },
        { tool: "end_turn", args: {} },
        { tool: "send_message", args: { text: "zwei" } },
        { tool: "send_message", args: { text: "drei" } },
      ],
    ];
    const { outcome, sent } = await run({ maxMessages: 2 });
    expect(sent.map((entry) => entry.text)).toEqual(["eins", "zwei"]);
    // The limit applies immediately, not only at the end of the step, and it is
    // the reason for the end, not the pending end_turn.
    expect(outcome.stopReason).toBe("message_limit");
  });

  it("starts no further model step after end_turn", async () => {
    stepScript = [
      [
        { tool: "send_message", args: { text: "letzte" } },
        { tool: "end_turn", args: {} },
      ],
      [{ tool: "send_message", args: { text: "danach noch was" } }],
    ];
    const { outcome, sent } = await run();
    expect(sent.map((entry) => entry.text)).toEqual(["letzte"]);
    expect(outcome.messagesSent).toBe(1);
  });

  it("rejects a tool from a later step if there is one after all", async () => {
    const { port, sent } = fakePort();
    const registry = new ToolRegistry().registerAll(messagingTools(port));
    const state = new TurnState({
      origin: "owner_message",
      triggerExternalId: "m-1",
      triggerMessageId: "db-1",
      reactableIds: ["m-1"],
    });

    // Step 1: end_turn in parallel with a message.
    await Promise.all([
      registry.execute("end_turn", {}, state),
      registry.execute("send_message", { text: "im selben Schritt" }, state),
    ]);
    expect(sent.map((entry) => entry.text)).toEqual(["im selben Schritt"]);
    expect(state.stopped).toBe(true);

    // Step 2: the same tool, now rejected.
    const late = await registry.execute("send_message", { text: "zu spät" }, state);
    expect(late.ok).toBe(false);
    expect(late.endsTurn).toBe(true);
    expect(sent).toHaveLength(1);
  });
});

/**
 * Finding from the live test 2026-09-18: the Agent SDK path kept running after
 * `end_turn` and started further model steps. The registry correctly rejected
 * their tools (`tool_denied`, `turn_stopped`), but each of these steps costs
 * subscription quota and seconds, and a `send_message` got lost along the way.
 * The turn state now actively signals when it is over.
 */
describe("End signal to the model layer", () => {
  it("signals the end once end_turn was called", async () => {
    script = [
      { tool: "send_message", args: { text: "passt" } },
      { tool: "end_turn", args: {} },
    ];
    await run();
    expect(stopSignalled).toBe(true);
  });

  it("signals only once the sibling calls of the step have run too", async () => {
    // `end_turn` comes first. If the signal fired immediately, the model layer
    // would abort before the message goes out.
    stepScript = [
      [
        { tool: "end_turn", args: {} },
        { tool: "send_message", args: { text: "geht trotzdem raus" } },
        { tool: "send_message", args: { text: "und die auch" } },
      ],
    ];
    const { sent, sentAtSignal } = await run();
    expect(sent.map((entry) => entry.text)).toEqual(["geht trotzdem raus", "und die auch"]);
    expect(sentAtSignal()).toEqual(["geht trotzdem raus", "und die auch"]);
  });

  it("also signals when a limit is hit rather than end_turn", async () => {
    // D11: limits apply immediately, not only at the end of the step. The signal
    // follows these semantics instead of inventing its own.
    stepScript = [
      [
        { tool: "send_message", args: { text: "eins" } },
        { tool: "send_message", args: { text: "zwei" } },
        { tool: "send_message", args: { text: "drei" } },
      ],
    ];
    const { outcome } = await run({ maxMessages: 2 });
    expect(outcome.stopReason).toBe("message_limit");
    expect(stopSignalled).toBe(true);
  });

  it("signals nothing when the model stops on its own", async () => {
    // Then the SDK request ends anyway, and an abort would hit the result
    // frame the token booking comes from.
    script = [{ tool: "send_message", args: { text: "und tschüss" } }];
    await run();
    expect(stopSignalled).toBe(false);
  });
});
