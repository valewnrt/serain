import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGliteInterface } from "@electric-sql/pglite";
import {
  absenceAtK,
  ownerDay,
  evaluateAnswer,
  evaluateState,
  expandVariants,
  firstRank,
  matches,
  normalize,
  parseForgetCandidates,
  recallAtK,
  withinDays,
} from "../eval/memory/checks.js";
import { caseDatabase, migratedTemplate } from "../eval/memory/db.js";
import { loadMemoryCases, parseMemoryCases, selectCases } from "../eval/memory/load.js";
import { columnOf, renderMarkdown, summarizeUsage, tabulate } from "../eval/memory/report.js";
import { PgliteMemoryStore } from "../eval/memory/store.js";
import {
  CATEGORIES,
  UNKNOWN_VARIANTS,
  type CaseResult,
  type FactRowSnapshot,
  type MemoryRunManifest,
  type MemorySnapshot,
} from "../eval/memory/types.js";

/**
 * The memory eval itself, without network and without a model: loading and
 * checking cases, the check functions, the PGlite store against fake embeddings and the
 * lock against the production database. What the eval measures, it measures only as
 * well as these building blocks are right.
 */

// --- Cases -----------------------------------------------------------------

describe("Cases", () => {
  const cases = loadMemoryCases();

  it("loads about 48 cases in all nine categories", () => {
    expect(cases.length).toBeGreaterThanOrEqual(45);
    expect(cases.length).toBeLessThanOrEqual(54);
    for (const category of CATEGORIES) {
      expect(cases.filter((testCase) => testCase.category === category).length, category).toBeGreaterThanOrEqual(4);
    }
  });

  it("has a counter-check per category", () => {
    for (const category of CATEGORIES) {
      expect(cases.some((testCase) => testCase.category === category && testCase.negative), category).toBe(true);
    }
  });

  it("holds back about a quarter as holdout", () => {
    const share = cases.filter((testCase) => testCase.holdout).length / cases.length;
    expect(share).toBeGreaterThanOrEqual(0.2);
    expect(share).toBeLessThanOrEqual(0.3);
  });

  it("never asks with the wording of the source message", () => {
    for (const testCase of cases) {
      const sources = testCase.script.map((message) => normalize(message.text));
      const questions = [
        ...testCase.recall.map((check) => check.query),
        ...(testCase.answer ? [testCase.answer.question] : []),
      ];
      for (const question of questions) {
        expect(sources, `${testCase.id}: ${question}`).not.toContain(normalize(question));
      }
    }
  });

  it("in every forgetting case with a sentinel also checks the user model that contains it", () => {
    const forgetting = cases.filter((testCase) => testCase.category === "vergessen" && !testCase.negative);
    expect(forgetting.length).toBeGreaterThanOrEqual(5);
    for (const testCase of forgetting) {
      const sentinel = testCase.state.find((check) => check.type === "sentinel_absent");
      expect(sentinel, testCase.id).toBeDefined();
      if (sentinel?.type !== "sentinel_absent") continue;
      expect(normalize(testCase.seed.userModel?.base ?? ""), testCase.id).toContain(normalize(sentinel.sentinel));
    }
  });

  it("uses only made-up people: no phone numbers, no mail addresses", () => {
    const raw = JSON.stringify(cases);
    expect(raw).not.toMatch(/\+\d{6,}/);
    expect(raw).not.toMatch(/[\w.-]+@[\w-]+\.[a-z]{2,}/i);
  });

  it("filters by ID and category and rejects unknown ones", () => {
    expect(selectCases(cases, { only: ["update-02"] }).map((testCase) => testCase.id)).toEqual(["update-02"]);
    expect(selectCases(cases, { category: "vergessen" }).every((testCase) => testCase.category === "vergessen")).toBe(true);
    expect(() => selectCases(cases, { only: ["gibt-99"] })).toThrow(/Unknown case ID/);
  });
});

