import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Kind and validity (D39), the nightly consolidation (H1, D40) and forgetting
 * down into the user model (D40). Fake database, fake models, set clock.
 * Everything synthetic: invented person, invented places.
 */
const auditMock = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock("../src/db/audit.js", () => ({ audit: (...args: unknown[]) => auditMock(...args) }));
vi.mock("../src/config/env.js", () => ({
  env: { openrouterApiKey: "", claudeOauthToken: "", dataDir: "/tmp", integrationKey: "", supabaseUrl: "http://localhost:54321", supabaseSecretKey: "sb_secret_test" },
}));

const { resolveValidity, validityLabel, ownerDayEnd, ownerDayStart } = await import("../src/memory/kinds.js");
const { rememberOwnerTurn, supersedeTiming } = await import("../src/memory/write.js");
const { buildMemoryContext, renderMemory } = await import("../src/memory/recall.js");
const { maybeConsolidate } = await import("../src/memory/consolidate.js");
const { checkConsolidation, normalizeLearned, parseLearned, renderLearned, emptyLearned } = await import("../src/memory/consolidate-rules.js");
const { purgeUserModel } = await import("../src/memory/forget.js");
const { markerFor, matchesMarker, markerKeyFrom, distinctiveTokens } = await import("../src/memory/markers.js");
const { MEMORY } = await import("../src/config/memory.js");
const { FakeJudge, FakeMemoryStore, choiceFor } = await import("./memory-store.fake.js");

type MemoryDeps = import("../src/memory/deps.js").MemoryDeps;
type ExtractedFact = import("../src/memory/deps.js").ExtractedFact;
type Consolidator = import("../src/memory/deps.js").Consolidator;

const NOW = new Date("2026-07-20T10:00:00Z");
const KEY = markerKeyFrom("test-integration-key");

const LEARNED = [
  "### who: who Alex is",
  "- Mara fährt nur Bahn.",
  "### current: what holds right now",
  "- Prüfungsphase bis 31.08.",
  "### how_to_write: how to write",
  "- kurz",
].join("\n");

/** The same content in the format written before the keyed sections (read compatibility). */
const LEGACY_LEARNED = [
  "### Wer Alex ist",
  "- Mara fährt nur Bahn.",
  "### Was gerade gilt",
  "- Prüfungsphase bis 31.08.",
  "### Wann handeln, wann fragen",
  "- nichts",
  "### Wie schreiben",
  "- kurz",
].join("\n");

function deps(store: InstanceType<typeof FakeMemoryStore>, overrides: Partial<MemoryDeps> = {}): MemoryDeps {
  return {
    store,
    judge: new FakeJudge((question) =>
      question.type === "boolean"
        ? { type: "boolean", source: "generative", probability: 0.95 }
        : question.type === "choice"
          ? choiceFor(question, 0, 0.95)
          : { type: "score", source: "generative", score: 0, index: 0, label: "", probabilities: {}, confidence: 1 },
    ),
    embed: async (texts) => texts.map(() => [0.1]),
    extractFacts: async () => [],
    summarize: async () => "",
    selectLines: async () => [],
    selectFacts: async () => [],
    consolidate: async () => ({ learned: LEARNED, outdatedBaseLines: [] }),
    classifyAreas: async ({ facts }) => facts.map(() => null),
    markerKey: KEY,
    now: () => NOW,
    ...overrides,
  };
}

beforeEach(() => auditMock.mockClear());

