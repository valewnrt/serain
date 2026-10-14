import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Proposals the owner confirms (V5, H5, D42): the decision parser, the taint
 * block, the weekly cadence, the adoption as fact or procedure and the
 * insertion in recall. Against the fake memory database, with a set clock.
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

const {
  ProposalService,
  decideOffer,
  offerWindowStart,
  parseProposalReply,
  proposalChoiceFromReaction,
  renderLessonOffer,
} = await import("../src/memory/proposals.js");
const { buildMemoryContext, renderMemory } = await import("../src/memory/recall.js");
const { PROCEDURES_PREAMBLE, pickProcedures } = await import("../src/memory/procedures.js");
const { FakeJudge, FakeMemoryStore } = await import("./memory-store.fake.js");

type LessonDeriver = import("../src/memory/lesson.js").LessonDeriver;
type MemoryDeps = import("../src/memory/deps.js").MemoryDeps;

/** Friday, 2 October 2026, 12:00 Berlin time (CEST, UTC+2). Sunday is the 4th. */
const FRIDAY_NOON = new Date("2026-10-02T10:00:00Z");
const SUNDAY_1759 = new Date("2026-10-04T15:59:00Z");
const SUNDAY_1800 = new Date("2026-10-04T16:00:00Z");
const SUNDAY_1830 = new Date("2026-10-04T16:30:00Z");
const SUNDAY_2230 = new Date("2026-10-04T20:30:00Z");
const MONDAY_0900 = new Date("2026-10-05T07:00:00Z");

function rig(options: { derive?: LessonDeriver } = {}) {
  const clock = { now: FRIDAY_NOON };
  const store = new FakeMemoryStore();
  const sent: Array<{ text: string; kind: string; taintSources: readonly string[] }> = [];
  const acks: Array<{ externalId: string; text: string }> = [];
  const state = { paused: false, lastMessageAt: null as Date | null, sentToday: 0, recorded: 0, sendFails: false };
  const derived: Array<{ said: string; correction: string }> = [];
  const service = new ProposalService({
    memory: { store, embed: async (texts) => texts.map(() => [0.1]), now: () => clock.now },
    deriveLesson: async (input) => {
      derived.push(input);
      return options.derive ? options.derive(input) : "Alex will bei Verkehrsfragen echte Daten statt Schätzungen.";
    },
    send: async (text, kind, taintSources) => {
      if (state.sendFails) return null;
      sent.push({ text, kind, taintSources });
      return { externalId: `offer-${sent.length}`, messageId: `db-offer-${sent.length}` };
    },
    acknowledge: async (externalId, text) => void acks.push({ externalId, text }),
    paused: async () => state.paused,
    lastMessageAt: async () => state.lastMessageAt,
    sentToday: async () => state.sentToday,
    recordSent: async () => void (state.recorded += 1),
  });
  return { clock, store, sent, acks, state, derived, service };
}

async function pendingLesson(store: InstanceType<typeof FakeMemoryStore>, body: string, at: Date, correction = "db-korrektur") {
  return store.insertProposal({
    kind: "lesson",
    title: "",
    body,
    trigger: "",
    status: "pending",
    offerExternalId: null,
    sourceMessageId: "db-serain",
    correctionMessageId: correction,
    taintSources: [],
    createdAt: at.toISOString(),
    offeredAt: null,
  });
}

beforeEach(() => auditMock.mockClear());

