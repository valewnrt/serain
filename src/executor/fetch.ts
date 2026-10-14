import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import {
  FETCH_MAX_BYTES,
  FETCH_PDF_MAX_BYTES,
  FETCH_MAX_CHARS,
  FETCH_MAX_REDIRECTS,
  FETCH_TIMEOUT_MS,
  PAGE_FACTS_LD_BLOCK_MAX_CHARS,
  PAGE_FACTS_LD_BLOCKS_MAX,
  PAGE_FACTS_LD_DEPTH_MAX,
  PAGE_FACTS_MAX_CHARS,
} from "../config/limits.js";
import { checkUrl, guardedLookup, type UrlVerdict } from "./netguard.js";

/**
 * Fetch a page and return it as text. Deliberately on `node:http(s)` instead of
 * `fetch`: only here can the DNS resolution be hung on the socket (`lookup`),
 * and only that way does the SSRF protection check the address that is really
 * connected to. No cookies, no credentials, no redirect without a new check.
 */

export interface FetchOptions {
  /** Only tests set this: the local test server would otherwise rightly be blocked. */
  lookup?: LookupFunction;
  checkUrl?: (raw: string) => UrlVerdict;
  /**
   * The body unchanged and uncut, up to `maxBytes`: for a parser in the code
   * that reads data from the page. Never unfiltered to the model.
   */
  raw?: { maxBytes: number };
  /**
   * Reads a PDF to text, in the sandbox (D20). Without it: PDFs are refused.
   * With it: loaded up to `FETCH_PDF_MAX_BYTES`, a truncated PDF is never read.
   */
  readPdf?: (body: Buffer) => Promise<string>;
}

export interface FetchedPage {
  url: string;
  status: number;
  contentType: string;
  title: string;
  text: string;
  truncated: boolean;
  /**
   * PDFs the page links to (only with `readPdf`): the text of a page carries
   * no links, and a menu or price list often only lives there.
   */
  documents?: { url: string; label: string }[];
  /** A PDF that was read, itself and unchanged: Serain can send it to the owner as a file. */
  pdf?: Buffer;
  /**
   * Structured data of an HTML page (`pageFacts`), separate from the text:
   * whoever shows it to the model puts it before the text with `withFacts`,
   * within `FETCH_MAX_CHARS`. Watchers only read the text (D43).
   */
  facts?: string;
}

/** The data before the text, together at most `max` characters. */
export function withFacts(facts: string | undefined, text: string, max = FETCH_MAX_CHARS): { text: string; cut: boolean } {
  const body = facts ? `${facts}\n\n${text}` : text;
  return { text: body.slice(0, max), cut: body.length > max };
}

/**
 * Why a fetch failed, for code that decides by it (whether a watcher retries,
 * how it words the failure). The message is for the model and may change; code
 * never reads it (I18N-SPEC, principle 4).
 *
 * - `timeout`: the page took too long; the only kind without a verdict on the page.
 * - `refused`: the URL check said no (scheme, port, credentials, internal address).
 * - `redirect`: a redirect without a target, or too many.
 * - `unreadable_type`: a content type that is not text; the message carries the
 *   type from the other side's header.
 * - `too_large`: a PDF beyond the limit.
 * - `pdf_unreadable`: the sandbox could not read a PDF.
 */
export type FetchErrorKind = "timeout" | "refused" | "redirect" | "unreadable_type" | "too_large" | "pdf_unreadable" | "other";

export class FetchError extends Error {
  readonly kind: FetchErrorKind;

  constructor(message: string, kind: FetchErrorKind = "other") {
    super(message);
    this.name = "FetchError";
    this.kind = kind;
  }
}

const PDF_ACCEPT = "text/html,text/plain,application/json;q=0.9,application/pdf;q=0.8,*/*;q=0.1";
const READABLE = /^(text\/|application\/(json|xml|xhtml\+xml|rss\+xml|atom\+xml|ld\+json))/i;

interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  truncated: boolean;
}