describe("validity from the extraction (D39)", () => {
  it("resolves calendar days in the owner's time zone, valid_until exclusive", () => {
    expect(ownerDayStart("2026-11-01")?.toISOString()).toBe("2026-10-31T23:00:00.000Z");
    // 31 August still holds entirely: the end is the midnight after it (summer time).
    expect(ownerDayEnd("2026-08-31")?.toISOString()).toBe("2026-08-31T22:00:00.000Z");
    expect(ownerDayStart("2026-02-30")).toBeNull();
  });

  it("drops nonsense instead of losing the fact", () => {
    expect(resolveValidity({ kind: "situation", validFrom: null, validUntil: "2026-08-31" }, NOW)).toEqual({
      validFrom: null,
      validUntil: "2026-08-31T22:00:00.000Z",
    });
    // Already over: then it was no state but history.
    expect(resolveValidity({ kind: "situation", validFrom: null, validUntil: "2026-07-01" }, NOW).validUntil).toBeNull();
    // Absurdly far away.
    expect(resolveValidity({ kind: "preference", validFrom: "2040-01-01", validUntil: null }, NOW).validFrom).toBeNull();
    // A past start only means "holds" for everything but episodes.
    expect(resolveValidity({ kind: "preference", validFrom: "2026-07-01", validUntil: null }, NOW).validFrom).toBeNull();
    expect(resolveValidity({ kind: "episode", validFrom: "2026-07-01", validUntil: null }, NOW).validFrom).not.toBeNull();
    // End before start: the end is dropped.
    expect(resolveValidity({ kind: "situation", validFrom: "2026-09-10", validUntil: "2026-09-01" }, NOW).validUntil).toBeNull();
  });

  it("labels from, until and on for the model, with ISO days", () => {
    expect(validityLabel({ kind: "situation", validFrom: null, validUntil: "2026-08-31T22:00:00.000Z" }, NOW)).toBe("until 2026-08-31");
    expect(validityLabel({ kind: "preference", validFrom: "2026-10-31T23:00:00.000Z", validUntil: null }, NOW)).toBe("from 2026-11-01");
    expect(validityLabel({ kind: "episode", validFrom: "2026-06-30T22:00:00.000Z", validUntil: null }, NOW)).toBe("on 2026-07-01");
    expect(validityLabel({ kind: "situation", validFrom: "2026-10-31T23:00:00.000Z", validUntil: "2026-11-30T23:00:00.000Z" }, NOW)).toBe(
      "from 2026-11-01, until 2026-11-30",
    );
  });
});

describe("replacing with a point in time (D39)", () => {
  it("time-limited overlays, future replaces later, everything else at once", () => {
    const at = NOW.toISOString();
    expect(supersedeTiming({ validFrom: null, validUntil: "2026-08-01T00:00:00Z" }, at)).toEqual({ kind: "overlay" });
    expect(supersedeTiming({ validFrom: "2026-11-01T00:00:00Z", validUntil: null }, at)).toEqual({
      kind: "scheduled",
      until: "2026-11-01T00:00:00Z",
    });
    expect(supersedeTiming({ validFrom: null, validUntil: null }, at)).toEqual({ kind: "now" });
  });

  async function learn(store: InstanceType<typeof FakeMemoryStore>, facts: ExtractedFact[]) {
    await rememberOwnerTurn(deps(store, { extractFacts: async () => facts }), { messageId: "m", text: "egal" });
  }

  it("\"vegan from November\" keeps \"eats meat\" until the end of October", async () => {
    const store = new FakeMemoryStore();
    await learn(store, [{ category: "ernaehrung", content: "Mara isst Fleisch.", confidence: 0.9, kind: "preference", validFrom: null, validUntil: null }]);
    await learn(store, [
      { category: "ernaehrung", content: "Mara isst ab November vegan.", confidence: 0.9, kind: "preference", validFrom: "2026-10-31T23:00:00.000Z", validUntil: null },
    ]);
    const meat = store.facts.find((fact) => fact.content === "Mara isst Fleisch.");
    expect(meat?.supersededBy).toBeNull();
    expect(meat?.validUntil).toBe("2026-10-31T23:00:00.000Z");
    // In the recall in October both, in November only vegan.
    const october = await store.searchFacts({ subject: "owner", embedding: null, query: "Mara isst", limit: 5, now: "2026-10-15T10:00:00Z" });
    expect(october.map((fact) => fact.content).sort()).toEqual(["Mara isst Fleisch.", "Mara isst ab November vegan."]);
    const november = await store.searchFacts({ subject: "owner", embedding: null, query: "Mara isst", limit: 5, now: "2026-11-02T10:00:00Z" });
    expect(november.map((fact) => fact.content)).toEqual(["Mara isst ab November vegan."]);
  });

  it("\"in Lisbon until Friday\" does not replace the home town", async () => {
    const store = new FakeMemoryStore();
    await learn(store, [{ category: "wohnort", content: "Mara wohnt in Ahrenfeld.", confidence: 0.9, kind: "identity", validFrom: null, validUntil: null }]);
    await learn(store, [
      { category: "wohnort", content: "Mara wohnt bis Freitag in Lissabon.", confidence: 0.9, kind: "situation", validFrom: null, validUntil: "2026-07-24T22:00:00.000Z" },
    ]);
    expect(store.facts.every((fact) => fact.supersededBy === null && (fact.kind !== "identity" || fact.validUntil === null))).toBe(true);
    expect(auditMock.mock.calls.some((call) => (call[1] as { decision?: string }).decision === "overlay")).toBe(true);
  });

  it("shows kind and validity in the memory block and leaves out what expired", async () => {
    const store = new FakeMemoryStore();
    await learn(store, [
      { category: "studium", content: "Mara hat Prüfungsphase.", confidence: 0.9, kind: "situation", validFrom: null, validUntil: "2026-08-31T22:00:00.000Z" },
    ]);
    const july = await buildMemoryContext(deps(store), { incoming: "Mara Prüfungsphase" });
    expect(renderMemory(july)).toContain("[studium, situation, until 2026-08-31] Mara hat Prüfungsphase.");
    const september = await buildMemoryContext(deps(store, { now: () => new Date("2026-09-05T10:00:00Z") }), { incoming: "Mara Prüfungsphase" });
    expect(renderMemory(september)).not.toContain("Prüfungsphase");
  });
});

