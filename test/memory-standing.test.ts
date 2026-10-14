import { describe, expect, it, vi } from "vitest";

/**
 * What Serain already knows about Alex, at the right moment (memory package
 * of 2026-10-10): what holds right now is always in the context, and a shown
 * playbook fetches its memory itself. Fake database, set clock, everything
 * synthetic.
 */
vi.mock("../src/db/audit.js", () => ({ audit: async () => undefined }));
vi.mock("../src/config/env.js", () => ({
  env: { openrouterApiKey: "", claudeOauthToken: "", dataDir: "/tmp", integrationKey: "", supabaseUrl: "http://localhost:54321", supabaseSecretKey: "sb_secret_test" },
}));

const { buildMemoryContext, renderMemory } = await import("../src/memory/recall.js");
const { MEMORY } = await import("../src/config/memory.js");
const { FakeJudge, FakeMemoryStore } = await import("./memory-store.fake.js");

type MemoryDeps = import("../src/memory/deps.js").MemoryDeps;
type NewFact = import("../src/memory/store.js").NewFact;

// Monday, 2026-10-12, 12:00 in Berlin.
const NOW = new Date("2026-10-12T10:00:00Z");

function deps(store: InstanceType<typeof FakeMemoryStore>): MemoryDeps {
  return {
    store,
    judge: new FakeJudge(() => ({ type: "boolean", source: "generative", probability: 0.1 })),
    embed: async (texts) => texts.map(() => [0.1]),
    extractFacts: async () => [],
    summarize: async () => "",
    selectLines: async () => [],
    selectFacts: async () => [],
    consolidate: async () => ({ learned: "", outdatedBaseLines: [] }),
    classifyAreas: async ({ facts }) => facts.map(() => null),
    markerKey: Buffer.alloc(32),
    now: () => NOW,
  };
}

async function add(store: InstanceType<typeof FakeMemoryStore>, fact: Partial<NewFact> & { content: string }) {
  return store.insertFact({
    subject: "owner",
    category: "test",
    confidence: 0.9,
    kind: "identity",
    validFrom: null,
    validUntil: null,
    sourceMessageId: "m-1",
    embedding: null,
    createdAt: "2026-10-10T08:00:00.000Z",
    area: null,
    ...fact,
  });
}

describe("what holds right now (<current>)", () => {
  it("is in the context even if the message does not sound like it, and before the other facts", async () => {
    const store = new FakeMemoryStore();
    await add(store, { category: "reise", content: "Alex ist bis Freitag in Lissabon.", kind: "situation", validUntil: "2026-10-16T22:00:00.000Z" });
    await add(store, { category: "kleidung", content: "Alex braucht immer eine Jacke mit Kapuze.", kind: "preference" });
    const context = await buildMemoryContext(deps(store), { incoming: "brauch ich ne jacke?" });
    const rendered = renderMemory(context);
    expect(rendered).toContain("<current>");
    expect(rendered).toContain("[reise, situation, until 2026-10-16] Alex ist bis Freitag in Lissabon.");
    expect(rendered.indexOf("<current>")).toBeLessThan(rendered.indexOf("<facts>"));
    expect(rendered).toContain("[kleidung, preference] Alex braucht immer eine Jacke mit Kapuze.");
    expect(rendered).toContain("Alex braucht immer eine Jacke mit Kapuze.");
  });

  it("appears only once, even if the search finds the same situation", async () => {
    const store = new FakeMemoryStore();
    await add(store, { category: "reise", content: "Alex ist bis Freitag in Lissabon.", kind: "situation", validUntil: "2026-10-16T22:00:00.000Z" });
    const context = await buildMemoryContext(deps(store), { incoming: "wie wird das wetter in lissabon" });
    expect(context.situations).toHaveLength(1);
    expect(context.facts).toHaveLength(0);
    const rendered = renderMemory(context);
    expect(rendered.split("Alex ist bis Freitag in Lissabon.")).toHaveLength(2);
    expect(rendered).not.toContain("<facts>");
  });

  it("takes what starts shortly, with \"from\"; not what is over, old without an end, far off or only knowledge", async () => {
    const store = new FakeMemoryStore();
    await add(store, { category: "reise", content: "Alex ist ab morgen in Lissabon.", kind: "situation", validFrom: "2026-10-12T22:00:00.000Z", validUntil: "2026-10-16T22:00:00.000Z" });
    await add(store, { category: "gesundheit", content: "Alex ist erkältet.", kind: "situation", createdAt: "2026-10-09T08:00:00.000Z" });
    await add(store, { category: "studium", content: "Alex hatte Prüfungsphase.", kind: "situation", validUntil: "2026-08-31T22:00:00.000Z" });
    await add(store, { category: "arbeit", content: "Alex steckt in einem Projekt.", kind: "situation", createdAt: "2026-08-01T08:00:00.000Z" });
    await add(store, { category: "wohnen", content: "Alex zieht im Dezember um.", kind: "situation", validFrom: "2026-11-30T23:00:00.000Z" });
    await add(store, { category: "wohnen", content: "Alex wohnt in Ahrenfeld.", kind: "identity" });
    await add(store, { category: "reise", content: "Jemand ist in Rom.", kind: "situation", subject: "andere" });
    const context = await buildMemoryContext(deps(store), { incoming: "hi" });
    expect(context.situations.map((fact) => fact.content)).toEqual(["Alex ist ab morgen in Lissabon.", "Alex ist erkältet."]);
    const rendered = renderMemory(context);
    expect(rendered).toContain("[reise, situation, from 2026-10-13, until 2026-10-16] Alex ist ab morgen in Lissabon.");
    expect(rendered).not.toContain("Prüfungsphase");
    expect(rendered).not.toContain("Projekt");
    expect(rendered).not.toContain("Dezember");
    expect(rendered).not.toContain("Rom");
  });

  it("stays within the character limit and in front when many facts fit", async () => {
    const store = new FakeMemoryStore();
    await add(store, { category: "reise", content: "Alex ist bis Freitag in Lissabon.", kind: "situation", validUntil: "2026-10-16T22:00:00.000Z" });
    for (let i = 0; i < 40; i++) {
      await add(store, { category: "lang", content: `Alex hat einen ziemlich langen synthetischen Fakt über Jacken Nummer ${i}, mit allerhand Text dahinter.` });
    }
    const rendered = renderMemory(await buildMemoryContext(deps(store), { incoming: "jacken" }));
    expect(rendered.length).toBeLessThanOrEqual(MEMORY.maxContextChars + 2);
    expect(rendered.startsWith("<current>")).toBe(true);
    expect(rendered).toContain("Alex ist bis Freitag in Lissabon.");
  });

  it("lets the turn run when the query fails", async () => {
    const store = new FakeMemoryStore();
    await add(store, { category: "kleidung", content: "Alex braucht immer eine Jacke.", kind: "preference" });
    store.activeSituations = async () => {
      throw new Error("function missing");
    };
    const context = await buildMemoryContext(deps(store), { incoming: "jacke" });
    expect(context.situations).toEqual([]);
    expect(context.facts).toHaveLength(1);
  });
});

