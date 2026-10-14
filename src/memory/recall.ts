import { askJudge } from "../agent/judge/index.js";
import { pickPlaybooks, renderPlaybookBlock, type Playbook } from "../agent/playbooks.js";
import { MEMORY, PROPOSALS } from "../config/memory.js";
import { audit } from "../db/audit.js";
import { log } from "../log.js";
import { kindsFallingInto } from "./areas.js";
import type { MemoryDeps } from "./deps.js";
import { validityLabel } from "./kinds.js";
import { pickProcedures, renderProcedureBlock } from "./procedures.js";
import type { ProcedureHit } from "./proposal-store.js";
import type { ContextFact, FactCandidate, OpenQuestion, SummaryRow } from "./store.js";
import { owner } from "../config/owner.js";

/**
 * Context building per turn (D4, D6): user model, what holds right now, the
 * fitting facts (plus what a shown playbook needs), the rolling summaries and
 * at most one open follow-up question. The history (last N messages) still
 * comes from `src/runtime.ts`: it is chat, not memory.
 *
 * There is deliberately no growing session. Every turn builds its context
 * anew from the database; that is the answer to iMessage knowing no "new
 * chat".
 *
 * If the memory fails, the turn runs anyway. Serain is dumber then, but not
 * mute.
 *
 * Everything here goes to the model, so the frame is English; facts,
 * summaries and the user model appear in the language they were stored in.
 */

export interface MemoryContext {
  userModel: string;
  facts: FactCandidate[];
  summaries: SummaryRow[];
  question: OpenQuestion | null;
  /** Clock of the recall: it decides whether a fact gets "from" or "until" (D39). */
  now: Date;
  /** Approved procedures that fit the task (H5, D42). Mostly empty. */
  procedures: ProcedureHit[];
  /** Built-in playbooks that fit the message (`src/agent/playbooks.ts`). Mostly empty. */
  playbooks: Playbook[];
  /**
   * What holds right now (memory package of 2026-10-10): situations that hold
   * today or shortly, whatever the message sounds like. Stands as `<current>`
   * before the facts and not again among them.
   */
  situations: ContextFact[];
  /** What the shown playbooks need from their areas, without what was already found. */
  playbookFacts: ContextFact[];
}

export const EMPTY_CONTEXT: MemoryContext = {
  userModel: "",
  facts: [],
  summaries: [],
  question: null,
  now: new Date(0),
  procedures: [],
  playbooks: [],
  situations: [],
  playbookFacts: [],
};

export async function buildMemoryContext(
  deps: MemoryDeps,
  input: { incoming: string; subject?: string },
): Promise<MemoryContext> {
  const subject = input.subject ?? "owner";
  const now = deps.now();

  // Without an embedding the full-text search remains. That is worse, but it
  // is not an outage.
  let embedding: number[] | null = null;
  try {
    const [vector] = await deps.embed([input.incoming]);
    embedding = vector ?? null;
  } catch (error) {
    log.warn("Recall without embedding:", (error as Error).message);
  }

  const playbooks = pickPlaybooks(input.incoming);
  const [userModel, facts, summaries, question, procedures, situations, fromAreas] = await Promise.all([
    deps.store.userModel(),
    deps.store.searchFacts({
      subject,
      embedding,
      query: input.incoming,
      limit: MEMORY.recallLimit,
      now: now.toISOString(),
    }),
    recallSummaries(deps, embedding),
    deps.store.nextOpenQuestion(),
    recallProcedures(deps, embedding, input.incoming),
    recallSituations(deps, subject, now),
    recallPlaybookFacts(deps, subject, playbooks, embedding, now),
  ]);

  const relevant = MEMORY.relevanceGate
    ? await filterByRelevance(deps, input.incoming, facts)
    : facts;

  // Every fact once: what holds right now stands in `<current>`, what the
  // search found not again under the playbook.
  const seen = new Set(situations.map((fact) => fact.id));
  const recalled = relevant.filter((fact) => !seen.has(fact.id));
  for (const fact of recalled) seen.add(fact.id);
  const playbookFacts = fromAreas.filter((fact) => !seen.has(fact.id)).slice(0, MEMORY.playbookFactLimit);

  return { userModel, facts: recalled, summaries, question, now, procedures, playbooks, situations, playbookFacts };
}

