import {
  SCHEDULE_LATE_NOTE_MS,
  SCHEDULE_RETRY_DELAYS_MS,
  SCHEDULER_BATCH,
  SCHEDULER_POLL_MS,
} from "../config/limits.js";
import { audit } from "../db/audit.js";
import { log } from "../log.js";
import { formatWallTime, nextOccurrence } from "../time.js";
import type { MissedReminders } from "./missed.js";
import type { ScheduleRow, ScheduleStore } from "./store.js";

/**
 * The 30 s poller over `schedules` (D9, D10). It knows nothing of the model and
 * nothing of the channel: what happens to a due entry is decided by the
 * caller via `deliver`. Here are only the tick, claiming, repetition and
 * failed attempts.
 *
 * A failed attempt means: `deliver` threw. What fails after that is
 * bookkeeping and never delivers again (`settle`).
 *
 * A failed attempt pushes the next attempt back (1, 5, 15, 60 min), the
 * due time stays (`dueAt`): lateness, the bracket note and repetition count from
 * it. A one-off reminder that even the last attempt does not deliver
 * goes to `missed` and follows after the channel's next success.
 */

export interface SchedulerDeps {
  store: ScheduleStore;
  /** True if nothing may run right now (kill switch, D8.2). */
  paused(): Promise<boolean>;
  /** Delivers a due entry. Throws if it did not work. */
  deliver(row: ScheduleRow, lateNote: string | null): Promise<void>;
  /** Runs along on every tick, e.g. the expiry of open confirmations. */
  housekeeping?(): Promise<void>;
  /** Finally failed reminders, until they are delivered late. Without it: they just stay `failed`. */
  missed?: Pick<MissedReminders, "record" | "flush">;
  now?: () => Date;
}

