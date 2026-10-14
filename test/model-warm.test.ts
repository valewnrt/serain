import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Subscription path with prewarmed processes (D50), against a fake Agent SDK:
 * which process gets a turn, that the turn ends immediately with `end_turn`
 * instead of waiting for the CLI to shut down, and that tokens per response
 * come from the stream events.
 */

const usageMock = vi.fn(async (_row: Record<string, unknown>) => undefined);
vi.mock("../src/db/usage.js", () => ({ recordModelUsage: (row: Record<string, unknown>) => usageMock(row) }));
vi.mock("../src/db/audit.js", () => ({ audit: async () => undefined }));
vi.mock("../src/budget.js", () => ({ budgetStatus: async () => ({ apiExhausted: false, apiCostUsd: 0 }) }));
vi.mock("../src/config/env.js", () => ({
  env: { openrouterApiKey: "", anthropicApiKey: "", claudeOauthToken: "sk-ant-oat-test", claudeAuth: "oauth", dataDir: "/tmp" },
}));

type Handler = (args: Record<string, unknown>) => Promise<unknown>;
interface FakeProcess {
  id: number;
  warm: boolean;
  closed: boolean;
  prompts: string[];
  /** What the fake does on the next prompt: tools in this order, or fail. */
  failOnPrompt: boolean;
}
const processes: FakeProcess[] = [];
let script: string[] = ["send_message", "end_turn"];

function fakeQuery(proc: FakeProcess, options: { mcpServers: { serain: { tools: Array<{ name: string; handler: Handler }> } } }, prompt: string) {
  proc.prompts.push(prompt);
  let stop: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => (stop = resolve));
  async function* run() {
    if (proc.failOnPrompt) throw new Error("CLI gone");
    yield { type: "stream_event", event: { type: "message_start", message: { id: "msg_1", usage: { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 5, output_tokens: 1 } } } };
    // The assistant frame repeats the start numbers per block; it must not be counted twice.
    yield { type: "assistant", message: { id: "msg_1", usage: { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 5, output_tokens: 1 } } };
    yield { type: "stream_event", event: { type: "message_delta", usage: { output_tokens: 42 } } };
    for (const name of script) {
      const tool = options.mcpServers.serain.tools.find((entry) => entry.name === name);
      await tool?.handler({});
    }
    // Like the real CLI: after the last tool it keeps going until someone ends the process.
    await closed;
  }
  const iterator = run();
  return {
    [Symbol.asyncIterator]: () => iterator,
    close: () => {
      proc.closed = true;
      stop();
    },
  };
}

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: (options: { tools: unknown[] }) => ({ tools: options.tools }),
  tool: (name: string, _description: string, _schema: unknown, handler: Handler) => ({ name, handler }),
  query: ({ prompt, options }: { prompt: string; options: never }) => {
    const proc: FakeProcess = { id: processes.length + 1, warm: false, closed: false, prompts: [], failOnPrompt: false };
    processes.push(proc);
    return fakeQuery(proc, options, prompt);
  },
  startup: async ({ options }: { options: never }) => {
    const proc: FakeProcess = { id: processes.length + 1, warm: true, closed: false, prompts: [], failOnPrompt: false };
    processes.push(proc);
    return {
      query: (prompt: string) => fakeQuery(proc, options, prompt),
      close: () => void (proc.closed = true),
    };
  },
}));

const { runModelTurn, prewarmTurn, closeWarmPool } = await import("../src/agent/model.js");

const tools = [
  { name: "send_message", description: "sends", level: "write_reversible" as const, schema: {}, run: async () => ({ ok: true, text: "" }) },
  { name: "end_turn", description: "End", level: "read" as const, schema: {}, endsTurn: true, run: async () => ({ ok: true, text: "" }) },
];
const shape = { role: "chat" as const, system: "system", tools, maxSteps: 8 };

function turn(system = "system") {
  let stop: () => void = () => undefined;
  const stopSignal = new Promise<void>((resolve) => (stop = resolve));
  const executed: string[] = [];
  return {
    executed,
    request: {
      ...shape,
      system,
      history: [],
      incoming: "hi",
      warm: "chat" as const,
      stopSignal,
      execute: async (name: string) => {
        executed.push(name);
        if (name === "end_turn") stop();
        return { ok: true, text: "ok", endsTurn: name === "end_turn" };
      },
    },
  };
}

beforeEach(() => {
  closeWarmPool();
  processes.length = 0;
  usageMock.mockClear();
  script = ["send_message", "end_turn"];
});

describe("Warm pool (D50)", () => {
  it("gives the turn the waiting process when the shape matches, and refills the slot afterwards", async () => {
    prewarmTurn("chat", shape, { sticky: true });
    await Promise.resolve();
    const { request, executed } = turn();
    const result = await runModelTurn(request);
    expect(executed).toEqual(["send_message", "end_turn"]);
    expect(result.latency?.warm).toBe(true);
    expect(processes[0]).toMatchObject({ warm: true, closed: true });
    expect(processes[0]?.prompts).toHaveLength(1);
    // Refilled, for the owner's next message.
    expect(processes.filter((proc) => proc.warm)).toHaveLength(2);
  });

  it("runs cold when the shape has changed (new user model), and the old process ends", async () => {
    prewarmTurn("chat", shape, { sticky: true });
    await Promise.resolve();
    const { request } = turn("system with new user model");
    const result = await runModelTurn(request);
    expect(result.latency?.warm).toBe(false);
    expect(processes[0]).toMatchObject({ warm: true, closed: true });
    expect(processes[0]?.prompts).toHaveLength(0);
  });

  it("retries a turn cold when the prewarmed process fails before the first tool", async () => {
    prewarmTurn("chat", shape);
    await Promise.resolve();
    processes[0]!.failOnPrompt = true;
    const { request, executed } = turn();
    const result = await runModelTurn(request);
    expect(result.latency?.warm).toBe(false);
    expect(executed).toEqual(["send_message", "end_turn"]);
  });

  it("ends immediately with end_turn and closes the process instead of waiting for it", async () => {
    const { request } = turn();
    await runModelTurn(request);
    expect(processes[0]?.closed).toBe(true);
  });

  it("counts tokens per response from the stream events, not per assistant frame", async () => {
    const { request } = turn();
    await runModelTurn(request);
    expect(usageMock).toHaveBeenCalledWith(
      expect.objectContaining({ inputTokens: 1015, outputTokens: 42, detail: expect.objectContaining({ cache_read: 1000, answers: 1 }) }),
    );
  });

  it("pinned turns (eval) never take a prewarmed process", async () => {
    prewarmTurn("chat", shape, { sticky: true });
    await Promise.resolve();
    const { request } = turn();
    const result = await runModelTurn({ ...request, pin: { provider: "subscription", model: "sonnet" } });
    expect(result.latency?.warm).toBe(false);
    expect(processes[0]?.prompts).toHaveLength(0);
  });
});
