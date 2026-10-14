import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * [W8] The acceptance test for memory v1.
 *
 * Set the same fact, correct it twice, fast-forward three days (with the
 * summary rollover) and then check what ends up in the context. Exactly that
 * is what two App Store reviews accuse Bo of: corrected details come back
 * later. Here only the last correction may be left.
 *
 * Everything synthetic: invented person, invented places, no real data.
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

const { rememberOwnerTurn } = await import("../src/memory/write.js");
const { buildMemoryContext, renderMemory } = await import("../src/memory/recall.js");
const { rollUpSummaries } = await import("../src/memory/summaries.js");
const { MEMORY } = await import("../src/config/memory.js");
const { FakeJudge, FakeMemoryStore, choiceFor } = await import("./memory-store.fake.js");

type MemoryDeps = import("../src/memory/deps.js").MemoryDeps;
type ExtractedFact = import("../src/memory/deps.js").ExtractedFact;
type JudgeAnswer = import("../src/agent/judge/types.js").JudgeAnswer;
type JudgeQuestion = import("../src/agent/judge/types.js").JudgeQuestion;

const DAY = 24 * 60 * 60_000;
const START = new Date("2026-09-01T09:00:00Z");

interface Harness {
  deps: MemoryDeps;
  store: InstanceType<typeof FakeMemoryStore>;
  judge: InstanceType<typeof FakeJudge>;
  clock: { now: Date };
  summarizerSawFacts: string[][];
  extraction: { facts: ExtractedFact[] };
}

function harness(options: { judge?: (q: JudgeQuestion, state: string) => JudgeAnswer } = {}): Harness {
  const store = new FakeMemoryStore();
  const clock = { now: new Date(START) };
  const extraction: { facts: ExtractedFact[] } = { facts: [] };
  const summarizerSawFacts: string[][] = [];

  const judge = new FakeJudge(
    options.judge ??
      ((question) => {
        if (question.type === "boolean") {
          return { type: "boolean", source: "generative", probability: 0.9 };
        }
        if (question.type === "choice") return choiceFor(question, 0, 0.95);
        return {
          type: "score",
          source: "generative",
          score: 2,
          textHit: false,
          index: 2,
          label: question.scale[2] ?? "",
          probabilities: { "0": 0, "1": 0, "2": 1, "3": 0 },
          confidence: 1,
        };
      }),
  );

  const deps: MemoryDeps = {
    store,
    judge,
    embed: async (texts) => texts.map(() => [0.1, 0.2, 0.3]),
    extractFacts: async () => extraction.facts,
    summarize: async (input) => {
      summarizerSawFacts.push([...input.knownFacts]);
      // A model that sticks to the instruction: what already stands as a fact,
      // outdated ones included, does not go into the summary.
      const body = input.messages
        .map((message) => message.body)
        .filter((body) => !input.knownFacts.some((fact) => overlaps(fact, body)))
        .join(" ");
      return `Zusammenfassung: ${body}`.trim();
    },
    selectLines: async () => [],
    selectFacts: async () => [],
    consolidate: async () => ({ learned: "", outdatedBaseLines: [] }),
    classifyAreas: async ({ facts }) => facts.map(() => null),
    markerKey: null,
    now: () => clock.now,
  };

  return { deps, store, judge, clock, summarizerSawFacts, extraction };
}

/** Rough word match, so that the fake summary really sorts out facts. */
function overlaps(fact: string, message: string): boolean {
  const words = message
    .toLowerCase()
    .split(/\W+/)
    .filter((word) => word.length > 4);
  return words.some((word) => fact.toLowerCase().includes(word));
}

async function say(h: Harness, text: string, facts: ExtractedFact[], at: Date): Promise<void> {
  h.clock.now = at;
  const messageId = h.store.addMessage("inbound", text, at);
  h.extraction.facts = facts;
  await rememberOwnerTurn(h.deps, { messageId, text });
}

const wohnort = (ort: string): ExtractedFact[] => [
  { category: "wohnort", content: `Mara wohnt in ${ort}.`, confidence: 0.9, kind: "identity", validFrom: null, validUntil: null },
];

beforeEach(() => auditMock.mockClear());

