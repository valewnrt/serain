import { MEMORY } from "../config/memory.js";
import { audit } from "../db/audit.js";
import { log } from "../log.js";
import { UNTRUSTED_TURN_PLACEHOLDER } from "./context.js";
import type { MemoryDeps } from "./deps.js";

/**
 * Rolling summaries (D6).
 *
 * Triggered not by time of day but by messages falling out of the
 * history window: what the model no longer sees in the history it should see
 * as a summary. Otherwise there would be a gap between "last 20 messages" and
 * "permanent fact" into which every arrangement falls that is neither one
 * nor the other.
 *
 * Duplicates with the facts are avoided by the summary knowing the
 * facts already stored and being told to leave them out. A fact that is in
 * both would be in the prompt twice and on forgetting (W7) would only
 * disappear in one place.
 *
 * **The cursor is read twice (live test 2026-09-18).** Between reading
 * `lastSummaryEnd()` and writing there is a model call, so
 * double-digit seconds. Two post-turn runs both read the same cursor in exactly
 * this window and wrote two overlapping summaries: same `window_start`,
 * different `window_end`, 16 and 12 messages, the smaller a true subset of the
 * larger. The actual bolt is the serialization of the post-turn pass
 * (`afterTurn` in `index.ts`); the second look at the cursor right before writing
 * is the belt on top and also holds when two processes briefly run during a deploy.
 */
export async function rollUpSummaries(deps: MemoryDeps): Promise<boolean> {
  const cursor = await deps.store.lastSummaryEnd();
  const messages = await deps.store.messagesAfter(
    cursor,
    MEMORY.historyLimit + MEMORY.summaryMaxMessages,
  );

  // Everything that no longer fits into the history window waits for a summary.
  const pending = messages.length - MEMORY.historyLimit;
  if (pending < MEMORY.summaryMinMessages) return false;

  const batch = messages.slice(0, Math.min(pending, MEMORY.summaryMaxMessages));
  const first = batch[0];
  const last = batch[batch.length - 1];
  if (!first || !last) return false;

  // The superseded versions too: otherwise the summary writes the old
  // address back into the context after the fact has long been corrected (W8).
  const knownFacts = await deps.store.allFactContents();
  // What Serain wrote after untrusted content does not go into the
  // summary (D8.4, addendum 2026-10-02). It sits as `<memory>`
  // in the system prompt, unframed and permanently; a framing a model is
  // supposed to respect while summarizing would no longer be a boundary there. Replaced in
  // code, before the model, so it does not depend on the request in the prompt.
  const content = await deps.summarize({
    messages: batch.map((message) =>
      message.fromUntrusted ? { ...message, body: UNTRUSTED_TURN_PLACEHOLDER } : message,
    ),
    knownFacts,
  });

  let embedding: number[] | null = null;
  try {
    const [vector] = await deps.embed([content]);
    embedding = vector ?? null;
  } catch (error) {
    log.warn("Summary without embedding:", (error as Error).message);
  }

  // If someone else has summarized in the meantime, this window is stale.
  // Writing it would put the same section into the context a second time,
  // and in an older, shorter version at that.
  const cursorNow = await deps.store.lastSummaryEnd();
  if (cursorNow !== cursor) {
    await audit("memory_summary", {
      skipped: "cursor_moved",
      window_start: first.createdAt,
      window_end: last.createdAt,
      cursor_before: cursor,
      cursor_now: cursorNow,
    });
    log.warn("Summary discarded: the cursor moved during the run");
    return false;
  }

  await deps.store.insertSummary({
    windowStart: first.createdAt,
    windowEnd: last.createdAt,
    content,
    messageCount: batch.length,
    embedding,
  });

  await audit("memory_summary", {
    messages: batch.length,
    window_start: first.createdAt,
    window_end: last.createdAt,
    chars: content.length,
  });
  return true;
}