function requestOnce(
  url: URL,
  lookup: LookupFunction,
  deadline: number,
  maxBytes = FETCH_MAX_BYTES,
  accept = "text/html,text/plain,application/json;q=0.9,*/*;q=0.1",
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = send(
      url,
      {
        method: "GET",
        lookup,
        headers: {
          "user-agent": "Serain/0.1 (personal assistant, one fetch per request)",
          accept,
          "accept-encoding": "identity",
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        const finish = () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
            truncated,
          });
        res.on("data", (chunk: Buffer) => {
          const room = maxBytes - size;
          if (chunk.length > room) {
            // Read enough. The rest is not even collected.
            chunks.push(chunk.subarray(0, room));
            truncated = true;
            res.destroy();
            finish();
            return;
          }
          chunks.push(chunk);
          size += chunk.length;
        });
        res.on("end", finish);
        res.on("error", (error) => (truncated ? undefined : reject(error)));
      },
    );
    const remaining = deadline - Date.now();
    const timer = setTimeout(
      () => req.destroy(new FetchError("The page took too long.", "timeout")),
      Math.max(1, remaining),
    );
    req.on("close", () => clearTimeout(timer));
    req.on("error", reject);
    req.end();
  });
}

function header(headers: RawResponse["headers"], name: string): string {
  const value = headers[name];
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  auml: "ä",
  ouml: "ö",
  uuml: "ü",
  Auml: "Ä",
  Ouml: "Ö",
  Uuml: "Ü",
  szlig: "ß",
  euro: "€",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
    if (code.startsWith("#")) {
      const point = code[1]?.toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(point) && point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : match;
    }
    return ENTITIES[code] ?? match;
  });
}

/**
 * Matches of `/<(names)\b…([\s\S]*?)<\/\1\s*>/gi`, in the same order and
 * with the same bounds, but in linear time. The regex itself searches to the end
 * for every start without a closing tag and starts over at the next start:
 * 400 KB of mail HTML made of nothing but `<script` or `<!--` held the process
 * for over a minute, Photon stream included (fuzzing 2026-10-04). Here each tag
 * name is searched in vain at most once: if the closing tag is missing after one
 * start, it is missing after every later one too.
 *
 * `openTag`: between name and content stands the rest of the opening tag (`[^>]*>`).
 */
function* blocks(html: string, names: string, openTag: boolean): Generator<{ start: number; end: number; inner: string }> {
  const opening = new RegExp(`<(${names})\\b`, "gi");
  const unclosed = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = opening.exec(html))) {
    const name = match[1] ?? "";
    if (unclosed.has(name.toLowerCase())) continue;
    let innerStart = opening.lastIndex;
    if (openTag) {
      const gt = html.indexOf(">", innerStart);
      // Without a `>` after it, no later opening tag closes either.
      if (gt === -1) return;
      innerStart = gt + 1;
    }
    const closing = new RegExp(`<\\/${name}\\s*>`, "gi");
    closing.lastIndex = innerStart;
    const found = closing.exec(html);
    if (!found) {
      unclosed.add(name.toLowerCase());
      continue;
    }
    yield { start: match.index, end: closing.lastIndex, inner: html.slice(innerStart, found.index) };
    opening.lastIndex = closing.lastIndex;
  }
}

/** Like `html.replace(/<(names)\b[\s\S]*?<\/\1\s*>/gi, " ")`, linear (see `blocks`). */
function removeBlocks(html: string, names: string): string {
  const parts: string[] = [];
  let at = 0;
  for (const block of blocks(html, names, false)) {
    parts.push(html.slice(at, block.start), " ");
    at = block.end;
  }
  parts.push(html.slice(at));
  return parts.join("");
}

/** Like `html.replace(/<!--[\s\S]*?-->/g, " ")`, linear: without `-->` after one start, no later one ends either. */
function removeComments(html: string): string {
  const parts: string[] = [];
  let at = 0;
  for (;;) {
    const start = html.indexOf("<!--", at);
    const end = start === -1 ? -1 : html.indexOf("-->", start + 4);
    if (end === -1) break;
    parts.push(html.slice(at, start), " ");
    at = end + 3;
  }
  parts.push(html.slice(at));
  return parts.join("");
}

/** Like `html.replace(/<[^>]+>/g, " ")`, linear: without `>` after a `<`, no later one closes either. */
function removeTags(html: string): string {
  const parts: string[] = [];
  let at = 0;
  let from = 0;
  for (;;) {
    const start = html.indexOf("<", from);
    if (start === -1) break;
    const end = html.indexOf(">", start + 1);
    if (end === -1) break;
    // `<>` is no tag; the next `<` can be one.
    if (end === start + 1) {
      from = start + 1;
      continue;
    }
    parts.push(html.slice(at, start), " ");
    at = from = end + 1;
  }
  parts.push(html.slice(at));
  return parts.join("");
}

