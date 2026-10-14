import { db } from "./client.js";
import { columns, pgRows } from "./pg.js";
import {
  EMPTY_WATCH_POLLER_STATE,
  watchStateSchema,
  type WatchKind,
  type WatcherPatch,
  type WatcherRow,
  type WatcherStore,
  type WatchPollerStateStore,
  type WatchStatus,
} from "../watch/types.js";

/**
 * `watchers` from 0013_watchers.sql (D43). `spec` is not interpreted here, only
 * passed through; it is checked in the poller and in the tool against the
 * kind's Zod schema. `state` is checked on read: a state that does not fit
 * counts as empty instead of stopping the poller.
 */

const COLUMNS = "id, kind, label, spec, state, status, next_check_at, last_checked_at, failures, expires_at, created_at";

interface DbRow {
  id: string;
  kind: string;
  label: string;
  spec: unknown;
  state: unknown;
  status: string;
  next_check_at: string;
  last_checked_at: string | null;
  failures: number;
  expires_at: string;
  created_at: string;
}

function toRow(row: DbRow): WatcherRow {
  const state = watchStateSchema.safeParse(row.state ?? {});
  return {
    id: row.id,
    // The table keeps `kind` within the three kinds via a check constraint.
    kind: row.kind as WatchKind,
    label: row.label,
    spec: row.spec,
    state: state.success ? state.data : {},
    status: row.status as WatchStatus,
    nextCheckAt: row.next_check_at,
    lastCheckedAt: row.last_checked_at,
    failures: Number(row.failures),
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

function toColumns(patch: WatcherPatch): Record<string, unknown> {
  return {
    ...(patch.state === undefined ? {} : { state: patch.state }),
    ...(patch.status === undefined ? {} : { status: patch.status }),
    ...(patch.nextCheckAt === undefined ? {} : { next_check_at: patch.nextCheckAt }),
    ...(patch.lastCheckedAt === undefined ? {} : { last_checked_at: patch.lastCheckedAt }),
    ...(patch.failures === undefined ? {} : { failures: patch.failures }),
    updated_at: new Date().toISOString(),
  };
}

export const watcherStore: WatcherStore = {
  async insert(row) {
    const { data, error } = await db
      .from("watchers")
      .insert({
        kind: row.kind,
        label: row.label,
        spec: row.spec,
        state: row.state,
        next_check_at: row.nextCheckAt,
        expires_at: row.expiresAt,
        // An empty string is not an ID (foreign key to `messages`).
        source_message_id: row.sourceMessageId || null,
      })
      .select(COLUMNS)
      .single();
    if (error) throw new Error(`Watcher not created: ${error.message}`);
    return toRow(data as DbRow);
  },

  async active() {
    const { data, error } = await db
      .from("watchers")
      .select(COLUMNS)
      .eq("status", "active")
      .order("next_check_at", { ascending: true });
    if (error) throw new Error(`Watchers not readable: ${error.message}`);
    return ((data ?? []) as DbRow[]).map(toRow);
  },

  async countActive() {
    const { count, error } = await db
      .from("watchers")
      .select("id", { count: "exact", head: true })
      .eq("status", "active");
    if (error) throw new Error(`Watchers not countable: ${error.message}`);
    return count ?? 0;
  },

  async due(now, limit) {
    // Every scheduler round, hence via Postgres (`pg.ts`).
    return (
      await pgRows<DbRow>(
        "Due watchers not readable",
        (sql) => sql`
          select ${columns(sql, COLUMNS)} from public.watchers
          where status = 'active' and next_check_at <= ${now}
          order by next_check_at asc limit ${limit}`,
      )
    ).map(toRow);
  },

  async claim(id, expected, leaseUntil) {
    const { data, error } = await db
      .from("watchers")
      .update({ next_check_at: leaseUntil, updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("status", "active")
      .eq("next_check_at", expected)
      .select("id");
    if (error) throw new Error(`Watcher not claimable: ${error.message}`);
    return (data ?? []).length === 1;
  },

  async update(id, patch) {
    const { data, error } = await db
      .from("watchers")
      .update(toColumns(patch))
      .eq("id", id)
      .eq("status", "active")
      .select("id");
    if (error) throw new Error(`Watcher not saved: ${error.message}`);
    return (data ?? []).length === 1;
  },

  async cancel(id) {
    const { data, error } = await db
      .from("watchers")
      .update({ status: "cancelled", updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("status", "active")
      .select("id");
    if (error) throw new Error(`Watcher not cancelled: ${error.message}`);
    return (data ?? []).length === 1;
  },
};

/** Daily cap of hit turns, in `agent_state` like the heartbeat's state. */
const STATE_KEY = "watch_poller";

export const watchPollerState: WatchPollerStateStore = {
  async load() {
    const { data, error } = await db.from("agent_state").select("value").eq("key", STATE_KEY).maybeSingle();
    if (error) throw new Error(`Watcher state not readable: ${error.message}`);
    const value = (data?.value ?? {}) as { hitDay?: unknown; hitCount?: unknown };
    return {
      hitDay: typeof value.hitDay === "string" ? value.hitDay : EMPTY_WATCH_POLLER_STATE.hitDay,
      hitCount: typeof value.hitCount === "number" ? value.hitCount : EMPTY_WATCH_POLLER_STATE.hitCount,
    };
  },

  async save(state) {
    const { error } = await db.from("agent_state").upsert({ key: STATE_KEY, value: state, updated_at: new Date().toISOString() });
    if (error) throw new Error(`Watcher state not saved: ${error.message}`);
  },
};
