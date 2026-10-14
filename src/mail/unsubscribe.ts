import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import { UNSUBSCRIBE_TIMEOUT_MS } from "../config/limits.js";
import { checkUrl, guardedLookup, type UrlVerdict } from "../executor/netguard.js";

/**
 * Unsubscribing from a bulk mail (D37), in this order:
 *
 * - **One-click (RFC 8058):** `List-Unsubscribe` names an https address and
 *   `List-Unsubscribe-Post` says `List-Unsubscribe=One-Click`. Then a POST with
 *   exactly this body is enough, without a page, without cookies.
 * - **By mail (RFC 2369):** a `mailto:` target.
 * - **Via the unsubscribe page** (addendum D37 of 2026-10-03): an https address
 *   in the header without one-click, or the unsubscribe link in the mail text.
 *   The code looks for the link, never the model; it is opened in the hardened
 *   server browser (`src/browser/unsubscribe.ts`). Never for mails from the
 *   spam folder: there every click only confirms that the address is alive.
 *
 * The target comes from a foreign mail. Hence the same network protection as
 * for the executor (D16): only https, only public addresses, checked at the
 * address that is really connected to. Nobody reads the response: only the
 * status goes back.
 *
 * **Redirects** (live finding 2026-09-21, a parcel service answered 302): 301,
 * 302 and 303 after a POST are the usual pattern "processed, this way to the
 * confirmation page". Serain does not fetch the page; the unsubscription counts
 * as done, but unconfirmed, and that is what the result says. If it is wrong,
 * the next mail brings a new header. 307 and 308 mean "the same POST
 * elsewhere": exactly once, through the same network protection.
 */

export type UnsubscribeRoute =
  | { kind: "one_click"; url: string; host: string }
  | { kind: "mailto"; address: string; subject: string; body: string }
  | { kind: "page"; url: string; host: string };

/** The smaller, the better: without a page before mail to third parties before the browser. */
export const ROUTE_RANK: Record<UnsubscribeRoute["kind"], number> = { one_click: 0, mailto: 1, page: 2 };

type PageRoute = Extract<UnsubscribeRoute, { kind: "page" }>;

function pageRoute(raw: string): PageRoute | null {
  if (!/^https:/i.test(raw)) return null;
  const verdict = checkUrl(raw);
  return verdict.ok && verdict.url.protocol === "https:" ? { kind: "page", url: verdict.url.href, host: verdict.url.hostname } : null;
}

