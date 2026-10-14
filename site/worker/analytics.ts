/**
 * Counting on serain.si (D65), in the Worker instead of the browser: no
 * script, no cookie, nothing stored on or read from the visitor's device, and
 * it sees what a script never would, the crawlers and assistants that read the
 * pages, their Markdown twins and llms.txt.
 *
 * One data point per counted request in Workers Analytics Engine (dataset
 * `serain_site`), only coarse categories: which built page, what kind of
 * request, the language, which class of client (and the name of a known
 * crawler from the list below), the host of a foreign referrer and the
 * country. Never the IP, not even hashed, never the raw user agent, never a
 * query string, never a path that is not a built file. Views can be counted,
 * visitors cannot, and that is the point. `pnpm site:stats` reads them.
 */

export type Agent = "browser" | "search" | "ai-crawler" | "ai-assistant" | "preview" | "bot";

/** Known clients by the token in their user agent, most specific first. */
const KNOWN: ReadonlyArray<readonly [Agent, readonly string[]]> = [
  // Fetches on behalf of a person who asked an assistant something.
  ["ai-assistant", ["ChatGPT-User", "Claude-User", "Perplexity-User", "MistralAI-User", "DuckAssistBot", "meta-externalfetcher"]],
  // Crawlers for training and for assistants' search indexes.
  ["ai-crawler", ["GPTBot", "OAI-SearchBot", "ClaudeBot", "Claude-SearchBot", "anthropic-ai", "PerplexityBot", "CCBot", "Bytespider", "Amazonbot", "meta-externalagent", "cohere-ai", "Diffbot", "YouBot"]],
  ["search", ["Googlebot", "bingbot", "Applebot", "DuckDuckBot", "YandexBot", "Baiduspider", "SeznamBot", "Yeti", "PetalBot", "Qwantbot"]],
  // Link previews in messengers and social networks.
  ["preview", ["facebookexternalhit", "Twitterbot", "Slackbot", "Discordbot", "TelegramBot", "WhatsApp", "LinkedInBot", "redditbot", "Mastodon", "Bluesky", "Iframely"]],
];

const GENERIC_BOT = /bot\b|crawl|spider|scrape|headless|curl\/|wget\/|python|httpx|go-http-client|node-fetch|undici|axios|java\/|libwww|okhttp/i;

/** The class of a client and, for a known one, its name from the list above; never the user agent itself. */
export function agentOf(userAgent: string | null): { agent: Agent; name: string } {
  const ua = userAgent ?? "";
  const lower = ua.toLowerCase();
  for (const [agent, names] of KNOWN) {
    const name = names.find((token) => lower.includes(token.toLowerCase()));
    if (name) return { agent, name };
  }
  if (!ua || GENERIC_BOT.test(ua) || !ua.startsWith("Mozilla/5.0")) return { agent: "bot", name: "" };
  return { agent: "browser", name: "" };
}

export type Kind = "page" | "markdown" | "llms" | "robots" | "sitemap" | "security" | "preview-image" | "notfound";

const FILES: Record<string, Kind> = {
  "/llms.txt": "llms",
  "/robots.txt": "robots",
  "/sitemap.xml": "sitemap",
  "/.well-known/security.txt": "security",
};

/**
 * What a request counts as, or null for what is not counted (scripts, styles,
 * images, redirects, probes for files that do not exist). `path` is the one a
 * file was served for, so it is always one the build wrote; a page that does
 * not exist counts without its path.
 */
export function counted(path: string, status: number, markdown: boolean): { kind: Kind; path: string } | null {
  const served = (status >= 200 && status < 300) || status === 304;
  const page = path.endsWith("/");
  if (page && status === 404) return { kind: "notfound", path: "" };
  if (!served) return null;
  if (page) return { kind: markdown ? "markdown" : "page", path };
  if (path.endsWith("/index.md")) return { kind: "markdown", path: path.slice(0, -"index.md".length) };
  const file = FILES[path];
  if (file) return { kind: file, path };
  const og = /^\/assets\/(og-[a-z]{2})\.[0-9a-f]+\.jpg$/.exec(path);
  if (og) return { kind: "preview-image", path: `/assets/${og[1]}` };
  return null;
}

/** The language of a counted path: German under /de/ and for its preview image, English for the other pages. */
export function langOf(kind: Kind, path: string): string {
  if (kind === "preview-image") return path.slice(-2);
  if (kind !== "page" && kind !== "markdown") return "";
  return path === "/de/" || path.startsWith("/de/") ? "de" : "en";
}

const HOST = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

/** Only the host of a foreign page that linked here; browsers send no more than the origin across sites anyway. */
export function referrerHost(referer: string | null, ownHost: string): string {
  if (!referer) return "";
  try {
    const url = new URL(referer);
    if (url.protocol !== "https:" && url.protocol !== "http:") return "";
    const host = url.hostname.toLowerCase();
    return host !== ownHost && HOST.test(host) && host.length <= 100 ? host : "";
  } catch {
    return "";
  }
}

/** What this file needs of the Analytics Engine binding; plain so the tests run without the Workers types. */
export interface Dataset {
  writeDataPoint(point: { indexes: string[]; blobs: string[] }): void;
}

/** Writes the request's data point; counting never stands in the way of the page. */
export function record(dataset: Dataset, request: Request, path: string, status: number, markdown: boolean): void {
  if (request.method !== "GET") return;
  const hit = counted(path, status, markdown);
  if (!hit) return;
  try {
    const { agent, name } = agentOf(request.headers.get("user-agent"));
    const referrer = hit.kind === "page" ? referrerHost(request.headers.get("referer"), new URL(request.url).hostname) : "";
    const country = (request as { cf?: { country?: unknown } }).cf?.country;
    dataset.writeDataPoint({
      indexes: [hit.path.slice(0, 96)],
      // blob1..blob7, in this order, for `pnpm site:stats` (scripts/site-cloudflare.ts).
      blobs: [hit.path, hit.kind, langOf(hit.kind, hit.path), agent, name, referrer, typeof country === "string" ? country.slice(0, 2) : ""],
    });
  } catch {
    // A full quota or a missing binding costs a count, never a page.
  }
}
