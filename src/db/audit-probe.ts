import { audit } from "./audit.js";
import { db } from "./client.js";
import type { AuditProbe, SelftestState } from "../health/audit-selftest.js";

/** The self-test (W9) against the real `audit_log`. */

const STATE_KEY = "audit_selftest";

export const auditProbe: AuditProbe = {
  async write(nonce) {
    // Through `audit()`, not directly: what is tested is the path everything else takes.
    await audit("selftest", { nonce, synthetic_error: true });
  },

  async count(nonce) {
    const { count, error } = await db
      .from("audit_log")
      .select("id", { count: "exact", head: true })
      .eq("event", "selftest")
      .eq("detail->>nonce", nonce);
    if (error) throw new Error(`audit_log not readable: ${error.message}`);
    return count ?? 0;
  },

  async updateSucceeds(nonce) {
    const { data, error } = await db
      .from("audit_log")
      .update({ event: "selftest_tampered" })
      .eq("event", "selftest")
      .eq("detail->>nonce", nonce)
      .select("id");
    // The trigger throws. No error and a changed row means: it is missing.
    return !error && (data ?? []).length > 0;
  },

  async deleteSucceeds(nonce) {
    const { data, error } = await db
      .from("audit_log")
      .delete()
      .eq("detail->>nonce", nonce)
      .select("id");
    return !error && (data ?? []).length > 0;
  },
};

export const selftestState: SelftestState = {
  async lastRunAt() {
    const { data, error } = await db
      .from("agent_state")
      .select("value")
      .eq("key", STATE_KEY)
      .maybeSingle();
    if (error) throw new Error(`Self-test state not readable: ${error.message}`);
    const at = (data?.value as { last_run_at?: unknown } | undefined)?.last_run_at;
    return typeof at === "string" ? new Date(at) : null;
  },

  async record(at, failures) {
    const { error } = await db.from("agent_state").upsert({
      key: STATE_KEY,
      value: { last_run_at: at.toISOString(), failures },
      updated_at: at.toISOString(),
    });
    if (error) throw new Error(`Self-test state not saved: ${error.message}`);
  },
};
