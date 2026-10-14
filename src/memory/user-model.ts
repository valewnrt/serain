import { db } from "../db/client.js";
import { log } from "../log.js";
import { owner } from "../config/owner.js";

/**
 * The user model, versioned (D6, D40). Active is the newest row in
 * `user_model_versions`; before that a single text lived in
 * `agent_state.user_model`, written only by `memory:push` (migration 0010).
 *
 * Two parts per version:
 * - `base`: the owner's base text from `data/user-model.md`. The machine only
 *   deletes whole lines from it (outdated according to the consolidation, or
 *   forgotten), it never rewrites it. A text the owner wrote themself (say,
 *   with Claude) beats any automatic profile (audit H7); it stays theirs.
 * - `learned`: what the nightly consolidation makes of new facts, with a
 *   fixed structure (keyed sections, `consolidate-rules.ts`) and a cap.
 *
 * Both parts stay in the language they were written in; the model reads any.
 *
 * The database is the only place where Mac and server see the same state:
 * `deploy.sh` excludes `data/` from rsync, and the owner's personal data
 * never travels through the repo.
 */

export type UserModelSource = "seed" | "push" | "consolidation" | "forget";

export interface UserModelVersion {
  id: string;
  base: string;
  learned: string;
  source: UserModelSource;
  factsCursor: string | null;
  diff: Record<string, unknown>;
  createdAt: string;
}

export type NewUserModelVersion = Omit<UserModelVersion, "id" | "createdAt"> & { createdAt?: string };

/** The heading the learned part stands under in the prompt. */
export const LEARNED_HEADING = "## Learned";

/** How the user model appears in the prompt. The learned part as stored: the model reads either format. */
export function renderUserModel(version: Pick<UserModelVersion, "base" | "learned" | "createdAt" | "source"> | null): string {
  if (!version) return "";
  const base = version.base.trim();
  const learned = version.learned.trim();
  if (!learned) return base;
  return `${base}\n\n${LEARNED_HEADING} (as of ${version.createdAt.slice(0, 10)})\n${learned}`;
}

interface VersionRow {
  id: string;
  base: string;
  learned: string;
  source: UserModelSource;
  facts_cursor: string | null;
  diff: Record<string, unknown> | null;
  created_at: string;
}

const COLUMNS = "id, base, learned, source, facts_cursor, diff, created_at";

function toVersion(row: VersionRow): UserModelVersion {
  return {
    id: row.id,
    base: row.base,
    learned: row.learned,
    source: row.source,
    factsCursor: row.facts_cursor,
    diff: row.diff ?? {},
    createdAt: row.created_at,
  };
}

/**
 * Read again, but not on every turn. When this process changes the model
 * (consolidation, forgetting), it clears the cache at once; a `memory:push`
 * from the Mac arrives after five minutes at the latest.
 */
let cached: { version: UserModelVersion | null; at: number } | null = null;
const TTL_MS = 5 * 60_000;

export async function activeUserModel(now = Date.now()): Promise<UserModelVersion | null> {
  if (cached && now - cached.at < TTL_MS) return cached.version;
  const { data, error } = await db
    .from("user_model_versions")
    .select(COLUMNS)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    // Without a user model Serain is dumber, but not broken. The turn goes on.
    log.warn("User model not loadable:", error.message);
    return cached?.version ?? null;
  }
  const version = data ? toVersion(data as VersionRow) : null;
  if (!version && !cached) log.warn(`No user model stored: Serain does not know ${owner.name}.`);
  cached = { version, at: now };
  return version;
}

export async function userModel(): Promise<string> {
  return renderUserModel(await activeUserModel());
}

export async function userModelVersions(): Promise<UserModelVersion[]> {
  const { data, error } = await db.from("user_model_versions").select(COLUMNS).order("created_at", { ascending: false });
  if (error) throw new Error(`User model versions not readable: ${error.message}`);
  return ((data ?? []) as VersionRow[]).map(toVersion);
}

export async function insertUserModelVersion(version: NewUserModelVersion): Promise<UserModelVersion> {
  const { data, error } = await db
    .from("user_model_versions")
    .insert({
      base: version.base,
      learned: version.learned,
      source: version.source,
      facts_cursor: version.factsCursor,
      diff: version.diff,
      ...(version.createdAt ? { created_at: version.createdAt } : {}),
    })
    .select(COLUMNS)
    .single();
  if (error) throw new Error(`User model not written: ${error.message}`);
  cached = null;
  return toVersion(data as VersionRow);
}

export async function deleteUserModelVersions(ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  const { error } = await db.from("user_model_versions").delete().in("id", [...ids]);
  if (error) throw new Error(`User model versions not deleted: ${error.message}`);
  cached = null;
}

export async function forgottenMarkers(): Promise<string[][]> {
  const { data, error } = await db.from("forgotten_markers").select("token_hmacs");
  if (error) throw new Error(`Markers for forgotten facts not readable: ${error.message}`);
  return ((data ?? []) as Array<{ token_hmacs: string[] }>).map((row) => row.token_hmacs);
}

export async function addForgottenMarker(hmacs: readonly string[]): Promise<void> {
  const { error } = await db.from("forgotten_markers").insert({ token_hmacs: [...hmacs] });
  if (error) throw new Error(`Marker for a forgotten fact not saved: ${error.message}`);
}
