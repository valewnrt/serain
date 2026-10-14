import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { HEALTH_STALE_THRESHOLD_MS, HEALTH_STARTUP_GRACE_MS } from "../config/limits.js";
import { log } from "../log.js";
import {
  MONITORED_COMPONENTS,
  isPlannedStop,
  readComponentStatus,
  shouldOpenStaleIncident,
  type ComponentName,
  type ComponentStatusRow,
} from "./status.js";
import { reportUnhealthy } from "./incidents.js";

/**
 * Watchdog, outside the Node process (W11, D10). Runs every few minutes by a
 * systemd timer as its own short process (`deploy/serain-watchdog.service`),
 * not as part of the long-lived `serain` service: if the service fails
 * completely, it cannot report itself, that has to happen from outside.
 *
 * Only opens incidents, never closes any: the report to the owner on closing
 * belongs to the running process (`src/health/heartbeat.ts`), the only one
 * with a channel. If Supabase itself fails, the watchdog sees nothing any more
 * either; for that there is no second, independent alarm path (yet) (open
 * decision, see deploy/README.md).
 *
 * What it explicitly does **not** report, since the false alarm of 2026-09-18:
 * a restart. The decision for that is in `shouldOpenStaleIncident`.
 */
const SERVICE_NAME = process.env["SERAIN_SERVICE_NAME"]?.trim() || "serain";

function isServiceActive(): boolean {
  try {
    const out = execFileSync("systemctl", ["is-active", SERVICE_NAME], { encoding: "utf8" }).trim();
    return out === "active";
  } catch {
    // `systemctl is-active` exits with an error code as soon as the service is
    // not active. That is the normal case we check, not a bug.
    return false;
  }
}

/**
 * Uptime of the service in ms, `null` when it cannot be determined.
 *
 * Both values come from the same monotonic clock (systemd counts microseconds
 * since boot, `/proc/uptime` seconds since boot). The wall clock variant
 * `ActiveEnterTimestamp` would be formatted by locale and so brittle.
 */
function serviceActiveForMs(): number | null {
  try {
    const raw = execFileSync(
      "systemctl",
      ["show", SERVICE_NAME, "--property=ActiveEnterTimestampMonotonic", "--value"],
      { encoding: "utf8" },
    ).trim();
    const activeEnterUs = Number(raw);
    if (!Number.isFinite(activeEnterUs) || activeEnterUs <= 0) return null;
    const bootSeconds = Number.parseFloat(readFileSync("/proc/uptime", "utf8").split(" ")[0] ?? "");
    if (!Number.isFinite(bootSeconds)) return null;
    return Math.max(0, bootSeconds * 1_000 - activeEnterUs / 1_000);
  } catch {
    return null;
  }
}

function describeStaleness(component: ComponentName, row: ComponentStatusRow | undefined): string {
  if (!row) return `Never seen a heartbeat for ${component}`;
  const minutes = Math.round(HEALTH_STALE_THRESHOLD_MS / 60_000);
  return `Heartbeat for ${component} older than ${minutes} minutes (last status: ${row.status})`;
}

async function main(): Promise<void> {
  let rows: ComponentStatusRow[];
  try {
    rows = await readComponentStatus();
  } catch (error) {
    // Without a database the watchdog can no longer check or report anything.
    // It shows in `journalctl -u serain-watchdog`, more is not possible without
    // a second channel (open decision, see deploy/README.md).
    log.error("Watchdog: component_status not readable, aborting:", error);
    return;
  }

  const byComponent = new Map(rows.map((row) => [row.component, row]));
  const plannedStop = isPlannedStop(byComponent.get("process"));

  if (!isServiceActive()) {
    if (plannedStop) {
      log.info(`Service ${SERVICE_NAME} is stopped, but was shut down cleanly: no incident.`);
      return;
    }
    await reportUnhealthy("process", `systemd: service ${SERVICE_NAME} is not active`);
    // If the service is down, channel and database are necessarily stale too.
    // That is the same disruption, not three: one incident, one cause.
    return;
  }

  const activeForMs = serviceActiveForMs();
  const now = new Date();
  for (const component of MONITORED_COMPONENTS) {
    const row = byComponent.get(component);
    const open = shouldOpenStaleIncident({
      row,
      now,
      thresholdMs: HEALTH_STALE_THRESHOLD_MS,
      serviceActiveForMs: activeForMs,
      graceMs: HEALTH_STARTUP_GRACE_MS,
      plannedStop,
    });
    if (open) await reportUnhealthy(component, describeStaleness(component, row));
  }
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    log.error("Watchdog failed:", error);
    process.exit(1);
  });
