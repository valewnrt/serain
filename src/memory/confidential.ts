import { MEMORY } from "../config/memory.js";
import { log } from "../log.js";
import { ConfidentialGuard } from "../security/confidential.js";
import type { MemoryDeps } from "./deps.js";

/**
 * The guard for confidential values (D29), built from everything the chat gets about the owner
 * in the prompt: user model, facts and the summaries (older ones too, which recall
 * fetches by closeness).
 * For the facts also the superseded ones, because an old address is still
 * an address. Throws if facts or summaries are not readable:
 * then no task starts (fail-closed), unlike recall, which carries on without
 * memory.
 */
export async function loadConfidentialGuard(deps: Pick<MemoryDeps, "store">, subject = "owner"): Promise<ConfidentialGuard> {
  const [userModel, facts, summaries] = await Promise.all([
    deps.store.userModel(),
    deps.store.allFactContents(subject),
    deps.store.recentSummaries(MEMORY.summaryGuardLimit),
  ]);
  const guard = ConfidentialGuard.from([userModel, ...facts, ...summaries.map((summary) => summary.content)]);
  if (guard.size === 0) log.warn("Confidential value guard is empty: memory holds nothing it recognizes.");
  return guard;
}
