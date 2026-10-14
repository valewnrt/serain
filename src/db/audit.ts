import { db } from "./client.js";
import { log } from "../log.js";

/**
 * Append-only audit (D8.6). Every message, every rejection, every tool call.
 * Never writes a secret value; `detail` contains only what the caller passes.
 */
export type AuditEvent =
  | "inbound"
  /** Which voice spoke a voice message and why not the one via OpenRouter (addendum D59). Never with text. */
  | "voice_synth"
  | "inbound_rejected"
  | "inbound_duplicate"
  | "inbound_reaction"
  | "feedback"
  | "reaction_feedback"
  | "outbound"
  | "outbound_duplicate"
  | "outbound_failed"
  | "outbound_reaction"
  | "outbound_edit"
  | "outbound_ack"
  | "outbound_status"
  | "kill_switch"
  | "kill_switch_release"
  | "model_call"
  | "model_fallback"
  | "tool_call"
  | "tool_denied"
  | "turn_limit"
  | "turn_text_fallback"
  | "turn_preempted"
  | "turn_steered"
  | "turn_steer_returned"
  | "turn_follow_up"
  | "budget_warning"
  | "approval_requested"
  | "approval_decided"
  | "approval_denied"
  | "approval_expired"
  | "approval_grant"
  | "approval_grant_used"
  /** Ran without a preview: the code proved that the owner asked for it in this message themselves (addendum D8). */
  | "approval_waived"
  | "approval_revoked"
  /** Was running during a crash; reported at startup, not caught up (D52). */
  | "approval_interrupted"
  /** "yes, but later" (addendum D14 of 2026-10-08): scheduled, refused, cancelled, due, missed. */
  | "approval_scheduled"
  | "approval_later_refused"
  | "approval_cancelled"
  | "approval_due"
  | "approval_missed"
  /** 👍 on an expired preview (addendum D8 of 2026-10-10): freshly reissued, or why not. */
  | "approval_reissued"
  | "approval_reissue_refused"
  | "task_started"
  | "task_finished"
  | "task_cancelled"
  /** A task's result turn sent the owner nothing; the code did so with a fixed sentence. */
  | "task_report_fallback"
  /** The list to choose from came with none of the turn's messages; the code sent it on its own. */
  | "task_picks_fallback"
  /** The result turn failed before it did anything: it waits (`waiting`) and runs once more (`again`). */
  | "task_result_retry"
  /** The owner's code for a login, intercepted and put into the field (D56). Without the code. */
  | "site_code"
  /** Was running during a crash; reported at startup, never silently repeated (D52). */
  | "task_interrupted"
  /** A message from the owner whose turn a crash interrupted, caught up at startup (D52). */
  | "turn_recovered"
  /** Too old to catch up (D52). */
  | "turn_abandoned"
  /**
   * The turn on a message from the owner failed before it did anything with an effect (addendum D52 of 2026-10-10):
   * `waiting` (with `due_at`, by which a restart finds it), `recovered`, `again` (the second run begins).
   * With `reason: "undelivered"`: the turn ran through, its reply did not arrive (addendum D52 of 2026-10-13).
   */
  | "turn_retry"
  /** The reply did not (fully) arrive and there is no second run left: the message is settled anyway (addendum D52 of 2026-10-13). */
  | "turn_undelivered"
  | "schedule_created"
  | "schedule_cancelled"
  | "schedule_fired"
  /** The query returned a schedule before its time; the poller left it alone. Must never happen. */
  | "schedule_early_skipped"
  | "schedule_failed"
  /** A one-off reminder did not arrive even after the last attempt and waits to be delivered late. */
  | "schedule_missed"
  /** Delivered late, after something got through the channel again. */
  | "schedule_missed_delivered"
  | "schedule_missed_retry_failed"
  | "schedule_recovered"
  /** Delivered but not settled; the poller retries only the settling, never the delivery. */
  | "schedule_settle_failed"
  | "schedule_settled"
  | "heartbeat"
  | "attachment"
  | "integration_connected"
  | "integration_disconnected"
  // Connections from the web interface (D51). `connector_requested` and
  // `connector_disconnect_requested` are written by the database function itself.
  | "connector_connected"
  | "connector_failed"
  | "connector_disconnected"
  | "mail_trigger"
  | "mail_classified"
  | "mail_finding"
  | "mail_finding_dropped"
  /** `mail_send` sent but did not record the identifier: Serain then does not report the reply by itself (addendum D33 of 2026-10-13). */
  | "mail_sent_unrecorded"
  /** Missions (D63, building block B): started, noted, closed, forgotten, woken; a wake above the daily cap; a missing check replaced at startup. */
  | "mission_started"
  | "mission_noted"
  | "mission_closed"
  | "mission_forgotten"
  | "mission_wake"
  | "mission_wake_capped"
  | "mission_rescheduled"
  | "judge_fallback"
  | "memory_seed"
  | "memory_gate"
  | "memory_fact"
  | "memory_conflict"
  | "memory_question"
  | "memory_forget"
  | "memory_summary"
  | "memory_error"
  | "memory_backfill"
  | "memory_consolidation"
  | "memory_user_model"
  | "memory_proposal"
  | "memory_areas"
  | "watcher"
  | "delivery_health"
  | "integration_health"
  | "channel_connected"
  | "channel_disconnected"
  | "hello"
  | "selftest"
  | "startup"
  | "shutdown"
  | "error";

