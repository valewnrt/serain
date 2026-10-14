import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The two memory tools (W6, W7) on the registry path, i.e. with level check,
 * schema validation and audit, not past the handlers.
 */
const auditMock = vi.fn(async (..._args: unknown[]) => undefined);
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

const { memoryTools, resolveForgetTarget } = await import("../src/agent/tools/memory.js");
const { trimmedRest } = await import("../src/memory/forget.js");
const { maybeClassifyAreas, memoryLines, parseSection, renderMemoryLines } = await import("../src/memory/areas.js");
const { installTranslations } = await import("../src/i18n/catalog.js");
const { ToolRegistry } = await import("../src/agent/tools/registry.js");
const { TurnState } = await import("../src/agent/tools/types.js");
const { FakeJudge, FakeMemoryStore } = await import("./memory-store.fake.js");

type MemoryDeps = import("../src/memory/deps.js").MemoryDeps;
type NewFact = import("../src/memory/store.js").NewFact;
type MessagePort = import("../src/agent/tools/messaging.js").MessagePort;

const START = new Date("2026-09-01T09:00:00Z");

function setup(origin: "owner_message" | "untrusted" = "owner_message", overrides: Partial<MemoryDeps> = {}) {
  const store = new FakeMemoryStore();
  const sent: Array<{ text: string; kind: string }> = [];
  const port: MessagePort = {
    canReact: true,
    canReplyInThread: true,
    async send(text, opts) {
      sent.push({ text, kind: opts.kind });
      return true;
    },
    async react() {
      return true;
    },
  };
  const memory: MemoryDeps = {
    store,
    judge: new FakeJudge(() => {
      throw new Error("Tools do not ask the judge");
    }),
    embed: async (texts) => texts.map(() => [0.1]),
    extractFacts: async () => [],
    summarize: async () => "",
    selectLines: async () => [],
    selectFacts: async () => [],
    consolidate: async () => ({ learned: "", outdatedBaseLines: [] }),
    classifyAreas: async ({ facts }) => facts.map(() => null),
    markerKey: null,
    now: () => START,
    ...overrides,
  };
  const registry = new ToolRegistry().registerAll(memoryTools({ memory, port }));
  const turn = new TurnState({
    origin,
    triggerExternalId: "m-1",
    triggerMessageId: "db-1",
    reactableIds: ["m-1"],
  });
  return { store, sent, registry, turn, memory };
}

async function addFact(
  store: InstanceType<typeof FakeMemoryStore>,
  category: string,
  content: string,
  extra: Partial<Pick<NewFact, "area" | "kind" | "sourceMessageId" | "validUntil">> = {},
): Promise<string> {
  const fact = await store.insertFact({
    subject: "owner",
    category,
    content,
    confidence: 0.9,
    kind: "identity",
    validFrom: null,
    validUntil: null,
    sourceMessageId: null,
    embedding: null,
    createdAt: START.toISOString(),
    ...extra,
  });
  return fact.id;
}

beforeEach(() => auditMock.mockClear());

