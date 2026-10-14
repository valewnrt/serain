// First import, before everything else: keeps the eval away from the production database (see sink.ts).
import { runLedger } from "./sink.js";
// Right after: the cases take place at Alex's (see ../persona.ts).
import "../persona.js";

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { newRunId } from "../store.js";
import { loadMemoryCases, selectCases } from "./load.js";
import { estimateEmbeddingUsd, mergeUsage, renderMarkdown } from "./report.js";
import { runMemoryEval } from "./run.js";
import { CATEGORIES, type Category, type Level, type MemoryRunManifest } from "./types.js";

/**
 * Command line of the memory eval (H4).
 *
 *   pnpm eval:memory                                  all cases, levels 1 to 3
 *   pnpm eval:memory --level 1,2                      without chat turns
 *   pnpm eval:memory --control none                   level 3 without memory (guessing control)
 *   pnpm eval:memory --category vergessen --repeat 3
 *   pnpm eval:memory --only update-02,vergessen-01 --concurrency 1
 *   pnpm eval:memory --cap 0.05                       cap for OpenRouter (embeddings, fallbacks)
 *
 * Runs land under `data/eval/memory-runs/<time>/` (`data/` is gitignored,
 * as with the other eval runs): `results.json`, `manifest.json`,
 * `report.md`. A separate directory next to `data/eval/runs/`, so that
 * `pnpm eval:rank` without `--run` does not land on a memory run.
 */

const RUNS_ROOT = "data/eval/memory-runs";
const DEFAULT_CAP_USD = 0.1;

function parseArgs(argv: readonly string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] as string;
    if (!token.startsWith("--")) throw new Error(`Unexpected argument "${token}"`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${token} needs a value`);
    flags.set(token.slice(2), value);
    i += 1;
  }
  const known = new Set(["repeat", "only", "category", "concurrency", "level", "control", "cap"]);
  for (const name of flags.keys()) {
    if (!known.has(name)) throw new Error(`Unknown option --${name}`);
  }
  return flags;
}

function positiveInt(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`--${name} "${value}" is not an integer > 0`);
  return parsed;
}

function parseLevels(value: string | undefined): Set<Level> {
  if (value === undefined) return new Set([1, 2, 3]);
  const levels = value.split(",").map((part) => Number(part.trim()));
  for (const level of levels) {
    if (level !== 1 && level !== 2 && level !== 3) throw new Error(`--level "${value}": allowed are 1, 2, 3`);
  }
  return new Set(levels as Level[]);
}

async function main(): Promise<void> {
  const flags = parseArgs(process.argv.slice(2));
  const control = flags.get("control");
  if (control !== undefined && control !== "none") throw new Error(`--control "${control}": only none is allowed`);
  const capValue = flags.get("cap");
  const capUsd = capValue === undefined ? DEFAULT_CAP_USD : Number(capValue);
  if (!Number.isFinite(capUsd) || capUsd <= 0) throw new Error(`--cap "${capValue}" is not a number > 0`);
  const category = flags.get("category");
  if (category !== undefined && !CATEGORIES.includes(category as Category)) {
    throw new Error(`--category "${category}": possible are ${CATEGORIES.join(", ")}`);
  }

  // The control measures only the answer; state and recall do not exist without memory.
  const levels = control === "none" ? new Set<Level>([3]) : parseLevels(flags.get("level"));
  const repeat = positiveInt(flags.get("repeat"), 1, "repeat");
  const concurrency = positiveInt(flags.get("concurrency"), 3, "concurrency");
  const only = flags.get("only")?.split(",").map((id) => id.trim()).filter(Boolean);
  const cases = selectCases(loadMemoryCases(), {
    ...(only?.length ? { only } : {}),
    ...(category ? { category: category as Category } : {}),
  });
  if (cases.length === 0) throw new Error("No cases selected.");

  const started = new Date();
  const runId = `${newRunId(started)}${control === "none" ? "_control" : ""}`;
  console.log(
    `Memory eval ${runId}: ${cases.length} cases · levels ${[...levels].join(",")} · ${repeat}× · ` +
      `parallel ${concurrency} · cap ${capUsd.toFixed(2)} $${control === "none" ? " · control without memory" : ""}`,
  );

  const outcome = await runMemoryEval({
    cases,
    levels,
    repeat,
    concurrency,
    control: control === "none" ? "none" : null,
    capUsd,
    runId,
    onCaseDone: (result, done, total) => {
      const byLevel = ([1, 2, 3] as const)
        .map((level) => {
          const checks = result.checks.filter((check) => check.level === level);
          return checks.length > 0 ? `L${level} ${checks.filter((check) => check.passed).length}/${checks.length}` : "";
        })
        .filter(Boolean)
        .join(" · ");
      console.log(
        `[${done}/${total}] ${result.caseId}${result.iteration > 1 ? `#${result.iteration}` : ""} · ` +
          `${result.ok ? byLevel || "no check" : `ERROR ${result.error ?? ""}`} · ${Math.round(result.durationMs / 1000)} s`,
      );
    },
  });

  const usage = mergeUsage(outcome.results.map((result) => result.usage));
  // What ran between the cases (template, aborts) is only in the run ledger.
  usage.unexpectedDbAccess = [...runLedger.unexpected];
  const manifest: MemoryRunManifest = {
    runId,
    startedAt: started.toISOString(),
    finishedAt: new Date().toISOString(),
    levels: [...levels].sort(),
    repeat,
    concurrency,
    control: control === "none" ? "none" : null,
    capUsd,
    caseIds: cases.map((testCase) => testCase.id),
    usage,
    embeddingEstimateUsd: estimateEmbeddingUsd(usage.embeddingChars),
    ...(outcome.abortedAt ? { abortedAt: outcome.abortedAt } : {}),
  };

  const order = new Map(cases.map((testCase, index) => [testCase.id, index]));
  const results = [...outcome.results].sort(
    (a, b) => a.iteration - b.iteration || (order.get(a.caseId) ?? 0) - (order.get(b.caseId) ?? 0),
  );

  const dir = resolve(process.cwd(), RUNS_ROOT, runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  writeFileSync(resolve(dir, "results.json"), `${JSON.stringify(results, null, 2)}\n`, "utf8");
  const report = renderMarkdown(manifest, results);
  writeFileSync(resolve(dir, "report.md"), report, "utf8");

  console.log(
    `\nDone: ${results.length} runs, ${results.filter((result) => !result.ok).length} failed, ` +
      `OpenRouter ${usage.openrouterUsd.toFixed(6)} $, ${usage.fallbacks} Fallbacks.`,
  );
  if (outcome.abortedAt) console.log(`Aborted: ${outcome.abortedAt}`);
  console.log(`Report: ${resolve(dir, "report.md")}`);
}

main().catch((error: unknown) => {
  console.error((error as Error).message);
  process.exitCode = 1;
});