describe("Decision in code (pattern D14)", () => {
  it("reads numbers in the usual notations", () => {
    expect(parseProposalReply("1 und 3", 3)).toEqual({ kind: "some", numbers: [1, 3] });
    expect(parseProposalReply("1,3", 3)).toEqual({ kind: "some", numbers: [1, 3] });
    expect(parseProposalReply("nur 2", 3)).toEqual({ kind: "some", numbers: [2] });
    expect(parseProposalReply("2.", 3)).toEqual({ kind: "some", numbers: [2] });
    expect(parseProposalReply("3 1", 3)).toEqual({ kind: "some", numbers: [1, 3] });
    expect(parseProposalReply("1, 2 und 3", 3)).toEqual({ kind: "all" });
  });

  it("knows all and none", () => {
    for (const text of ["alle", "Alle!", "ja", "ok", "passt", "beide"]) expect(parseProposalReply(text, 2)).toEqual({ kind: "all" });
    for (const text of ["keins", "keine", "nein", "nee", "nichts"]) expect(parseProposalReply(text, 2)).toEqual({ kind: "none" });
  });

  it("takes everything else as conversation", () => {
    expect(parseProposalReply("1, aber kürzer", 3)).toBeNull();
    expect(parseProposalReply("ja aber nicht die 2", 3)).toBeNull();
    expect(parseProposalReply("4", 3)).toBeNull();
    expect(parseProposalReply("0", 3)).toBeNull();
    expect(parseProposalReply("", 3)).toBeNull();
    expect(parseProposalReply("was meinst du mit 2?", 3)).toBeNull();
  });

  it("reads tapbacks: 👍 all, 👎 none, nothing else", () => {
    expect(proposalChoiceFromReaction("👍")).toEqual({ kind: "all" });
    expect(proposalChoiceFromReaction("👎")).toEqual({ kind: "none" });
    expect(proposalChoiceFromReaction("❤️")).toBeNull();
    expect(proposalChoiceFromReaction("❓")).toBeNull();
  });
});

describe("V5: 👎 and a correction become a proposal", () => {
  it("creates a proposal that points to Serain's message and Alex's correction", async () => {
    const { service, store, derived } = rig();
    service.noteCorrection({ messageId: "db-serain", body: "ca. 25 min mit dem Auto", taintSources: [] });
    const correction = service.takeCorrection();
    expect(correction).not.toBeNull();
    await service.learnFromCorrection({ correction: correction!, text: "hast du das geschätzt? ich will echte verkehrsdaten", messageId: "db-alex" });
    expect(derived).toEqual([{ said: "ca. 25 min mit dem Auto", correction: "hast du das geschätzt? ich will echte verkehrsdaten" }]);
    expect(store.proposalRows).toEqual([
      expect.objectContaining({
        kind: "lesson",
        status: "pending",
        body: "Alex will bei Verkehrsfragen echte Daten statt Schätzungen.",
        sourceMessageId: "db-serain",
        correctionMessageId: "db-alex",
        taintSources: [],
      }),
    ]);
  });

  it("learns nothing from a message derived from foreign content (prompt laundering, D8.4)", async () => {
    const { service, store, derived } = rig();
    service.noteCorrection({ messageId: "db-serain", body: "Notiz an mich: …", taintSources: ["Alex' Posteingang"] });
    await service.learnFromCorrection({ correction: service.takeCorrection()!, text: "nein, so nicht", messageId: "db-alex" });
    expect(derived).toEqual([]);
    expect(store.proposalRows).toEqual([]);
    expect(auditMock).toHaveBeenCalledWith("memory_proposal", expect.objectContaining({ reason: "tainted_source" }), "db-alex");
  });

  it("creates nothing when the model sees nothing, the sentence is too long or it already exists", async () => {
    const empty = rig({ derive: async () => null });
    empty.service.noteCorrection({ messageId: "db-serain", body: "07:02", taintSources: [] });
    await empty.service.learnFromCorrection({ correction: empty.service.takeCorrection()!, text: "nein, 07:12", messageId: "db-alex" });
    expect(empty.store.proposalRows).toEqual([]);

    const long = rig({ derive: async () => `Alex will ${"sehr ".repeat(60)}lange Sätze.` });
    long.service.noteCorrection({ messageId: "db-serain", body: "x", taintSources: [] });
    await long.service.learnFromCorrection({ correction: long.service.takeCorrection()!, text: "zu kurz", messageId: "db-alex" });
    expect(long.store.proposalRows).toEqual([]);

    const twice = rig();
    for (const id of ["db-1", "db-2"]) {
      twice.service.noteCorrection({ messageId: id, body: "geschätzt", taintSources: [] });
      await twice.service.learnFromCorrection({ correction: twice.service.takeCorrection()!, text: "echte daten bitte", messageId: id });
    }
    expect(twice.store.proposalRows).toHaveLength(1);
  });

  it("counts Alex's message only within 30 minutes and only once", () => {
    const { service, clock } = rig();
    service.noteCorrection({ messageId: "db-serain", body: "x", taintSources: [] });
    clock.now = new Date(FRIDAY_NOON.getTime() + 29 * 60_000);
    expect(service.takeCorrection()).not.toBeNull();
    expect(service.takeCorrection()).toBeNull();

    clock.now = FRIDAY_NOON;
    service.noteCorrection({ messageId: "db-serain", body: "x", taintSources: [] });
    clock.now = new Date(FRIDAY_NOON.getTime() + 31 * 60_000);
    expect(service.takeCorrection()).toBeNull();
  });
});

