import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What the paid fallback path really looks like, checked on the request, not
 * on the intent.
 *
 * 1. **Zero Data Retention (D3).** No exception: every OpenRouter request goes
 *    through a ZDR provider. The paths are checked one by one because the
 *    policy used to be split (soft for chat, hard for memory) and exactly such
 *    a split can creep back in unnoticed.
 * 2. **End of turn.** After the step with `end_turn` the SDK starts no further
 *    step, the same semantics as on the subscription path.
 */

const usageMock = vi.fn(async () => undefined);
const auditMock = vi.fn(async () => undefined);

vi.mock("../src/db/usage.js", () => ({
  recordModelUsage: (...args: unknown[]) => usageMock(...(args as [])),
}));
vi.mock("../src/db/audit.js", () => ({ audit: (...args: unknown[]) => auditMock(...(args as [])) }));
vi.mock("../src/budget.js", () => ({
  budgetStatus: async () => ({ apiExhausted: false, apiCostUsd: 0 }),
}));
vi.mock("../src/config/env.js", () => ({
  env: {
    openrouterApiKey: "sk-or-v1-test",
    // Empty: the subscription path fails immediately, and every call lands in
    // the paid fallback, exactly the path this is about.
    claudeOauthToken: "",
    dataDir: "/tmp",
    supabaseUrl: "http://localhost:54321",
    supabaseSecretKey: "sb_secret_test",
  },
}));

/** Options of every `createOpenRouter` call, in call order. */
const providerOptions: Array<Record<string, unknown>> = [];
/** Options of every `generateText`/`generateObject` call. */
const callOptions: Array<Record<string, unknown>> = [];

vi.mock("@openrouter/ai-sdk-provider", () => ({
  createOpenRouter: (options: Record<string, unknown>) => {
    providerOptions.push(options);
    return { chat: (model: string) => ({ modelId: model }) };
  },
}));

vi.mock("ai", () => ({
  generateText: async (options: Record<string, unknown>) => {
    callOptions.push(options);
    return {
      steps: [],
      totalUsage: { inputTokens: 10, outputTokens: 5 },
      text: "",
    };
  },
  generateObject: async (options: Record<string, unknown>) => {
    callOptions.push(options);
    return {
      object: { ok: true },
      usage: { inputTokens: 10, outputTokens: 5 },
      providerMetadata: {},
    };
  },
  tool: (definition: unknown) => definition,
  stepCountIs: (count: number) => ({ kind: "stepCountIs", count }),
  hasToolCall: (name: string) => ({ kind: "hasToolCall", name }),
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: () => ({}),
  query: () => {
    throw new Error("subscription path is off in this test");
  },
  tool: (name: string, description: string) => ({ name, description }),
}));

const { runModelTurn, runStructured } = await import("../src/agent/model.js");
const { OPENROUTER_PROVIDER_POLICY } = await import("../src/config/models.js");
const { embedOne } = await import("../src/memory/embeddings.js");
const { jevRequestBody } = await import("../src/agent/judge/jev.js");
const { assertZeroDataRetention } = await import("../eval/config.js");
const { z } = await import("zod");
const { WRAP_UP_STEPS } = await import("../src/config/limits.js");

const EXPECTED = { zdr: true, data_collection: "deny" };

const fetchMock = vi.fn();