let currentActor = "serain";

/**
 * Who is writing to the audit log right now? In operation that stays "serain".
 * The eval harness (`eval/`) sets "eval" before it runs turns: there, real tool
 * calls go through the same registry but never go out to the owner. Without
 * the distinction, eval runs in the security log could not be told apart from
 * real calls. The `actor` column exists exactly for that.
 */
export function setAuditActor(actor: string): void {
  currentActor = actor.trim() || "serain";
}

export async function audit(
  event: AuditEvent,
  detail: Record<string, unknown> = {},
  messageId?: string,
): Promise<void> {
  const { error } = await db.from("audit_log").insert({
    event,
    actor: currentActor,
    // An empty string is not an ID: `message_id` is a uuid with a foreign key,
    // "" would lose the whole entry.
    message_id: messageId || null,
    detail,
  });
  if (error) {
    // A failed audit entry must not kill the turn, but it has to be visible.
    log.error("audit_log insert failed:", error.message, "event:", event);
  }
}

export interface ToolAction {
  messageId: string;
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  result: string;
  /** `ToolResult.ref` if the tool named an identifier. Also in `result`, but there behind text that gets truncated. */
  ref?: string;
}

/**
 * What Serain did for these messages, oldest action first. Source for the
 * history (D4): a turn that consisted only of a tapback and a tool call leaves
 * nothing in `messages`, but everything in the audit log.
 */
export async function toolActionsFor(
  messageIds: readonly string[],
  tools: readonly string[],
): Promise<ToolAction[]> {
  if (messageIds.length === 0 || tools.length === 0) return [];
  const { data, error } = await db
    .from("audit_log")
    .select("message_id, detail")
    .eq("event", "tool_call")
    .eq("actor", "serain")
    .in("message_id", [...messageIds])
    .in("detail->>tool", [...tools])
    .order("id", { ascending: true });
  if (error) throw new Error(`Actions not readable: ${error.message}`);
  const actions = (data ?? []).map((row) => {
    const detail = row.detail as Record<string, unknown>;
    return {
      messageId: String(row.message_id),
      tool: String(detail["tool"] ?? ""),
      args: (detail["args"] as Record<string, unknown> | undefined) ?? {},
      ok: detail["ok"] === true,
      result: String(detail["result"] ?? detail["error"] ?? ""),
      ...(typeof detail["ref"] === "string" ? { ref: detail["ref"] } : {}),
    };
  });
  if (!actions.some((action) => action.tool === "run_task")) return actions;

  const cancelled = await db
    .from("audit_log")
    .select("event, message_id")
    .in("event", ["task_cancelled", "task_interrupted"])
    .eq("actor", "serain")
    .in("message_id", [...messageIds]);
  if (cancelled.error) throw new Error(`Actions not readable: ${cancelled.error.message}`);
  const ended = cancelled.data ?? [];
  return markCancelledTasks(
    actions,
    ended.filter((row) => row.event === "task_cancelled").map((row) => String(row.message_id)),
    ended.filter((row) => row.event === "task_interrupted").map((row) => String(row.message_id)),
  );
}

/** A waiting second run. `undelivered`: the first ran through, only its reply did not arrive (addendum D52 of 2026-10-13). */
export interface TurnRetryMark {
  dueAt: string;
  ran: boolean;
  undelivered: boolean;
}