describe("Weekly cadence", () => {
  it("computes the most recent Sunday 18:00 Berlin time", () => {
    expect(offerWindowStart(SUNDAY_1759).toISOString()).toBe("2026-09-27T16:00:00.000Z");
    expect(offerWindowStart(SUNDAY_1800).toISOString()).toBe("2026-10-04T16:00:00.000Z");
    expect(offerWindowStart(MONDAY_0900).toISOString()).toBe("2026-10-04T16:00:00.000Z");
    expect(offerWindowStart(FRIDAY_NOON).toISOString()).toBe("2026-09-27T16:00:00.000Z");
  });

  const base = { lastOfferAt: new Date("2026-09-27T16:30:00Z"), paused: false, lastMessageAt: null, sentToday: 0, waiting: 2 };

  it("asks from Sunday 18:00, not earlier, and once a week", () => {
    expect(decideOffer({ ...base, now: SUNDAY_1759 })).toEqual({ offer: false, reason: "not_due" });
    expect(decideOffer({ ...base, now: SUNDAY_1800 })).toEqual({ offer: true });
    expect(decideOffer({ ...base, now: SUNDAY_1830, lastOfferAt: SUNDAY_1800 })).toEqual({ offer: false, reason: "not_due" });
  });

  it("stays quiet at night, on kill switch, mid-conversation, above the daily cap and without a proposal", () => {
    expect(decideOffer({ ...base, now: SUNDAY_2230 })).toEqual({ offer: false, reason: "quiet_hours" });
    expect(decideOffer({ ...base, now: SUNDAY_1830, paused: true })).toEqual({ offer: false, reason: "paused" });
    expect(decideOffer({ ...base, now: SUNDAY_1830, lastMessageAt: new Date(SUNDAY_1830.getTime() - 5 * 60_000) })).toEqual({
      offer: false,
      reason: "in_conversation",
    });
    expect(decideOffer({ ...base, now: SUNDAY_1830, sentToday: 1 })).toEqual({ offer: false, reason: "daily_limit" });
    expect(decideOffer({ ...base, now: SUNDAY_1830, waiting: 0 })).toEqual({ offer: false, reason: "nothing_waiting" });
  });

  it("catches up on a missed Sunday in the same week", () => {
    expect(decideOffer({ ...base, now: MONDAY_0900 })).toEqual({ offer: true });
  });

  it("sends one message with at most three proposals, oldest first, and counts it against the daily cap", async () => {
    const { service, store, sent, state, clock } = rig();
    for (const [index, body] of ["Alex will A.", "Alex will B.", "Alex will C.", "Alex will D."].entries()) {
      await pendingLesson(store, body, new Date(FRIDAY_NOON.getTime() + index * 60_000));
    }
    clock.now = SUNDAY_1830;
    await service.maybeOffer();
    expect(sent).toEqual([
      {
        text:
          "aus der woche, drei sachen, die ich mir merken würde:\n1. Alex will A (nach deinem 👎 am fr)\n2. Alex will B (nach deinem 👎 am fr)\n" +
          "3. Alex will C (nach deinem 👎 am fr)\n👍 für alle, 👎 für keins, oder schreib im thread die nummern.",
        kind: "lesson_offer",
        taintSources: [],
      },
    ]);
    expect(store.proposalRows.map((row) => row.status)).toEqual(["offered", "offered", "offered", "pending"]);
    expect(store.proposalRows[0]?.offerExternalId).toBe("offer-1");
    expect(state.recorded).toBe(1);

    // Not again in the same week, not even for the fourth.
    clock.now = new Date(SUNDAY_1830.getTime() + 60 * 60_000);
    await service.maybeOffer();
    expect(sent).toHaveLength(1);
  });

  it("does not ask about what only came in after Sunday 18:00", async () => {
    const { service, store, sent, clock } = rig();
    await pendingLesson(store, "Alex will A.", new Date(SUNDAY_1800.getTime() + 60_000));
    clock.now = SUNDAY_1830;
    await service.maybeOffer();
    expect(sent).toEqual([]);
  });

  it("sends nothing with the kill switch pulled and nothing at night", async () => {
    const paused = rig();
    await pendingLesson(paused.store, "Alex will A.", FRIDAY_NOON);
    paused.state.paused = true;
    paused.clock.now = SUNDAY_1830;
    await paused.service.maybeOffer();
    expect(paused.sent).toEqual([]);

    const night = rig();
    await pendingLesson(night.store, "Alex will A.", FRIDAY_NOON);
    night.clock.now = SUNDAY_2230;
    await night.service.maybeOffer();
    expect(night.sent).toEqual([]);
  });

  it("phrases a single question without the numbers hint", () => {
    expect(renderLessonOffer([{ body: "Alex will A.", createdAt: FRIDAY_NOON.toISOString() }], SUNDAY_1830)).toBe(
      "aus der woche, eine sache, die ich mir merken würde:\n1. Alex will A (nach deinem 👎 am fr)\n👍 heißt ja, 👎 nein.",
    );
  });

  it("names the day of the 👎 per item: today, the weekday within the week, the date before that (addendum D23 of 2026-10-10)", () => {
    const text = renderLessonOffer(
      [
        { body: "Alex will A.", createdAt: new Date("2026-10-04T08:00:00Z").toISOString() },
        { body: "Alex will B", createdAt: new Date("2026-09-24T08:00:00Z").toISOString() },
      ],
      SUNDAY_1830,
    );
    expect(text).toContain("1. Alex will A (nach deinem 👎 heute)");
    expect(text).toContain("2. Alex will B (nach deinem 👎 am 24.09.)");
    expect(text).not.toMatch(/[–—]/);
  });

  it("lets an unanswered question expire after seven days, along with its text", async () => {
    const { service, store, clock } = rig();
    await pendingLesson(store, "Alex will A.", FRIDAY_NOON);
    clock.now = SUNDAY_1830;
    await service.maybeOffer();
    clock.now = new Date(SUNDAY_1830.getTime() + 6 * 86_400_000);
    await service.maybeOffer();
    expect(store.proposalRows[0]?.status).toBe("offered");
    clock.now = new Date(SUNDAY_1830.getTime() + 7 * 86_400_000 + 60_000);
    await service.maybeOffer();
    expect(store.proposalRows[0]).toMatchObject({ status: "expired", body: "" });
  });
});

