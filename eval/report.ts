import { aliasAt } from "./anonymize.js";
import { passRate } from "./checks.js";
import type { CaseRun, RunManifest, SuiteName } from "./types.js";

/**
 * The blind comparison for the owner. A local HTML file, no server, no
 * network: answers side by side, candidates are called A, B, C, and the owner clicks
 * the winner for each case.
 *
 * The choice lands in browser storage and at the same time as JSON in the text field below.
 * The owner puts it next to the report as `choices.json`, then
 * `pnpm eval:rank --run <run>` computes the ranking from it.
 *
 * Pure function: results go in, a string comes out. That makes it
 * testable, and it can never accidentally pass a model name through.
 */

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function nl2br(value: string): string {
  return escapeHtml(value).replace(/\n/g, "<br>");
}

function renderRecord(run: CaseRun): string {
  if (!run.ok) return `<p class="fail">Failed: ${escapeHtml(run.error ?? "unknown")}</p>`;
  const record = run.record;
  if (!record) return `<p class="muted">No recording.</p>`;

  const bubbles = record.messages
    .map(
      (message) =>
        `<div class="bubble">${nl2br(message.text)}<span class="kind">${escapeHtml(message.kind)}</span></div>`,
    )
    .join("");
  const reactions = record.reactions.length
    ? `<div class="tapbacks">Tapback: ${record.reactions.map((r) => escapeHtml(r.emoji)).join(" ")}</div>`
    : "";
  const silence = !bubbles && !reactions ? `<p class="muted">Nothing sent.</p>` : "";
  const fallback = record.usedTextFallback
    ? `<p class="warn">Emergency exit: no messaging tool used.</p>`
    : "";
  const tools = record.toolCalls.length
    ? `<p class="tools">${record.toolCalls.map((call) => escapeHtml(call.name)).join(" → ")}</p>`
    : "";
  return `${bubbles}${reactions}${silence}${fallback}${tools}`;
}

function renderChecks(run: CaseRun): string {
  if (run.checks.length === 0) return "";
  const items = run.checks
    .map((check) => {
      const cls = check.passed ? "pass" : "fail";
      const detail = check.detail ? ` <span class="detail">${escapeHtml(check.detail)}</span>` : "";
      return `<li class="${cls}">${escapeHtml(check.id)}${detail}</li>`;
    })
    .join("");
  return `<ul class="checks">${items}</ul>`;
}

export interface ReportInput {
  manifest: RunManifest;
  results: readonly CaseRun[];
  /** Where the cases per suite came from. Shown in the header so that nobody mistakes
   *  synthetic turns for the owner's real ones. */
  sources: Partial<Record<SuiteName, string>>;
}