describe("playbooks fetch their memory themselves", () => {
  async function travelStore() {
    const store = new FakeMemoryStore();
    await add(store, { category: "reise", content: "Alex fliegt am liebsten ab Frankfurt Flughafen.", area: "places" });
    await add(store, { category: "bahn", content: "Alex hat eine Bahncard 50.", kind: "preference", area: "preferences" });
    await add(store, { category: "reise", content: "Alex sitzt im Flieger gern am Gang.", kind: "preference" });
    await add(store, { category: "familie", content: "Alex' Schwester heißt Mia.", area: "people" });
    await add(store, { category: "geburtstag", content: "Mia hat am 3. März Geburtstag.", area: "anniversaries" });
    return store;
  }

  it("brings departure airport and Bahncard to the trip, even if the message does not sound like it", async () => {
    const store = await travelStore();
    const context = await buildMemoryContext(deps(store), { incoming: "plan mir einen städtetrip nach rom" });
    expect(context.playbooks.map((playbook) => playbook.id)).toEqual(["reise"]);
    const rendered = renderMemory(context);
    expect(rendered).toContain("Alex fliegt am liebsten ab Frankfurt Flughafen.");
    expect(rendered).toContain("Alex hat eine Bahncard 50.");
    // Without an area the kind counts: a preference belongs to the preferences.
    expect(rendered).toContain("Alex sitzt im Flieger gern am Gang.");
    expect(rendered).not.toContain("Mia");
  });

  it("fetches nothing when no playbook fits or the playbook has no areas", async () => {
    const store = await travelStore();
    expect((await buildMemoryContext(deps(store), { incoming: "hast recht, danke dir" })).playbookFacts).toEqual([]);
    expect((await buildMemoryContext(deps(store), { incoming: "ist das phishing?" })).playbookFacts).toEqual([]);
  });

  it("at most eight, without duplicates with the search and with <current>", async () => {
    const store = await travelStore();
    await add(store, { category: "reise", content: "Alex ist bis Freitag in Lissabon.", kind: "situation", validUntil: "2026-10-16T22:00:00.000Z", area: "places" });
    for (let i = 0; i < 12; i++) await add(store, { category: "vorlieben", content: `Alex mag Sache ${i}.`, kind: "preference", area: "preferences" });
    const context = await buildMemoryContext(deps(store), { incoming: "hotel in rom mit bahncard rabatt?" });
    expect(context.playbookFacts.length).toBeLessThanOrEqual(MEMORY.playbookFactLimit);
    const ids = [...context.situations, ...context.facts, ...context.playbookFacts].map((fact) => fact.id);
    expect(new Set(ids).size).toBe(ids.length);
    // The search already found the Bahncard; it does not appear again under the playbook.
    expect(context.facts.some((fact) => fact.content.includes("Bahncard"))).toBe(true);
    expect(context.playbookFacts.some((fact) => fact.content.includes("Bahncard"))).toBe(false);
    expect(context.playbookFacts.some((fact) => fact.content.includes("Lissabon"))).toBe(false);
  });

  it("brings home town and ticket to the journey", async () => {
    const store = new FakeMemoryStore();
    await add(store, { category: "wohnen", content: "Alex wohnt in Ahrenfeld, nah am Bahnhof.", area: "places" });
    await add(store, { category: "mobilitaet", content: "Alex hat ein Deutschlandticket.", area: "self" });
    await add(store, { category: "familie", content: "Alex' Schwester heißt Mia.", area: "people" });
    const context = await buildMemoryContext(deps(store), { incoming: "wann fährt die nächste s-bahn nach frankfurt?" });
    expect(context.playbooks.map((playbook) => playbook.id)).toEqual(["unterwegs"]);
    const rendered = renderMemory(context);
    expect(rendered).toContain("Alex wohnt in Ahrenfeld, nah am Bahnhof.");
    expect(rendered).toContain("Alex hat ein Deutschlandticket.");
    expect(rendered).not.toContain("Mia");
  });
});