/**
 * What holds right now, independent of the message (memory package of
 * 2026-10-10). If the query fails, the turn runs without it: then recall by
 * similarity remains, as before.
 */
async function recallSituations(deps: MemoryDeps, subject: string, now: Date): Promise<ContextFact[]> {
  try {
    return await deps.store.activeSituations({
      subject,
      now: now.toISOString(),
      startsBefore: new Date(now.getTime() + MEMORY.situationLeadDays * 86_400_000).toISOString(),
      freshSince: new Date(now.getTime() - MEMORY.situationFreshDays * 86_400_000).toISOString(),
      limit: MEMORY.situationLimit,
    });
  } catch (error) {
    log.warn("Recall without current situations:", (error as Error).message);
    return [];
  }
}

/**
 * Facts from the areas of the shown playbooks (`Playbook.areas`). More come
 * back than needed, because the caller only removes duplicates with recall
 * and `<current>` afterwards; both run in parallel so the turn does not wait
 * for a second round (D50).
 */
async function recallPlaybookFacts(
  deps: MemoryDeps,
  subject: string,
  playbooks: readonly Playbook[],
  embedding: number[] | null,
  now: Date,
): Promise<ContextFact[]> {
  const areas = [...new Set(playbooks.flatMap((playbook) => playbook.areas ?? []))];
  if (areas.length === 0) return [];
  try {
    return await deps.store.areaFacts({
      subject,
      areas,
      kinds: kindsFallingInto(areas),
      embedding,
      terms: playbooks.map((playbook) => playbook.recallTerms ?? "").join(" ").trim(),
      now: now.toISOString(),
      limit: MEMORY.playbookFactLimit + MEMORY.recallLimit + MEMORY.situationLimit,
    });
  } catch (error) {
    log.warn("Recall without facts for the playbook:", (error as Error).message);
    return [];
  }
}

/**
 * Procedures the owner approved (H5, D42), only when they fit. If the search
 * fails, the turn runs without: a procedure is a hint, not part of the answer.
 */
async function recallProcedures(deps: MemoryDeps, embedding: number[] | null, incoming: string): Promise<ProcedureHit[]> {
  try {
    const hits = await deps.store.searchProcedures({ embedding, query: incoming, limit: PROPOSALS.maxActiveProcedures });
    return pickProcedures(hits);
  } catch (error) {
    log.warn("Recall without procedures:", (error as Error).message);
    return [];
  }
}

/**
 * Summaries for the context (V3, D41): the most recent by time, plus older
 * ones that fit the message. Without a vector the most recent remain. If the
 * similarity search fails, that is no outage of the recall.
 */
async function recallSummaries(deps: MemoryDeps, embedding: number[] | null): Promise<SummaryRow[]> {
  const recent = await deps.store.recentSummaries(MEMORY.summaryRecentLimit);
  if (!embedding) return recent;
  const oldestRecent = recent[0]?.windowStart ?? null;
  let similar: SummaryRow[] = [];
  try {
    similar = (await deps.store.similarSummaries(embedding, MEMORY.summarySimilarLimit, oldestRecent)).filter(
      (summary) => (summary.similarity ?? 1) >= MEMORY.summarySimilarMin,
    );
  } catch (error) {
    log.warn("Similar summaries not readable:", (error as Error).message);
  }
  const seen = new Set(recent.map((summary) => summary.id));
  return [...similar.filter((summary) => !seen.has(summary.id)), ...recent].sort((a, b) => a.windowEnd.localeCompare(b.windowEnd));
}

/**
 * Optional relevance gate (off by config). One judge question per candidate:
 * with a dozen candidates that costs more than the turn itself, so it is off
 * by default and only becomes interesting once the memory is so large that
 * ballast costs more than the check.
 */
