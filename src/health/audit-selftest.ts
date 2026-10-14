import { randomUUID } from "node:crypto";
import { AUDIT_SELFTEST_INTERVAL_MS } from "../config/limits.js";
import { t } from "../i18n/catalog.js";
import { currentLanguage } from "../i18n/language.js";
import { health as text } from "../i18n/messages/health.js";
import { log } from "../log.js";

/**
 * Audit log self-test (W9). Building the log is not enough: Muse's own
 * monitoring switched itself off in the internal test, and nobody noticed.
 * `audit()` swallows write errors on purpose, so a turn does not die of the
 * log; that is exactly why someone has to check.
 *
 * Once a week: write a synthetic error, find it again, and try to change and
 * delete it. Finding must work, changing and deleting must fail (D8.6,
 * append-only). Silent on success, loud on every failure.
 */

export interface AuditProbe {
  /** Writes the synthetic entry the normal way (`audit()`). */
  write(nonce: string): Promise<void>;
  /** How many entries with this nonce stand in the log? */
  count(nonce: string): Promise<number>;
  /** Tries to change the entry. True means: it worked, and that is the error. */
  updateSucceeds(nonce: string): Promise<boolean>;
  deleteSucceeds(nonce: string): Promise<boolean>;
}

export interface SelftestState {
  lastRunAt(): Promise<Date | null>;
  record(at: Date, failures: string[]): Promise<void>;
}

export type SelftestFailure = "written_not_found" | "update_allowed" | "delete_allowed" | "probe_error";

export async function runAuditSelftest(probe: AuditProbe): Promise<SelftestFailure[]> {
  const nonce = randomUUID();
  const failures: SelftestFailure[] = [];
  try {
    await probe.write(nonce);
    if ((await probe.count(nonce)) !== 1) {
      // Without an entry there is nothing to change or delete.
      return ["written_not_found"];
    }
    if (await probe.updateSucceeds(nonce)) failures.push("update_allowed");
    if (await probe.deleteSucceeds(nonce)) failures.push("delete_allowed");
    if ((await probe.count(nonce)) !== 1) failures.push("written_not_found");
  } catch (error) {
    log.error("Audit self-test could not check:", error);
    failures.push("probe_error");
  }
  return [...new Set(failures)];
}

const EXPLANATION = {
  written_not_found: text.selftestWrittenNotFound,
  update_allowed: text.selftestUpdateAllowed,
  delete_allowed: text.selftestDeleteAllowed,
  probe_error: text.selftestProbeError,
} as const;

/** The alert to the owner, from the catalog. The reasons are listed with commas, as in the style round. */
export function selftestAlert(failures: readonly SelftestFailure[], lang: string = currentLanguage()): string {
  return t(text.selftestAlert, { reasons: failures.map((failure) => t(EXPLANATION[failure], undefined, lang)).join(", ") }, lang);
}

export interface AuditSelftestDeps {
  probe: AuditProbe;
  state: SelftestState;
  /** Tells the owner. Only on failure. */
  alert(text: string): Promise<void>;
  now?: () => Date;
}

/** Hangs on the scheduler's beat and runs when the week is over. */
export class AuditSelftest {
  private nextCheckAt = 0;
  private readonly now: () => Date;

  constructor(private readonly deps: AuditSelftestDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async maybeRun(): Promise<void> {
    const now = this.now();
    if (now.getTime() < this.nextCheckAt) return;
    const last = await this.deps.state.lastRunAt();
    const dueAt = (last?.getTime() ?? 0) + AUDIT_SELFTEST_INTERVAL_MS;
    if (now.getTime() < dueAt) {
      this.nextCheckAt = dueAt;
      return;
    }
    const failures = await runAuditSelftest(this.deps.probe);
    await this.deps.state.record(now, failures);
    this.nextCheckAt = now.getTime() + AUDIT_SELFTEST_INTERVAL_MS;
    if (failures.length > 0) {
      log.error("Audit self-test failed:", failures.join(", "));
      await this.deps.alert(selftestAlert(failures));
    }
  }
}