describe("rules of the consolidation (H1)", () => {
  const base = ["# Mara", "", "## Alltag", "Mara wohnt in Ahrenfeld.", "Mara fährt Auto."].join("\n");

  it("accepts only the keyed format exactly as the code writes it", () => {
    expect(checkConsolidation({ base, learnedBefore: "", learned: LEARNED, outdatedBaseLines: [] }).ok).toBe(true);
    const unknown = LEARNED.replace("### who: who Alex is", "### X");
    expect(checkConsolidation({ base, learnedBefore: "", learned: unknown, outdatedBaseLines: [] })).toEqual({ ok: false, reason: "headings" });
    const swapped = [LEARNED.split("\n").slice(2, 4), LEARNED.split("\n").slice(0, 2), LEARNED.split("\n").slice(4)].flat().join("\n");
    expect(checkConsolidation({ base, learnedBefore: "", learned: swapped, outdatedBaseLines: [] })).toEqual({ ok: false, reason: "headings" });
    // The model never writes the old format any more.
    expect(checkConsolidation({ base, learnedBefore: "", learned: LEGACY_LEARNED, outdatedBaseLines: [] })).toEqual({ ok: false, reason: "headings" });
    expect(checkConsolidation({ base, learnedBefore: "", learned: "freier Text", outdatedBaseLines: [] })).toEqual({ ok: false, reason: "headings" });
  });

  it("deletes only whole lines in the base text, no headings, not too many", () => {
    const ok = checkConsolidation({ base, learnedBefore: "", learned: LEARNED, outdatedBaseLines: [4] });
    expect(ok).toMatchObject({ ok: true, removedBaseLines: 1 });
    if (ok.ok) expect(ok.base).not.toContain("Mara fährt Auto.");
    expect(checkConsolidation({ base, learnedBefore: "", learned: LEARNED, outdatedBaseLines: [2] })).toEqual({ ok: false, reason: "base_lines" });
    expect(checkConsolidation({ base, learnedBefore: "", learned: LEARNED, outdatedBaseLines: [99] })).toEqual({ ok: false, reason: "base_lines" });
  });

  it("writes empty sections as nothing, so an empty learned part is the empty string", () => {
    const empty = renderLearned(emptyLearned());
    expect(empty).toBe("");
    expect(renderLearned({ ...emptyLearned(), current: ["  ", "-"] })).toBe("");
    expect(checkConsolidation({ base, learnedBefore: "", learned: empty, outdatedBaseLines: [] })).toEqual({ ok: false, reason: "no_change" });
    expect(checkConsolidation({ base, learnedBefore: "", learned: empty, outdatedBaseLines: [4] })).toMatchObject({ ok: true, learned: "" });
  });

  it("keeps every entry on one line, so an entry cannot open a section of its own", () => {
    const learned = renderLearned({ ...emptyLearned(), who: ["Mara\n### current: x\n- y"] });
    expect(learned).toBe("### who: who Alex is\n- Mara ### current: x - y");
    expect(parseLearned(learned)).toEqual({ ...emptyLearned(), who: ["Mara ### current: x - y"] });
  });

  it("rejects too long and unchanged", () => {
    const long = `${LEARNED}\n${"- x".repeat(MEMORY.learnedMaxChars)}`;
    expect(checkConsolidation({ base, learnedBefore: "", learned: long, outdatedBaseLines: [] })).toEqual({ ok: false, reason: "too_long" });
    expect(checkConsolidation({ base, learnedBefore: LEARNED, learned: LEARNED, outdatedBaseLines: [] })).toEqual({ ok: false, reason: "no_change" });
    // A stored legacy part with the same content is no change either.
    expect(checkConsolidation({ base, learnedBefore: LEGACY_LEARNED, learned: LEARNED, outdatedBaseLines: [] })).toEqual({ ok: false, reason: "no_change" });
  });
});

