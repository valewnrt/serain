import { RoutedJudge, type Judge } from "../src/agent/judge/index.js";
import { fromProductionAnswer, judgeState, toProductionQuestion, toRawAnswer } from "./judge-map.js";
import type { JudgeAnswer, JudgeBackendName, JudgeCase, JudgeRawAnswer } from "./types.js";

/**
 * Connects the judge suite to the `judge` role from `src/agent/judge/` (D12).
 * The format translation lives in `eval/judge-map.ts` and is tested
 * there; only the wiring hangs here.
 */

export interface JudgeRun {
  answer: JudgeAnswer;
  /** The distribution before the threshold. Without it, comparing thresholds is a new run. */
  raw: JudgeRawAnswer;
  costUsd: number;
}

/** Run one case against a backend order. */
export async function askJudgeCase(judge: Judge, testCase: JudgeCase): Promise<JudgeRun> {
  const question = toProductionQuestion(testCase.id, testCase.question);
  const result = await judge.ask({ state: judgeState(testCase), questions: [question] });
  const raw = result.answers[testCase.id];
  if (!raw) throw new Error(`judge did not answer "${testCase.id}"`);
  return {
    answer: fromProductionAnswer(testCase.question, raw),
    raw: toRawAnswer(raw),
    costUsd: result.costUsd,
  };
}

/**
 * A candidate of the judge suite is not a model ID but a
 * backend order: `jev` first or `generative` first. That is exactly the
 * open question from D12, and that is exactly what the eval should answer.
 */
export function judgeFor(backends: readonly JudgeBackendName[]): Judge {
  return new RoutedJudge(backends);
}
