import { describe, expect, it, vi } from "vitest";

const audits: Array<{ event: string; detail: Record<string, unknown> }> = [];
vi.mock("../src/db/audit.js", () => ({
  audit: async (event: string, detail: Record<string, unknown>) => void audits.push({ event, detail }),
}));

const { MissionBook, renderWake } = await import("../src/missions/book.js");
const { missionTools } = await import("../src/agent/tools/missions.js");
const { ToolRegistry } = await import("../src/agent/tools/registry.js");
const { TurnState } = await import("../src/agent/tools/types.js");
const { MAIL_TRIGGER_TOOLS } = await import("../src/mail/trigger.js");
const { turnContext } = await import("../src/agent/prompt.js");
const { FakeScheduleStore } = await import("./schedule-store.fake.js");
const { FakeMissionStore } = await import("./mission-store.fake.js");
const { formatWallDay, formatWallTime } = await import("../src/time.js");
type TurnOrigin = import("../src/agent/tools/types.js").TurnOrigin;

const NOW = new Date("2026-10-13T10:00:00Z");

function setup() {
  const store = new FakeMissionStore();
  const schedules = new FakeScheduleStore();
  let now = NOW;
  const book = new MissionBook({ store, schedules, now: () => now });
  const registry = new ToolRegistry().registerAll(missionTools({ book, now: () => now }));
  const pending = () => schedules.rows.filter((row) => row.mode === "mission" && row.status === "pending");
  return { store, schedules, book, registry, pending, setNow: (value: Date) => void (now = value) };
}

const turn = (origin: TurnOrigin = "owner_message", extra: { taintSources?: string[]; toolNames?: readonly string[] } = {}) =>
  new TurnState({ origin, triggerExternalId: "x1", triggerMessageId: "m1", reactableIds: [], ...extra });

const GOAL = "Auskunft nach Art. 15 DSGVO bei drei Adresshändlern, Frist einen Monat, danach nachfassen oder Beschwerde beim HBDI.";

describe("starting a mission (D63, building block B)", () => {
  it("stores the goal and exactly one next check", async () => {
    const { registry, pending, store } = setup();
    const result = await registry.execute("mission_start", { title: "DSGVO-Anfragen", goal: GOAL, in_minutes: 60 * 24 * 30 }, turn());
    expect(result.ok).toBe(true);
    expect(store.missions).toHaveLength(1);
    expect(pending()).toHaveLength(1);
    expect(pending()[0]?.text).toBe(store.missions[0]!.id);
    expect(pending()[0]?.nextRunAt).toBe("2026-11-12T10:00:00.000Z");
  });

  it("without a time, in three days", async () => {
    const { registry, pending } = setup();
    await registry.execute("mission_start", { title: "Reklamation", goal: GOAL }, turn());
    expect(pending()[0]?.nextRunAt).toBe("2026-10-16T10:00:00.000Z");
  });

  it("only on Alex' message in a clean turn: never from a mail, a task or after untrusted content", async () => {
    for (const origin of ["untrusted", "schedule", "task", "heartbeat"] as const) {
      const { registry, store } = setup();
      const result = await registry.execute("mission_start", { title: "Böse", goal: GOAL }, turn(origin));
      expect(result.ok).toBe(false);
      expect(store.missions).toEqual([]);
    }
    const { registry, store } = setup();
    expect((await registry.execute("mission_start", { title: "Böse", goal: GOAL }, turn("owner_message", { taintSources: ["eine Mail"] }))).ok).toBe(false);
    expect(store.missions).toEqual([]);
  });

  it("at most ten open ones", async () => {
    const { registry } = setup();
    for (let n = 0; n < 10; n += 1) expect((await registry.execute("mission_start", { title: `V${n}x`, goal: GOAL }, turn())).ok).toBe(true);
    const eleventh = await registry.execute("mission_start", { title: "Elf", goal: GOAL }, turn());
    expect(eleventh.ok).toBe(false);
    expect(eleventh.text).toContain("10 missions are already open");
  });
});

