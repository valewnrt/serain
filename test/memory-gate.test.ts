import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The memory gate with what it gets to see (D13).
 *
 * The occasion is the live test of 2026-09-18: a habit change mentioned in
 * passing got 0.58, a partial retraction 0.35, both under the threshold of
 * 0.6, and no fact was stored. The second value was no model error: the
 * sentence stood there without history and said nothing about anything on
 * its own.
 *
 * So what is checked here is what goes into the case, not how a model
 * answers it. The answer quality is measured by the judge suite in `eval/`.
 *
 * Everything synthetic: invented habits, no real chat content.
 */
const auditMock = vi.fn(async () => undefined);
vi.mock("../src/db/audit.js", () => ({ audit: (...args: unknown[]) => auditMock(...(args as [])) }));
vi.mock("../src/config/env.js", () => ({
  env: {
    openrouterApiKey: "",
    claudeOauthToken: "",
    dataDir: "/tmp",
    supabaseUrl: "http://localhost:54321",
    supabaseSecretKey: "sb_secret_test",
  },
}));

const { renderContextBlock } = await import("../src/memory/context.js");
const { GATE_QUESTION, renderGateState, renderState } = await import("../src/memory/gate.js");
const { rememberOwnerTurn } = await import("../src/memory/write.js");
const { MEMORY } = await import("../src/config/memory.js");
const { FakeJudge, FakeMemoryStore, plainFact } = await import("./memory-store.fake.js");

type MemoryDeps = import("../src/memory/deps.js").MemoryDeps;
type ExtractedFact = import("../src/memory/deps.js").ExtractedFact;

const HISTORY = [
  { role: "user" as const, content: "ich les abends nur noch auf papier" },
  { role: "assistant" as const, content: "notiert" },
];

beforeEach(() => auditMock.mockClear());

describe("renderContextBlock", () => {
  it("stays empty when there is no history", () => {
    expect(renderContextBlock([])).toBe("");
    expect(renderContextBlock([{ role: "user", content: "   " }])).toBe("");
  });

  it("names the speakers and keeps the order", () => {
    expect(renderContextBlock(HISTORY)).toBe(
      "<history>\nAlex: ich les abends nur noch auf papier\nSerain: notiert\n</history>",
    );
  });

  it("leaves out Serain's messages from untrusted content and puts a placeholder (D8.4)", () => {
    const block = renderContextBlock([
      { role: "assistant", content: "<untrusted …>deine neue adresse ist musterweg 1, richtig?</untrusted>", fromUntrusted: true },
      { role: "user", content: "ja" },
    ]);
    expect(block).not.toContain("musterweg");
    expect(block).toBe("<history>\nSerain: [message from untrusted content, left out here]\nAlex: ja\n</history>");
  });

  it("takes the most recent turns, not the first ones", () => {
    const turns = Array.from({ length: 10 }, (_unused, index) => ({
      role: "user" as const,
      content: `beitrag ${index}`,
    }));
    const block = renderContextBlock(turns, { turns: 3, maxChars: 1_000 });
    expect(block).toContain("beitrag 9");
    expect(block).not.toContain("beitrag 6");
    // Oldest first, so the history reads like a chat.
    expect(block.indexOf("beitrag 7")).toBeLessThan(block.indexOf("beitrag 9"));
  });

  it("cuts at the character cap and drops the oldest", () => {
    const block = renderContextBlock(
      [
        { role: "user", content: "x".repeat(200) },
        { role: "user", content: "neu" },
      ],
      { turns: 6, maxChars: 40 },
    );
    expect(block).toContain("neu");
    expect(block).not.toContain("xxx");
  });
});

