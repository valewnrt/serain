// First import, before everything else: the cases take place at Alex's (see persona.ts).
import "./persona.js";

import { CANDIDATES, DEFAULT_RUN_CAP_USD, SUITE_ROLE, candidatesForRole } from "./config.js";
import { loadSuite } from "./load.js";
import { compareRuns, gateSweep, rankRun, renderGateSweep, renderRanking, renderRegression } from "./rank.js";
import { renderReport } from "./report.js";
import { resolveCandidates, runEval } from "./run.js";
import { listRuns, readRun, runPaths, writeText } from "./store.js";
import { SUITES, type Candidate, type JudgeCase, type RoleName, type SuiteName } from "./types.js";

/**
 * Command line of the eval harness.
 *
 *   pnpm eval --list
 *   pnpm eval --suite chat,tools --candidates chat:sub:sonnet,chat:or:kimi-k2 --cap 0.50
 *   pnpm eval --suite chat --role chat --limit 5
 *   pnpm eval --suite chat,tools --candidate chat:sub:sonnet --only stil-nachhaken-01,tool-reminder-01
 *   pnpm eval --suite chat --candidate chat:or:kimi-k2 --baseline 2026-09-18_10-00-00
 *   pnpm eval:rank --run 2026-09-18_10-00-00
 *
 * Candidates must be named (`--candidates` or `--role`). No default
 * of "all": a full run over all candidates and all suites costs money,
 * and the owner starts it deliberately, not by accident.
 */

interface Args {
  command: "run" | "rank";
  flags: Map<string, string>;
  bare: Set<string>;
}

function parseArgs(argv: string[]): Args {
  const command = argv[0] === "rank" ? "rank" : "run";
  const rest = command === "rank" ? argv.slice(1) : argv;
  const flags = new Map<string, string>();
  const bare = new Set<string>();

  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i] as string;
    if (!token.startsWith("--")) continue;
    const name = token.slice(2);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith("--")) {
      bare.add(name);
    } else {
      flags.set(name, next);
      i += 1;
    }
  }
  return { command, flags, bare };
}

function parseSuites(value: string | undefined): SuiteName[] {
  if (!value) return ["chat", "tools", "dates"];
  const names = value.split(",").map((name) => name.trim());
  for (const name of names) {
    if (!SUITES.includes(name as SuiteName)) {
      throw new Error(`Unknown suite "${name}". Possible: ${SUITES.join(", ")}`);
    }
  }
  return names as SuiteName[];
}

function pickCandidates(args: Args, suites: SuiteName[]): Candidate[] {
  const single = args.flags.get("candidate");
  if (single) return resolveCandidates([single]);

  const list = args.flags.get("candidates");
  if (list) return resolveCandidates(list.split(",").map((id) => id.trim()));

  const role = args.flags.get("role");
  if (role) {
    const candidates = candidatesForRole(role as RoleName);
    if (candidates.length === 0) throw new Error(`No candidates for role "${role}"`);
    return candidates;
  }

  const roles = [...new Set(suites.map((suite) => SUITE_ROLE[suite]))].filter(Boolean);
  throw new Error(
    "Please specify candidates: --candidates <id,id> or --role <" +
      roles.join("|") +
      ">. `pnpm eval --list` shows all.",
  );
}

function printCandidates(): void {
  console.log("Candidates (D3). ID, role, provider, model:\n");
  for (const candidate of CANDIDATES) {
    console.log(
      `  ${candidate.id.padEnd(24)} ${candidate.role.padEnd(11)} ${candidate.provider.padEnd(13)} ${candidate.model}`,
    );
  }
  const runs = listRuns();
  if (runs.length > 0) {
    console.log(`\nRuns: ${runs.slice(-5).join(", ")}${runs.length > 5 ? " (last 5)" : ""}`);
  }
}

