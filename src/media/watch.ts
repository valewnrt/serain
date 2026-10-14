import { MEDIA_COMPACT_TIMEOUT_MS, MEDIA_FETCH_TIMEOUT_MS, MEDIA_MAX_IMAGES, SANDBOX_IMAGE_TIMEOUT_MS } from "../config/limits.js";
import { FetchError, fetchPage, htmlToText } from "../executor/fetch.js";
import { BlockedAddressError } from "../executor/netguard.js";
import { owner } from "../config/owner.js";
import { SandboxError, type Sandbox, type SandboxResult } from "../sandbox/client.js";
import { VideoModelError, watchVideo, type VideoDescription, type VideoSource } from "./video.js";

/**
 * Watching videos and posts (D61): YouTube, TikTok, Instagram, X.
 *
 * - **YouTube** blocks the server as a data centre. Google fetches the video
 *   itself (`watchVideo` with the URL); from the server only oEmbed goes out,
 *   for title and channel.
 * - **TikTok, Instagram, X** are loaded by yt-dlp in the sandbox
 *   (`media_fetch`), whose only way out is the filter proxy. ffmpeg then shrinks
 *   without network (`video_compact`), and the model sees that MP4. A post
 *   without a video (Instagram image post, TikTok photo series) brings its
 *   images; `image_to_jpeg` normalises them, and the model sees all of them
 *   together. A post on X without a video comes as text through X's own oEmbed.
 *
 * Only these four platforms and only the paths of videos and posts: no
 * profile, no story, no arbitrary page. Nothing ever logs in; what a platform
 * only shows with an account is closed, and the result says so.
 *
 * Downloading with yt-dlp is off by default (`SERAIN_MEDIA_DOWNLOAD=1` turns it
 * on): the platforms forbid it in their terms, so every operator decides for
 * themselves. Without the switch there is only YouTube, which needs no
 * download.
 */

export type MediaPlatform = "youtube" | "tiktok" | "instagram" | "x";

export interface MediaLink {
  platform: MediaPlatform;
  /** The cleaned address: without tracking parameters, only the parts that identify the video. */
  url: string;
}

export const MEDIA_PLATFORM_LABEL: Record<MediaPlatform, string> = { youtube: "YouTube", tiktok: "TikTok", instagram: "Instagram", x: "X" };
const LABEL = MEDIA_PLATFORM_LABEL;

/** Env switch for yt-dlp in the sandbox. Only the value `1` turns it on. */
export const MEDIA_DOWNLOAD_ENV = "SERAIN_MEDIA_DOWNLOAD";

/** May `media_fetch` load? Reads the switch from the env, off by default. */
export function mediaDownloadEnabled(): boolean {
  return process.env[MEDIA_DOWNLOAD_ENV]?.trim() === "1";
}

/** Name of the proxy socket in the directory `SERAIN_MEDIA_PROXY_DIR`; the container sees it as `/proxy/proxy.sock`. */
export const MEDIA_PROXY_SOCKET = "proxy.sock";

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const DIGITS = /^\d{1,25}$/;
const SHORT_CODE = /^[A-Za-z0-9_-]{4,40}$/;
const HANDLE = /^[A-Za-z0-9_.]{1,40}$/;

/** Which platform, which video? `null` for everything else, profiles and stories included. */
export function mediaLink(raw: string): MediaLink | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password || (url.port && url.port !== "443" && url.port !== "80")) return null;
  const host = url.hostname.toLowerCase().replace(/^(www|m|mobile)\./, "");
  const parts = url.pathname.split("/").filter(Boolean);
  const [first = "", second = "", third = "", fourth = ""] = parts;

  if (host === "youtu.be") {
    return YOUTUBE_ID.test(first) ? youtube(first) : null;
  }
  if (host === "youtube.com") {
    const id = first === "watch" ? (url.searchParams.get("v") ?? "") : ["shorts", "live", "embed", "v"].includes(first) ? second : "";
    return YOUTUBE_ID.test(id) ? youtube(id) : null;
  }
  if (host === "tiktok.com") {
    if (first.startsWith("@") && HANDLE.test(first.slice(1)) && (second === "video" || second === "photo") && DIGITS.test(third)) {
      return { platform: "tiktok", url: `https://www.tiktok.com/${first}/${second}/${third}` };
    }
    if (first === "t" && SHORT_CODE.test(second)) return { platform: "tiktok", url: `https://www.tiktok.com/t/${second}/` };
    return null;
  }
  if (host === "vm.tiktok.com" || host === "vt.tiktok.com") {
    return SHORT_CODE.test(first) && parts.length === 1 ? { platform: "tiktok", url: `https://${host}/${first}/` } : null;
  }
  if (host === "instagram.com") {
    // /reel/CODE, /p/CODE, /tv/CODE, and lately /name/reel/CODE.
    const [kind, code] = ["reel", "reels", "p", "tv"].includes(first) ? [first, second] : ["reel", "p"].includes(second) && HANDLE.test(first) ? [second, third] : ["", ""];
    if (!kind || !SHORT_CODE.test(code)) return null;
    return { platform: "instagram", url: `https://www.instagram.com/${kind === "reels" ? "reel" : kind}/${code}/` };
  }
  if (host === "x.com" || host === "twitter.com") {
    if (first === "i" && second === "web" && third === "status" && DIGITS.test(fourth)) return { platform: "x", url: `https://x.com/i/status/${fourth}` };
    if (second === "status" && DIGITS.test(third) && (first === "i" || /^[A-Za-z0-9_]{1,15}$/.test(first))) {
      return { platform: "x", url: `https://x.com/${first}/status/${third}` };
    }
    return null;
  }
  return null;
}

