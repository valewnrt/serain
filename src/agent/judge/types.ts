import type { JudgeBackendName } from "../../config/models.js";

/**
 * The `judge` role: typed decisions instead of free text.
 *
 * In the memory path Serain constantly has to make small judgements ("is this
 * a fact worth remembering?", "does this replace an existing fact?", "how
 * expensive would a wrong assumption be?"). A chat model answers that with
 * prose that has to be parsed again. Here the question is typed and the answer
 * is a distribution, that is a number one can put a threshold against.
 *
 * **Safety boundary (D8, D12):** `judge` NEVER decides about the duty to
 * confirm, tool levels or the allowlist. These limits are deterministic and
 * live in `src/agent/tools/registry.ts` and `src/security/`. A model that
 * answers with probabilities must not decide whether money may be spent: a
 * probability of 0.97 is not good enough there, and 1.0 does not exist.
 *
 * This file is the contract the eval also runs against. It stays small.
 */

export type { JudgeBackendName };

/**
 * The key of the "none of these" option of a choice question. A stable,
 * language-neutral key: callers compare the answer against it, never against
 * a word in some language.
 */
export const JUDGE_NONE_KEY = "none";

export interface JudgeChoiceOption {
  /** Stable key, e.g. a fact ID. Comes back in the answer. */
  key: string;
  /** How to recognise that exactly this option applies. */
  criterion: string;
}

export interface JudgeBooleanQuestion {
  key: string;
  type: "boolean";
  /** Phrased as a yes/no question. The answer is P(yes). */
  instructions: string;
}

export interface JudgeChoiceQuestion {
  key: string;
  type: "choice";
  instructions: string;
  /** At least two options. One of them should be "none of these" (`JUDGE_NONE_KEY`). */
  options: readonly JudgeChoiceOption[];
}

export interface JudgeScoreQuestion {
  key: string;
  type: "score";
  instructions: string;
  /** Ordered scale, ascending. The index is the value (0-based). */
  scale: readonly string[];
}

export type JudgeQuestion = JudgeBooleanQuestion | JudgeChoiceQuestion | JudgeScoreQuestion;

interface JudgeAnswerBase {
  /**
   * Which backend answered. With `generative` the probability is estimated by
   * the language model itself and not calibrated; whoever puts the number
   * against a threshold has to know that.
   */
  source: JudgeBackendName;
}

export interface JudgeBooleanAnswer extends JudgeAnswerBase {
  type: "boolean";
  /** P(yes), between 0 and 1. */
  probability: number;
}

export interface JudgeChoiceAnswer extends JudgeAnswerBase {
  type: "choice";
  /** Key of the most likely option. */
  choice: string;
  /** Distribution over all option keys, summing to 1. */
  probabilities: Record<string, number>;
  /** Probability of the chosen option. */
  confidence: number;
}

export interface JudgeScoreAnswer extends JudgeAnswerBase {
  type: "score";
  /** Expected value on the 0-based scale, e.g. 1.68 with four levels. */
  score: number;
  /** Index of the most likely level. */
  index: number;
  /** Label for `index`, from `scale`. */
  label: string;
  /** Distribution over the level indices as strings ("0", "1", …). */
  probabilities: Record<string, number>;
  confidence: number;
}

export type JudgeAnswer = JudgeBooleanAnswer | JudgeChoiceAnswer | JudgeScoreAnswer;

/** Answer type that belongs to a question. Saves type guards at the call sites. */
export type JudgeAnswerFor<Q extends JudgeQuestion> = Q extends JudgeBooleanQuestion
  ? JudgeBooleanAnswer
  : Q extends JudgeChoiceQuestion
    ? JudgeChoiceAnswer
    : JudgeScoreAnswer;

export interface JudgeRequest {
  /**
   * The case as text. Everything needed for the judgement, and nothing
   * beyond it: the state goes to an external provider.
   */
  state: string;
  /**
   * Several questions are allowed. The client still sends them one by one:
   * combined calls were measurably worse in the pre-test than one question per request.
   */
  questions: readonly JudgeQuestion[];
}

export interface JudgeResult {
  /** Answers by `question.key`. Contains every question asked. */
  answers: Record<string, JudgeAnswer>;
  /** Sum over all partial requests. The subscription path costs $0. */
  costUsd: number;
}

export interface Judge {
  ask(request: JudgeRequest): Promise<JudgeResult>;
}

/**
 * A backend answers exactly one question. Splitting into single requests, the
 * fallback and the bookkeeping live one level up (`index.ts`).
 */
export interface JudgeBackend {
  readonly name: JudgeBackendName;
  askOne(state: string, question: JudgeQuestion): Promise<JudgeBackendAnswer>;
}

export interface JudgeBackendAnswer {
  answer: JudgeAnswer;
  costUsd: number;
}

/** Convenient single call with a suitably typed answer. */
export async function askJudge<Q extends JudgeQuestion>(
  judge: Judge,
  state: string,
  question: Q,
): Promise<JudgeAnswerFor<Q>> {
  const result = await judge.ask({ state, questions: [question] });
  const answer = result.answers[question.key];
  if (!answer) throw new Error(`judge did not answer the question "${question.key}"`);
  return answer as JudgeAnswerFor<Q>;
}

/** Normalises a distribution to sum 1. Throws when nothing meaningful is in it. */
export function normalizeDistribution(raw: Record<string, number>): Record<string, number> {
  const entries = Object.entries(raw).map(([key, value]) => [key, Math.max(0, value)] as const);
  const total = entries.reduce((sum, [, value]) => sum + value, 0);
  if (!Number.isFinite(total) || total <= 0) {
    throw new Error("Distribution without positive mass");
  }
  return Object.fromEntries(entries.map(([key, value]) => [key, value / total]));
}

/** Most likely key of a distribution. On a tie the first. */
export function argmax(distribution: Record<string, number>): { key: string; value: number } {
  let best: { key: string; value: number } | null = null;
  for (const [key, value] of Object.entries(distribution)) {
    if (!best || value > best.value) best = { key, value };
  }
  if (!best) throw new Error("Empty distribution");
  return best;
}
