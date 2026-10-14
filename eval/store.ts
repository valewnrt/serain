import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { RUNS_DIR } from "./config.js";
import type { CaseRun, ChoiceFile, RunKey, RunManifest, StoredCaseRun } from "./types.js";

/**
 * A run lives entirely under `data/eval/runs/<time>/`. `data/` is in
 * `.gitignore`: eval runs contain model answers to the owner's messages and
 * never belong in the repo.
 *
 * Four files, deliberately separate:
 * - `manifest.json`  Frame of the run (suites, cap, cost).
 * - `results.json`   Results, **blind**: only A, B, C, no model name.
 * - `key.json`       The key. Whoever wants to do the blind comparison opens
 *                    it only afterwards.
 * - `report.html`    What the owner opens. Also blind.
 * Their choice lands next to it as `choices.json`.
 */

export interface RunPaths {
  dir: string;
  manifest: string;
  results: string;
  key: string;
  report: string;
  choices: string;
  ranking: string;
}

export function runPaths(runId: string, root = RUNS_DIR): RunPaths {
  const dir = resolve(process.cwd(), root, runId);
  return {
    dir,
    manifest: resolve(dir, "manifest.json"),
    results: resolve(dir, "results.json"),
    key: resolve(dir, "key.json"),
    report: resolve(dir, "report.html"),
    choices: resolve(dir, "choices.json"),
    ranking: resolve(dir, "ranking.md"),
  };
}

/** Run ID from the timestamp: sortable, without characters that break paths. */
export function newRunId(now = new Date()): string {
  return now.toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/** Removes the candidate name. Without it the blind comparison would not be blind. */
export function blind(results: readonly CaseRun[]): StoredCaseRun[] {
  return results.map(({ candidateId: _candidateId, ...rest }) => rest);
}

export function writeRun(
  paths: RunPaths,
  manifest: RunManifest,
  key: RunKey,
  results: readonly CaseRun[],
): void {
  mkdirSync(paths.dir, { recursive: true });
  writeJson(paths.manifest, manifest);
  writeJson(paths.key, key);
  writeJson(paths.results, blind(results));
}

export interface LoadedRun {
  paths: RunPaths;
  manifest: RunManifest;
  key: RunKey;
  /** Results with the candidate resolved again. */
  results: CaseRun[];
  choices: ChoiceFile | null;
}

export function readRun(runId: string, root = RUNS_DIR): LoadedRun {
  const paths = runPaths(runId, root);
  if (!existsSync(paths.manifest)) throw new Error(`Run "${runId}" does not exist (${paths.dir})`);
  const manifest = JSON.parse(readFileSync(paths.manifest, "utf8")) as RunManifest;
  const key = JSON.parse(readFileSync(paths.key, "utf8")) as RunKey;
  const stored = JSON.parse(readFileSync(paths.results, "utf8")) as StoredCaseRun[];
  const results: CaseRun[] = stored.map((run) => {
    const candidate = key.aliases[run.alias];
    if (!candidate) throw new Error(`Blind name "${run.alias}" is missing in key.json of ${runId}`);
    return { ...run, candidateId: candidate.id };
  });
  const choices = existsSync(paths.choices)
    ? (JSON.parse(readFileSync(paths.choices, "utf8")) as ChoiceFile)
    : null;
  return { paths, manifest, key, results, choices };
}

/** All runs, newest last. */
export function listRuns(root = RUNS_DIR): string[] {
  const dir = resolve(process.cwd(), root);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

export function writeText(path: string, content: string): void {
  writeFileSync(path, content, "utf8");
}
