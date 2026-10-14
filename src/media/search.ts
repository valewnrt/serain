import { VIDEO_SEARCH_MAX_BYTES, VIDEO_SEARCH_MAX_HITS } from "../config/limits.js";
import { owner } from "../config/owner.js";
import { fetchPage } from "../executor/fetch.js";
import { currentLanguage } from "../i18n/language.js";

/**
 * Searching videos on YouTube (D61 addendum of 2026-10-09). Web search finds
 * three to six pages about a creator, without date or length; in the live test
 * that missed the video the owner had asked about, and the executor watched an
 * older one with a similar title. YouTube's public search page works from the
 * server (unlike loading the videos) and carries every hit with channel, age,
 * length and views as JSON (`ytInitialData`). No login, no cookies, the same
 * network protection as `web_fetch`.
 *
 * Interface language and region follow the owner: `hl` is the current
 * language (ages and view counts come in it, and results lean towards it),
 * `gl` the owner's country (`OWNER_COUNTRY`), left out when unknown.
 */

export interface VideoHit {
  url: string;
  title: string;
  channel: string;
  published: string;
  length: string;
  views: string;
  /** Start of the description, without links. Often shows who owns a channel ("KOCHKANAL42 SOCIALS"). */
  snippet: string;
  /**
   * The description points to an "original" on YouTube: then it is a reaction
   * to someone else's video. Live finding 2026-10-09: three times the executor
   * took a reaction on the second channel instead of the creator's own visit.
   */
  reaction: boolean;
}

export class VideoSearchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VideoSearchError";
  }
}

export async function searchVideos(query: string, fetchImpl: typeof fetchPage = fetchPage): Promise<VideoHit[]> {
  const region = owner.country ? `&gl=${owner.country}` : "";
  const url = `https://www.youtube.com/results?hl=${currentLanguage()}${region}&search_query=${encodeURIComponent(query)}`;
  const page = await fetchImpl(url, { raw: { maxBytes: VIDEO_SEARCH_MAX_BYTES } });
  if (page.status >= 400) throw new VideoSearchError(`YouTube search: status ${page.status}`);
  return parseSearchPage(page.text).slice(0, VIDEO_SEARCH_MAX_HITS);
}

/** The hits from the HTML of the search page, in YouTube's order. Shorts and ads are left out. */
export function parseSearchPage(html: string): VideoHit[] {
  const start = html.search(/ytInitialData\s*=\s*\{/);
  if (start < 0) throw new VideoSearchError("The YouTube search page has no result data (layout changed or blocked).");
  const open = html.indexOf("{", start);
  const end = html.indexOf(";</script>", open);
  let data: unknown;
  try {
    data = JSON.parse(html.slice(open, end < 0 ? undefined : end));
  } catch {
    throw new VideoSearchError("The result data of the YouTube search could not be read.");
  }
  const hits: VideoHit[] = [];
  const seen = new Set<string>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (!node || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    const video = record["videoRenderer"];
    if (video && typeof video === "object") {
      const hit = toHit(video as Record<string, unknown>);
      if (hit && !seen.has(hit.url)) {
        seen.add(hit.url);
        hits.push(hit);
      }
      return;
    }
    for (const value of Object.values(record)) walk(value);
  };
  walk(data);
  return hits;
}

function toHit(video: Record<string, unknown>): VideoHit | null {
  const id = video["videoId"];
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{11}$/.test(id)) return null;
  const title = textOf(video["title"]);
  if (!title) return null;
  const snippets = video["detailedMetadataSnippets"];
  const raw = Array.isArray(snippets) && snippets[0] && typeof snippets[0] === "object" ? textOf((snippets[0] as Record<string, unknown>)["snippetText"]) : "";
  return {
    url: `https://www.youtube.com/watch?v=${id}`,
    title,
    channel: textOf(video["ownerText"]) || textOf(video["longBylineText"]),
    published: textOf(video["publishedTimeText"]),
    length: textOf(video["lengthText"]),
    views: textOf(video["viewCountText"]),
    snippet: raw.replace(/https?:\/\/\S+/g, "").replace(/\s+/g, " ").trim().slice(0, 160),
    reaction: REACTION.test(raw),
  };
}

/**
 * "ORIGINAL VIDEO ▻ https://www.youtube.com/watch?v=…", "full video: youtu.be/…"
 * and the German "zum Video: youtu.be/…" (clip channels). Comfort, not safety:
 * in other languages a reaction simply counts as a video of its own.
 */
const REACTION = /\b(?:original(?:\s*-?\s*video)?|zum\s+(?:ganzen\s+)?video|full\s+video)\s*[:▻►>»-]*\s*(?:https?:\/\/)?(?:www\.|m\.)?(?:youtube\.com\/watch|youtu\.be\/)/i;

/** YouTube writes text as `simpleText` or as `runs`. */
function textOf(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  if (typeof record["simpleText"] === "string") return clean(record["simpleText"]);
  const runs = record["runs"];
  if (!Array.isArray(runs)) return "";
  return clean(runs.map((run) => (run && typeof (run as Record<string, unknown>)["text"] === "string" ? (run as Record<string, string>)["text"] : "")).join(""));
}

function clean(text: string): string {
  return text.replace(/[\p{Cc}\p{Cf}\p{Co}\p{Cn}]/gu, "").replace(/\s+/g, " ").trim().slice(0, 200);
}
