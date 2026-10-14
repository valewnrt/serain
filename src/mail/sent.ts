import type { MailMessage } from "./types.js";

/**
 * What Serain has sent (addendum D33 of 2026-10-13). When the owner has Serain
 * send a ticket request, the answer often only comes the next morning and would
 * fall through as "unimportant", because `judge` only sees a polite
 * confirmation. Whoever has Serain send a mail has handed the matter over and
 * is waiting for the answer. That is why the code remembers the `Message-ID` of
 * every mail from `mail_send`, and the mail trigger always reports a reply to it.
 *
 * Recognised only by the header (`References`, `In-Reply-To`), never by the
 * subject: anyone can write "Re: …", but not the identifier of a mail that
 * only the recipient received.
 */
export interface SentMailStore {
  /** After sending. Throws if it is not stored; the mail is out regardless. */
  record(integrationId: string, messageId: string, at: Date): Promise<void>;
  /** Is one of these identifiers a mail that Serain has sent since `since`? */
  ours(messageIds: readonly string[], since: Date): Promise<boolean>;
}

/** At most this many identifiers from a thread, the most recent: a long chain is no reason for a long query. */
const MAX_IDS = 20;

/** `<id@host>`, without whitespace. Empty if nothing is left. */
export function normalizeMessageId(value: string): string {
  const inner = value.trim().replace(/^<+|>+$/g, "").trim();
  return inner && !/\s/.test(inner) ? `<${inner}>` : "";
}

/** The identifiers a mail replies to: `References` and, where the adapter has it, the thread (`In-Reply-To`). */
export function repliedIds(mail: Pick<MailMessage, "references" | "threadKey" | "messageId">): string[] {
  const own = normalizeMessageId(mail.messageId);
  const ids = [...mail.references, mail.threadKey].map(normalizeMessageId).filter((id) => id && id !== own);
  return [...new Set(ids)].slice(-MAX_IDS);
}