describe("Load validation", () => {
  const base = {
    id: "abruf-99",
    category: "abruf",
    holdout: false,
    note: "Test",
    truth: [{ id: "t1", content: "Alex mag Tee.", kind: "preference" }],
    script: [{ at: "2026-03-01T10:00:00+01:00", from: "owner", text: "ich mag tee" }],
    state: [{ type: "fact_present", pattern: "tee" }],
  };

  it("accepts a valid case and fills defaults", () => {
    const [parsed] = parseMemoryCases([base]);
    expect(parsed?.negative).toBe(false);
    expect(parsed?.recall).toEqual([]);
    expect(parsed?.seed.facts).toEqual([]);
  });

  it("rejects a broken pattern", () => {
    expect(() => parseMemoryCases([{ ...base, state: [{ type: "fact_present", pattern: "(tee" }] }])).toThrow(
      /regex/,
    );
  });

  it("rejects messages in the wrong order", () => {
    const script = [
      { at: "2026-03-02T10:00:00+01:00", from: "owner", text: "b" },
      { at: "2026-03-01T10:00:00+01:00", from: "owner", text: "a" },
    ];
    expect(() => parseMemoryCases([{ ...base, script }])).toThrow(/is not after/);
  });

  it("rejects a question before the last message", () => {
    const recall = [{ type: "recall", at: "2026-02-01T10:00:00+01:00", query: "was trink ich", pattern: "tee" }];
    expect(() => parseMemoryCases([{ ...base, recall }])).toThrow(/not after the last message/);
  });

  it("lets only the owner have something forgotten", () => {
    const script = [{ at: "2026-03-01T10:00:00+01:00", from: "serain", text: "ok", forget: "Tee" }];
    expect(() => parseMemoryCases([{ ...base, script }])).toThrow(/only the owner/);
  });

  it("rejects instants without offset and duplicate IDs", () => {
    const script = [{ at: "2026-03-01T10:00:00", from: "owner", text: "a" }];
    expect(() => parseMemoryCases([{ ...base, script }])).toThrow(/offset/);
    expect(() => parseMemoryCases([base, base])).toThrow(/duplicate case ID/);
  });
});

// --- Check functions -------------------------------------------------------

describe("Normalization and patterns", () => {
  it("spells out umlauts, lowercase, without typographic quotes", () => {
    expect(normalize("„Roter Anker“ in KÖLN, Straße")).toBe("roter anker in koeln, strasse");
  });

  it("matches umlaut patterns in spelled-out text and vice versa", () => {
    expect(matches("köln", "Er zieht nach Koeln.")).toBe(true);
    expect(matches("koeln", "Er zieht nach Köln.")).toBe(true);
    expect(matches("gartenstr", "wohnt in der Gartenstraße")).toBe(true);
  });

  it("leaves escape sequences in the pattern intact", () => {
    // Lowercasing the pattern turned \D into \d.
    expect(matches("\\D+3", "ID.3")).toBe(true);
    expect(matches("id\\.? ?3", "fährt einen ID.3")).toBe(true);
    expect(matches("14\\.0?9", "am 14.9.")).toBe(true);
  });
});

describe("Date window", () => {
  it("computes in Berlin calendar days", () => {
    expect(ownerDay("2026-08-31T22:30:00Z")).toBe("2026-09-01");
    expect(ownerDay("2026-08-31T21:59:00Z")).toBe("2026-08-31");
  });

  it("accepts ±3 days and no more", () => {
    expect(withinDays("2026-09-03T10:00:00Z", "2026-08-31")).toBe(true);
    expect(withinDays("2026-08-28T10:00:00Z", "2026-08-31")).toBe(true);
    expect(withinDays("2026-09-04T10:00:00Z", "2026-08-31")).toBe(false);
  });
});

describe("Recall@k and Absence@k", () => {
  const ranked = ["Alex wohnt in Kesselbach.", "Alex arbeitet bei Lorenz.", "Alex wohnte in Ahrenfeld."];

  it("finds the rank of the first hit", () => {
    expect(firstRank(ranked, "lorenz")).toBe(2);
    expect(firstRank(ranked, "finkel")).toBeNull();
  });

  it("counts recall only within k", () => {
    expect(recallAtK(ranked, "ahrenfeld", 3)).toBe(true);
    expect(recallAtK(ranked, "ahrenfeld", 2)).toBe(false);
  });

  it("for absence requires that nothing is among the first k", () => {
    expect(absenceAtK(ranked, "ahrenfeld", 2)).toBe(true);
    expect(absenceAtK(ranked, "ahrenfeld", 3)).toBe(false);
  });
});