describe("reading stored learned parts", () => {
  it("reads the keyed format by its keys, whatever the readable title says", () => {
    expect(parseLearned("### current: was gerade gilt\n- Prüfungsphase\n### how_to_write: cómo escribir\n- kurz")).toEqual({
      ...emptyLearned(),
      current: ["Prüfungsphase"],
      how_to_write: ["kurz"],
    });
  });

  it("still reads the old German headings and drops their \"nichts\" (read compatibility only)", () => {
    expect(parseLearned(LEGACY_LEARNED)).toEqual({
      who: ["Mara fährt nur Bahn."],
      current: ["Prüfungsphase bis 31.08."],
      when_to_act: [],
      how_to_write: ["kurz"],
    });
    // Another owner name in the old first heading.
    expect(parseLearned("### Wer Lena Sophie ist\n- mag Tee").who).toEqual(["mag Tee"]);
    expect(normalizeLearned(LEGACY_LEARNED)).toBe(LEARNED);
  });

  it("skips lines under unknown headings and before the first heading", () => {
    expect(parseLearned("lose Zeile\n### Notizen\n- egal\n### who: x\n- bleibt")).toEqual({ ...emptyLearned(), who: ["bleibt"] });
    // "nichts" is only a sentinel in the old format; in the keyed one it is content.
    expect(parseLearned("### current: x\n- nichts").current).toEqual(["nichts"]);
  });
});