describe("[W6] show_memory", () => {
  it("sends the facts by area, with origin and date, without the base text", async () => {
    const { store, sent, registry, turn } = setup();
    store.model = "Mara mag kurze Antworten.";
    await addFact(store, "wohnort", "Mara wohnt in Cordheim.", { area: "places", sourceMessageId: "msg-1" });
    await addFact(store, "arbeit", "Mara ist Tischlerin.");

    const result = await registry.execute("show_memory", {}, turn);

    expect(result.ok).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toBe("Ich:\n- Mara ist Tischlerin. (erschlossen 01.09.2026)\n\nOrte:\n- Mara wohnt in Cordheim. (gesagt 01.09.2026)");
    // The dump goes through the normal outlet: chunking and budget apply there.
    expect(sent[0]?.kind).toBe("show_memory");
  });

  it("counts against the turn's message limit", async () => {
    const { store, registry, turn } = setup();
    store.model = "kurz";
    await addFact(store, "wohnort", "Mara wohnt in Cordheim.");
    await registry.execute("show_memory", {}, turn);
    expect(turn.messagesSent).toBe(1);
  });

  it("offers areas instead of flooding Alex with bubbles", async () => {
    const { store, sent, registry, turn } = setup();
    store.model = "Grundtext";
    for (let i = 0; i < 60; i += 1) {
      await addFact(store, "x", `Synthetischer Fakt Nummer ${i}, absichtlich lang genug.`, { area: i % 2 === 0 ? "places" : "people" });
    }
    const result = await registry.execute("show_memory", {}, turn);

    expect(result.ok).toBe(true);
    expect(sent).toHaveLength(0);
    expect(result.text).toContain("Areas: people (30), places (30).");
    expect(result.text).toContain("base text (as of 2026-01-01");
  });

  it("filters to one area, also in Alex's spelling", async () => {
    const { store, sent, registry, turn } = setup();
    await addFact(store, "wohnort", "Mara wohnt in Cordheim.", { area: "places" });
    await addFact(store, "familie", "Maras Bruder heißt Ole.", { area: "people" });

    await registry.execute("show_memory", { area: "Personen" }, turn);
    expect(sent[0]?.text).toContain("Ole");
    expect(sent[0]?.text).not.toContain("Cordheim");
    await registry.execute("show_memory", { area: "Präferenzen" }, turn);
    expect(sent).toHaveLength(1);
    const unknown = await registry.execute("show_memory", { area: "hobbys" }, turn);
    expect(unknown.ok).toBe(false);
    expect(unknown.text).toContain("self, open, people, places, preferences, anniversaries, procedures");
  });

  it("sorts facts without an area by their kind and shows validity", async () => {
    const { store, sent, registry, turn } = setup();
    await addFact(store, "studium", "Mara schreibt ihre Bachelorarbeit.", { kind: "situation", validUntil: "2026-11-30T23:00:00.000Z" });
    await addFact(store, "essen", "Mara isst keine Pilze.", { kind: "preference" });
    await addFact(store, "alt", "Mara war in Lissabon.", { kind: "situation", validUntil: "2026-08-01T00:00:00.000Z" });
    await registry.execute("show_memory", {}, turn);
    expect(sent[0]?.text).toBe(
      "Offen:\n- Mara schreibt ihre Bachelorarbeit. (erschlossen 01.09.2026, bis 30.11.2026)\n\nPräferenzen:\n- Mara isst keine Pilze. (erschlossen 01.09.2026)",
    );
  });

  it("shows the learned part of the user model as inferred, under its areas", async () => {
    const { store, sent, registry, turn } = setup();
    await store.insertUserModelVersion({
      base: "Grundtext von Mara",
      learned: "### Wer Alex ist\n- arbeitet nachts\n### Was gerade gilt\n- nichts\n### Wann handeln, wann fragen\n- Termine ohne Rückfrage eintragen\n### Wie schreiben\n- kurz",
      source: "consolidation",
      factsCursor: null,
      diff: {},
      createdAt: "2026-09-02T02:00:00.000Z",
    });
    await registry.execute("show_memory", {}, turn);
    expect(sent[0]?.text).toBe(
      "Ich:\n- arbeitet nachts (erschlossen 02.09.2026)\n\nPräferenzen:\n- Termine ohne Rückfrage eintragen (erschlossen 02.09.2026)\n- kurz (erschlossen 02.09.2026)",
    );
    expect(sent[0]?.text).not.toContain("Grundtext von Mara");
  });

  it("reads the keyed learned format by its keys", async () => {
    const { store, sent, registry, turn } = setup();
    await store.insertUserModelVersion({
      base: "Grundtext von Mara",
      learned: "### who: who Alex is\n- arbeitet nachts\n### when_to_act: when to act, when to ask\n- Termine ohne Rückfrage eintragen",
      source: "consolidation",
      factsCursor: null,
      diff: {},
      createdAt: "2026-09-02T02:00:00.000Z",
    });
    await registry.execute("show_memory", {}, turn);
    expect(sent[0]?.text).toBe(
      "Ich:\n- arbeitet nachts (erschlossen 02.09.2026)\n\nPräferenzen:\n- Termine ohne Rückfrage eintragen (erschlossen 02.09.2026)",
    );
  });
});

