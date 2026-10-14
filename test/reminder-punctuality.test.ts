import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeScheduleStore } from "./schedule-store.fake.js";
import { FUZZ_SEED, params } from "./fuzz/helpers.js";
import type { ScheduleRow } from "../src/scheduler/store.js";

const auditMock = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock("../src/db/audit.js", () => ({ audit: (...args: unknown[]) => auditMock(...args) }));

const { Scheduler } = await import("../src/scheduler/poller.js");
const { scheduleTools } = await import("../src/agent/tools/schedule.js");
const { ToolRegistry } = await import("../src/agent/tools/registry.js");
const { TurnState } = await import("../src/agent/tools/types.js");
const { SCHEDULER_POLL_MS } = await import("../src/config/limits.js");
const { nextOccurrence, toWallTime } = await import("../src/time.js");

/**
 * Reminders never come early (reminders that arrive 19 to 52 s before their
 * time are a known failure of assistants). Played through from Alex's side:
 * the model creates them via the real tool, the real poller runs in its 30 s
 * beat on a clock the test moves forward, and what is measured is when the
 * reminder goes out. The due time is given here as UTC, independently of the
 * code, so that an error in the conversion does not confirm itself.
 *
 * Goal: 0 to +30 s, never earlier. Across both clock changes, with repetition
 * and with "in X minutes" at a time with seconds.
 */

interface Firing {
  id: string;
  text: string;
  at: number;
  lateNote: string | null;
}

function rig() {
  const store = new FakeScheduleStore();
  const fired: Firing[] = [];
  const scheduler = new Scheduler({
    store,
    paused: async () => false,
    async deliver(row: ScheduleRow, lateNote: string | null) {
      fired.push({ id: row.id, text: row.text, at: Date.now(), lateNote });
    },
  });
  const registry = new ToolRegistry().registerAll(scheduleTools({ store, now: () => new Date() }));
  const remind = async (text: string, when: { at?: string; in_minutes?: number; repeat?: string }) => {
    const turn = new TurnState({ origin: "owner_message", triggerExternalId: "m-1", triggerMessageId: "db-1", reactableIds: [] });
    const result = (await registry.execute("set_reminder", { text, ...when }, turn)) as { ok: boolean; text: string };
    expect(result.ok, result.text).toBe(true);
  };
  return { store, fired, scheduler, remind };
}

/** Runs the clock in the poller's beats until `until`. */
async function runUntil(until: string): Promise<void> {
  await vi.advanceTimersByTimeAsync(Date.parse(until) - Date.now());
}

function expectOnTime(fired: Firing[], text: string, intended: readonly string[]): void {
  const times = fired.filter((entry) => entry.text === text);
  expect(times.map((entry) => new Date(entry.at).toISOString()), text).toHaveLength(intended.length);
  times.forEach((entry, index) => {
    const deviation = entry.at - Date.parse(intended[index]!);
    expect(deviation, `${text} #${index + 1}: ${deviation} ms off ${intended[index]}`).toBeGreaterThanOrEqual(0);
    expect(deviation, `${text} #${index + 1}: ${deviation} ms off ${intended[index]}`).toBeLessThanOrEqual(SCHEDULER_POLL_MS);
    expect(entry.lateNote).toBeNull();
  });
}

/** Every `schedule_fired` in the audit carries the signed deviation, and none is negative. */
function auditedLateness(): number[] {
  return auditMock.mock.calls
    .filter(([event]) => event === "schedule_fired")
    .map(([, detail]) => (detail as { late_ms: number }).late_ms);
}

