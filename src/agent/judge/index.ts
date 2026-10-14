import { JUDGE_BACKEND_ORDER, type JudgeBackendName } from "../../config/models.js";
import { audit } from "../../db/audit.js";
import { log } from "../../log.js";
import { GenerativeBackend } from "./generative.js";
import { JevBackend } from "./jev.js";
import type { Judge, JudgeBackend, JudgeRequest, JudgeResult } from "./types.js";

export * from "./types.js";

/**
 * The `judge` role, assembled (D12).
 *
 * Two backends behind one interface: `jev` (a specialised decider at
 * OpenRouter's alpha endpoint) and `generative` (a small model over the
 * existing model layer). Which one is primary is set in
 * `src/config/models.ts`, not here.
 *
 * Three rules that live here and not in the backends:
 *
 * 1. **One question per request.** The interface carries several, the client
 *    sends them one by one. Combined calls were measurably worse in the pre-test.
 * 2. **Fallback with a trace.** If the primary backend fails (HTTP, schema,
 *    timeout), the next one takes over, and the reason stands in the audit log.
 *    An alpha endpoint may fail, but not unnoticed.
 * 3. **Never safety-relevant.** `judge` decides about memory, never about the
 *    duty to confirm, tool levels or the allowlist (D8). That limit is
 *    deterministic and lives in the registry.
 */

function createBackend(name: JudgeBackendName): JudgeBackend {
  return name === "jev" ? new JevBackend() : new GenerativeBackend();
}

export class RoutedJudge implements Judge {
  private readonly backends: JudgeBackend[];

  constructor(order: readonly JudgeBackendName[] = JUDGE_BACKEND_ORDER) {
    if (order.length === 0) throw new Error("judge needs at least one backend");
    this.backends = order.map(createBackend);
  }

  async ask(request: JudgeRequest): Promise<JudgeResult> {
    const answers: JudgeResult["answers"] = {};
    let costUsd = 0;

    for (const question of request.questions) {
      let lastError: Error | null = null;
      let answered = false;

      for (const [index, backend] of this.backends.entries()) {
        try {
          const result = await backend.askOne(request.state, question);
          answers[question.key] = result.answer;
          costUsd += result.costUsd;
          answered = true;
          break;
        } catch (error) {
          lastError = error as Error;
          const next = this.backends[index + 1];
          await audit("judge_fallback", {
            from: backend.name,
            to: next?.name ?? null,
            question: question.key,
            type: question.type,
            reason: lastError.message,
          });
          log.warn(`judge backend ${backend.name} failed:`, lastError.message);
        }
      }

      if (!answered) {
        // No backend could answer. Better no judgement than a guessed one:
        // the memory path catches this and simply doesn't learn from this turn.
        throw new Error(
          `judge could not answer "${question.key}": ${lastError?.message ?? "unknown"}`,
        );
      }
    }

    return { answers, costUsd };
  }
}

let shared: Judge | null = null;

/** Shared instance for production. Tests build their own. */
export function judge(): Judge {
  shared ??= new RoutedJudge();
  return shared;
}