describe("show_memory in other languages", () => {
  const now = new Date("2026-09-01T09:00:00Z");
  const fact = (content: string, extra: Partial<{ sourceMessageId: string; kind: "identity" | "situation"; validUntil: string; area: "places" }> = {}) => ({
    id: content,
    category: "x",
    content,
    confidence: 0.9,
    kind: extra.kind ?? ("identity" as const),
    validFrom: null,
    validUntil: extra.validUntil ?? null,
    area: extra.area ?? null,
    sourceMessageId: extra.sourceMessageId ?? null,
    createdAt: "2026-09-01T09:00:00.000Z",
  });
  const lines = memoryLines({
    facts: [
      fact("Mara ist Tischlerin."),
      fact("Mara wohnt in Cordheim.", { sourceMessageId: "m-1", area: "places" }),
      fact("Mara schreibt ihre Bachelorarbeit.", { kind: "situation", validUntil: "2026-11-30T23:00:00.000Z" }),
    ],
    learned: null,
    procedures: [
      { id: "p1", title: "Postfach aufräumen", trigger: "Mara will aufräumen", body: "1. Spam\n2. Rest", createdAt: "2026-09-01T09:00:00.000Z" } as never,
    ],
    now,
  });

  it("renders the frame in English, the content verbatim", () => {
    expect(renderMemoryLines(lines, "en")).toBe(
      [
        "Me:",
        "- Mara ist Tischlerin. (inferred 09/01/2026)",
        "",
        "Open:",
        "- Mara schreibt ihre Bachelorarbeit. (inferred 09/01/2026, until 11/30/2026)",
        "",
        "Places:",
        "- Mara wohnt in Cordheim. (said 09/01/2026)",
        "",
        "Procedures:",
        "- Postfach aufräumen (when: Mara will aufräumen) (said 09/01/2026)",
        "1. Spam",
        "2. Rest",
      ].join("\n"),
    );
  });

  it("renders a translated frame with that language's dates, and English for lines not translated yet", () => {
    expect(
      installTranslations("tr", {
        "Me:": "Ben:",
        "Places:": "Yerler:",
        "{content} (said {day})": "{content} ({day} tarihinde söylendi)",
        "{content} (inferred {day})": "{content} ({day} tarihinde çıkarıldı)",
      }),
    ).toEqual([]);
    const text = renderMemoryLines(lines, "tr");
    expect(text).toContain("Ben:\n- Mara ist Tischlerin. (01.09.2026 tarihinde çıkarıldı)");
    expect(text).toContain("Yerler:\n- Mara wohnt in Cordheim. (01.09.2026 tarihinde söylendi)");
    // Not translated: the English line, but the dates stay in the frame's language.
    expect(text).toContain("Open:\n- Mara schreibt ihre Bachelorarbeit. (inferred 01.09.2026, until 30.11.2026)");
  });

  it("finds a section by id, English name, legacy German id or the German heading", () => {
    for (const raw of ["people", "Person", "personen", "Personen"]) expect(parseSection(raw)).toBe("people");
    for (const raw of ["Präferenzen", "praeferenzen", "PRÄFERENZ", "preferences"]) expect(parseSection(raw)).toBe("preferences");
    for (const raw of ["Abläufe", "ablaeufe", "procedure", "procedures"]) expect(parseSection(raw)).toBe("procedures");
    for (const raw of ["me", "self", "ich"]) expect(parseSection(raw)).toBe("self");
    expect(parseSection("İnsanlar")).toBeNull();
    expect(parseSection("hobbys")).toBeNull();
  });

  it("reads facts classified with the legacy German area ids under the new areas", async () => {
    const { areaFromStored, storedAreaKeys } = await import("../src/memory/areas.js");
    expect(["ich", "offen", "personen", "orte", "praeferenzen", "jahrestage"].map(areaFromStored)).toEqual([
      "self",
      "open",
      "people",
      "places",
      "preferences",
      "anniversaries",
    ]);
    expect(areaFromStored("places")).toBe("places");
    expect(areaFromStored("hobbys")).toBeNull();
    expect(areaFromStored(null)).toBeNull();
    expect(storedAreaKeys(["places", "self"]).sort()).toEqual(["ich", "orte", "places", "self"]);
    // A legacy id that reaches `show_memory` still lands in its section.
    const legacy = memoryLines({ facts: [{ ...fact("Mara wohnt in Cordheim."), area: "orte" as never }], learned: null, procedures: [], now });
    expect(legacy.map((line) => line.section)).toEqual(["places"]);
  });
});

