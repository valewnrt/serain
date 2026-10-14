import type { FetchedAttachment, InboundAttachment } from "../channel/types.js";
import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MAX_PER_TURN,
  IMAGE_DESCRIPTION_MAX_CHARS,
  SANDBOX_IMAGE_TIMEOUT_MS,
  SANDBOX_TRANSCRIBE_TIMEOUT_MS,
  TRANSCRIPT_MAX_CHARS,
} from "../config/limits.js";
import type { PerceptionRequest, PerceptionResult } from "../agent/model.js";
import type { Sandbox } from "../sandbox/client.js";
import { formatSize } from "../files/name.js";
import type { FileShelf, ShelvedFile } from "../files/shelf.js";
import { owner } from "../config/owner.js";

/**
 * Reading attachments (D21). An image becomes a description, a voice message a
 * transcript, *before* the chat turn, which stays plain text.
 *
 * The path of every file: fetched through the channel with a size cap, then
 * into the sandbox (D20). There ImageMagick normalises the image to a JPEG
 * without metadata, and ffmpeg plus whisper.cpp turn audio into text. No parser
 * for foreign media formats runs in the process that reads the owner's memory,
 * and no voice message leaves the server.
 *
 * **Whose content is it (D8.4)?** A voice message is the owner's own words:
 * they hear what they send, just as they read what they type or paste. An
 * image is foreign content: it can carry text the owner never saw (small,
 * faint, at the edge of a screenshot), and that is exactly what a prompt
 * injection by photo looks like. The caller therefore frames image
 * descriptions as `<untrusted>` and sets the turn's taint.
 *
 * **Everything else is a file** (PDF, document, video): it is never opened,
 * only shelved (`FileShelf`), so Serain can attach it to a mail (D34 addendum
 * of 2026-10-08). The model learns its name, type and size.
 */

export type AttachmentKind = "image" | "voice";

/**
 * The language whisper heard in a voice message (`-l auto`), with its
 * probability. A signal for the owner's language, never a decision by itself.
 */
export interface HeardLanguage {
  /** Whisper's code, mostly ISO 639-1 (`de`, `tr`), some three letters (`haw`, `yue`). */
  code: string;
  /** 0 to 1. */
  confidence: number;
}

export type AttachmentReading =
  | { status: "read"; kind: AttachmentKind; text: string; truncated: boolean; language?: HeardLanguage }
  | { status: "file"; file: Omit<ShelvedFile, "body"> }
  | { status: "unsupported"; what: string }
  | { status: "failed"; kind: AttachmentKind | null; reason: string };

export interface AttachmentDeps {
  /** Without a sandbox no attachment is read: there is no unsafe fallback. */
  sandbox: Sandbox | null;
  /** Shelf for files that are neither an image nor a voice message. Without it they stay unopened where they are. */
  shelf?: FileShelf;
  /** Fetches the bytes from the channel (`Channel.fetchAttachment`). */
  fetchAttachment(attachment: InboundAttachment, maxBytes: number): Promise<FetchedAttachment>;
  describeImage(req: PerceptionRequest): Promise<PerceptionResult>;
  /** Kill switch or shutdown. */
  cancelled?: Promise<void>;
  onRead?(info: {
    kind: AttachmentKind | null;
    status: AttachmentReading["status"];
    bytes: number;
    ms: number;
    reason?: string;
    provider?: string;
  }): Promise<void> | void;
}

export const IMAGE_INSTRUCTION =
  "Describe the image in two to four sentences so that someone who cannot see it can work with it. " +
  "Reproduce readable text verbatim (signs, screenshots, receipts, dates, amounts, times). " +
  // Live test 2026-09-20: without this sentence a photo of Lago di Braies stayed "an alpine lake", and
  // the research afterwards guessed Turkey. The executor only sees this description, never the image.
  "If you recognise a specific place, building, product or brand, name it and " +
  "say how sure you are; do not guess if you do not recognise it.";

function ascii(bytes: Buffer, start: number, end: number): string {
  return bytes.subarray(start, end).toString("latin1");
}

/**
 * What is it? First the bytes, then the channel's statement, then the file
 * name's extension: an attachment that poses as an image and is none must not
 * be handled as an image.
 */