async function commandRun(args: Args): Promise<void> {
  if (args.bare.has("list")) {
    printCandidates();
    return;
  }

  const suites = parseSuites(args.flags.get("suite"));
  const candidates = pickCandidates(args, suites);
  const capValue = args.flags.get("cap");
  const capUsd = capValue === undefined ? DEFAULT_RUN_CAP_USD : Number(capValue);
  if (!Number.isFinite(capUsd) || capUsd <= 0) throw new Error(`--cap "${capValue}" is not a number > 0`);
  const limitValue = args.flags.get("limit");
  const limit = limitValue === undefined ? undefined : Number(limitValue);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    throw new Error(`--limit "${limitValue}" is not an integer > 0`);
  }

  const only = args.flags.get("only")?.split(",").map((id) => id.trim()).filter(Boolean);

  console.log(
    `Run: suites ${suites.join(", ")} · ${candidates.length} candidate(s) · cap ${capUsd.toFixed(2)} $` +
      (limit ? ` · only ${limit} cases per suite` : ""),
  );

  const result = await runEval({
    suites,
    candidates,
    capUsd,
    ...(limit === undefined ? {} : { limit }),
    ...(only?.length ? { only } : {}),
  });

  const paths = runPaths(result.runId);
  writeText(
    paths.report,
    renderReport({ manifest: result.manifest, results: result.results, sources: result.sources }),
  );

  const failed = result.results.filter((run) => !run.ok).length;
  console.log(
    `\nDone. ${result.results.length} turns, ${failed} failed, ${result.manifest.spentUsd.toFixed(4)} $ spent.`,
  );
  if (result.manifest.abortedAt) console.log(`Aborted: ${result.manifest.abortedAt}`);
  console.log(`Blind comparison: ${paths.report}`);
  console.log(`Key (open only afterwards): ${paths.key}`);

  const baseline = args.flags.get("baseline");
  if (baseline) {
    const suite = suites[0] as SuiteName;
    const candidate = candidates[0] as Candidate;
    if (candidates.length !== 1 || suites.length !== 1) {
      throw new Error("--baseline compares exactly one candidate in exactly one suite");
    }
    const before = readRun(baseline);
    const report = compareRuns({
      baseline: { runId: before.manifest.runId, results: before.results },
      current: { runId: result.runId, results: result.results },
      candidateId: candidate.id,
      suite,
    });
    const text = renderRegression(report);
    writeText(`${paths.dir}/regression.md`, `${text}\n`);
    console.log(`\n${text}`);
  }
}

function commandRank(args: Args): void {
  const runId = args.flags.get("run") ?? listRuns().at(-1);
  if (!runId) throw new Error("No run found. Pass --run <id>.");
  const suiteValue = args.flags.get("suite");
  const suite = suiteValue ? (parseSuites(suiteValue)[0] as SuiteName) : undefined;

  const run = readRun(runId);
  const byRole = rankRun({
    results: run.results,
    key: run.key,
    choices: run.choices,
    ...(suite === undefined ? {} : { suite }),
  });
  const ranking = renderRanking(byRole, {
    runId,
    ...(suite === undefined ? {} : { suite }),
    hasChoices: run.choices !== null,
  });
  // For the judge role the threshold is the real question: which backend
  // wins is decided by the ranking, where the line lies by this table.
  const sweep = run.results.some((entry) => entry.suite === "judge")
    ? renderGateSweep(
        gateSweep({
          results: run.results,
          cases: loadSuite("judge").cases as JudgeCase[],
        }),
      )
    : "";
  const text = sweep ? `${ranking}\n${sweep}` : ranking;
  writeText(run.paths.ranking, `${text}\n`);
  console.log(text);
  if (!run.choices) {
    console.log(
      `\nNote: ${run.paths.choices} is missing. Open the report, choose, put the JSON block there, then run again.`,
    );
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "rank") {
    commandRank(args);
    return;
  }
  await commandRun(args);
}

main().catch((error: unknown) => {
  console.error((error as Error).message);
  process.exitCode = 1;
});
