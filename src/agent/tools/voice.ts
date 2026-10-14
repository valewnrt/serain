import { z } from "zod";
import { SANDBOX_AUDIO_TIMEOUT_MS, SANDBOX_VOICE_TIMEOUT_MS, VOICE_TEXT_MAX_CHARS } from "../../config/limits.js";
import { audit } from "../../db/audit.js";
import { log } from "../../log.js";
import { hasLocalVoice, noVoiceText, speechLanguage, type RemoteSpeech } from "../../media/speech.js";
import { SandboxError, type Sandbox, type SandboxResult } from "../../sandbox/client.js";
import type { ConfidentialGuard } from "../../security/confidential.js";
import type { FilePort } from "./files.js";
import { defineTool, type ToolDefinition } from "./types.js";
import { owner } from "../../config/owner.js";

/**
 * Voice messages to the owner (D59). The text is spoken on the server, not at
 * a provider: Piper in the sandbox (D20, own image, no network), then AAC mono
 * 24 kHz in an m4a container. Costs $0, and no sentence to the owner leaves
 * the server before it reaches them.
 *
 * **Never as the default.** The tool only runs when the owner sent a voice
 * message themselves in this turn or asks for one in their own words
 * (`ownerWords`, never model text). The code enforces this, not the
 * description: a model that likes voice messages must not be able to make
 * them a habit. A standing preference ("always answer me by voice")
 * deliberately does not exist yet.
 *
 * What was spoken appears as `[Voice message] …` in the history, just as
 * the owner's own voice messages appear there as transcripts.
 *
 * **Two voices (addendum D59).** If there is `remote`, Fish Audio speaks via
 * OpenRouter with zero data retention (decision of 2026-10-08); the MP3
 * becomes a voice message in the sandbox. Piper remains the way for
 * everything that does not belong there or does not work: text with a
 * confidential value (D29), cap reached, provider gone. Piper has one fixed
 * voice per language (`PIPER_VOICES`); in the owner's language it speaks with
 * that one. Without a local voice for the language, the reply goes as text
 * instead of in a voice that cannot speak it.
 */

export interface VoiceDeps {
  sandbox: Sandbox | null;
  port: FilePort | null;
  /** Can the channel send real voice messages (`capabilities.voice`)? */
  canSend: boolean;
  /** The voice via OpenRouter. Without it, Piper always speaks. */
  remote?: RemoteSpeech | null;
  /** Confidential values (D29): text containing them does not leave the server, not as speech either. */
  confidential?: () => Promise<ConfidentialGuard>;
}

function usable(result: SandboxResult): Buffer | null {
  return result.exitCode === 0 && !result.timedOut && !result.truncated && result.stdout.length > 0 ? result.stdout : null;
}

/**
 * The owner wants to hear it: they spoke themselves (transcript marker) or ask
 * for it. German and English words; in any other language the tool simply
 * stays closed (comfort, not security): the owner gets text.
 */
export const VOICE_WANTED = /sprach|vorles|vorsprech|\blies\b[^.?!\n]*\bvor\b|audio|voice|anhör|zum hören|\bread\b[^.?!\n]*\b(?:out|aloud)\b/i;

/**
 * What Piper should read out: without emoji, Markdown and links. Piper reads
 * an emoji as gibberish or not at all, and a link read out helps nobody.
 */
export function speakable(text: string): string {
  return text
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/\p{Extended_Pictographic}|\p{Emoji_Modifier}|\u{FE0F}|\u{200D}/gu, "")
    .replace(/[*_~`#>|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function voiceTools(deps: VoiceDeps): ToolDefinition[] {
  const { sandbox, port } = deps;
  if (!sandbox || !port || !deps.canSend) return [];
  return [
    defineTool({
      name: "send_voice",
      description:
        `Sends ${owner.name} a voice message: you write the text, they hear it spoken. Only when ${owner.name} wants it ` +
        "or wrote by voice message themselves, never on your own. Short and phrased for speaking, as you " +
        "would say it, without lists, links, emoji and numbers to copy (those go along as text with " +
        `send_message). At most ${VOICE_TEXT_MAX_CHARS} characters.`,
      level: "write_reversible",
      origins: ["owner_message"],
      answersOwner: true,
      textToOwner: true,
      schema: { text: z.string().trim().min(1).max(VOICE_TEXT_MAX_CHARS) },
      async run(args, turn) {
        if (!VOICE_WANTED.test(turn.ownerWords)) {
          return {
            ok: false,
            text: `Not sent: voice messages only when ${owner.name} wants one or spoke themselves. Write it as text.`,
          };
        }
        const spoken = speakable(args.text);
        if (!spoken) return { ok: false, text: "Nothing left to read out (only emoji, links or symbols). Write it as text." };
        let audio: Buffer | null = null;
        let voice = "piper";
        try {
          // The language the model writes in, from the code; never a value from the model.
          const language = speechLanguage();
          const remote = deps.remote;
          if (remote) {
            let fallback: string | null = null;
            try {
              // Fail closed: without a readable protection list nothing goes out, Piper speaks.
              const kinds = deps.confidential ? (await deps.confidential()).check(spoken) : [];
              if (kinds.length > 0) fallback = "confidential";
              else {
                const mp3 = await remote(spoken, language);
                audio = usable(
                  await sandbox.run({ job: "audio_to_voice", input: mp3, timeoutMs: SANDBOX_AUDIO_TIMEOUT_MS, cancelled: turn.untilStopped }),
                );
                if (audio) voice = "remote";
                else fallback = "conversion failed";
              }
            } catch (error) {
              if (turn.stopped) throw error;
              fallback = (error as Error).message;
              log.warn("Voice via OpenRouter unavailable, Piper speaks:", fallback);
            }
            await audit("voice_synth", { voice, ...(fallback ? { fallback } : {}), chars: spoken.length }, turn.triggerMessageId);
          }
          if (!audio) {
            if (!hasLocalVoice(language)) return { ok: false, text: noVoiceText(language) };
            audio = usable(
              await sandbox.run({
                job: "text_to_voice",
                input: Buffer.from(spoken, "utf8"),
                language,
                timeoutMs: SANDBOX_VOICE_TIMEOUT_MS,
                cancelled: turn.untilStopped,
              }),
            );
          }
          if (!audio) return { ok: false, text: "Speech synthesis failed. Write it as text." };
        } catch (error) {
          if (error instanceof SandboxError) return { ok: false, text: `Speech synthesis failed (${error.message}). Write it as text.` };
          throw error;
        }
        if (!turn.claimMessage()) return { ok: false, text: "Message limit for this turn reached." };
        const sent = await port.sendFile(
          { name: "Serain.m4a", mimeType: "audio/mp4", body: audio, voice: true },
          spoken,
          { kind: "voice", origin: turn.origin, taintSources: [...turn.taintSources] },
        );
        return sent
          ? { ok: true, text: "Voice message is out." }
          : { ok: false, text: "Not sent (channel, limit or duplicate). Write it as text." };
      },
    }),
  ];
}
