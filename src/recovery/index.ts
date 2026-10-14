import type { InboundAttachment, InboundMessage } from "../channel/types.js";
import type { AttachmentReading } from "../media/attachments.js";
import { TASK_SCREENSHOT_LINE } from "../agent/tools/task.js";
import { owner } from "../config/owner.js";
import { formatWallTime } from "../time.js";
import { t } from "../i18n/catalog.js";
import { core } from "../i18n/messages/core.js";

/**
 * What a crash cuts off, the next start picks up (D52). A planned restart
 * waits for `work.json` (src/health/work.ts); a crash does not.
 *
 * - **The owner's message** is `pending` from `storeInbound` on and only
 *   becomes `done` when its turn is through or it was handled outside a turn
 *   (kill switch, decision, revoke). Whatever is still `pending` at start goes
 *   through the same pipeline once more, with a note on what the interrupted
 *   turn had already done. A turn that already did something with an effect is
 *   continued that way instead of repeated.
 * - **A task** is in `tasks` and `running` until its result turn is through.
 *   At start it is reported, never silently repeated: restarting research the
 *   owner may no longer ask about costs budget and sends a reply into the void
 *   (D14 does the same with confirmations).
 * - **A confirmation** that was running at the crash (`approved`) is reported,
 *   not caught up (D14). Only the report is new: whether the mail went out
 *   nobody knows afterwards, and the owner should not believe it did.
 */

export interface PendingInbound {
  id: string;
  channel: string;
  externalId: string;
  chatId: string;
  peer: string;
  isGroup: boolean;
  body: string;
  /** As stored: at first the channel's attachments, after reading what was read (D21). */
  attachments: unknown;
  raw: unknown;
  createdAt: string;
}

export interface RunningTask {
  id: string;
  task: string;
  site: string | null;
  triggerMessageId: string | null;
  triggerExternalId: string;
  acked: boolean;
  startedAt: string;
}

export interface NewTask {
  task: string;
  site?: string;
  triggerMessageId: string;
  triggerExternalId: string;
  acked: boolean;
}

export interface RecoveryStore {
  /** Turn through: `pending` becomes `done`. Never the other way round. */
  settleInbound(ids: readonly string[]): Promise<void>;
  /** Unanswered messages of this sender, oldest first. */
  pendingInbound(peer: string): Promise<PendingInbound[]>;
  /** Too old to catch up. */
  abandonInbound(ids: readonly string[]): Promise<void>;
  /** Returns the id. */
  startTask(task: NewTask): Promise<string>;
  /** Clears the task text: it is no longer needed. */
  finishTask(id: string, status: "done" | "cancelled"): Promise<void>;
  runningTasks(): Promise<RunningTask[]>;
  /** Atomically `running` → `interrupted`. False if it was no longer running. */
  interruptTask(id: string): Promise<boolean>;
}

/**
 * The message as the channel delivered it back then, from the row.
 * Attachments that were already read are not fetched again (that would not
 * work after a restart anyway): `readings` carries what was read. A voice
 * message is then already in `body`, an image stays foreign content.
 */
export function restoreInbound(row: PendingInbound): { message: InboundMessage; readings: AttachmentReading[] | null } {
  const raw = (row.raw ?? {}) as { reply_to?: unknown; attachments?: unknown };
  const stored = Array.isArray(row.attachments) ? (row.attachments as Array<Record<string, unknown>>) : [];
  const read = stored.filter(
    (entry) =>
      ((entry["kind"] === "image" || entry["kind"] === "voice") && typeof entry["text"] === "string") ||
      (entry["kind"] === "file" && typeof entry["id"] === "string" && typeof entry["name"] === "string" && typeof entry["size"] === "number"),
  );
  const original = Array.isArray(raw.attachments) ? (raw.attachments as InboundAttachment[]) : (stored as unknown as InboundAttachment[]);
  const message: InboundMessage = {
    channel: row.channel,
    externalId: row.externalId,
    from: row.peer,
    chatId: row.chatId,
    isGroup: row.isGroup,
    participants: [],
    text: row.body,
    replyToExternalId: typeof raw.reply_to === "string" ? raw.reply_to : "",
    attachments: original,
    receivedAt: new Date(row.createdAt),
    raw: row.raw,
  };
  // Images come into the turn framed; the voice message is already in `body`. A file shows
  // with its id; the shelf is empty after the restart, `mail_send` says so then.
  const readings: AttachmentReading[] | null =
    read.length > 0
      ? read.flatMap((entry): AttachmentReading[] =>
          entry["kind"] === "image"
            ? [{ status: "read", kind: "image", text: String(entry["text"]), truncated: false }]
            : entry["kind"] === "file"
              ? [
                  {
                    status: "file",
                    file: { id: String(entry["id"]), name: String(entry["name"]), mimeType: String(entry["mimeType"] ?? ""), size: Number(entry["size"]) },
                  },
                ]
              : [],
        )
      : null;
  return { message, readings };
}

