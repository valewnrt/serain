import { askJudge } from "../agent/judge/index.js";
import { IMPORTANCE_SCALE, MEMORY } from "../config/memory.js";
import { audit } from "../db/audit.js";
import { log } from "../log.js";
import type { MemoryContextTurn } from "./context.js";
import { GATE_QUESTION, NO_RIVAL_KEY, renderGateState, renderState } from "./gate.js";
import type { ExtractedFact, MemoryDeps } from "./deps.js";
import type { FactCandidate, StoredFact } from "./store.js";
import { owner } from "../config/owner.js";

/**
 * The write path (D6, D12). Runs after every turn, asynchronously: it must not
 * delay the answer to the owner and has to carry its own errors.
 *
 * Three stages, in descending order of cost:
 *
 * 1. **Gate.** One judge question: is there anything worth remembering
 *    permanently in here at all? Below the threshold nothing else happens.
 *    That is the normal case and saves the expensive part.
 * 2. **Extraction.** A small generative model writes down the facts.
 * 3. **Placement.** For every new fact, similar existing facts are fetched
 *    (pgvector plus full text) and the judge is asked which of them the new
 *    one replaces.
 *
 * The threshold logic is the real point. High means replace. Low means: new
 * fact, both hold. In between nothing is overwritten **silently**; both are
 * kept and the contradiction is noted as a follow-up question, which Serain
 * only asks when a wrong assumption would be expensive (W20). The mistake Bo
 * makes according to two App Store reviews is exactly this: silently
 * swallowing a correction and later playing out the old version.
 *
 * **Only the owner's turns create facts (D8.4).** Untrusted content (mails,
 * web pages, tool results) must never write into the memory, otherwise a
 * crafted page writes itself into Serain's view of the world. That is why this
 * function explicitly only takes an inbound message of the owner.
 */

export interface RememberInput {
  /** DB id of the triggering message. Stored at the fact as provenance. */
  messageId: string;
  /** The owner's wording. */
  text: string;
  /**
   * The turns before it (owner and Serain), oldest first. Only for
   * understanding: only what is in `text` is stored (D8.4). Without this
   * history a correction or partial retraction cannot be resolved.
   */
  context?: readonly MemoryContextTurn[];
  subject?: string;
}

export interface RememberOutcome {
  /** Did the gate lead to an extraction at all? */
  extracted: boolean;
  stored: StoredFact[];
  superseded: string[];
  conflicts: string[];
}

const EMPTY: RememberOutcome = { extracted: false, stored: [], superseded: [], conflicts: [] };

/** The fact candidate with the highest probability, the "none" option excluded. */
function bestRival(
  probabilities: Record<string, number>,
  candidates: readonly FactCandidate[],
): { candidate: FactCandidate; probability: number } | null {
  let best: { candidate: FactCandidate; probability: number } | null = null;
  for (const candidate of candidates) {
    const probability = probabilities[candidate.id] ?? 0;
    if (!best || probability > best.probability) best = { candidate, probability };
  }
  return best;
}

export async function rememberOwnerTurn(
  deps: MemoryDeps,
  input: RememberInput,
): Promise<RememberOutcome> {
  const subject = input.subject ?? "owner";
  const text = input.text.trim();
  if (!text) return EMPTY;
  const context = input.context ?? [];

  // The history is part of the case, but the question points explicitly at
  // the last message: the verdict is about what the owner just wrote, it is
  // understood in context.
  const gate = await askJudge(deps.judge, renderGateState(text, context), GATE_QUESTION);

  if (gate.probability < MEMORY.gateThreshold) {
    await audit(
      "memory_gate",
      { kept: false, probability: gate.probability, source: gate.source },
      input.messageId,
    );
    return EMPTY;
  }
  await audit(
    "memory_gate",
    { kept: true, probability: gate.probability, source: gate.source },
    input.messageId,
  );

  const existing = await deps.store.activeFacts(subject);
  const knownCategories = [...new Set(existing.map((fact) => fact.category))].sort();
  const extracted = await deps.extractFacts({ text, context, knownCategories, now: deps.now() });
  if (extracted.length === 0) {
    await audit("memory_fact", { count: 0 }, input.messageId);
    return { ...EMPTY, extracted: true };
  }

  const outcome: RememberOutcome = {
    extracted: true,
    stored: [],
    superseded: [],
    conflicts: [],
  };

  for (const fact of extracted) {
    const stored = await storeOneFact(deps, {
      fact,
      text,
      context,
      subject,
      messageId: input.messageId,
      outcome,
    });
    if (stored) outcome.stored.push(stored);
  }
  return outcome;
}

