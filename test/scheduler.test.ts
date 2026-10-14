import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeMissedReminderStore, FakeScheduleStore } from "./schedule-store.fake.js";
import type { ScheduleRow } from "../src/scheduler/store.js";

const auditMock = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock("../src/db/audit.js", () => ({ audit: (...args: unknown[]) => auditMock(...args) }));

const { Scheduler } = await import("../src/scheduler/poller.js");
const { MissedReminders, reminderText } = await import("../src/scheduler/missed.js");
const { scheduleTools } = await import("../src/agent/tools/schedule.js");
const { overviewTools } = await import("../src/agent/tools/overview.js");
const { ToolRegistry } = await import("../src/agent/tools/registry.js");
const { TurnState } = await import("../src/agent/tools/types.js");
const { SCHEDULE_RETRY_DELAYS_MS, SCHEDULER_BATCH } = await import("../src/config/limits.js");
const { installTranslations } = await import("../src/i18n/catalog.js");
const { core } = await import("../src/i18n/messages/core.js");
const { formatWallTime } = await import("../src/time.js");

/**
 * Scheduler (D9). The acceptance question is "did the reminder come?": on
 * time, exactly once, also after a restart, and never while the kill switch is
 * active.
 */

const NOW = new Date("2026-09-19T10:00:00Z"); // 12:00 in Berlin

function rig(opts: { paused?: boolean; failing?: boolean } = {}) {
  const store = new FakeScheduleStore();
  const clock = { now: NOW };
  const delivered: Array<{ row: ScheduleRow; lateNote: string | null }> = [];
  const state = { paused: opts.paused ?? false, failing: opts.failing ?? false };
  // The channel as the OutboundGate sees it: when something last went through, and what was delivered late.
  const channel = {
    lastDelivered: null as number | null,
    outcome: "sent" as "sent" | "duplicate" | "failed",
    resent: [] as Array<{ text: string; taintSources: string[] }>,
  };
  const missedStore = new FakeMissedReminderStore();
  const missed = new MissedReminders({
    store: missedStore,
    lastDelivered: () => channel.lastDelivered,
    send: async (text, entry) => {
      if (channel.outcome !== "failed") {
        channel.resent.push({ text, taintSources: entry.taintSources });
        channel.lastDelivered = clock.now.getTime();
      }
      return channel.outcome;
    },
    now: () => clock.now,
  });
  const scheduler = new Scheduler({
    store,
    now: () => clock.now,
    paused: async () => state.paused,
    async deliver(row, lateNote) {
      if (state.failing) throw new Error("channel gone");
      delivered.push({ row, lateNote });
      channel.lastDelivered = clock.now.getTime();
    },
    missed,
  });
  const registry = new ToolRegistry()
    .registerAll(scheduleTools({ store, now: () => clock.now }))
    .registerAll(
      overviewTools({
        schedules: store,
        watchers: { active: async () => [] } as never,
        tasks: () => [],
        paused: async () => false,
        now: () => clock.now,
      }),
    );
  /** Sets the clock to the next attempt of the first entry and runs one round. */
  const tickAtNext = async () => {
    clock.now = new Date(store.rows[0]!.nextRunAt);
    await scheduler.tick();
  };
  return { store, clock, delivered, state, scheduler, registry, channel, missedStore, tickAtNext };
}

function turn(origin: "owner_message" | "schedule" = "owner_message", taintSources: string[] = []) {
  return new TurnState({
    origin,
    triggerExternalId: "m-1",
    triggerMessageId: "db-1",
    reactableIds: [],
    taintSources,
  });
}

const minutes = (count: number) => new Date(NOW.getTime() + count * 60_000);

beforeEach(() => auditMock.mockClear());

