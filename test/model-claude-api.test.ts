import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

/**
 * Claude with an API key against a fake Agent SDK: the child process gets
 * exactly one credential, costs land in `usage_log`, and the monthly cap stops
 * this path too. With the subscription token everything stays at $0.
 */

const state = vi.hoisted(() => ({
  env: {
    openrouterApiKey: "",
    anthropicApiKey: "",
    claudeOauthToken: "",
    claudeAuth: null as "api_key" | "oauth" | null,
    dataDir: "/tmp",
  },
  spentUsd: 0,
  budgetReads: 0,
  queries: [] as Array<{ env: Record<string, string> }>,
  /** What the result frame reports as cost. */
  reportedCostUsd: 0.0123,
}));

const usageMock = vi.fn(async (_row: Record<string, unknown>) => undefined);
const auditMock = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock("../src/db/usage.js", () => ({ recordModelUsage: (row: Record<string, unknown>) => usageMock(row) }));
vi.mock("../src/db/audit.js", () => ({ audit: (...args: unknown[]) => auditMock(...args) }));
vi.mock("../src/budget.js", () => ({
  budgetStatus: async () => {
    state.budgetReads += 1;
    return { apiExhausted: state.spentUsd >= 6.5, apiCostUsd: state.spentUsd };
  },
}));
vi.mock("../src/config/env.js", () => ({ env: state.env }));

type Handler = (args: Record<string, unknown>) => Promise<unknown>;

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: (options: { tools: unknown[] }) => ({ tools: options.tools }),
  tool: (name: string, _description: string, _schema: unknown, handler: Handler) => ({ name, handler }),
  startup: async () => {
    throw new Error("not prewarmed in this test");
  },
  query: ({ prompt, options }: { prompt: unknown; options: { env: Record<string, string>; mcpServers?: { serain: { tools: Array<{ name: string; handler: Handler }> } } } }) => {
    state.queries.push({ env: options.env });
    let stop: () => void = () => undefined;
    const closed = new Promise<void>((resolve) => (stop = resolve));
    async function* run() {
      if (typeof prompt !== "string" || !options.mcpServers) {
        // Single request (structured, image): runs until the result frame.
        yield {
          type: "result",
          subtype: "success",
          result: '{"ok":true}',
          total_cost_usd: state.reportedCostUsd,
          modelUsage: { "claude-haiku-5-5": { inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } },
        };
        return;
      }
      // Turn: stream events, then tools; with `end_turn` the turn ends the process, a result frame never arrives.
      yield {
        type: "stream_event",
        event: { type: "message_start", message: { id: "msg_1", model: "claude-sonnet-5-5", usage: { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 5, output_tokens: 1 } } },
      };
      yield { type: "stream_event", event: { type: "message_delta", usage: { output_tokens: 42 } } };
      for (const tool of options.mcpServers.serain.tools) await tool.handler({});
      await closed;
    }
    const iterator = run();
    return { [Symbol.asyncIterator]: () => iterator, close: () => stop() };
  },
}));

let model: typeof import("../src/agent/model.js");

const tools = [{ name: "end_turn", description: "End", level: "read" as const, schema: {}, endsTurn: true, run: async () => ({ ok: true, text: "" }) }];

function turn() {
  let stop: () => void = () => undefined;
  const stopSignal = new Promise<void>((resolve) => (stop = resolve));
  return {
    role: "chat" as const,
    system: "system",
    tools,
    maxSteps: 4,
    history: [],
    incoming: "hi",
    stopSignal,
    execute: async (name: string) => {
      if (name === "end_turn") stop();
      return { ok: true, text: "ok", endsTurn: name === "end_turn" };
    },
  };
}

function useAuth(claudeAuth: "api_key" | "oauth" | null): void {
  state.env.claudeAuth = claudeAuth;
  state.env.anthropicApiKey = claudeAuth === "api_key" ? "sk-ant-api03-dummy" : "";
  state.env.claudeOauthToken = claudeAuth === "oauth" ? "sk-ant-oat01-dummy" : "";
}