describe("Classifying areas afterwards", () => {
  it("only classifies facts without an area and leaves uncertain ones empty", async () => {
    const classify = vi.fn<MemoryDeps["classifyAreas"]>(async ({ facts }) => facts.map((fact) => (fact.includes("Geburtstag") ? "anniversaries" : null)));
    const { store, memory } = setup("owner_message", { classifyAreas: classify });
    await addFact(store, "x", "Maras Geburtstag ist am 3. Oktober.");
    await addFact(store, "x", "Mara mag Tee.");
    await addFact(store, "x", "Mara wohnt in Cordheim.", { area: "places" });

    expect(await maybeClassifyAreas(memory)).toEqual({ classified: 1, more: false });
    expect(classify.mock.calls[0]?.[0].facts).toEqual(["Maras Geburtstag ist am 3. Oktober.", "Mara mag Tee."]);
    const facts = await store.activeFacts("owner");
    expect(facts.map((fact) => fact.area)).toEqual(["anniversaries", null, "places"]);
    expect(auditMock).toHaveBeenCalledWith("memory_areas", { pending: 2, classified: 1 });
  });

  it("reports a full batch so the rest comes next right away", async () => {
    const { store, memory } = setup("owner_message", { classifyAreas: async ({ facts }) => facts.map(() => "self" as const) });
    for (let i = 0; i < 61; i += 1) await addFact(store, "x", `Fakt ${i}`);
    expect(await maybeClassifyAreas(memory)).toEqual({ classified: 60, more: true });
    expect(await maybeClassifyAreas(memory)).toEqual({ classified: 1, more: false });
  });

  it("asks no model when everything is classified", async () => {
    const classify = vi.fn<MemoryDeps["classifyAreas"]>(async () => []);
    const { store, memory } = setup("owner_message", { classifyAreas: classify });
    await addFact(store, "x", "Mara wohnt in Cordheim.", { area: "places" });
    expect(await maybeClassifyAreas(memory)).toEqual({ classified: 0, more: false });
    expect(classify).not.toHaveBeenCalled();
  });
});

describe("[W7] forget_fact", () => {
  it("deletes the fact hard, with its earlier versions", async () => {
    const { store, registry, turn } = setup();
    const alt = await addFact(store, "wohnort", "Mara wohnt in Ahrenfeld.");
    const neu = await addFact(store, "wohnort", "Mara wohnt in Cordheim.");
    await store.supersedeFact(alt, neu, START.toISOString());

    const result = await registry.execute("forget_fact", { what: "wo Mara wohnt" }, turn);

    expect(result.ok).toBe(true);
    expect(store.facts).toHaveLength(0);
    expect(await store.allFactContents()).toEqual([]);
  });

  it("does not revive the earlier version", async () => {
    const { store, registry, turn } = setup();
    const alt = await addFact(store, "wohnort", "Mara wohnt in Ahrenfeld.");
    const neu = await addFact(store, "wohnort", "Mara wohnt in Cordheim.");
    await store.supersedeFact(alt, neu, START.toISOString());

    await registry.execute("forget_fact", { what: "wo Mara wohnt" }, turn);
    expect(await store.activeFacts()).toHaveLength(0);
  });

  it("writes THAT something was deleted to the audit log, but never what", async () => {
    const { store, registry, turn } = setup();
    await addFact(store, "wohnort", "Mara wohnt in Cordheim.");

    await registry.execute("forget_fact", { what: "wo Mara wohnt" }, turn);

    const forgetCall = auditMock.mock.calls.find((call) => call[0] === "memory_forget");
    expect(forgetCall).toBeDefined();
    const detail = JSON.stringify(forgetCall?.[1]);
    expect(detail).toContain("wohnort");
    expect(detail).not.toContain("Cordheim");

    // The tool call itself is logged like any other (D8.6); it holds the
    // owner's wording, not the deleted fact.
    const toolCall = auditMock.mock.calls.find((call) => call[0] === "tool_call");
    expect(JSON.stringify(toolCall?.[1])).not.toContain("Cordheim");
  });

  it("asks back on an ambiguous target instead of guessing", async () => {
    const { store, registry, turn } = setup();
    await addFact(store, "wohnort", "Mara wohnt in Cordheim.");
    await addFact(store, "wohnort", "Mara wohnt gern in Cordheim.");

    const result = await registry.execute("forget_fact", { what: "Mara wohnt in Cordheim" }, turn);

    expect(result.ok).toBe(false);
    expect(result.text).toContain("Ambiguous");
    expect(store.facts).toHaveLength(2);
  });

  it("after a follow-up deletes the named fact and leaves others", async () => {
    const { store, registry, turn } = setup();
    const eins = await addFact(store, "wohnort", "Mara wohnt in Cordheim.");
    await addFact(store, "arbeit", "Mara arbeitet in Cordheim.");

    const result = await registry.execute(
      "forget_fact",
      { what: "Mara wohnt in Cordheim", fact_id: eins },
      turn,
    );

    expect(result.ok).toBe(true);
    expect(store.facts.map((fact) => fact.id)).not.toContain(eins);
    expect(store.facts).toHaveLength(1);
  });

  it("says honestly when there is nothing to forget", async () => {
    const { registry, turn } = setup();
    const result = await registry.execute("forget_fact", { what: "irgendwas" }, turn);
    expect(result.ok).toBe(false);
    expect(result.text).toContain("nothing stored");
  });

  it("blocks the write path for this turn", async () => {
    const { store, registry, turn } = setup();
    await addFact(store, "wohnort", "Mara wohnt in Cordheim.");
    await registry.execute("forget_fact", { what: "wo Mara wohnt" }, turn);
    // Otherwise the deleted fact would be back right away: the message
    // "vergiss, dass ich in Cordheim wohne" contains it.
    expect(turn.factExtractionBlocked).toBe(true);
  });

  it("blocks the write path even when nothing was deleted", async () => {
    const { registry, turn } = setup();
    await registry.execute("forget_fact", { what: "irgendwas" }, turn);
    expect(turn.factExtractionBlocked).toBe(true);
  });

  it("takes affected summaries along", async () => {
    const { store, registry, turn } = setup();
    const id = await addFact(store, "wohnort", "Mara wohnt in Cordheim.");
    store.facts[0]!.sourceMessageId = store.addMessage("inbound", "ich wohne in Cordheim", START);
    store.summaries.push({
      id: "s-1",
      windowStart: new Date(START.getTime() - 60_000).toISOString(),
      windowEnd: new Date(START.getTime() + 60_000).toISOString(),
      content: "Ein Zeitraum, in dem der Umzug Thema war.",
      messageCount: 12,
    });

    await registry.execute("forget_fact", { what: "wo Mara wohnt", fact_id: id }, turn);

    expect(store.summaries).toHaveLength(0);
    expect(auditMock).toHaveBeenCalledWith(
      "memory_forget",
      expect.objectContaining({ summaries_deleted: 1 }),
    );
  });
});

