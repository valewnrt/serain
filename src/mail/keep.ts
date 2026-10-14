import { MailError } from "./types.js";

/**
 * Keep list (D37). When cleaning up, the owner does not read a list of eighty
 * senders; they say once what should stay, and from then on the code takes
 * care of it, not a model's memory. An entry is an address or a domain; the
 * domain also covers its subdomains.
 *
 * Fail-closed: if the list cannot be read, nothing is cleaned up.
 */

export interface MailKeepStore {
  load(): Promise<string[]>;
  save(entries: string[]): Promise<void>;
}

const ENTRY = /^([^\s@<>,;"']+@)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
export const MAIL_KEEP_MAX = 200;

export function normalizeKeepEntry(raw: string): string | null {
  const entry = raw.trim().toLowerCase().replace(/^@/, "");
  return ENTRY.test(entry) ? entry : null;
}

export function isKept(address: string, entries: readonly string[]): boolean {
  const lower = address.toLowerCase();
  const domain = lower.slice(lower.lastIndexOf("@") + 1);
  return entries.some((entry) => (entry.includes("@") ? entry === lower : domain === entry || domain.endsWith(`.${entry}`)));
}

export async function loadKeep(store: MailKeepStore): Promise<string[]> {
  try {
    return await store.load();
  } catch (error) {
    throw new MailError(`The keep list cannot be read, so I am not cleaning anything up (${(error as Error).message}).`);
  }
}

export async function addKeep(store: MailKeepStore, raw: readonly string[]): Promise<{ added: string[]; invalid: string[]; total: number }> {
  const current = await loadKeep(store);
  const added: string[] = [];
  const invalid: string[] = [];
  for (const value of raw) {
    const entry = normalizeKeepEntry(value);
    if (!entry) invalid.push(value);
    else if (!current.includes(entry) && !added.includes(entry)) added.push(entry);
  }
  const next = [...current, ...added];
  if (next.length > MAIL_KEEP_MAX) throw new MailError(`The keep list holds at most ${MAIL_KEEP_MAX} entries.`);
  if (added.length > 0) await store.save(next);
  return { added, invalid, total: next.length };
}

export async function removeKeep(store: MailKeepStore, raw: readonly string[]): Promise<{ removed: string[]; total: number }> {
  const current = await loadKeep(store);
  const wanted = new Set(raw.map((value) => normalizeKeepEntry(value)).filter((entry): entry is string => entry !== null));
  const removed = current.filter((entry) => wanted.has(entry));
  const next = current.filter((entry) => !wanted.has(entry));
  if (removed.length > 0) await store.save(next);
  return { removed, total: next.length };
}