describe("Poller", () => {
  it("delivers only when the time is due, and then exactly once", async () => {
    const { store, clock, delivered, scheduler } = rig();
    await store.insert({ mode: "reminder", text: "Müll raus", repeat: null, nextRunAt: minutes(2).toISOString(), sourceMessageId: "db-1", taintSources: [] });
    await scheduler.tick();
    expect(delivered).toHaveLength(0);
    clock.now = minutes(2);
    await scheduler.tick();
    await scheduler.tick();
    expect(delivered.map((entry) => entry.row.text)).toEqual(["Müll raus"]);
    expect(store.rows[0]?.status).toBe("done");
  });

  it("holds still while the kill switch is active, and catches up afterwards", async () => {
    const { store, clock, delivered, state, scheduler } = rig({ paused: true });
    await store.insert({ mode: "reminder", text: "x", repeat: null, nextRunAt: NOW.toISOString(), sourceMessageId: "", taintSources: [] });
    await scheduler.tick();
    expect(delivered).toHaveLength(0);
    expect(store.rows[0]?.status).toBe("pending");
    state.paused = false;
    clock.now = minutes(30);
    await scheduler.tick();
    expect(delivered[0]?.lateNote).toMatch(/12:00/);
  });

  it("says nothing about lateness when there was none worth mentioning", async () => {
    const { store, clock, delivered, scheduler } = rig();
    await store.insert({ mode: "reminder", text: "x", repeat: null, nextRunAt: NOW.toISOString(), sourceMessageId: "", taintSources: [] });
    clock.now = minutes(1);
    await scheduler.tick();
    expect(delivered[0]?.lateNote).toBeNull();
  });

  it("moves a repetition to the next wall time instead of ending it", async () => {
    const { store, delivered, scheduler } = rig();
    await store.insert({ mode: "reminder", text: "Tabletten", repeat: "daily", nextRunAt: NOW.toISOString(), sourceMessageId: "", taintSources: [] });
    await scheduler.tick();
    expect(delivered).toHaveLength(1);
    expect(store.rows[0]).toMatchObject({ status: "pending", nextRunAt: "2026-09-20T10:00:00.000Z" });
  });

  it("retries after 1, 5, 15 and 60 minutes and only then gives up", async () => {
    const { store, scheduler, clock, tickAtNext } = rig({ failing: true });
    await store.insert({ mode: "reminder", text: "x", repeat: null, nextRunAt: NOW.toISOString(), sourceMessageId: "", taintSources: [] });
    await scheduler.tick();
    const retries: number[] = [];
    while (store.rows[0]?.status === "pending") {
      retries.push(Date.parse(store.rows[0].nextRunAt) - clock.now.getTime());
      // Nothing happens before the time.
      clock.now = new Date(Date.parse(store.rows[0].nextRunAt) - 1_000);
      await scheduler.tick();
      expect(store.rows[0]?.attempts).toBe(retries.length);
      await tickAtNext();
    }
    expect(retries).toEqual(SCHEDULE_RETRY_DELAYS_MS);
    expect(store.rows[0]).toMatchObject({ status: "failed", attempts: SCHEDULE_RETRY_DELAYS_MS.length + 1, dueAt: NOW.toISOString() });
    expect(auditMock).toHaveBeenCalledWith("schedule_failed", expect.objectContaining({ final: false, retry_at: minutes(1).toISOString() }));
    expect(auditMock).toHaveBeenCalledWith("schedule_failed", expect.objectContaining({ final: true, reason: "channel gone" }));
  });

  it("after a failed attempt computes lateness and bracket from the due time, not from the attempt", async () => {
    const { store, state, delivered, scheduler, tickAtNext } = rig({ failing: true });
    await store.insert({ mode: "reminder", text: "x", repeat: null, nextRunAt: NOW.toISOString(), sourceMessageId: "", taintSources: [] });
    await scheduler.tick();
    await tickAtNext(); // +1 min
    state.failing = false;
    await tickAtNext(); // +6 min: no bracket yet
    expect(delivered[0]?.lateNote).toBeNull();
    expect(auditMock).toHaveBeenCalledWith("schedule_fired", expect.objectContaining({ late_ms: 6 * 60_000, attempt: 3 }));

    // Three failed attempts: at the fourth (+21 min) it is late enough for the bracket, with the due time.
    const late = rig({ failing: true });
    await late.store.insert({ mode: "reminder", text: "y", repeat: null, nextRunAt: NOW.toISOString(), sourceMessageId: "", taintSources: [] });
    await late.scheduler.tick();
    await late.tickAtNext();
    await late.tickAtNext();
    late.state.failing = false;
    await late.tickAtNext();
    expect(late.clock.now.getTime() - NOW.getTime()).toBe(21 * 60_000);
    expect(late.delivered[0]?.lateNote).toMatch(/12:00/);
    expect(late.store.rows[0]?.status).toBe("done");
  });

  it("works off a backlog in small rounds", async () => {
    const { store, delivered, scheduler } = rig();
    for (let i = 0; i < SCHEDULER_BATCH + 2; i += 1) {
      await store.insert({ mode: "reminder", text: `r${i}`, repeat: null, nextRunAt: NOW.toISOString(), sourceMessageId: "", taintSources: [] });
    }
    await scheduler.tick();
    expect(delivered).toHaveLength(SCHEDULER_BATCH);
  });

  it("resumes after a crash what was stuck in the middle of a run", async () => {
    const { store, delivered, scheduler } = rig();
    await store.insert({ mode: "reminder", text: "x", repeat: null, nextRunAt: NOW.toISOString(), sourceMessageId: "", taintSources: [] });
    await store.claim(store.rows[0]!.id);
    vi.useFakeTimers();
    await scheduler.start();
    await scheduler.tick();
    await scheduler.stop();
    vi.useRealTimers();
    expect(delivered).toHaveLength(1);
    expect(auditMock).toHaveBeenCalledWith("schedule_recovered", { count: 1 });
  });
});