function youtube(id: string): MediaLink {
  return { platform: "youtube", url: `https://www.youtube.com/watch?v=${id}` };
}

export interface MediaWatchResult {
  ok: boolean;
  text: string;
  source: string;
}

export interface MediaWatcher {
  /** What works here. Without switch, sandbox and proxy only YouTube. */
  platforms: readonly MediaPlatform[];
  /** Downloading is switched off (not: sandbox or proxy is missing). */
  downloadOff: boolean;
  watch(url: string, cancelled?: Promise<void>): Promise<MediaWatchResult>;
}

export interface MediaWatcherDeps {
  /** Sandbox whose helper reaches the filter proxy's socket in `media_fetch`. Without it only YouTube. */
  downloads: Sandbox | null;
  /** Whether yt-dlp may load. Default: the switch `SERAIN_MEDIA_DOWNLOAD` (`mediaDownloadEnabled`). */
  downloadsAllowed?: boolean;
  fetch?: typeof fetchPage;
  watchVideo?: typeof watchVideo;
}

/** What yt-dlp in the sandbox reports when it does not load (`deploy/sandbox/media_fetch.py`). */
type FetchFailure = "login" | "no_video" | "unavailable" | "unsupported" | "too_long" | "too_big" | "failed";

interface FetchedVideo {
  title: string;
  uploader: string;
  description: string;
  duration: number | null;
  /** Only for image posts: how many images the post has, and which music plays with it (TikTok). */
  imagesTotal: number;
  music: string;
  parts: { bytes: number; kind: string }[];
  body: Buffer;
}

class MediaFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MediaFailure";
  }
}

function failureText(reason: FetchFailure, platform: MediaPlatform, detail: string): string {
  const name = LABEL[platform];
  switch (reason) {
    case "login":
      return `${name} only shows this when logged in, and Serain is not logged in there. ${owner.name} has to watch it themselves.`;
    case "no_video":
      return `The ${name} post has neither a video nor an image that can be loaded.`;
    case "unavailable":
      return `This does not exist on ${name} (any more), or it is private.`;
    case "unsupported":
      return `This ${name} address cannot be loaded.`;
    case "too_long":
      return `The video is longer than 30 minutes; nothing that long is loaded.`;
    case "too_big":
      return `The video is too big to load.`;
    default:
      return `Loading from ${name} failed${detail ? `: ${detail}` : ""}.`;
  }
}