describe("[W8] set a fact, correct it twice, check three days later", () => {
  it("leaves only the last correction in the context", async () => {
    const h = harness();

    await say(h, "ich wohne in Ahrenfeld", wohnort("Ahrenfeld"), new Date(START));
    await say(h, "bin nach Bruckstadt gezogen", wohnort("Bruckstadt"), new Date(START.getTime() + DAY));
    await say(h, "jetzt doch Cordheim", wohnort("Cordheim"), new Date(START.getTime() + 2 * DAY));

    // Three days of chat on top, so that the history window overflows.
    for (let i = 0; i < 40; i += 1) {
      const at = new Date(START.getTime() + 3 * DAY + i * 60_000);
      h.store.addMessage(i % 2 === 0 ? "inbound" : "outbound", `Smalltalk ${i}`, at);
    }
    h.clock.now = new Date(START.getTime() + 5 * DAY);
    expect(await rollUpSummaries(h.deps)).toBe(true);

    const context = await buildMemoryContext(h.deps, { incoming: "wo wohne ich nochmal" });
    const rendered = renderMemory(context);

    expect(rendered).toContain("Cordheim");
    expect(rendered).not.toContain("Ahrenfeld");
    expect(rendered).not.toContain("Bruckstadt");

    // The old versions are replaced, not deleted: provenance stays (D6).
    const all = await h.store.allFactContents();
    expect(all).toHaveLength(3);
    expect((await h.store.activeFacts()).map((fact) => fact.content)).toEqual([
      "Mara wohnt in Cordheim.",
    ]);
  });

  it("also gives the summary the outdated versions to sort out", async () => {
    const h = harness();
    await say(h, "ich wohne in Ahrenfeld", wohnort("Ahrenfeld"), new Date(START));
    await say(h, "jetzt Bruckstadt", wohnort("Bruckstadt"), new Date(START.getTime() + DAY));

    for (let i = 0; i < 40; i += 1) {
      h.store.addMessage("inbound", `Smalltalk ${i}`, new Date(START.getTime() + 2 * DAY + i * 60_000));
    }
    await rollUpSummaries(h.deps);

    const seen = h.summarizerSawFacts[0] ?? [];
    expect(seen).toContain("Mara wohnt in Ahrenfeld.");
    expect(seen).toContain("Mara wohnt in Bruckstadt.");
  });

  it("does not bring a replaced version back through the summary either", async () => {
    const h = harness();
    await say(h, "ich wohne in Ahrenfeld", wohnort("Ahrenfeld"), new Date(START));
    await say(h, "jetzt Bruckstadt", wohnort("Bruckstadt"), new Date(START.getTime() + DAY));

    for (let i = 0; i < 40; i += 1) {
      h.store.addMessage("inbound", `Smalltalk ${i}`, new Date(START.getTime() + 2 * DAY + i * 60_000));
    }
    await rollUpSummaries(h.deps);

    const context = await buildMemoryContext(h.deps, { incoming: "wo wohne ich" });
    expect(renderMemory(context)).not.toContain("Ahrenfeld");
  });
});