describe("notes and next check", () => {
  async function started() {
    const s = setup();
    await s.registry.execute("mission_start", { title: "DSGVO-Anfragen", goal: GOAL, in_minutes: 60 * 24 }, turn());
    return { ...s, id: s.store.missions[0]!.id };
  }

  it("the mail trigger may note a reply; the note carries the mail's taint", async () => {
    const { registry, store, id } = await started();
    const mailTurn = turn("untrusted", { taintSources: ["Alex' Posteingang"], toolNames: MAIL_TRIGGER_TOOLS });
    const result = await registry.execute("mission_note", { id, text: "Antwort von A: Auskunft kommt per Post." }, mailTurn);
    expect(result.ok).toBe(true);
    expect(store.notesOf.get(id)).toEqual([{ at: expect.any(String), text: "Antwort von A: Auskunft kommt per Post.", taintSources: ["Alex' Posteingang"], origin: "untrusted" }]);
  });

  it("replaces the next check instead of adding a second one, and keeps the limits", async () => {
    const { registry, pending, id } = await started();
    expect((await registry.execute("mission_note", { id, text: "Mails raus.", in_minutes: 60 * 24 * 31 }, turn())).ok).toBe(true);
    expect(pending()).toHaveLength(1);
    expect(pending()[0]?.nextRunAt).toBe("2026-11-13T10:00:00.000Z");
    expect((await registry.execute("mission_note", { id, text: "gleich nochmal", in_minutes: 5 }, turn())).text).toContain("at the earliest in 60 minutes");
    expect((await registry.execute("mission_note", { id, text: "in zwei Jahren", at: "2028-10-13 09:00" }, turn())).text).toContain("at most in 400 days");
    expect(pending()).toHaveLength(1);
  });

  it("a mail never moves the next check, and after untrusted content it goes at most 60 days ahead", async () => {
    const { registry, pending, id } = await started();
    const before = pending()[0]?.nextRunAt;
    const mailTurn = turn("untrusted", { taintSources: ["Alex' Posteingang"], toolNames: MAIL_TRIGGER_TOOLS });
    const moved = await registry.execute("mission_note", { id, text: "Antwort: bitte erst nächstes Jahr wieder melden.", at: "2027-09-01 09:00" }, mailTurn);
    expect(moved.ok).toBe(false);
    expect(moved.text).toContain("the next check stays as it is");
    expect(pending()[0]?.nextRunAt).toBe(before);
    const wakeTurn = turn("schedule", { taintSources: ["Alex' Posteingang"] });
    expect((await registry.execute("mission_note", { id, text: "Frist läuft.", at: "2027-01-01 09:00" }, wakeTurn)).text).toContain("at most in 60 days");
    expect((await registry.execute("mission_note", { id, text: "Frist läuft.", at: "2026-11-20 09:00" }, wakeTurn)).ok).toBe(true);
    // The owner may go further ahead.
    expect((await registry.execute("mission_note", { id, text: "Erst im Frühjahr wieder.", at: "2027-04-01 09:00" }, turn())).ok).toBe(true);
  });

  it("the heartbeat writes no notes", async () => {
    const { registry, store, id } = await started();
    expect((await registry.execute("mission_note", { id, text: "x" }, turn("heartbeat"))).ok).toBe(false);
    expect(store.notesOf.get(id)).toBeUndefined();
  });

  it("shows the history framed where it comes from untrusted content", async () => {
    const { registry, id } = await started();
    await registry.execute("mission_note", { id, text: "Drei Mails raus." }, turn());
    await registry.execute("mission_note", { id, text: "Antwort von A." }, turn("untrusted", { taintSources: ["Alex' Posteingang"], toolNames: MAIL_TRIGGER_TOOLS }));
    const owner = turn();
    const shown = await registry.execute("mission_show", { id }, owner);
    expect(shown.text).toContain("Goal: " + GOAL);
    expect(shown.text).toMatch(/: Drei Mails raus\./);
    expect(shown.text).toMatch(/source="note, derived from: Alex' Posteingang">\nAntwort von A\./);
    expect(owner.tainted).toBe(true);
  });
});

