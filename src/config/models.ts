/**
 * Models live exclusively here (D3). No model name anywhere else in the code.
 *
 * Serain reaches Claude through the Agent SDK, either with an API key (the
 * default, `ANTHROPIC_API_KEY`) or with a subscription token for personal use
 * (`CLAUDE_CODE_OAUTH_TOKEN`); see `pickClaudeAuth` in `src/config/env.ts`. The
 * fallback is OpenRouter, capped at $10/month. The final choice of fallback
 * models is made in phase 1 by eval, not by opinion; until then the candidates
 * here are ones with zero data retention.
 */

export type ModelRole = "chat" | "executor" | "extraction" | "judge" | "consolidation";

export interface RoleModels {
  /** Model ID for the Claude Agent SDK (Claude path, API key or subscription token). */
  subscription: string;
  /** Model ID for OpenRouter (fallback path). */
  openrouter: string;
  /**
   * Cheaper OpenRouter model while the budget is throttled (addendum D3 of
   * 2026-10-08). Without it the normal one stays; the small roles already run
   * on the cheapest anyway.
   */
  saver?: string;
  /** Thinking before the answer on the Claude path (D50). Without it, the Agent SDK default. */
  thinking?: Thinking;
}

/**
 * How long the model thinks before an answer on the Claude path (D50). `off`
 * turns thinking off, a level keeps adaptive thinking on and sets the effort.
 * Without it, the Agent SDK default applies: adaptive, level `high`. Measured
 * 2026-10-02 with Sonnet 5: thinking costs about two seconds before every tool
 * call, even before a tapback.
 */
export type Thinking = "off" | "low" | "medium" | "high";

/**
 * Backends of the `judge` role (D12). `jev` is a specialized decider behind an
 * alpha endpoint of OpenRouter, `generative` the small model of the
 * `extraction` role with structured output.
 */
export type JudgeBackendName = "jev" | "generative";

/**
 * Order of the judge backends: the first element is primary, the rest is
 * fallback in this order. The default is deliberately `generative` until the
 * eval has decided: the Jev endpoint is alpha and undocumented, and a memory
 * that depends on an alpha endpoint would be a gamble.
 */
export const JUDGE_BACKEND_ORDER = [
  "generative",
  "jev",
] as const satisfies readonly JudgeBackendName[];

/** Model ID of the Jev decider. Like every model ID, it lives only here. */
export const JEV_MODEL = "typesafe/jev-1.13";

/**
 * Jev directly at Typesafe, as the browser pilot (D35). Pinned, because the
 * thresholds in `src/config/limits.ts` depend on a version; `jev-latest`
 * changes its behavior without notice. Price per million input tokens, output
 * is free.
 */
export const JEV_DIRECT = { model: "jev-1.13.0", pricePerMillionInputTokensUsd: 0.042 } as const;

/**
 * Embedding model for pgvector (D13). 1536 dimensions, because the columns in
 * `0001_core.sql` are exactly that wide. Price: $0.02 per million tokens, a
 * fact costs about $0.0000002.
 */
export const EMBEDDING = {
  openrouter: "openai/text-embedding-3-small",
  dimensions: 1536,
  /**
   * Price per million tokens (D13). Only for cost estimates before a real call
   * (backfill cap, `--dry-run`): embeddings have no output tokens and no model
   * variance, the price is linear in the input tokens, so an estimate from the
   * character count is enough. The actual cost is in `usage_log` after every
   * real call.
   */
  pricePerMillionTokensUsd: 0.02,
} as const;

/**
 * Saver model for the throttled fallback (addendum D3 of 2026-10-08): a third
 * of Sonnet's price, same family, ZDR endpoint. Chosen by eval against the
 * normal fallback, result in the addendum.
 */
const SAVER = "anthropic/claude-haiku-4.5";

export const models: Record<ModelRole, RoleModels> = {
  chat: {
    subscription: "sonnet",
    openrouter: "anthropic/claude-sonnet-4.5",
    saver: SAVER,
  },
  executor: {
    subscription: "sonnet",
    openrouter: "anthropic/claude-sonnet-4.5",
    saver: SAVER,
  },
  extraction: {
    subscription: "haiku",
    openrouter: "google/gemini-2.5-flash-lite",
  },
  /**
   * A role of its own, although today it holds the same model as `extraction`:
   * the generative judge backend answers decision questions, not extraction
   * questions, and the eval should be able to measure and fill both separately
   * (D12).
   */
  judge: {
    subscription: "haiku",
    openrouter: "google/gemini-2.5-flash-lite",
  },
  /**
   * Nightly consolidation of the user model (H1, D40). Once per night and only
   * with new facts, so rarely; in exchange, the result is in every turn
   * afterwards. Hence the chat model and not the small one of extraction.
   */
  consolidation: {
    subscription: "sonnet",
    openrouter: "anthropic/claude-sonnet-4.5",
    saver: SAVER,
  },
};

