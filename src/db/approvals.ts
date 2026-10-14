import { db } from "./client.js";
import { columns, pgRows } from "./pg.js";
import type {
  ApprovalClaim,
  ApprovalRow,
  ApprovalStore,
  NewApproval,
} from "../security/approvals.js";

/** `approvals` and `approval_grants` in Supabase (migration 0004). */

const COLUMNS =
  "id, tool, level, args, preview, undo, grant_key, scope, status, preview_external_id, preview_file_external_ids, request_message_id, expires_at, execute_at, later_pin, taint_sources, reissued_from";

interface DbRow {
  id: string;
  tool: string;
  level: "irreversible" | "money";
  args: Record<string, unknown>;
  preview: string;
  undo: string;
  grant_key: string;
  scope: "once" | "standing";
  status: ApprovalRow["status"];
  preview_external_id: string;
  preview_file_external_ids: string[] | null;
  request_message_id: string | null;
  expires_at: string;
  execute_at: string | null;
  later_pin: Record<string, unknown> | null;
  taint_sources: string[] | null;
  reissued_from: string | null;
}

function toRow(row: DbRow): ApprovalRow {
  return {
    id: row.id,
    tool: row.tool,
    level: row.level,
    args: row.args,
    preview: row.preview,
    undo: row.undo,
    grantKey: row.grant_key,
    scope: row.scope,
    status: row.status,
    previewExternalId: row.preview_external_id,
    previewFileExternalIds: row.preview_file_external_ids ?? [],
    requestMessageId: row.request_message_id,
    expiresAt: row.expires_at,
    executeAt: row.execute_at,
    laterPin: row.later_pin,
    taintSources: row.taint_sources ?? [],
    reissuedFrom: row.reissued_from ?? null,
  };
}

function rows(data: unknown): ApprovalRow[] {
  return ((data ?? []) as DbRow[]).map(toRow);
}

