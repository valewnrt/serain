import { z } from "zod";
import { JEV_DIRECT } from "../config/models.js";
import { recordModelUsage } from "../db/usage.js";

/**
 * Jev directly at Typesafe (D35): one state, typed questions, distributions
 * back. Raw `fetch` with Zod validation as on the OpenRouter path (D12): a
 * third party's answer fills nothing that does not fit the contract.
 *
 * **Public content only.** Typesafe does not commit to zero data retention
 * (D3); what goes here is the text of public web pages and a task that has
 * already passed the filter for confidential values (D29). The owner's
 * messages, memory and mails never pass through here; they stay with the
 * `judge` via OpenRouter.
 */

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const TIMEOUT_MS = 15_000;

/** Instructions and criteria may be text, objects or lists (Typesafe API): Jev reads structure more precisely than a long sentence. */
export type SystemOneQuestion =
  | { type: "noul"; instructions: unknown; criteria?: { true: string; false: string } }
  | { type: "choice"; instructions: unknown; criteria: Record<string, unknown> };

const answerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("noul"), noul: z.number().min(0).max(1) }),
  z.object({
    type: z.literal("choice"),
    choice: z.string().min(1),
    probabilities: z.record(z.string(), z.number()),
    confidence: z.number().min(0).max(1),
  }),
]);

const responseSchema = z.object({
  model: z.string(),
  answers: z.record(z.string(), answerSchema),
  usage: z.object({ input_tokens: z.number().nonnegative().default(0), output_tokens: z.number().nonnegative().default(0) }),
});

export type SystemOneAnswer = z.infer<typeof answerSchema>;

export interface SystemOne {
  ask(state: unknown, questions: Record<string, SystemOneQuestion>): Promise<Record<string, SystemOneAnswer>>;
}

export class TypesafeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TypesafeError";
  }
}

export function typesafeClient(apiKey: string, fetchImpl: typeof fetch = fetch): SystemOne {
  return {
    async ask(state, questions) {
      let response: Response;
      try {
        response = await fetchImpl(ENDPOINT, {
          method: "POST",
          headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
          body: JSON.stringify({ state, model: JEV_DIRECT.model, questions }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (error) {
        throw new TypesafeError(`Typesafe unreachable: ${(error as Error).message}`);
      }
      if (!response.ok) {
        throw new TypesafeError(`Typesafe answered with ${response.status}: ${(await response.text().catch(() => "")).slice(0, 200)}`);
      }
      const parsed = responseSchema.safeParse(await response.json().catch(() => null));
      if (!parsed.success) throw new TypesafeError("Typesafe answered in an unknown format.");
      for (const key of Object.keys(questions)) {
        if (parsed.data.answers[key]?.type !== questions[key]?.type) throw new TypesafeError(`Typesafe did not answer "${key}".`);
      }
      // Against the same monthly cap as everything else (D3).
      await recordModelUsage({
        provider: "typesafe",
        model: parsed.data.model,
        role: "browser",
        inputTokens: parsed.data.usage.input_tokens,
        outputTokens: parsed.data.usage.output_tokens,
        costUsd: (parsed.data.usage.input_tokens / 1_000_000) * JEV_DIRECT.pricePerMillionInputTokensUsd,
      });
      return parsed.data.answers;
    },
  };
}