describe("Follow-up question from forget_fact", () => {
  it("reads the candidates from exactly the text the model gets", () => {
    const text = [
      "Mehrdeutig, ich lösche nichts auf Verdacht. Frag Alex, welcher gemeint ist:",
      "0f8fad5b-d9cb-469f-a165-70867728950e: [finanzen] Der Nutzer hat einen Kredit bei der Wolkenbank.",
      "7c9e6679-7425-40de-944b-e07fc1f90ae7: [fahrzeug] Der Nutzer besitzt ein Motorrad.",
      "Dann forget_fact noch einmal mit fact_id aufrufen.",
    ].join("\n");
    expect(parseForgetCandidates(text)).toEqual([
      { id: "0f8fad5b-d9cb-469f-a165-70867728950e", category: "finanzen", content: "Der Nutzer hat einen Kredit bei der Wolkenbank." },
      { id: "7c9e6679-7425-40de-944b-e07fc1f90ae7", category: "fahrzeug", content: "Der Nutzer besitzt ein Motorrad." },
    ]);
    expect(parseForgetCandidates("Weg. Sag Alex kurz Bescheid.")).toEqual([]);
  });
});

function fact(content: string, extra: Partial<FactRowSnapshot> = {}): FactRowSnapshot {
  return {
    id: content,
    category: "test",
    content,
    kind: "identity",
    validFrom: null,
    validUntil: null,
    supersededBy: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    seeded: false,
    ...extra,
  };
}

function snapshot(partial: Partial<MemorySnapshot>): MemorySnapshot {
  return { facts: [], summaries: [], userModels: [], openQuestions: [], ...partial };
}

describe("State check (level 1)", () => {
  it("distinguishes active and superseded facts", () => {
    const state = snapshot({
      facts: [fact("Alex wohnt in Ahrenfeld.", { supersededBy: "x" }), fact("Alex wohnt in Kesselbach.")],
    });
    const results = evaluateState(
      [
        { type: "fact_present", pattern: "kesselbach" },
        { type: "fact_present", pattern: "ahrenfeld" },
        { type: "superseded", pattern: "ahrenfeld" },
        { type: "fact_absent", pattern: "ahrenfeld", includeSuperseded: false },
        { type: "fact_absent", pattern: "ahrenfeld", includeSuperseded: true },
      ],
      state,
    );
    expect(results.map((result) => result.passed)).toEqual([true, false, true, true, false]);
  });

  it("for superseded requires that no active fact matches any more", () => {
    const state = snapshot({ facts: [fact("Alex ist Vegetarier.", { supersededBy: "x" }), fact("Alex ist Vegetarier.")] });
    expect(evaluateState([{ type: "superseded", pattern: "vegetarier" }], state)[0]?.passed).toBe(false);
  });

  it("allows facts about third parties with allowIf", () => {
    const state = snapshot({ facts: [fact("Jonas zieht nach Talwies.")] });
    const allowed = evaluateState(
      [{ type: "fact_absent", pattern: "talwies", allowIf: "jonas", includeSuperseded: false }],
      state,
    );
    expect(allowed[0]?.passed).toBe(true);
    const wrong = evaluateState(
      [{ type: "fact_absent", pattern: "talwies", allowIf: "jonas", includeSuperseded: false }],
      snapshot({ facts: [fact("Alex zieht nach Talwies.")] }),
    );
    expect(wrong[0]?.passed).toBe(false);
  });

  it("for fact_count counts only what was learned, not the starting state", () => {
    const state = snapshot({ facts: [fact("Seed.", { seeded: true }), fact("Gelernt.")] });
    expect(evaluateState([{ type: "fact_count", max: 0 }], state)[0]?.passed).toBe(false);
    expect(evaluateState([{ type: "fact_count", max: 1 }], state)[0]?.passed).toBe(true);
  });

  it("marks kind and validity as V2 and checks the window", () => {
    const state = snapshot({
      facts: [fact("Wohnt in der Gartenstraße.", { kind: "situation", validUntil: "2026-09-01T21:00:00.000Z" })],
    });
    const results = evaluateState(
      [
        { type: "kind", pattern: "gartenstr", kind: "situation" },
        { type: "valid_until", pattern: "gartenstr", date: "2026-08-31" },
        { type: "valid_from", pattern: "gartenstr", date: null },
        { type: "valid_until", pattern: "gartenstr", date: "2026-08-20" },
      ],
      state,
    );
    expect(results.map((result) => result.needsV2)).toEqual([true, true, true, true]);
    expect(results.map((result) => result.passed)).toEqual([true, true, true, false]);
  });

  it("fans the sentinel out into one check per layer", () => {
    const state = snapshot({
      facts: [],
      summaries: ["Nichts dazu."],
      userModels: [{ base: "Hat einen Kredit bei der Wolkenbank.", learned: "", source: "seed" }],
      openQuestions: [],
    });
    const results = evaluateState([{ type: "sentinel_absent", sentinel: "Wolkenbank" }], state);
    expect(results.map((result) => [result.kind, result.passed])).toEqual([
      ["sentinel:facts", true],
      ["sentinel:summaries", true],
      ["sentinel:user_model", false],
      ["sentinel:open_questions", true],
    ]);
  });
});

