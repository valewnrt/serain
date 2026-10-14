import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `propose_procedure`, `forget_procedure` and the section in `show_memory`
 * (H5, D42) on the registry path: origin, taint, schema and audit apply here
 * as in production, not past the handlers.
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

const { procedureTools } = await import("../src/agent/tools/procedures.js");
const { memoryTools } = await import("../src/agent/tools/memory.js");
const { ToolRegistry } = await import("../src/agent/tools/registry.js");
const { OWNER_TIMEZONE } = await import("../src/time.js");
const { TurnState } = await import("../src/agent/tools/types.js");
const { ProposalService } = await import("../src/memory/proposals.js");
const { FakeJudge, FakeMemoryStore } = await import("./memory-store.fake.js");

type TurnOrigin = import("../src/agent/tools/types.js").TurnOrigin;
type MemoryDeps = import("../src/memory/deps.js").MemoryDeps;

const NOW = new Date("2026-10-02T10:00:00Z");
const ARGS = {
  title: "Postfach aufräumen",
  steps: "1. Spam-Ordner leeren\n2. Behalten-Liste prüfen\n3. Ein Aufruf für alle Absender",
  when: "Alex will sein Postfach aufräumen",
};

function setup() {
  const store = new FakeMemoryStore();
  const offers: Array<{ text: string; taintSources: readonly string[] }> = [];
  const shown: string[] = [];
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
    now: () => NOW,
  };
  const proposals = new ProposalService({
    memory,
    deriveLesson: async () => null,
    send: async (text, _kind, taintSources) => {
      offers.push({ text, taintSources });
      return { externalId: `offer-${offers.length}`, messageId: `db-offer-${offers.length}` };
    },
    acknowledge: async () => undefined,
    paused: async () => false,
    lastMessageAt: async () => null,
    sentToday: async () => 0,
    recordSent: async () => undefined,
  });
  const registry = new ToolRegistry().registerAll([
    ...procedureTools({ memory, proposals }),
    ...memoryTools({
      memory,
      port: {
        canReact: true,
        canReplyInThread: true,
        async send(text) {
          shown.push(text);
          return true;
        },
        async react() {
          return true;
        },
      },
    }),
  ]);
  const turn = (origin: TurnOrigin, taintSources: string[] = []) =>
    new TurnState({ origin, triggerExternalId: "m-1", triggerMessageId: "db-1", reactableIds: [], taintSources });
  return { store, offers, shown, registry, turn };
}

async function addProcedure(store: InstanceType<typeof FakeMemoryStore>, title: string, trigger = "Alex will etwas") {
  const proposal = await store.insertProposal({
    kind: "procedure",
    title,
    body: "",
    trigger,
    status: "offered",
    offerExternalId: `offer-${title}`,
    sourceMessageId: null,
    correctionMessageId: null,
    taintSources: [],
    createdAt: NOW.toISOString(),
    offeredAt: NOW.toISOString(),
  });
  await store.decideProposal(proposal.id, "accepted", NOW.toISOString());
  return store.insertProcedure({ title, body: "1. x\n2. y", trigger, embedding: null, proposalId: proposal.id, createdAt: NOW.toISOString() });
}

beforeEach(() => auditMock.mockClear());