describe("Acceptance writes a fact or procedure", () => {
  async function offered() {
    const r = rig();
    for (const [index, body] of ["Alex will A.", "Alex will B.", "Alex will C."].entries()) {
      await pendingLesson(r.store, body, new Date(FRIDAY_NOON.getTime() + index * 60_000), `db-korrektur-${index + 1}`);
    }
    r.clock.now = SUNDAY_1830;
    await r.service.maybeOffer();
    return r;
  }

  it("turns 👍 on the combined question into three facts of kind preference in category style", async () => {
    const { service, store, acks } = await offered();
    expect(await service.onReaction("offer-1", "👍")).toBe(true);
    expect(store.facts.map((fact) => [fact.content, fact.kind, fact.category, fact.sourceMessageId])).toEqual([
      ["Alex will A.", "preference", "style", "db-korrektur-1"],
      ["Alex will B.", "preference", "style", "db-korrektur-2"],
      ["Alex will C.", "preference", "style", "db-korrektur-3"],
    ]);
    expect(store.proposalRows.map((row) => [row.status, row.body])).toEqual([
      ["accepted", ""],
      ["accepted", ""],
      ["accepted", ""],
    ]);
    // A tapback gets no acknowledgement.
    expect(acks).toEqual([]);
    expect(auditMock).toHaveBeenCalledWith(
      "memory_proposal",
      expect.objectContaining({ action: "decided", accepted: 3, rejected: 0, fact_ids: expect.any(Array) }),
      undefined,
    );
  });

  it("takes none on 👎 and empties the texts", async () => {
    const { service, store } = await offered();
    expect(await service.onReaction("offer-1", "👎")).toBe(true);
    expect(store.facts).toEqual([]);
    expect(store.proposalRows.map((row) => [row.status, row.body])).toEqual([
      ["rejected", ""],
      ["rejected", ""],
      ["rejected", ""],
    ]);
  });

  it("takes exactly those on \"1 und 3\" in the thread and acknowledges with 👍 on Alex's reply", async () => {
    const { service, store, acks } = await offered();
    const handled = await service.onReply({ offerExternalId: "offer-1", text: "1 und 3", decisionMessageId: "db-antwort", ackExternalId: "m-antwort" });
    expect(handled).toBe(true);
    expect(store.facts.map((fact) => fact.content)).toEqual(["Alex will A.", "Alex will C."]);
    expect(store.proposalRows.map((row) => row.status)).toEqual(["accepted", "rejected", "accepted"]);
    expect(acks).toEqual([{ externalId: "m-antwort", text: "Gemerkt." }]);
  });

  it("lets a conversation in the thread through and decides nothing", async () => {
    const { service, store } = await offered();
    expect(await service.onReply({ offerExternalId: "offer-1", text: "was meinst du mit B?", decisionMessageId: "db-x", ackExternalId: "m-x" })).toBe(false);
    expect(store.proposalRows.every((row) => row.status === "offered")).toBe(true);
  });

  it("swallows a second 👎 on a decided question instead of passing it on as a correction", async () => {
    const { service, store } = await offered();
    await service.onReaction("offer-1", "👍");
    expect(await service.onReaction("offer-1", "👎")).toBe(true);
    expect(store.facts).toHaveLength(3);
    // A message that is not a proposal question belongs to the caller.
    expect(await service.onReaction("irgendwas", "👎")).toBe(false);
  });

  it("sends the question about a procedure with the turn's taint and stores it only after 👍", async () => {
    const { service, store, sent } = rig();
    const result = await service.offerProcedure({
      title: "Postfach aufräumen",
      steps: "1. Spam-Ordner leeren\n2. Behalten-Liste prüfen\n3. Ein Aufruf für alle Absender",
      when: "Alex will sein Postfach aufräumen",
      taintSources: ["Alex' Posteingang"],
      sourceMessageId: "db-auftrag",
    });
    expect(result.ok).toBe(true);
    expect(sent).toEqual([
      {
        text:
          "Soll ich mir das als Ablauf merken?\nPostfach aufräumen\n1. Spam-Ordner leeren\n2. Behalten-Liste prüfen\n" +
          "3. Ein Aufruf für alle Absender\nPasst, wenn: Alex will sein Postfach aufräumen\n👍 heißt ja.",
        kind: "procedure_offer",
        taintSources: ["Alex' Posteingang"],
      },
    ]);
    expect(store.procedureRows).toEqual([]);
    expect(store.proposalRows[0]).toMatchObject({ kind: "procedure", status: "offered", taintSources: ["Alex' Posteingang"] });

    await service.onReaction("offer-1", "👍");
    expect(store.procedureRows).toEqual([
      expect.objectContaining({ title: "Postfach aufräumen", trigger: "Alex will sein Postfach aufräumen", proposalId: store.proposalRows[0]?.id }),
    ]);
    expect(store.proposalRows[0]).toMatchObject({ status: "accepted", body: "" });
  });

  it("rejects duplicates and does not ask again after a 👎", async () => {
    const { service, store, sent } = rig();
    const offer = { title: "Postfach aufräumen", steps: "1. Spam\n2. Rest", when: "Alex will aufräumen", taintSources: [], sourceMessageId: "" };
    await service.offerProcedure(offer);
    expect((await service.offerProcedure({ ...offer, title: "postfach  Aufräumen!" })).text).toContain("already with Alex");
    await service.onReaction("offer-1", "👎");
    expect((await service.offerProcedure(offer)).text).toContain("already declined");
    expect(sent).toHaveLength(1);
    expect(store.procedureRows).toEqual([]);
  });

  it("keeps at most 20 procedures including open questions", async () => {
    const { service, store, sent } = rig();
    for (let i = 0; i < 20; i += 1) {
      await store.insertProcedure({ title: `Ablauf ${i}`, body: "1. x", trigger: "y", embedding: null, proposalId: null, createdAt: FRIDAY_NOON.toISOString() });
    }
    const result = await service.offerProcedure({ title: "Noch einer", steps: "1. a\n2. b", when: "immer", taintSources: [], sourceMessageId: "" });
    expect(result.ok).toBe(false);
    expect(sent).toEqual([]);
  });
});