describe("Answer check (level 3)", () => {
  it("requires every group and knows the abstention placeholder", () => {
    expect(expandVariants(["@unbekannt"])).toEqual([...UNKNOWN_VARIANTS]);
    const results = evaluateAnswer(
      { at: "2026-01-01T00:00:00Z", question: "?", anyOf: [["@unbekannt"]], notContains: ["Tilda"] },
      "Hm, das hast du mir nie erzählt.",
    );
    expect(results.every((result) => result.passed)).toBe(true);
  });

  it("finds forbidden words regardless of case and umlaut", () => {
    const [notContains] = evaluateAnswer(
      { at: "2026-01-01T00:00:00Z", question: "?", anyOf: [], notContains: ["brösel"] },
      "Der heißt BROESEL, glaub ich.",
    );
    expect(notContains?.passed).toBe(false);
  });
});

// --- Report ----------------------------------------------------------------

describe("Report", () => {
  function caseResult(partial: Partial<CaseResult>): CaseResult {
    return {
      caseId: "update-01",
      category: "update",
      holdout: false,
      negative: false,
      iteration: 1,
      control: false,
      ok: true,
      checks: [],
      trace: [],
      usage: summarizeUsage({ usage: [], audits: [], unexpected: [] }, 0),
      durationMs: 1,
      ...partial,
    };
  }

  it("assigns checks to exactly one column and counts per category", () => {
    const results = [
      caseResult({
        checks: [
          { id: "a", level: 1, kind: "fact_present", needsV2: false, passed: true },
          { id: "b", level: 1, kind: "valid_until", needsV2: true, passed: false },
          { id: "c", level: 2, kind: "recall@5", needsV2: false, passed: true },
          { id: "d", level: 2, kind: "absence@3", needsV2: true, passed: false },
          { id: "e", level: 3, kind: "answer_any_of", needsV2: false, passed: false },
        ],
      }),
    ];
    expect(results[0]?.checks.map(columnOf)).toEqual(["L1", "L1·V2", "L2 R@5", "L2·V2", "L3"]);
    const row = tabulate(results).get("update");
    expect(row?.get("L1")).toEqual({ passed: 1, total: 1 });
    expect(row?.get("L3")).toEqual({ passed: 0, total: 1 });
  });

  it("writes no overall grade and names the missing judge", () => {
    const manifest: MemoryRunManifest = {
      runId: "test",
      startedAt: "2026-10-02T00:00:00Z",
      finishedAt: "2026-10-02T00:01:00Z",
      levels: [1, 2, 3],
      repeat: 1,
      concurrency: 1,
      control: null,
      capUsd: 0.1,
      caseIds: ["update-01"],
      usage: summarizeUsage({ usage: [], audits: [], unexpected: [] }, 0),
      embeddingEstimateUsd: 0,
    };
    const markdown = renderMarkdown(manifest, [caseResult({})]);
    expect(markdown).toContain("| update |");
    expect(markdown).toContain("No LLM judge");
    expect(markdown).not.toMatch(/overall/i);
  });
});

// --- PGlite store ----------------------------------------------------------

/** One-hot vector: same axis means similarity 1, other axis 0. */
function axis(index: number, weight = 1): number[] {
  return Array.from({ length: 1536 }, (_, i) => (i === index ? weight : 0));
}

function mix(a: number, b: number): number[] {
  return Array.from({ length: 1536 }, (_, i) => (i === a ? 0.8 : i === b ? 0.6 : 0));
}