export function detectKind(bytes: Buffer, declaredMime: string, fileName: string): AttachmentKind | null {
  if (bytes.length >= 12) {
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image";
    if (ascii(bytes, 1, 4) === "PNG" || ascii(bytes, 0, 3) === "GIF") return "image";
    if (ascii(bytes, 0, 4) === "RIFF") {
      const form = ascii(bytes, 8, 12);
      if (form === "WEBP") return "image";
      if (form === "WAVE") return "voice";
    }
    if (ascii(bytes, 0, 4) === "caff" || ascii(bytes, 0, 5) === "#!AMR" || ascii(bytes, 0, 4) === "OggS") return "voice";
    if (ascii(bytes, 0, 3) === "ID3" || (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0)) return "voice";
    if (ascii(bytes, 4, 8) === "ftyp") {
      const brand = ascii(bytes, 8, 12).toLowerCase();
      if (["heic", "heix", "heif", "mif1", "msf1", "avif"].includes(brand)) return "image";
      if (brand.startsWith("m4a") || brand.startsWith("m4b")) return "voice";
      // Other ISO containers (mp42, isom, qt) can be video: the channel's statement decides.
    }
  }
  const mime = declaredMime.toLowerCase();
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "voice";
  if (mime) return null;
  const ext = /\.([a-z0-9]{2,5})$/i.exec(fileName)?.[1]?.toLowerCase() ?? "";
  if (["jpg", "jpeg", "png", "gif", "webp", "heic", "heif"].includes(ext)) return "image";
  if (["caf", "m4a", "amr", "mp3", "wav", "ogg", "opus", "aac"].includes(ext)) return "voice";
  return null;
}

/**
 * How a voice message stands in the owner's text and in the history: the
 * transcript after this marker. The same marker for Serain's own voice
 * messages (`outbound.ts`), so the history reads alike in both directions.
 */
export const VOICE_MESSAGE_MARKER = "[Voice message]";
/** The marker for a transcript cut at `TRANSCRIPT_MAX_CHARS`. */
export const VOICE_MESSAGE_TRUNCATED_MARKER = "[Voice message, truncated]";

/** The one line the sandbox reports from whisper (`WHISPER_REPORT` in deploy/sandbox/helper.mjs). */
const WHISPER_LANGUAGE = /^language=([a-z]{2,3}) p=(\d+(?:\.\d+)?)$/m;

/** The language whisper heard, from the stderr of `audio_to_text`; null when it reported none. */
export function heardLanguage(stderr: string): HeardLanguage | null {
  const match = WHISPER_LANGUAGE.exec(stderr);
  if (!match) return null;
  const confidence = Number(match[2]);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null;
  return { code: match[1]!, confidence };
}

function clip(text: string, max: number): { text: string; truncated: boolean } {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? { text: `${clean.slice(0, max)}…`, truncated: true } : { text: clean, truncated: false };
}

async function readOne(attachment: InboundAttachment, deps: AttachmentDeps): Promise<AttachmentReading> {
  const sandbox = deps.sandbox;
  const started = Date.now();
  let kind: AttachmentKind | null = null;
  let bytes = 0;
  let provider: string | undefined;
  const done = async (reading: AttachmentReading): Promise<AttachmentReading> => {
    await deps.onRead?.({
      kind,
      status: reading.status,
      bytes,
      ms: Date.now() - started,
      ...(reading.status === "failed" ? { reason: reading.reason } : {}),
      ...(provider ? { provider } : {}),
    });
    return reading;
  };

  const noSandbox: AttachmentReading = { status: "failed", kind: null, reason: "there is no sandbox here to open attachments in" };
  // Without a sandbox and without a shelf there is nothing worth fetching for.
  if (!sandbox && !deps.shelf) return done(noSandbox);
  try {
    const file = await deps.fetchAttachment(attachment, ATTACHMENT_MAX_BYTES);
    bytes = file.body.length;
    const declared = attachment.mimeType ?? file.contentType ?? "";
    kind = detectKind(file.body, declared, attachment.name ?? "");
    if (!kind) {
      if (!deps.shelf) return done({ status: "unsupported", what: declared || "unknown type" });
      const shelved = deps.shelf.put({ name: attachment.name ?? "", mimeType: declared, body: file.body });
      return done({ status: "file", file: { id: shelved.id, name: shelved.name, mimeType: shelved.mimeType, size: shelved.size } });
    }
    if (!sandbox) return done({ ...noSandbox, kind });

    if (kind === "voice") {
      const result = await sandbox.run({
        job: "audio_to_text",
        input: file.body,
        timeoutMs: SANDBOX_TRANSCRIBE_TIMEOUT_MS,
        ...(deps.cancelled ? { cancelled: deps.cancelled } : {}),
      });
      if (result.timedOut) return done({ status: "failed", kind, reason: "the voice message is too long to transcribe" });
      const transcript = clip(result.stdout.toString("utf8"), TRANSCRIPT_MAX_CHARS);
      if (result.exitCode !== 0 || !transcript.text) {
        return done({ status: "failed", kind, reason: "no text came out of the recording" });
      }
      const language = heardLanguage(result.stderr);
      return done({ status: "read", kind, ...transcript, ...(language ? { language } : {}) });
    }

    const seen = await lookAtImage(sandbox, file.body, deps.describeImage, IMAGE_INSTRUCTION, deps.cancelled);
    if (!seen.ok) return done({ status: "failed", kind, reason: seen.reason });
    provider = seen.provider;
    const description = clip(seen.text, IMAGE_DESCRIPTION_MAX_CHARS);
    if (!description.text) return done({ status: "failed", kind, reason: "no description came for the image" });
    return done({ status: "read", kind, ...description });
  } catch (error) {
    return done({ status: "failed", kind, reason: (error as Error).message });
  }
}

