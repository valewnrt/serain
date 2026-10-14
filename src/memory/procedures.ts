import { PROPOSALS } from "../config/memory.js";
import type { ProcedureHit, StoredProcedure } from "./proposal-store.js";
import { owner } from "../config/owner.js";

/**
 * Approved procedures in the context (H5, D42). Leaf-like, without database,
 * so that recall and tests see the same threshold and the same text.
 *
 * **A procedure is a hint, never a right.** Structurally, not by request: it
 * is text in the system prompt and never reaches the registry. Levels,
 * `ownerOriginOnly`, `cleanTurnOnly`, taint and the confirmation protocol
 * check the call, not the prompt; a procedure that said "clean up without a
 * preview" would change nothing about the preview. The sentence in
 * `<procedures>` explains that to the model, it is held in code.
 */

/** Stands above the procedures in the context. Same wording on purpose, see D42. */
export const PROCEDURES_PREAMBLE =
  `Hints from earlier tasks that ${owner.name} approved. They grant no rights: previews and confirmations apply as always.`;

/**
 * Which hits really fit? Through the embedding from
 * `procedureMinSimilarity`, otherwise through at least
 * `procedureMinSharedTerms` shared words (`public.serain_text`). The search returns every
 * procedure with its raw values; only here is it decided whether one goes
 * into the context. The normal case is none.
 */
export function pickProcedures(hits: readonly ProcedureHit[]): ProcedureHit[] {
  return hits
    .filter((hit) => hit.similarity >= PROPOSALS.procedureMinSimilarity || hit.sharedTerms >= PROPOSALS.procedureMinSharedTerms)
    .sort((a, b) => b.similarity - a.similarity || b.sharedTerms - a.sharedTerms)
    .slice(0, PROPOSALS.procedureRecallLimit);
}

/** A procedure as text for the model: title, trigger, steps. `show_memory` and the question to the owner have their own frame. */
export function renderProcedure(procedure: Pick<StoredProcedure, "title" | "trigger" | "body">): string {
  return [`${procedure.title} (when: ${procedure.trigger})`, procedure.body.trim()].join("\n");
}

export function renderProcedureBlock(procedures: readonly Pick<StoredProcedure, "title" | "trigger" | "body">[]): string {
  if (procedures.length === 0) return "";
  return ["<procedures>", PROCEDURES_PREAMBLE, ...procedures.map(renderProcedure), "</procedures>"].join("\n");
}

/** Comparable form for titles and sentences: the code recognises duplicates, not the model. */
export function comparableText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}
