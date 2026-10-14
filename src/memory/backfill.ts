import { EMBEDDING } from "../config/models.js";
import { audit } from "../db/audit.js";
import { db } from "../db/client.js";
import type { Embedder } from "./embeddings.js";

/**
 * Backfill for facts without an embedding (D13 addendum, 2026-09-18).
 *
 * Cause: `scripts/push-memory.ts` created facts before memory v1 without `embedding`
 * (fixed in the same change that introduces this module), so the backfill here
 * is a one-off catch-up for the 70 seed facts, not a permanent state.
 *
 * Same code path as the write path: `embed()` from `src/memory/embeddings.ts`
 * already brings model ID, ZDR policy, budget guard (`src/budget.ts`) and
 * `usage_log` booking; this module only calls `embed`/`embedOne` via the
 * `Embedder` type and adds nothing of its own in terms of network or provider policy.
 * Only the `embedding` column is written; fact texts are never logged or
 * written to the audit log.
 */

export interface BackfillRow {
  id: string;
  content: string;
}

/** Only the three operations the backfill needs, testable with a fake. */
export interface BackfillStore {
  factsWithoutEmbedding(): Promise<BackfillRow[]>;
  /** For the self-check: the row count must never change from a pure embedding backfill. */
  totalFactCount(): Promise<number>;
  /** Writes ONLY the `embedding` column for this one row. */
  writeEmbedding(id: string, embedding: number[]): Promise<void>;
}

/** The production path: Supabase with the secret key, like everywhere else. */
export class SupabaseBackfillStore implements BackfillStore {
  async factsWithoutEmbedding(): Promise<BackfillRow[]> {
    const { data, error } = await db.from("facts").select("id, content").is("embedding", null);
    if (error) throw new Error(`Facts without embedding not readable: ${error.message}`);
    return (data ?? []) as BackfillRow[];
  }

  async totalFactCount(): Promise<number> {
    const { count, error } = await db.from("facts").select("id", { count: "exact", head: true });
    if (error) throw new Error(`Fact count not readable: ${error.message}`);
    return count ?? 0;
  }

  async writeEmbedding(id: string, embedding: number[]): Promise<void> {
    const { error } = await db.from("facts").update({ embedding }).eq("id", id);
    if (error) throw new Error(`Embedding not written (${id}): ${error.message}`);
  }
}

/**
 * Rough token estimate from the character count. Accurate enough for embeddings: the
 * price is linear in input tokens, there are no output tokens and no model
 * variance as with chat replies. Only serves to estimate cost before the
 * real call (`--dry-run`, cost cap); the actual cost is in `usage_log` after
 * every real call.
 */
function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export function estimateCostUsd(texts: readonly string[]): number {
  const tokens = texts.reduce((sum, text) => sum + estimateTokens(text), 0);
  return (tokens / 1_000_000) * EMBEDDING.pricePerMillionTokensUsd;
}

/** Default for `--cost-cap`, can be overridden by flag. */
export const DEFAULT_BACKFILL_COST_CAP_USD = 0.05;
export const DEFAULT_BACKFILL_BATCH_SIZE = 20;

export interface BackfillOptions {
  store: BackfillStore;
  embed: Embedder;
  dryRun: boolean;
  costCapUsd?: number;
  batchSize?: number;
}

export interface BackfillResult {
  dryRun: boolean;
  /** Facts without an embedding at the start of the run. */
  totalMissing: number;
  processed: number;
  skippedDueToCap: number;
  capExceeded: boolean;
  /** Estimated cost: in a dry run for all missing facts, otherwise for the ones actually processed. */
  estimatedCostUsd: number;
  factCountBefore: number;
  factCountAfter: number;
  /** Facts that still have no embedding after the run. */
  remainingNull: number;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Idempotent: if the run finds no facts without an embedding, nothing happens,
 * not even an audit entry. `--dry-run` only reads (count, estimated cost) and
 * writes nothing, no `usage_log` either, no audit.
 *
 * The cost cap is checked **before** each batch using the estimated cost
 * (not only after the call): if a batch would break the cap, the run ends
 * there, batches already written stay. A second run catches up on the rest,
 * because again it only sees the facts without an embedding.
 */
export async function runBackfill(options: BackfillOptions): Promise<BackfillResult> {
  const costCapUsd = options.costCapUsd ?? DEFAULT_BACKFILL_COST_CAP_USD;
  const batchSize = options.batchSize ?? DEFAULT_BACKFILL_BATCH_SIZE;
  if (!(costCapUsd > 0)) throw new Error("The cost cap must be greater than 0.");
  if (!(batchSize > 0)) throw new Error("The batch size must be greater than 0.");

  const rows = await options.store.factsWithoutEmbedding();
  const factCountBefore = await options.store.totalFactCount();

  if (options.dryRun) {
    return {
      dryRun: true,
      totalMissing: rows.length,
      processed: 0,
      skippedDueToCap: 0,
      capExceeded: false,
      estimatedCostUsd: estimateCostUsd(rows.map((row) => row.content)),
      factCountBefore,
      factCountAfter: factCountBefore,
      remainingNull: rows.length,
    };
  }

  if (rows.length === 0) {
    return {
      dryRun: false,
      totalMissing: 0,
      processed: 0,
      skippedDueToCap: 0,
      capExceeded: false,
      estimatedCostUsd: 0,
      factCountBefore,
      factCountAfter: factCountBefore,
      remainingNull: 0,
    };
  }

  let spentEstimateUsd = 0;
  let processed = 0;
  let capExceeded = false;

  for (const batch of chunk(rows, batchSize)) {
    const batchEstimateUsd = estimateCostUsd(batch.map((row) => row.content));
    if (spentEstimateUsd + batchEstimateUsd > costCapUsd) {
      capExceeded = true;
      break;
    }

    const vectors = await options.embed(batch.map((row) => row.content));
    if (vectors.length !== batch.length) {
      throw new Error(`${vectors.length} vectors for ${batch.length} facts in one batch.`);
    }
    for (let i = 0; i < batch.length; i += 1) {
      const row = batch[i];
      const vector = vectors[i];
      if (!row || !vector) throw new Error("Fact or vector missing in the batch response.");
      await options.store.writeEmbedding(row.id, vector);
    }

    spentEstimateUsd += batchEstimateUsd;
    processed += batch.length;
  }

  const remainingNull = (await options.store.factsWithoutEmbedding()).length;
  const factCountAfter = await options.store.totalFactCount();

  if (processed > 0) {
    // Only numbers, never contents (D8.6, task statement).
    await audit("memory_backfill", {
      processed,
      totalMissingBefore: rows.length,
      remainingNull,
      capExceeded,
      estimatedCostUsd: Number(spentEstimateUsd.toFixed(6)),
    });
  }

  return {
    dryRun: false,
    totalMissing: rows.length,
    processed,
    skippedDueToCap: rows.length - processed,
    capExceeded,
    estimatedCostUsd: spentEstimateUsd,
    factCountBefore,
    factCountAfter,
    remainingNull,
  };
}
