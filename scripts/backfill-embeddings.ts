/**
 * Backfills embeddings for facts that were created without a vector before
 * Memory v1 (addendum to D13). The cause was `scripts/push-memory.ts`, which wrote
 * facts without `embedding`; that is fixed at the source, and this backfill
 * catches up the old 70 seed facts once. The actual logic lives in
 * `src/memory/backfill.ts`; this is only the command line.
 *
 *   pnpm memory:backfill-embeddings --dry-run
 *   pnpm memory:backfill-embeddings
 *   pnpm memory:backfill-embeddings -- --cost-cap=0.10
 *
 * `--dry-run` only reads (count, estimated cost) and writes nothing, not even
 * `usage_log` or audit. Without `--dry-run` the hard cost cap applies
 * (`--cost-cap`, default $0.05): if a batch would exceed it, the run ends
 * there. Idempotent: a second run finds no more facts without an embedding
 * and writes nothing.
 */
import { pathToFileURL } from "node:url";
import { embed } from "../src/memory/embeddings.js";
import {
  DEFAULT_BACKFILL_COST_CAP_USD,
  runBackfill,
  SupabaseBackfillStore,
} from "../src/memory/backfill.js";

function parseCostCap(argv: readonly string[]): number {
  const flag = argv.find((arg) => arg.startsWith("--cost-cap="));
  if (!flag) return DEFAULT_BACKFILL_COST_CAP_USD;
  const value = Number(flag.slice("--cost-cap=".length));
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("--cost-cap must be a number greater than 0.");
  }
  return value;
}

export async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const costCapUsd = parseCostCap(argv);

  const result = await runBackfill({
    store: new SupabaseBackfillStore(),
    embed,
    dryRun,
    costCapUsd,
  });

  if (result.dryRun) {
    console.log(`Dry run: ${result.totalMissing} facts without an embedding.`);
    console.log(`Estimated cost: $${result.estimatedCostUsd.toFixed(6)}.`);
    console.log("Nothing written.");
    return;
  }

  if (result.totalMissing === 0) {
    console.log("Nothing to do: all facts already have an embedding.");
    return;
  }

  console.log(`Processed: ${result.processed} of ${result.totalMissing} facts.`);
  console.log(
    `Estimated cost: $${result.estimatedCostUsd.toFixed(6)} (cap $${costCapUsd.toFixed(2)}).`,
  );
  if (result.capExceeded) {
    console.log(
      `Cost cap reached: ${result.skippedDueToCap} facts still open. Run again ` +
        "to continue (idempotent), or raise --cost-cap.",
    );
  }
  console.log(
    `Self-check: ${result.remainingNull} facts still without an embedding, row count ` +
      `${result.factCountBefore} → ${result.factCountAfter}.`,
  );
  if (result.factCountAfter !== result.factCountBefore) {
    console.error(
      "WARNING: row count changed during the run. That must not happen in a pure " +
        "embedding backfill; check by hand.",
    );
    process.exitCode = 1;
  }
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error: unknown) => {
    console.error((error as Error).message);
    process.exit(1);
  });
}
