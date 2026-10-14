import type { Ledger } from "./sink.js";
import { CATEGORIES, type CaseResult, type Category, type MemoryRunManifest, type UsageTotals } from "./types.js";

/**
 * Report of the memory eval: hit rate per category and level, **no
 * overall grade**. Six cases per category only carry large differences, and
 * an average across forgetting and recall says nothing about either.
 *
 * Checks that can only pass with fact kind and validity (V2)
 * stand in their own columns. Otherwise the baseline would look worse than
 * today's code is for what it claims to do, and better after V2 than
 * the change deserves.
 */

/** text-embedding-3-small: 0.02 $ per million tokens. Roughly four characters per token. */
const EMBEDDING_USD_PER_CHAR = 0.02 / 1_000_000 / 4;

export function estimateEmbeddingUsd(chars: number): number {
  return chars * EMBEDDING_USD_PER_CHAR;
}

export function summarizeUsage(ledger: Ledger, embeddingChars: number): UsageTotals {
  const groups = new Map<string, UsageTotals["calls"][number]>();
  for (const entry of ledger.usage) {
    const key = `${entry.provider}|${entry.role}|${entry.model}`;
    const group = groups.get(key) ?? {
      provider: entry.provider,
      role: entry.role,
      model: entry.model,
      count: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    };
    group.count += 1;
    group.inputTokens += entry.inputTokens;
    group.outputTokens += entry.outputTokens;
    group.costUsd += entry.costUsd;
    groups.set(key, group);
  }
  const calls = [...groups.values()].sort((a, b) => `${a.provider}${a.role}`.localeCompare(`${b.provider}${b.role}`));
  return {
    calls,
    openrouterUsd: calls.filter((call) => call.provider === "openrouter").reduce((sum, call) => sum + call.costUsd, 0),
    embeddingChars,
    fallbacks: ledger.audits.filter((entry) => entry.event === "model_fallback" || entry.event === "judge_fallback").length,
    unexpectedDbAccess: [...ledger.unexpected],
  };
}