describe("settling after delivery (D15, addendum 2026-10-10)", () => {
  it("does not deliver a task again when only settling fails, and does not book it as failed", async () => {
    const { store, clock, delivered, scheduler } = rig();
    await store.insert({ mode: "task", text: "Wetter checken", repeat: null, nextRunAt: NOW.toISOString(), sourceMessageId: "", taintSources: [] });
    store.failComplete = 1;
    await scheduler.tick();
    expect(delivered).toHaveLength(1);
    expect(auditMock).toHaveBeenCalledWith("schedule_fired", expect.objectContaining({ mode: "task" }));
    expect(auditMock).toHaveBeenCalledWith("schedule_settle_failed", expect.objectContaining({ schedule_id: store.rows[0]!.id }));
    // It stays `running`, so no query returns it again.
    expect(store.rows[0]).toMatchObject({ status: "running", attempts: 0 });

    clock.now = minutes(1);
    await scheduler.tick();
    expect(delivered).toHaveLength(1);
    expect(store.rows[0]).toMatchObject({ status: "done", attempts: 0 });
    expect(auditMock).toHaveBeenCalledWith("schedule_settled", { schedule_id: store.rows[0]!.id, after_ms: 60_000 });
    expect(auditMock).not.toHaveBeenCalledWith("schedule_failed", expect.anything());
  });

  it("keeps trying to settle as long as the database is gone, also with the kill switch pulled, and continues a repetition from the due time", async () => {
    const { store, clock, delivered, state, scheduler } = rig();
    await store.insert({ mode: "task", text: "Wetter checken", repeat: "daily", nextRunAt: NOW.toISOString(), sourceMessageId: "", taintSources: [] });
    store.failComplete = 10;
    await scheduler.tick();
    state.paused = true;
    for (let i = 1; i <= 10; i += 1) {
      clock.now = minutes(i);
      await scheduler.tick();
    }
    expect(delivered).toHaveLength(1);
    expect(store.rows[0]).toMatchObject({ status: "pending", nextRunAt: "2026-09-20T10:00:00.000Z", attempts: 0 });
    expect(auditMock.mock.calls.filter(([event]) => event === "schedule_settle_failed")).toHaveLength(1);
  });

  it("does not bring back a cancelled schedule when settling late", async () => {
    const { store, clock, scheduler } = rig();
    await store.insert({ mode: "task", text: "Wetter checken", repeat: "daily", nextRunAt: NOW.toISOString(), sourceMessageId: "", taintSources: [] });
    store.failComplete = 1;
    await scheduler.tick();
    expect(await store.cancel(store.rows[0]!.id)).toBe(true);
    clock.now = minutes(1);
    await scheduler.tick();
    expect(store.rows[0]?.status).toBe("cancelled");
  });

  it("after a restart does not run a task again that was already handed over, but does deliver a reminder", async () => {
    const { store, clock, delivered, scheduler } = rig();
    await store.insert({ mode: "task", text: "Wetter checken", repeat: null, nextRunAt: NOW.toISOString(), sourceMessageId: "", taintSources: [] });
    await store.insert({ mode: "task", text: "Kontostand", repeat: "daily", nextRunAt: NOW.toISOString(), sourceMessageId: "", taintSources: [] });
    await store.insert({ mode: "reminder", text: "Müll raus", repeat: null, nextRunAt: NOW.toISOString(), sourceMessageId: "", taintSources: [] });
    for (const row of store.rows) await store.claim(row.id);

    // Restart a day later: the daily one moves on to the next run, not the missed one.
    clock.now = new Date("2026-09-20T10:30:00Z");
    const restarted = rig();
    restarted.store.rows = store.rows;
    restarted.clock.now = clock.now;
    vi.useFakeTimers();
    await restarted.scheduler.start();
    await restarted.scheduler.tick();
    await restarted.scheduler.stop();
    vi.useRealTimers();
    expect(delivered).toHaveLength(0);
    expect(restarted.delivered.map((entry) => entry.row.text)).toEqual(["Müll raus"]);
    expect(store.rows.map((row) => row.status)).toEqual(["done", "pending", "done"]);
    expect(store.rows[1]?.nextRunAt).toBe("2026-09-21T10:00:00.000Z");
    expect(auditMock).toHaveBeenCalledWith("schedule_recovered", { count: 3, tasks_not_repeated: 2 });
  });
});