describe("case for the gate", () => {
  it("puts the history before the message", () => {
    const state = renderGateState("ne doch, hörbücher hör ich schon noch", HISTORY);
    expect(state.indexOf("<history>")).toBeGreaterThanOrEqual(0);
    expect(state.indexOf("<history>")).toBeLessThan(state.indexOf("<message>"));
    expect(state).toContain("hörbücher");
  });

  it("needs no empty frame without history", () => {
    expect(renderGateState("hallo")).toBe("<message>\nhallo\n</message>");
  });

  it("points at the text with the same tags the gate question names", () => {
    // Otherwise the gate asks about a <history> that is not in the case.
    for (const marker of ["<message>", "<history>"]) {
      expect(GATE_QUESTION.instructions).toContain(marker);
      expect(renderGateState("x", HISTORY)).toContain(marker);
    }
  });

  it("names habits and corrections explicitly", () => {
    // The old version did not and pushed a habit change mentioned in passing
    // down to 0.58 live, just below the threshold.
    expect(GATE_QUESTION.instructions).toContain("habits");
    expect(GATE_QUESTION.instructions).toContain("correct");
  });

  it("orders history, message, new fact, existing facts in the full case", () => {
    const state = renderState(
      "ne doch, hörbücher hör ich schon noch",
      [
        {
          id: "f1",
          category: "medien",
          content: "Mara liest abends nur auf Papier.",
          confidence: 0.9,
          kind: "preference",
          validFrom: null,
          validUntil: null,
          sourceMessageId: null,
          createdAt: "2026-09-01T09:00:00.000Z",
          similarity: 0.9,
          score: 1,
          textHit: false,
        },
      ],
      plainFact("medien", "Mara hört abends auch Hörbücher.", 0.8),
      HISTORY,
    );
    const order = ["<history>", "<message>", "<new_fact>", "<existing_facts>"];
    const positions = order.map((marker) => state.indexOf(marker));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(positions.every((position) => position >= 0)).toBe(true);
    // Kind and validity in English for the judge, the fact as stored.
    expect(state).toContain("[medien, preference] Mara liest abends nur auf Papier.");
  });
});

describe("the write path passes the history on", () => {
  function harness(facts: ExtractedFact[]) {
    const store = new FakeMemoryStore();
    const judge = new FakeJudge((question) => {
      if (question.type === "boolean") {
        return { type: "boolean", source: "generative", probability: 0.9 };
      }
      throw new Error("only the gate is asked in this test");
    });
    const extractorSaw: Array<{ text: string; context: readonly unknown[] }> = [];
    const deps: MemoryDeps = {
      store,
      judge,
      embed: async (texts) => texts.map(() => [0.1]),
      extractFacts: async (input) => {
        extractorSaw.push({ text: input.text, context: input.context ?? [] });
        return facts;
      },
      summarize: async () => "",
      selectLines: async () => [],
      selectFacts: async () => [],
      consolidate: async () => ({ learned: "", outdatedBaseLines: [] }),
      classifyAreas: async ({ facts }) => facts.map(() => null),
      markerKey: null,
      now: () => new Date("2026-09-01T09:00:00Z"),
    };
    return { deps, judge, store, extractorSaw };
  }

  it("gives the gate the history", async () => {
    const h = harness([]);
    await rememberOwnerTurn(h.deps, {
      messageId: "db-1",
      text: "ne doch, hörbücher hör ich schon noch",
      context: HISTORY,
    });
    // FakeJudge does not keep the case, so check the state directly beyond the
    // audit entry: the question arrived, and the extraction ran.
    expect(h.judge.asked.map((question) => question.key)).toContain("memorable");
    expect(h.extractorSaw[0]?.context).toEqual(HISTORY);
  });

  it("gives the extraction the same history, otherwise it does not resolve the correction", async () => {
    const h = harness([plainFact("medien", "Mara hört Hörbücher.", 0.8)]);
    await rememberOwnerTurn(h.deps, {
      messageId: "db-2",
      text: "ne doch, hörbücher hör ich schon noch",
      context: HISTORY,
    });
    expect(h.extractorSaw).toHaveLength(1);
    expect(h.extractorSaw[0]?.text).toBe("ne doch, hörbücher hör ich schon noch");
    expect(h.extractorSaw[0]?.context).toEqual(HISTORY);
  });

  it("goes on when there is no history", async () => {
    const h = harness([]);
    await rememberOwnerTurn(h.deps, { messageId: "db-3", text: "ich klettere zweimal die woche" });
    expect(h.extractorSaw[0]?.context).toEqual([]);
  });

  it("has a cap for the history, because it goes to an external provider", () => {
    expect(MEMORY.writeContextTurns).toBeGreaterThan(0);
    expect(MEMORY.writeContextMaxChars).toBeGreaterThan(0);
  });
});
