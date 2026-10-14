import { db } from "../db/client.js";
import { pgRun } from "../db/pg.js";
import { log } from "../log.js";

/**
 * Heartbeat (W11, D10 "health check cron still pending"). One row per
 * component in `component_status`, kept current by upsert. `model` is purely
 * informative (shows "last ok"); only what should run all the time is
 * monitored: a quiet day without chat is no incident.
 */
export type ComponentName = "process" | "channel" | "db" | "model" | "delivery";
export type ComponentHealth = "ok" | "degraded" | "down";

/**
 * Components for which inactivity above the threshold counts as an incident.
 *
 * `delivery` (D44) is missing here on purpose. Only the running process knows
 * its state, and the heartbeat opens the incident right away when deliveries
 * fail. A stale `delivery` row would only mean that the process is stopped or
 * hangs, and `process`, `channel` and `db` report that already. With
 * `delivery` here the same outage would be a fourth incident.
 */
export const MONITORED_COMPONENTS: readonly ComponentName[] = ["process", "channel", "db"];

export interface ComponentStatusRow {
  component: ComponentName;
  status: ComponentHealth;
  last_ok_at: string | null;
  updated_at: string;
  detail: Record<string, unknown>;
}

/**
 * Pure decision, no DB access: is the last known good state too old?
 * `lastOkAt === null` (never reported) counts as stale.
 */
export function isStale(lastOkAt: string | null, now: Date, thresholdMs: number): boolean {
  if (!lastOkAt) return true;
  const last = new Date(lastOkAt).getTime();
  if (Number.isNaN(last)) return true;
  return now.getTime() - last > thresholdMs;
}

/**
 * Did the process say goodbye cleanly? `runtime.ts` sets the marker in the
 * `stop()` path, so on SIGTERM from a deploy or a `systemctl stop`. A crash
 * never gets here and leaves the last row at `ok`: that is exactly how the
 * watchdog tells the two apart.
 */
export function isPlannedStop(row: ComponentStatusRow | undefined): boolean {
  return row?.status === "down" && row.detail?.["planned"] === true;
}

export interface StaleIncidentInput {
  row: ComponentStatusRow | undefined;
  now: Date;
  thresholdMs: number;
  /** Uptime of `serain.service` in ms, `null` when it cannot be determined. */
  serviceActiveForMs: number | null;
  graceMs: number;
  /** The process was last stopped on purpose (`isPlannedStop`). */
  plannedStop: boolean;
}

/**
 * Pure decision of the watchdog: is a stale heartbeat an outage?
 *
 * Two cases explicitly are not, and both led to real false alarms on
 * 2026-09-18 or would have:
 * - **Start phase.** If the service has not run for `graceMs` yet, the
 *   heartbeat cannot have written anything. A missing entry here means "just
 *   restarted", not "dead".
 * - **Planned stop.** Whoever says `systemctl stop serain` (the way back in
 *   the deploy checklist) wants no alarms every five minutes.
 *
 * If the uptime cannot be determined (`null`), there is no grace period:
 * rather one alarm too many than a concealed outage.
 */
export function shouldOpenStaleIncident(input: StaleIncidentInput): boolean {
  if (input.plannedStop) return false;
  if (input.serviceActiveForMs !== null && input.serviceActiveForMs < input.graceMs) return false;
  return isStale(input.row?.last_ok_at ?? null, input.now, input.thresholdMs);
}

export async function recordComponentStatus(
  component: ComponentName,
  status: ComponentHealth,
  detail: Record<string, unknown> = {},
): Promise<void> {
  // Per component in every heartbeat and after every model call, hence over Postgres (`pg.ts`).
  const ok = status === "ok";
  await pgRun(
    `component_status (${component}) not written`,
    (sql) => sql`
      insert into public.component_status (component, status, detail, updated_at, last_ok_at)
      values (${component}, ${status}, ${sql.json(detail as never)}, now(), ${ok ? sql`now()` : null})
      on conflict (component) do update set
        status = excluded.status, detail = excluded.detail, updated_at = excluded.updated_at,
        last_ok_at = ${ok ? sql`excluded.last_ok_at` : sql`component_status.last_ok_at`}`,
  ).catch((error: unknown) => log.error((error as Error).message));
}

/**
 * Leaves the watchdog the note that this stop was intended. Runs in the
 * `stop()` path of `runtime.ts` after the heartbeat has stopped, so no tick
 * sets the row back to `ok` right away.
 */
export async function markPlannedStop(): Promise<void> {
  await recordComponentStatus("process", "down", { planned: true, pid: process.pid });
}

export async function readComponentStatus(): Promise<ComponentStatusRow[]> {
  const { data, error } = await db.from("component_status").select("*");
  if (error) throw new Error(`component_status not readable: ${error.message}`);
  return (data ?? []) as ComponentStatusRow[];
}