async function filterByRelevance(
  deps: MemoryDeps,
  incoming: string,
  facts: readonly FactCandidate[],
): Promise<FactCandidate[]> {
  const kept: FactCandidate[] = [];
  for (const fact of facts) {
    try {
      const answer = await askJudge(
        deps.judge,
        `<message>\n${incoming}\n</message>\n\n<fact>\n${fact.content}\n</fact>`,
        {
          key: "relevant",
          type: "boolean",
          instructions: "Does this fact help to answer exactly this message well?",
        },
      );
      if (answer.probability >= MEMORY.relevanceThreshold) kept.push(fact);
    } catch (error) {
      // When in doubt keep it: a superfluous fact costs tokens, a missing one
      // costs the answer.
      log.warn("Relevance gate skipped:", (error as Error).message);
      kept.push(fact);
    }
  }
  return kept;
}

/** Stands above `<current>`. For the model, never for the owner. */
export const CURRENT_PREAMBLE = `Holds for ${owner.name} right now, even if the message does not mention it: the default for place and situation.`;

/**
 * Builds the memory block for the prompt. Capped at `maxContextChars`; cut
 * from the back, so at the worst-fitting facts (D3: a small context is budget
 * policy).
 */
export function renderMemory(context: MemoryContext): string {
  const blocks: string[] = [];

  // Fitting procedures first (D42): there are at most two, and if one fits,
  // it matters more for this task than the twelfth fact where the cap cuts.
  // Hints, not rights, see `procedures.ts`.
  const procedures = renderProcedureBlock(context.procedures);
  if (procedures) blocks.push(procedures);
  const playbooks = renderPlaybookBlock(context.playbooks);
  if (playbooks) blocks.push(playbooks);

  // Kind and validity stand at every fact (D39): "situation, until 2026-08-31"
  // tells the model that something is time-limited, "from 2026-11-01" that it
  // does not hold yet.
  const line = (fact: ContextFact) =>
    `[${[fact.category, fact.kind, validityLabel(fact, context.now)].filter(Boolean).join(", ")}] ${fact.content}`;

  // What holds right now, before all other facts: it is the silent default
  // for place and situation, and the cap cuts from the back.
  if (context.situations.length > 0) {
    blocks.push(["<current>", CURRENT_PREAMBLE, ...context.situations.map(line), "</current>"].join("\n"));
  }

  const facts: ContextFact[] = [...context.facts, ...context.playbookFacts];
  if (facts.length > 0) {
    // Grouped by category, rank order within each group; what a playbook
    // fetched in addition stands behind the search hits.
    const byCategory = new Map<string, string[]>();
    for (const fact of facts) {
      const list = byCategory.get(fact.category) ?? [];
      list.push(line(fact));
      byCategory.set(fact.category, list);
    }
    const lines = [...byCategory.values()].flat();
    blocks.push(["<facts>", ...lines, "</facts>"].join("\n"));
  }

  if (context.summaries.length > 0) {
    const lines = context.summaries.map(
      (summary) => `${summary.windowStart.slice(0, 10)} to ${summary.windowEnd.slice(0, 10)}: ${summary.content}`,
    );
    blocks.push(["<earlier>", ...lines, "</earlier>"].join("\n"));
  }

  if (context.question) {
    blocks.push(
      [
        "<open_question>",
        context.question.question,
        "Ask it briefly if it fits into the chat right now. Otherwise leave it out.",
        "</open_question>",
      ].join("\n"),
    );
  }

  const rendered = blocks.join("\n\n");
  return rendered.length > MEMORY.maxContextChars
    ? `${rendered.slice(0, MEMORY.maxContextChars).trimEnd()}\n…`
    : rendered;
}

/**
 * A follow-up question is marked as asked as soon as it was in the context.
 * Not only once Serain really asked it: that would take another model verdict,
 * and a question that comes up again in every turn would be worse than one
 * that gets lost once.
 */
export async function markQuestionShown(
  deps: MemoryDeps,
  question: OpenQuestion | null,
): Promise<void> {
  if (!question) return;
  try {
    await deps.store.markQuestionAsked(question.id, deps.now().toISOString());
    await audit("memory_question", { question_id: question.id, status: "asked" });
  } catch (error) {
    log.warn("Follow-up question not marked as asked:", (error as Error).message);
  }
}
