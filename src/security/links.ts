import { t } from "../i18n/catalog.js";
import { currentLanguage } from "../i18n/language.js";
import { core } from "../i18n/messages/core.js";
import { getDomain } from "tldts";
import { checkUrl } from "../executor/netguard.js";

/**
 * Links in messages to the owner after untrusted content (addendum D8.4 of 2026-10-08).
 *
 * A link Serain sends looks like Serain's recommendation. If it comes from
 * a mail, a search hit or the text of a page, that is the shortest
 * path to phishing: the tampered source writes it in, Serain passes it
 * on, the owner taps it. After untrusted content, therefore, only a link goes out
 * whose page a tool in this job has itself opened successfully,
 * one the owner wrote themselves, or the home page of a sender
 * their mail provider has confirmed via DMARC (addendum of 2026-10-12).
 *
 * Detected is what iMessage shows as a link: with a scheme, with `www.` and every
 * name with an ending made of letters. File names like "invoice.pdf" don't count,
 * their endings are not domains. Better detected once too often (then
 * the model writes the sentence without it) than once too rarely.
 */

const CANDIDATE = /(?:https?:\/\/)?(?:[\p{L}\p{N}-]+\.)+[\p{L}]{2,}(?::\d{1,5})?(?:[/?#][^\s<>"'`]*)?/giu;

/** Endings that appear in messages as file names and are not domains. */
const FILE_EXTENSIONS = new Set([
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "txt", "csv", "rtf", "pages", "numbers", "key",
  "png", "jpg", "jpeg", "gif", "heic", "webp", "svg", "ics", "vcf", "vcard", "json", "xml", "mp3", "m4a", "wav", "js", "ts",
]);

/** Punctuation at the end belongs to the sentence, not to the link. */
function trimTrailing(match: string): string {
  return match.replace(/[.,;:!?)\]}]+$/u, "");
}

/** All links in the text, as they stand. */
export function findLinks(text: string): string[] {
  const links: string[] = [];
  for (const match of text.matchAll(CANDIDATE)) {
    const start = match.index ?? 0;
    // Part of a mail address (before or after the @): not a page the owner opens.
    if ((start > 0 && text[start - 1] === "@") || text[start + match[0].length] === "@") continue;
    const link = trimTrailing(match[0]);
    const host = link.replace(/^https?:\/\//i, "").split(/[/?#:]/)[0] ?? "";
    const ending = host.split(".").at(-1)?.toLowerCase() ?? "";
    const explicit = /^https?:\/\//i.test(link) || /^www\./i.test(host);
    if (!explicit && FILE_EXTENSIONS.has(ending)) continue;
    links.push(link);
  }
  return links;
}

/** Host without `www.`, path without trailing slash, query as it is. No scheme, no anchor. */
function normalize(link: string): { host: string; path: string; query: string } | null {
  try {
    const url = new URL(/^https?:\/\//i.test(link) ? link : `https://${link}`);
    return {
      host: url.hostname.toLowerCase().replace(/^www\./, ""),
      path: decodeURIComponent(url.pathname).replace(/\/+$/, ""),
      query: url.search,
    };
  } catch {
    return null;
  }
}

/** The registrable domain; private suffixes (github.io, blogspot.com) count as their own suffix. */
function site(host: string): string | null {
  return getDomain(host, { allowPrivateDomains: true });
}

/**
 * The home page of a confirmed sender (addendum D8.4 of 2026-10-12):
 * same registrable domain as one of the `senders`, without path and without
 * query. Only the home page, because DMARC alone says that the sender is genuine,
 * not what lies behind a path: a sharing mail from Google is
 * genuine, the shared document behind it can still be phishing.
 */
function senderHome(link: { host: string; path: string; query: string }, senders: readonly string[]): boolean {
  if (link.path !== "" || link.query !== "") return false;
  const wanted = site(link.host);
  return wanted !== null && senders.some((domain) => site(domain) === wanted);
}

/**
 * Which of them are not backed. A link is backed if it points to one of the pages
 * (same host, same path); a query after the path only if it was
 * opened exactly like that. A redirect via `?url=` thus does not
 * become a free pass. Plus the home page of a confirmed sender (`senders`).
 */
export function unbackedLinks(text: string, backed: readonly string[], senders: readonly string[] = []): string[] {
  const known = backed.flatMap((link) => {
    const parsed = normalize(link);
    return parsed ? [parsed] : [];
  });
  return findLinks(text).filter((link) => {
    const parsed = normalize(link);
    if (!parsed) return true;
    if (senderHome(parsed, senders)) return false;
    return !known.some(
      (page) => page.host === parsed.host && page.path === parsed.path && (parsed.query === "" || parsed.query === page.query),
    );
  });
}

/**
 * For the emergency exit that can no longer ask anyone: unbacked links are
 * dropped, and this marker stands in their place. It reaches the owner
 * verbatim (emergency exit, picks), so it comes from the catalog.
 */
export function linkDropped(lang: string = currentLanguage()): string {
  return t(core.linkDropped, undefined, lang);
}

export function dropUnbackedLinks(text: string, backed: readonly string[], senders: readonly string[] = []): string {
  const drop = new Set(unbackedLinks(text, backed, senders));
  if (drop.size === 0) return text;
  const marker = linkDropped();
  // Longest first, so that a shorter link is not replaced inside a longer one.
  return [...drop].sort((a, b) => b.length - a.length).reduce((out, link) => out.split(link).join(marker), text);
}

/**
 * Parameters that only track who came from where (addendum D48 of 2026-10-08).
 * They are dropped before Photon's Mac fetches the page for the preview.
 */
const TRACKING_PARAM =
  /^(?:utm_.*|fbclid|gclid|dclid|gbraid|wbraid|msclkid|mc_cid|mc_eid|_hsenc|_hsmi|igshid|si|yclid|twclid|ttclid|srsltid|ref_src|spm)$/i;

/** The URL without tracking parameters and without anchor. Null if it is not a URL. */
export function stripTracking(link: string): string | null {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAM.test(key)) url.searchParams.delete(key);
  }
  url.hash = "";
  return url.toString();
}

/**
 * Where a link preview may point (addendum D48 of 2026-10-08). Photon's
 * Mac fetches the page for it itself, so only a page that a tool
 * with `opensPages` has already opened in this job: same host without
 * `www.`, same path, same query, both compared without tracking parameters.
 * What comes back is the opened page itself (after redirects,
 * without tracking), never the model's text; only `https` and only public
 * hosts. Otherwise null.
 */
export function previewTarget(link: string, opened: readonly string[]): string | null {
  const wanted = stripTracking(link);
  const want = wanted ? normalize(wanted) : null;
  if (!want) return null;
  for (const page of opened) {
    const clean = stripTracking(page);
    if (!clean || !clean.startsWith("https://") || !checkUrl(clean).ok) continue;
    const have = normalize(clean);
    if (have && have.host === want.host && have.path === want.path && have.query === want.query) return clean;
  }
  return null;
}
