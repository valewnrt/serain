import { judge } from "../agent/judge/index.js";
import { MEMORY } from "../config/memory.js";
import { env } from "../config/env.js";
import { audit } from "../db/audit.js";
import { log } from "../log.js";
import type { MemoryDeps } from "./deps.js";
import { embed } from "./embeddings.js";
import { classifyFactAreas, consolidateUserModel, extractFacts, selectForgottenFacts, selectUserModelLines, summarize } from "./extract.js";
import { markerKeyFrom } from "./markers.js";
import { memoryStore } from "./store.js";
import { rollUpSummaries } from "./summaries.js";
import { rememberOwnerTurn, type RememberInput } from "./write.js";

export type { MemoryDeps } from "./deps.js";
export { buildMemoryContext, renderMemory, markQuestionShown, EMPTY_CONTEXT } from "./recall.js";
export type { MemoryContext } from "./recall.js";
export { rememberOwnerTurn } from "./write.js";
export { rollUpSummaries } from "./summaries.js";
export { maybeConsolidate } from "./consolidate.js";
export { maybeClassifyAreas } from "./areas.js";

let shared: MemoryDeps | null = null;

/** The wiring for production. Tests build their own deps. */
export function defaultMemoryDeps(): MemoryDeps {
  shared ??= {
    store: memoryStore(),
    judge: judge(),
    embed,
    extractFacts,
    summarize,
    selectLines: selectUserModelLines,
    selectFacts: selectForgottenFacts,
    consolidate: consolidateUserModel,
    classifyAreas: classifyFactAreas,
    markerKey: markerKeyFrom(env.integrationKey),
    now: () => new Date(),
  };
  return shared;
}

/**
 * The post-turn pass runs sequentially for the one conversation there is.
 *
 * The reason is a finding from the live test of 2026-09-18: the post-turn pass is
 * started per turn and not awaited (`Runtime.track`), so two runs overlap as soon
 * as the owner writes faster than a model call takes. Both read the same summary
 * cursor and wrote two overlapping windows. The same flaw would have hit fact
 * writing too: two runs searching for candidates at the same time do not see
 * each other's fact and create it a second time instead of superseding it.
 *
 * A chain instead of a lock, because the order matters: turns should be
 * learned in the order in which they happened.
 *
 * D10 provides for exactly one long-lived process, so this is enough. For
 * the window in which a deploy briefly has two processes, `rollUpSummaries`
 * additionally checks the cursor right before writing.
 */
let chain: Promise<void> = Promise.resolve();

/**
 * What happens after a turn when nobody is waiting anymore: learn facts and
 * summarize if needed.
 *
 * Deliberately after the reply and deliberately with its own error handling: a
 * memory that blocks the chat or drags it down when it fails itself
 * would be worse than none. The caller gets a promise so that a
 * shutdown can still wait for it instead of cutting the work off half done.
 */
export function afterTurn(input: RememberInput & { deps?: MemoryDeps }): Promise<void> {
  return afterMemory(() => runAfterTurn(input));
}

/**
 * Appends work to the same chain as the post-turn pass. That way consolidation never
 * runs next to a fact writer: it reads "what is new since the cursor" and
 * advances the cursor afterwards; a fact from the meantime would otherwise slip through.
 */
export function afterMemory<T>(work: () => Promise<T>): Promise<T> {
  const run = chain.then(work);
  // The chain must not get stuck on an error; it is reported to the caller.
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function runAfterTurn(input: RememberInput & { deps?: MemoryDeps }): Promise<void> {
  const deps = input.deps ?? defaultMemoryDeps();
  try {
    await rememberOwnerTurn(deps, input);
  } catch (error) {
    await audit("memory_error", { stage: "remember", reason: (error as Error).message }, input.messageId);
    log.error("Memory write path failed:", error);
  }
  try {
    await rollUpSummaries(deps);
  } catch (error) {
    await audit("memory_error", { stage: "summary", reason: (error as Error).message });
    log.error("Summary failed:", error);
  }
  try {
    await embedPendingMessages(deps);
  } catch (error) {
    // Without a vector the message stays findable via full-text search (V3).
    log.warn("Messages without vector:", (error as Error).message);
  }
}

/**
 * Vectors for the history (V3, D41). `messages.embedding` has existed since 0001 and
 * was never written; now every post-turn pass catches up on what is missing, including
 * messages from turns without the owner (heartbeat, results). One call for all,
 * capped, so that a backlog is not cleared in one go.
 */
export async function embedPendingMessages(deps: MemoryDeps): Promise<number> {
  const pending = await deps.store.messagesWithoutEmbedding(MEMORY.historyEmbedBatch);
  if (pending.length === 0) return 0;
  const vectors = await deps.embed(pending.map((message) => message.body.slice(0, MEMORY.historyEmbedMaxChars)));
  let written = 0;
  for (const [index, message] of pending.entries()) {
    const vector = vectors[index];
    if (!vector) continue;
    await deps.store.setMessageEmbedding(message.id, vector);
    written += 1;
  }
  return written;
}