/**
 * What the turn reads in addition to a caught-up message. Never the owner's
 * words, never into memory. `done` is the note from `renderActions` (`[done:
 * …]`): what the interrupted turn had already done with an effect.
 */
export function recoveredNote(receivedAt: Date, done: string): string {
  return [
    `[Caught up: this message arrived ${formatWallTime(receivedAt)}, your turn on it broke off at a restart.` +
      ` If you already wrote something to ${owner.name} about it, it is in the history.]`,
    ...(done ? [`${done} That already happened, do not do it again.`] : []),
  ].join("\n");
}

/**
 * What the second run reads about the owner's message (addendum D52 of
 * 2026-10-10). Never their word, never into memory. The first run had done
 * nothing with an effect, or there would be no second; what it got in between
 * is in the history.
 */
export function retriedNote(receivedAt: Date): string {
  return (
    `[Second attempt: this message arrived ${formatWallTime(receivedAt)}, your first turn on it failed with an error ` +
    `before you had done anything. ${owner.name} knows you are trying again; just answer now.]`
  );
}

/**
 * What the second run reads when the first one's reply did not arrive (in
 * full) (addendum D52 of 2026-10-13). Unlike `retriedNote`, the first run may
 * already have done something: `done` is the note from `renderActions`. What
 * arrived is in the history, what did not is not. Never the owner's word,
 * never memory.
 */
export function undeliveredNote(receivedAt: Date, done: string): string {
  return [
    `[Second attempt: this message arrived ${formatWallTime(receivedAt)}. Because of a disruption at iMessage your reply to it did not reach ` +
      `${owner.name}, or not in full; what arrived is in the history. Send them what is missing.]`,
    ...(done ? [`${done} That already happened, do not do it again.`] : []),
  ].join("\n");
}

/** This long may the task stand in the report to the owner; the rest is in the history of their question. */
const TASK_QUOTE_MAX = 120;

/** The task as the owner reads it in the report: without the code's line for the screenshot, cut at a word. */
function quotedTask(text: string): string {
  const plain = text
    .split("\n")
    .filter((line) => line.trim() !== TASK_SCREENSHOT_LINE)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (plain.length <= TASK_QUOTE_MAX) return plain;
  const cut = plain.slice(0, TASK_QUOTE_MAX);
  const space = cut.lastIndexOf(" ");
  return `${(space > TASK_QUOTE_MAX / 2 ? cut.slice(0, space) : cut).replace(/[\s,.;:]+$/u, "")}…`;
}

/**
 * The report to the owner, in their language, wording from the style round
 * (addendum D23 of 2026-10-10). "again" is no pattern in the code: the chat
 * turn reads the report in the history, right before its reply, and then
 * restarts the task itself. Nothing is repeated silently (D52).
 */
export function interruptedTaskReport(task: Pick<RunningTask, "task" | "site">): string {
  return task.site ? t(core.taskInterruptedSession, { site: task.site }) : t(core.taskInterruptedResearch, { task: quotedTask(task.task) });
}

/** Trigger of the turn that reports an interrupted task. */
export function interruptedTaskPrompt(task: RunningTask): string {
  return [
    `Your background task "${task.task}" from ${formatWallTime(new Date(task.startedAt))} was cut off: Serain was restarted in the middle of it.`,
    "It does not run again by itself, and there is no result.",
    `Tell ${owner.name} exactly this sentence with reply_in_thread, nothing more: "${interruptedTaskReport(task)}"`,
    `Do not restart it; if ${owner.name} asks for it again, you restart it in their turn.`,
  ].join("\n");
}

/** Trigger of the turn that reports a confirmation that was running at the crash (D14). */
export function interruptedApprovalPrompt(approval: { tool: string; preview: string }): string {
  return [
    `${owner.name} had confirmed this preview: "${approval.preview}"`,
    `While the tool ${approval.tool} was running, Serain was restarted. Whether it went through, nobody knows.`,
    "It is not repeated: better not at all than twice.",
    `Tell ${owner.name} that in one sentence, so they check themselves.`,
  ].join("\n");
}