describe("PGlite store against fake embeddings", () => {
  let template: PGliteInterface;
  let db: PGliteInterface;
  const clock = { now: new Date("2026-06-01T10:00:00+02:00") };
  let store: PgliteMemoryStore;

  beforeAll(async () => {
    template = await migratedTemplate();
    db = await caseDatabase(template);
    store = new PgliteMemoryStore(db, () => clock.now);
  }, 120_000);

  afterAll(async () => {
    await db?.close();
    await template?.close();
  });

  it("returns an empty user model without a version and renders base plus learned", async () => {
    expect(await store.userModel()).toBe("");
    await store.seedUserModel("Grundtext.", "", "2026-01-01T00:00:00Z");
    expect(await store.userModel()).toBe("Grundtext.");
    await db.query(
      "insert into public.user_model_versions (base, learned, source, created_at) values ($1, $2, 'consolidation', $3)",
      ["Grundtext neu.", "Gelernt.", "2026-02-01T00:00:00Z"],
    );
    expect(await store.userModel()).toMatch(/^Grundtext neu.\n\n## Learned \(as of \d{4}-\d{2}-\d{2}\)\nGelernt.$/);
  });

  it("stores, searches via search_facts and orders by vector proximity", async () => {
    const message = await store.insertMessage("inbound", "ich wohn in ahrenfeld", "2026-03-01T10:00:00+01:00");
    const home = await store.insertFact({
      subject: "owner",
      category: "wohnen",
      content: "Alex wohnt in Ahrenfeld.",
      confidence: 0.9,
      kind: "identity",
      validFrom: null,
      validUntil: null,
      sourceMessageId: message,
      embedding: axis(1),
      createdAt: "2026-03-01T10:00:00+01:00",
    });
    await store.seedFact({
      subject: "owner",
      category: "sport",
      content: "Alex spielt Volleyball.",
      confidence: 0.9,
      kind: "identity",
      validFrom: null,
      validUntil: null,
      sourceMessageId: null,
      embedding: axis(2),
      createdAt: "2026-02-01T10:00:00+01:00",
    });
    expect(home.createdAt).toBe("2026-03-01T09:00:00.000Z");

    const hits = await store.searchFacts({ subject: "owner", embedding: mix(1, 2), query: "", limit: 12, now: clock.now.toISOString() });
    expect(hits.map((hit) => hit.content)).toEqual(["Alex wohnt in Ahrenfeld.", "Alex spielt Volleyball."]);
    expect(hits[0]?.similarity).toBeCloseTo(0.8, 5);

    const text = await store.searchFacts({ subject: "owner", embedding: null, query: "Volleyball", limit: 12, now: clock.now.toISOString() });
    expect(text.map((hit) => hit.content)).toEqual(["Alex spielt Volleyball."]);
  });

  it("passes the set clock to search_facts: expired facts drop out", async () => {
    const temp = await store.insertFact({
      subject: "owner",
      category: "auto",
      content: "Alex fährt einen Leihwagen.",
      confidence: 0.9,
      kind: "identity",
      validFrom: null,
      validUntil: null,
      sourceMessageId: null,
      embedding: axis(3),
      createdAt: "2026-04-08T08:00:00+02:00",
    });
    await db.query("update public.facts set valid_until = $2 where id = $1", [temp.id, "2026-04-15T23:59:00+02:00"]);

    clock.now = new Date("2026-04-10T10:00:00+02:00");
    let hits = await store.searchFacts({ subject: "owner", embedding: axis(3), query: "", limit: 12, now: clock.now.toISOString() });
    expect(hits[0]?.content).toBe("Alex fährt einen Leihwagen.");

    clock.now = new Date("2026-04-25T10:00:00+02:00");
    hits = await store.searchFacts({ subject: "owner", embedding: axis(3), query: "", limit: 12, now: clock.now.toISOString() });
    expect(hits.map((hit) => hit.content)).not.toContain("Alex fährt einen Leihwagen.");
  });

  it("hides superseded facts and forgets the whole chain including the overlapping summary", async () => {
    const first = await store.insertMessage("inbound", "3 espresso am tag", "2026-02-01T08:00:00+01:00");
    const old = await store.insertFact({
      subject: "owner",
      category: "essen",
      content: "Alex trinkt drei Espresso am Tag.",
      confidence: 0.9,
      kind: "identity",
      validFrom: null,
      validUntil: null,
      sourceMessageId: first,
      embedding: axis(4),
      createdAt: "2026-02-01T08:00:00+01:00",
    });
    const second = await store.insertMessage("inbound", "nur noch einen", "2026-03-01T08:00:00+01:00");
    const current = await store.insertFact({
      subject: "owner",
      category: "essen",
      content: "Alex trinkt einen Espresso am Tag.",
      confidence: 0.9,
      kind: "identity",
      validFrom: null,
      validUntil: null,
      sourceMessageId: second,
      embedding: axis(4),
      createdAt: "2026-03-01T08:00:00+01:00",
    });
    await store.supersedeFact(old.id, current.id, "2026-03-01T08:00:00+01:00");
    await store.insertSummary({
      windowStart: "2026-03-01T00:00:00+01:00",
      windowEnd: "2026-03-01T23:59:00+01:00",
      content: "Alex hat reduziert.",
      messageCount: 2,
      embedding: null,
    });

    const hits = await store.searchFacts({ subject: "owner", embedding: axis(4), query: "", limit: 12, now: clock.now.toISOString() });
    expect(hits.map((hit) => hit.id)).toContain(current.id);
    expect(hits.map((hit) => hit.id)).not.toContain(old.id);

    const result = await store.forgetFact(current.id);
    expect([...result.deletedIds].sort()).toEqual([old.id, current.id].sort());
    expect(result.categories).toEqual(["essen", "essen"]);
    expect(result.summariesDeleted).toBe(1);
    expect((await store.allFactContents()).some((content) => content.includes("Espresso"))).toBe(false);
  });

  it("queues a follow-up question for the same pair only once", async () => {
    const [a, b] = await store.activeFacts();
    if (!a || !b) throw new Error("too few facts for the test");
    const question = { question: "Gilt das noch?", factId: a.id, rivalFactId: b.id, importance: 2, createdAt: "2026-05-01T00:00:00Z" };
    expect(await store.addOpenQuestion(question)).not.toBeNull();
    expect(await store.addOpenQuestion(question)).toBeNull();
    expect((await store.nextOpenQuestion())?.question).toBe("Gilt das noch?");
  });

  it("returns a snapshot with kind, validity and seed marker", async () => {
    const state = await store.snapshot();
    const volleyball = state.facts.find((row) => row.content.includes("Volleyball"));
    const leihwagen = state.facts.find((row) => row.content.includes("Leihwagen"));
    expect(volleyball?.seeded).toBe(true);
    expect(volleyball?.kind).toBe("identity");
    expect(leihwagen?.validUntil).toBe("2026-04-15T21:59:00.000Z");
    expect(state.userModels.map((version) => version.source)).toEqual(["seed", "consolidation"]);
    expect(state.openQuestions).toEqual(["Gilt das noch?"]);
  });

  it("clones independent databases from the template", async () => {
    const other = await caseDatabase(template);
    try {
      const fresh = new PgliteMemoryStore(other, () => clock.now);
      expect(await fresh.activeFacts()).toEqual([]);
      expect(await fresh.userModel()).toBe("");
    } finally {
      await other.close();
    }
  });
});

// --- Lock against the production database ----------------------------------

describe("Database dummy", () => {
  it("redirects Supabase, intercepts audit and usage and reports everything else", async () => {
    const { SINK_URL, newLedger, withLedger } = await import("../eval/memory/sink.js");
    expect(process.env["SUPABASE_URL"]).toBe(SINK_URL);

    const ledger = newLedger();
    await withLedger(ledger, async () => {
      const audit = await fetch(`${SINK_URL}/rest/v1/audit_log`, {
        method: "POST",
        body: JSON.stringify({ event: "memory_gate", actor: "serain", message_id: "m1", detail: { probability: 0.7 } }),
      });
      expect(audit.status).toBe(201);
      await fetch(`${SINK_URL}/rest/v1/usage_log`, {
        method: "POST",
        body: JSON.stringify({ kind: "model", provider: "openrouter", model: "x", role: "embedding", input_tokens: 5, output_tokens: 0, cost_usd: 0.0001 }),
      });
      const month = await fetch(`${SINK_URL}/rest/v1/rpc/usage_since`, {
        method: "POST",
        body: JSON.stringify({ p_kind: "model", p_since: "2026-10-01T00:00:00Z" }),
      });
      expect(await month.json()).toEqual([{ cost_usd: 0, units: 0 }]);
      const other = await fetch(`${SINK_URL}/rest/v1/facts`, { method: "POST", body: "{}" });
      expect(other.status).toBe(500);
    });

    expect(ledger.audits).toEqual([{ event: "memory_gate", messageId: "m1", detail: { probability: 0.7 } }]);
    expect(ledger.usage[0]?.costUsd).toBe(0.0001);
    expect(ledger.unexpected).toEqual(["POST /rest/v1/facts"]);
    const usage = summarizeUsage(ledger, 400);
    expect(usage.openrouterUsd).toBeCloseTo(0.0001, 8);
    expect(usage.unexpectedDbAccess).toEqual(["POST /rest/v1/facts"]);
  });
});
