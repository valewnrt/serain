import { log } from "../log.js";

/**
 * Healthchecks.io deadman switch (period 5 min, grace 10 min). Runs in
 * addition to the internal heartbeat (`heartbeat.ts`) and the external
 * watchdog (`watchdog.ts`), independent of the server and of Supabase, the
 * only alarm path on a total outage (see `deploy/README.md`). GET on the ping
 * URL when all monitored components are ok, GET on `<url>/fail` otherwise.
 *
 * The pure decision is separate from the HTTP call, so it can be tested
 * without `fetch` (same pattern as `decideIncidentAction` in incidents.ts).
 */
export type DeadmanAction = "ping" | "fail" | "none";

export function decideDeadmanAction(allHealthy: boolean, pingUrl: string | undefined): DeadmanAction {
  if (!pingUrl) return "none";
  return allHealthy ? "ping" : "fail";
}

const PING_TIMEOUT_MS = 10_000;

export type FetchLike = typeof fetch;

/**
 * Sends the ping. Never throws (a disturbed ping service must not drag the
 * heartbeat down), only logs. The URL itself never lands in the log: it
 * carries the secret UUID and is already registered as a secret via
 * `redactValue` (config/env.ts) at start, so `log.ts` scrubs it anyway, but on
 * top of that we deliberately log only action and reason, never `url`.
 */
export async function sendDeadmanPing(
  pingUrl: string,
  action: "ping" | "fail",
  fetchImpl: FetchLike = fetch,
): Promise<void> {
  const url = action === "fail" ? `${pingUrl}/fail` : pingUrl;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PING_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { method: "GET", signal: controller.signal });
    if (!response.ok) {
      log.warn(`Healthchecks.io ping (${action}) answered with HTTP ${response.status}`);
    }
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    log.warn(`Healthchecks.io ping (${action}) failed:`, reason);
  } finally {
    clearTimeout(timeout);
  }
}

let missingUrlLogged = false;

/** One-time notice at start: the variable is optional, without it no ping. */
export function logMissingPingUrlOnce(pingUrl: string | undefined): void {
  if (pingUrl || missingUrlLogged) return;
  missingUrlLogged = true;
  log.info("HEALTHCHECKS_PING_URL not set: no Healthchecks.io deadman switch active (optional).");
}
