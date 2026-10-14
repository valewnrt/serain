import { z } from "zod";
import { describeKinds, type ConfidentialGuard } from "../security/confidential.js";
import { formatWallDay, formatWallTime } from "../time.js";
import { VALUE_LOCALE } from "./extract.js";
import { describeFetchError, isTransientFetchError, isTransientStatus, type PageFetcher } from "./read.js";

/**
 * Quote watchers (addendum D43 of 2026-10-08): crypto, currencies and stocks
 * through exactly one fixed source per class. No page, no anchor, no address
 * from the model: it names class, symbol and currency, a narrow regex checks
 * the symbol, host and path are fixed here. The code reads the value from fixed
 * fields of the response; no text of the source reaches the model, not even a
 * company name. What a source can steer this way is a number.
 *
 * - Crypto: Kraken, public REST API (documented, no key), price of the last trade.
 * - Currencies: ECB reference rates (official), once per working day around 16:00 CET; cross rates via the euro.
 * - Stocks and ETFs: Yahoo's chart endpoint, unofficial (decision of 2026-10-08: better that than no stocks).
 *   Fetched with Serain's honest user agent, no disguise; if Yahoo blocks it, the watcher fails.
 */

export const QUOTE_ASSETS = ["crypto", "fx", "stock"] as const;
export type QuoteAsset = (typeof QUOTE_ASSETS)[number];

const SYMBOL: Record<QuoteAsset, RegExp> = {
  crypto: /^[A-Z0-9]{2,10}$/,
  fx: /^[A-Z]{3}$/,
  // AAPL, SAP.DE, VWCE.DE, BRK-B
  stock: /^[A-Z0-9][A-Z0-9-]{0,9}(\.[A-Z]{1,3})?$/,
};

export const quoteSpec = z
  .object({
    asset: z.enum(QUOTE_ASSETS),
    symbol: z.string().trim().toUpperCase().max(14),
    currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, "currency as ISO code, e.g. EUR"),
    compare: z.enum(["below", "above"]),
    threshold: z.number().finite().positive(),
  })
  .strict()
  .refine((spec) => SYMBOL[spec.asset].test(spec.symbol), { message: "symbol does not fit the asset class", path: ["symbol"] })
  .refine((spec) => spec.asset !== "crypto" || spec.currency === "EUR" || spec.currency === "USD", {
    message: "crypto only in EUR or USD",
    path: ["currency"],
  })
  .refine((spec) => spec.asset !== "fx" || spec.symbol !== spec.currency, { message: "two different currencies", path: ["currency"] });

export type QuoteSpec = z.infer<typeof quoteSpec>;

/** The name of the source in sentences for the model. Fixed, never from the response. */
export const QUOTE_SOURCE: Record<QuoteAsset, string> = {
  crypto: "Kraken",
  fx: "ECB reference rate",
  stock: "Yahoo Finance, unofficial",
};

/** How often to look. The ECB changes its rate once per working day. */
export const QUOTE_INTERVAL_MS: Record<QuoteAsset, number> = {
  crypto: 10 * 60_000,
  fx: 60 * 60_000,
  stock: 10 * 60_000,
};

/** A first hit only counts when a second fetch this much later confirms it. */
export const QUOTE_CONFIRM_MS = 2 * 60_000;

/** The address, built from fixed parts and the checked symbol. */
export function quoteUrl(spec: Pick<QuoteSpec, "asset" | "symbol" | "currency">): string {
  switch (spec.asset) {
    case "crypto": {
      // Kraken lists bitcoin as XBT.
      const base = spec.symbol === "BTC" ? "XBT" : spec.symbol;
      return `https://api.kraken.com/0/public/Ticker?pair=${encodeURIComponent(`${base}${spec.currency}`)}`;
    }
    case "fx":
      return "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml";
    case "stock":
      return `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(spec.symbol)}?interval=1d&range=1d`;
  }
}

export interface Quote {
  value: number;
  /** "72,113.00 €", formatted by the code. */
  display: string;
  /** Time of the price according to the source, else null. */
  asOf: string | null;
  /** Exchange for stocks, from a fixed list or as a code of capital letters. */
  venue: string | null;
}

export type QuoteReading =
  | { ok: true; quote: Quote }
  | {
      ok: false;
      reason: string;
      /** A second attempt changes nothing: unknown symbol, wrong currency, confidential value. */
      final: boolean;
      /** The source is disrupted (network, timeout, 5xx, 429, Kraken's service errors), not wrong. */
      transient?: true;
    };

const DECIMAL = /^\d{1,15}(\.\d{1,12})?$/;