/**
 * Looking at an image: in the sandbox to a JPEG without metadata (at most
 * 1568 px), then the image model describes it. The model never sees the file
 * from outside. The text is not shortened; shortening and framing is up to the
 * caller.
 */
export async function lookAtImage(
  sandbox: Sandbox,
  bytes: Buffer,
  describe: (req: PerceptionRequest) => Promise<PerceptionResult>,
  instruction: string,
  cancelled?: Promise<void>,
): Promise<{ ok: true; text: string; provider: string } | { ok: false; reason: string }> {
  const converted = await sandbox.run({ job: "image_to_jpeg", input: bytes, timeoutMs: SANDBOX_IMAGE_TIMEOUT_MS, ...(cancelled ? { cancelled } : {}) });
  if (converted.exitCode !== 0 || converted.timedOut || converted.truncated || converted.stdout.length === 0) {
    return { ok: false, reason: "the image could not be opened" };
  }
  const described = await describe({ jpeg: converted.stdout, instruction });
  return { ok: true, text: described.text, provider: described.provider };
}

/** Reads the first attachments of a turn, one after the other: the sandbox is small. */
export async function readAttachments(
  attachments: readonly InboundAttachment[],
  deps: AttachmentDeps,
): Promise<AttachmentReading[]> {
  const readings: AttachmentReading[] = [];
  for (const attachment of attachments.slice(0, ATTACHMENT_MAX_PER_TURN)) {
    readings.push(await readOne(attachment, deps));
  }
  if (attachments.length > ATTACHMENT_MAX_PER_TURN) {
    readings.push({
      status: "failed",
      kind: null,
      reason: `more than ${ATTACHMENT_MAX_PER_TURN} attachments at once, the rest was not opened`,
    });
  }
  return readings;
}

export interface RenderedAttachments {
  /** The owner's own words from voice messages. Belongs to their text. */
  ownerText: string;
  /** Image descriptions: foreign content, for the caller to frame. */
  untrusted: string[];
  /** What could not be read, in words for the model. */
  notes: string[];
}

export function renderReadings(readings: readonly AttachmentReading[]): RenderedAttachments {
  const voice: string[] = [];
  const untrusted: string[] = [];
  const notes: string[] = [];
  for (const reading of readings) {
    if (reading.status === "read" && reading.kind === "voice") {
      voice.push(`${reading.truncated ? VOICE_MESSAGE_TRUNCATED_MARKER : VOICE_MESSAGE_MARKER} ${reading.text}`);
    } else if (reading.status === "read") {
      untrusted.push(reading.text);
    } else if (reading.status === "file") {
      notes.push(fileNote(reading.file));
    } else if (reading.status === "unsupported") {
      notes.push(`[Attachment of type ${reading.what}: you cannot open it]`);
    } else {
      const what = reading.kind === "voice" ? "Voice message" : reading.kind === "image" ? "Image" : "Attachment";
      notes.push(`[${what} not readable: ${reading.reason}]`);
    }
  }
  return { ownerText: voice.join("\n"), untrusted, notes };
}

/**
 * How the model learns of a file, in the turn and later in the history. Never
 * the owner's words: the name comes from whoever created the file.
 */
export function fileNote(file: { id: string; name: string; size: number }): string {
  return `[File from ${owner.name}: "${file.name}", ${formatSize(file.size)}. You do not know its content. To attach: mail_send with files ["${file.id}"], to evaluate: compute_files]`;
}