/** The approval for a preview in this state. A file under the preview (0021) counts like the preview itself. */
async function byPreview(previewExternalId: string, status: "pending" | "scheduled"): Promise<ApprovalRow | null> {
  if (!previewExternalId) return null;
  const { data, error } = await db
    .from("approvals")
    .select(COLUMNS)
    .eq("preview_external_id", previewExternalId)
    .eq("status", status)
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Approval not readable: ${error.message}`);
  if (data) return toRow(data as DbRow);
  const byFile = await db
    .from("approvals")
    .select(COLUMNS)
    .contains("preview_file_external_ids", [previewExternalId])
    .eq("status", status)
    .limit(1)
    .maybeSingle();
  if (byFile.error) throw new Error(`Approval not readable: ${byFile.error.message}`);
  return byFile.data ? toRow(byFile.data as DbRow) : null;
}

export const approvalStore: ApprovalStore = {
  async insert(row: NewApproval) {
    const { data, error } = await db
      .from("approvals")
      .insert({
        tool: row.tool,
        level: row.level,
        args: row.args,
        preview: row.preview,
        undo: row.undo,
        grant_key: row.grantKey,
        token: row.token,
        preview_external_id: row.previewExternalId,
        preview_file_external_ids: row.previewFileExternalIds,
        request_message_id: row.requestMessageId,
        expires_at: row.expiresAt,
        ...(row.reissuedFrom ? { reissued_from: row.reissuedFrom } : {}),
      })
      .select(COLUMNS)
      .single();
    if (error) throw new Error(`Approval not created: ${error.message}`);
    return toRow(data as DbRow);
  },

  pendingByPreview(previewExternalId) {
    return byPreview(previewExternalId, "pending");
  },

  scheduledByPreview(previewExternalId) {
    return byPreview(previewExternalId, "scheduled");
  },

  async claim(id, claim: ApprovalClaim) {
    // A conditional update is the lock: of two simultaneous signals, exactly one
    // still finds `pending`.
    const { data, error } = await db
      .from("approvals")
      .update({
        status: claim.status,
        scope: claim.scope,
        decided_at: claim.now,
        decided_via: claim.via,
        decision_message_id: claim.decisionMessageId,
      })
      .eq("id", id)
      .eq("status", "pending")
      .gt("expires_at", claim.now)
      .select(COLUMNS)
      .maybeSingle();
    if (error) throw new Error(`Approval not claimable: ${error.message}`);
    return data ? toRow(data as DbRow) : null;
  },

  async finish(id, status, result) {
    const { error } = await db
      .from("approvals")
      .update({ status, result, executed_at: new Date().toISOString() })
      .eq("id", id)
      .eq("status", "approved");
    if (error) throw new Error(`Approval not finished: ${error.message}`);
  },

  async expireDue(now) {
    // On the scheduler's tick, hence via Postgres (`pg.ts`).
    const rows = await pgRows<DbRow>(
      "Expiry not recorded",
      (sql) => sql`
        update public.approvals set status = 'expired', decided_at = ${now}, decided_via = 'timeout'
        where status = 'pending' and expires_at <= ${now}
        returning ${columns(sql, COLUMNS)}`,
    );
    return rows.map(toRow);
  },

  async failApproved(result) {
    const { data, error } = await db
      .from("approvals")
      .update({ status: "failed", result, executed_at: new Date().toISOString() })
      .eq("status", "approved")
      .select(COLUMNS);
    if (error) throw new Error(`Stuck approvals not recorded: ${error.message}`);
    return ((data ?? []) as DbRow[]).map(toRow);
  },

  async expireAllPending() {
    const { data, error } = await db
      .from("approvals")
      .update({ status: "expired", decided_at: new Date().toISOString(), decided_via: "kill_switch" })
      .eq("status", "pending")
      .select("id");
    if (error) throw new Error(`Expiry not recorded: ${error.message}`);
    return (data ?? []).length;
  },

  async countPending(now) {
    const { count, error } = await db
      .from("approvals")
      .select("id", { count: "exact", head: true })
      .eq("status", "pending")
      .gt("expires_at", now);
    if (error) throw new Error(`Approvals not countable: ${error.message}`);
    return count ?? 0;
  },

  async hasGrant(tool, grantKey) {
    const { data, error } = await db
      .from("approval_grants")
      .select("id")
      .eq("tool", tool)
      .eq("grant_key", grantKey)
      .is("revoked_at", null)
      .maybeSingle();
    // When in doubt, no grant: then Serain simply asks.
    if (error) return false;
    return data !== null;
  },

  async addGrant(grant) {
    const { error } = await db.from("approval_grants").insert({
      tool: grant.tool,
      grant_key: grant.grantKey,
      level: "irreversible",
      approval_id: grant.approvalId,
    });
    // 23505: the grant already exists. Not an error.
    if (error && error.code !== "23505") {
      throw new Error(`Standing approval not saved: ${error.message}`);
    }
  },

  async schedule(id, plan) {
    // Like `claim`: the conditional update is the lock, and only before the preview expires.
    const { data, error } = await db
      .from("approvals")
      .update({
        status: "scheduled",
        scope: "once",
        decided_at: plan.now,
        decided_via: "thread_reply",
        decision_message_id: plan.decisionMessageId,
        execute_at: plan.executeAt,
        later_pin: plan.pin,
        taint_sources: plan.taintSources,
      })
      .eq("id", id)
      .eq("status", "pending")
      .gt("expires_at", plan.now)
      .neq("level", "money")
      .select(COLUMNS)
      .maybeSingle();
    if (error) throw new Error(`Approval not schedulable: ${error.message}`);
    return data ? toRow(data as DbRow) : null;
  },

  async scheduled() {
    const { data, error } = await db
      .from("approvals")
      .select(COLUMNS)
      .eq("status", "scheduled")
      .order("execute_at", { ascending: true })
      .limit(50);
    if (error) throw new Error(`Scheduled approvals not readable: ${error.message}`);
    return rows(data);
  },

  async countScheduled() {
    const { count, error } = await db
      .from("approvals")
      .select("id", { count: "exact", head: true })
      .eq("status", "scheduled");
    if (error) throw new Error(`Scheduled approvals not countable: ${error.message}`);
    return count ?? 0;
  },

  async dueScheduled(now, limit) {
    // On the scheduler's tick, hence via Postgres (`pg.ts`).
    return (
      await pgRows<DbRow>(
        "Due approvals not readable",
        (sql) => sql`
          select ${columns(sql, COLUMNS)} from public.approvals
          where status = 'scheduled' and execute_at <= ${now}
          order by execute_at asc limit ${limit}`,
      )
    ).map(toRow);
  },

  async claimDue(id, now) {
    const { data, error } = await db
      .from("approvals")
      .update({ status: "approved" })
      .eq("id", id)
      .eq("status", "scheduled")
      .lte("execute_at", now)
      .select(COLUMNS)
      .maybeSingle();
    if (error) throw new Error(`Due approval not claimable: ${error.message}`);
    return data ? toRow(data as DbRow) : null;
  },

  async missScheduled(id, result) {
    const { data, error } = await db
      .from("approvals")
      .update({ status: "failed", result, executed_at: new Date().toISOString() })
      .eq("id", id)
      .eq("status", "scheduled")
      .select(COLUMNS)
      .maybeSingle();
    if (error) throw new Error(`Missed approval not recorded: ${error.message}`);
    return data ? toRow(data as DbRow) : null;
  },

  async cancelScheduled(id, via, now) {
    const { data, error } = await db
      .from("approvals")
      .update({ status: "cancelled", result: { ok: false, text: `Cancelled (${via}).` }, executed_at: now })
      .eq("id", id)
      .eq("status", "scheduled")
      .select(COLUMNS)
      .maybeSingle();
    if (error) throw new Error(`Cancellation not recorded: ${error.message}`);
    return data ? toRow(data as DbRow) : null;
  },

  async cancelAllScheduled(now) {
    const { data, error } = await db
      .from("approvals")
      .update({ status: "cancelled", result: { ok: false, text: "Cancelled (kill_switch)." }, executed_at: now })
      .eq("status", "scheduled")
      .select("id");
    if (error) throw new Error(`Cancellation not recorded: ${error.message}`);
    return (data ?? []).length;
  },

  async expiredByPreview(previewExternalId) {
    // Only what expired at its deadline (`decided_via = 'timeout'`), never what the kill switch expired (addendum D8 of 2026-10-10).
    if (!previewExternalId) return null;
    const query = () =>
      db.from("approvals").select(COLUMNS).eq("status", "expired").eq("decided_via", "timeout").order("expires_at", { ascending: false }).limit(1);
    const { data, error } = await query().eq("preview_external_id", previewExternalId).maybeSingle();
    if (error) throw new Error(`Expired approval not readable: ${error.message}`);
    if (data) return toRow(data as DbRow);
    const byFile = await query().contains("preview_file_external_ids", [previewExternalId]).maybeSingle();
    if (byFile.error) throw new Error(`Expired approval not readable: ${byFile.error.message}`);
    return byFile.data ? toRow(byFile.data as DbRow) : null;
  },

  async claimExpired(id, now) {
    // The conditional update is the lock: of two 👍 on the same old preview, exactly one gets an answer.
    const { data, error } = await db
      .from("approvals")
      .update({ expired_answered_at: now })
      .eq("id", id)
      .eq("status", "expired")
      .eq("decided_via", "timeout")
      .is("expired_answered_at", null)
      .select(COLUMNS)
      .maybeSingle();
    if (error) throw new Error(`Expired approval not claimable: ${error.message}`);
    return data ? toRow(data as DbRow) : null;
  },

  async revokeGrants(via) {
    const { data, error } = await db
      .from("approval_grants")
      .update({ revoked_at: new Date().toISOString(), revoked_via: via })
      .is("revoked_at", null)
      .select("id");
    if (error) throw new Error(`Revocation not recorded: ${error.message}`);
    return (data ?? []).length;
  },
};

/**
 * Which standing approvals currently apply, as `grant_key` (e.g. "mails to …").
 * For the receipt on "serain revoke" (addendum D23 of 2026-10-10): the owner
 * should hear which ones are gone. Read before the revocation, without
 * secrets: the key only names recipients the owner confirmed themselves.
 */
export async function activeGrantKeys(): Promise<string[]> {
  const { data, error } = await db.from("approval_grants").select("grant_key").is("revoked_at", null).order("created_at", { ascending: true });
  if (error) throw new Error(`Standing approvals not readable: ${error.message}`);
  return (data ?? []).map((row) => String((row as { grant_key: unknown }).grant_key ?? "")).filter(Boolean);
}
