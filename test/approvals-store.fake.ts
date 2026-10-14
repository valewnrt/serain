import type {
  ApprovalClaim,
  ApprovalRow,
  ApprovalSchedule,
  CancelVia,
  ApprovalStore,
  NewApproval,
} from "../src/security/approvals.js";

/** `approvals` in memory, with the same atomicity as the conditional update in Postgres. */
export class FakeApprovalStore implements ApprovalStore {
  rows: ApprovalRow[] = [];
  grants: Array<{ tool: string; grantKey: string; revoked: boolean }> = [];
  results = new Map<string, Record<string, unknown>>();
  private seq = 0;

  async insert(row: NewApproval): Promise<ApprovalRow> {
    const stored: ApprovalRow = {
      id: `ap-${++this.seq}`,
      tool: row.tool,
      level: row.level,
      args: row.args,
      preview: row.preview,
      undo: row.undo,
      grantKey: row.grantKey,
      scope: "once",
      status: "pending",
      previewExternalId: row.previewExternalId,
      previewFileExternalIds: row.previewFileExternalIds,
      requestMessageId: row.requestMessageId,
      expiresAt: row.expiresAt,
      executeAt: null,
      laterPin: null,
      taintSources: [],
      reissuedFrom: row.reissuedFrom ?? null,
    };
    this.rows.push(stored);
    return { ...stored };
  }

  async pendingByPreview(previewExternalId: string): Promise<ApprovalRow | null> {
    return this.byPreview(previewExternalId, "pending");
  }

  async scheduledByPreview(previewExternalId: string): Promise<ApprovalRow | null> {
    return this.byPreview(previewExternalId, "scheduled");
  }

  private byPreview(previewExternalId: string, status: "pending" | "scheduled"): ApprovalRow | null {
    const row = this.rows.find(
      (entry) =>
        (entry.previewExternalId === previewExternalId || entry.previewFileExternalIds.includes(previewExternalId)) &&
        entry.status === status,
    );
    return row ? { ...row } : null;
  }

  async schedule(id: string, plan: ApprovalSchedule): Promise<ApprovalRow | null> {
    const row = this.rows.find((entry) => entry.id === id);
    if (!row || row.status !== "pending" || row.expiresAt <= plan.now || row.level === "money") return null;
    row.status = "scheduled";
    row.executeAt = plan.executeAt;
    row.laterPin = plan.pin;
    row.taintSources = [...plan.taintSources];
    return { ...row };
  }

  async scheduled(): Promise<ApprovalRow[]> {
    return this.rows
      .filter((entry) => entry.status === "scheduled")
      .sort((a, b) => (a.executeAt ?? "").localeCompare(b.executeAt ?? ""))
      .map((row) => ({ ...row }));
  }

  async countScheduled(): Promise<number> {
    return this.rows.filter((entry) => entry.status === "scheduled").length;
  }

  async dueScheduled(now: string, limit: number): Promise<ApprovalRow[]> {
    return (await this.scheduled()).filter((row) => (row.executeAt ?? "") <= now).slice(0, limit);
  }

  async claimDue(id: string, now: string): Promise<ApprovalRow | null> {
    const row = this.rows.find((entry) => entry.id === id);
    if (!row || row.status !== "scheduled" || (row.executeAt ?? "") > now) return null;
    row.status = "approved";
    return { ...row };
  }

  async missScheduled(id: string, result: Record<string, unknown>): Promise<ApprovalRow | null> {
    const row = this.rows.find((entry) => entry.id === id);
    if (row?.status !== "scheduled") return null;
    row.status = "failed";
    this.results.set(id, result);
    return { ...row };
  }

  cancelledVia = new Map<string, CancelVia>();

  async cancelScheduled(id: string, via: CancelVia): Promise<ApprovalRow | null> {
    const row = this.rows.find((entry) => entry.id === id);
    if (row?.status !== "scheduled") return null;
    row.status = "cancelled";
    this.cancelledVia.set(id, via);
    return { ...row };
  }

  async cancelAllScheduled(): Promise<number> {
    const open = this.rows.filter((entry) => entry.status === "scheduled");
    for (const row of open) {
      row.status = "cancelled";
      this.cancelledVia.set(row.id, "kill_switch");
    }
    return open.length;
  }

  async claim(id: string, claim: ApprovalClaim): Promise<ApprovalRow | null> {
    const row = this.rows.find((entry) => entry.id === id);
    if (!row || row.status !== "pending" || row.expiresAt <= claim.now) return null;
    row.status = claim.status;
    row.scope = claim.scope;
    return { ...row };
  }

  async finish(id: string, status: "executed" | "failed", result: Record<string, unknown>) {
    const row = this.rows.find((entry) => entry.id === id);
    if (row?.status === "approved") {
      row.status = status;
      this.results.set(id, result);
    }
  }

  async failApproved(result: Record<string, unknown>): Promise<ApprovalRow[]> {
    const hanging = this.rows.filter((entry) => entry.status === "approved");
    for (const row of hanging) {
      row.status = "failed";
      this.results.set(row.id, result);
    }
    return hanging.map((row) => ({ ...row }));
  }

  /** Like `decided_via` and `expired_answered_at` in Postgres. */
  expiredVia = new Map<string, "timeout" | "kill_switch">();
  expiredAnswered = new Set<string>();

  async expireDue(now: string): Promise<ApprovalRow[]> {
    const due = this.rows.filter((entry) => entry.status === "pending" && entry.expiresAt <= now);
    for (const row of due) {
      row.status = "expired";
      this.expiredVia.set(row.id, "timeout");
    }
    return due.map((row) => ({ ...row }));
  }

  async expireAllPending(): Promise<number> {
    const open = this.rows.filter((entry) => entry.status === "pending");
    for (const row of open) {
      row.status = "expired";
      this.expiredVia.set(row.id, "kill_switch");
    }
    return open.length;
  }

  async expiredByPreview(previewExternalId: string): Promise<ApprovalRow | null> {
    const row = this.rows
      .filter(
        (entry) =>
          (entry.previewExternalId === previewExternalId || entry.previewFileExternalIds.includes(previewExternalId)) &&
          entry.status === "expired" &&
          this.expiredVia.get(entry.id) === "timeout",
      )
      .sort((a, b) => b.expiresAt.localeCompare(a.expiresAt))[0];
    return row ? { ...row } : null;
  }

  async claimExpired(id: string): Promise<ApprovalRow | null> {
    const row = this.rows.find((entry) => entry.id === id);
    if (!row || row.status !== "expired" || this.expiredVia.get(id) !== "timeout" || this.expiredAnswered.has(id)) return null;
    this.expiredAnswered.add(id);
    return { ...row };
  }

  async countPending(now: string): Promise<number> {
    return this.rows.filter((entry) => entry.status === "pending" && entry.expiresAt > now).length;
  }

  async hasGrant(tool: string, grantKey: string): Promise<boolean> {
    return this.grants.some(
      (grant) => grant.tool === tool && grant.grantKey === grantKey && !grant.revoked,
    );
  }

  async addGrant(grant: { tool: string; grantKey: string }): Promise<void> {
    if (!(await this.hasGrant(grant.tool, grant.grantKey))) {
      this.grants.push({ tool: grant.tool, grantKey: grant.grantKey, revoked: false });
    }
  }

  async revokeGrants(): Promise<number> {
    const active = this.grants.filter((grant) => !grant.revoked);
    for (const grant of active) grant.revoked = true;
    return active.length;
  }
}