beforeEach(() => {
  auditMock.mockClear();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe("reminders never come early", () => {
  it("across the change to winter time: daily, weekdays, repeated hour, \"in 2 minutes\" with seconds", async () => {
    // Friday, 2026-10-23, 07:59:17.4 in Berlin (summer time, UTC+2).
    vi.setSystemTime(new Date("2026-10-23T05:59:17.400Z"));
    const { fired, scheduler, remind } = rig();
    await remind("Täglich um acht", { at: "2026-10-23 08:00", repeat: "daily" });
    await remind("Werktags um neun", { at: "2026-10-23 09:00", repeat: "weekdays" });
    await remind("In zwei Minuten und dann täglich", { in_minutes: 2, repeat: "daily" });
    await remind("In der doppelten Stunde", { at: "2026-10-25 02:30" });
    await remind("Kurz vor Mitternacht", { at: "2026-10-24 23:59" });
    await scheduler.start();
    await runUntil("2026-10-27T09:00:00Z");
    await scheduler.stop();

    // Change on Oct 25 at 03:00 summer time: UTC+1 from then on.
    expectOnTime(fired, "Täglich um acht", [
      "2026-10-23T06:00:00Z",
      "2026-10-24T06:00:00Z",
      "2026-10-25T07:00:00Z",
      "2026-10-26T07:00:00Z",
      "2026-10-27T07:00:00Z",
    ]);
    expectOnTime(fired, "Werktags um neun", ["2026-10-23T07:00:00Z", "2026-10-26T08:00:00Z", "2026-10-27T08:00:00Z"]);
    // 08:01:17.4 Berlin time, every day, also after the change: the seconds stay.
    expectOnTime(fired, "In zwei Minuten und dann täglich", [
      "2026-10-23T06:01:17.400Z",
      "2026-10-24T06:01:17.400Z",
      "2026-10-25T07:01:17.400Z",
      "2026-10-26T07:01:17.400Z",
      "2026-10-27T07:01:17.400Z",
    ]);
    // 02:30 exists twice; the first one counts, still in summer time.
    expectOnTime(fired, "In der doppelten Stunde", ["2026-10-25T00:30:00Z"]);
    expectOnTime(fired, "Kurz vor Mitternacht", ["2026-10-24T21:59:00Z"]);
    expect(auditedLateness().length).toBe(fired.length);
    expect(Math.min(...auditedLateness())).toBeGreaterThanOrEqual(0);
  });

  it("across the change to summer time: the skipped hour comes after, never before", async () => {
    vi.setSystemTime(new Date("2027-03-26T22:00:00Z"));
    const { fired, scheduler, remind } = rig();
    await remind("Täglich um halb drei", { at: "2027-03-27 02:30", repeat: "daily" });
    await remind("Monatlich am 31.", { at: "2027-03-31 09:00", repeat: "monthly" });
    await scheduler.start();
    await runUntil("2027-06-01T00:00:00Z");
    await scheduler.stop();

    const halfPastTwo = fired.filter((entry) => entry.text === "Täglich um halb drei");
    // Mar 27 winter time, on Mar 28 02:30 does not exist (03:30 summer time), from Mar 29 02:30 again.
    expectOnTime(halfPastTwo.slice(0, 3), "Täglich um halb drei", [
      "2027-03-27T01:30:00Z",
      "2027-03-28T01:30:00Z",
      "2027-03-29T00:30:00Z",
    ]);
    for (const entry of halfPastTwo.slice(3)) {
      const wall = toWallTime(new Date(entry.at));
      expect([wall.hour, wall.minute]).toEqual([2, 30]);
    }
    // Apr 31 does not exist: then the last day of the month, and in May the 31st again.
    expectOnTime(fired, "Monatlich am 31.", ["2027-03-31T07:00:00Z", "2027-04-30T07:00:00Z", "2027-05-31T07:00:00Z"]);
    expect(Math.min(...auditedLateness())).toBeGreaterThanOrEqual(0);
  }, 30_000);

  it("\"in X minutes\" never comes before the minutes are up, created at any second", async () => {
    // Fixed seed like the fuzzing (D53): reproducible, `FUZZ_SEED=… pnpm test` for other cases.
    const cases = fc.sample(
      fc.record({ offsetMs: fc.integer({ min: 0, max: 59_999 }), minutes: fc.integer({ min: 1, max: 180 }) }),
      { seed: FUZZ_SEED, numRuns: 40 },
    );
    vi.setSystemTime(new Date("2026-11-02T08:00:00Z"));
    const { fired, scheduler, remind } = rig();
    await scheduler.start();
    const intended: Array<{ text: string; at: number }> = [];
    // Created while the poller runs: one every minute, at an arbitrary millisecond.
    for (const [index, entry] of cases.entries()) {
      await runUntil(new Date(Date.parse("2026-11-02T08:00:00Z") + index * 60_000 + entry.offsetMs).toISOString());
      const text = `Case ${index}`;
      await remind(text, { in_minutes: entry.minutes });
      intended.push({ text, at: Date.now() + entry.minutes * 60_000 });
    }
    await runUntil("2026-11-02T12:00:00Z");
    await scheduler.stop();
    for (const entry of intended) expectOnTime(fired, entry.text, [new Date(entry.at).toISOString()]);
  });

  it("yearly: counted from the first run, across the clock change, Feb 29 on Feb 28 without a leap day", async () => {
    // A year in 30 s beats would be a million rounds. So the clock jumps to
    // shortly before each run (the poller's timers keep running as before),
    // then the poller runs three minutes in its real beat.
    vi.setSystemTime(new Date("2027-03-26T22:00:00Z"));
    const { fired, scheduler, remind } = rig();
    await remind("Jährlich um neun", { at: "2027-03-27 09:00", repeat: "yearly" });
    await remind("Geburtstag am Schalttag", { at: "2028-02-29 09:00", repeat: "yearly" });
    await scheduler.start();
    // Mar 27 is already in summer time in 2028 and 2029 (UTC+2), otherwise before it (UTC+1).
    const intended = [
      "2027-03-27T08:00:00Z",
      "2028-02-29T08:00:00Z",
      "2028-03-27T07:00:00Z",
      "2029-02-28T08:00:00Z",
      "2029-03-27T07:00:00Z",
      "2030-02-28T08:00:00Z",
      "2030-03-27T08:00:00Z",
      "2031-02-28T08:00:00Z",
      "2031-03-27T08:00:00Z",
      "2032-02-29T08:00:00Z",
      "2032-03-27T08:00:00Z",
    ];
    for (const at of intended) {
      vi.setSystemTime(new Date(Date.parse(at) - 90_000));
      await runUntil(new Date(Date.parse(at) + 90_000).toISOString());
    }
    await scheduler.stop();
    expectOnTime(fired, "Jährlich um neun", intended.filter((at) => at.slice(5, 10) === "03-27"));
    expectOnTime(fired, "Geburtstag am Schalttag", intended.filter((at) => at.slice(5, 10) !== "03-27"));
    expect(Math.min(...auditedLateness())).toBeGreaterThanOrEqual(0);
  });

  it("delivers nothing before its time, even if the query wrongly returns it", async () => {
    vi.setSystemTime(new Date("2026-11-02T08:00:00Z"));
    const { store, fired, scheduler, remind } = rig();
    await remind("Um zehn", { at: "2026-11-02 10:00" });
    // A broken query (time zone, comparison as text, the database's clock) returns everything pending.
    store.due = async () => store.rows.filter((row) => row.status === "pending").map((row) => ({ ...row }));
    await scheduler.start();
    await runUntil("2026-11-02T08:59:30Z");
    expect(fired).toHaveLength(0);
    expect(auditMock).toHaveBeenCalledWith("schedule_early_skipped", expect.objectContaining({ early_ms: expect.any(Number) }));
    await runUntil("2026-11-02T09:01:00Z");
    await scheduler.stop();
    expectOnTime(fired, "Um zehn", ["2026-11-02T09:00:00Z"]);
  });
});

/** Every calendar day from `from` to `to` (inclusive) at the same UTC time, optionally only certain weekdays. */
function everyDay(from: string, to: string, time: string, keep: (weekday: number) => boolean = () => true): string[] {
  const days: string[] = [];
  for (let at = Date.parse(`${from}T${time}Z`); at <= Date.parse(`${to}T${time}Z`); at += 86_400_000) {
    if (keep(new Date(at).getUTCDay())) days.push(new Date(at).toISOString());
  }
  return days;
}

const workday = (weekday: number) => weekday !== 0 && weekday !== 6;

describe("first run in the night of the clock change (D15, addendum 2026-10-10)", () => {
  // 02:30 wall time is meant. The first run exists like that only once (skipped:
  // 03:30 summer time; repeated: the first 02:30), the repetition stays 02:30.
  const REPEATS = ["daily", "weekdays", "weekly", "monthly"] as const;

  it("summer time: the first run falls on 03:30, all further ones come at 02:30 again", async () => {
    // Saturday, 2027-03-27, 23:00 winter time. Change on Sunday, Mar 28, at 02:00 (01:00 UTC).
    vi.setSystemTime(new Date("2027-03-27T22:00:00Z"));
    const { fired, scheduler, remind } = rig();
    for (const repeat of REPEATS) await remind(`Um halb drei, ${repeat}`, { at: "2027-03-28 02:30", repeat });
    await scheduler.start();
    await runUntil("2027-04-28T12:00:00Z");
    await scheduler.stop();

    // Mar 28 at 03:30 summer time (01:30 UTC), after that 02:30 summer time (00:30 UTC).
    const first = "2027-03-28T01:30:00.000Z";
    expectOnTime(fired, "Um halb drei, daily", [first, ...everyDay("2027-03-29", "2027-04-28", "00:30:00.000")]);
    expectOnTime(fired, "Um halb drei, weekdays", [first, ...everyDay("2027-03-29", "2027-04-28", "00:30:00.000", workday)]);
    expectOnTime(fired, "Um halb drei, weekly", [first, ...everyDay("2027-03-29", "2027-04-28", "00:30:00.000", (day) => day === 0)]);
    expectOnTime(fired, "Um halb drei, monthly", [first, "2027-04-28T00:30:00.000Z"]);
    expect(Math.min(...auditedLateness())).toBeGreaterThanOrEqual(0);
  }, 60_000);

  it("winter time: the first run is the first 02:30, all further ones 02:30 winter time", async () => {
    // Saturday, 2026-10-24, 23:00 summer time. Change on Sunday, Oct 25, at 03:00 (01:00 UTC).
    vi.setSystemTime(new Date("2026-10-24T21:00:00Z"));
    const { fired, scheduler, remind } = rig();
    for (const repeat of REPEATS) await remind(`Um halb drei, ${repeat}`, { at: "2026-10-25 02:30", repeat });
    await scheduler.start();
    await runUntil("2026-11-25T12:00:00Z");
    await scheduler.stop();

    // Oct 25 at 02:30 summer time (00:30 UTC), after that 02:30 winter time (01:30 UTC).
    const first = "2026-10-25T00:30:00.000Z";
    expectOnTime(fired, "Um halb drei, daily", [first, ...everyDay("2026-10-26", "2026-11-25", "01:30:00.000")]);
    expectOnTime(fired, "Um halb drei, weekdays", [first, ...everyDay("2026-10-26", "2026-11-25", "01:30:00.000", workday)]);
    expectOnTime(fired, "Um halb drei, weekly", [first, ...everyDay("2026-10-26", "2026-11-25", "01:30:00.000", (day) => day === 0)]);
    expectOnTime(fired, "Um halb drei, monthly", [first, "2026-11-25T01:30:00.000Z"]);
    expect(Math.min(...auditedLateness())).toBeGreaterThanOrEqual(0);
  }, 60_000);

  it("yearly: 02:30 stays 02:30, in every year by its offset, and falls on 03:30 again when the day is the change again", async () => {
    vi.setSystemTime(new Date("2026-10-24T21:00:00Z"));
    const { fired, scheduler, remind } = rig();
    await remind("Jährlich in der doppelten Stunde", { at: "2026-10-25 02:30", repeat: "yearly" });
    await remind("Jährlich in der übersprungenen Stunde", { at: "2027-03-28 02:30", repeat: "yearly" });
    await scheduler.start();
    // Oct 25 is before the change from 2027 to 2031 (summer time). Mar 28 is itself the
    // change in 2027 and 2032 (03:30 summer time), after it in 2028 and 2029, before it in 2030 and 2031.
    const autumn = [
      "2026-10-25T00:30:00.000Z",
      "2027-10-25T00:30:00.000Z",
      "2028-10-25T00:30:00.000Z",
      "2029-10-25T00:30:00.000Z",
      "2030-10-25T00:30:00.000Z",
      "2031-10-25T00:30:00.000Z",
    ];
    const spring = [
      "2027-03-28T01:30:00.000Z",
      "2028-03-28T00:30:00.000Z",
      "2029-03-28T00:30:00.000Z",
      "2030-03-28T01:30:00.000Z",
      "2031-03-28T01:30:00.000Z",
      "2032-03-28T01:30:00.000Z",
    ];
    // As above: the clock jumps to shortly before each run, then the poller runs three minutes in its real beat.
    for (const at of [...autumn, ...spring].sort()) {
      vi.setSystemTime(new Date(Date.parse(at) - 90_000));
      await runUntil(new Date(Date.parse(at) + 90_000).toISOString());
    }
    await scheduler.stop();
    expectOnTime(fired, "Jährlich in der doppelten Stunde", autumn);
    expectOnTime(fired, "Jährlich in der übersprungenen Stunde", spring);
    expect(Math.min(...auditedLateness())).toBeGreaterThanOrEqual(0);
  });
});

describe("failed attempts shift nothing (D15, addendum 2026-10-10)", () => {
  it("across the change to winter time: a bad day drops out, a late success does not shift the next run", async () => {
    vi.setSystemTime(new Date("2026-10-23T05:59:17.400Z"));
    const { store } = rig();
    // The channel does not work at all on Saturday, Oct 24, and on Sunday, Oct 25 (day of the change), only at the third attempt.
    const failures = new Map<string, number>([
      ["Täglich um acht 2026-10-24", Infinity],
      ["Täglich um acht 2026-10-25", 2],
      ["In der doppelten Stunde 2026-10-25", 1],
    ]);
    const fired: Firing[] = [];
    const scheduler = new Scheduler({
      store,
      paused: async () => false,
      async deliver(row: ScheduleRow, lateNote: string | null) {
        const key = `${row.text} ${new Date(Date.now()).toISOString().slice(0, 10)}`;
        const left = failures.get(key) ?? 0;
        if (left > 0) {
          failures.set(key, left - 1);
          throw new Error("channel gone");
        }
        fired.push({ id: row.id, text: row.text, at: Date.now(), lateNote });
      },
    });
    const registry = new ToolRegistry().registerAll(scheduleTools({ store, now: () => new Date() }));
    const turn = new TurnState({ origin: "owner_message", triggerExternalId: "m-1", triggerMessageId: "db-1", reactableIds: [] });
    for (const [text, when] of [
      ["Täglich um acht", { at: "2026-10-23 08:00", repeat: "daily" }],
      ["In der doppelten Stunde", { at: "2026-10-25 02:30" }],
    ] as const) {
      const result = (await registry.execute("set_reminder", { text, ...when }, turn)) as { ok: boolean; text: string };
      expect(result.ok, result.text).toBe(true);
    }
    await scheduler.start();
    await runUntil("2026-10-27T09:00:00Z");
    await scheduler.stop();

    // Oct 24 drops out; Oct 25 comes after two failed attempts (1 + 5 min) at 08:06 winter time; from Oct 26 at 08:00 again.
    const eight = (iso: string, retriedMs = 0) => Date.parse(iso) + retriedMs;
    expectOnTime(
      fired.filter((entry) => entry.text === "Täglich um acht"),
      "Täglich um acht",
      [eight("2026-10-23T06:00:00Z"), eight("2026-10-25T07:00:00Z", 6 * 60_000), eight("2026-10-26T07:00:00Z"), eight("2026-10-27T07:00:00Z")].map(
        (at) => new Date(at).toISOString(),
      ),
    );
    // The first 02:30, still summer time, one minute later: never before, and without a bracket.
    expectOnTime(fired, "In der doppelten Stunde", ["2026-10-25T00:31:00Z"]);
    expect(Math.min(...auditedLateness())).toBeGreaterThanOrEqual(0);
    expect(auditMock).toHaveBeenCalledWith("schedule_failed", expect.objectContaining({ final: true, next_run_at: "2026-10-25T07:00:00.000Z" }));
  });
});

describe("nextOccurrence", () => {
  it("is never before the same wall time including seconds on the next day", () => {
    fc.assert(
      fc.property(
        fc.date({ min: new Date("2026-01-01T00:00:00Z"), max: new Date("2030-12-31T00:00:00Z"), noInvalidDate: true }),
        fc.constantFrom("daily" as const, "weekdays" as const, "weekly" as const, "monthly" as const, "yearly" as const),
        (previous, repeat) => {
          const next = nextOccurrence(previous, repeat, previous);
          expect(next.getTime()).toBeGreaterThan(previous.getTime());
          expect(next.getUTCSeconds() * 1_000 + next.getUTCMilliseconds()).toBe(previous.getUTCSeconds() * 1_000 + previous.getUTCMilliseconds());
          const was = toWallTime(previous);
          const is = toWallTime(next);
          // Same wall time, unless the hour does not exist on that day (then one later).
          if (is.hour !== was.hour) expect(is.hour).toBe(was.hour + 1);
          expect(is.minute).toBe(was.minute);
        },
      ),
      params(200),
    );
  });
});