beforeEach(async () => {
  // Fresh module per test: the in-memory budget state of the Claude path starts empty.
  vi.resetModules();
  model = await import("../src/agent/model.js");
  state.queries.length = 0;
  state.spentUsd = 0;
  state.budgetReads = 0;
  state.reportedCostUsd = 0.0123;
  usageMock.mockClear();
  auditMock.mockClear();
  // The inherited environment carries both: still only one may reach the child process.
  vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-api03-inherited");
  vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "sk-ant-oat01-inherited");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Credentials in the child process", () => {
  it("passes only the key when using an API key", async () => {
    useAuth("api_key");
    await model.runModelTurn(turn());
    const childEnv = state.queries[0]!.env;
    expect(childEnv["ANTHROPIC_API_KEY"]).toBe("sk-ant-api03-dummy");
    expect(childEnv).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
  });

  it("passes only the token when using the subscription", async () => {
    useAuth("oauth");
    await model.runModelTurn(turn());
    const childEnv = state.queries[0]!.env;
    expect(childEnv["CLAUDE_CODE_OAUTH_TOKEN"]).toBe("sk-ant-oat01-dummy");
    expect(childEnv).not.toHaveProperty("ANTHROPIC_API_KEY");
  });

  it("starts no process without credentials and goes straight to OpenRouter without a fallback notice", async () => {
    useAuth(null);
    expect(() => model.claudeChildEnv()).toThrow("No Claude access");
    await expect(model.runModelTurn(turn())).rejects.toThrow("OPENROUTER_API_KEY missing");
    model.prewarmTurn("chat", { role: "chat", system: "system", tools, maxSteps: 4 });
    expect(state.queries).toHaveLength(0);
    expect(auditMock).not.toHaveBeenCalled();
  });
});

describe("Costs", () => {
  it("books a turn ended with end_turn at list prices, because the SDK then reports no cost", async () => {
    useAuth("api_key");
    const result = await model.runModelTurn(turn());
    // Sonnet 5.5: 10 × $2 + 42 × $10 + 1000 × $0.20 + 5 × $2.50 per million.
    expect(result.costUsd).toBeCloseTo(652.5e-6, 12);
    expect(usageMock).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "anthropic", costUsd: result.costUsd, detail: expect.objectContaining({ cost_from: "tokens" }) }),
    );
  });

  it("books the cost from the SDK result for a single request", async () => {
    useAuth("api_key");
    const result = await model.runStructured({ role: "extraction", system: "s", prompt: "p", schema: z.object({ ok: z.boolean() }), schemaName: "ok" });
    expect(result.costUsd).toBe(0.0123);
    expect(usageMock).toHaveBeenCalledWith(expect.objectContaining({ provider: "anthropic", costUsd: 0.0123 }));
    await model.describeImage({ jpeg: Buffer.from("image"), instruction: "describe" });
    expect(usageMock).toHaveBeenLastCalledWith(expect.objectContaining({ provider: "anthropic", role: "perception", costUsd: 0.0123 }));
  });

  it("keeps booking $0 with the subscription and never asks the cap", async () => {
    useAuth("oauth");
    state.spentUsd = 100;
    const result = await model.runModelTurn(turn());
    expect(result.costUsd).toBe(0);
    expect(usageMock).toHaveBeenCalledWith(expect.objectContaining({ provider: "subscription", costUsd: 0 }));
    expect(usageMock.mock.calls[0]![0]["detail"]).not.toHaveProperty("cost_from");
    expect(state.budgetReads).toBe(0);
  });
});

describe("Cap", () => {
  it("stops the Claude path at the cap without falling back to OpenRouter", async () => {
    useAuth("api_key");
    state.spentUsd = 6.5;
    await expect(model.runModelTurn(turn())).rejects.toBeInstanceOf(model.BudgetExceededError);
    await expect(
      model.runStructured({ role: "extraction", system: "s", prompt: "p", schema: z.object({ ok: z.boolean() }), schemaName: "ok" }),
    ).rejects.toBeInstanceOf(model.BudgetExceededError);
    expect(state.queries).toHaveLength(0);
    expect(auditMock).not.toHaveBeenCalledWith("model_fallback", expect.anything());
  });

  it("adds its own costs immediately, without rereading before every turn", async () => {
    useAuth("api_key");
    state.spentUsd = 6.49;
    state.reportedCostUsd = 0.02;
    await model.runStructured({ role: "extraction", system: "s", prompt: "p", schema: z.object({ ok: z.boolean() }), schemaName: "ok" });
    await expect(model.runModelTurn(turn())).rejects.toBeInstanceOf(model.BudgetExceededError);
    expect(state.budgetReads).toBe(1);
    expect(state.queries).toHaveLength(1);
  });
});
