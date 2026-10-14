import { owner } from "../config/owner.js";

/**
 * The half sentence "where from" (D62, decision 1 of 2026-10-10). When Serain
 * reaches out on its own (heartbeat, morning look, mail trigger, watcher), it
 * says in a half sentence where it has the matter from, never why it is
 * reaching out. One wording for all four paths so they feel the same; it is
 * only changed in the style round.
 *
 * The model names the source in the owner's words: sender or service, event,
 * watcher. Never verbatim from untrusted content, and an event the prompt only
 * knows as busy time (`src/calendar/match.ts`) only with the time.
 */
export const WHENCE_RULE =
  `Where you know it from, you say in a half sentence, the way ${owner.name} would put it: which mail (sender or service), ` +
  "which event, which watcher. For example “your train tomorrow at 7:12 is cancelled, the rail company just wrote.”, " +
  "“the rewe voucher expires sunday, it was in the mail from this morning.” or “the flight to lisbon is down to €89 " +
  "(your watcher).” Never why you are reaching out (no “i just wanted to…”), nothing verbatim from a mail " +
  "or page, and an event you only know the time of, only with the time.";