/**
 * Addendum D45 (vergessen-02): a detail often sits in several facts, sometimes
 * whole, sometimes only mentioned along. It must go from all of them; what
 * stands next to it stays.
 */
describe("forget_fact beyond the one fact", () => {
  const WHAT = "Wohnung in der Lindenallee";

  async function apartment(store: InstanceType<typeof FakeMemoryStore>) {
    const gemietet = await addFact(store, "wohnen", "Alex hat die Wohnung in der Lindenallee 4 in Brunnau gemietet.");
    const wohnt = await addFact(store, "wohnen", "Alex wohnt in der Lindenallee 4 in Brunnau.");
    const stellplatz = await addFact(store, "auto", "Alex hat einen Stellplatz in der Tiefgarage der Wohnung Lindenallee 4 in Brunnau.");
    const fremd = await addFact(store, "arbeit", "Alex sucht eine Wohnung für seinen Bruder.");
    return { gemietet, wohnt, stellplatz, fremd };
  }

  it("deletes all facts with the detail and trims the one that only mentions it", async () => {
    const selectFacts = vi.fn<MemoryDeps["selectFacts"]>(async ({ facts }) =>
      facts.flatMap((fact, index): Array<{ index: number; rest: string | null }> =>
        fact.includes("Stellplatz")
          ? [{ index, rest: "Alex hat einen Stellplatz in der Tiefgarage." }]
          : fact.includes("Lindenallee")
            ? [{ index, rest: null }]
            : [],
      ),
    );
    const { store, registry, turn } = setup("owner_message", { selectFacts });
    const ids = await apartment(store);
    const source = store.addMessage("inbound", "stellplatz dazu genommen", START);
    store.facts.find((fact) => fact.id === ids.stellplatz)!.sourceMessageId = source;

    const result = await registry.execute("forget_fact", { what: WHAT, fact_id: ids.gemietet }, turn);

    expect(result.ok).toBe(true);
    const left = await store.activeFacts();
    expect(left.map((fact) => fact.content).sort()).toEqual([
      "Alex hat einen Stellplatz in der Tiefgarage.",
      "Alex sucht eine Wohnung für seinen Bruder.",
    ]);
    expect(await store.allFactContents()).not.toContainEqual(expect.stringContaining("Lindenallee"));
    const trimmed = store.facts.find((fact) => fact.content.startsWith("Alex hat einen Stellplatz"));
    expect(trimmed).toMatchObject({ category: "auto", sourceMessageId: source });
    expect(result.text).toContain("the rest stays");
    const audits = auditMock.mock.calls.filter((call) => call[0] === "memory_forget");
    expect(audits).toHaveLength(3);
    expect(JSON.stringify(audits)).not.toContain("Lindenallee");
  });

  it("deletes entirely when the rest adds something or still names the detail", async () => {
    const selectFacts: MemoryDeps["selectFacts"] = async ({ facts }) =>
      facts.flatMap((fact, index): Array<{ index: number; rest: string | null }> =>
        fact.includes("Stellplatz")
          ? [{ index, rest: "Alex hat einen günstigen Stellplatz in der Tiefgarage." }]
          : fact.includes("Lindenallee")
            ? [{ index, rest: null }]
            : [],
      );
    const { store, registry, turn } = setup("owner_message", { selectFacts });
    const ids = await apartment(store);

    await registry.execute("forget_fact", { what: WHAT, fact_id: ids.wohnt }, turn);

    expect((await store.activeFacts()).map((fact) => fact.content)).toEqual(["Alex sucht eine Wohnung für seinen Bruder."]);
  });

  it("never trims the target, nor a rest that keeps a word of the target", async () => {
    const selectFacts: MemoryDeps["selectFacts"] = async ({ facts }) =>
      facts.flatMap((fact, index) =>
        fact.includes("Lindenallee")
          ? [{ index, rest: fact.includes("Stellplatz") ? "Alex hat einen Stellplatz in Brunnau." : fact.includes("gemietet") ? "Alex hat gemietet." : null }]
          : [],
      );
    const { store, registry, turn } = setup("owner_message", { selectFacts });
    const ids = await apartment(store);

    await registry.execute("forget_fact", { what: WHAT, fact_id: ids.gemietet }, turn);

    expect((await store.activeFacts()).map((fact) => fact.content)).toEqual(["Alex sucht eine Wohnung für seinen Bruder."]);
  });

  it("takes facts with two distinctive words of the detail along even without a model", async () => {
    const { store, registry, turn } = setup();
    const ids = await apartment(store);

    await registry.execute("forget_fact", { what: WHAT, fact_id: ids.gemietet }, turn);

    // Without a model only what shares no two distinctive words remains; that is the safe direction.
    expect((await store.activeFacts()).map((fact) => fact.id)).toEqual([ids.fremd]);
  });

  it("asks back instead of deleting many more facts on suspicion", async () => {
    const selectFacts: MemoryDeps["selectFacts"] = async ({ facts }) => facts.map((_, index) => ({ index, rest: null }));
    const { store, registry, turn } = setup("owner_message", { selectFacts });
    const target = await addFact(store, "wohnen", "Alex wohnt in Brunnau.");
    for (let i = 0; i < 7; i += 1) await addFact(store, "brunnau", `Alex kennt in Brunnau den Laden Nummer ${i}.`);

    const first = await registry.execute("forget_fact", { what: "Brunnau", fact_id: target }, turn);

    expect(first.ok).toBe(false);
    expect(first.text).toContain("8 facts");
    expect(store.facts).toHaveLength(8);

    const second = await registry.execute("forget_fact", { what: "Brunnau", fact_id: target, all_lines: true }, turn);
    expect(second.ok).toBe(true);
    expect(store.facts).toHaveLength(0);
  });
});