export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  /** Delivered but not yet completed, with the next run and since when (`settle`). */
  private readonly unsettled = new Map<string, { next: Date | null; since: Date }>();
  private readonly now: () => Date;

  constructor(private readonly deps: SchedulerDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async start(): Promise<void> {
    // The process died in the middle of a run, or the completion did not get through
    // before the restart. A reminder is due again: better twice than not at
    // all, and if it did go out, the OutboundGate's duplicate block catches the
    // second. A task is not: between claiming and handing over to the queue
    // there is no `await`, whatever hangs on `running` was handed over. Whether its turn ran,
    // nobody knows; it is never silently repeated (D52), it counts as done.
    const hanging = await this.deps.store.running();
    const now = this.now();
    let tasks = 0;
    for (const row of hanging) {
      if (row.mode === "reminder") {
        await this.deps.store.release(row.id);
        continue;
      }
      tasks += 1;
      await this.settle(row, this.nextRun(row, now), now);
    }
    if (hanging.length > 0) {
      await audit("schedule_recovered", { count: hanging.length, ...(tasks > 0 ? { tasks_not_repeated: tasks } : {}) });
    }
    this.timer = setInterval(() => void this.tick(), SCHEDULER_POLL_MS);
    this.timer.unref();
    void this.tick();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running;
  }

  /** One round. Never overlaps with itself. */
  tick(): Promise<void> {
    this.running ??= this.round()
      .catch((error: unknown) => log.error("Scheduler round failed:", error))
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }

  private async round(): Promise<void> {
    // Completing is bookkeeping, not an effect: it runs even with the kill switch pulled.
    await this.settleBacklog();
    await this.deps.housekeeping?.();
    // Stopped means stopped: due entries stay put and run after the release.
    if (await this.deps.paused()) return;

    const now = this.now();
    const due = await this.deps.store.due(now.toISOString(), SCHEDULER_BATCH);
    for (const row of due) {
      // Never too early: what the query returns, the poller checks once more
      // against its own clock before claiming it.
      if (Date.parse(row.nextRunAt) > now.getTime()) {
        await audit("schedule_early_skipped", { schedule_id: row.id, early_ms: Date.parse(row.nextRunAt) - now.getTime() });
        continue;
      }
      if (!(await this.deps.store.claim(row.id, now.toISOString()))) continue;
      await this.runOne(row, now);
    }
    // After the due ones: if a reminder got through this round, leftovers follow right after.
    await this.deps.missed?.flush();
  }

  private async runOne(row: ScheduleRow, now: Date): Promise<void> {
    const dueAt = new Date(row.dueAt);
    const lateMs = now.getTime() - dueAt.getTime();
    const lateNote = lateMs > SCHEDULE_LATE_NOTE_MS ? formatWallTime(dueAt) : null;
    const next = this.nextRun(row, now);
    try {
      await this.deps.deliver(row, lateNote);
    } catch (error) {
      await this.failed(row, now, next, (error as Error).message);
      return;
    }
    await audit("schedule_fired", {
      schedule_id: row.id,
      mode: row.mode,
      // Deviation from the due time when the reminder was out (for a task: when it
      // was in the queue). Signed: negative would mean too early and must never happen.
      late_ms: this.now().getTime() - dueAt.getTime(),
      next_run_at: next?.toISOString() ?? null,
      ...(row.attempts > 0 ? { attempt: row.attempts + 1 } : {}),
    });
    await this.settle(row, next, now);
  }

  /** The next repetition counts from the due time, never from the attempt: a late attempt shifts nothing. */
  private nextRun(row: ScheduleRow, now: Date): Date | null {
    return row.repeat ? nextOccurrence(new Date(row.dueAt), row.repeat, now, row.anchor) : null;
  }

  /**
   * Completes a delivered run. If that fails, it is not a failed delivery
   * attempt: the entry stays `running`, no query returns it
   * again, and every round only retries the completion.
   */
  private async settle(row: ScheduleRow, next: Date | null, since: Date): Promise<void> {
    try {
      await this.deps.store.complete(row.id, next?.toISOString() ?? null);
    } catch (error) {
      this.unsettled.set(row.id, { next, since });
      await audit("schedule_settle_failed", { schedule_id: row.id, mode: row.mode, reason: (error as Error).message });
      log.error(`Schedule ${row.id} delivered but not completed; retrying in the next round:`, error);
    }
  }

  private async settleBacklog(): Promise<void> {
    for (const [id, { next, since }] of this.unsettled) {
      try {
        await this.deps.store.complete(id, next?.toISOString() ?? null);
      } catch {
        // Database still gone; it was already reported the first time.
        continue;
      }
      this.unsettled.delete(id);
      await audit("schedule_settled", { schedule_id: id, after_ms: this.now().getTime() - since.getTime() });
    }
  }

  /**
   * A failed attempt. The next attempt comes after `SCHEDULE_RETRY_DELAYS_MS`.
   * A repetition does not die of a bad day: if the time until
   * its next run is no longer enough for an attempt, this one is skipped, and
   * the next is due at its time. A one-off reminder goes to `missed` after the
   * last attempt.
   */
  private async failed(row: ScheduleRow, now: Date, next: Date | null, reason: string): Promise<void> {
    const delay = SCHEDULE_RETRY_DELAYS_MS[row.attempts];
    const retryAt = delay === undefined ? null : new Date(now.getTime() + delay);
    if (retryAt && (!next || retryAt < next)) {
      await this.deps.store.fail(row.id, reason, { at: retryAt.toISOString(), dueAt: row.dueAt });
      await audit("schedule_failed", { schedule_id: row.id, mode: row.mode, reason, final: false, retry_at: retryAt.toISOString() });
      log.error(`Schedule ${row.id} failed, next attempt ${retryAt.toISOString()}:`, reason);
      return;
    }
    if (next) {
      await this.deps.store.complete(row.id, next.toISOString());
      await audit("schedule_failed", { schedule_id: row.id, mode: row.mode, reason, final: true, next_run_at: next.toISOString() });
      log.error(`Schedule ${row.id} skipped this time, next run ${next.toISOString()}:`, reason);
      return;
    }
    if (row.mode === "reminder" && this.deps.missed) {
      try {
        await this.deps.missed.record(row, reason);
      } catch (error) {
        // Not recorded does not mean giving up: then it stays with the scheduler and keeps trying hourly.
        const at = new Date(now.getTime() + (SCHEDULE_RETRY_DELAYS_MS.at(-1) ?? SCHEDULER_POLL_MS)).toISOString();
        await this.deps.store.fail(row.id, reason, { at, dueAt: row.dueAt });
        await audit("schedule_failed", { schedule_id: row.id, mode: row.mode, reason, final: false, retry_at: at, unsaved: (error as Error).message });
        log.error(`Reminder ${row.id} not recorded, stays with the scheduler:`, error);
        return;
      }
    }
    await this.deps.store.fail(row.id, reason, null);
    await audit("schedule_failed", { schedule_id: row.id, mode: row.mode, reason, final: true });
    log.error(`Schedule ${row.id} failed for good:`, reason);
  }
}
