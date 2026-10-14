import { db } from "./client.js";
import { columns, pgRows } from "./pg.js";
import type { MissedReminder, MissedReminderStore } from "../scheduler/missed.js";
import type { NewSchedule, ScheduleRow, ScheduleStore } from "../scheduler/store.js";
import { formatAnchor, parseAnchor, wallAnchor, type Repeat } from "../time.js";

/**
 * `schedules` from 0001_core.sql. Kind, repetition and origin live in
 * `payload`; for repetitions `cron_expr` carries the keyword because the table
 * requires it for `kind = 'cron'`. Nothing is computed from it: the next wall
 * time comes from `src/time.ts`.
 */

const COLUMNS = "id, prompt, payload, next_run_at, attempts, created_at";

interface DbRow {
  id: string;
  prompt: string;
  payload: {
    mode?: string;
    repeat?: string | null;
    taint_sources?: string[];
    /** Until 2026-10-10: time of the first run (ISO, UTC). */
    anchor?: string;
    /** Since 2026-10-10: the intended wall time (`formatAnchor`). */
    anchor_wall?: string;
    due?: string;
  };
  next_run_at: string;
  attempts: number;
  created_at: string;
}

function toRow(row: DbRow): ScheduleRow {
  return {
    id: row.id,
    mode: row.payload.mode === "task" || row.payload.mode === "mission" ? row.payload.mode : "reminder",
    text: row.prompt,
    repeat: (row.payload.repeat as Repeat | null | undefined) ?? null,
    nextRunAt: row.next_run_at,
    // New entries carry the intended wall time, older ones the time of the first run, the oldest nothing.
    anchor:
      (typeof row.payload.anchor_wall === "string" ? parseAnchor(row.payload.anchor_wall) : null) ??
      wallAnchor(new Date(typeof row.payload.anchor === "string" ? row.payload.anchor : row.next_run_at)),
    // `payload.due` only applies while a run has failed attempts: `complete` resets
    // `attempts` and leaves the old value in place instead of reading the row first.
    dueAt: row.attempts > 0 && typeof row.payload.due === "string" ? row.payload.due : row.next_run_at,
    attempts: row.attempts,
    createdAt: row.created_at,
    // Entries from before 2026-10-02 lack the field; they come from turns whose
    // taint is recorded nowhere and count as clean, as before.
    taintSources: Array.isArray(row.payload.taint_sources) ? row.payload.taint_sources : [],
  };
}