describe("repetitions after failed attempts", () => {
  it("does not let a repetition die on a bad day and does not shift its next run", async () => {
    const { store, scheduler, tickAtNext } = rig({ failing: true });
    await store.insert({ mode: "reminder", text: "x", repeat: "daily", nextRunAt: NOW.toISOString(), sourceMessageId: "", taintSources: [] });
    await scheduler.tick();
    for (let i = 0; i < SCHEDULE_RETRY_DELAYS_MS.length; i += 1) await tickAtNext();
    expect(store.rows[0]).toMatchObject({ status: "pending", nextRunAt: "2026-09-20T10:00:00.000Z", attempts: 0 });
    expect(auditMock).toHaveBeenCalledWith("schedule_failed", expect.objectContaining({ final: true, next_run_at: "2026-09-20T10:00:00.000Z" }));
  });

  it("computes the next run from the due time after a late success", async () => {
    const { store, state, scheduler, tickAtNext } = rig({ failing: true });
    await store.insert({ mode: "reminder", text: "x", repeat: "daily", nextRunAt: NOW.toISOString(), sourceMessageId: "", taintSources: [] });
    await scheduler.tick();
    await tickAtNext();
    state.failing = false;
    await tickAtNext(); // 12:06
    expect(store.rows[0]).toMatchObject({ status: "pending", nextRunAt: "2026-09-20T10:00:00.000Z", dueAt: "2026-09-20T10:00:00.000Z" });
  });

  it("never lets a late attempt run into the next run", async () => {
    // The kill switch held the daily reminder from 12:00 until 11:40 the next day.
    const { store, clock, scheduler, tickAtNext } = rig({ failing: true });
    await store.insert({ mode: "reminder", text: "x", repeat: "daily", nextRunAt: NOW.toISOString(), sourceMessageId: "", taintSources: [] });
    clock.now = new Date("2026-09-20T09:40:00Z");
    await scheduler.tick(); // 11:40, next attempt 11:41
    await tickAtNext(); // 11:41, next 11:46
    await tickAtNext(); // 11:46, the next would be 12:01, after the regular run at 12:00
    expect(store.rows[0]).toMatchObject({ status: "pending", nextRunAt: "2026-09-20T10:00:00.000Z", attempts: 0 });
  });
});