const ADDRESS = /^[^\s@<>,;"']+@[^\s@<>,;"']+\.[a-z]{2,}$/i;

function mailtoRoute(raw: string): UnsubscribeRoute | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  let address: string;
  try {
    address = decodeURIComponent(url.pathname).trim().toLowerCase();
  } catch {
    return null;
  }
  // Exactly one recipient: `mailto:a@x,b@y` would be a mail to someone the preview does not name.
  if (!ADDRESS.test(address)) return null;
  const oneLine = (value: string | null, max: number) => (value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
  return {
    kind: "mailto",
    address,
    subject: oneLine(url.searchParams.get("subject"), 200) || "unsubscribe",
    body: oneLine(url.searchParams.get("body"), 500) || "unsubscribe",
  };
}

/** The best route the headers offer: one-click before mail before the unsubscribe page, otherwise none. */
export function unsubscribeRoute(listUnsubscribe: string, listUnsubscribePost: string): UnsubscribeRoute | null {
  const targets = [...listUnsubscribe.matchAll(/<([^<>\s]+)>/g)].map((match) => match[1] ?? "");
  const oneClick = /^\s*List-Unsubscribe\s*=\s*One-Click\s*$/i.test(listUnsubscribePost);
  if (oneClick) {
    for (const target of targets) {
      if (!/^https:/i.test(target)) continue;
      const verdict = checkUrl(target);
      if (verdict.ok && verdict.url.protocol === "https:") return { kind: "one_click", url: verdict.url.href, host: verdict.url.hostname };
    }
  }
  for (const target of targets) {
    if (!/^mailto:/i.test(target)) continue;
    const route = mailtoRoute(target);
    if (route) return route;
  }
  for (const target of targets) {
    const route = pageRoute(target);
    if (route) return route;
  }
  return null;
}

/** What an unsubscribe link says, in German, English and the neighbouring languages. "subscribe" alone does not match. */
const UNSUBSCRIBE_LABEL =
  /\b(unsubscribe|abmelden|abbestellen|austragen|abmeldung|opt[\s-]?out|d[ée]sabonner|d[ée]sinscri\w*|darse de baja|uitschrijven|afmelden|annulla(re)? l'iscrizione)\b/i;
const PREFERENCES_LABEL = /\b(preferences|pr[ée]f[ée]rences|einstellungen|subscription settings|manage (your )?(e-?mail|subscription)s?)\b/i;
const UNSUBSCRIBE_PATH = /unsub|abmeld|abbestell|opt-?out/i;

/** A numeric character reference from foreign HTML. Outside Unicode it stays as it is, instead of letting `fromCodePoint` throw. */
const codePoint = (match: string, value: number) => (Number.isInteger(value) && value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : match);

const decodeEntities = (value: string) =>
  value
    .replace(/&amp;/gi, "&")
    .replace(/&#x([0-9a-f]+);/gi, (match, hex: string) => codePoint(match, parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (match, dec: string) => codePoint(match, Number(dec)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");

/**
 * The links of a mail like `/<a\b([^>]*)>([\s\S]*?)<\/a>/gi`, but in linear
 * time. The regex searches to the end after every `<a` without `</a>` and
 * starts over at the next one: a mail made of nothing but `<a ` held the
 * process (fuzzing 2026-10-04). If `>` or `</a>` is missing after one start,
 * it is also missing after every later one.
 */
function* anchors(html: string): Generator<{ attributes: string; label: string }> {
  const opening = /<a\b/gi;
  const closing = /<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = opening.exec(html))) {
    const gt = html.indexOf(">", opening.lastIndex);
    if (gt === -1) return;
    closing.lastIndex = gt + 1;
    const end = closing.exec(html);
    if (!end) return;
    yield { attributes: html.slice(opening.lastIndex, gt), label: html.slice(gt + 1, end.index) };
    opening.lastIndex = closing.lastIndex;
  }
}

/**
 * The unsubscribe link in the mail text, found by the link text or the path,
 * never chosen by the model. "Unsubscribe" before "preferences", the path only
 * if the text says nothing (an image, "here"). Only https and only public
 * addresses.
 */
export function unsubscribeLink(html: string): PageRoute | null {
  const candidates: Array<{ route: PageRoute; score: number }> = [];
  for (const anchor of anchors(html)) {
    const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(anchor.attributes);
    const route = pageRoute(decodeEntities((href?.[1] ?? href?.[2] ?? href?.[3] ?? "").trim()));
    if (!route) continue;
    // `[^<>]` instead of `[^>]`: a link text of nothing but `<` without `>` would otherwise be quadratic.
    const label = decodeEntities(anchor.label.replace(/<[^<>]*>/g, " ")).replace(/\s+/g, " ").trim();
    const title = /\b(?:title|aria-label)\s*=\s*"([^"]*)"/i.exec(anchor.attributes)?.[1] ?? "";
    const text = `${label} ${title}`;
    const score = UNSUBSCRIBE_LABEL.test(text)
      ? PREFERENCES_LABEL.test(text) ? 2 : 3
      : UNSUBSCRIBE_PATH.test(new URL(route.url).pathname)
        ? 2
        : PREFERENCES_LABEL.test(text)
          ? 1
          : 0;
    if (score > 0) candidates.push({ route, score });
  }
  // On a tie the last one: the unsubscribe link is in the footer, an "unsubscribe" note at the top of the text is rare.
  return candidates.reduce<{ route: PageRoute; score: number } | null>((best, entry) => (!best || entry.score >= best.score ? entry : best), null)?.route ?? null;
}

export interface OneClickOptions {
  /** Only tests set this: the local test server would otherwise rightly be blocked. */
  lookup?: LookupFunction;
  checkUrl?: (raw: string) => UrlVerdict;
  request?: typeof httpsRequest;
}

export interface OneClickResult {
  /** The server answered with 2xx, or redirected to the confirmation page after the POST. */
  ok: boolean;
  /** Accepted, but not confirmed with 2xx. */
  unconfirmed?: boolean;
  /** Why not, in words that carry no foreign content: a status code or a fixed cause. */
  reason: string;
}

/** Sends the one-click POST. */
export function postOneClick(rawUrl: string, options: OneClickOptions = {}, mayFollow = true): Promise<OneClickResult> {
  const verdict = (options.checkUrl ?? checkUrl)(rawUrl);
  if (!verdict.ok || verdict.url.protocol !== "https:") return Promise.resolve({ ok: false, reason: "address not allowed" });
  const body = "List-Unsubscribe=One-Click";
  return new Promise((resolve) => {
    const req = (options.request ?? httpsRequest)(
      verdict.url,
      {
        method: "POST",
        lookup: options.lookup ?? guardedLookup,
        headers: {
          "user-agent": "Serain/0.1 (personal assistant, unsubscribe per RFC 8058)",
          "content-type": "application/x-www-form-urlencoded",
          "content-length": Buffer.byteLength(body),
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        // The response is foreign content nobody here needs.
        res.resume();
        const location = typeof res.headers.location === "string" ? res.headers.location : "";
        const done = () => {
          if ((status === 307 || status === 308) && mayFollow && location) {
            let next = "";
            try {
              next = new URL(location, verdict.url).href;
            } catch {
              next = "";
            }
            if (next) return void postOneClick(next, options, false).then(resolve);
          }
          if (status === 301 || status === 302 || status === 303) return resolve({ ok: true, unconfirmed: true, reason: `HTTP ${status}` });
          resolve({ ok: status >= 200 && status < 300, reason: `HTTP ${status}` });
        };
        res.on("end", done);
        res.on("error", done);
      },
    );
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      req.destroy(new Error("timeout"));
    }, UNSUBSCRIBE_TIMEOUT_MS);
    req.on("close", () => clearTimeout(timer));
    req.on("error", () => resolve({ ok: false, reason: timedOut ? "no response" : "connection failed" }));
    req.end(body);
  });
}