/** Like `/<title[^>]*>([\s\S]*?)<\/title>/i`: the first `<title` decides, a later one would have less text ahead of it. */
function titleOf(html: string): string {
  const open = /<title/i.exec(html);
  if (!open) return "";
  const gt = html.indexOf(">", open.index + 6);
  if (gt === -1) return "";
  const closing = /<\/title>/gi;
  closing.lastIndex = gt + 1;
  const found = closing.exec(html);
  return found ? html.slice(gt + 1, found.index) : "";
}

/**
 * The content part of a page: `<main>` or `<article>`, if they exist and carry
 * a noteworthy amount of text. Only 12,000 characters go to the model; in the
 * live test of 2026-09-20 the start of a timetable page consisted of language
 * choice and navigation, and the departure times lay behind the cut.
 */
function mainContent(html: string): string {
  const inner = [...blocks(html, "main|article", true)].map((block) => block.inner);
  const largest = inner.sort((a, b) => b.length - a.length)[0] ?? "";
  return largest.length >= 500 ? largest : html;
}

/** At most this many PDF links per page. */
const MAX_DOCUMENT_LINKS = 12;

/** Links to PDFs, absolute and without duplicates, with the link text. Only http(s). */
export function pdfLinks(html: string, base: URL): { url: string; label: string }[] {
  const found = new Map<string, string>();
  const lower = html.toLowerCase();
  // Linear: first the opening tag (without backtracking beyond `>`), the link text only up to the next
  // `</a`, at most 2,000 characters far. A pattern over the whole element would be quadratic on broken HTML.
  // `{0,2000}`: an `<a` without `>` must not make it search to the end of the page, anew for every `<a`.
  for (const match of html.matchAll(/<a\b[^>]{0,2000}>/gi)) {
    const href = /\bhref\s*=\s*["']([^"'#]+)["']/i.exec(match[0]);
    if (!href) continue;
    let url: URL;
    try {
      url = new URL(decodeEntities(href[1]!), base);
    } catch {
      continue;
    }
    if (!/^https?:$/.test(url.protocol) || !/\.pdf$/i.test(url.pathname) || found.has(url.toString())) continue;
    const start = match.index + match[0].length;
    const close = lower.indexOf("</a", start);
    const inner = html.slice(start, close < 0 ? start : Math.min(close, start + 2_000));
    const label = decodeEntities(removeTags(inner)).replace(/\s+/g, " ").trim().slice(0, 80);
    found.set(url.toString(), label);
    if (found.size >= MAX_DOCUMENT_LINKS) break;
  }
  return [...found].map(([url, label]) => ({ url, label }));
}

/**
 * Structured data of the page, before `htmlToText` throws it away with `script`
 * and `footer`: JSON-LD per schema.org, `tel:` links and footer lines that look
 * like opening hours or contact. For stores, authorities and shops exactly that
 * is where what the page's text often does not say stands: special opening hours
 * on holidays, whether something is sold out, the final price with shipping,
 * whether an event is cancelled.
 *
 * The labels are English (they go to the model); the values stay as the page
 * has them. Recognising footer lines is comfort, not a safety check: it works
 * on pages in English, German and a few more languages, and on any other page
 * the facts are simply missing, the text is still there.
 *
 * Foreign content, hence narrow: at most `PAGE_FACTS_LD_BLOCKS_MAX` blocks of
 * `PAGE_FACTS_LD_BLOCK_MAX_CHARS` each, depth counted before `JSON.parse`, and
 * only fields from an allowlist, each as a short line without control
 * characters. Everything linear (D53): every piece of HTML is searched at most once.
 */