describe("reminders left behind (D15, addendum 2026-10-10)", () => {
  async function abandoned(r: ReturnType<typeof rig>, text = "Zahnarzt anrufen", taintSources: string[] = []) {
    await r.store.insert({ mode: "reminder", text, repeat: null, nextRunAt: r.clock.now.toISOString(), sourceMessageId: "", taintSources });
    const row = r.store.rows.at(-1)!;
    await r.scheduler.tick();
    while (row.status === "pending") {
      r.clock.now = new Date(row.nextRunAt);
      await r.scheduler.tick();
    }
    return row;
  }

  it("notes a reminder that failed for good and delivers it after the next success, with bracket and origin", async () => {
    const r = rig({ failing: true });
    const row = await abandoned(r, "Zahnarzt anrufen", ["https://praxis.example"]);
    expect(row.status).toBe("failed");
    expect(r.missedStore.entries).toEqual([
      expect.objectContaining({ scheduleId: row.id, text: "Zahnarzt anrufen", dueAt: NOW.toISOString(), taintSources: ["https://praxis.example"], triedAt: null }),
    ]);
    expect(auditMock).toHaveBeenCalledWith("schedule_missed", expect.objectContaining({ schedule_id: row.id, reason: "channel gone" }));

    // No success at the channel yet: nothing.
    r.clock.now = minutes(120);
    await r.scheduler.tick();
    expect(r.channel.resent).toHaveLength(0);

    // Something else gets through to the owner (a reply, a hit): it follows after that.
    r.channel.lastDelivered = r.clock.now.getTime();
    await r.scheduler.tick();
    expect(r.channel.resent).toEqual([{ text: "Zahnarzt anrufen\n(sollte um 12 kommen)", taintSources: ["https://praxis.example"] }]);
    expect(r.missedStore.entries).toEqual([]);
    expect(auditMock).toHaveBeenCalledWith("schedule_missed_delivered", { schedule_id: row.id, late_ms: 120 * 60_000 });

    // And only once.
    r.channel.lastDelivered = r.clock.now.getTime() + 1;
    await r.scheduler.tick();
    expect(r.channel.resent).toHaveLength(1);
  });

  it("does not take a success from before the failure as a sign that the channel works again", async () => {
    const r = rig({ failing: true });
    r.channel.lastDelivered = NOW.getTime() - 60_000;
    await abandoned(r);
    await r.scheduler.tick();
    expect(r.channel.resent).toHaveLength(0);
    expect(r.missedStore.entries).toHaveLength(1);
  });

  it("after a failed late delivery waits for the next success and counts a duplicate as delivered", async () => {
    const r = rig({ failing: true });
    await abandoned(r);
    r.channel.outcome = "failed";
    r.channel.lastDelivered = r.clock.now.getTime() + 1;
    r.clock.now = new Date(r.clock.now.getTime() + 60_000);
    await r.scheduler.tick();
    expect(r.missedStore.entries[0]?.triedAt).toBe(r.clock.now.toISOString());
    expect(auditMock).toHaveBeenCalledWith("schedule_missed_retry_failed", expect.any(Object));
    // The same old success does not trigger a second attempt.
    r.channel.outcome = "sent";
    await r.scheduler.tick();
    expect(r.channel.resent).toHaveLength(0);
    // A new one does; according to the duplicate block the owner has just received it.
    r.channel.outcome = "duplicate";
    r.channel.lastDelivered = r.clock.now.getTime() + 1;
    await r.scheduler.tick();
    expect(r.missedStore.entries).toEqual([]);
    expect(auditMock).toHaveBeenCalledWith("schedule_missed_delivered", expect.objectContaining({ duplicate: true }));
  });

  it("names the time in the bracket, the day only when it was not today (addendum D23 of 2026-10-10)", () => {
    const eight = new Date("2026-10-09T06:00:00Z"); // Fri, 08:00 Berlin
    expect(reminderText("müll raus", null, eight)).toBe("müll raus");
    expect(reminderText("müll raus", eight, new Date("2026-10-09T07:10:00Z"))).toBe("müll raus\n(sollte um 8 kommen)");
    expect(reminderText("müll raus", new Date("2026-10-09T06:30:00Z"), new Date("2026-10-09T07:10:00Z"))).toBe("müll raus\n(sollte um 8:30 kommen)");
    expect(reminderText("müll raus", eight, new Date("2026-10-10T07:10:00Z"))).toBe("müll raus\n(sollte gestern um 8 kommen)");
    expect(reminderText("müll raus", eight, new Date("2026-10-12T07:10:00Z"))).toBe("müll raus\n(sollte fr., 09.10. um 8 kommen)");
  });

  it("writes the bracket in English with the English clock and date", () => {
    const eight = new Date("2026-10-09T06:00:00Z"); // Fri, 08:00 Berlin
    expect(reminderText("take out the trash", eight, new Date("2026-10-09T07:10:00Z"), "en")).toBe("take out the trash\n(was due at 8\u202fAM)");
    expect(reminderText("take out the trash", new Date("2026-10-09T06:30:00Z"), new Date("2026-10-09T07:10:00Z"), "en")).toBe(
      "take out the trash\n(was due at 8:30\u202fAM)",
    );
    expect(reminderText("take out the trash", eight, new Date("2026-10-10T07:10:00Z"), "en")).toBe("take out the trash\n(was due yesterday at 8\u202fAM)");
    expect(reminderText("take out the trash", eight, new Date("2026-10-12T07:10:00Z"), "en")).toBe("take out the trash\n(was due fri, 10/09 at 8\u202fAM)");
  });

  it("writes the bracket in a translated language and keeps the reminder text verbatim", () => {
    expect(
      installTranslations("tr", {
        [core.reminderLateToday.en]: "(saat {time} gelmesi gerekiyordu)",
        [core.reminderLateYesterday.en]: "(dün saat {time} gelmesi gerekiyordu)",
        [core.reminderLateDay.en]: "({day} saat {time} gelmesi gerekiyordu)",
      }),
    ).toEqual([]);
    const eight = new Date("2026-10-09T06:00:00Z"); // Fri, 08:00 Berlin
    expect(reminderText("müll raus", eight, new Date("2026-10-09T07:10:00Z"), "tr")).toBe("müll raus\n(saat 8 gelmesi gerekiyordu)");
    expect(reminderText("müll raus", eight, new Date("2026-10-10T07:10:00Z"), "tr")).toBe("müll raus\n(dün saat 8 gelmesi gerekiyordu)");
    expect(reminderText("müll raus", eight, new Date("2026-10-12T07:10:00Z"), "tr")).toBe("müll raus\n(09/10 cum saat 8 gelmesi gerekiyordu)");
  });

  it("delivers nothing late with the kill switch pulled", async () => {
    const r = rig({ failing: true });
    await abandoned(r);
    r.state.paused = true;
    r.channel.lastDelivered = r.clock.now.getTime() + 1;
    await r.scheduler.tick();
    expect(r.channel.resent).toHaveLength(0);
    r.state.paused = false;
    await r.scheduler.tick();
    expect(r.channel.resent).toHaveLength(1);
  });

  it("delivers at most three per round late, oldest first, the rest in the next", async () => {
    const r = rig({ failing: true });
    for (const text of ["eins", "zwei", "drei", "vier"]) {
      await abandoned(r, text);
      r.clock.now = new Date(r.clock.now.getTime() + 60_000);
    }
    expect(r.missedStore.entries).toHaveLength(4);
    r.channel.lastDelivered = r.clock.now.getTime();
    await r.scheduler.tick();
    expect(r.channel.resent.map((entry) => entry.text.split("\n")[0])).toEqual(["eins", "zwei", "drei"]);
    await r.scheduler.tick();
    expect(r.channel.resent.map((entry) => entry.text.split("\n")[0])).toEqual(["eins", "zwei", "drei", "vier"]);
  });

  it("notes no repetitions and no tasks: those keep running or the heartbeat has them", async () => {
    const r = rig({ failing: true });
    await r.store.insert({ mode: "task", text: "Kurs prüfen", repeat: null, nextRunAt: NOW.toISOString(), sourceMessageId: "", taintSources: [] });
    await r.store.insert({ mode: "reminder", text: "Tabletten", repeat: "daily", nextRunAt: NOW.toISOString(), sourceMessageId: "", taintSources: [] });
    await r.scheduler.tick();
    // Both fail in the same beat until the task gives up and the repetition jumps to tomorrow.
    while (r.store.rows[0]?.status === "pending") {
      r.clock.now = new Date(r.store.rows[0].nextRunAt);
      await r.scheduler.tick();
    }
    expect(r.store.rows[0]?.status).toBe("failed");
    expect(r.store.rows[1]).toMatchObject({ status: "pending", nextRunAt: "2026-09-20T10:00:00.000Z" });
    expect(r.missedStore.entries).toEqual([]);
  });

  it("does not give up a reminder that cannot be noted: it stays with the scheduler", async () => {
    const r = rig({ failing: true });
    r.missedStore.failSave = true;
    const row = await (async () => {
      await r.store.insert({ mode: "reminder", text: "x", repeat: null, nextRunAt: NOW.toISOString(), sourceMessageId: "", taintSources: [] });
      const inserted = r.store.rows[0]!;
      await r.scheduler.tick();
      for (let i = 0; i < SCHEDULE_RETRY_DELAYS_MS.length; i += 1) await r.tickAtNext();
      return inserted;
    })();
    expect(row.status).toBe("pending");
    expect(Date.parse(row.nextRunAt) - r.clock.now.getTime()).toBe(SCHEDULE_RETRY_DELAYS_MS.at(-1));
    expect(auditMock).toHaveBeenCalledWith("schedule_failed", expect.objectContaining({ final: false, unsaved: "database gone" }));
    // When the channel works again, it comes at the next attempt as usual, with the bracket.
    r.state.failing = false;
    await r.tickAtNext();
    expect(row.status).toBe("done");
    expect(r.delivered[0]?.lateNote).toMatch(/12:00/);
  });
});

