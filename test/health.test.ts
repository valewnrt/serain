import { describe, expect, it } from "vitest";
import {
  isPlannedStop,
  isStale,
  MONITORED_COMPONENTS,
  shouldOpenStaleIncident,
  type ComponentStatusRow,
} from "../src/health/status.js";
import { decideIncidentAction, type Incident } from "../src/health/incidents.js";
import { IncidentNotificationLimiter } from "../src/health/notify.js";
import { deliveryVerdict, describeDeliveryFailure, describeResolved, selectResolvedToNotify } from "../src/health/heartbeat.js";
import { DeliveryLog, deliveryReason } from "../src/health/delivery.js";

describe("staleness decision", () => {
  const now = new Date("2026-09-18T12:00:00Z");

  it("counts as stale without any reported time", () => {
    expect(isStale(null, now, 15 * 60_000)).toBe(true);
  });

  it("counts as stale when the last good time is too long ago", () => {
    const lastOk = new Date(now.getTime() - 16 * 60_000).toISOString();
    expect(isStale(lastOk, now, 15 * 60_000)).toBe(true);
  });

  it("does not count as stale within the threshold", () => {
    const lastOk = new Date(now.getTime() - 5 * 60_000).toISOString();
    expect(isStale(lastOk, now, 15 * 60_000)).toBe(false);
  });

  it("treats unreadable timestamps as stale", () => {
    expect(isStale("kein-datum", now, 15 * 60_000)).toBe(true);
  });

  it("monitors process, channel and database, not the model", () => {
    expect(MONITORED_COMPONENTS).toEqual(["process", "channel", "db"]);
  });

  it("leaves delivery out of the watchdog: a stale row would be the same outage as process (D44)", () => {
    expect(MONITORED_COMPONENTS).not.toContain("delivery");
  });
});

describe("opening/closing incidents", () => {
  it("opens only when unhealthy and none is open yet", () => {
    expect(decideIncidentAction(false, false)).toBe("open");
  });

  it("closes only when healthy again and one was open", () => {
    expect(decideIncidentAction(true, true)).toBe("close");
  });

  it("does nothing when the state already matches the open incident", () => {
    expect(decideIncidentAction(false, true)).toBe("none");
    expect(decideIncidentAction(true, false)).toBe("none");
  });
});

describe("rate limit of the incident report", () => {
  it("lets the first report per component through", () => {
    const limiter = new IncidentNotificationLimiter(30 * 60_000);
    expect(limiter.allows("channel", 1_000)).toBe(true);
  });

  it("blocks a second report within the window", () => {
    const limiter = new IncidentNotificationLimiter(30 * 60_000);
    limiter.record(["channel"], 1_000);
    expect(limiter.allows("channel", 1_000 + 60_000)).toBe(false);
  });

  it("lets through again after the window", () => {
    const limiter = new IncidentNotificationLimiter(30 * 60_000);
    limiter.record(["channel"], 1_000);
    expect(limiter.allows("channel", 1_000 + 30 * 60_000)).toBe(true);
  });

  it("keeps components apart independently", () => {
    const limiter = new IncidentNotificationLimiter(30 * 60_000);
    limiter.record(["channel"], 1_000);
    expect(limiter.allows("db", 1_000)).toBe(true);
  });

  it("records nothing on a mere question", () => {
    const limiter = new IncidentNotificationLimiter(30 * 60_000);
    expect(limiter.allows("db", 1_000)).toBe(true);
    // The old bug: `shouldNotify` already recorded when asked, so the window was
    // used up even though nothing went out.
    expect(limiter.allows("db", 1_000 + 60_000)).toBe(true);
  });

  it("records several components of a bundled report at once", () => {
    const limiter = new IncidentNotificationLimiter(30 * 60_000);
    limiter.record(["process", "channel", "db"], 1_000);
    expect(limiter.allows("process", 2_000)).toBe(false);
    expect(limiter.allows("channel", 2_000)).toBe(false);
    expect(limiter.allows("db", 2_000)).toBe(false);
  });
});

/**
 * The false alarm of 2026-09-18: the watchdog ran right after the deploy,
 * `component_status` was (freshly migrated) still empty, and "never a
 * heartbeat" counted as an outage. Three incidents that the restarted process
 * closed at once and reported to Alex one by one.
 */
