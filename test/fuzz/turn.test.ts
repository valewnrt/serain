import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { FUZZ_TIMEOUT_MS, hostileString, params } from "./helpers.js";

/**
 * The turn loop with a model that misbehaves: unknown tools, broken
 * arguments, tools that throw, return nonsense or never come back, and no end
 * on its own. The model is a fake as in test/turn.test.ts: it runs its steps
 * via `execute` and only stops when the turn says so (like the subscription
 * path via `stopSignal`) or its own step limit applies (`maxTurns`).
 *
 * Invariant: the turn ends in bounded time, with at most as many steps and
 * messages as the limits allow, and no audit entry becomes huge. Otherwise a
 * turn blocks the conversation queue, and Serain is mute.
 */

interface Call {
  tool: string;
  args: Record<string, unknown>;
}

let script: Call[][] = [];
let executions = 0;

const audits: Array<{ event: string; detail: Record<string, unknown> }> = [];
vi.mock("../../src/db/audit.js", () => ({
  audit: async (event: string, detail: Record<string, unknown>) => void audits.push({ event, detail }),
}));
vi.mock("../../src/log.js", async (original) => ({
  ...(await original<typeof import("../../src/log.js")>()),
  log: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
}));
vi.mock("../../src/agent/model.js", () => ({
  runModelTurn: async (req: {
    maxSteps: number;
    stopSignal?: Promise<void>;
    execute: (name: string, args: Record<string, unknown>) => Promise<{ endsTurn: boolean }>;
  }) => {
    let stopped = false;
    void req.stopSignal?.then(() => {
      stopped = true;
    });
    // Like the Agent SDK: at most maxTurns steps, parallel calls of a step simultaneously.
    for (const step of script.slice(0, req.maxSteps + 1)) {
      if (stopped) break;
      await Promise.all(
        step.map(async (call) => {
          executions += 1;
          return req.execute(call.tool, call.args);
        }),
      );
    }
    return { provider: "subscription", model: "fake", costUsd: 0, text: "" };
  },
}));

const { runTurn } = await import("../../src/agent/turn.js");
const { messagingTools } = await import("../../src/agent/tools/messaging.js");
const { ToolRegistry } = await import("../../src/agent/tools/registry.js");
const { AUDIT_TEXT_MAX_CHARS, MAX_MESSAGES_PER_TURN, MAX_TOOL_STEPS_PER_TURN } = await import("../../src/config/limits.js");
type MessagePort = import("../../src/agent/tools/messaging.js").MessagePort;
type ToolDefinition = import("../../src/agent/tools/types.js").ToolDefinition;

const port: MessagePort = {
  canReact: true,
  canReplyInThread: true,
  send: async () => true,
  react: async () => true,
};

/** Tools that do everything wrong a tool can do wrong. */
const BROKEN: ToolDefinition[] = [
  { name: "hangs_forever", description: "x", level: "read", schema: {}, timeoutMs: 20, run: () => new Promise<never>(() => undefined) },
  {
    name: "throws_weird",
    description: "x",
    level: "read",
    schema: {},
    run: async () => {
      throw null;
    },
  },
  { name: "returns_garbage", description: "x", level: "read", schema: {}, run: async () => ({ ok: true, text: { nested: true } }) as never },
  { name: "returns_huge", description: "x", level: "read", returnsUntrusted: true, schema: {}, run: async () => ({ ok: true, text: "</untrusted>".repeat(50_000) }) },
];

const registry = new ToolRegistry().registerAll([...messagingTools(port), ...BROKEN]);
const TOOL_NAMES = registry.list().map((def) => def.name);

const call: fc.Arbitrary<Call> = fc.record({
  tool: fc.oneof({ weight: 4, arbitrary: fc.constantFrom(...TOOL_NAMES) }, { weight: 1, arbitrary: fc.constantFrom("Bash", "unknown_tool", "", "mcp__serain__send_message", "x".repeat(500)) }),
  args: fc.oneof(
    // The broken tools take no arguments; without `{}` almost every call would already fail at the schema.
    fc.constant({}),
    fc.record({ text: hostileString }),
    fc.record({ emoji: fc.constantFrom("👍", "ok", "👍👍", ""), message_id: fc.constantFrom("m-1", "m-2", "") }),
    fc.dictionary(fc.string({ maxLength: 8 }), fc.oneof(hostileString, fc.integer(), fc.constant(null)), { maxKeys: 4 }),
  ),
});

describe("Turn loop: a derailed model", () => {
  it(
    "always ends in bounded time, within the limits, with small audit entries",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(fc.array(call, { minLength: 1, maxLength: 4 }), { minLength: 1, maxLength: 30 }),
          fc.constantFrom("owner_message", "heartbeat", "untrusted", "task") as fc.Arbitrary<"owner_message" | "heartbeat" | "untrusted" | "task">,
          async (steps, origin) => {
            script = steps;
            executions = 0;
            audits.length = 0;
            const started = performance.now();
            const outcome = await runTurn(
              { registry, port },
              {
                system: "s",
                history: [],
                incoming: "hallo",
                setup: { origin, triggerExternalId: "m-1", triggerMessageId: "db-1", reactableIds: ["m-1"] },
              },
            );
            // Each step at most as long as its slowest tool (20 ms here), plus headroom.
            expect(performance.now() - started).toBeLessThan(2_000);
            expect(outcome.steps).toBeLessThanOrEqual(MAX_TOOL_STEPS_PER_TURN);
            expect(outcome.messagesSent).toBeLessThanOrEqual(MAX_MESSAGES_PER_TURN);
            // Characters in `detail`, without JSON escapes: that is how much `jsonb` stores.
            for (const entry of audits) expect(JSON.stringify(entry.detail).replace(/\\(u[0-9a-fA-F]{4}|.)/g, "x").length).toBeLessThanOrEqual(AUDIT_TEXT_MAX_CHARS + 4_000);
          },
        ),
        params(60),
      );
    },
    FUZZ_TIMEOUT_MS,
  );

  it("does not hang on a tool that never comes back", async () => {
    script = [[{ tool: "hangs_forever", args: {} }], [{ tool: "send_message", args: { text: "bin noch da" } }], [{ tool: "end_turn", args: {} }]];
    const outcome = await runTurn(
      { registry, port },
      { system: "s", history: [], incoming: "hallo", setup: { origin: "owner_message", triggerExternalId: "m-1", triggerMessageId: "db-1", reactableIds: [] } },
    );
    expect(outcome.messagesSent).toBe(1);
    expect(outcome.stopReason).toBe("end_turn");
  });
});