describe("threshold logic", () => {
  it("replaces at high probability", async () => {
    const h = harness();
    await say(h, "ich wohne in Ahrenfeld", wohnort("Ahrenfeld"), new Date(START));
    await say(h, "jetzt Bruckstadt", wohnort("Bruckstadt"), new Date(START.getTime() + DAY));

    expect(await h.store.activeFacts()).toHaveLength(1);
    expect(auditMock).toHaveBeenCalledWith(
      "memory_fact",
      expect.objectContaining({ decision: "superseded" }),
      expect.any(String),
    );
  });

  it("keeps both in the middle range and notes the conflict as a follow-up question", async () => {
    const h = harness({
      judge: (question) => {
        if (question.type === "boolean") {
          return { type: "boolean", source: "generative", probability: 0.9 };
        }
        // 0.6 lies between supersedeLow (0.45) and supersedeHigh (0.8).
        if (question.type === "choice") return choiceFor(question, 0, 0.6);
        return {
          type: "score",
          source: "generative",
          score: 2.4,
          textHit: false,
          index: 2,
          label: question.scale[2] ?? "",
          probabilities: { "0": 0, "1": 0.1, "2": 0.4, "3": 0.5 },
          confidence: 0.5,
        };
      },
    });

    await say(h, "ich wohne in Ahrenfeld", wohnort("Ahrenfeld"), new Date(START));
    await say(h, "jetzt Bruckstadt", wohnort("Bruckstadt"), new Date(START.getTime() + DAY));

    const active = await h.store.activeFacts();
    expect(active).toHaveLength(2);
    expect(h.store.questions).toHaveLength(1);
    expect(h.store.questions[0]?.question).toContain("Bruckstadt");
    expect(h.store.questions[0]?.status).toBe("open");
  });

  it("does not ask in the middle range when a wrong assumption would be cheap", async () => {
    const h = harness({
      judge: (question) => {
        if (question.type === "boolean") {
          return { type: "boolean", source: "generative", probability: 0.9 };
        }
        if (question.type === "choice") return choiceFor(question, 0, 0.6);
        // W20: below conflictImportanceMin there is no question.
        return {
          type: "score",
          source: "generative",
          score: 0.4,
          textHit: false,
          index: 0,
          label: question.scale[0] ?? "",
          probabilities: { "0": 0.7, "1": 0.2, "2": 0.1, "3": 0 },
          confidence: 0.7,
        };
      },
    });

    await say(h, "ich wohne in Ahrenfeld", wohnort("Ahrenfeld"), new Date(START));
    await say(h, "jetzt Bruckstadt", wohnort("Bruckstadt"), new Date(START.getTime() + DAY));

    expect(await h.store.activeFacts()).toHaveLength(2);
    expect(h.store.questions).toHaveLength(0);
    expect(auditMock).toHaveBeenCalledWith(
      "memory_conflict",
      expect.objectContaining({ importance: 0.4 }),
      expect.any(String),
    );
  });

  it("simply creates a new fact at low probability", async () => {
    const h = harness({
      judge: (question) => {
        if (question.type === "boolean") {
          return { type: "boolean", source: "generative", probability: 0.9 };
        }
        if (question.type === "choice") {
          // "none" wins clearly: the new fact is added.
          return choiceFor(question, question.options.length - 1, 0.9);
        }
        throw new Error("score should not be asked here at all");
      },
    });

    await say(h, "ich wohne in Ahrenfeld", wohnort("Ahrenfeld"), new Date(START));
    await say(h, "jetzt Bruckstadt", wohnort("Bruckstadt"), new Date(START.getTime() + DAY));

    expect(await h.store.activeFacts()).toHaveLength(2);
    expect(h.store.questions).toHaveLength(0);
  });
});

describe("gate before the extraction", () => {
  it("does not extract when there is nothing worth remembering", async () => {
    const h = harness({
      judge: () => ({ type: "boolean", source: "generative", probability: 0.2 }),
    });
    const extractor = vi.fn(async () => wohnort("Ahrenfeld"));
    h.deps.extractFacts = extractor;

    h.clock.now = new Date(START);
    const messageId = h.store.addMessage("inbound", "haha ok", new Date(START));
    const outcome = await rememberOwnerTurn(h.deps, { messageId, text: "haha ok" });

    expect(outcome.extracted).toBe(false);
    expect(extractor).not.toHaveBeenCalled();
    expect(h.store.facts).toHaveLength(0);
    expect(auditMock).toHaveBeenCalledWith(
      "memory_gate",
      expect.objectContaining({ kept: false }),
      messageId,
    );
  });

  it("asks the decider exactly one question per request", async () => {
    const h = harness();
    await say(h, "ich wohne in Ahrenfeld", wohnort("Ahrenfeld"), new Date(START));
    expect(h.judge.asked.map((question) => question.key)).toEqual(["memorable"]);
  });
});

describe("context size", () => {
  it("caps the memory block", () => {
    const facts = Array.from({ length: 400 }, (_, i) => ({
      id: `f-${i}`,
      category: "test",
      content: `Ein ziemlich langer synthetischer Fakt mit der Nummer ${i}.`,
      confidence: 0.9,
      sourceMessageId: null,
      createdAt: START.toISOString(),
      kind: "identity" as const,
      validFrom: null,
      validUntil: null,
      similarity: 0.9,
      score: 0.9,
      textHit: false,
    }));
    const rendered = renderMemory({ userModel: "", facts, summaries: [], question: null, now: START, procedures: [], playbooks: [], situations: [], playbookFacts: [] });
    expect(rendered.length).toBeLessThanOrEqual(MEMORY.maxContextChars + 2);
  });
});
