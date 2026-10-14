import { db } from "./client.js";
import type { NewTask, PendingInbound, RecoveryStore, RunningTask } from "../recovery/index.js";

/** `messages.turn_status` and `tasks` from 0019_recovery.sql (D52). */
export const recoveryStore: RecoveryStore = {
  async settleInbound(ids) {
    if (ids.length === 0) return;
    const { error } = await db
      .from("messages")
      .update({ turn_status: "done" })
      .in("id", [...ids])
      .eq("turn_status", "pending");
    if (error) throw new Error(`Turn not settled: ${error.message}`);
  },

  async pendingInbound(peer) {
    const { data, error } = await db
      .from("messages")
      .select("id, channel, external_id, chat_id, peer, is_group, body, attachments, raw, created_at")
      .eq("direction", "inbound")
      .eq("peer", peer)
      .eq("turn_status", "pending")
      .order("created_at", { ascending: true })
      .limit(50);
    if (error) throw new Error(`Pending messages not readable: ${error.message}`);
    return (data ?? []).map(
      (row): PendingInbound => ({
        id: row.id as string,
        channel: row.channel as string,
        externalId: row.external_id as string,
        chatId: row.chat_id as string,
        peer: row.peer as string,
        isGroup: row.is_group as boolean,
        body: row.body as string,
        attachments: row.attachments,
        raw: row.raw,
        createdAt: row.created_at as string,
      }),
    );
  },

  async abandonInbound(ids) {
    if (ids.length === 0) return;
    const { error } = await db
      .from("messages")
      .update({ turn_status: "abandoned" })
      .in("id", [...ids])
      .eq("turn_status", "pending");
    if (error) throw new Error(`Pending messages not abandoned: ${error.message}`);
  },

  async startTask(task: NewTask) {
    const { data, error } = await db
      .from("tasks")
      .insert({
        task: task.task,
        site: task.site ?? null,
        trigger_message_id: task.triggerMessageId || null,
        trigger_external_id: task.triggerExternalId,
        acked: task.acked,
      })
      .select("id")
      .single();
    if (error) throw new Error(`Task not saved: ${error.message}`);
    return (data as { id: string }).id;
  },

  async finishTask(id, status) {
    const { error } = await db
      .from("tasks")
      .update({ status, task: "", finished_at: new Date().toISOString() })
      .eq("id", id)
      .eq("status", "running");
    if (error) throw new Error(`Task not finished: ${error.message}`);
  },

  async runningTasks() {
    const { data, error } = await db
      .from("tasks")
      .select("id, task, site, trigger_message_id, trigger_external_id, acked, started_at")
      .eq("status", "running")
      .order("started_at", { ascending: true });
    if (error) throw new Error(`Running tasks not readable: ${error.message}`);
    return (data ?? []).map(
      (row): RunningTask => ({
        id: row.id as string,
        task: row.task as string,
        site: (row.site as string | null) ?? null,
        triggerMessageId: (row.trigger_message_id as string | null) ?? null,
        triggerExternalId: row.trigger_external_id as string,
        acked: row.acked as boolean,
        startedAt: row.started_at as string,
      }),
    );
  },

  async interruptTask(id) {
    const { data, error } = await db
      .from("tasks")
      .update({ status: "interrupted", task: "", finished_at: new Date().toISOString() })
      .eq("id", id)
      .eq("status", "running")
      .select("id");
    if (error) throw new Error(`Task not marked as interrupted: ${error.message}`);
    return (data ?? []).length === 1;
  },
};