describe("nightly consolidation (H1, D40)", () => {
  function storeWithModel() {
    const store = new FakeMemoryStore();
    store.versions = [
      { id: "v1", base: "# Mara\nMara wohnt in Ahrenfeld.\nMara fährt Auto.", learned: "", source: "seed", factsCursor: null, diff: {}, createdAt: "2026-07-01T00:00:00.000Z" },
    ];
    return store;
  }
  const at = (iso: string) => () => new Date(iso);

  it("runs only from three o'clock in the owner's time zone and once a day", async () => {
    const store = storeWithModel();
    expect(await maybeConsolidate(deps(store, { now: at("2026-07-20T00:30:00Z") }))).toBe("skipped");
    expect(await maybeConsolidate(deps(store, { now: at("2026-07-20T01:30:00Z") }))).toBe("nothing_new");
    expect(await maybeConsolidate(deps(store, { now: at("2026-07-20T09:30:00Z") }))).toBe("skipped");
  });

  it("asks no model when nothing happened to the facts", async () => {
    const store = storeWithModel();
    const consolidate = vi.fn<Consolidator>(async () => ({ learned: LEARNED, outdatedBaseLines: [] }));
    expect(await maybeConsolidate(deps(store, { consolidate }))).toBe("nothing_new");
    expect(consolidate).not.toHaveBeenCalled();
    expect(store.consolidation.cursor).toBe(NOW.toISOString());
  });

  it("writes a new version with new, replaced and expired facts as input", async () => {
    const store = storeWithModel();
    const fresh = await store.insertFact({ subject: "owner", category: "mobil", content: "Mara fährt nur Bahn.", confidence: 0.9, kind: "preference", validFrom: null, validUntil: null, sourceMessageId: null, embedding: null, createdAt: "2026-07-10T00:00:00.000Z" });
    const old = await store.insertFact({ subject: "owner", category: "mobil", content: "Mara hat ein Auto.", confidence: 0.9, kind: "identity", validFrom: null, validUntil: null, sourceMessageId: null, embedding: null, createdAt: "2026-06-01T00:00:00.000Z" });
    await store.supersedeFact(old.id, fresh.id, "2026-07-10T00:00:00.000Z");
    await store.insertFact({ subject: "owner", category: "reise", content: "Mara ist in Lissabon.", confidence: 0.9, kind: "situation", validFrom: null, validUntil: "2026-07-15T00:00:00.000Z", sourceMessageId: null, embedding: null, createdAt: "2026-06-20T00:00:00.000Z" });
    const consolidate = vi.fn<Consolidator>(async () => ({ learned: LEARNED, outdatedBaseLines: [2] }));

    expect(await maybeConsolidate(deps(store, { consolidate }))).toBe("written");
    const input = consolidate.mock.calls[0]?.[0];
    expect(input?.added.map((fact) => fact.content)).toEqual(["Mara fährt nur Bahn."]);
    expect(input?.superseded).toEqual([{ old: "Mara hat ein Auto.", replacement: "Mara fährt nur Bahn." }]);
    expect(input?.expired.map((fact) => fact.content)).toEqual(["Mara ist in Lissabon."]);

    const active = await store.activeUserModel();
    expect(active?.source).toBe("consolidation");
    expect(active?.learned).toBe(LEARNED);
    // Line 2 of the base text is outdated and deleted, the rest stays verbatim.
    expect(active?.base).toBe("# Mara\nMara wohnt in Ahrenfeld.");
    expect(store.versions).toHaveLength(2);
  });

  it("keeps the old version when the result breaks the rules and tries again tomorrow from the same cursor", async () => {
    const store = storeWithModel();
    await store.insertFact({ subject: "owner", category: "x", content: "Mara klettert.", confidence: 0.9, kind: "preference", validFrom: null, validUntil: null, sourceMessageId: null, embedding: null, createdAt: "2026-07-10T00:00:00.000Z" });
    expect(await maybeConsolidate(deps(store, { consolidate: async () => ({ learned: "freier Text", outdatedBaseLines: [] }) }))).toBe("rejected");
    expect(store.versions).toHaveLength(1);
    expect(store.consolidation).toEqual({ lastRunDay: "2026-07-20", cursor: "2026-07-01T00:00:00.000Z" });
  });

  it("rejects a version that writes back what was forgotten, unless Alex told it anew", async () => {
    const store = storeWithModel();
    await store.insertFact({ subject: "owner", category: "x", content: "Mara klettert.", confidence: 0.9, kind: "preference", validFrom: null, validUntil: null, sourceMessageId: null, embedding: null, createdAt: "2026-07-10T00:00:00.000Z" });
    store.markers.push(markerFor(KEY as Buffer, "Mara geht in Ahrenfeld zur Physiotherapie bei Kowalczyk") as string[]);
    const leaking = LEARNED.replace("- Mara fährt nur Bahn.", "- Physiotherapie bei Kowalczyk in Ahrenfeld");
    expect(await maybeConsolidate(deps(store, { consolidate: async () => ({ learned: leaking, outdatedBaseLines: [] }) }))).toBe("rejected");
    expect(auditMock.mock.calls.at(-1)?.[1]).toMatchObject({ reason: "forgotten" });

    // If Alex tells it again themself, it is a fact again and may go into the model.
    store.consolidation = { lastRunDay: null, cursor: null };
    await store.insertFact({ subject: "owner", category: "gesundheit", content: "Mara geht zur Physiotherapie bei Kowalczyk.", confidence: 0.9, kind: "situation", validFrom: null, validUntil: null, sourceMessageId: null, embedding: null, createdAt: "2026-07-11T00:00:00.000Z" });
    expect(await maybeConsolidate(deps(store, { consolidate: async () => ({ learned: leaking, outdatedBaseLines: [] }) }))).toBe("written");
  });

  it("keeps at most the configured number of versions", async () => {
    const store = storeWithModel();
    for (let i = 0; i < MEMORY.userModelKeepVersions + 3; i += 1) {
      await store.insertUserModelVersion({ base: "b", learned: `l${i}`, source: "push", factsCursor: null, diff: {} });
    }
    await store.insertFact({ subject: "owner", category: "x", content: "Mara klettert.", confidence: 0.9, kind: "preference", validFrom: null, validUntil: null, sourceMessageId: null, embedding: null, createdAt: "2026-07-10T00:00:00.000Z" });
    store.consolidation = { lastRunDay: null, cursor: "2026-07-01T00:00:00.000Z" };
    expect(await maybeConsolidate(deps(store, { consolidate: async () => ({ learned: LEARNED, outdatedBaseLines: [] }) }))).toBe("written");
    expect(store.versions).toHaveLength(MEMORY.userModelKeepVersions);
  });
});