describe("[W11] watchdog reports no restart as an outage", () => {
  const now = new Date("2026-09-18T12:00:00Z");
  const grace = 15 * 60_000;
  const threshold = 15 * 60_000;
  const frisch: ComponentStatusRow = {
    component: "channel",
    status: "ok",
    last_ok_at: new Date(now.getTime() - 60_000).toISOString(),
    updated_at: new Date(now.getTime() - 60_000).toISOString(),
    detail: {},
  };

  it("stays silent while the service is still in the grace period and has written nothing", () => {
    expect(
      shouldOpenStaleIncident({
        row: undefined,
        now,
        thresholdMs: threshold,
        serviceActiveForMs: 2_000,
        graceMs: grace,
        plannedStop: false,
      }),
    ).toBe(false);
  });

  it("reports a missing heartbeat as soon as the grace period is over", () => {
    expect(
      shouldOpenStaleIncident({
        row: undefined,
        now,
        thresholdMs: threshold,
        serviceActiveForMs: grace + 1,
        graceMs: grace,
        plannedStop: false,
      }),
    ).toBe(true);
  });

  it("stays silent after an intended stop", () => {
    expect(
      shouldOpenStaleIncident({
        row: undefined,
        now,
        thresholdMs: threshold,
        serviceActiveForMs: null,
        graceMs: grace,
        plannedStop: true,
      }),
    ).toBe(false);
  });

  it("grants no grace period without a determinable uptime", () => {
    // Rather one alarm too many than a concealed outage.
    expect(
      shouldOpenStaleIncident({
        row: undefined,
        now,
        thresholdMs: threshold,
        serviceActiveForMs: null,
        graceMs: grace,
        plannedStop: false,
      }),
    ).toBe(true);
  });

  it("reports nothing when the heartbeat is fresh", () => {
    expect(
      shouldOpenStaleIncident({
        row: frisch,
        now,
        thresholdMs: threshold,
        serviceActiveForMs: 60 * 60_000,
        graceMs: grace,
        plannedStop: false,
      }),
    ).toBe(false);
  });

  it("recognises a clean stop only by status down plus marker", () => {
    const down = (detail: Record<string, unknown>): ComponentStatusRow => ({
      component: "process",
      status: "down",
      last_ok_at: null,
      updated_at: now.toISOString(),
      detail,
    });
    expect(isPlannedStop(down({ planned: true }))).toBe(true);
    expect(isPlannedStop(down({}))).toBe(false);
    expect(isPlannedStop(undefined)).toBe(false);
    // A crash never goes through the stop() path: the last row stays ok.
    expect(isPlannedStop({ ...down({ planned: true }), status: "ok" })).toBe(false);
  });
});

describe("[W11] report about resolved outages", () => {
  const now = Date.parse("2026-09-18T12:00:00Z");
  const incident = (minutesAgo: number): Incident => ({
    id: "i1",
    component: "channel",
    started_at: new Date(now - minutesAgo * 60_000).toISOString(),
    ended_at: null,
    root_cause: null,
    note: null,
    detail: {},
  });
  const alles = () => true;

  it("stays silent on an outage below the minimum duration", () => {
    const closed = [{ component: "channel" as const, incident: incident(1) }];
    expect(selectResolvedToNotify(closed, now, 10 * 60_000, alles)).toEqual([]);
  });

  it("reports from the minimum duration on", () => {
    const closed = [{ component: "channel" as const, incident: incident(10) }];
    expect(selectResolvedToNotify(closed, now, 10 * 60_000, alles)).toHaveLength(1);
  });

  it("leaves out the components blocked by the rate limit", () => {
    const closed = [
      { component: "process" as const, incident: incident(20) },
      { component: "db" as const, incident: incident(20) },
    ];
    const gewaehlt = selectResolvedToNotify(closed, now, 10 * 60_000, (c) => c !== "db");
    expect(gewaehlt.map((entry) => entry.component)).toEqual(["process"]);
  });

  it("says it in one sentence, whatever the components were (addendum D23 of 2026-10-10)", () => {
    expect(describeResolved(12)).toBe("war 12 min nicht erreichbar, jetzt wieder da.");
  });
});

