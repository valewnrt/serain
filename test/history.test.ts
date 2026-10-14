import { describe, expect, it, vi } from "vitest";

/**
 * History search and vectors for messages (V3, D41), with a fake database.
 * Synthetic: invented person, invented places.
 */
vi.mock("../src/db/audit.js", () => ({ audit: async () => undefined }));
vi.mock("../src/config/env.js", () => ({
  env: { openrouterApiKey: "", claudeOauthToken: "", dataDir: "/tmp", integrationKey: "", supabaseUrl: "http://localhost:54321", supabaseSecretKey: "sb_secret_test" },
}));

const { historyTools } = await import("../src/agent/tools/history.js");
const { embedPendingMessages } = await import("../src/memory/index.js");
const { buildMemoryContext } = await import("../src/memory/recall.js");
const { ToolRegistry } = await import("../src/agent/tools/registry.js");
const { TurnState } = await import("../src/agent/tools/types.js");
const { FakeJudge, FakeMemoryStore } = await import("./memory-store.fake.js");

type MemoryDeps = import("../src/memory/deps.js").MemoryDeps;

function deps(store: InstanceType<typeof FakeMemoryStore>, embed: MemoryDeps["embed"] = async (texts) => texts.map(() => [0.1])): MemoryDeps {
  return {
    store,
    judge: new FakeJudge(() => ({ type: "boolean", source: "generative", probability: 0 })),
    embed,
    extractFacts: async () => [],
    summarize: async () => "",
    selectLines: async () => [],
    selectFacts: async () => [],
    consolidate: async () => ({ learned: "", outdatedBaseLines: [] }),
    classifyAreas: async ({ facts }) => facts.map(() => null),
    markerKey: null,
    now: () => new Date("2026-09-20T10:00:00Z"),
  };
}

function turn() {
  return new TurnState({ origin: "owner_message", triggerExternalId: "x", triggerMessageId: "y", reactableIds: [] });
}

describe("search_history (V3)", () => {
  it("finds earlier messages, sorted by time, and frames what Serain wrote after untrusted content, without tainting the turn", async () => {
    const store = new FakeMemoryStore();
    store.addMessage("inbound", "der vermieter will die kaution erst im märz zurückzahlen", new Date("2026-09-01T10:00:00Z"));
    store.addMessage("outbound", "Laut der Mail der Hausverwaltung kommt die Kaution im März.", new Date("2026-09-02T10:00:00Z"), true);
    store.addMessage("inbound", "was ganz anderes", new Date("2026-09-03T10:00:00Z"));
    const registry = new ToolRegistry().registerAll(historyTools({ memory: deps(store), ownerPhone: "+490000000000" }));
    const state = turn();
    const result = await registry.execute("search_history", { query: "kaution märz" }, state);
    expect(result.ok).toBe(true);
    const lines = result.text.split("\n");
    expect(lines[0]).toContain("Alex: der vermieter will die kaution");
    expect(result.text).toContain("<untrusted");
    expect(result.text).not.toContain("was ganz anderes");
    expect(state.tainted).toBe(false);
  });

  it("filters by Berlin calendar days", async () => {
    const store = new FakeMemoryStore();
    // 23:30 Berlin time on 1 Sept is still 1 Sept, in UTC already 21:30.
    store.addMessage("inbound", "kaution vom ersten", new Date("2026-09-01T21:30:00Z"));
    store.addMessage("inbound", "kaution vom zweiten", new Date("2026-09-02T08:00:00Z"));
    const registry = new ToolRegistry().registerAll(historyTools({ memory: deps(store), ownerPhone: "+490000000000" }));
    const result = await registry.execute("search_history", { query: "kaution", from: "2026-09-01", to: "2026-09-01" }, turn());
    expect(result.text).toContain("kaution vom ersten");
    expect(result.text).not.toContain("kaution vom zweiten");
  });
});

describe("Vectors for the history (V3)", () => {
  it("backfills missing vectors in one call and skips empty messages", async () => {
    const store = new FakeMemoryStore();
    store.addMessage("inbound", "eins", new Date("2026-09-01T10:00:00Z"));
    store.addMessage("outbound", "zwei", new Date("2026-09-01T10:01:00Z"));
    store.addMessage("inbound", "", new Date("2026-09-01T10:02:00Z"));
    const embed = vi.fn(async (texts: readonly string[]) => texts.map(() => [0.2]));
    expect(await embedPendingMessages(deps(store, embed))).toBe(2);
    expect(embed).toHaveBeenCalledTimes(1);
    expect(await embedPendingMessages(deps(store, embed))).toBe(0);
  });
});

describe("Summaries in recall (V3)", () => {
  it("takes the most recent plus older matching ones, without duplicates, in chronological order", async () => {
    const store = new FakeMemoryStore();
    for (let i = 1; i <= 5; i += 1) {
      store.summaries.push({ id: `s${i}`, windowStart: `2026-09-0${i}T00:00:00Z`, windowEnd: `2026-09-0${i}T12:00:00Z`, content: `Section ${i}`, messageCount: 10 });
    }
    store.summaryEmbeddings.add("s1");
    store.summaryEmbeddings.add("s5");
    const context = await buildMemoryContext(deps(store), { incoming: "egal" });
    expect(context.summaries.map((summary) => summary.id)).toEqual(["s1", "s4", "s5"]);
  });

  it("sticks to the most recent without a vector", async () => {
    const store = new FakeMemoryStore();
    store.summaries.push({ id: "s1", windowStart: "2026-09-01T00:00:00Z", windowEnd: "2026-09-01T12:00:00Z", content: "x", messageCount: 10 });
    store.summaryEmbeddings.add("s1");
    const context = await buildMemoryContext(
      deps(store, async () => {
        throw new Error("no budget");
      }),
      { incoming: "egal" },
    );
    expect(context.summaries.map((summary) => summary.id)).toEqual(["s1"]);
  });
});
