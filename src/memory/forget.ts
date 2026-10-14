import { MEMORY } from "../config/memory.js";
import { audit } from "../db/audit.js";
import { withoutLines } from "./consolidate-rules.js";
import type { MemoryDeps } from "./deps.js";
import { distinctiveTokens, markerFor, normalizedWords } from "./markers.js";
import { pruneVersions } from "./consolidate.js";
import type { ActiveFact, FactCandidate } from "./store.js";

/**
 * Forgetting beyond the one fact (addendum D45). Finding from forget-02 of
 * 2026-10-02: "rented the flat at lindenallee 4" became two facts ("has
 * rented", "lives in"), and the parking-space fact mentioned the address too.
 * `forget_fact` deleted exactly one of them, once the parking space instead of
 * the flat, and the address was still there afterwards.
 *
 * Procedure: the target (unambiguous after `resolveForgetTarget` or chosen by
 * the owner) always goes. Besides, the code searches nearby facts, by the
 * information and by the target, and a model names those that carry the
 * information; in addition every fact with at least two distinctive words
 * from information and target goes (like for the user model, D40). Another
 * fact that contains something independent besides stays, trimmed: the rest
 * comes from the model, the code only takes it if it contains nothing but
 * words of the old fact and no distinctive word from information or target.
 * Otherwise the fact goes entirely. The target itself is never trimmed: it is
 * what the owner meant, and "pills against migraine" without "against
 * migraine" left the name of the medication standing (memory eval,
 * forget-03). If it would hit more than `forgetMaxRelatedFacts` others,
 * nothing happens, and Serain asks back. Trimming means deleting (chain,
 * summaries) and creating anew, in this order: if creating fails, more is
 * gone than necessary, never less.
 */
export interface FactForget {
  /** Deleted rows in `facts`, replacement chains and trimmed facts included. */
  deleted: number;
  /** Facts that live on without the information. */
  trimmed: number;
  /** Wording of the entirely deleted facts, for user model and markers. */
  removedContents: string[];
  /** Too many other facts: nothing is deleted, the facts go back to the owner as a question. */
  tooMany: string[] | null;
}

export async function forgetFacts(
  deps: MemoryDeps,
  input: { what: string; target: ActiveFact | FactCandidate; subject: string; allowMany: boolean },
): Promise<FactForget> {
  const { what, target } = input;
  let vectors: Array<number[] | null> = [null, null];
  try {
    const embedded = await deps.embed([what, target.content]);
    vectors = [embedded[0] ?? null, embedded[1] ?? null];
  } catch {
    // Without a vector the full text remains. An embedding outage must not prevent forgetting.
  }
  const now = deps.now().toISOString();
  const pool = new Map<string, FactCandidate>();
  for (const embedding of vectors) {
    const hits = await deps.store.searchFacts({
      subject: input.subject,
      embedding,
      query: what,
      limit: MEMORY.forgetRelatedLimit,
      now,
      includeExpired: true,
    });
    for (const hit of hits) pool.set(hit.id, hit);
  }
  pool.delete(target.id);
  const others = [...pool.values()];
  const facts = [target, ...others];

  const picked = new Map<number, string | null>();
  for (const entry of await deps.selectFacts({ what, facts: facts.map((fact) => fact.content) })) {
    picked.set(entry.index, entry.rest);
  }
  // Information and target together: whatever carries two distinctive words of them goes; no rest may keep one.
  const forbidden = `${what} ${target.content}`;
  const tokens = distinctiveTokens(forbidden);
  facts.forEach((fact, index) => {
    if (picked.has(index)) return;
    const factTokens = distinctiveTokens(fact.content);
    let shared = 0;
    for (const token of tokens) if (factTokens.has(token)) shared += 1;
    if (index === 0 || shared >= 2) picked.set(index, null);
  });

  const result: FactForget = { deleted: 0, trimmed: 0, removedContents: [], tooMany: null };
  // Too many: touch nothing. Then the repetition with `allowMany` hits the same target.
  const related = [...picked.keys()].filter((index) => index > 0);
  if (related.length > MEMORY.forgetMaxRelatedFacts && !input.allowMany) {
    return { ...result, tooMany: [0, ...related].map((index) => (facts[index] as ActiveFact | FactCandidate).content) };
  }
  const plan: Array<{ fact: ActiveFact | FactCandidate; rest: string | null; trim: FactCandidate | null }> = [...picked].map(
    ([index, rest]) => {
      const other = index > 0 ? (others[index - 1] ?? null) : null;
      const keep = other && trimmedRest(other.content, rest, forbidden) ? rest : null;
      return { fact: other ?? target, rest: keep, trim: keep ? other : null };
    },
  );

  const restVectors = new Map<string, number[] | null>();
  const rests = plan.flatMap((step) => (step.rest ? [step.rest] : []));
  if (rests.length > 0) {
    try {
      const embedded = await deps.embed(rests);
      rests.forEach((rest, index) => restVectors.set(rest, embedded[index] ?? null));
    } catch {
      // A trimmed fact without a vector can still be found through the full text.
    }
  }

  for (const step of plan) {
    const gone = await deps.store.forgetFact(step.fact.id);
    result.deleted += gone.deletedIds.length;
    let trimmedId: string | null = null;
    if (step.rest && step.trim) {
      const stored = await deps.store.insertFact({
        subject: input.subject,
        category: step.trim.category,
        content: step.rest,
        confidence: step.trim.confidence,
        sourceMessageId: step.trim.sourceMessageId,
        embedding: restVectors.get(step.rest) ?? null,
        createdAt: step.trim.createdAt,
        kind: step.trim.kind,
        validFrom: step.trim.validFrom,
        validUntil: step.trim.validUntil,
      });
      trimmedId = stored.id;
      result.trimmed += 1;
    } else {
      result.removedContents.push(step.fact.content);
    }
    // The audit log keeps THAT something was deleted: id, category, time.
    // No content, otherwise the deletion would be none.
    await audit("memory_forget", {
      fact_id: step.fact.id,
      deleted: gone.deletedIds.length,
      categories: gone.categories,
      summaries_deleted: gone.summariesDeleted,
      ...(step.fact.id === target.id ? {} : { related: true }),
      ...(trimmedId ? { trimmed_to: trimmedId } : {}),
    });
  }
  return result;
}

