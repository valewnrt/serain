import { FEEDBACK_QUOTE_MAX_CHARS } from "../config/limits.js";
import { owner } from "../config/owner.js";
import { wrapDerived } from "../security/untrusted.js";

/**
 * The owner's tapbacks on Serain's own messages (W24, D24). Three meanings,
 * decided by a table and never by the model:
 *
 * - 👎 is a **correction signal**, not an abort. A model likes to apologise for
 *   it and then say the same thing again; the second attempt has to bring new
 *   information.
 * - ❓ means "I don't understand that" or "I don't believe that".
 * - Everything else (👍, ❤️, 😂, ‼️, free emoji) is an acknowledgement. Nobody
 *   answers it; it stands in the next turn as a note in the history.
 */
export type ReactionMeaning = "correction" | "question" | "note";

export function reactionMeaning(emoji: string): ReactionMeaning {
  if (emoji === "👎") return "correction";
  if (emoji === "❓") return "question";
  return "note";
}

/**
 * The quote of the message the tapback sits on. If it was derived from
 * untrusted content (`taintSources`), it is framed as in the history (D8.4):
 * otherwise a 👎 brings exactly the text a mail dictated back as the owner's
 * cause.
 */
function quote(body: string, taintSources: readonly string[] = []): string {
  const flat = body.replace(/\s+/g, " ").trim();
  const short = flat.length > FEEDBACK_QUOTE_MAX_CHARS ? `${flat.slice(0, FEEDBACK_QUOTE_MAX_CHARS)}…` : flat;
  return taintSources.length > 0 ? wrapDerived(short, taintSources) : short;
}

/** One line for the history, or for a turn the tapback falls into. */
export function reactionNote(emoji: string, body?: string, taintSources: readonly string[] = []): string {
  return body
    ? `[tapback from ${owner.name}: ${emoji} on “${quote(body, taintSources)}”]`
    : `[tapback from ${owner.name}: ${emoji}]`;
}

/** What the model reads as the trigger when a 👎 or ❓ gets a turn of its own. */
export function feedbackPrompt(
  meaning: Exclude<ReactionMeaning, "note">,
  emoji: string,
  body: string,
  taintSources: readonly string[] = [],
): string {
  const head = `${owner.name} put ${emoji} on your message: “${quote(body, taintSources)}”`;
  if (meaning === "question") {
    return [
      head,
      "They don't understand the message or don't believe it. Say with reply_in_thread in one or two",
      "sentences what you meant or what it rests on. Don't repeat the message.",
    ].join("\n");
  }
  return [
    head,
    "That is a correction signal, not an abort. Don't say the same thing again in other words: your",
    "second attempt must contain something new. If you see in the history what was wrong, correct it with",
    "reply_in_thread. If you don't see it, ask in one sentence what didn't fit. The 👎 came just now,",
    `even if the conversation has moved on since: silence would look to ${owner.name} as if you had`,
    "overlooked them. The turn ends without a message only if the message was a reminder.",
  ].join("\n");
}
