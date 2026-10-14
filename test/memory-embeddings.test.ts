import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Embeddings go to an external provider and carry facts about the owner.
 * So the main check is this: the ZDR parameters are in every
 * request, and a response with the wrong width is not passed through.
 */
const usageMock = vi.fn(async () => undefined);
let apiExhausted = false;

vi.mock("../src/db/usage.js", () => ({
  recordModelUsage: (...args: unknown[]) => usageMock(...(args as [])),
}));
vi.mock("../src/budget.js", () => ({
  budgetStatus: async () => ({ apiExhausted, apiCostUsd: apiExhausted ? 6.5 : 0 }),
}));
vi.mock("../src/config/env.js", () => ({
  env: {
    openrouterApiKey: "sk-or-v1-test",
    claudeOauthToken: "",
    dataDir: "/tmp",
    supabaseUrl: "http://localhost:54321",
    supabaseSecretKey: "sb_secret_test",
  },
}));

const { embed, embedOne, embedBestEffort, EmbeddingUnavailableError } = await import(
  "../src/memory/embeddings.js"
);
const { EMBEDDING } = await import("../src/config/models.js");

const fetchMock = vi.fn();

function vector(length: number = EMBEDDING.dimensions): number[] {
  return Array.from({ length }, (_, i) => i / length);
}

function ok(vectors: number[][]): Response {
  return new Response(
    JSON.stringify({
      data: vectors.map((embedding) => ({ embedding })),
      model: "text-embedding-3-small",
      usage: { prompt_tokens: 14, total_tokens: 14, cost: 2.8e-7 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

beforeEach(() => {
  apiExhausted = false;
  usageMock.mockClear();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

describe("Embeddings", () => {
  it("sets the ZDR parameters in every request", async () => {
    fetchMock.mockResolvedValue(ok([vector()]));
    await embedOne("synthetischer Text");

    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string) as Record<string, unknown>;
    expect(body["provider"]).toEqual({ zdr: true, data_collection: "deny" });
    expect(body["model"]).toBe(EMBEDDING.openrouter);
  });

  it("books the cost in usage_log", async () => {
    fetchMock.mockResolvedValue(ok([vector()]));
    await embedOne("synthetischer Text");
    expect(usageMock).toHaveBeenCalledWith(
      expect.objectContaining({ role: "embedding", provider: "openrouter" }),
    );
  });

  it("does not even ask when the API cap is used up", async () => {
    apiExhausted = true;
    await expect(embedOne("x")).rejects.toBeInstanceOf(EmbeddingUnavailableError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a wrong vector width instead of pushing it into the column", async () => {
    fetchMock.mockResolvedValue(ok([vector(768)]));
    await expect(embedOne("x")).rejects.toThrow(/dimensions/);
  });

  it("rejects an incomplete response", async () => {
    fetchMock.mockResolvedValue(ok([vector()]));
    await expect(embed(["eins", "zwei"])).rejects.toThrow(/vectors/);
  });

  it("makes no request without input", async () => {
    expect(await embed([])).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("embedBestEffort", () => {
  it("returns one vector per text, in order", async () => {
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { input: string[] };
      return ok(body.input.map((_, i) => vector(EMBEDDING.dimensions).map((v) => v + i)));
    });

    const result = await embedBestEffort(["eins", "zwei", "drei"], 20);
    expect(result).toHaveLength(3);
    for (const entry of result) expect(entry).not.toBeNull();
  });

  it("bundles into batches of the given size", async () => {
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { input: string[] };
      return ok(body.input.map(() => vector()));
    });

    const texts = Array.from({ length: 25 }, (_, i) => `fakt ${i}`);
    const result = await embedBestEffort(texts, 10);

    expect(result).toHaveLength(25);
    expect(fetchMock).toHaveBeenCalledTimes(3); // 10 + 10 + 5
    const sizes = fetchMock.mock.calls.map(
      (call) => (JSON.parse((call[1] as RequestInit).body as string) as { input: string[] }).input.length,
    );
    expect(sizes).toEqual([10, 10, 5]);
  });

  it("does not let a failed batch take down the whole call", async () => {
    let call = 0;
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
      call += 1;
      const body = JSON.parse(init.body as string) as { input: string[] };
      if (call === 2) return new Response("Server Error", { status: 500 });
      return ok(body.input.map(() => vector()));
    });

    const texts = Array.from({ length: 30 }, (_, i) => `fakt ${i}`);
    const result = await embedBestEffort(texts, 10);

    expect(result).toHaveLength(30);
    // First and third batch (index 0-9, 20-29) have a vector, the
    // second (10-19) stayed null: exactly the one that got HTTP 500.
    expect(result.slice(0, 10).every((v) => v !== null)).toBe(true);
    expect(result.slice(10, 20).every((v) => v === null)).toBe(true);
    expect(result.slice(20, 30).every((v) => v !== null)).toBe(true);
  });

  it("books only the batches that actually made a request", async () => {
    apiExhausted = true;
    const result = await embedBestEffort(["a", "b"], 20);
    expect(result).toEqual([null, null]);
    expect(usageMock).not.toHaveBeenCalled();
  });
});
