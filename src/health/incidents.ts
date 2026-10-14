import { db } from "../db/client.js";
import { columns, pgRows } from "../db/pg.js";
import { log } from "../log.js";
import type { ComponentName } from "./status.js";

/**
 * What incidents exist for: the components from `component_status` and every
 * connected login (`integration:<id>`, src/health/integrations.ts). The column
 * is free text; the type here keeps typos out.
 */
export type IncidentComponent = ComponentName | `integration:${string}`;

/** Postgres code for a unique violation, as in db/messages.ts. */
const UNIQUE_VIOLATION = "23505";

export interface Incident {
  id: string;
  component: string;
  started_at: string;
  ended_at: string | null;
  root_cause: string | null;
  note: string | null;
  detail: Record<string, unknown>;
}

const COLUMNS = "id, component, started_at, ended_at, root_cause, note, detail";

export type IncidentAction = "open" | "close" | "none";

/**
 * Pure state decision, no DB access: the action follows from the current
 * health and whether an incident is already open. Separate from the DB layer,
 * so it can be tested without Supabase (killswitch.ts separates
 * `detectKillSwitchCommand` from the DB class the same way).
 */
export function decideIncidentAction(isHealthy: boolean, hasOpenIncident: boolean): IncidentAction {
  if (!isHealthy && !hasOpenIncident) return "open";
  if (isHealthy && hasOpenIncident) return "close";
  return "none";
}

export async function findOpenIncident(component: IncidentComponent): Promise<Incident | null> {
  // Per component in every heartbeat, hence over Postgres (`pg.ts`).
  const rows = await pgRows<Incident>(
    "incidents not readable",
    (sql) => sql`
      select ${columns(sql, COLUMNS)} from public.incidents
      where component = ${component} and ended_at is null
      order by started_at desc limit 1`,
  );
  return rows[0] ?? null;
}

async function insertIncident(component: IncidentComponent, rootCause: string): Promise<Incident | null> {
  const { data, error } = await db
    .from("incidents")
    .insert({ component, root_cause: rootCause })
    .select(COLUMNS)
    .single();
  if (error) {
    // A unique violation means: another runner (watchdog or main process) was
    // faster. No error, the second opener gets the existing one.
    if (error.code === UNIQUE_VIOLATION) return findOpenIncident(component);
    log.error(`Incident (${component}) not created:`, error.message);
    return null;
  }
  log.warn(`Incident opened: ${component} (${rootCause})`);
  return data as Incident;
}

async function closeIncident(id: string, note: string): Promise<Incident | null> {
  const { data, error } = await db
    .from("incidents")
    .update({ ended_at: new Date().toISOString(), note, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select(COLUMNS)
    .single();
  if (error) {
    log.error("Incident not closed:", error.message);
    return null;
  }
  log.info(`Incident closed: ${(data as Incident).component}`);
  return data as Incident;
}

export interface HealthTransitionResult {
  action: IncidentAction;
  incident: Incident | null;
}

/**
 * Opens or closes an incident for a component, depending on the current
 * health. Called by the running process (`src/health/heartbeat.ts`), the only
 * one with a channel to notify the owner on closing.
 */
export async function applyHealthTransition(
  component: IncidentComponent,
  isHealthy: boolean,
  message: string,
): Promise<HealthTransitionResult> {
  const existing = await findOpenIncident(component);
  const action = decideIncidentAction(isHealthy, existing !== null);
  if (action === "open") {
    return { action, incident: await insertIncident(component, message) };
  }
  if (action === "close" && existing) {
    return { action, incident: await closeIncident(existing.id, message) };
  }
  return { action: "none", incident: existing };
}

/**
 * Only open, never close. For the watchdog (`src/health/watchdog.ts`), which
 * runs outside the Node process and has no channel to report a recovery to the
 * owner. Closing (and reporting) is done only by the running process itself via
 * `applyHealthTransition`; otherwise the report to the owner would get lost,
 * because the watchdog would have closed it silently.
 */
export async function reportUnhealthy(component: IncidentComponent, rootCause: string): Promise<Incident | null> {
  const existing = await findOpenIncident(component);
  if (decideIncidentAction(false, existing !== null) !== "open") return existing;
  return insertIncident(component, rootCause);
}

/**
 * Notes on the incident that the owner knows about it. The state lives in the
 * database, not in the process: after a restart the same outage should not be
 * reported again, and the all-clear should only come if there was a warning.
 */
export async function markIncidentNotified(incident: Incident): Promise<void> {
  const { error } = await db
    .from("incidents")
    .update({ detail: { ...incident.detail, notified: true }, updated_at: new Date().toISOString() })
    .eq("id", incident.id);
  if (error) throw new Error(`Incident not marked as notified: ${error.message}`);
}