async function storeOneFact(
  deps: MemoryDeps,
  input: {
    fact: ExtractedFact;
    text: string;
    context: readonly MemoryContextTurn[];
    subject: string;
    messageId: string;
    outcome: RememberOutcome;
  },
): Promise<StoredFact | null> {
  const { fact, subject, messageId, outcome } = input;
  const at = deps.now().toISOString();

  // Without an embedding it goes on, only worse: the fact is stored and can
  // be found through the full text. Running out of budget must not mean
  // losing memory.
  let embedding: number[] | null = null;
  try {
    const [vector] = await deps.embed([fact.content]);
    embedding = vector ?? null;
  } catch (error) {
    await audit(
      "memory_error",
      { stage: "embed", reason: (error as Error).message },
      messageId,
    );
    log.warn("Fact stored without embedding:", (error as Error).message);
  }

  const candidates = (
    await deps.store.searchFacts({
      subject,
      embedding,
      query: fact.content,
      limit: MEMORY.candidateLimit,
      now: at,
    })
  ).filter(
    // A full-text hit is a candidate even when the vector is weak: "Finkel" against "Lorenz &
    // Partner" is at 0.5 in the vector, the employer is still the same thing (memory eval, D45).
    (candidate) => candidate.similarity >= MEMORY.candidateMinSimilarity || candidate.textHit || embedding === null,
  );

  const newFact = await deps.store.insertFact({
    subject,
    category: fact.category,
    content: fact.content,
    confidence: fact.confidence,
    kind: fact.kind,
    area: fact.area ?? null,
    validFrom: fact.validFrom,
    validUntil: fact.validUntil,
    sourceMessageId: messageId || null,
    embedding,
    createdAt: at,
  });

  if (candidates.length === 0) {
    await audit(
      "memory_fact",
      { fact_id: newFact.id, category: fact.category, kind: fact.kind, decision: "new", candidates: 0 },
      messageId,
    );
    return newFact;
  }

  const answer = await askJudge(deps.judge, renderState(input.text, candidates, fact, input.context), {
    key: "supersedes",
    type: "choice",
    instructions:
      "Which of the existing facts does the new fact replace, because it settles the same thing " +
      `about ${owner.name} anew? Only replace if both cannot be true side by side.`,
    options: [
      ...candidates.map((candidate) => ({
        key: candidate.id,
        criterion: `[${candidate.category}] ${candidate.content}`,
      })),
      { key: NO_RIVAL_KEY, criterion: "The new fact replaces none of them, it is added." },
    ],
  });

  const rival = bestRival(answer.probabilities, candidates);
  const probability = rival?.probability ?? 0;

  if (rival && probability >= MEMORY.supersedeHigh) {
    const timing = supersedeTiming(newFact, at);
    if (timing.kind !== "now") {
      // Replacing does not mean "gone right away" here (D39). Something
      // time-limited only lies over the old fact: "in Lisbon until Friday" does
      // not replace "lives in Musterstadt", otherwise Serain would no longer
      // know from Saturday on where the owner lives. Something in the future
      // ends the old fact only on its first day: "vegan from November" keeps
      // "eats meat" until the end of October.
      if (timing.kind === "scheduled") await deps.store.expireFactAt(rival.candidate.id, timing.until, at);
      await audit(
        "memory_fact",
        {
          fact_id: newFact.id,
          category: fact.category,
          kind: fact.kind,
          decision: timing.kind === "scheduled" ? "superseded_later" : "overlay",
          replaced: rival.candidate.id,
          probability,
          source: answer.source,
        },
        messageId,
      );
      return newFact;
    }
    await deps.store.supersedeFact(rival.candidate.id, newFact.id, at);
    outcome.superseded.push(rival.candidate.id);
    await audit(
      "memory_fact",
      {
        fact_id: newFact.id,
        category: fact.category,
        kind: fact.kind,
        decision: "superseded",
        replaced: rival.candidate.id,
        probability,
        source: answer.source,
      },
      messageId,
    );
    return newFact;
  }

  if (rival && probability >= MEMORY.supersedeLow) {
    // Middle range: both stay. Silently overwriting would be the mistake
    // nobody sees later.
    await flagConflict(deps, {
      messageId,
      newFact,
      rival: rival.candidate,
      probability,
      outcome,
      state: renderState(input.text, [rival.candidate], fact, input.context),
      source: answer.source,
    });
    return newFact;
  }

  await audit(
    "memory_fact",
    {
      fact_id: newFact.id,
      category: fact.category,
      kind: fact.kind,
      decision: "new",
      candidates: candidates.length,
      probability,
      source: answer.source,
    },
    messageId,
  );
  return newFact;
}

async function flagConflict(
  deps: MemoryDeps,
  input: {
    messageId: string;
    newFact: StoredFact;
    rival: FactCandidate;
    probability: number;
    outcome: RememberOutcome;
    state: string;
    source: string;
  },
): Promise<void> {
  const importance = await askJudge(deps.judge, input.state, {
    key: "importance",
    type: "score",
    instructions:
      "How expensive would it be if Serain took the wrong one of the two versions to be true " +
      "and acted on it?",
    scale: IMPORTANCE_SCALE,
  });

  await audit(
    "memory_conflict",
    {
      fact_id: input.newFact.id,
      rival_fact_id: input.rival.id,
      probability: input.probability,
      importance: importance.score,
      source: input.source,
    },
    input.messageId,
  );

  if (importance.score < MEMORY.conflictImportanceMin) {
    // W20: do not ask just because it would be interesting. Both facts stay,
    // the contradiction is in the audit log.
    return;
  }

  const question = await deps.store.addOpenQuestion({
    // For the model (`<open_question>`), which asks it in the owner's language.
    question: `Does "${input.rival.content}" still hold, or now "${input.newFact.content}"?`,
    factId: input.newFact.id,
    rivalFactId: input.rival.id,
    importance: importance.score,
    createdAt: deps.now().toISOString(),
  });
  if (question) {
    input.outcome.conflicts.push(question.id);
    await audit(
      "memory_question",
      { question_id: question.id, importance: importance.score, status: "open" },
      input.messageId,
    );
  }
}

/**
 * When a fact that replaces an old one takes effect (D39). Something
 * time-limited (`validUntil`) only overlays, something in the future
 * (`validFrom` after now) ends the old fact on its first day, everything else
 * replaces at once.
 */
export function supersedeTiming(
  fact: Pick<StoredFact, "validFrom" | "validUntil">,
  at: string,
): { kind: "now" } | { kind: "overlay" } | { kind: "scheduled"; until: string } {
  if (fact.validUntil) return { kind: "overlay" };
  if (fact.validFrom && fact.validFrom > at) return { kind: "scheduled", until: fact.validFrom };
  return { kind: "now" };
}
