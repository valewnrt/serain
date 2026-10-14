import { ownerDate, formatWallTime } from "../time.js";
import type { PendingItem } from "./trigger.js";
import { owner } from "../config/owner.js";

/**
 * "What is open, who is waiting for me?" from what the mail trigger has
 * already classified (`mail_items`, D33), instead of searching the mailbox
 * again (W3). Stored there are the digest, the commitment and the due date,
 * never the mail text.
 *
 * Pure selection and rendering, without a database: the tool reads the rows,
 * here it is decided what of it is still open.
 */

/** Read stored entries, with the commitment that a later entry changed. */
export interface MailItemReader {
  /** Classified entries (never `none`) received after `since`, newest first. */
  recent(since: Date, limit: number): Promise<PendingItem[]>;
}

export interface OpenItems {
  /** Someone expects a reaction (`urgent`). Newest first. */
  waiting: PendingItem[];
  /** Appointments, deadlines and changes to them. By due date, those without one last. */
  dates: PendingItem[];
}

/**
 * What is still open. A commitment that a later mail changed only counts as
 * that change: "appointment on Friday" and "appointment moved to Monday" are
 * one open item, not two.
 */
export function selectOpen(items: readonly PendingItem[]): OpenItems {
  const replaced = new Set(items.flatMap((item) => (item.changesItem ? [item.changesItem] : [])));
  const current = items.filter((item) => !replaced.has(item.id));
  const byReceived = (a: PendingItem, b: PendingItem) => b.receivedAt.localeCompare(a.receivedAt);
  const due = (item: PendingItem) => item.commitment?.due ?? "9999-99-99";
  return {
    waiting: current.filter((item) => item.category === "urgent").sort(byReceived),
    // A mail the owner was waiting for, without an appointment or deadline, has been reported and is not open.
    dates: current.filter((item) => item.category !== "urgent" && ((item.category !== "reply" && item.category !== "awaited") || item.commitment)).sort((a, b) => due(a).localeCompare(due(b)) || byReceived(a, b)),
  };
}

function itemLines(item: PendingItem, today: string, withAccount: boolean): string {
  const due = item.commitment?.due;
  return [
    `- ${item.sender || "(no sender)"}, ${formatWallTime(new Date(item.receivedAt))}${withAccount ? `, mailbox ${item.integrationId}` : ""}, subject "${item.subject || "(no subject)"}"`,
    `  ${item.summary}`,
    item.commitment ? `  Commitment: ${item.commitment.what}${item.commitment.when ? `, ${item.commitment.when}` : ""}` : "",
    due ? `  ${due < today ? "Was due" : "Due"}: ${due}` : "",
    item.previous ? `  Before: ${item.previous.what}${item.previous.when ? `, ${item.previous.when}` : ""}` : "",
    item.replied === true ? `  ${owner.name} has already replied in the thread.` : item.replied === false ? `  No reply from ${owner.name} in the thread yet.` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** The text for the model. The registry frames it as untrusted content. */
export function describeOpen(open: OpenItems, options: { days: number; now: Date; accounts: number }): string {
  const today = ownerDate(options.now);
  const many = options.accounts > 1;
  const sections = [
    open.waiting.length > 0 ? `Waiting for a reaction from ${owner.name}:\n${open.waiting.map((item) => itemLines(item, today, many)).join("\n")}` : "",
    open.dates.length > 0 ? `Appointments and deadlines:\n${open.dates.map((item) => itemLines(item, today, many)).join("\n")}` : "",
  ].filter(Boolean);
  const head = `Classified from the last ${options.days} days, without newsletters and bulk mail.`;
  if (sections.length === 0) return `${head} Nothing open.`;
  return [
    head,
    ...sections,
    `Whether ${owner.name} has replied is only noted for the newest ones waiting for them; what else they have taken care of is not listed here. If they ask about it, check with mail_search in the Sent folder.`,
  ].join("\n\n");
}