/** A decimal number from a string of the source, only finite and greater than zero. */
function decimal(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) && raw > 0 ? raw : null;
  if (typeof raw !== "string" || !DECIMAL.test(raw)) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

const CURRENCY_SIGN: Record<string, string> = { EUR: "€", USD: "$", GBP: "£" };

/** Formatted for the model like `formatValue`, with as many decimals as the size needs. */
export function formatQuote(value: number, currency: string, asset: QuoteAsset): string {
  const decimals = asset === "fx" ? 4 : value >= 1 ? 2 : value >= 0.01 ? 4 : 8;
  const number = new Intl.NumberFormat(VALUE_LOCALE, { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(value);
  return `${number} ${CURRENCY_SIGN[currency] ?? currency}`;
}

/** Where the price comes from, as a half sentence. */
const QUOTE_HIT_SOURCE: Record<QuoteAsset, string> = {
  crypto: "on Kraken",
  fx: "according to the ECB",
  stock: "on Yahoo",
};

/** "72,057.00 €" → "72,057 €": round numbers without zeros after the decimal point. */
function withoutZeroDecimals(display: string): string {
  return display.replace(/\.0+(?=\s|$)/, "");
}

/**
 * The sentence for a quote hit (style round, addendum D23 of 2026-10-08):
 * symbol, threshold, price and source come from the code, the model takes it
 * over in the owner's language.
 * "BTC is above 72,057 €: 72,664.30 € on Kraken, read twice."
 */
export function quoteHitSentence(spec: Pick<QuoteSpec, "asset" | "symbol" | "currency" | "compare" | "threshold">, current: string): string {
  const threshold = withoutZeroDecimals(formatQuote(spec.threshold, spec.currency, spec.asset));
  return `${spec.symbol} is ${spec.compare} ${threshold}: ${withoutZeroDecimals(current)} ${QUOTE_HIT_SOURCE[spec.asset]}, read twice.`;
}

/** Yahoo's codes of the common exchanges. Others appear only as a code of capital letters. */
const VENUES: Record<string, string> = {
  GER: "Xetra",
  FRA: "Frankfurt",
  STU: "Stuttgart",
  MUN: "Munich",
  NMS: "Nasdaq",
  NGM: "Nasdaq",
  NCM: "Nasdaq",
  NYQ: "NYSE",
  PCX: "NYSE Arca",
  LSE: "London",
  PAR: "Paris",
  AMS: "Amsterdam",
  EBS: "SIX Zurich",
  MIL: "Milan",
  VIE: "Vienna",
};

function venue(code: unknown): string | null {
  if (typeof code !== "string") return null;
  return VENUES[code] ?? (/^[A-Z]{2,4}$/.test(code) ? code : null);
}

function json(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const KRAKEN_TRANSIENT = /^(EService:|EAPI:Rate limit|EGeneral:(Internal error|Temporary lockout|Too many requests))/;

function readKraken(text: string, spec: QuoteSpec): QuoteReading {
  const body = record(json(text));
  if (!body) return { ok: false, final: false, reason: "Kraken's response is unreadable" };
  if (Array.isArray(body["error"]) && body["error"].length > 0) {
    // The error text of the other side does not pass through, only whether the pair is unknown.
    const errors = body["error"].filter((entry): entry is string => typeof entry === "string");
    if (errors.some((entry) => entry.includes("Unknown asset pair"))) {
      return { ok: false, final: true, reason: `Kraken does not know ${spec.symbol} in ${spec.currency}` };
    }
    // Kraken's errors for "not right now": service unavailable or overloaded, rate limit, internal error.
    const transient = errors.length > 0 && errors.every((entry) => KRAKEN_TRANSIENT.test(entry));
    return { ok: false, final: false, reason: "Kraken reports an error", ...(transient ? { transient: true as const } : {}) };
  }
  const result = record(body["result"]);
  const pairs = result ? Object.values(result) : [];
  if (pairs.length !== 1) return { ok: false, final: false, reason: "Kraken's response is unreadable" };
  const last = record(pairs[0])?.["c"];
  const value = Array.isArray(last) ? decimal(last[0]) : null;
  if (value === null) return { ok: false, final: false, reason: "Kraken returns no price" };
  return { ok: true, quote: { value, display: formatQuote(value, spec.currency, "crypto"), asOf: null, venue: null } };
}

/** Euro reference rates: how much of a currency one euro buys. */
export function ecbRates(xml: string): { day: string | null; rates: Map<string, number> } {
  const rates = new Map<string, number>([["EUR", 1]]);
  for (const match of xml.matchAll(/<Cube\s+currency=['"]([A-Z]{3})['"]\s+rate=['"]([0-9.]{1,20})['"]\s*\/>/g)) {
    const rate = decimal(match[2]);
    if (match[1] && rate !== null) rates.set(match[1], rate);
  }
  const day = /<Cube\s+time=['"](\d{4}-\d{2}-\d{2})['"]/.exec(xml)?.[1] ?? null;
  return { day, rates };
}

function readEcb(text: string, spec: QuoteSpec): QuoteReading {
  const { day, rates } = ecbRates(text);
  if (rates.size < 2) return { ok: false, final: false, reason: "the ECB returns no rates" };
  const base = rates.get(spec.symbol);
  const quote = rates.get(spec.currency);
  if (base === undefined || quote === undefined) {
    const missing = base === undefined ? spec.symbol : spec.currency;
    return { ok: false, final: true, reason: `the ECB has no rate for ${missing}` };
  }
  // 1 unit of `symbol` in `currency`: via the euro, since the ECB quotes everything per euro.
  const value = quote / base;
  const asOf = day ? new Date(`${day}T14:15:00Z`).toISOString() : null;
  return { ok: true, quote: { value, display: formatQuote(value, spec.currency, "fx"), asOf, venue: null } };
}

function readYahoo(text: string, spec: QuoteSpec): QuoteReading {
  const chart = record(record(json(text))?.["chart"]);
  if (!chart) return { ok: false, final: false, reason: "Yahoo's response is unreadable" };
  const results = chart["result"];
  if (!Array.isArray(results) || results.length === 0) {
    return chart["error"] ? { ok: false, final: true, reason: `Yahoo does not know ${spec.symbol}` } : { ok: false, final: false, reason: "Yahoo returns no price" };
  }
  const meta = record(record(results[0])?.["meta"]);
  const value = decimal(meta?.["regularMarketPrice"]);
  if (!meta || value === null) return { ok: false, final: false, reason: "Yahoo returns no price" };
  const currency = typeof meta["currency"] === "string" && /^[A-Z]{3}$/.test(meta["currency"]) ? meta["currency"] : null;
  if (!currency) return { ok: false, final: true, reason: `${spec.symbol} is quoted in a currency I cannot read` };
  if (currency !== spec.currency) return { ok: false, final: true, reason: `${spec.symbol} is quoted in ${currency}, not in ${spec.currency}` };
  const time = meta["regularMarketTime"];
  const asOf = typeof time === "number" && Number.isFinite(time) && time > 0 ? new Date(time * 1_000).toISOString() : null;
  return { ok: true, quote: { value, display: formatQuote(value, currency, "stock"), asOf, venue: venue(meta["exchangeName"]) } };
}

/**
 * Reads a price. Fetched through the protected fetch (D16); before that the
 * protection of confidential values checks the address (D29), fail closed.
 * Reasons are in our own words, never with text of the other side.
 */
export async function readQuote(spec: QuoteSpec, guard: ConfidentialGuard, fetcher: PageFetcher): Promise<QuoteReading> {
  const url = quoteUrl(spec);
  const leaks = guard.check(url);
  if (leaks.length > 0) return { ok: false, final: true, reason: `the symbol contains ${describeKinds(leaks)} from memory` };
  let text: string;
  try {
    const page = await fetcher(url);
    if (page.status === 404 && spec.asset === "stock") return { ok: false, final: true, reason: `Yahoo does not know ${spec.symbol}` };
    if (page.status >= 400) {
      return {
        ok: false,
        final: false,
        reason: `${QUOTE_SOURCE[spec.asset]} answers with status ${page.status}`,
        ...(isTransientStatus(page.status) ? { transient: true as const } : {}),
      };
    }
    text = page.text;
  } catch (error) {
    return { ok: false, final: false, reason: describeFetchError(error), ...(isTransientFetchError(error) ? { transient: true as const } : {}) };
  }
  switch (spec.asset) {
    case "crypto":
      return readKraken(text, spec);
    case "fx":
      return readEcb(text, spec);
    case "stock":
      return readYahoo(text, spec);
  }
}

/** "BTC in EUR (Kraken)", for the overview, the header and the result. */
export function quoteTarget(spec: Pick<QuoteSpec, "asset" | "symbol" | "currency">): string {
  return `${spec.symbol} in ${spec.currency} (${QUOTE_SOURCE[spec.asset]})`;
}

/** Time and exchange of a price, as a half sentence for the model. */
export function quoteStand(quote: Quote, asset: QuoteAsset): string {
  const asOf = quote.asOf ? new Date(quote.asOf) : null;
  const parts = [quote.venue, asOf ? (asset === "fx" ? `daily rate of ${formatWallDay(asOf)}` : `as of ${formatWallTime(asOf)}`) : null];
  return parts.filter(Boolean).join(", ");
}
