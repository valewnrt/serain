import { describe, expect, it } from "vitest";
import {
  AuditSelftest,
  runAuditSelftest,
  selftestAlert,
  type AuditProbe,
} from "../src/health/audit-selftest.js";
import { AUDIT_SELFTEST_INTERVAL_MS } from "../src/config/limits.js";

/**
 * W9: an audit log that nobody cross-checks can switch itself off unnoticed.
 * The self-test must find each of the three ways in which the log
 * can be broken.
 */

function probe(faults: { lost?: boolean; mutable?: boolean; deletable?: boolean; broken?: boolean } = {}): AuditProbe {
  const rows = new Set<string>();
  return {
    async write(nonce) {
      if (faults.broken) throw new Error("db gone");
      if (!faults.lost) rows.add(nonce);
    },
    count: async (nonce) => (rows.has(nonce) ? 1 : 0),
    updateSucceeds: async () => faults.mutable === true,
    async deleteSucceeds(nonce) {
      if (!faults.deletable) return false;
      rows.delete(nonce);
      return true;
    },
  };
}

describe("audit self-test", () => {
  it("is silent when the log writes and holds", async () => {
    expect(await runAuditSelftest(probe())).toEqual([]);
  });

  it("notices when an entry does not arrive at all", async () => {
    expect(await runAuditSelftest(probe({ lost: true }))).toEqual(["written_not_found"]);
  });

  it("notices when entries can be changed or deleted", async () => {
    expect(await runAuditSelftest(probe({ mutable: true }))).toEqual(["update_allowed"]);
    expect(await runAuditSelftest(probe({ deletable: true }))).toEqual([
      "delete_allowed",
      "written_not_found",
    ]);
  });

  it("does not count a test that could not check as passed", async () => {
    expect(await runAuditSelftest(probe({ broken: true }))).toEqual(["probe_error"]);
  });

  it("runs once a week, reports only failures and survives a restart", async () => {
    const alerts: string[] = [];
    let last: Date | null = null;
    let runs = 0;
    const clock = { now: new Date("2026-09-19T10:00:00Z") };
    const make = (faults: Parameters<typeof probe>[0]) =>
      new AuditSelftest({
        probe: probe(faults),
        now: () => clock.now,
        alert: async (text) => void alerts.push(text),
        state: {
          lastRunAt: async () => last,
          record: async (at) => {
            last = at;
            runs += 1;
          },
        },
      });

    const healthy = make({});
    await healthy.maybeRun();
    await healthy.maybeRun();
    expect(runs).toBe(1);
    expect(alerts).toEqual([]);

    // Restart the next day: the state comes from the DB, not from memory.
    clock.now = new Date(clock.now.getTime() + 24 * 3_600_000);
    await make({}).maybeRun();
    expect(runs).toBe(1);

    clock.now = new Date(clock.now.getTime() + AUDIT_SELFTEST_INTERVAL_MS);
    await make({ mutable: true }).maybeRun();
    expect(runs).toBe(2);
    expect(alerts).toEqual([selftestAlert(["update_allowed"])]);
    expect(alerts[0]).toContain("nachträglich ändern");
  });
});
