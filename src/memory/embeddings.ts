import { z } from "zod";
import { budgetStatus } from "../budget.js";
import { env } from "../config/env.js";
import { EMBEDDING, OPENROUTER_PROVIDER_POLICY } from "../config/models.js";
import { recordModelUsage } from "../db/usage.js";
import { log } from "../log.js";
import { keepAliveFetch } from "../net/keepalive.js";

/**
 * Embeddings for pgvector (D13).
 *
 * OpenRouter has an embedding endpoint that does not show up in the model list
 * but works (checked on 2026-09-18). That keeps it at one provider and one key:
 * no new service, no new account. `text-embedding-3-small` delivers exactly the
 * 1536 dimensions the columns in `0001_core.sql` have, and costs $0.02 per
 * million tokens; a fact about $0.0000002.
 *
 * There is no free path via the owner's subscription: embeddings are the only
 * part of the memory that always needs the paid provider. That is why
 * every call goes through the budget guard and is booked in `usage_log`.
 */

const ENDPOINT = "https://openrouter.ai/api/v1/embeddings";
const TIMEOUT_MS = 20_000;

const responseSchema = z.object({
  data: z
    .array(z.object({ embedding: z.array(z.number()) }))
    .min(1),
  model: z.string().optional(),
  usage: z
    .object({
      prompt_tokens: z.number().nonnegative().default(0),
      total_tokens: z.number().nonnegative().default(0),
      cost: z.number().nonnegative().default(0),
    })
    .optional(),
});

/** One row per input text, in the same order. */
export type Embedder = (texts: readonly string[]) => Promise<number[][]>;

export class EmbeddingUnavailableError extends Error {
  constructor(reason: string) {
    super(`Embedding unavailable: ${reason}`);
    this.name = "EmbeddingUnavailableError";
  }
}

export async function embed(texts: readonly string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (!env.openrouterApiKey) throw new EmbeddingUnavailableError("OPENROUTER_API_KEY missing");

  const budget = await budgetStatus();
  if (budget.apiExhausted) {
    // No vector is better than a blown cap: recall then falls back to
    // full-text search, the write path stores the fact without an embedding.
    throw new EmbeddingUnavailableError(`API budget exhausted (${budget.apiCostUsd.toFixed(2)} $)`);
  }

  const response = await keepAliveFetch(ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.openrouterApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: EMBEDDING.openrouter,
      input: [...texts],
      // Never optional: facts about the owner go to an external provider here.
      provider: OPENROUTER_PROVIDER_POLICY,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new EmbeddingUnavailableError(`HTTP ${response.status}`);
  }

  const parsed = responseSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new EmbeddingUnavailableError(`Response does not match the schema: ${parsed.error.issues[0]?.message}`);
  }
  if (parsed.data.data.length !== texts.length) {
    throw new EmbeddingUnavailableError(
      `${parsed.data.data.length} vectors for ${texts.length} texts`,
    );
  }

  const vectors = parsed.data.data.map((entry) => entry.embedding);
  for (const vector of vectors) {
    if (vector.length !== EMBEDDING.dimensions) {
      // A wrong width would break the column and would only have surfaced on
      // insert, but then in the middle of the write path.
      throw new EmbeddingUnavailableError(
        `${vector.length} dimensions instead of ${EMBEDDING.dimensions}`,
      );
    }
  }

  await recordModelUsage({
    provider: "openrouter",
    model: parsed.data.model ?? EMBEDDING.openrouter,
    role: "embedding",
    inputTokens: parsed.data.usage?.prompt_tokens ?? 0,
    outputTokens: 0,
    costUsd: parsed.data.usage?.cost ?? 0,
  });

  return vectors;
}

/** One text, one vector. More convenient for call sites that need exactly one. */
export async function embedOne(text: string): Promise<number[]> {
  const [vector] = await embed([text]);
  if (!vector) throw new EmbeddingUnavailableError("no vector returned");
  return vector;
}

/**
 * Like {@link embed}, but tolerant and in batches: if a batch fails
 * (budget cap, network, schema), exactly the texts from that batch get
 * `null` instead of the whole call throwing. For callers who prefer a record
 * without an embedding over one that is not saved at all because of an
 * embedding error, e.g. the seed path (`scripts/push-memory.ts`), which
 * would otherwise lose 70 facts at the end of the budget instead of only their vectors.
 *
 * Order is preserved, one entry per input text.
 */
export async function embedBestEffort(
  texts: readonly string[],
  batchSize = 20,
): Promise<Array<number[] | null>> {
  const out: Array<number[] | null> = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    try {
      const vectors = await embed(batch);
      out.push(...vectors);
    } catch (error) {
      log.warn(
        `Embeddings for ${batch.length} text(s) unavailable, storing without embedding:`,
        (error as Error).message,
      );
      out.push(...batch.map(() => null));
    }
  }
  return out;
}