export function pageFacts(html: string): string {
  const entities: string[] = [];
  const phones = new Set<string>();
  for (const block of jsonLdBlocks(html)) {
    const value = parseLd(block);
    if (value === undefined) continue;
    const found: Record<string, unknown>[] = [];
    collectEntities(value, 0, found, { left: LD_NODES_MAX });
    for (const entity of found) {
      const line = entityLine(entity);
      if (!line) continue;
      if (!entities.includes(line.text)) entities.push(line.text);
      for (const phone of line.phones) phones.add(phone);
      if (entities.length >= LD_ENTITIES_MAX) break;
    }
    if (entities.length >= LD_ENTITIES_MAX) break;
  }
  const telLinks = telNumbers(html).filter((phone) => !phones.has(digitsOf(phone)));
  const footer = footerLines(html);

  const sections: string[][] = [];
  if (entities.length > 0) sections.push(["Page data (schema.org):", ...entities.map((line) => `- ${line}`)]);
  if (telLinks.length > 0) sections.push([`Phone numbers on the page: ${telLinks.join(", ")}`]);
  if (footer.length > 0) sections.push(["From the page footer:", ...footer.map((line) => `- ${line}`)]);
  // Up to the limit, line by line: rather one entry fewer than half a one.
  const out: string[] = [];
  let used = 0;
  for (const section of sections) {
    for (const [index, line] of section.entries()) {
      if (used + line.length + 1 > PAGE_FACTS_MAX_CHARS) break;
      // A heading without a line below it is dropped.
      if (index === 0 && section.length > 1 && used + line.length + 1 + (section[1]?.length ?? 0) + 1 > PAGE_FACTS_MAX_CHARS) break;
      out.push(line);
      used += line.length + 1;
    }
  }
  return out.join("\n");
}

/** Objects visited at most in the JSON-LD, and entries that go into the block. */
const LD_NODES_MAX = 400;
const LD_ENTITIES_MAX = 8;
/** Length of a single value. */
const FACT_VALUE_MAX = 120;
/** An opening `<script` tag that is longer carries no JSON-LD, only noise. */
const SCRIPT_TAG_MAX = 2_000;
const LD_TYPE = /\btype\s*=\s*["']?application\/ld\+json/i;

/** The content of every `<script type="application/ld+json">`, linear (see `blocks`): if a `</script>` is missing, it is missing for every later one too. */
function* jsonLdBlocks(html: string): Generator<string> {
  const opening = /<script\b/gi;
  const closing = /<\/script\s*>/gi;
  let yielded = 0;
  let match: RegExpExecArray | null;
  while ((match = opening.exec(html))) {
    const gt = html.indexOf(">", opening.lastIndex);
    if (gt === -1) return;
    closing.lastIndex = gt + 1;
    const end = closing.exec(html);
    if (!end) return;
    opening.lastIndex = closing.lastIndex;
    if (gt - match.index > SCRIPT_TAG_MAX || !LD_TYPE.test(html.slice(match.index, gt + 1))) continue;
    if (end.index - (gt + 1) > PAGE_FACTS_LD_BLOCK_MAX_CHARS) continue;
    yield html.slice(gt + 1, end.index);
    yielded += 1;
    if (yielded >= PAGE_FACTS_LD_BLOCKS_MAX) return;
  }
}

/** Counts the nesting outside of strings, without parsing. */
function nestingWithin(text: string, max: number): boolean {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (inString) {
      if (code === 92) i += 1;
      else if (code === 34) inString = false;
      continue;
    }
    if (code === 34) inString = true;
    else if (code === 123 || code === 91) {
      depth += 1;
      if (depth > max) return false;
    } else if (code === 125 || code === 93) depth -= 1;
  }
  return true;
}

/** JSON-LD to a value; broken, too deep or empty means `undefined`. Some pages wrap it in `<!-- -->` or CDATA. */
function parseLd(block: string): unknown {
  const text = block
    .trim()
    .replace(/^(?:<!--|\/\*\s*<!\[CDATA\[\s*\*\/|<!\[CDATA\[)/, "")
    .replace(/(?:-->|\/\*\s*\]\]>\s*\*\/|\]\]>)$/, "")
    .trim();
  if (!text || !nestingWithin(text, PAGE_FACTS_LD_DEPTH_MAX)) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Fields `entityLine` reads itself; the search for further entries does not descend into them. */
const READ_FIELDS = new Set(["address", "offers", "location", "openingHoursSpecification", "specialOpeningHoursSpecification", "shippingDetails"]);

/** Every object that can be an entry, up to the depth and count of the limit. Order as on the page. */
function collectEntities(value: unknown, depth: number, out: Record<string, unknown>[], budget: { left: number }): void {
  if (depth > PAGE_FACTS_LD_DEPTH_MAX || budget.left <= 0) return;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 50)) collectEntities(item, depth + 1, out, budget);
    return;
  }
  if (!isRecord(value)) return;
  budget.left -= 1;
  out.push(value);
  for (const [key, child] of Object.entries(value)) {
    if (READ_FIELDS.has(key) || typeof child !== "object" || child === null) continue;
    collectEntities(child, depth + 1, out, budget);
  }
}

