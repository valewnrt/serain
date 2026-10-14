import type {
  JudgeAnswer as ProdJudgeAnswer,
  JudgeQuestion as ProdJudgeQuestion,
} from "../src/agent/judge/types.js";
import { GATE_QUESTION, renderGateState } from "../src/memory/gate.js";
import type { JudgeAnswer, JudgeCase, JudgeQuestion, JudgeRawAnswer } from "./types.js";

/**
 * Translation between the eval cases and the `judge` role (D12). Two
 * formats, deliberately kept apart:
 *
 * - **In the eval** a question reads the way a human asks it: boolean, choice
 *   with readable options, score with a scale. Plus the expected answer and a
 *   tolerance. The cases should stay readable even when production changes its
 *   interface.
 * - **In production** an answer is a probability distribution.
 *
 * This file is the only place that knows both formats, and it imports only
 * types from production. That makes it testable without network, without keys and
 * without a database.
 */

/** "More likely yes than no". Where the real threshold lies is decided by the
 *  memory path itself; the eval measures the verdict, not the threshold. */
export const BOOLEAN_THRESHOLD = 0.5;

/** Default scale when a case brings no labels. */
export function defaultScale(min: number, max: number): string[] {
  return Array.from({ length: max - min + 1 }, (_unused, index) => String(min + index));
}

/** What stands above a gate case in the report. The full question would be a paragraph there. */
export const GATE_LABEL = "Memory gate: worth remembering? (question from src/memory/write.ts)";

export function questionLabel(question: JudgeQuestion): string {
  if (question.kind === "boolean") return question.prompt ?? GATE_LABEL;
  return question.prompt;
}

export function toProductionQuestion(caseId: string, question: JudgeQuestion): ProdJudgeQuestion {
  switch (question.kind) {
    case "boolean": {
      if (question.gate === true) return { ...GATE_QUESTION, key: caseId };
      if (!question.prompt) throw new Error(`Case "${caseId}": boolean without prompt and without gate`);
      return { key: caseId, type: "boolean", instructions: question.prompt };
    }
    case "choice":
      return {
        key: caseId,
        type: "choice",
        instructions: question.prompt,
        options: question.options.map((option) => ({ key: option.id, criterion: option.text })),
      };
    case "score":
      return {
        key: caseId,
        type: "score",
        instructions: question.prompt,
        scale: question.scale ?? defaultScale(question.min, question.max),
      };
  }
}

/**
 * Answer back into the eval form. For `score` production delivers a
 * 0-based expected value on the scale; the cases are phrased in their own
 * scale (e.g. 1 to 5), so it is converted back.
 */
export function fromProductionAnswer(
  question: JudgeQuestion,
  answer: ProdJudgeAnswer,
): JudgeAnswer {
  if (question.kind === "boolean" && answer.type === "boolean") {
    return { kind: "boolean", value: answer.probability >= BOOLEAN_THRESHOLD };
  }
  if (question.kind === "choice" && answer.type === "choice") {
    return { kind: "choice", value: answer.choice };
  }
  if (question.kind === "score" && answer.type === "score") {
    return { kind: "score", value: Math.round(answer.score) + question.min };
  }
  throw new Error(`judge answered with "${answer.type}", the question was "${question.kind}"`);
}

/**
 * The distribution, unchanged, plus the backend that delivered it. That way
 * a threshold can be moved after the fact without repeating the run,
 * and only that way is the question "0.4 or 0.6?" measurable at all.
 */
export function toRawAnswer(answer: ProdJudgeAnswer): JudgeRawAnswer {
  if (answer.type === "boolean") {
    return { backend: answer.source, probability: answer.probability };
  }
  if (answer.type === "choice") {
    return {
      backend: answer.source,
      choice: answer.choice,
      probabilities: answer.probabilities,
      confidence: answer.confidence,
    };
  }
  return {
    backend: answer.source,
    score: answer.score,
    probabilities: answer.probabilities,
    confidence: answer.confidence,
  };
}

/**
 * The case being judged. Contains only what the verdict needs:
 * the state goes to an external provider.
 *
 * Framed as in production (`renderGateState`), not in a prose form of its own:
 * the gate question points explicitly at `<message>` and `<history>`,
 * and a suite that sets other markers measures a different question.
 */
export function judgeState(testCase: JudgeCase): string {
  const state = renderGateState(testCase.message, testCase.history ?? []);
  return testCase.context ? `${state}\n\n${testCase.context}` : state;
}