describe("Trimmed fact when forgetting", () => {
  const original = "Alex hat einen Stellplatz in der Tiefgarage der Wohnung Lindenallee 4 in Brunnau.";
  const what = "Wohnung in der Lindenallee";

  it("accepts a rest that only strikes", () => {
    expect(trimmedRest(original, "Alex hat einen Stellplatz in der Tiefgarage.", what)).toBe(true);
  });

  it("rejects new words, words of the detail, empty and unchanged", () => {
    expect(trimmedRest(original, "Alex hat einen günstigen Stellplatz.", what)).toBe(false);
    expect(trimmedRest(original, "Alex hat einen Stellplatz in der Lindenallee.", what)).toBe(false);
    expect(trimmedRest(original, "Alex hat einen", what)).toBe(false);
    expect(trimmedRest(original, null, what)).toBe(false);
    expect(trimmedRest(original, original, what)).toBe(false);
  });
});

describe("Finding the target when forgetting", () => {
  const candidate = (id: string, similarity: number, score: number) => ({
    id,
    category: "wohnort",
    content: `Fakt ${id}`,
    confidence: 0.9,
    sourceMessageId: null,
    createdAt: START.toISOString(),
    kind: "identity" as const,
    validFrom: null,
    validUntil: null,
    similarity,
    score,
    textHit: false,
  });

  it("picks by meaning, not by the rank from the fusion (D45)", () => {
    const stellplatz = { ...candidate("stellplatz", 0.58, 0.033), textHit: true };
    const wohnung = { ...candidate("wohnung", 0.74, 0.016), textHit: false };
    const decision = resolveForgetTarget([stellplatz, wohnung]);
    expect(decision.kind === "one" && decision.fact.id).toBe("wohnung");
  });

  it("asks back on a weak match instead of saying nothing is stored (D45)", () => {
    expect(resolveForgetTarget([candidate("a", 0.41, 0.01)]).kind).toBe("ambiguous");
  });

  it("accepts a full-text hit even with a weak vector (D45)", () => {
    const hit = { ...candidate("a", 0.52, 0.03), textHit: true };
    expect(resolveForgetTarget([hit]).kind).toBe("one");
  });

  it("reports none when no candidate is close enough", () => {
    expect(resolveForgetTarget([candidate("a", 0.2, 0.2)])).toEqual({ kind: "none" });
  });

  it("accepts a clear match", () => {
    const decision = resolveForgetTarget([candidate("a", 0.95, 0.95), candidate("b", 0.6, 0.6)]);
    expect(decision.kind).toBe("one");
  });

  it("reports ambiguous when two are close together", () => {
    const decision = resolveForgetTarget([candidate("a", 0.9, 0.9), candidate("b", 0.85, 0.85)]);
    expect(decision.kind).toBe("ambiguous");
  });
});