export const scheduleStore: ScheduleStore = {
  async insert(row: NewSchedule) {
    const { data, error } = await db
      .from("schedules")
      .insert({
        kind: row.repeat ? "cron" : "once",
        cron_expr: row.repeat,
        next_run_at: row.nextRunAt,
        prompt: row.text,
        payload: {
          mode: row.mode,
          repeat: row.repeat,
          anchor_wall: formatAnchor(row.anchor),
          source_message_id: row.sourceMessageId,
          taint_sources: [...row.taintSources],
        },
      })
      .select(COLUMNS)
      .single();
    if (error) throw new Error(`Schedule not created: ${error.message}`);
    return toRow(data as DbRow);
  },

  async active() {
    const { data, error } = await db
      .from("schedules")
      .select(COLUMNS)
      .in("status", ["pending", "running"])
      .order("next_run_at", { ascending: true });
    if (error) throw new Error(`Schedules not readable: ${error.message}`);
    return ((data ?? []) as DbRow[]).map(toRow);
  },

  async countActive() {
    const { count, error } = await db
      .from("schedules")
      .select("id", { count: "exact", head: true })
      .in("status", ["pending", "running"]);
    if (error) throw new Error(`Schedules not countable: ${error.message}`);
    return count ?? 0;
  },

  async due(now, limit) {
    // Every scheduler round, hence via Postgres (`pg.ts`).
    return (
      await pgRows<DbRow>(
        "Due schedules not readable",
        (sql) => sql`
          select ${columns(sql, COLUMNS)} from public.schedules
          where status = 'pending' and next_run_at <= ${now}
          order by next_run_at asc limit ${limit}`,
      )
    ).map(toRow);
  },

  async claim(id, now) {
    const { data, error } = await db
      .from("schedules")
      .update({ status: "running", last_run_at: now, updated_at: now })
      .eq("id", id)
      .eq("status", "pending")
      .select("id");
    if (error) throw new Error(`Schedule not claimable: ${error.message}`);
    return (data ?? []).length === 1;
  },

  async complete(id, nextRunAt) {
    const now = new Date().toISOString();
    const { error } = await db
      .from("schedules")
      .update(
        nextRunAt
          ? { status: "pending", next_run_at: nextRunAt, attempts: 0, last_error: null, updated_at: now }
          : { status: "done", last_error: null, updated_at: now },
      )
      .eq("id", id)
      .eq("status", "running");
    if (error) throw new Error(`Schedule not completed: ${error.message}`);
  },

  async fail(id, reason, retry) {
    const { data, error: readError } = await db
      .from("schedules")
      .select("attempts, payload")
      .eq("id", id)
      .single();
    if (readError) throw new Error(`Schedule not readable: ${readError.message}`);
    const { error } = await db
      .from("schedules")
      .update({
        status: retry ? "pending" : "failed",
        attempts: Number(data.attempts) + 1,
        last_error: reason.slice(0, 500),
        // The next attempt is later, the due time stays (without a migration, like `anchor_wall`).
        ...(retry ? { next_run_at: retry.at, payload: { ...(data.payload as DbRow["payload"]), due: retry.dueAt } } : {}),
        updated_at: new Date().toISOString(),
      })
      .eq("id", id);
    if (error) throw new Error(`Failure not recorded: ${error.message}`);
  },

  async cancel(id) {
    const { data, error } = await db
      .from("schedules")
      .update({ status: "cancelled", updated_at: new Date().toISOString() })
      .eq("id", id)
      .in("status", ["pending", "running"])
      .select("id");
    if (error) throw new Error(`Schedule not cancelled: ${error.message}`);
    return (data ?? []).length === 1;
  },

  async running() {
    const { data, error } = await db.from("schedules").select(COLUMNS).eq("status", "running");
    if (error) throw new Error(`Stuck schedules not readable: ${error.message}`);
    return ((data ?? []) as DbRow[]).map(toRow);
  },

  async release(id) {
    const { error } = await db
      .from("schedules")
      .update({ status: "pending", updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("status", "running");
    if (error) throw new Error(`Stuck schedule not reset: ${error.message}`);
  },
};

/** Reminders that failed for good, until they are delivered late (`src/scheduler/missed.ts`). */
const MISSED_KEY = "missed_reminders";

function missedEntry(raw: unknown): MissedReminder | null {
  const entry = (raw ?? {}) as Record<string, unknown>;
  const text = (key: string) => (typeof entry[key] === "string" ? (entry[key] as string) : null);
  const scheduleId = text("scheduleId");
  const body = text("text");
  const dueAt = text("dueAt");
  const failedAt = text("failedAt");
  if (!scheduleId || !body || !dueAt || !failedAt) return null;
  const sources = entry["taintSources"];
  return {
    scheduleId,
    text: body,
    dueAt,
    failedAt,
    triedAt: text("triedAt"),
    taintSources: Array.isArray(sources) ? sources.filter((source): source is string => typeof source === "string") : [],
  };
}

export const missedReminderStore: MissedReminderStore = {
  async load() {
    const { data, error } = await db.from("agent_state").select("value").eq("key", MISSED_KEY).maybeSingle();
    if (error) throw new Error(`Missed reminders not readable: ${error.message}`);
    const entries = (data?.value as { entries?: unknown } | undefined)?.entries;
    return Array.isArray(entries) ? entries.map(missedEntry).filter((entry): entry is MissedReminder => entry !== null) : [];
  },

  async save(entries) {
    const { error } = await db.from("agent_state").upsert({ key: MISSED_KEY, value: { entries }, updated_at: new Date().toISOString() });
    if (error) throw new Error(`Missed reminders not saved: ${error.message}`);
  },
};