describe("[D44] delivery: window and thresholds", () => {
  const MIN = 60_000;
  const t0 = Date.parse("2026-10-02T12:00:00Z");

  it("is healthy without a single attempt: silence is no error", () => {
    const health = new DeliveryLog().health(t0);
    expect(health).toMatchObject({ healthy: true, idle: true, attempts: 0, failures: 0, consecutiveFailures: 0, lastError: null });
  });

  it("becomes sick at three failures in a row, not at two", () => {
    const log = new DeliveryLog();
    expect(log.record(t0, false, "Target not allowed for this project")).toBe(false);
    expect(log.record(t0 + MIN, false, "Target not allowed for this project")).toBe(false);
    expect(log.health(t0 + MIN).healthy).toBe(true);
    expect(log.record(t0 + 2 * MIN, false, "Target not allowed for this project")).toBe(true);
    expect(log.health(t0 + 2 * MIN)).toMatchObject({
      healthy: false,
      idle: false,
      attempts: 3,
      failures: 3,
      consecutiveFailures: 3,
      lastError: "Target not allowed for this project",
    });
  });

  it("becomes sick at half of four attempts in the window, even without a streak", () => {
    const log = new DeliveryLog();
    log.record(t0, true);
    log.record(t0 + MIN, false, "x");
    log.record(t0 + 2 * MIN, true);
    expect(log.record(t0 + 3 * MIN, false, "x")).toBe(true);
    expect(log.health(t0 + 3 * MIN)).toMatchObject({ healthy: false, attempts: 4, failures: 2, consecutiveFailures: 1 });
  });

  it("counts only the last 30 minutes for the ratio", () => {
    const log = new DeliveryLog();
    log.record(t0, false, "x");
    log.record(t0 + MIN, true);
    log.record(t0 + 2 * MIN, false, "x");
    log.record(t0 + 3 * MIN, true);
    // Over everything three of five; in the window there is only this one attempt.
    expect(log.record(t0 + 40 * MIN, false, "x")).toBe(false);
    expect(log.health(t0 + 40 * MIN)).toMatchObject({ healthy: true, attempts: 1, failures: 1 });
  });

  it("stays sick when only silence follows the failures", () => {
    const log = new DeliveryLog();
    for (let i = 0; i < 3; i += 1) log.record(t0 + i * MIN, false, "x");
    const later = log.health(t0 + 3 * 60 * MIN);
    expect(later.healthy).toBe(false);
    expect(later.attempts).toBe(0);
  });

  it("becomes healthy again with the first success", () => {
    const log = new DeliveryLog();
    for (let i = 0; i < 4; i += 1) log.record(t0 + i * MIN, false, "x");
    expect(log.record(t0 + 5 * MIN, true)).toBe(true);
    expect(log.health(t0 + 5 * MIN)).toMatchObject({ healthy: true, consecutiveFailures: 0, attempts: 5, failures: 4 });
  });

  it("reports a change exactly once, not at every further failure", () => {
    const log = new DeliveryLog();
    const flips = [0, 1, 2, 3, 4].map((i) => log.record(t0 + i * MIN, false, "x"));
    expect(flips).toEqual([false, false, true, false, false]);
  });

  it("shortens the error reason and takes phone numbers out", () => {
    expect(deliveryReason("No iMessage client serves phone +1 555 010 0199. Available: +15550100199")).toBe(
      "No iMessage client serves phone <number>. Available: <number>",
    );
    const long = deliveryReason(`13 INTERNAL: ${"a".repeat(500)}`);
    expect(long).toHaveLength(200);
    expect(long.endsWith("…")).toBe(true);
    expect(deliveryReason("Target not allowed for this project")).toBe("Target not allowed for this project");
  });
});

describe("[D44] delivery in the heartbeat", () => {
  const idle = new DeliveryLog().health(0);
  const failing = (() => {
    const log = new DeliveryLog();
    for (let i = 0; i < 3; i += 1) log.record(i, false, "Target not allowed for this project");
    return log.health(3);
  })();

  it("keeps an incident from the last run open while the new process has sent nothing", () => {
    expect(deliveryVerdict(idle, true)).toBe(false);
    expect(deliveryVerdict(idle, false)).toBe(true);
  });

  it("otherwise follows the count, whether or not an incident is open", () => {
    expect(deliveryVerdict(failing, false)).toBe(false);
    expect(deliveryVerdict(failing, true)).toBe(false);
  });

  it("writes numbers and Photon's reason into the incident", () => {
    expect(describeDeliveryFailure(failing)).toBe(
      "detected automatically: deliveries fail (3 in a row, 3 of 3 in the window): Target not allowed for this project",
    );
  });
});
