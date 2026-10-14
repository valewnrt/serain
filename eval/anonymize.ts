import type { Candidate, RunKey } from "./types.js";

/**
 * Blind comparison (D3: "candidates run blind side by side"). The owner
 * should rate the style, not the brand name. That is why the columns in the report are
 * called A, B, C, and the key lives in a separate file.
 *
 * The order is shuffled so that the same candidate is not always on the left;
 * the shuffle is deterministic from the run ID so that a run stays
 * reproducible and a test can check it.
 */

/** Small deterministic PRNG (mulberry32) over a string seed. */
function seeded(seed: string): () => number {
  let hash = 0x811c9dc5;
  for (const char of seed) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return () => {
    hash = (hash + 0x6d2b79f5) >>> 0;
    let t = hash;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function aliasAt(index: number): string {
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  if (index < letters.length) return letters[index] as string;
  const first = letters[Math.floor(index / letters.length) - 1] as string;
  const second = letters[index % letters.length] as string;
  return `${first}${second}`;
}

/** Fisher-Yates with a fixed seed. */
export function shuffle<T>(items: readonly T[], seed: string): T[] {
  const random = seeded(seed);
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    const a = out[i] as T;
    const b = out[j] as T;
    out[i] = b;
    out[j] = a;
  }
  return out;
}

export function anonymize(candidates: readonly Candidate[], runId: string): RunKey {
  const aliases: Record<string, Candidate> = {};
  for (const [index, candidate] of shuffle(candidates, runId).entries()) {
    aliases[aliasAt(index)] = candidate;
  }
  return { runId, aliases };
}

/** Blind name of a candidate in this run. */
export function aliasOf(key: RunKey, candidateId: string): string {
  const found = Object.entries(key.aliases).find(([, candidate]) => candidate.id === candidateId);
  if (!found) throw new Error(`Candidate "${candidateId}" does not belong to run ${key.runId}`);
  return found[0];
}