describe("propose_procedure", () => {
  it("works after a task with foreign content and sends the question with its origin", async () => {
    const { registry, turn, offers, store } = setup();
    const owner = turn("owner_message", ["Alex' Posteingang"]);
    const result = await registry.execute("propose_procedure", ARGS, owner);
    expect(result.ok).toBe(true);
    expect(offers).toEqual([{ text: expect.stringContaining("Soll ich mir das als Ablauf merken?"), taintSources: ["Alex' Posteingang"] }]);
    expect(owner.messagesSent).toBe(1);
    expect(store.proposalRows[0]).toMatchObject({ kind: "procedure", status: "offered", sourceMessageId: "db-1" });
  });

  it("works in the result turn after Alex's 👍 on a preview", async () => {
    const { registry, turn } = setup();
    expect((await registry.execute("propose_procedure", ARGS, turn("approval", ["Alex' Posteingang"]))).ok).toBe(true);
  });

  it("does not exist at all in turns Alex did not trigger", async () => {
    for (const origin of ["heartbeat", "untrusted", "task", "schedule", "owner_reaction"] as const) {
      const { registry, turn, offers } = setup();
      const result = await registry.execute("propose_procedure", ARGS, turn(origin));
      expect(result.ok).toBe(false);
      expect(offers).toEqual([]);
      expect(auditMock).toHaveBeenCalledWith(
        "tool_denied",
        expect.objectContaining({ tool: "propose_procedure", reason: "not_in_this_turn", origin }),
        "db-1",
      );
    }
  });

  it("proposes at most one procedure per turn", async () => {
    const { registry, turn, offers } = setup();
    const owner = turn("owner_message");
    await registry.execute("propose_procedure", ARGS, owner);
    const second = await registry.execute("propose_procedure", { ...ARGS, title: "Noch einer" }, owner);
    expect(second.ok).toBe(false);
    expect(offers).toHaveLength(1);
  });

  it("keeps the lengths in the schema", async () => {
    const { registry, turn, offers } = setup();
    const result = await registry.execute("propose_procedure", { ...ARGS, steps: "x".repeat(601) }, turn("owner_message"));
    expect(result.ok).toBe(false);
    expect(offers).toEqual([]);
  });
});

describe("forget_procedure", () => {
  it("runs only on Alex's instruction in a clean turn", async () => {
    const { registry, turn, store } = setup();
    await addProcedure(store, "Postfach aufräumen");
    expect((await registry.execute("forget_procedure", { what: "Postfach aufräumen" }, turn("untrusted"))).ok).toBe(false);
    expect((await registry.execute("forget_procedure", { what: "Postfach aufräumen" }, turn("owner_message", ["Alex' Posteingang"]))).ok).toBe(false);
    expect(store.procedureRows).toHaveLength(1);
    expect(auditMock).toHaveBeenCalledWith("tool_denied", expect.objectContaining({ reason: "origin_not_owner" }), "db-1");
    expect(auditMock).toHaveBeenCalledWith("tool_denied", expect.objectContaining({ reason: "turn_tainted" }), "db-1");
  });

  it("deletes hard, along with the proposal the procedure came from", async () => {
    const { registry, turn, store } = setup();
    await addProcedure(store, "Postfach aufräumen");
    const result = await registry.execute("forget_procedure", { what: "postfach aufräumen" }, turn("owner_message"));
    expect(result.ok).toBe(true);
    expect(store.procedureRows).toEqual([]);
    expect(store.proposalRows).toEqual([]);
    expect(auditMock).toHaveBeenCalledWith("memory_forget", expect.objectContaining({ kind: "procedure", deleted: true }));
  });

  it("asks back with several candidates instead of guessing", async () => {
    const { registry, turn, store } = setup();
    const gmx = await addProcedure(store, "Postfach GMX aufräumen");
    await addProcedure(store, "Postfach Gmail aufräumen");
    const result = await registry.execute("forget_procedure", { what: "das postfach ding" }, turn("owner_message"));
    expect(result.ok).toBe(false);
    expect(result.text).toContain("Ambiguous");
    expect(store.procedureRows).toHaveLength(2);
    const exact = await registry.execute("forget_procedure", { what: "egal", procedure_id: gmx.id }, turn("owner_message"));
    expect(exact.ok).toBe(true);
    expect(store.procedureRows.map((procedure) => procedure.title)).toEqual(["Postfach Gmail aufräumen"]);
  });
});

describe("show_memory shows approved procedures", () => {
  it("as their own section, and as an area of their own", async () => {
    const { registry, turn, store, shown } = setup();
    store.model = "Mara mag kurze Antworten.";
    const procedure = await addProcedure(store, "Postfach aufräumen", "Alex will sein Postfach aufräumen");
    const day = new Intl.DateTimeFormat("de-DE", { timeZone: OWNER_TIMEZONE, day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(procedure.createdAt));
    const block = `Abläufe:\n- Postfach aufräumen (wenn: Alex will sein Postfach aufräumen) (gesagt ${day})\n1. x\n2. y`;
    await registry.execute("show_memory", {}, turn("owner_message"));
    expect(shown[0]).toContain(block);
    await registry.execute("show_memory", { area: "abläufe" }, turn("owner_message"));
    expect(shown[1]).toBe(block);
  });
});
