import type { Repeat, WallAnchor } from "../time.js";

/**
 * Scheduled items (D9). Two kinds, and the difference is intentional:
 *
 * - `reminder`: a finished text that goes out at the time. No model, no
 *   cost, nothing that can go wrong except the channel. "Did the reminder come?"
 *   should never hang on a rate limit.
 * - `task`: a job Serain carries out with the model at the time. The turn
 *   has the origin `schedule` and therefore no owner-only tools (D8.4).
 * - `mission`: the next look at a mission (D63, building block B); `text` is
 *   its ID. The turn has the same rights as with `task`; goal and history
 *   come from `missions`.
 */
export type ScheduleMode = "reminder" | "task" | "mission";

export interface ScheduleRow {
  id: string;
  mode: ScheduleMode;
  /** For `reminder` the text to the owner, for `task` the job for the model, for `mission` the mission's ID. */
  text: string;
  repeat: Repeat | null;
  nextRunAt: string;
  /**
   * The intended wall time of the first run. Repetitions take the time of day,
   * seconds and day of month from here, not from the previous run (`nextOccurrence`).
   * Entries from before 2026-10-10 carry the instant of the first run
   * (`payload.anchor`), those from before 2026-10-08 nothing; then its wall
   * time applies, or that of `nextRunAt`.
   */
  anchor: WallAnchor;
  /**
   * The due time of this run. Equal to `nextRunAt`, unless a failed attempt pushed
   * the next attempt back: lateness, the "(was meant for …)" note and the
   * next repetition count from here, never from the attempt.
   */
  dueAt: string;
  attempts: number;
  createdAt: string;
  /**
   * Untrusted content the creating turn had seen (D8.4). A reminder may also be
   * created after research (D15); its text is then derived from it and goes
   * out with this provenance.
   */
  taintSources: string[];
}

export interface NewSchedule {
  mode: ScheduleMode;
  text: string;
  repeat: Repeat | null;
  nextRunAt: string;
  /** What the owner meant; for a time in the skipped hour, earlier than `nextRunAt`. */
  anchor: WallAnchor;
  sourceMessageId: string;
  taintSources: readonly string[];
}

export interface ScheduleStore {
  insert(row: NewSchedule): Promise<ScheduleRow>;
  /** Upcoming entries, next first. */
  active(): Promise<ScheduleRow[]>;
  countActive(): Promise<number>;
  due(now: string, limit: number): Promise<ScheduleRow[]>;
  /** Atomically `pending` → `running`. False if someone else was faster. */
  claim(id: string, now: string): Promise<boolean>;
  /**
   * Done: one-off entries end, repeating ones get the next instant. Only from
   * `running`: an entry the owner cancelled while the completion hung stays cancelled.
   */
  complete(id: string, nextRunAt: string | null): Promise<void>;
  /**
   * Failed: with `retry` back to `pending`, next attempt at `retry.at`,
   * the due time stays `retry.dueAt`; without it, finally `failed`.
   */
  fail(id: string, error: string, retry: { at: string; dueAt: string } | null): Promise<void>;
  cancel(id: string): Promise<boolean>;
  /** What hangs on `running` at start (crash or not completed). */
  running(): Promise<ScheduleRow[]>;
  /** `running` → `pending`: due again, at the previous time. */
  release(id: string): Promise<void>;
}