/**
 * Which of these messages are waiting for their second run (addendum D52 of
 * 2026-10-10): when it is due and whether it has already started. No column of
 * its own, because the audit log carries the marker anyway and is append-only.
 */
export async function turnRetriesFor(messageIds: readonly string[]): Promise<Map<string, TurnRetryMark>> {
  const byId = new Map<string, TurnRetryMark>();
  if (messageIds.length === 0) return byId;
  const { data, error } = await db
    .from("audit_log")
    .select("message_id, detail")
    .eq("event", "turn_retry")
    .eq("actor", "serain")
    .in("message_id", [...messageIds])
    .order("id", { ascending: true });
  if (error) throw new Error(`Second runs not readable: ${error.message}`);
  for (const row of data ?? []) {
    const id = String(row.message_id);
    const detail = row.detail as Record<string, unknown>;
    const known = byId.get(id);
    if (detail["stage"] === "waiting" && typeof detail["due_at"] === "string") {
      byId.set(id, { dueAt: detail["due_at"], ran: known?.ran ?? false, undelivered: detail["reason"] === "undelivered" });
    }
    else if (detail["stage"] === "again" && known) known.ran = true;
  }
  return byId;
}

/**
 * A cancelled task never reports back: no result turn, no message. Without
 * this correction the history would say "research running in the background"
 * forever; in a live test on 2026-09-20 the heartbeat still considered a
 * weather research underway three hours after "serain stop".
 */
export function markCancelledTasks(
  actions: readonly ToolAction[],
  cancelledMessageIds: readonly string[],
  interruptedMessageIds: readonly string[] = [],
): ToolAction[] {
  const cancelled = new Set(cancelledMessageIds);
  // A crash cancels just like the stop (D52); that is reported at startup.
  const interrupted = new Set(interruptedMessageIds);
  return actions.map((action) => {
    if (action.tool !== "run_task" || !action.ok) return action;
    if (cancelled.has(action.messageId)) return { ...action, ok: false, result: "Research was cancelled (stop) and never came back." };
    if (interrupted.has(action.messageId)) return { ...action, ok: false, result: "Research broke off during a restart and never came back." };
    return action;
  });
}

/**
 * Tapbacks currently on these messages (W24). The source is the audit log:
 * every incoming tapback is recorded there with target, emoji and whether it
 * was set or removed. The latest state per emoji applies.
 */
export async function reactionsFor(externalIds: readonly string[]): Promise<Map<string, string[]>> {
  const current = new Map<string, Set<string>>();
  if (externalIds.length === 0) return new Map();
  const { data, error } = await db
    .from("audit_log")
    .select("detail")
    .eq("event", "inbound_reaction")
    .in("detail->>external_id", [...externalIds])
    .order("id", { ascending: true });
  if (error) throw new Error(`Tapbacks not readable: ${error.message}`);
  for (const row of data ?? []) {
    const detail = row.detail as Record<string, unknown>;
    const target = String(detail["external_id"] ?? "");
    const emoji = String(detail["emoji"] ?? "");
    if (!target || !emoji) continue;
    const set = current.get(target) ?? new Set<string>();
    if (detail["removed"] === true) set.delete(emoji);
    else set.add(emoji);
    current.set(target, set);
  }
  return new Map([...current].filter(([, set]) => set.size > 0).map(([id, set]) => [id, [...set]]));
}

/** Origin of the turn that sent this message (`detail.origin` on the `outbound` entry). */
export async function outboundOrigin(messageId: string): Promise<string | null> {
  const { data, error } = await db
    .from("audit_log")
    .select("detail")
    .eq("event", "outbound")
    .eq("message_id", messageId)
    .order("id", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Origin not readable: ${error.message}`);
  const origin = (data?.detail as Record<string, unknown> | undefined)?.["origin"];
  return typeof origin === "string" ? origin : null;
}

/** How many entries of this event the audit log has since the given time, without eval. */
export async function countAuditSince(event: AuditEvent, since: Date): Promise<number> {
  const { count, error } = await db
    .from("audit_log")
    .select("id", { count: "exact", head: true })
    .eq("event", event)
    .neq("actor", "eval")
    .gte("at", since.toISOString());
  if (error) throw new Error(`Audit log not countable: ${error.message}`);
  return count ?? 0;
}
