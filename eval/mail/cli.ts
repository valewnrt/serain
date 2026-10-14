// First import, before everything else: keeps the eval away from the production database (see sink.ts).
import { runLedger, SINK_URL } from "../memory/sink.js";
// Right after: synthetic cases take place at Alex's, real samples (--cases) at the owner's (see ../persona.ts).
import "../persona.js";

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { RoutedJudge } from "../../src/agent/judge/index.js";
import type { JudgeBackendName, JudgeChoiceAnswer } from "../../src/agent/judge/types.js";
import { env } from "../../src/config/env.js";
import { judgedFinding, looksLikeFinding } from "../../src/mail/findings.js";
import { judgedCategory, mailJudgeRequest, prepareAttachmentNames, prepareMailText } from "../../src/mail/trigger.js";
import { newRunId } from "../store.js";
import { parseMailCases, reported, summarize, type MailCase, type MailCaseResult } from "./score.js";

/**
 * Mail eval (addendum to D33 of 2026-10-08): asks `judge` exactly the question
 * the mail trigger asks for every case, and compares "reported" with the
 * expected verdict.
 *
 *   pnpm eval:mail                                  synthetic cases from eval/cases/mail.json
 *   pnpm eval:mail --cases <path>                   other cases, e.g. real samples outside the repo
 *   pnpm eval:mail --backends generative            only one backend (default as in the trigger: jev, generative)
 *   pnpm eval:mail --rules <module>                 a different `mailJudgeRequest`, e.g. the rules before a change
 *   pnpm eval:mail --out <path>                     result there instead of data/eval/mail-runs/
 *
 * Real mails never belong in the repo: cases from the real mailbox live outside it,
 * and so does `--out` for their runs. Nothing goes to Supabase (sink.ts); the cost
 * is printed at the end from the intercepted `usage_log` rows.
 */

type RequestBuilder = typeof mailJudgeRequest;

function parseArgs(argv: readonly string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] as string;
    const value = argv[i + 1];
    if (!token.startsWith("--") || value === undefined || value.startsWith("--")) throw new Error(`Unexpected argument "${token}"`);
    flags.set(token.slice(2), value);
    i += 1;
  }
  for (const name of flags.keys()) {
    if (!["cases", "backends", "rules", "out", "concurrency"].includes(name)) throw new Error(`Unknown option --${name}`);
  }
  return flags;
}

async function loadBuilder(path: string | undefined): Promise<RequestBuilder> {
  if (!path) return mailJudgeRequest;
  const module = (await import(pathToFileURL(resolve(path)).href)) as { mailJudgeRequest?: RequestBuilder };
  if (typeof module.mailJudgeRequest !== "function") throw new Error(`${path} does not export mailJudgeRequest`);
  return module.mailJudgeRequest;
}

async function runCase(judge: RoutedJudge, build: RequestBuilder, testCase: MailCase, now: Date): Promise<MailCaseResult> {
  const base = { id: testCase.id, expected: testCase.expected, expectedFinding: testCase.finding };
  // As in the trigger: `judge` only sees bulk and machine mail when there is a hint of a finding, and then only asks about that.
  const machine = testCase.bulk || testCase.automated;
  const finding = looksLikeFinding(testCase.subject, testCase.text, testCase.attachments);
  if (machine && !finding) return { ...base, category: "header", pSomething: null, source: null, error: null, finding: null };
  try {
    const date = new Date(now.getTime() - testCase.daysAgo * 86_400_000).toISOString();
    const request = build(
      { from: testCase.from, subject: testCase.subject, date, text: prepareMailText(testCase.text), attachments: prepareAttachmentNames(testCase.attachments) },
      testCase.known,
      testCase.mailbox,
      { kind: !machine, finding },
    );
    const result = await judge.ask(request);
    const kind = result.answers["kind"] as JudgeChoiceAnswer | undefined;
    const found = finding ? judgedFinding(result.answers["finding"] as JudgeChoiceAnswer | undefined) : null;
    if (!kind) return { ...base, category: "header", pSomething: null, source: null, error: null, finding: found };
    const { category } = judgedCategory(kind, result.answers["which"] as JudgeChoiceAnswer | undefined, testCase.known);
    return { ...base, category, pSomething: Number((1 - (kind.probabilities["none"] ?? 0)).toFixed(2)), source: kind.source, error: null, finding: found };
  } catch (error) {
    return { ...base, category: "none", pSomething: null, source: null, error: (error as Error).message };
  }
}

async function main(): Promise<void> {
  if (env.supabaseUrl !== SINK_URL) throw new Error("Mail eval without database interception: aborting");
  const flags = parseArgs(process.argv.slice(2));
  const cases = parseMailCases(JSON.parse(readFileSync(flags.get("cases") ?? "eval/cases/mail.json", "utf8")));
  const backends = (flags.get("backends") ?? "jev,generative").split(",").map((name) => name.trim()) as JudgeBackendName[];
  const judge = new RoutedJudge(backends);
  const build = await loadBuilder(flags.get("rules"));
  const concurrency = Number(flags.get("concurrency") ?? 4);
  const now = new Date();

  const results: MailCaseResult[] = new Array(cases.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, concurrency) }, async () => {
      while (next < cases.length) {
        const index = next++;
        results[index] = await runCase(judge, build, cases[index] as MailCase, now);
      }
    }),
  );

  for (const result of results) {
    const mark = result.error ? "ERROR" : reported(result) === (result.expected === "wichtig") ? "ok" : "WRONG";
    const found = result.expectedFinding ? ` finding ${result.finding ?? "-"}${(result.finding ?? "none") === result.expectedFinding ? "" : ` (expected ${result.expectedFinding})`}` : "";
    console.log([mark.padEnd(6), result.expected.padEnd(9), result.category.padEnd(14), String(result.pSomething ?? "-").padEnd(5), result.id].join(" ") + found);
  }
  const summary = summarize(results);
  const costUsd = runLedger.usage.reduce((sum, entry) => sum + entry.costUsd, 0);
  const fallbacks = runLedger.audits.filter((entry) => entry.event === "judge_fallback").length;
  console.log(
    `\n${summary.correct}/${summary.total} correct, ${summary.falseAlarms.length} false alarms, ${summary.misses.length} missed` +
      ` (${summary.lostAtHeader.length} of them at the header), ${summary.errors.length} errors, ${fallbacks} fallbacks, ${costUsd.toFixed(4)} $`,
  );
  if (summary.findings.total > 0) {
    console.log(`Findings: ${summary.findings.correct}/${summary.findings.total} correct${summary.findings.wrong.length > 0 ? `, wrong: ${summary.findings.wrong.join(", ")}` : ""}`);
  }

  const out = flags.get("out") ?? `data/eval/mail-runs/${newRunId()}.json`;
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({ backends, rules: flags.get("rules") ?? "src/mail/trigger.ts", summary, costUsd, fallbacks, results }, null, 2));
  console.log(`Result: ${out}`);
}

main().catch((error: unknown) => {
  console.error((error as Error).message);
  process.exitCode = 1;
});