/**
 * Is the rest fit as a trimmed fact? Only deleted, nothing added: every word
 * was already in the old fact, it is shorter, something distinctive remains,
 * and no distinctive word from `forbidden` (information and target) is still
 * in it.
 */
export function trimmedRest(original: string, rest: string | null, forbiddenText: string): rest is string {
  if (!rest) return false;
  const before = normalizedWords(original);
  const after = normalizedWords(rest);
  if (after.length === 0 || after.length >= before.length) return false;
  const known = new Set(before);
  if (!after.every((word) => known.has(word))) return false;
  const left = distinctiveTokens(rest);
  if (left.size === 0) return false;
  const forbidden = distinctiveTokens(forbiddenText);
  return ![...left].some((token) => forbidden.has(token));
}

/**
 * Forgetting down into the user model (D40). Finding from the memory benchmark
 * research of 2026-10-02: `forget_fact` deleted fact, replacement chain and
 * summaries, but the user model (~15,500 characters, in every turn) stayed
 * untouched. Serain said "forgotten" and had it in the prompt again in the
 * next turn.
 *
 * Procedure: a model names the lines that depend on the information; in
 * addition every line that contains at least two distinctive words of the
 * information goes. Deleting happens in code, only whole lines, as a new
 * version (headings are never candidates, in either format of the learned
 * part). Afterwards all older versions that still contain one of the deleted
 * lines disappear: a history that keeps what was deleted would undo the
 * forgetting (W7). Last, a marker, so that consolidation and `memory:push` do not
 * bring it back.
 */
export interface ModelPurge {
  /** Deleted lines in the active user model. */
  removedLines: number;
  /** Older versions that were deleted because they still contained it. */
  versionsPurged: number;
  /** Too many hits: nothing deleted, the lines go back to the owner as a question. */
  tooMany: string[] | null;
  marker: boolean;
}

export async function purgeUserModel(
  deps: MemoryDeps,
  input: { what: string; facts: readonly string[]; allowMany: boolean },
): Promise<ModelPurge> {
  const marker = await rememberForgotten(deps, [input.what, ...input.facts].join("\n"));
  const active = await deps.store.activeUserModel();
  if (!active) return { removedLines: 0, versionsPurged: 0, tooMany: null, marker };

  // Base text and learned part as one list, so that the model sees both at once.
  const baseLines = active.base.split("\n");
  const learnedLines = active.learned.split("\n");
  const candidates = [
    ...baseLines.map((text, index) => ({ part: "base" as const, index, text })),
    ...learnedLines.map((text, index) => ({ part: "learned" as const, index, text })),
  ].filter((line) => line.text.trim() && !line.text.trim().startsWith("#"));

  const chosen = new Set(await deps.selectLines({ what: input.what, facts: input.facts, lines: candidates.map((line) => line.text) }));
  const tokens = distinctiveTokens([input.what, ...input.facts].join(" "));
  candidates.forEach((line, index) => {
    const lineTokens = distinctiveTokens(line.text);
    let shared = 0;
    for (const token of tokens) if (lineTokens.has(token)) shared += 1;
    if (shared >= 2) chosen.add(index);
  });

  const hit = [...chosen].sort((a, b) => a - b).flatMap((index) => (candidates[index] ? [candidates[index]] : []));
  if (hit.length === 0) return { removedLines: 0, versionsPurged: 0, tooMany: null, marker };
  if (hit.length > MEMORY.forgetMaxModelLines && !input.allowMany) {
    return { removedLines: 0, versionsPurged: 0, tooMany: hit.map((line) => line.text.trim()), marker };
  }

  const removedTexts = new Set(hit.map((line) => line.text.trim()));
  const version = await deps.store.insertUserModelVersion({
    base: withoutLines(active.base, hit.filter((line) => line.part === "base").map((line) => line.index)),
    learned: withoutLines(active.learned, hit.filter((line) => line.part === "learned").map((line) => line.index)),
    source: "forget",
    factsCursor: active.factsCursor,
    diff: { removed_lines: hit.length },
    createdAt: deps.now().toISOString(),
  });

  // Older versions that contain one of the deleted lines are a way back to
  // what the owner wants forgotten. They go entirely.
  const older = (await deps.store.userModelVersions()).filter((entry) => entry.id !== version.id);
  const stale = older
    .filter((entry) => `${entry.base}\n${entry.learned}`.split("\n").some((line) => removedTexts.has(line.trim())))
    .map((entry) => entry.id);
  await deps.store.deleteUserModelVersions(stale);
  await pruneVersions(deps);

  await audit("memory_user_model", { action: "forget", removed_lines: hit.length, versions_purged: stale.length, version_id: version.id });
  return { removedLines: hit.length, versionsPurged: stale.length, tooMany: null, marker };
}

/** Stores a marker (D40). Without a key or with too few distinctive words there is none. */
async function rememberForgotten(deps: MemoryDeps, text: string): Promise<boolean> {
  if (!deps.markerKey) return false;
  const marker = markerFor(deps.markerKey, text);
  if (!marker) return false;
  await deps.store.addForgottenMarker(marker);
  return true;
}
