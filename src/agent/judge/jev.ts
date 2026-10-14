import { z } from "zod";
import { env } from "../../config/env.js";
import { JEV_MODEL, OPENROUTER_PROVIDER_POLICY } from "../../config/models.js";
import { recordModelUsage } from "../../db/usage.js";
import {
  argmax,
  normalizeDistribution,
  type JudgeBackend,
  type JudgeBackendAnswer,
  type JudgeQuestion,
} from "./types.js";

/**
 * Jev over OpenRouter's decisions endpoint.
 *
 * Raw `fetch` instead of an SDK: the endpoint is alpha (`/api/alpha/decisions`),
 * not in chat completion format, and no SDK knows it. In return every answer is
 * checked against a Zod schema: an alpha endpoint may change its format, but it
 * must not fill Serain's memory with half-guessed values. Schema, HTTP or
 * timeout errors lead one level up (`index.ts`) automatically to the generative
 * backend, with an audit entry.
 *
 * Measured on 2026-09-18 with four synthetic requests (cost together
 * $0.000048), so the shapes below are measured and not guessed:
 * - boolean is called `noul` there, the answer is P(true) as one number;
 * - `choice` requires `criteria` as an object (an array is rejected with 400)
 *   and answers with `choice`, `probabilities` per key and `confidence`;
 * - `score` takes `criteria` as an array, answers with an expected value over
 *   the **0-indexed positions** plus `legend` and `probabilities` per index.
 *   So the numeric value comes from the position, not from the criterion text.
 */

const ENDPOINT = "https://openrouter.ai/api/alpha/decisions";
/** The memory path runs asynchronously, but must not hang forever. */
const TIMEOUT_MS = 20_000;

const usageSchema = z.object({
  input_tokens: z.number().nonnegative().default(0),
  output_tokens: z.number().nonnegative().default(0),
  cost: z.number().nonnegative().default(0),
});

const noulAnswerSchema = z.object({
  type: z.literal("noul"),
  noul: z.number().min(0).max(1),
});

const choiceAnswerSchema = z.object({
  type: z.literal("choice"),
  choice: z.string().min(1),
  probabilities: z.record(z.string(), z.number()),
  confidence: z.number().min(0).max(1),
});

const scoreAnswerSchema = z.object({
  type: z.literal("score"),
  score: z.number(),
  legend: z.record(z.string(), z.string()),
  probabilities: z.record(z.string(), z.number()),
  confidence: z.number().min(0).max(1),
});

const responseSchema = z.object({
  model: z.string().optional(),
  answers: z.record(
    z.string(),
    z.union([noulAnswerSchema, choiceAnswerSchema, scoreAnswerSchema]),
  ),
  usage: usageSchema,
});

export type JevResponse = z.infer<typeof responseSchema>;

/** Body for exactly one question. Public so the test can check the ZDR parameters. */
export function jevRequestBody(state: string, question: JudgeQuestion): Record<string, unknown> {
  const spec: Record<string, unknown> =
    question.type === "boolean"
      ? { type: "noul", instructions: question.instructions }
      : question.type === "choice"
        ? {
            type: "choice",
            instructions: question.instructions,
            criteria: Object.fromEntries(
              question.options.map((option) => [option.key, option.criterion]),
            ),
          }
        : { type: "score", instructions: question.instructions, criteria: [...question.scale] };

  return {
    model: JEV_MODEL,
    state,
    // Never optional: facts about the owner go to an external provider here.
    provider: OPENROUTER_PROVIDER_POLICY,
    questions: { [question.key]: spec },
  };
}

/** Translates the measured answer shape into the SDK-neutral shape from `types.ts`. */
export function toJudgeAnswer(
  question: JudgeQuestion,
  raw: JevResponse["answers"][string],
): JudgeBackendAnswer["answer"] {
  if (question.type === "boolean") {
    if (raw.type !== "noul") throw new Error(`Jev answered with ${raw.type} instead of noul`);
    return { type: "boolean", source: "jev", probability: raw.noul };
  }

  if (question.type === "choice") {
    if (raw.type !== "choice") throw new Error(`Jev answered with ${raw.type} instead of choice`);
    const known = new Set(question.options.map((option) => option.key));
    if (!known.has(raw.choice)) throw new Error(`Jev chose "${raw.choice}", which was not an option`);
    for (const key of Object.keys(raw.probabilities)) {
      if (!known.has(key)) throw new Error(`Jev assigned probability to "${key}", which was not an option`);
    }
    const probabilities = normalizeDistribution(raw.probabilities);
    return {
      type: "choice",
      source: "jev",
      choice: raw.choice,
      probabilities,
      confidence: probabilities[raw.choice] ?? 0,
    };
  }

  if (raw.type !== "score") throw new Error(`Jev answered with ${raw.type} instead of score`);
  // 0-indexed by position in the scale array. Anything else would be guessing.
  for (const key of Object.keys(raw.probabilities)) {
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0 || index >= question.scale.length) {
      throw new Error(`Jev reported level "${key}", the scale has ${question.scale.length} levels`);
    }
  }
  const probabilities = normalizeDistribution(raw.probabilities);
  const index = Number(argmax(probabilities).key);
  const label = question.scale[index];
  if (label === undefined) throw new Error(`Level ${index} does not exist on the scale`);
  return {
    type: "score",
    source: "jev",
    score: raw.score,
    index,
    label,
    probabilities,
    confidence: probabilities[String(index)] ?? 0,
  };
}

export class JevBackend implements JudgeBackend {
  readonly name = "jev" as const;

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async askOne(state: string, question: JudgeQuestion): Promise<JudgeBackendAnswer> {
    if (!env.openrouterApiKey) throw new Error("OPENROUTER_API_KEY missing");

    const response = await this.fetchImpl(ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.openrouterApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(jevRequestBody(state, question)),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!response.ok) {
      // Error text deliberately cut: it can mirror the request, and the request
      // carries facts about the owner.
      const detail = (await response.text().catch(() => "")).slice(0, 200);
      throw new Error(`Jev answered with HTTP ${response.status}: ${detail}`);
    }

    const parsed = responseSchema.safeParse(await response.json());
    if (!parsed.success) {
      throw new Error(`Jev answer does not match the schema: ${parsed.error.issues[0]?.message}`);
    }

    const raw = parsed.data.answers[question.key];
    if (!raw) throw new Error(`Jev did not answer the question "${question.key}"`);

    const answer = toJudgeAnswer(question, raw);
    await recordModelUsage({
      provider: "openrouter",
      model: parsed.data.model ?? JEV_MODEL,
      role: "judge",
      inputTokens: parsed.data.usage.input_tokens,
      outputTokens: parsed.data.usage.output_tokens,
      costUsd: parsed.data.usage.cost,
    });
    return { answer, costUsd: parsed.data.usage.cost };
  }
}
