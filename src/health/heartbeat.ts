import type { Channel } from "../channel/types.js";
import type { OutboundGate } from "../outbound.js";
import { db } from "../db/client.js";
import { pgRows } from "../db/pg.js";
import {
  HEARTBEAT_INTERVAL_MS,
  INCIDENT_NOTIFY_MIN_DURATION_MS,
  INCIDENT_NOTIFY_MIN_INTERVAL_MS,
} from "../config/limits.js";
import { env } from "../config/env.js";
import { t } from "../i18n/catalog.js";
import { currentLanguage } from "../i18n/language.js";
import { health as text } from "../i18n/messages/health.js";
import { log } from "../log.js";
import { recordComponentStatus } from "./status.js";
import { applyHealthTransition, findOpenIncident, type Incident } from "./incidents.js";
import type { DeliveryHealth } from "./delivery.js";
import { IncidentNotificationLimiter } from "./notify.js";
import { decideDeadmanAction, logMissingPingUrlOnce, sendDeadmanPing } from "./deadman.js";

/**
 * Heartbeat in the running process (W11, D10). Writes the component status
 * every few minutes and closes (and reports) incidents as soon as a component
 * is healthy again. Opening on an outage this heartbeat also does right away
 * for `channel` and `db`, faster than the external watchdog, which only steps
 * in on staleness (`src/health/watchdog.ts`). `process` can only report itself
 * when coming back up, never on the outage: that is what the watchdog is for.
 *
 * `delivery` (D44) measures whether messages really go out at the channel. If
 * it is sick, the deadman ping goes to `/fail` too: Healthchecks.io is then the
 * only way to the owner, because the own channel is exactly the one that fails.
 */

type MonitoredComponent = "process" | "channel" | "db" | "delivery";

export interface ClosedIncident {
  component: MonitoredComponent;
  incident: Incident;
}

export interface Heartbeat {
  stop(): void;
}

function durationMs(incident: Incident, now: number): number {
  return now - new Date(incident.started_at).getTime();
}

/**
 * Pure selection, no sending: which of the incidents just closed are worth a
 * message? Separate from the rest, so the two rules can be tested without a
 * channel and without a database (same pattern as `decideIncidentAction`).
 */
export function selectResolvedToNotify(
  closed: readonly ClosedIncident[],
  now: number,
  minDurationMs: number,
  allows: (component: MonitoredComponent) => boolean,
): ClosedIncident[] {
  return closed.filter(
    (entry) => durationMs(entry.incident, now) >= minDurationMs && allows(entry.component),
  );
}

/**
 * The wording from the style round (addendum D23 of 2026-10-10), from the
 * catalog. For the owner each of these components is the same: Serain was
 * unreachable. Which one it was stands in the audit (`components`), not in the
 * message.
 */
export function describeResolved(minutes: number, lang: string = currentLanguage()): string {
  return t(text.resolved, { minutes }, lang);
}

/**
 * Pure decision: is delivery healthy for this run?
 *
 * If this process has sent nothing yet, it knows nothing about delivery. An
 * incident from the run before a restart then stays open until a message
 * really goes out: a restart is no recovery. Otherwise every deploy during a
 * broken line would send Healthchecks.io to "ok again" and the owner an
 * all-clear that is not true. Without an open incident silence means healthy.
 */
export function deliveryVerdict(health: DeliveryHealth, hasOpenIncident: boolean): boolean {
  return health.idle ? !hasOpenIncident : health.healthy;
}

/** What stands in the incident as the cause. Numbers and Photon's reason, never content. */
export function describeDeliveryFailure(health: DeliveryHealth): string {
  return (
    `detected automatically: deliveries fail (${health.consecutiveFailures} in a row, ` +
    `${health.failures} of ${health.attempts} in the window)${health.lastError ? `: ${health.lastError}` : ""}`
  );
}

export function startHeartbeat(channel: Channel, outbound: OutboundGate): Heartbeat {
  const limiter = new IncidentNotificationLimiter(INCIDENT_NOTIFY_MIN_INTERVAL_MS);

  const check = async (
    component: MonitoredComponent,
    isHealthy: boolean,
    closed: ClosedIncident[],
    detail: Record<string, unknown> = {},
    downCause = "detected automatically: not reachable",
  ): Promise<boolean> => {
    await recordComponentStatus(component, isHealthy ? "ok" : "down", detail);
    const { action, incident } = await applyHealthTransition(
      component,
      isHealthy,
      isHealthy ? "detected automatically: ok again" : downCause,
    );
    if (action === "close" && incident) closed.push({ component, incident });
    return isHealthy;
  };

  /**
   * One report per run, not one per component. On 2026-09-18 three messages
   * went out for a single deploy, because every component reported for itself
   * and the rate limit only knows repetitions of the **same** component. Short
   * disruptions stay entirely silent: they only stand in the incident log.
   */
  const notifyResolved = async (closed: ClosedIncident[]): Promise<void> => {
    const now = Date.now();
    const allowed = selectResolvedToNotify(closed, now, INCIDENT_NOTIFY_MIN_DURATION_MS, (component) =>
      limiter.allows(component, now),
    );
    if (allowed.length === 0) return;

    const components = allowed.map((entry) => entry.component);
    const minutes = Math.max(
      ...allowed.map((entry) => Math.max(1, Math.round(durationMs(entry.incident, now) / 60_000))),
    );
    const sent = await outbound.sendToOwner(describeResolved(minutes), {
      kind: "incident_resolved",
      components,
    });
    // Only a notice actually sent uses up the time window. If the budget or the
    // rate limit swallowed it, the next run may try again.
    if (sent) limiter.record(components, now);
  };

  const tick = async (): Promise<void> => {
    const closed: ClosedIncident[] = [];
    const processOk = await check("process", true, closed, {
      pid: process.pid,
      uptime_s: Math.round(process.uptime()),
    });
    const channelOk = await check("channel", channel.isConnected(), closed);
    const dbOk = await check("db", await pingDb(), closed);
    const delivery = outbound.deliveryHealth(Date.now());
    const deliveryOk = await check(
      "delivery",
      deliveryVerdict(delivery, delivery.idle && (await findOpenIncident("delivery")) !== null),
      closed,
      {
        attempts: delivery.attempts,
        failures: delivery.failures,
        consecutive_failures: delivery.consecutiveFailures,
        last_error: delivery.lastError,
        idle: delivery.idle,
      },
      describeDeliveryFailure(delivery),
    );

    await notifyResolved(closed);

    const deadmanAction = decideDeadmanAction(
      processOk && channelOk && dbOk && deliveryOk,
      env.healthchecksPingUrl,
    );
    if (deadmanAction !== "none") {
      await sendDeadmanPing(env.healthchecksPingUrl as string, deadmanAction);
    }
  };

  logMissingPingUrlOnce(env.healthchecksPingUrl);
  void tick().catch((error: unknown) => log.error("Heartbeat failed:", error));
  const timer = setInterval(() => {
    void tick().catch((error: unknown) => log.error("Heartbeat failed:", error));
  }, HEARTBEAT_INTERVAL_MS);

  return { stop: () => clearInterval(timer) };
}

/** Both ways into the database: PostgREST for turns and tools, Postgres for the beat (`pg.ts`). */
async function pingDb(): Promise<boolean> {
  const { error } = await db.from("component_status").select("component").limit(1);
  if (error) return false;
  return pgRows("Postgres not reachable", (sql) => sql`select 1 as ok`).then(
    () => true,
    () => false,
  );
}