describe("Tools", () => {
  it("converts local wall time to UTC itself and names it in the result", async () => {
    const { registry, store } = rig();
    const result = await registry.execute("set_reminder", { text: "Anna anrufen", at: "2026-09-20 09:00" }, turn());
    expect(result.ok).toBe(true);
    // The model's form, "Sun 20 Sep(t), 09:00", from an instant given independently as UTC.
    expect(result.text.startsWith(`Set for ${formatWallTime(new Date("2026-09-20T07:00:00Z"))}. ID `)).toBe(true);
    expect(result.text).toMatch(/^Set for Sun 20 Sept?, 09:00\. ID /);
    expect(store.rows[0]).toMatchObject({ mode: "reminder", nextRunAt: "2026-09-20T07:00:00.000Z" });
  });

  it("tells for Alex's reminder that ⏰ is the receipt, not for planned tasks (addendum D23 of 2026-10-08)", async () => {
    const { registry } = rig();
    const reminder = await registry.execute("set_reminder", { text: "Anna anrufen", at: "2026-09-20 09:00" }, turn());
    expect(reminder.text).toContain("\nAcknowledge with react scheduled on Alex's message. If you chose the time or day yourself, also write a short sentence with your choice.");
    const fromSchedule = await registry.execute("set_reminder", { text: "Pizza", in_minutes: 2 }, turn("schedule"));
    expect(fromSchedule.text).not.toContain("scheduled");
    const task = await registry.execute("schedule_task", { task: "Prüf den Kurs und sag Bescheid", in_minutes: 60 }, turn());
    expect(task.text).not.toContain("scheduled");
  });

  it("does not put a self-chosen time in the middle of an event and names only the busy span to the model", async () => {
    const store = new FakeScheduleStore();
    const asked: Date[] = [];
    // Sun 2026-09-20, 14:00 to 15:30 Berlin time busy.
    const span = { start: new Date("2026-09-20T12:00:00Z"), end: new Date("2026-09-20T13:30:00Z") };
    const registry = new ToolRegistry().registerAll(
      scheduleTools({
        store,
        now: () => NOW,
        busyAt: (at) => {
          asked.push(at);
          return at >= span.start && at < span.end ? span : null;
        },
      }),
    );
    const inMeeting = await registry.execute("set_reminder", { text: "Anna anrufen", at: "2026-09-20 14:30", own_time: true }, turn());
    expect(inMeeting.ok).toBe(false);
    expect(inMeeting.text).toMatch(/^Not created: Sun 20 Sept?, 14:30 falls in an event, Alex is busy Sun 20 Sept?, 14:00 to 15:30\. /);
    expect(store.rows).toHaveLength(0);

    // The better time after it goes through.
    const after = await registry.execute("set_reminder", { text: "Anna anrufen", at: "2026-09-20 15:30", own_time: true }, turn());
    expect(after.ok).toBe(true);
    // If Alex named the time, it holds, even during the event, and nothing is asked at all.
    const named = await registry.execute("set_reminder", { text: "Anna anrufen", at: "2026-09-20 14:30" }, turn());
    expect(named.ok).toBe(true);
    // A planned task is not a reminder to the owner.
    const task = await registry.execute("schedule_task", { task: "Kurs prüfen", at: "2026-09-20 14:30" }, turn());
    expect(task.ok).toBe(true);
    expect(asked.map((at) => at.toISOString())).toEqual(["2026-09-20T12:30:00.000Z", "2026-09-20T13:30:00.000Z"]);
    expect(store.rows).toHaveLength(3);
  });

  it("lets everything through when the snapshot knows nothing", async () => {
    const store = new FakeScheduleStore();
    const registry = new ToolRegistry().registerAll(scheduleTools({ store, now: () => NOW, busyAt: () => null }));
    const result = await registry.execute("set_reminder", { text: "Anna anrufen", at: "2026-09-20 14:30", own_time: true }, turn());
    expect(result.ok).toBe(true);
  });

  it("knows yearly repetitions and names them in the overview", async () => {
    const { registry, store } = rig();
    const result = await registry.execute("set_reminder", { text: "Mia hat Geburtstag", at: "2027-02-28 09:00", repeat: "yearly" }, turn());
    expect(result.ok).toBe(true);
    expect(store.rows[0]?.repeat).toBe("yearly");
    const overview = await registry.execute("overview", {}, turn());
    expect(overview.text).toContain("yearly on February 28 at 09:00");
  });

  it("knows relative times", async () => {
    const { registry, store } = rig();
    await registry.execute("set_reminder", { text: "Pizza", in_minutes: 2 }, turn());
    expect(store.rows[0]?.nextRunAt).toBe(minutes(2).toISOString());
  });

  it("rejects what is past, unreadable or ambiguous", async () => {
    const { registry, store } = rig();
    for (const args of [
      { text: "x", at: "2026-09-19 11:00" },
      { text: "x", at: "morgen um 9" },
      { text: "x", at: "2026-09-20T09:00:00+02:00" },
      { text: "x", at: "2026-09-20 09:00", in_minutes: 5 },
      { text: "x" },
    ]) {
      expect((await registry.execute("set_reminder", args, turn())).ok).toBe(false);
    }
    expect(store.rows).toHaveLength(0);
  });

  it("plans tasks only on Alex's direct request, never after untrusted content (D8.4)", async () => {
    const { registry, store } = rig();
    const args = { task: "Prüf den Kurs und sag Bescheid", in_minutes: 60 };
    expect((await registry.execute("schedule_task", args, turn("schedule"))).ok).toBe(false);
    expect((await registry.execute("schedule_task", args, turn("owner_message", ["https://evil.example"]))).ok).toBe(false);
    expect(store.rows).toHaveLength(0);
    expect((await registry.execute("schedule_task", args, turn())).ok).toBe(true);
    expect(store.rows[0]?.mode).toBe("task");
  });

  it("allows a reminder even after untrusted content: the text only goes to Alex", async () => {
    const { registry } = rig();
    const result = await registry.execute(
      "set_reminder",
      { text: "Zug fährt 14:32", in_minutes: 30 },
      turn("owner_message", ["https://bahn.example"]),
    );
    expect(result.ok).toBe(true);
  });

  it("lists and cancels", async () => {
    const { registry, store } = rig();
    await registry.execute("set_reminder", { text: "Pizza", in_minutes: 2 }, turn());
    const id = store.rows[0]!.id;
    expect((await registry.execute("overview", {}, turn())).text).toContain('"Pizza"');
    expect((await registry.execute("cancel_schedule", { id }, turn())).ok).toBe(true);
    expect((await registry.execute("cancel_schedule", { id }, turn())).ok).toBe(false);
    expect((await registry.execute("overview", {}, turn())).text).toMatch(/^No reminders, tasks or watchers\./);
  });
});
