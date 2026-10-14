import { owner } from "../src/config/owner.js";
import { passRate } from "./checks.js";
import { candidateById } from "./config.js";
import type { CaseRun, ChoiceFile, JudgeCase, RoleName, RunKey, SuiteName } from "./types.js";

/**
 * Evaluation. Three sources, deliberately not stirred into one number:
 *
 * - **The owner's choice** from the blind comparison. That is the actual verdict.
 * - **Rule checks** (W2). Measurable, but blind to everything that is not a rule.
 * - **Cost and latency.** Stay a separate column and do *not* go into the
 *   score: D3 says "the owner chooses per role with an eye on cost per turn",
 *   not "the cheapest wins". A cost penalty folded in would secretly preempt
 *   that decision.
 *
 * Latency counts too, because a friend who needs twelve seconds to type feels
 * wrong, no matter how good the sentence is.
 */

export interface CandidateScore {
  candidateId: string;
  label: string;
  role: RoleName;
  cases: number;
  errors: number;
  /** Share of passed rule checks across all cases. */
  passRate: number;
  /** How often the owner chose this candidate. */
  wins: number;
  /** Cases in which the owner chose at all and this candidate competed. */
  votes: number;
  winRate: number;
  totalCostUsd: number;
  avgCostUsd: number;
  medianLatencyMs: number;
  score: number;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] as number;
  return (((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2);
}

export interface RankOptions {
  results: readonly CaseRun[];
  key: RunKey;
  choices: ChoiceFile | null;
  /** Evaluate only this suite. Without it, all. */
  suite?: SuiteName;
}

/**
 * Ranking per role. Candidates of different roles are never
 * set against each other: ranking an extraction model against a chat model
 * would be a number without meaning.
 */
export function rankRun(options: RankOptions): Record<string, CandidateScore[]> {
  const results = options.suite
    ? options.results.filter((run) => run.suite === options.suite)
    : options.results;

  // Who competed in which case? For the win rate only cases count in which
  // the candidate was up for choice at all.
  const contenders = new Map<string, Set<string>>();
  for (const run of results) {
    const caseKey = `${run.suite}/${run.caseId}`;
    const set = contenders.get(caseKey) ?? new Set<string>();
    set.add(run.candidateId);
    contenders.set(caseKey, set);
  }

  const winnerByCase = new Map<string, string | null>();
  for (const [caseKey, alias] of Object.entries(options.choices?.choices ?? {})) {
    const candidate = alias ? options.key.aliases[alias] : null;
    winnerByCase.set(caseKey, candidate?.id ?? null);
  }

  const byCandidate = new Map<string, CaseRun[]>();
  for (const run of results) {
    byCandidate.set(run.candidateId, [...(byCandidate.get(run.candidateId) ?? []), run]);
  }

  const scores: CandidateScore[] = [];
  for (const [candidateId, runs] of byCandidate) {
    const candidate = candidateById(candidateId);
    const checks = runs.flatMap((run) => run.checks);
    const okRuns = runs.filter((run) => run.ok);

    let wins = 0;
    let votes = 0;
    for (const [caseKey, winner] of winnerByCase) {
      if (!contenders.get(caseKey)?.has(candidateId)) continue;
      votes += 1;
      if (winner === candidateId) wins += 1;
    }

    const totalCostUsd = runs.reduce((sum, run) => sum + run.costUsd, 0);
    scores.push({
      candidateId,
      label: candidate?.label ?? candidateId,
      role: candidate?.role ?? "chat",
      cases: runs.length,
      errors: runs.length - okRuns.length,
      passRate: passRate(checks),
      wins,
      votes,
      winRate: votes > 0 ? wins / votes : 0,
      totalCostUsd,
      avgCostUsd: runs.length > 0 ? totalCostUsd / runs.length : 0,
      medianLatencyMs: Math.round(median(okRuns.map((run) => run.latencyMs))),
      score: 0,
    });
  }

  const byRole: Record<string, CandidateScore[]> = {};
  for (const score of scores) {
    byRole[score.role] = [...(byRole[score.role] ?? []), score];
  }

  for (const group of Object.values(byRole)) {
    const latencies = group.map((score) => score.medianLatencyMs);
    const fastest = Math.min(...latencies);
    const slowest = Math.max(...latencies);
    for (const score of group) {
      const speed =
        slowest === fastest ? 1 : 1 - (score.medianLatencyMs - fastest) / (slowest - fastest);
      const voted = score.votes > 0;
      // Without the owner's choice the score carries only the rule checks; it then
      // claims no more than it knows.
      score.score = voted
        ? 0.5 * score.winRate + 0.4 * score.passRate + 0.1 * speed
        : 0.85 * score.passRate + 0.15 * speed;
    }
    group.sort((a, b) => b.score - a.score);
  }
  return byRole;
}

export function renderRanking(
  byRole: Record<string, CandidateScore[]>,
  meta: { runId: string; suite?: SuiteName; hasChoices: boolean },
): string {
  const lines: string[] = [
    `# Eval ranking · ${meta.runId}${meta.suite ? ` · suite ${meta.suite}` : ""}`,
    "",
    meta.hasChoices
      ? `Score: 50 % ${owner.name}'s blind choice, 40 % rule checks, 10 % speed.`
      : `Without \`choices.json\`: score from rule checks (85 %) and speed (15 %). ${owner.name}'s blind choice is still missing, so the ranking is only half the truth.`,
    "",
    `Cost stands alongside and is deliberately not factored in: D3 says ${owner.name} chooses with an eye on cost per turn, not that the cheapest wins.`,
    "",
  ];

  for (const [role, group] of Object.entries(byRole)) {
    lines.push(`## Role ${role}`, "");
    lines.push(`| # | Candidate | Score | Rule checks | ${owner.name}'s choice | Errors | ⌀ cost | Median latency |`);
    lines.push("|---|---|---|---|---|---|---|---|");
    for (const [index, score] of group.entries()) {
      lines.push(
        `| ${index + 1} | ${score.label} | ${score.score.toFixed(3)} | ${Math.round(score.passRate * 100)} % | ` +
          `${score.wins}/${score.votes} | ${score.errors}/${score.cases} | ` +
          `${score.avgCostUsd.toFixed(4)} $ | ${score.medianLatencyMs} ms |`,
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}

// --- Gate threshold --------------------------------------------------------

/**
 * The thresholds `MEMORY.gateThreshold` can plausibly take. Not read from
 * the config: the point here is the comparison *with* alternatives,
 * not the current value.
 */
export const GATE_THRESHOLDS = [0.4, 0.5, 0.6] as const;

export interface GateSweepRow {
  candidateId: string;
  label: string;
  threshold: number;
  cases: number;
  hits: number;
  /** Worth remembering, but below the threshold: the fact is lost. */
  falseNegatives: number;
  /** Not worth remembering, but above the threshold: one extraction too many. */
  falsePositives: number;
  hitRate: number;
}

/**
 * What happens to the memory gate when the threshold is moved?
 *
 * Computed over the raw probabilities of a run, not over its
 * yes/no answers; that is why `eval/run.ts` records them. One run
 * is thus enough for all thresholds, instead of one per threshold.
 *
 * The two errors are deliberately reported separately and not stirred into one
 * number: a false negative costs a fact nobody misses until it is
 * missing; a false positive costs an extraction call. That is not
 * the same price, and which weighs more is decided by the owner, not by this
 * function.
 */
export function gateSweep(args: {
  results: readonly CaseRun[];
  cases: readonly JudgeCase[];
  thresholds?: readonly number[];
}): GateSweepRow[] {
  const thresholds = args.thresholds ?? GATE_THRESHOLDS;
  const expected = new Map<string, boolean>();
  for (const testCase of args.cases) {
    if (testCase.expected.kind === "boolean") expected.set(testCase.id, testCase.expected.value);
  }

  const usable = args.results.filter(
    (run) =>
      run.suite === "judge" &&
      run.ok &&
      expected.has(run.caseId) &&
      typeof run.judge?.probability === "number",
  );

  const byCandidate = new Map<string, CaseRun[]>();
  for (const run of usable) {
    byCandidate.set(run.candidateId, [...(byCandidate.get(run.candidateId) ?? []), run]);
  }

  const rows: GateSweepRow[] = [];
  for (const [candidateId, runs] of byCandidate) {
    for (const threshold of thresholds) {
      let hits = 0;
      let falseNegatives = 0;
      let falsePositives = 0;
      for (const run of runs) {
        const kept = (run.judge?.probability ?? 0) >= threshold;
        const want = expected.get(run.caseId) === true;
        if (kept === want) hits += 1;
        else if (want) falseNegatives += 1;
        else falsePositives += 1;
      }
      rows.push({
        candidateId,
        label: candidateById(candidateId)?.label ?? candidateId,
        threshold,
        cases: runs.length,
        hits,
        falseNegatives,
        falsePositives,
        hitRate: runs.length > 0 ? hits / runs.length : 0,
      });
    }
  }
  return rows;
}

export function renderGateSweep(rows: readonly GateSweepRow[]): string {
  if (rows.length === 0) return "";
  const lines = [
    "## Gate threshold",
    "",
    "Computed over the raw probabilities of the same run. False negative means: the fact would have been lost. False positive means: an extraction for nothing.",
    "",
    "| Candidate | Threshold | Hits | Rate | false negative | false positive |",
    "|---|---|---|---|---|---|",
  ];
  for (const row of rows) {
    lines.push(
      `| ${row.label} | ${row.threshold.toFixed(2)} | ${row.hits}/${row.cases} | ` +
        `${Math.round(row.hitRate * 100)} % | ${row.falseNegatives} | ${row.falsePositives} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

// --- Regression comparison -------------------------------------------------

export interface RegressionRow {
  checkId: string;
  baseline: number;
  current: number;
  delta: number;
}

export interface RegressionReport {
  candidateId: string;
  suite: SuiteName;
  baselineRunId: string;
  currentRunId: string;
  overallBaseline: number;
  overallCurrent: number;
  rows: RegressionRow[];
  /** A check that was better before is a regression. */
  regressions: RegressionRow[];
}

function rateByCheck(runs: readonly CaseRun[]): Map<string, number> {
  const tally = new Map<string, { passed: number; total: number }>();
  for (const run of runs) {
    for (const check of run.checks) {
      const entry = tally.get(check.id) ?? { passed: 0, total: 0 };
      entry.total += 1;
      if (check.passed) entry.passed += 1;
      tally.set(check.id, entry);
    }
  }
  return new Map([...tally].map(([id, entry]) => [id, entry.passed / entry.total]));
}

/**
 * Compares a candidate's rule-check rates with an earlier run.
 * Meant for later prompt changes: same suite, same model, only
 * a different prompt, and then visible what got better and what got worse.
 */
export function compareRuns(args: {
  baseline: { runId: string; results: readonly CaseRun[] };
  current: { runId: string; results: readonly CaseRun[] };
  candidateId: string;
  suite: SuiteName;
}): RegressionReport {
  const pick = (runs: readonly CaseRun[]): CaseRun[] =>
    runs.filter((run) => run.candidateId === args.candidateId && run.suite === args.suite);
  const before = pick(args.baseline.results);
  const after = pick(args.current.results);
  if (before.length === 0) {
    throw new Error(
      `Baseline ${args.baseline.runId} contains no results for ${args.candidateId} in suite ${args.suite}`,
    );
  }

  const beforeRates = rateByCheck(before);
  const afterRates = rateByCheck(after);
  const ids = [...new Set([...beforeRates.keys(), ...afterRates.keys()])].sort();
  const rows: RegressionRow[] = ids.map((checkId) => {
    const baseline = beforeRates.get(checkId) ?? 0;
    const current = afterRates.get(checkId) ?? 0;
    return { checkId, baseline, current, delta: current - baseline };
  });

  return {
    candidateId: args.candidateId,
    suite: args.suite,
    baselineRunId: args.baseline.runId,
    currentRunId: args.current.runId,
    overallBaseline: passRate(before.flatMap((run) => run.checks)),
    overallCurrent: passRate(after.flatMap((run) => run.checks)),
    rows,
    regressions: rows.filter((row) => row.delta < 0),
  };
}

export function renderRegression(report: RegressionReport): string {
  const lines = [
    `# Regression · ${report.candidateId} · suite ${report.suite}`,
    "",
    `Baseline ${report.baselineRunId}: ${Math.round(report.overallBaseline * 100)} %`,
    `Now ${report.currentRunId}: ${Math.round(report.overallCurrent * 100)} %`,
    "",
    "| Check | before | now | Δ |",
    "|---|---|---|---|",
  ];
  for (const row of report.rows) {
    const arrow = row.delta > 0 ? "▲" : row.delta < 0 ? "▼" : "=";
    lines.push(
      `| ${row.checkId} | ${Math.round(row.baseline * 100)} % | ${Math.round(row.current * 100)} % | ${arrow} ${Math.round(row.delta * 100)} |`,
    );
  }
  lines.push(
    "",
    report.regressions.length === 0
      ? "No regression."
      : `${report.regressions.length} check(s) worse than before: ${report.regressions.map((row) => row.checkId).join(", ")}.`,
  );
  return lines.join("\n");
}
