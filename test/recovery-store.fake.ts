import type { NewTask, PendingInbound, RecoveryStore, RunningTask } from "../src/recovery/index.js";

/** `messages.turn_status` and `tasks` in memory, with the same conditional transitions as in Postgres (D52). */
export class FakeRecoveryStore implements RecoveryStore {
  /** Messages with status; `pendingInbound` returns the `pending` ones. */
  inbound: Array<PendingInbound & { status: "pending" | "done" | "abandoned" }> = [];
  tasks: Array<RunningTask & { status: "running" | "done" | "cancelled" | "interrupted" }> = [];
  private seq = 0;

  status(id: string): string | undefined {
    return this.inbound.find((row) => row.id === id)?.status;
  }

  async settleInbound(ids: readonly string[]): Promise<void> {
    for (const row of this.inbound) if (ids.includes(row.id) && row.status === "pending") row.status = "done";
  }

  async pendingInbound(peer: string): Promise<PendingInbound[]> {
    return this.inbound
      .filter((row) => row.status === "pending" && row.peer === peer)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(({ status: _status, ...row }) => ({ ...row }));
  }

  async abandonInbound(ids: readonly string[]): Promise<void> {
    for (const row of this.inbound) if (ids.includes(row.id) && row.status === "pending") row.status = "abandoned";
  }

  async startTask(task: NewTask): Promise<string> {
    const id = `task-${++this.seq}`;
    this.tasks.push({
      id,
      task: task.task,
      site: task.site ?? null,
      triggerMessageId: task.triggerMessageId || null,
      triggerExternalId: task.triggerExternalId,
      acked: task.acked,
      startedAt: new Date().toISOString(),
      status: "running",
    });
    return id;
  }

  async finishTask(id: string, status: "done" | "cancelled"): Promise<void> {
    const row = this.tasks.find((entry) => entry.id === id);
    if (row?.status === "running") {
      row.status = status;
      row.task = "";
    }
  }

  async runningTasks(): Promise<RunningTask[]> {
    return this.tasks.filter((row) => row.status === "running").map(({ status: _status, ...row }) => ({ ...row }));
  }

  async interruptTask(id: string): Promise<boolean> {
    const row = this.tasks.find((entry) => entry.id === id);
    if (row?.status !== "running") return false;
    row.status = "interrupted";
    row.task = "";
    return true;
  }
}
