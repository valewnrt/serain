import type { MissedReminder, MissedReminderStore } from "../src/scheduler/missed.js";
import type { NewSchedule, ScheduleRow, ScheduleStore } from "../src/scheduler/store.js";
import { wallAnchor, type WallAnchor } from "../src/time.js";

type Status = "pending" | "running" | "done" | "failed" | "cancelled";

/** `agent_state.missed_reminders` in memory. */
export class FakeMissedReminderStore implements MissedReminderStore {
  entries: MissedReminder[] = [];
  failSave = false;

  async load(): Promise<MissedReminder[]> {
    return structuredClone(this.entries);
  }

  async save(entries: MissedReminder[]): Promise<void> {
    if (this.failSave) throw new Error("database gone");
    this.entries = structuredClone(entries);
  }
}

/** `schedules` in memory. */
export class FakeScheduleStore implements ScheduleStore {
  rows: Array<ScheduleRow & { status: Status; lastError: string | null }> = [];
  /** This many of the next `complete` calls fail (database briefly gone). */
  failComplete = 0;
  private seq = 0;

  /** Without `anchor`, like an entry that carries none: then the wall time of `nextRunAt` applies (`src/db/schedules.ts`). */
  async insert(row: Omit<NewSchedule, "anchor"> & { anchor?: WallAnchor }): Promise<ScheduleRow> {
    const stored = {
      id: `00000000-0000-4000-8000-${String(++this.seq).padStart(12, "0")}`,
      mode: row.mode,
      text: row.text,
      repeat: row.repeat,
      nextRunAt: row.nextRunAt,
      anchor: row.anchor ? { ...row.anchor } : wallAnchor(new Date(row.nextRunAt)),
      dueAt: row.nextRunAt,
      attempts: 0,
      createdAt: "2026-09-19T08:00:00.000Z",
      taintSources: [...row.taintSources],
      status: "pending" as Status,
      lastError: null,
    };
    this.rows.push(stored);
    return { ...stored };
  }

  private open() {
    return this.rows.filter((row) => row.status === "pending" || row.status === "running");
  }

  async active(): Promise<ScheduleRow[]> {
    return this.open().sort((a, b) => a.nextRunAt.localeCompare(b.nextRunAt));
  }

  async countActive(): Promise<number> {
    return this.open().length;
  }

  async due(now: string, limit: number): Promise<ScheduleRow[]> {
    return this.rows
      .filter((row) => row.status === "pending" && row.nextRunAt <= now)
      .sort((a, b) => a.nextRunAt.localeCompare(b.nextRunAt))
      .slice(0, limit)
      .map((row) => ({ ...row }));
  }

  async claim(id: string): Promise<boolean> {
    const row = this.rows.find((entry) => entry.id === id);
    if (!row || row.status !== "pending") return false;
    row.status = "running";
    return true;
  }

  async complete(id: string, nextRunAt: string | null): Promise<void> {
    if (this.failComplete > 0) {
      this.failComplete -= 1;
      throw new Error("Schedule not completed: database gone");
    }
    const row = this.rows.find((entry) => entry.id === id);
    if (!row || row.status !== "running") return;
    if (nextRunAt) {
      row.status = "pending";
      row.nextRunAt = nextRunAt;
      row.dueAt = nextRunAt;
      row.attempts = 0;
    } else {
      row.status = "done";
    }
  }

  async fail(id: string, error: string, retry: { at: string; dueAt: string } | null): Promise<void> {
    const row = this.rows.find((entry) => entry.id === id);
    if (!row) return;
    row.attempts += 1;
    row.lastError = error;
    row.status = retry ? "pending" : "failed";
    if (retry) {
      row.nextRunAt = retry.at;
      row.dueAt = retry.dueAt;
    }
  }

  async cancel(id: string): Promise<boolean> {
    const row = this.open().find((entry) => entry.id === id);
    if (!row) return false;
    row.status = "cancelled";
    return true;
  }

  async running(): Promise<ScheduleRow[]> {
    return this.rows.filter((row) => row.status === "running").map((row) => ({ ...row }));
  }

  async release(id: string): Promise<void> {
    const row = this.rows.find((entry) => entry.id === id);
    if (row?.status === "running") row.status = "pending";
  }
}