export function renderReport(input: ReportInput): string {
  const { manifest, results } = input;
  const aliases = [...new Set(results.map((run) => run.alias))].sort(
    (a, b) => a.localeCompare(b),
  );

  const byCase = new Map<string, CaseRun[]>();
  for (const run of results) {
    const list = byCase.get(`${run.suite}/${run.caseId}`) ?? [];
    list.push(run);
    byCase.set(`${run.suite}/${run.caseId}`, list);
  }

  const cards = [...byCase.entries()]
    .map(([caseKey, runs]) => {
      const first = runs[0] as CaseRun;
      const present = [...runs].sort((a, b) => a.alias.localeCompare(b.alias));
      const columns = present
        .map(
          (run) => `
        <div class="col">
          <header>
            <label><input type="radio" name="${escapeHtml(caseKey)}" value="${escapeHtml(run.alias)}"> ${escapeHtml(run.alias)}</label>
            <span class="meta">${run.costUsd.toFixed(4)} $ · ${run.latencyMs} ms · ${Math.round(passRate(run.checks) * 100)} %</span>
          </header>
          ${renderRecord(run)}
          ${renderChecks(run)}
        </div>`,
        )
        .join("");
      const note = first.note ? `<p class="note">${escapeHtml(first.note)}</p>` : "";
      return `
    <section class="case" data-case="${escapeHtml(caseKey)}">
      <h2>${escapeHtml(caseKey)}</h2>
      <blockquote>${nl2br(first.input)}</blockquote>
      ${note}
      <div class="cols">${columns}</div>
      <label class="skip"><input type="radio" name="${escapeHtml(caseKey)}" value=""> none convinces</label>
    </section>`;
    })
    .join("");

  const sourceLines = Object.entries(input.sources)
    .map(([suite, source]) => `${escapeHtml(suite)}: ${escapeHtml(source ?? "")}`)
    .join(" · ");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Serain Eval ${escapeHtml(manifest.runId)}</title>
<style>
  :root { color-scheme: light dark; --line: #d9d5cc; --muted: #6b6b6b; }
  body { margin: 0; padding: 24px; font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 1200px; margin-inline: auto; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .head { border-bottom: 1px solid var(--line); padding-bottom: 12px; margin-bottom: 20px; }
  .muted, .meta, .note, .detail { color: var(--muted); font-size: 13px; }
  .case { border-bottom: 1px solid var(--line); padding: 18px 0; }
  .case h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin: 0 0 8px; }
  blockquote { margin: 0 0 6px; padding: 10px 12px; background: rgba(127,127,127,.1); border-radius: 10px; white-space: pre-wrap; }
  .note { margin: 0 0 12px; }
  .cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 14px; }
  .col { border: 1px solid var(--line); border-radius: 12px; padding: 12px; }
  .col header { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; margin-bottom: 8px; }
  .col header label { font-weight: 600; }
  .bubble { background: #1c8cf6; color: #fff; border-radius: 16px; padding: 8px 12px; margin-bottom: 6px; white-space: pre-wrap; }
  .bubble .kind { display: block; font-size: 11px; opacity: .7; margin-top: 4px; }
  .tapbacks { font-size: 20px; margin: 4px 0; }
  .tools { font-size: 12px; color: var(--muted); margin: 8px 0 0; }
  .checks { list-style: none; padding: 0; margin: 10px 0 0; font-size: 12px; }
  .checks li::before { content: "✓ "; }
  .checks li.fail { color: #c0392b; }
  .checks li.fail::before { content: "✗ "; }
  .pass { color: #2d7a3e; }
  .fail { color: #c0392b; }
  .warn { color: #b8860b; font-size: 13px; }
  .skip { display: inline-block; margin-top: 10px; font-size: 13px; color: var(--muted); }
  #out { width: 100%; height: 160px; font-family: ui-monospace, monospace; font-size: 12px; margin-top: 8px; }
  @media (max-width: 640px) { body { padding: 16px; } .cols { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<div class="head">
  <h1>Serain Eval · ${escapeHtml(manifest.runId)}</h1>
  <p class="muted">Suites: ${manifest.suites.join(", ")} · candidates blind as ${aliases.join(", ")} · ${manifest.spentUsd.toFixed(4)} of ${manifest.capUsd.toFixed(2)} $${manifest.abortedAt ? ` · aborted: ${escapeHtml(manifest.abortedAt)}` : ""}</p>
  <p class="muted">${sourceLines}</p>
  <p class="muted">For each case, pick the answer you would have written yourself. Which model is behind A, B, C is in <code>key.json</code>. Only look there once you are done.</p>
</div>
${cards}
<section>
  <h2>Your choice</h2>
  <p class="muted">Put this block next to the report as <code>choices.json</code>, then <code>pnpm eval:rank --run ${escapeHtml(manifest.runId)}</code>.</p>
  <textarea id="out" readonly></textarea>
  <p><button id="copy">copy</button></p>
</section>
<script>
  const runId = ${JSON.stringify(manifest.runId)};
  const store = "serain-eval-" + runId;
  const out = document.getElementById("out");
  const saved = JSON.parse(localStorage.getItem(store) || "{}");

  function render() {
    out.value = JSON.stringify({ runId, choices: saved }, null, 2);
  }
  for (const input of document.querySelectorAll("input[type=radio]")) {
    if (saved[input.name] === (input.value || null)) input.checked = true;
    input.addEventListener("change", () => {
      saved[input.name] = input.value || null;
      localStorage.setItem(store, JSON.stringify(saved));
      render();
    });
  }
  document.getElementById("copy").addEventListener("click", async () => {
    await navigator.clipboard.writeText(out.value);
  });
  render();
</script>
</body>
</html>
`;
}