export function mergeUsage(parts: readonly UsageTotals[]): UsageTotals {
  const groups = new Map<string, UsageTotals["calls"][number]>();
  for (const part of parts) {
    for (const call of part.calls) {
      const key = `${call.provider}|${call.role}|${call.model}`;
      const group = groups.get(key) ?? { ...call, count: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
      group.count += call.count;
      group.inputTokens += call.inputTokens;
      group.outputTokens += call.outputTokens;
      group.costUsd += call.costUsd;
      groups.set(key, group);
    }
  }
  return {
    calls: [...groups.values()],
    openrouterUsd: parts.reduce((sum, part) => sum + part.openrouterUsd, 0),
    embeddingChars: parts.reduce((sum, part) => sum + part.embeddingChars, 0),
    fallbacks: parts.reduce((sum, part) => sum + part.fallbacks, 0),
    unexpectedDbAccess: parts.flatMap((part) => part.unexpectedDbAccess),
  };
}

// --- Aggregation ------------------------------------------------------------

/** The table's columns. Every check falls into exactly one. */
export const COLUMNS = ["L1", "L1·V2", "L2 R@5", "L2 R@12", "L2 Abs@3", "L2·V2", "L3"] as const;
export type Column = (typeof COLUMNS)[number];

export function columnOf(check: CaseResult["checks"][number]): Column {
  if (check.level === 1) return check.needsV2 ? "L1·V2" : "L1";
  if (check.level === 3) return "L3";
  if (check.needsV2) return "L2·V2";
  if (check.kind === "recall@5") return "L2 R@5";
  if (check.kind === "recall@12") return "L2 R@12";
  return "L2 Abs@3";
}

export interface Tally {
  passed: number;
  total: number;
}

export type Table = Map<Category, Map<Column, Tally>>;

export function tabulate(results: readonly CaseResult[]): Table {
  const table: Table = new Map();
  for (const result of results) {
    const row = table.get(result.category) ?? new Map<Column, Tally>();
    for (const check of result.checks) {
      const column = columnOf(check);
      const cell = row.get(column) ?? { passed: 0, total: 0 };
      cell.total += 1;
      if (check.passed) cell.passed += 1;
      row.set(column, cell);
    }
    table.set(result.category, row);
  }
  return table;
}

function cell(tally: Tally | undefined): string {
  return tally && tally.total > 0 ? `${tally.passed}/${tally.total}` : "–";
}

// --- Markdown ---------------------------------------------------------------

export function renderMarkdown(manifest: MemoryRunManifest, results: readonly CaseResult[]): string {
  const lines: string[] = [];
  const control = manifest.control === "none";
  lines.push(`# Memory eval ${manifest.runId}${control ? " · control without memory" : ""}`, "");
  lines.push(
    `Levels ${manifest.levels.join(", ")} · ${new Set(results.map((r) => r.caseId)).size} cases · ` +
      `${manifest.repeat}× · parallel ${manifest.concurrency} · cap ${manifest.capUsd.toFixed(2)} $ (OpenRouter)`,
  );
  lines.push(`Start ${manifest.startedAt} · end ${manifest.finishedAt}`);
  if (manifest.abortedAt) lines.push("", `**Aborted:** ${manifest.abortedAt}`);
  if (control) {
    lines.push(
      "",
      "Control: empty memory block and empty user model, no history. Level 3 should be close to 0 here,",
      "except for abstention, false premise and misapplication, where not knowing is the right answer.",
    );
  }

  lines.push("", "## Hit rate per category and level", "");
  lines.push(
    "L1 state after the pipeline (SQL) · L2 recall via `search_facts` (Recall@k, Absence@3) · L3 answer end to end (rules).",
    "Columns with ·V2 contain checks that need fact kind or validity (V2) and may fail today.",
    "",
  );
  const table = tabulate(results);
  lines.push(`| Category | Cases (holdout) | ${COLUMNS.join(" | ")} |`);
  lines.push(`|---|---|${COLUMNS.map(() => "---").join("|")}|`);
  for (const category of CATEGORIES) {
    const ofCategory = results.filter((result) => result.category === category && result.iteration === 1);
    if (ofCategory.length === 0) continue;
    const holdout = ofCategory.filter((result) => result.holdout).length;
    const row = table.get(category);
    lines.push(
      `| ${category} | ${ofCategory.length} (${holdout}) | ${COLUMNS.map((column) => cell(row?.get(column))).join(" | ")} |`,
    );
  }

  const holdoutResults = results.filter((result) => result.holdout);
  if (holdoutResults.length > 0 && holdoutResults.length < results.length) {
    const tuned = tabulate(results.filter((result) => !result.holdout));
    const held = tabulate(holdoutResults);
    const sum = (t: Table, column: Column): Tally => {
      const out = { passed: 0, total: 0 };
      for (const row of t.values()) {
        const c = row.get(column);
        if (c) {
          out.passed += c.passed;
          out.total += c.total;
        }
      }
      return out;
    };
    lines.push("", "Holdout versus tuning cases (only for spotting overfitting, not a grade):", "");
    lines.push(`| Part | ${COLUMNS.join(" | ")} |`, `|---|${COLUMNS.map(() => "---").join("|")}|`);
    lines.push(`| Tuning | ${COLUMNS.map((column) => cell(sum(tuned, column))).join(" | ")} |`);
    lines.push(`| Holdout | ${COLUMNS.map((column) => cell(sum(held, column))).join(" | ")} |`);
  }

  const usage = manifest.usage;
  lines.push("", "## Calls and cost", "");
  lines.push("| Provider | Role | Model | Calls | Tokens in/out | Cost |", "|---|---|---|---|---|---|");
  for (const call of usage.calls) {
    lines.push(
      `| ${call.provider} | ${call.role} | ${call.model} | ${call.count} | ${call.inputTokens}/${call.outputTokens} | ${call.costUsd.toFixed(6)} $ |`,
    );
  }
  lines.push(
    "",
    `OpenRouter per responses: ${usage.openrouterUsd.toFixed(6)} $ · embedding characters ${usage.embeddingChars} ` +
      `(estimate ${manifest.embeddingEstimateUsd.toFixed(6)} $) · subscription calls 0 $ · fallbacks ${usage.fallbacks}`,
    `Unexpected database accesses: ${usage.unexpectedDbAccess.length === 0 ? "none" : usage.unexpectedDbAccess.join(", ")}`,
  );

  // How often `forget_fact` asked back although the instruction was clear. No
  // pass/fail: per D13 asking back is right when the target is unclear.
  // But every follow-up question is one more round for the owner, and the number shows whether
  // a change to search or threshold shifts anything there.
  const forgets = results.flatMap((result) => result.trace.flatMap((trace) => (trace.forget ? [trace.forget] : [])));
  if (forgets.length > 0) {
    const ambiguous = forgets.filter((forget) => forget.ambiguous).length;
    const deleted = forgets.filter((forget) => forget.ok).length;
    lines.push(
      "",
      `forget_fact: ${forgets.length} instructions, ${ambiguous} of them with a follow-up question (owner's choice simulated), ${deleted} deleted in the end.`,
    );
  }

  const errors = results.filter((result) => !result.ok);
  if (errors.length > 0) {
    lines.push("", "## Failed cases", "");
    for (const result of errors) lines.push(`- ${result.caseId} (#${result.iteration}): ${result.error ?? ""}`);
  }

  const pipelineErrors = results.flatMap((result) =>
    result.trace.filter((trace) => trace.error).map((trace) => `${result.caseId}: "${trace.text}" → ${trace.error}`),
  );
  if (pipelineErrors.length > 0) {
    lines.push("", "## Errors in the write path", "", ...pipelineErrors.map((line) => `- ${line}`));
  }

  lines.push("", "## Failed checks", "");
  let any = false;
  for (const result of results) {
    const failed = result.checks.filter((check) => !check.passed);
    if (failed.length === 0) continue;
    any = true;
    const tags = [result.holdout ? "holdout" : "", result.negative ? "counter-check" : "", manifest.repeat > 1 ? `#${result.iteration}` : ""]
      .filter(Boolean)
      .join(", ");
    lines.push(`### ${result.caseId}${tags ? ` (${tags})` : ""}`);
    for (const check of failed) {
      lines.push(`- \`${check.id}\`${check.needsV2 ? " [V2]" : ""}: ${check.detail ?? ""}`);
    }
    const gates = result.trace
      .filter((trace) => trace.from === "owner")
      .map((trace) => {
        const gate = trace.gate === undefined ? (trace.forget ? "forget" : "–") : trace.gate.toFixed(2);
        const stored = trace.stored.length > 0 ? ` → ${trace.stored.map((s) => `"${s}"`).join("; ")}` : "";
        const decisions = trace.decisions.length > 0 ? ` [${trace.decisions.join(", ")}]` : "";
        const forget = trace.forget
          ? ` forget_fact("${trace.forget.what}")${trace.forget.ambiguous ? ` ambiguous${trace.forget.picked ? `, choice: ${trace.forget.picked.map((p) => `"${p}"`).join(", ")}` : ", no choice"}` : ""}: ${trace.forget.text.split("\n")[0]}`
          : "";
        return `  - Gate ${gate}: "${trace.text}"${stored}${decisions}${forget}`;
      });
    if (gates.length > 0) lines.push("- Trace:", ...gates);
    if (result.answer) lines.push(`- Answer: "${result.answer.text.replace(/\n/g, " / ")}"`);
    lines.push("");
  }
  if (!any) lines.push("None.");

  lines.push(
    "",
    "## Limits",
    "",
    "- No LLM judge: level 3 only checks required variants and forbidden words. The judge after Memora (two binary",
    "  criteria, a different model family, checked beforehand against deliberately wrong answers) is missing in this version.",
    "- Cases and prompts come from the same hand: the eval shows regressions and improvements in the same harness,",
    "  not absolute quality.",
    "- Without an oracle upper bound (only evidence messages in context); the control without memory runs with `--control none`.",
  );
  return `${lines.join("\n")}\n`;
}