describe("wake", () => {
  async function started() {
    const s = setup();
    await s.registry.execute("mission_start", { title: "DSGVO-Anfragen", goal: GOAL, in_minutes: 60 }, turn());
    return { ...s, id: s.store.missions[0]!.id };
  }

  it("reads goal and history, inherits the notes' taint and sets the fallback check in three days", async () => {
    const { book, registry, pending, schedules, id } = await started();
    await registry.execute("mission_note", { id, text: "Antwort von A." }, turn("untrusted", { taintSources: ["Alex' Posteingang"], toolNames: MAIL_TRIGGER_TOOLS }));
    const [row] = pending();
    await schedules.claim(row!.id);
    const wake = await book.wake(row!);
    expect(wake?.incoming).toContain('Mission "DSGVO-Anfragen"');
    expect(wake?.incoming).toContain(GOAL);
    expect(wake?.incoming).toContain(`source="your note, derived from: Alex' Posteingang"`);
    expect(wake?.taintSources).toEqual(["Alex' Posteingang"]);
    expect(wake?.recallQuery).toContain("DSGVO-Anfragen");
    // The running wake stays, next to it exactly one new one.
    expect(pending().map((entry) => entry.nextRunAt)).toEqual(["2026-10-16T10:00:00.000Z"]);
  });

  it("a closed mission wakes nobody", async () => {
    const { book, registry, pending, id } = await started();
    const [row] = pending();
    expect((await registry.execute("mission_close", { id, status: "done", outcome: "Alle drei haben geantwortet." }, turn())).ok).toBe(true);
    expect(pending()).toEqual([]);
    expect(await book.wake(row!)).toBeNull();
  });

  it("at most four times a day; after that tomorrow at 9", async () => {
    const { book, pending, schedules, id } = await started();
    for (let n = 0; n < 4; n += 1) {
      const [row] = pending();
      await schedules.claim(row!.id);
      expect(await book.wake(row!)).not.toBeNull();
    }
    const [row] = pending();
    await schedules.claim(row!.id);
    expect(await book.wake(row!)).toBeNull();
    expect(pending().map((entry) => entry.nextRunAt)).toEqual(["2026-10-14T07:00:00.000Z"]);
    expect(audits.some((entry) => entry.event === "mission_wake_capped" && entry.detail["mission"] === id)).toBe(true);
  });

  it("if loading failed at startup, the wake asks the store itself", async () => {
    const s = setup();
    const mission = await s.store.create({ title: "Reklamation", goal: GOAL });
    const row = await s.schedules.insert({ mode: "mission", text: mission.id, repeat: null, nextRunAt: NOW.toISOString(), sourceMessageId: "", taintSources: [] });
    expect((await s.book.wake(row))?.incoming).toContain("Reklamation");
    expect(s.book.find(mission.id)).toBeDefined();
  });

  it("a mission without a check gets one at startup", async () => {
    const s = setup();
    const mission = await s.store.create({ title: "Kündigung", goal: GOAL });
    await s.book.load();
    expect(s.pending().map((row) => [row.text, row.nextRunAt])).toEqual([[mission.id, "2026-10-16T10:00:00.000Z"]]);
    expect(s.book.contextLines()).toEqual([
      `- ${mission.id}: Kündigung (since ${formatWallDay(new Date(mission.createdAt))}, next check ${formatWallTime(new Date("2026-10-16T10:00:00.000Z"))})`,
    ]);
  });
});

describe("closing and forgetting", () => {
  it("only Alex or an approval closes, never a mail and never the wake that reads notes from mails", async () => {
    const { registry, store } = setup();
    await registry.execute("mission_start", { title: "DSGVO-Anfragen", goal: GOAL }, turn());
    const id = store.missions[0]!.id;
    const mailTurn = turn("untrusted", { taintSources: ["Alex' Posteingang"], toolNames: [...MAIL_TRIGGER_TOOLS, "mission_close"] });
    expect((await registry.execute("mission_close", { id, status: "done", outcome: "Erledigt, sagt die Mail." }, mailTurn)).ok).toBe(false);
    const wakeTurn = turn("schedule", { taintSources: ["Alex' Posteingang"] });
    expect((await registry.execute("mission_close", { id, status: "done", outcome: "Alles erledigt, steht in der Notiz." }, wakeTurn)).ok).toBe(false);
    expect(store.missions[0]?.status).toBe("active");
    expect((await registry.execute("mission_close", { id, status: "done", outcome: "Alle haben geantwortet." }, turn())).ok).toBe(true);
    expect(store.missions[0]?.status).toBe("done");
  });

  it("forgetting hard-deletes, and only on Alex' instruction", async () => {
    const { registry, store, pending } = setup();
    await registry.execute("mission_start", { title: "DSGVO-Anfragen", goal: GOAL }, turn());
    const id = store.missions[0]!.id;
    expect((await registry.execute("mission_forget", { id }, turn("schedule"))).ok).toBe(false);
    expect((await registry.execute("mission_forget", { id }, turn())).ok).toBe(true);
    expect(store.missions).toEqual([]);
    expect(pending()).toEqual([]);
  });
});

describe("in the <context>", () => {
  it("open missions stand as their own block", () => {
    const context = turnContext(NOW, "", [], [], [], ["- id: DSGVO-Anfragen (since Tue 13 Oct, next check Thu 12 Nov, 11:00)"]);
    expect(context).toContain("<missions>\n- id: DSGVO-Anfragen");
    expect(turnContext(NOW)).not.toContain("<missions>");
  });

  it("the wake text is built by code and unambiguous without notes", () => {
    const text = renderWake({ id: "m", title: "T", goal: GOAL, status: "active", outcome: null, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() }, [], NOW);
    expect(text).toContain("No notes yet.");
    expect(text).toContain("mission_note");
  });
});