/** A value as a short line: entities resolved, without control, direction and separator characters, without angle brackets. */
function factText(value: unknown, max = FACT_VALUE_MAX): string {
  const raw = typeof value === "string" ? value : typeof value === "number" && Number.isFinite(value) ? String(value) : "";
  if (!raw) return "";
  return decodeEntities(raw.slice(0, max * 4))
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff<>]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/** A value or a list of them, at most `limit` items. */
function many(value: unknown, limit: number): unknown[] {
  return (Array.isArray(value) ? value : value === undefined ? [] : [value]).slice(0, limit);
}

/** The last part of a schema.org value ("https://schema.org/InStock" → "InStock"), letters only. */
function schemaToken(value: unknown): string {
  if (typeof value !== "string") return "";
  const token = value.trim().slice(0, 200).split(/[/#:]/).at(-1) ?? "";
  return /^[A-Za-z]{2,40}$/.test(token) ? token : "";
}

const AVAILABILITY: Record<string, string> = {
  InStock: "in stock",
  InStoreOnly: "in store only",
  OnlineOnly: "online only",
  LimitedAvailability: "limited availability",
  OutOfStock: "out of stock",
  SoldOut: "sold out",
  PreOrder: "pre-order",
  PreSale: "presale",
  BackOrder: "back order",
  Discontinued: "discontinued",
  Reserved: "reserved",
};

const EVENT_STATUS: Record<string, string> = {
  EventScheduled: "scheduled",
  EventCancelled: "cancelled",
  EventPostponed: "postponed",
  EventRescheduled: "rescheduled",
  EventMovedOnline: "online instead of on site",
};

/** schema.org day names (and their two-letter forms) as short English labels for the model. */
const WEEKDAYS: Record<string, string> = {
  monday: "Mon", tuesday: "Tue", wednesday: "Wed", thursday: "Thu", friday: "Fri", saturday: "Sat", sunday: "Sun",
  publicholidays: "public holidays",
  mo: "Mon", tu: "Tue", we: "Wed", th: "Thu", fr: "Fri", sa: "Sat", su: "Sun",
};

function weekday(value: unknown): string {
  const token = schemaToken(value);
  return token ? (WEEKDAYS[token.toLowerCase()] ?? token) : "";
}

/** "09:00" from "09:00:00" or "09:00+02:00". */
function clock(value: unknown): string {
  return typeof value === "string" ? (/^\s*(\d{1,2}:\d{2})/.exec(value)?.[1] ?? "") : "";
}

/** "2026-12-24" from a date or point in time. */
function isoDay(value: unknown): string {
  return typeof value === "string" ? (/^\s*(\d{4}-\d{2}-\d{2})/.exec(value)?.[1] ?? "") : "";
}

/** An `OpeningHoursSpecification` as "Mon, Tue 09:00-18:00"; the same opening and closing time means closed per schema.org. */
function hoursSpec(spec: unknown, special: boolean): string {
  if (!isRecord(spec)) return "";
  const days = many(spec["dayOfWeek"], 8).map(weekday).filter(Boolean).join(", ");
  const opens = clock(spec["opens"]);
  const closes = clock(spec["closes"]);
  const time = opens && closes ? (opens === closes ? "closed" : `${opens}-${closes}`) : "";
  const from = isoDay(spec["validFrom"]);
  const through = isoDay(spec["validThrough"]);
  const valid = from ? (through && through !== from ? `${from} to ${through}` : from) : through ? `until ${through}` : "";
  const when = special ? [valid, days].filter(Boolean).join(" ") : [days, valid ? `(${valid})` : ""].filter(Boolean).join(" ");
  if (!time && !when) return "";
  return [when, time || "time not given"].filter(Boolean).join(" ");
}

function addressText(value: unknown): string {
  if (typeof value === "string") return factText(value);
  if (!isRecord(value)) return "";
  const place = [factText(value["postalCode"], 12), factText(value["addressLocality"], 60)].filter(Boolean).join(" ");
  return [factText(value["streetAddress"], 80), place].filter(Boolean).join(", ");
}

/** `QuantitativeValue` with `minValue`/`maxValue` as days. */
function dayRange(value: unknown): [number, number] | null {
  if (!isRecord(value)) return null;
  const min = Number(value["minValue"]);
  const max = Number(value["maxValue"] ?? value["minValue"]);
  if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max < min || max > 365) return null;
  return [min, max];
}

/** Shipping roughly: cost and delivery time in days. */
function shippingText(value: unknown): string {
  const details = many(value, 2).find(isRecord);
  if (!details) return "";
  const rateValue = details["shippingRate"];
  const rate = isRecord(rateValue) ? rateValue : null;
  const cost = rate ? [factText(rate["value"], 20), currency(rate["currency"])].filter(Boolean).join(" ") : "";
  const timeValue = details["deliveryTime"];
  const time = isRecord(timeValue) ? timeValue : null;
  const handling = time ? dayRange(time["handlingTime"]) : null;
  const transit = time ? dayRange(time["transitTime"]) : null;
  const total = handling || transit ? [(handling?.[0] ?? 0) + (transit?.[0] ?? 0), (handling?.[1] ?? 0) + (transit?.[1] ?? 0)] : null;
  const days = total ? (total[0] === total[1] ? `${total[0]} ${total[0] === 1 ? "day" : "days"}` : `${total[0]} to ${total[1]} days`) : "";
  return [cost ? `shipping ${cost}` : "", days ? `delivery ${days}` : ""].filter(Boolean).join(", ");
}

function currency(value: unknown): string {
  return typeof value === "string" && /^[A-Za-z]{3}$/.test(value.trim()) ? value.trim().toUpperCase() : "";
}

function offerText(value: unknown): string {
  if (!isRecord(value)) return "";
  const price = [factText(value["price"], 20), currency(value["priceCurrency"])].filter(Boolean).join(" ");
  const availability = schemaToken(value["availability"]);
  return [
    price ? `price ${price}` : "",
    availability ? (AVAILABILITY[availability] ?? availability) : "",
    shippingText(value["shippingDetails"]),
  ]
    .filter(Boolean)
    .join(", ");
}

function digitsOf(phone: string): string {
  return phone.replace(/\D/g, "");
}

/** A phone number as it stands, only with digits and the usual separators; none below six digits. */
function phoneText(value: unknown): string {
  const text = factText(value, 40).replace(/[^\d+ ()/.-]/g, "").replace(/\s+/g, " ").trim();
  return digitsOf(text).length >= 6 ? text : "";
}

/** An entry as a line, only from allowed fields. Without any data besides the name: no line. */
function entityLine(entity: Record<string, unknown>): { text: string; phones: string[] } | null {
  const parts: string[] = [];
  const phones: string[] = [];
  const hours = many(entity["openingHours"], 7).map((value) => factText(value, 60)).filter(Boolean);
  if (hours.length > 0) parts.push(`Opening hours ${hours.join("; ")}`);
  const specs = many(entity["openingHoursSpecification"], 10).map((spec) => hoursSpec(spec, false)).filter(Boolean);
  if (specs.length > 0) parts.push(`Opening hours ${specs.join("; ")}`);
  const special = many(entity["specialOpeningHoursSpecification"], 10).map((spec) => hoursSpec(spec, true)).filter(Boolean);
  if (special.length > 0) parts.push(`Special opening hours ${special.join("; ")}`);
  const phone = phoneText(entity["telephone"]);
  if (phone) {
    parts.push(`Phone ${phone}`);
    phones.push(digitsOf(phone));
  }
  const address = many(entity["address"], 2).map(addressText).filter(Boolean);
  if (address.length > 0) parts.push(`Address ${address.join("; ")}`);
  const offers = many(entity["offers"], 5).map(offerText).filter(Boolean);
  if (offers.length > 0) parts.push(`Offer ${offers.join("; ")}`);
  const start = factText(entity["startDate"], 30);
  if (start) {
    const end = factText(entity["endDate"], 30);
    const status = schemaToken(entity["eventStatus"]);
    const place = many(entity["location"], 2)
      .map((location) => (isRecord(location) ? factText(location["name"], 80) : ""))
      .filter(Boolean)
      .join("; ");
    parts.push(
      [`Event ${end ? `${start} to ${end}` : start}`, status ? (EVENT_STATUS[status] ?? status) : "", place ? `location ${place}` : ""].filter(Boolean).join(", "),
    );
  }
  if (parts.length === 0) return null;
  const name = factText(entity["name"], 80);
  const type = schemaToken(many(entity["@type"], 1)[0]);
  const label = name ? (type ? `${name} (${type})` : name) : type;
  return { text: `${label ? `${label}: ` : ""}${parts.join(" | ")}`, phones };
}

/** `tel:` links of the page, at most three, without duplicates. A link dials a number, it carries no text. */
function telNumbers(html: string): string[] {
  const found = new Map<string, string>();
  for (const match of html.matchAll(/href\s*=\s*["']\s*tel:([^"'<>]{3,40})["']/gi)) {
    let raw = match[1] ?? "";
    try {
      raw = decodeURIComponent(raw);
    } catch {
      // Broken encoding: as it stands.
    }
    const phone = phoneText(raw);
    if (phone && !found.has(digitsOf(phone))) found.set(digitsOf(phone), phone);
    if (found.size >= 3) break;
  }
  return [...found.values()];
}

const FOOTERS_MAX = 3;
const FOOTER_SCAN_MAX = 30_000;
const FOOTER_LINES_MAX = 6;
const FOOTER_LINE_MAX = 160;
/**
 * Day names with a clock time after them, in German, English, French, Spanish
 * and Dutch (whole words, so "mon" never matches inside "money"). Abbreviations
 * only where they are unambiguous enough in a footer (de, en).
 */
const HOURS_DAYS = [
  // German
  "mo", "di", "mi", "do", "fr", "sa", "so", "montags?", "dienstags?", "mittwochs?", "donnerstags?", "freitags?", "samstags?", "sonntags?", "werktags", "feiertags?",
  // English
  "mon", "tue", "wed", "thu", "fri", "sat", "sun", "mondays?", "tuesdays?", "wednesdays?", "thursdays?", "fridays?", "saturdays?", "sundays?", "weekdays", "holidays?",
  // French, Spanish, Dutch
  "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche",
  "lunes", "martes", "miércoles", "jueves", "viernes", "sábados?", "domingos?",
  "maandag", "dinsdag", "woensdag", "donderdag", "vrijdag", "zaterdag", "zondag",
].join("|");
/** Words that only stand next to opening hours, as parts of words ("Öffnungszeiten", "horaires"). */
const HOURS_WORDS = [
  "öffnungszeit", "geöffnet", "geschlossen", "ruhetag", "betriebsurlaub", "betriebsferien", "sprechzeit",
  "opening hours", "opening times", "business hours", "office hours", "closed on",
  "horaires", "horario", "orari di apertura", "openingstijden", "godziny otwarcia", "çalışma saatleri",
].join("|");
/**
 * A day name with a clock time within 40 characters after it ("Sa 10:00", "Monday 9am", "lundi 9h00"), or a
 * word that only stands next to opening hours. Bounded and without nested repetition, so linear (D53).
 */
const HOURS_LINE = new RegExp(`\\b(?:${HOURS_DAYS})(?![\\p{L}])[^\\n]{0,40}?\\d{1,2}(?:[:.h]\\d{2}|\\s*(?:uhr|h|am|pm)\\b)|${HOURS_WORDS}`, "iu");
/** Phone number, mail address, or a five-digit postcode with a place name (in any script). */
const CONTACT_LINE = /(?:\+\d|\b0\d)[\d /().-]{4,24}\d|[\w.+-]{1,64}@[\w-]{1,63}\.[a-z]{2,12}\b|\b\d{5} \p{L}{2}/iu;

/** Lines from the footers that look like opening hours or contact. */
function footerLines(html: string): string[] {
  const lines: string[] = [];
  let footers = 0;
  for (const block of blocks(html, "footer", true)) {
    footers += 1;
    const text = decodeEntities(
      removeTags(
        removeBlocks(removeComments(block.inner.slice(0, FOOTER_SCAN_MAX)), "script|style|noscript|svg|template|iframe").replace(
          /<\/(p|div|li|tr|td|dd|dt|span|address|h[1-6])\s*>|<br\s*\/?>/gi,
          "\n",
        ),
      ),
    );
    for (const raw of text.split("\n")) {
      const line = factText(raw, 300);
      if (line.length < 5 || !(HOURS_LINE.test(line) || CONTACT_LINE.test(line))) continue;
      const short = line.slice(0, FOOTER_LINE_MAX);
      if (!lines.includes(short)) lines.push(short);
      if (lines.length >= FOOTER_LINES_MAX) return lines;
    }
    if (footers >= FOOTERS_MAX) break;
  }
  return lines;
}

export function htmlToText(html: string): { title: string; text: string } {
  const title = decodeEntities(titleOf(html))
    .replace(/\s+/g, " ")
    .trim();
  const text = decodeEntities(
    removeTags(
      removeBlocks(
        removeBlocks(removeComments(mainContent(html)), "script|style|noscript|svg|head|template|iframe"),
        // Scaffolding of the page, no content: menus, footers, forms, select lists.
        "nav|footer|header|aside|form|select|button",
      ).replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote|pre)\s*>|<br\s*\/?>/gi, "\n"),
    ),
  )
    .replace(/[ \t\f\v ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title, text };
}