describe("markers for forgotten facts (D40)", () => {
  it("counts only distinctive words and needs at least two (German)", () => {
    expect([...distinctiveTokens("Vergiss bitte, dass ich in Mainz wohne")]).toEqual(["mainz", "wohne"]);
    // A single distinctive word would block every later sentence about Mainz.
    expect(markerFor(KEY as Buffer, "Vergiss Mainz bitte")).toBeNull();
    const marker = markerFor(KEY as Buffer, "Mara geht zur Physiotherapie in Ahrenfeld") as string[];
    expect(marker.length).toBeGreaterThanOrEqual(2);
    expect(matchesMarker(KEY as Buffer, [marker], "Physiotherapie, Ahrenfeld")).toBe(true);
    expect(matchesMarker(KEY as Buffer, [marker], "Ahrenfeld ist schön")).toBe(false);
    // Filler words with umlauts count as filler too ("könnte", "während").
    expect([...distinctiveTokens("Mara könnte während Physiotherapie")]).toEqual(["physiotherapie"]);
  });

  it("filters English filler words the same way", () => {
    expect([...distinctiveTokens("Please forget that I live in Mainz, because nothing about Kowalczyk matters")]).toEqual(["mainz", "kowalczyk", "matters"]);
    expect(markerFor(KEY as Buffer, "Please forget about Mainz")).toBeNull();
    const marker = markerFor(KEY as Buffer, "Mara goes to physiotherapy in Ahrenfeld") as string[];
    expect(matchesMarker(KEY as Buffer, [marker], "- physiotherapy helps Mara (Ahrenfeld)")).toBe(true);
    expect(matchesMarker(KEY as Buffer, [marker], "Ahrenfeld is nice")).toBe(false);
  });

  it("keeps every longer word in another language, so it errs on the side of blocking", () => {
    // No Turkish filler list: "lütfen" (please) stays distinctive, the marker is not dropped.
    const tokens = [...distinctiveTokens("Lütfen fizyoterapiyi Ahrenfeld unut")];
    expect(tokens).toEqual(["lutfen", "fizyoterapiyi", "ahrenfeld"]);
    const marker = markerFor(KEY as Buffer, "Lütfen fizyoterapiyi Ahrenfeld unut") as string[];
    expect(marker).toHaveLength(3);
    expect(matchesMarker(KEY as Buffer, [marker], "Mara fizyoterapiyi Ahrenfeld seviyor")).toBe(true);
    // A text that only shares the filler word does not count: two hits are the floor.
    expect(matchesMarker(KEY as Buffer, [marker], "lütfen bana yaz")).toBe(false);
  });

  it("stores no words, only HMACs", () => {
    const marker = markerFor(KEY as Buffer, "Physiotherapie Ahrenfeld") as string[];
    expect(marker.every((entry) => /^[0-9a-f]{64}$/.test(entry))).toBe(true);
    expect(JSON.stringify(marker)).not.toContain("physio");
  });
});

