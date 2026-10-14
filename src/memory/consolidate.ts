import { MEMORY } from "../config/memory.js";
import { audit } from "../db/audit.js";
import { log } from "../log.js";
import { toWallTime } from "../time.js";
import { checkConsolidation, deletableLines } from "./consolidate-rules.js";
import type { MemoryDeps } from "./deps.js";
import { ownerDay, notExpired } from "./kinds.js";
import { matchesMarker } from "./markers.js";

/**
 * Nightly consolidation (H1, D40): the user model lives.
 *
 * D6 promised a "document maintained by the agent", what was built was one
 * pushed by hand. New facts landed in `facts`, the model in every turn never
 * changed. Now the profile is consolidated about every 24 h, built so that the
 * usual failure of such loops (most writes are noise, a review run even
 * without anything new) does not happen:
 *
 * - **Code first.** Once a day (the owner's wall time) from 03:00, and a model
 *   only runs if facts are new, replaced or expired since the last run.
 * - **Only from the owner's words.** Inputs are facts (they only come from
 *   their messages, D13) and summaries (foreign notices in them are left out,
 *   D8.4). Never mail, web or executor content. So the "prompt laundering"
 *   path from OpenClaw structurally does not exist here.
 * - **The owner's base text stays theirs.** The consolidation only rewrites
 *   the learned part and may delete at most a few whole lines of the base
 *   text that new facts have outdated.
 * - **Checked in code before activating:** structure (keyed sections), cap,
 *   markers for forgotten facts, no empty diff. Otherwise the old version
 *   stays.
 */
export async function maybeConsolidate(deps: MemoryDeps): Promise<"skipped" | "nothing_new" | "rejected" | "written"> {
  const now = deps.now();
  const today = ownerDay(now);
  if (toWallTime(now).hour < MEMORY.consolidationHour) return "skipped";
  const state = await deps.store.consolidationState();
  if (state.lastRunDay === today) return "skipped";

  const active = await deps.store.activeUserModel();
  // Very first run: from the state of the user model. Migration 0010 sets it
  // to the last `memory:push`, so that what was learned since comes along.
  const cursor = state.cursor ?? active?.createdAt ?? now.toISOString();
  const nowIso = now.toISOString();
  const changes = await deps.store.factChangesSince(cursor, nowIso);
  if (changes.added.length + changes.superseded.length + changes.expired.length === 0) {
    await deps.store.saveConsolidationState({ lastRunDay: today, cursor: nowIso });
    await audit("memory_consolidation", { ran: false, reason: "nothing_new" });
    return "nothing_new";
  }

  const base = active?.base ?? "";
  const learnedBefore = active?.learned ?? "";
  const baseLines = base.split("\n");
  const summaries = (await deps.store.summariesSince(cursor)).map((summary) => summary.content);
  const result = await deps.consolidate({
    now,
    baseLines,
    learned: learnedBefore,
    added: changes.added,
    superseded: changes.superseded,
    expired: changes.expired,
    summaries,
  });

  const verdict = checkConsolidation({ base, learnedBefore, learned: result.learned, outdatedBaseLines: result.outdatedBaseLines });
  let rejected: string | null = verdict.ok ? null : verdict.reason;
  if (verdict.ok && deps.markerKey) {
    const markers = await deps.store.forgottenMarkers();
    // What the owner has said again themself since stands as a fact and may go into the model.
    const current = (await deps.store.activeFacts()).filter((fact) => notExpired(fact, now)).map((fact) => fact.content);
    if (markers.length > 0 && matchesMarker(deps.markerKey, markers, verdict.learned, current)) rejected = "forgotten";
  }
  if (!verdict.ok || rejected) {
    // Nothing to change is a valid result: the cursor moves on, otherwise a
    // model would be asked the same every night. After a broken rule, though,
    // again tomorrow, with everything from today.
    const unchanged = rejected === "no_change";
    await deps.store.saveConsolidationState({ lastRunDay: today, cursor: unchanged ? nowIso : cursor });
    await audit("memory_consolidation", {
      ran: true,
      written: false,
      reason: rejected,
      added: changes.added.length,
      superseded: changes.superseded.length,
      expired: changes.expired.length,
    });
    if (unchanged) return "nothing_new";
    log.warn(`Consolidation rejected (${rejected}), the user model stays as it is`);
    return "rejected";
  }

  const version = await deps.store.insertUserModelVersion({
    base: verdict.base,
    learned: verdict.learned,
    source: "consolidation",
    factsCursor: nowIso,
    diff: {
      removed_base_lines: verdict.removedBaseLines,
      deletable_base_lines: deletableLines(base).length,
      learned_chars_before: learnedBefore.length,
      learned_chars_after: verdict.learned.length,
    },
    createdAt: nowIso,
  });
  await pruneVersions(deps);
  await deps.store.saveConsolidationState({ lastRunDay: today, cursor: nowIso });
  await audit("memory_consolidation", {
    ran: true,
    written: true,
    version_id: version.id,
    added: changes.added.length,
    superseded: changes.superseded.length,
    expired: changes.expired.length,
    summaries: summaries.length,
    removed_base_lines: verdict.removedBaseLines,
    learned_chars: verdict.learned.length,
  });
  return "written";
}

/** Older versions beyond the cap are dropped; the newest always stays. */
export async function pruneVersions(deps: Pick<MemoryDeps, "store">): Promise<number> {
  const versions = await deps.store.userModelVersions();
  const stale = versions.slice(MEMORY.userModelKeepVersions).map((version) => version.id);
  await deps.store.deleteUserModelVersions(stale);
  return stale.length;
}