/**
 * Perception (D21): describe an image. Not a `ModelRole`, because no turn runs
 * here, just a single call with an image. Claude reads it through the Agent SDK,
 * OpenRouter is the fallback. Voice messages need no model from this file:
 * whisper.cpp transcribes them in the sandbox.
 */
export const PERCEPTION_MODELS = {
  image: { subscription: "haiku", openrouter: "google/gemini-2.5-flash" },
  /**
   * Video with picture and sound (D61). Claude cannot do video, so OpenRouter
   * only. Chosen on 2026-10-08 against 3.5 and 3.6 Flash on a TikTok and a
   * YouTube video of 3:33: the same description, but 3 instead of 5 to 7 s and a
   * third to half the cost (1 cent for the 3:33, about 91 tokens per second).
   * An hour of YouTube thus costs about $0.17.
   */
  video: { openrouter: "google/gemini-3-flash-preview" },
} as const;

/**
 * Serain's voice (addendum D59 of 2026-10-08): Fish Audio via OpenRouter, with
 * zero data retention, chosen from three voice samples. Price per character
 * according to OpenRouter ($0.015 per 1,000); the response is pure audio
 * without a cost figure, so it is billed by characters.
 *
 * A Fish voice speaks the language it was trained on; in any other it sounds
 * wrong. So the voice is chosen per language (`speechVoice`): only languages
 * listed here go to Fish, every other one to the local Piper voice of that
 * language (`PIPER_VOICES` in `src/media/speech.ts`), and without one the reply
 * stays text. The German voice comes from Fish's library ("5.28达人", young,
 * bright, trained on German, uploaded by a user); if it disappears, Piper
 * takes over. A voice for another language is a new line here, chosen by
 * listening, like the first.
 */
export const SPEECH = {
  openrouter: "fish-audio/s2.1-pro",
  voices: {
    de: "2f5ba840381340698c38b9ad0e34803d",
  } as Readonly<Record<string, string>>,
  pricePerCharUsd: 0.000015,
} as const;

/** The Fish voice for a base language (`de`), or null: then Piper or text. */
export function speechVoice(language: string): string | null {
  return Object.hasOwn(SPEECH.voices, language) ? SPEECH.voices[language]! : null;
}

/**
 * The only provider policy for OpenRouter. Every paid call (chat fallback,
 * structured output, embeddings, Jev, eval) goes out with exactly this policy.
 *
 * D3 says "only providers with zero data retention", with no exception for the
 * chat. Previously there were two policies here: a soft one
 * (`data_collection: "deny"`) for the chat and a hard one (additionally
 * `zdr: true`) for the memory paths. The reasoning was that the ZDR flag
 * shrinks the provider list too much. That was checked against the model API on
 * 2026-09-18 and refuted: all candidates from D3 have a ZDR endpoint. And the
 * split was wrong anyway: a chat turn carries the owner's messages and half the
 * memory context in its prompt, so it deserves no less protection than a single
 * fact.
 *
 * `data_collection: "deny"` stays in addition: it excludes providers that may
 * collect prompts for their own purposes, even if they store nothing.
 */
export const OPENROUTER_PROVIDER_POLICY = {
  zdr: true,
  data_collection: "deny",
} as const;

/**
 * The one named exception to {@link OPENROUTER_PROVIDER_POLICY} (D61, of
 * 2026-10-08): YouTube blocks the server as a data center, nothing can be
 * downloaded there. Google AI Studio fetches a YouTube video itself, and only
 * this provider can do that; Vertex (ZDR) takes no URL. AI Studio has no ZDR,
 * but does not collect (`data_collection: "deny"` holds). The call therefore
 * carries only the public URL and a fixed instruction, never the owner's
 * question, never anything from their memory (`src/media/video.ts`). Use it for
 * nothing else.
 */
export const YOUTUBE_PROVIDER_POLICY = {
  only: ["google-ai-studio"],
  allow_fallbacks: false,
  data_collection: "deny",
} as const;