describe("forgetting down into the user model (D40)", () => {
  function store3() {
    const store = new FakeMemoryStore();
    const base = ["# Mara", "Mara wohnt in Ahrenfeld.", "Mara geht dienstags zur Physiotherapie bei Kowalczyk.", "Mara mag Tee."].join("\n");
    store.versions = [
      { id: "v2", base, learned: "### who: who Alex is\n- Physiotherapie hilft Mara beim Rücken (Kowalczyk).", source: "consolidation", factsCursor: null, diff: {}, createdAt: "2026-07-02T00:00:00.000Z" },
      { id: "v1", base, learned: "", source: "seed", factsCursor: null, diff: {}, createdAt: "2026-07-01T00:00:00.000Z" },
      { id: "v0", base: "# Mara\nMara mag Tee.", learned: "", source: "seed", factsCursor: null, diff: {}, createdAt: "2026-06-01T00:00:00.000Z" },
    ];
    return store;
  }

  it("deletes the lines the model names and those carrying the distinctive words, and erases old versions", async () => {
    const store = store3();
    const selectLines = vi.fn(async () => [1]);
    const result = await purgeUserModel(deps(store, { selectLines }), {
      what: "vergiss das mit der Physiotherapie bei Kowalczyk",
      facts: [],
      allowMany: false,
    });
    expect(result).toMatchObject({ removedLines: 2, versionsPurged: 2, tooMany: null, marker: true });
    const all = store.versions.map((version) => `${version.base}\n${version.learned}`).join("\n");
    expect(all).not.toMatch(/Kowalczyk|Physiotherapie/);
    // What has nothing to do with it stays: a version without the line survives, the rest verbatim.
    expect(store.versions.map((version) => version.id)).toContain("v0");
    expect((await store.activeUserModel())?.base).toBe("# Mara\nMara wohnt in Ahrenfeld.\nMara mag Tee.");
    expect(store.markers).toHaveLength(1);
  });

  it("asks back instead of deleting many lines on suspicion", async () => {
    const store = new FakeMemoryStore();
    store.model = Array.from({ length: 12 }, (_, i) => `Zeile ${i} über die Arbeit.`).join("\n");
    const result = await purgeUserModel(deps(store, { selectLines: async () => Array.from({ length: 12 }, (_, i) => i) }), {
      what: "vergiss alles über meine Arbeit",
      facts: [],
      allowMany: false,
    });
    expect(result.removedLines).toBe(0);
    expect(result.tooMany).toHaveLength(12);
    expect(store.versions).toHaveLength(1);
    const confirmed = await purgeUserModel(deps(store, { selectLines: async () => Array.from({ length: 12 }, (_, i) => i) }), {
      what: "vergiss alles über meine Arbeit",
      facts: [],
      allowMany: true,
    });
    expect(confirmed.removedLines).toBe(12);
  });

  it("changes nothing when none of it is in the user model", async () => {
    const store = store3();
    const result = await purgeUserModel(deps(store), { what: "vergiss meine Lieblingsfarbe", facts: [], allowMany: false });
    expect(result.removedLines).toBe(0);
    expect(store.versions).toHaveLength(3);
  });
});