beforeEach(() => {
  providerOptions.length = 0;
  callOptions.length = 0;
  usageMock.mockClear();
  auditMock.mockClear();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

function lastProviderPolicy(): unknown {
  const last = providerOptions.at(-1);
  return (last?.["extraBody"] as { provider?: unknown } | undefined)?.provider;
}

describe("Zero Data Retention on every OpenRouter path (D3)", () => {
  it("knows exactly one policy, and it demands both", () => {
    expect(OPENROUTER_PROVIDER_POLICY).toEqual(EXPECTED);
  });

  it("chat fallback: the policy is in the request", async () => {
    await runModelTurn({
      role: "chat",
      system: "system",
      history: [],
      incoming: "hi",
      tools: [],
      execute: async () => ({ ok: true, text: "", endsTurn: false }),
      maxSteps: 4,
      pin: { provider: "openrouter", model: "test/model" },
    });
    expect(providerOptions).toHaveLength(1);
    expect(lastProviderPolicy()).toEqual(EXPECTED);
  });

  it("runStructured: the policy is in the request", async () => {
    await runStructured({
      role: "extraction",
      system: "system",
      prompt: "prompt",
      schema: z.object({ ok: z.boolean() }),
      schemaName: "Test",
    });
    expect(providerOptions).toHaveLength(1);
    expect(lastProviderPolicy()).toEqual(EXPECTED);
  });

  it("embeddings: the policy is in the request", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [{ embedding: Array.from({ length: 1536 }, () => 0.1) }],
          model: "text-embedding-3-small",
          usage: { prompt_tokens: 3, total_tokens: 3, cost: 0 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    await embedOne("synthetic text");
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(body["provider"]).toEqual(EXPECTED);
  });

  it("Jev: the policy is in the request", () => {
    const body = jevRequestBody("Case", {
      key: "worth_remembering",
      type: "boolean",
      instructions: "Does this contain a lasting fact?",
    });
    expect(body["provider"]).toEqual(EXPECTED);
  });

  it("eval: the gatekeeper before the first paid call lets the policy pass", () => {
    expect(() => assertZeroDataRetention()).not.toThrow();
  });
});

describe("End of turn on the OpenRouter path", () => {
  it("stops after the step with a turn-ending tool, without guessing the name", async () => {
    await runModelTurn({
      role: "chat",
      system: "system",
      history: [],
      incoming: "hi",
      tools: [
        { name: "send_message", description: "", level: "write_reversible", schema: {}, run: async () => ({ ok: true, text: "" }) },
        { name: "end_turn", description: "", level: "read", schema: {}, endsTurn: true, run: async () => ({ ok: true, text: "" }) },
      ],
      execute: async () => ({ ok: true, text: "", endsTurn: false }),
      maxSteps: 4,
      pin: { provider: "openrouter", model: "test/model" },
    });
    // The condition comes from the tool definition (`endsTurn`), not from a
    // second name hardcoded here.
    expect(callOptions[0]?.["stopWhen"]).toEqual([
      { kind: "stepCountIs", count: 4 + WRAP_UP_STEPS },
      { kind: "hasToolCall", name: "end_turn" },
      // End from outside (upper limit, preemption by a new message, D50).
      expect.any(Function),
    ]);
  });

  it("with a turn signal the turn decides: a rejected end_turn ends nothing (D57)", async () => {
    await runModelTurn({
      role: "chat",
      system: "system",
      history: [],
      incoming: "hi",
      tools: [{ name: "end_turn", description: "", level: "read", schema: {}, endsTurn: true, run: async () => ({ ok: true, text: "" }) }],
      execute: async () => ({ ok: true, text: "", endsTurn: false }),
      maxSteps: 4,
      stopSignal: new Promise<void>(() => undefined),
      pin: { provider: "openrouter", model: "test/model" },
    });
    expect(callOptions[0]?.["stopWhen"]).toEqual([{ kind: "stepCountIs", count: 4 + WRAP_UP_STEPS }, expect.any(Function)]);
  });

  it("reports every new response and gives the restart what Alex sent in the meantime (D57)", async () => {
    let responses = 0;
    await runModelTurn({
      role: "chat",
      system: "system",
      history: [],
      incoming: "such Flüge nach Rom",
      tools: [],
      execute: async () => ({ ok: true, text: "", endsTurn: false }),
      maxSteps: 4,
      onResponse: () => void (responses += 1),
      restartNotes: () => '<addendum message_id="m-2">\nnur direkt\n</addendum>',
    });
    const options = callOptions[0] as { prepareStep: () => unknown; messages: Array<{ content: string }> };
    expect(options.messages.at(-1)?.content).toBe('such Flüge nach Rom\n\n<addendum message_id="m-2">\nnur direkt\n</addendum>');
    options.prepareStep();
    options.prepareStep();
    expect(responses).toBe(2);
  });
});