export async function fetchPage(rawUrl: string, options: FetchOptions = {}): Promise<FetchedPage> {
  const lookup = options.lookup ?? guardedLookup;
  const check = options.checkUrl ?? checkUrl;
  const deadline = Date.now() + FETCH_TIMEOUT_MS;

  let current = rawUrl;
  for (let hop = 0; hop <= FETCH_MAX_REDIRECTS; hop += 1) {
    // Every hop is checked, not only the first: a public page must not
    // redirect to 169.254.169.254.
    const verdict = check(current);
    if (!verdict.ok) throw new FetchError(verdict.reason, "refused");

    const maxBytes = options.raw?.maxBytes ?? (options.readPdf ? FETCH_PDF_MAX_BYTES : undefined);
    const response = await requestOnce(verdict.url, lookup, deadline, maxBytes, options.readPdf ? PDF_ACCEPT : undefined);
    if (response.status >= 300 && response.status < 400) {
      const location = header(response.headers, "location");
      if (!location) throw new FetchError(`Redirect without a target (status ${response.status}).`, "redirect");
      current = new URL(location, verdict.url).toString();
      continue;
    }

    const contentType = header(response.headers, "content-type").split(";")[0]?.trim() ?? "";
    const isPdf = /^application\/(pdf|x-pdf)$/i.test(contentType) || response.body.subarray(0, 5).toString("latin1") === "%PDF-";
    if (isPdf && options.readPdf) {
      if (response.truncated) throw new FetchError(`The PDF is larger than ${Math.round(FETCH_PDF_MAX_BYTES / 1_000_000)} MB.`, "too_large");
      const text = (await options.readPdf(response.body)).trim();
      return {
        url: verdict.url.toString(),
        status: response.status,
        contentType: "application/pdf",
        title: "",
        text: text.slice(0, FETCH_MAX_CHARS),
        truncated: text.length > FETCH_MAX_CHARS,
        pdf: response.body,
      };
    }
    if (contentType && !READABLE.test(contentType)) {
      throw new FetchError(`Cannot read content type ${contentType}.`, "unreadable_type");
    }
    // The 20 MB only apply to a PDF; everything else stays at FETCH_MAX_BYTES (review 2026-10-09).
    if (!isPdf && options.readPdf && !options.raw && response.body.length > FETCH_MAX_BYTES) {
      response.body = response.body.subarray(0, FETCH_MAX_BYTES);
      response.truncated = true;
    }
    const raw = response.body.toString("utf8");
    if (options.raw) {
      return { url: verdict.url.toString(), status: response.status, contentType, title: "", text: raw, truncated: response.truncated };
    }
    const isHtml = /html/i.test(contentType) || /^\s*<(!doctype|html)/i.test(raw);
    const { title, text } = isHtml ? htmlToText(raw) : { title: "", text: raw.trim() };
    const documents = isHtml && options.readPdf ? pdfLinks(raw, verdict.url) : [];
    const facts = isHtml ? pageFacts(raw) : "";
    return {
      url: verdict.url.toString(),
      status: response.status,
      contentType,
      title,
      text: text.slice(0, FETCH_MAX_CHARS),
      truncated: response.truncated || text.length > FETCH_MAX_CHARS,
      ...(documents.length > 0 ? { documents } : {}),
      ...(facts ? { facts } : {}),
    };
  }
  throw new FetchError("Too many redirects.", "redirect");
}