/**
 * D8.4: the level `write_reversible` of `forget_fact` is only justifiable as
 * long as the tool runs exclusively in turns the owner triggered (D13).
 * Exactly that is checked here, not on the description in the prompt, but on
 * the registry.
 */
describe("Memory tools only in turns from Alex (D8.4)", () => {
  it("deletes nothing when Alex did not trigger the turn", async () => {
    const { store, registry, turn } = setup("untrusted");
    const id = await addFact(store, "wohnort", "Mara wohnt in Cordheim.");

    const result = await registry.execute("forget_fact", { what: "wo Mara wohnt" }, turn);

    expect(result.ok).toBe(false);
    expect((await store.activeFacts("owner")).map((fact) => fact.id)).toEqual([id]);
    expect(auditMock).toHaveBeenCalledWith(
      "tool_denied",
      expect.objectContaining({ tool: "forget_fact", reason: "origin_not_owner" }),
      "db-1",
    );
  });

  it("does not show the memory when Alex did not trigger the turn", async () => {
    const { store, registry, turn, sent } = setup("untrusted");
    await addFact(store, "wohnort", "Mara wohnt in Cordheim.");

    const result = await registry.execute("show_memory", {}, turn);

    expect(result.ok).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it("runs both tools in a turn from Alex", async () => {
    const { store, registry, turn, sent } = setup();
    await addFact(store, "wohnort", "Mara wohnt in Cordheim.");

    expect((await registry.execute("show_memory", {}, turn)).ok).toBe(true);
    expect(sent).toHaveLength(1);
    expect((await registry.execute("forget_fact", { what: "wo Mara wohnt" }, turn)).ok).toBe(true);
    expect(await store.activeFacts("owner")).toHaveLength(0);
  });
});

describe("proposal questions and replies in other languages", async () => {
  const { parseProposalReply, renderLessonOffer, renderProcedureOffer } = await import("../src/memory/proposals.js");
  // Sunday, 2026-10-04, 18:30 in Berlin.
  const sunday = new Date("2026-10-04T16:30:00Z");
  const lessons = [
    { body: "Alex will A.", createdAt: "2026-10-04T08:00:00.000Z" },
    { body: "Alex will B", createdAt: "2026-10-02T10:00:00.000Z" },
    { body: "Alex will C", createdAt: "2026-09-24T08:00:00.000Z" },
  ];

  it("asks in German as before (OWNER_LANGUAGE=de)", () => {
    expect(renderLessonOffer(lessons, sunday)).toBe(
      [
        "aus der woche, drei sachen, die ich mir merken würde:",
        "1. Alex will A (nach deinem 👎 heute)",
        "2. Alex will B (nach deinem 👎 am fr)",
        "3. Alex will C (nach deinem 👎 am 24.09.)",
        "👍 für alle, 👎 für keins, oder schreib im thread die nummern.",
      ].join("\n"),
    );
    expect(renderLessonOffer(lessons.slice(0, 1), sunday).split("\n")[0]).toBe("aus der woche, eine sache, die ich mir merken würde:");
  });

  it("reads German, English and numbers as decisions", () => {
    for (const text of ["alle", "Alle!", "ja", "passt", "beide", "all", "yes", "both", "👍"]) expect(parseProposalReply(text, 2, "de")).toEqual({ kind: "all" });
    for (const text of ["keins", "nein", "nee", "nichts", "none", "no", "nope", "👎"]) expect(parseProposalReply(text, 2, "de")).toEqual({ kind: "none" });
    expect(parseProposalReply("1 und 3", 3, "de")).toEqual({ kind: "some", numbers: [1, 3] });
    expect(parseProposalReply("only 2", 3, "en")).toEqual({ kind: "some", numbers: [2] });
    expect(parseProposalReply("1 and 3", 3, "en")).toEqual({ kind: "some", numbers: [1, 3] });
    expect(parseProposalReply("1, 2 and 3", 3, "en")).toEqual({ kind: "all" });
    expect(parseProposalReply("1 and", 3, "en")).toBeNull();
    expect(parseProposalReply("1, but shorter", 3, "en")).toBeNull();
  });

  it("treats words of a language without a translated catalog as conversation, numbers still count", () => {
    for (const text of ["hepsi", "hiçbiri", "evet", "sadece 2", "1 ve 3"]) expect(parseProposalReply(text, 3, "sv")).toBeNull();
    expect(parseProposalReply("1, 3", 3, "sv")).toEqual({ kind: "some", numbers: [1, 3] });
    expect(parseProposalReply("👍", 3, "sv")).toEqual({ kind: "all" });
  });

  it("reads a translated language's words once its catalog is there, and asks in it", () => {
    expect(
      installTranslations("tr", {
        "all|all of them|both|both of them|everything|all three": "hepsi|ikisi de",
        "none|none of them|neither|nothing": "hiçbiri|hiç",
        "only|just": "sadece",
        and: "ve",
        "from this week, {count, plural, =1 {one thing} =2 {two things} =3 {three things} one {# thing} other {# things}} i'd remember:":
          "bu haftadan aklımda tutacağım {count, plural, =1 {bir şey} =2 {iki şey} =3 {üç şey} one {# şey} other {# şey}}:",
        "{number}. {lesson} (after your 👎 today)": "{number}. {lesson} (bugünkü 👎 sonrası)",
        "{number}. {lesson} (after your 👎 on {day})": "{number}. {lesson} ({day} günkü 👎 sonrası)",
        "👍 for all, 👎 for none, or write the numbers in the thread.": "hepsi için 👍, hiçbiri için 👎, ya da numaraları yaz.",
      }),
    ).toEqual([]);
    expect(parseProposalReply("Hepsi", 2, "tr")).toEqual({ kind: "all" });
    expect(parseProposalReply("hiçbiri", 2, "tr")).toEqual({ kind: "none" });
    expect(parseProposalReply("sadece 2", 3, "tr")).toEqual({ kind: "some", numbers: [2] });
    expect(parseProposalReply("1 ve 3", 3, "tr")).toEqual({ kind: "some", numbers: [1, 3] });
    // English and German keep working next to it.
    expect(parseProposalReply("keins", 2, "tr")).toEqual({ kind: "none" });
    expect(parseProposalReply("all", 2, "tr")).toEqual({ kind: "all" });
  });

  it("asks in English with English dates", async () => {
    const { ownerLanguage } = await import("../src/i18n/language.js");
    const spy = vi.spyOn(ownerLanguage, "current", "get").mockReturnValue("en");
    try {
      expect(renderLessonOffer(lessons, sunday)).toBe(
        [
          "from this week, three things i'd remember:",
          "1. Alex will A (after your 👎 today)",
          "2. Alex will B (after your 👎 on fri)",
          "3. Alex will C (after your 👎 on 09/24)",
          "👍 for all, 👎 for none, or write the numbers in the thread.",
        ].join("\n"),
      );
      expect(renderLessonOffer(lessons.slice(0, 1), sunday)).toBe("from this week, one thing i'd remember:\n1. Alex will A (after your 👎 today)\n👍 means yes, 👎 no.");
      expect(renderProcedureOffer({ title: "Postfach aufräumen", steps: "1. Spam\n2. Rest", when: "Alex will aufräumen" })).toBe(
        "Should I remember this as a procedure?\nPostfach aufräumen\n1. Spam\n2. Rest\nFits when: Alex will aufräumen\n👍 means yes.",
      );
    } finally {
      spy.mockRestore();
    }
  });
});