function headerAndBody(result: SandboxResult, what: string): { header: Record<string, unknown>; body: Buffer } {
  if (result.timedOut) throw new MediaFailure(`${what} took too long.`);
  if (result.truncated) throw new MediaFailure(`${what}: result too big.`);
  const newline = result.stdout.indexOf(0x0a);
  if (result.exitCode !== 0 || newline < 0) throw new MediaFailure(`${what} failed.`);
  try {
    const header = JSON.parse(result.stdout.subarray(0, newline).toString("utf8")) as Record<string, unknown>;
    return { header, body: result.stdout.subarray(newline + 1) };
  } catch {
    throw new MediaFailure(`${what}: response unreadable.`);
  }
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function minutes(seconds: number): string {
  const total = Math.round(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** From a promise that resolves on cancellation, a signal for `fetch`. */
function signalOf(cancelled: Promise<void> | undefined): AbortSignal | undefined {
  if (!cancelled) return undefined;
  const controller = new AbortController();
  void cancelled.then(() => controller.abort());
  return controller.signal;
}

export function mediaWatcher(deps: MediaWatcherDeps): MediaWatcher {
  const fetchImpl = deps.fetch ?? fetchPage;
  const watchImpl = deps.watchVideo ?? watchVideo;
  const allowed = deps.downloadsAllowed ?? mediaDownloadEnabled();
  // Without the switch the watcher never gets the sandbox: `media_fetch` then runs on no path at all.
  const sandbox = allowed ? deps.downloads : null;
  const platforms: MediaPlatform[] = sandbox ? ["youtube", "tiktok", "instagram", "x"] : ["youtube"];

  /** Title and channel on YouTube. `null` means: the video does not exist. */
  async function youtubeMeta(url: string): Promise<{ title: string; author: string } | null> {
    try {
      const page = await fetchImpl(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`);
      if (page.status === 404 || page.status === 400) return null;
      if (page.status >= 400) return { title: "", author: "" };
      const data = JSON.parse(page.text) as Record<string, unknown>;
      return { title: text(data["title"]), author: text(data["author_name"]) };
    } catch {
      // It works without a title too: the model fetches the video itself.
      return { title: "", author: "" };
    }
  }

  async function tweetText(url: string): Promise<string | null> {
    try {
      const page = await fetchImpl(`https://publish.x.com/oembed?omit_script=1&dnt=true&url=${encodeURIComponent(url)}`);
      if (page.status >= 400) return null;
      const data = JSON.parse(page.text) as Record<string, unknown>;
      const body = htmlToText(text(data["html"])).text.trim();
      if (!body) return null;
      const author = text(data["author_name"]);
      return `X post${author ? ` by ${author}` : ""} (no video):\n${body}`;
    } catch (error) {
      if (error instanceof FetchError || error instanceof BlockedAddressError || error instanceof SyntaxError) return null;
      throw error;
    }
  }

  async function download(link: MediaLink, cancelled: Promise<void> | undefined): Promise<FetchedVideo | { failure: FetchFailure; detail: string }> {
    if (!sandbox) throw new MediaFailure(`${LABEL[link.platform]} cannot be loaded here.`);
    const result = await sandbox.run({
      job: "media_fetch",
      input: Buffer.from(JSON.stringify({ url: link.url })),
      timeoutMs: MEDIA_FETCH_TIMEOUT_MS,
      ...(cancelled ? { cancelled } : {}),
    });
    const { header, body } = headerAndBody(result, "Loading");
    if (header["ok"] !== true) {
      const reason = text(header["reason"]) as FetchFailure;
      return { failure: reason || "failed", detail: text(header["message"]) };
    }
    const parts = Array.isArray(header["parts"]) ? (header["parts"] as { bytes: number; kind: string }[]) : [];
    const expected = parts.reduce((sum, part) => sum + (Number.isInteger(part.bytes) ? part.bytes : NaN), 0);
    const images = parts.length > 0 && parts.every((part) => part.kind === "image");
    const tooMany = images ? parts.length > MEDIA_MAX_IMAGES : parts.length > 2 || parts.some((part) => part.kind === "image");
    if (parts.length < 1 || tooMany || expected !== body.length) throw new MediaFailure("Loading: parts do not match what was announced.");
    return {
      title: text(header["title"]),
      uploader: text(header["uploader"]),
      description: text(header["description"]),
      duration: typeof header["duration"] === "number" ? header["duration"] : null,
      imagesTotal: Number.isInteger(header["images_total"]) ? (header["images_total"] as number) : parts.length,
      music: text(header["music"]),
      parts: parts.map((part) => ({ bytes: part.bytes, kind: text(part.kind) })),
      body,
    };
  }

  /** Every image on its own through ImageMagick without network, like a photo from the owner (D21). What cannot be opened is left out. */
  async function normalize(post: FetchedVideo, cancelled: Promise<void> | undefined): Promise<Buffer[]> {
    if (!sandbox) throw new MediaFailure("No sandbox.");
    const jpegs: Buffer[] = [];
    let offset = 0;
    for (const part of post.parts) {
      const input = post.body.subarray(offset, offset + part.bytes);
      offset += part.bytes;
      const result = await sandbox.run({
        job: "image_to_jpeg",
        input,
        timeoutMs: SANDBOX_IMAGE_TIMEOUT_MS,
        ...(cancelled ? { cancelled } : {}),
      });
      if (result.exitCode === 0 && !result.timedOut && !result.truncated && result.stdout.length > 0) jpegs.push(result.stdout);
    }
    if (jpegs.length === 0) throw new MediaFailure("The images of the post could not be opened.");
    return jpegs;
  }

  async function compact(video: FetchedVideo, cancelled: Promise<void> | undefined): Promise<{ mp4: Buffer; seconds: number | null; cut: boolean; audio: boolean }> {
    if (!sandbox) throw new MediaFailure("No sandbox.");
    const result = await sandbox.run({
      job: "video_compact",
      input: Buffer.concat([Buffer.from(`${JSON.stringify({ parts: video.parts })}\n`), video.body]),
      timeoutMs: MEDIA_COMPACT_TIMEOUT_MS,
      ...(cancelled ? { cancelled } : {}),
    });
    const { header, body } = headerAndBody(result, "Preparing the video");
    if (body.length === 0) throw new MediaFailure("The video could not be opened.");
    return {
      mp4: body,
      seconds: typeof header["seconds"] === "number" ? header["seconds"] : null,
      cut: header["cut"] === true,
      audio: header["audio"] === true,
    };
  }

  async function describe(source: VideoSource, signal: AbortSignal | undefined): Promise<VideoDescription> {
    try {
      return await watchImpl(source, signal);
    } catch (error) {
      if (error instanceof VideoModelError) throw new MediaFailure(error.message);
      const name = (error as Error).name;
      if (name === "TimeoutError" || name === "AbortError") throw new MediaFailure("Watching took too long or was cancelled.");
      if (error instanceof TypeError) throw new MediaFailure(`The video model was not reachable: ${error.message}`);
      throw error;
    }
  }

  return {
    platforms,
    downloadOff: !allowed,
    async watch(raw, cancelled) {
      const link = mediaLink(raw);
      if (!link) {
        return {
          ok: false,
          source: raw,
          text: "This is not a link to a video or a post on YouTube, TikTok, Instagram or X. Profiles and stories do not work; other pages are read by web_fetch.",
        };
      }
      if (!platforms.includes(link.platform)) {
        if (!allowed) {
          return {
            ok: false,
            source: link.url,
            text: `${LABEL[link.platform]} would have to be downloaded with yt-dlp, and that is off: turn it on with ${MEDIA_DOWNLOAD_ENV}=1 in the env, at your own risk (the platforms forbid it in their terms).`,
          };
        }
        return { ok: false, source: link.url, text: `${LABEL[link.platform]} cannot be watched here, only ${platforms.map((p) => LABEL[p]).join(", ")}.` };
      }
      const signal = signalOf(cancelled);
      try {
        if (link.platform === "youtube") {
          const meta = await youtubeMeta(link.url);
          if (!meta) return { ok: false, source: link.url, text: "This YouTube video does not exist (any more), or it is private." };
          const seen = await describe({ kind: "youtube", url: link.url }, signal);
          const head = meta.title ? `YouTube video "${meta.title}"${meta.author ? ` by ${meta.author}` : ""}` : "YouTube video";
          return { ok: true, source: link.url, text: `${head}\n\n${seen.text}` };
        }

        const fetched = await download(link, cancelled);
        if ("failure" in fetched) {
          if (fetched.failure === "no_video" && link.platform === "x") {
            const post = await tweetText(link.url);
            if (post) return { ok: true, source: link.url, text: post };
          }
          return { ok: false, source: link.url, text: failureText(fetched.failure, link.platform, fetched.detail) };
        }
        if (fetched.parts.every((part) => part.kind === "image")) {
          const jpegs = await normalize(fetched, cancelled);
          const seen = await describe({ kind: "images", jpegs }, signal);
          const count = jpegs.length === fetched.imagesTotal ? `${jpegs.length} ${jpegs.length === 1 ? "image" : "images"}` : `${fetched.imagesTotal} images, ${jpegs.length} of them viewed`;
          const lines = [
            `${LABEL[link.platform]} post${fetched.uploader ? ` by ${fetched.uploader}` : ""} with ${count}, no video`,
            ...(fetched.description ? [`Text of the post: ${fetched.description}`] : []),
            ...(fetched.music ? [`Music: ${fetched.music}`] : []),
            "",
            seen.text,
          ];
          return { ok: true, source: link.url, text: lines.join("\n") };
        }
        const video = await compact(fetched, cancelled);
        const seen = await describe({ kind: "mp4", data: video.mp4, audio: video.audio }, signal);
        const length = video.seconds ?? fetched.duration;
        const lines = [
          `${LABEL[link.platform]} video${fetched.title ? ` "${fetched.title}"` : ""}${fetched.uploader ? ` by ${fetched.uploader}` : ""}${length ? ` (${minutes(length)}${video.audio ? "" : ", no sound"})` : video.audio ? "" : " (no sound)"}`,
          ...(fetched.description && fetched.description !== fetched.title ? [`Text of the post: ${fetched.description}`] : []),
          ...(video.cut ? ["Only the first 15 minutes were watched; the video is longer."] : []),
          "",
          seen.text,
        ];
        return { ok: true, source: link.url, text: lines.join("\n") };
      } catch (error) {
        if (error instanceof MediaFailure || error instanceof SandboxError) return { ok: false, source: link.url, text: error.message };
        throw error;
      }
    },
  };
}