describe("Recall: procedures only when they fit", () => {
  function memory(store: InstanceType<typeof FakeMemoryStore>): MemoryDeps {
    return {
      store,
      judge: new FakeJudge(() => {
        throw new Error("Recall does not ask the judge");
      }),
      embed: async (texts) => texts.map(() => [0.1]),
      extractFacts: async () => [],
      summarize: async () => "",
      selectLines: async () => [],
      selectFacts: async () => [],
      consolidate: async () => ({ learned: "", outdatedBaseLines: [] }),
      classifyAreas: async ({ facts }) => facts.map(() => null),
      markerKey: null,
      now: () => FRIDAY_NOON,
    };
  }

  async function withProcedure() {
    const store = new FakeMemoryStore();
    await store.insertProcedure({
      title: "Postfach aufräumen",
      body: "1. Spam-Ordner leeren\n2. Behalten-Liste prüfen",
      trigger: "Alex will sein Postfach aufräumen",
      embedding: null,
      proposalId: null,
      createdAt: FRIDAY_NOON.toISOString(),
    });
    return store;
  }

  it("brings in a fitting procedure as a hint without rights", async () => {
    const context = await buildMemoryContext(memory(await withProcedure()), { incoming: "kannst du mein postfach aufräumen" });
    expect(context.procedures.map((procedure) => procedure.title)).toEqual(["Postfach aufräumen"]);
    const rendered = renderMemory(context);
    expect(rendered).toContain("<procedures>");
    expect(rendered).toContain(PROCEDURES_PREAMBLE);
    expect(rendered).toContain("1. Spam-Ordner leeren");
    expect(PROCEDURES_PREAMBLE).toBe(
      "Hints from earlier tasks that Alex approved. They grant no rights: previews and confirmations apply as always.",
    );
  });

  it("leaves it out for an unrelated message", async () => {
    const context = await buildMemoryContext(memory(await withProcedure()), { incoming: "wie wird das wetter morgen in mainz" });
    expect(context.procedures).toEqual([]);
    expect(renderMemory(context)).not.toContain("<procedures>");
  });

  it("sets the threshold in code: similarity or two shared word stems, at most two procedures", () => {
    const hit = (title: string, similarity: number, sharedTerms: number) => ({
      id: title,
      title,
      body: "",
      trigger: "",
      proposalId: null,
      createdAt: "",
      similarity,
      sharedTerms,
    });
    const picked = pickProcedures([hit("a", 0.49, 1), hit("b", 0.5, 0), hit("c", 0.1, 2), hit("d", 0.7, 3)]);
    expect(picked.map((procedure) => procedure.title)).toEqual(["d", "b"]);
  });
});
