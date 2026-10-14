import { budgetStatus } from "../budget.js";
import { env } from "../config/env.js";
import { SPEECH_API_MAX_MONTH_USD, SPEECH_API_MAX_PER_DAY, SPEECH_API_TIMEOUT_MS } from "../config/limits.js";
import { OPENROUTER_PROVIDER_POLICY, SPEECH, speechVoice } from "../config/models.js";
import { recordModelUsage, speechUsage } from "../db/usage.js";
import { currentLanguage } from "../i18n/language.js";
import { keepAliveFetch } from "../net/keepalive.js";

/**
 * Serain's voice through OpenRouter (D59 addendum): Fish Audio, only with
 * providers that have zero data retention. Approved on 2026-10-08: spoken
 * replies go there. Returns MP3; it becomes a voice message in the sandbox
 * (`audio_to_voice`).
 *
 * Costs per character, so three checks before every call: the overall API cap,
 * the daily cap, the monthly pot of the voice. Booked before the call, as with
 * search: a booked call that fails is cheaper than one that ran and is
 * recorded nowhere. Every refusal is a reason, not an error: then Piper speaks
 * locally.
 */

/**
 * The languages with a local Piper voice in the sandbox (`VOICES` in
 * deploy/sandbox/helper.mjs, downloaded in `Dockerfile.tts`). `test/sandbox.test.ts`
 * checks that the three lists agree. In any other language there is no local
 * voice, and a spoken reply that Fish Audio cannot give is written instead.
 */
export const PIPER_VOICES = ["de", "en", "es", "fr", "it", "nl", "pl", "pt", "ru", "tr"] as const;

/**
 * The language a spoken reply is in: the owner's current language, which the
 * model writes in. The caller passes it as `language` to `text_to_voice`.
 */
export function speechLanguage(): string {
  return currentLanguage();
}

/** Has the sandbox a voice for this language? Then `text_to_voice` takes it as `language`. */
export function hasLocalVoice(language: string): boolean {
  return (PIPER_VOICES as readonly string[]).includes(language);
}

/**
 * For the model, when no voice can speak the reply: plain English, the model
 * writes the reply in the owner's language anyway. `language` is a code from
 * `currentLanguage()`, never text from the model.
 */
export function noVoiceText(language: string): string {
  const name = languageName(language);
  return `No voice for ${name}, send it as text.`;
}

/** "Turkish (tr)" for a code `Intl` knows, else the code. */
function languageName(language: string): string {
  try {
    const name = new Intl.DisplayNames(["en"], { type: "language" }).of(language);
    return name && name !== language ? `${name} (${language})` : language;
  } catch {
    return language;
  }
}

/** Speaks `text` in `language` (base subtag) through a hosted voice; throws `SpeechUnavailable` when that is not possible. */
export type RemoteSpeech = (text: string, language: string) => Promise<Buffer>;

export class SpeechUnavailable extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "SpeechUnavailable";
  }
}

const MAX_AUDIO_BYTES = 4 * 1024 * 1024;

export function openRouterSpeech(): RemoteSpeech | null {
  if (!env.openrouterApiKey) return null;
  return async (text, language) => {
    // Only languages with a chosen hosted voice; every other one falls back to Piper or text.
    const voice = speechVoice(language);
    if (!voice) throw new SpeechUnavailable(`no hosted voice for ${language}`);
    if ((await budgetStatus()).apiExhausted) throw new SpeechUnavailable("API budget used up");
    const usage = await speechUsage();
    if (usage.today >= SPEECH_API_MAX_PER_DAY) throw new SpeechUnavailable("daily cap of the voice reached");
    const cost = text.length * SPEECH.pricePerCharUsd;
    if (usage.monthUsd + cost > SPEECH_API_MAX_MONTH_USD) throw new SpeechUnavailable("monthly pot of the voice used up");
    await recordModelUsage({
      provider: "openrouter",
      model: SPEECH.openrouter,
      role: "speech",
      inputTokens: 0,
      outputTokens: 0,
      costUsd: cost,
      detail: { chars: text.length, estimated: true },
    });
    const response = await keepAliveFetch("https://openrouter.ai/api/v1/audio/speech", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.openrouterApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: SPEECH.openrouter,
        input: text,
        voice,
        response_format: "mp3",
        // Never optional: here Serain's reply to the owner goes to a third party.
        provider: OPENROUTER_PROVIDER_POLICY,
      }),
      signal: AbortSignal.timeout(SPEECH_API_TIMEOUT_MS),
    });
    if (!response.ok) throw new SpeechUnavailable(`HTTP ${response.status}`);
    const audio = Buffer.from(await response.arrayBuffer());
    if (audio.length === 0 || audio.length > MAX_AUDIO_BYTES) throw new SpeechUnavailable(`audio with ${audio.length} bytes`);
    return audio;
  };
}
