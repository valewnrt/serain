/**
 * Pushes Serain's base knowledge about the owner from `data/` to Supabase:
 * `data/user-model.md` (base text of the user model) and `data/facts.json`
 * (facts with `category`, `content`, `confidence`, optional `kind`,
 * `valid_from`, `valid_until`).
 *
 *   cp -r data.example data   once: template with a made-up example, then write about yourself
 *   pnpm memory:push          shows what would happen
 *   pnpm memory:push --apply  writes
 *
 * Why a script and not a migration: this is data, not structure, and it
 * contains personal details. `data/` is gitignored and `deploy.sh`
 * deliberately does not transfer it; the database is the only place where both
 * sides see the same state.
 *
 * Additive, as D6 requires: facts are created or updated via an ID derived
 * from their content. Facts that disappeared from the file are not deleted,
 * only reported: Serain replaces corrections in operation via `superseded_by`,
 * and a seed run must not override that.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { db } from "../src/db/client.js";
import { env } from "../src/config/env.js";
import { activeFacts, factId, type SeedFact } from "../src/memory/facts.js";
import { embedBestEffort } from "../src/memory/embeddings.js";
import { ownerDayEnd, ownerDayStart, FACT_KINDS } from "../src/memory/kinds.js";
import { markerKeyFrom, matchesMarker } from "../src/memory/markers.js";
import { activeUserModel, forgottenMarkers, insertUserModelVersion } from "../src/memory/user-model.js";
import { audit } from "../src/db/audit.js";

const APPLY = process.argv.includes("--apply");
const ROOT = resolve(import.meta.dirname, "..");

function isSeedFact(value: unknown): value is SeedFact {
  if (typeof value !== "object" || value === null) return false;
  const f = value as Record<string, unknown>;
  const optionalDay = (key: string) =>
    f[key] === undefined || (typeof f[key] === "string" && (key === "valid_from" ? ownerDayStart : ownerDayEnd)(f[key] as string) !== null);
  return (
    typeof f["category"] === "string" &&
    f["category"].length > 0 &&
    typeof f["content"] === "string" &&
    f["content"].length > 0 &&
    typeof f["confidence"] === "number" &&
    f["confidence"] >= 0 &&
    f["confidence"] <= 1 &&
    (f["kind"] === undefined || FACT_KINDS.includes(f["kind"] as (typeof FACT_KINDS)[number])) &&
    optionalDay("valid_from") &&
    optionalDay("valid_until")
  );
}

async function readData(file: string): Promise<string> {
  try {
    return await readFile(resolve(ROOT, file), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`${file} is missing. Template: cp -r data.example data, then write about yourself.`);
    throw error;
  }
}

export async function main(): Promise<void> {
  const model = await readData("data/user-model.md");
  const raw: unknown = JSON.parse(await readData("data/facts.json"));
  if (!Array.isArray(raw)) throw new Error("data/facts.json is not an array.");

  const facts = raw.map((entry, index) => {
    if (!isSeedFact(entry)) throw new Error(`data/facts.json: entry ${index} is incomplete.`);
    return entry;
  });

  // What the owner had Serain forget is unknown to the local file (D40).
  // Without this check the next push would bring it back: as a fact with the
  // same ID and as a line in the base text. Only what carries a marker is
  // blocked; the script never touches the file itself.
  const markerKey = markerKeyFrom(env.integrationKey);
  if (!markerKey) throw new Error("SERAIN_INTEGRATION_KEY is missing: without it I cannot recognize forgotten items, so I push nothing.");
  const markers = await forgottenMarkers();
  const forgotten = (text: string) => markers.length > 0 && matchesMarker(markerKey, markers, text);
  const skippedFacts = facts.filter((fact) => forgotten(fact.content));
  const modelLines = model.split("\n");
  const skippedLines = modelLines.filter((line) => line.trim() && !line.trim().startsWith("#") && forgotten(line));
  const base = modelLines.filter((line) => !skippedLines.includes(line)).join("\n");

  const rows = facts
    .filter((fact) => !skippedFacts.includes(fact))
    .map((fact) => ({
      id: factId(fact.category, fact.content),
      subject: "owner",
      category: fact.category,
      content: fact.content,
      confidence: fact.confidence,
      kind: fact.kind ?? "identity",
      valid_from: fact.valid_from ? ownerDayStart(fact.valid_from)?.toISOString() ?? null : null,
      valid_until: fact.valid_until ? ownerDayEnd(fact.valid_until)?.toISOString() ?? null : null,
      updated_at: new Date().toISOString(),
    }));

  const ids = new Set(rows.map((row) => row.id));
  if (ids.size !== rows.length) throw new Error("data/facts.json contains duplicate facts.");

  const existing = await activeFacts();
  const orphans = existing.filter((row) => !ids.has(row.id));

  const byCategory = new Map<string, number>();
  for (const fact of facts) byCategory.set(fact.category, (byCategory.get(fact.category) ?? 0) + 1);

  console.log(`User model: ${base.length} characters`);
  if (skippedLines.length > 0 || skippedFacts.length > 0) {
    console.log(
      `Not taken over because you had it forgotten: ${skippedLines.length} line(s) in the user model, ` +
        `${skippedFacts.length} fact(s). Please delete them from data/ too.`,
    );
  }
  console.log(`Facts: ${rows.length} in ${byCategory.size} categories`);
  for (const [category, count] of [...byCategory].sort()) console.log(`  ${category}: ${count}`);
  console.log(`Already in the DB: ${existing.length} active facts`);

  if (orphans.length > 0) {
    console.log(`\n${orphans.length} facts in the DB that do not come from the file:`);
    for (const row of orphans) console.log(`  [${row.category}] ${row.content.slice(0, 90)}`);
    console.log("They stay untouched. If they should go, decide by hand.");
  }

  if (!APPLY) {
    console.log("\nDry run. Write with --apply.");
    return;
  }

  // New version with the owner's base text; what consolidation has learned stays.
  const previous = await activeUserModel();
  await insertUserModelVersion({
    base,
    learned: previous?.learned ?? "",
    source: "push",
    factsCursor: previous?.factsCursor ?? null,
    diff: { pushed_chars: base.length, skipped_lines: skippedLines.length },
  });
  const { error } = await db.from("facts").upsert(rows, { onConflict: "id" });
  if (error) throw new Error(`Facts not written: ${error.message}`);

  // Write embeddings separately and ONLY for the column itself (like the
  // backfill, `src/memory/backfill.ts`): an upsert that sends the whole vector
  // on every run would overwrite an existing good embedding row with `null`
  // when the budget runs out or the network fails. Same code path as the write
  // path (model ID, ZDR policy, budget guard, usage_log). Best-effort: running
  // out of budget must not cost a fact, only its vector; the backfill catches
  // up the rest (addendum to D13).
  const embeddings = await embedBestEffort(rows.map((row) => row.content));
  let missingEmbeddings = 0;
  for (const [index, vector] of embeddings.entries()) {
    const row = rows[index];
    if (!row) continue;
    if (!vector) {
      missingEmbeddings += 1;
      continue;
    }
    const { error: embeddingError } = await db
      .from("facts")
      .update({ embedding: vector })
      .eq("id", row.id);
    if (embeddingError) {
      throw new Error(`Embedding not written (${row.id}): ${embeddingError.message}`);
    }
  }

  await audit("memory_seed", {
    facts: rows.length,
    user_model_chars: base.length,
    skipped_forgotten: skippedLines.length + skippedFacts.length,
    missing_embeddings: missingEmbeddings,
  });
  console.log(`\nWritten: user model + ${rows.length} facts.`);
  if (missingEmbeddings > 0) {
    console.log(
      `${missingEmbeddings} without an embedding (budget/network); ` +
        '"pnpm memory:backfill-embeddings" catches them up.',
    );
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
