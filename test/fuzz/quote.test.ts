import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ConfidentialGuard } from "../../src/security/confidential.js";
import { QUOTE_ASSETS, quoteSpec, readQuote, type QuoteSpec } from "../../src/watch/quote.js";
import type { FetchedPage } from "../../src/executor/fetch.js";
import { CANARY, hostileString, params } from "./helpers.js";

/**
 * Quote watchers (addendum D43 of 2026-10-08) at the trust boundary: the
 * response of Kraken, the ECB and Yahoo is untrusted text. What may get through
 * is a finite number greater than zero, formatted by the code. No text of the
 * source, not in reasons either, and never a throw.
 */

const guard = ConfidentialGuard.from([]);

/** Responses that look like the real ones, with hostile values in every place. */
const hostileValue = fc.oneof(
  hostileString,
  fc.double(),
  fc.integer(),
  fc.constantFrom("72113.4", "0x10", "1e308", "-1", "Infinity", "NaN", "0", "0.00000001", `${CANARY}`),
  fc.constant(null),
  fc.array(hostileString, { maxLength: 3 }),
);

const kraken = fc
  .tuple(fc.array(hostileString, { maxLength: 2 }), hostileString, hostileValue)
  .map(([error, pair, price]) => JSON.stringify({ error, result: { [pair]: { c: [price, "1"] } } }));
const ecb = fc
  .array(fc.tuple(fc.oneof(fc.constantFrom("USD", "JPY", "CHF", "GBP"), hostileString), hostileValue), { maxLength: 6 })
  .map((rates) => `<Cube time='2026-10-08'>${rates.map(([c, r]) => `<Cube currency='${String(c)}' rate='${String(r)}'/>`).join("")}</Cube>`);
const yahoo = fc
  .tuple(hostileValue, hostileValue, hostileValue, hostileValue)
  .map(([price, currency, exchange, name]) => JSON.stringify({ chart: { result: [{ meta: { regularMarketPrice: price, currency, exchangeName: exchange, longName: name, regularMarketTime: price } }] } }));

const body = fc.oneof(kraken, ecb, yahoo, hostileString);

const spec = fc
  .tuple(fc.constantFrom(...QUOTE_ASSETS), fc.constantFrom("BTC", "ETH", "USD", "SAP.DE", "AAPL", "JPY"), fc.constantFrom("EUR", "USD", "JPY"))
  .map(([asset, symbol, currency]) => quoteSpec.safeParse({ asset, symbol, currency, compare: "below", threshold: 1 }))
  .filter((parsed) => parsed.success)
  .map((parsed) => parsed.data as QuoteSpec);

describe("readQuote", () => {
  it("returns only a finite number greater than zero and never text of the source", async () => {
    await fc.assert(
      fc.asyncProperty(spec, body, fc.constantFrom(200, 404, 500), async (quote, text, status) => {
        const page: FetchedPage = { url: "x", status, contentType: "application/json", title: "", text, truncated: false };
        const reading = await readQuote(quote, guard, async () => page);
        const shown = JSON.stringify(reading);
        expect(shown).not.toContain(CANARY);
        if (reading.ok) {
          expect(Number.isFinite(reading.quote.value)).toBe(true);
          expect(reading.quote.value).toBeGreaterThan(0);
          expect(reading.quote.display).toMatch(/^[0-9.,]+ (€|\$|£|[A-Z]{3})$/);
          expect(reading.quote.venue === null || /^[A-Za-z .]{2,12}$/.test(reading.quote.venue)).toBe(true);
        } else {
          expect(reading.reason.length).toBeLessThan(120);
        }
      }),
      params(2_000),
    );
  });

  it("accepts no symbol that could leave the fixed address", () => {
    fc.assert(
      fc.property(fc.constantFrom(...QUOTE_ASSETS), hostileString, (asset, symbol) => {
        const parsed = quoteSpec.safeParse({ asset, symbol, currency: "EUR", compare: "above", threshold: 1 });
        if (parsed.success) expect(parsed.data.symbol).toMatch(/^[A-Z0-9][A-Z0-9.-]{0,13}$/);
      }),
      params(2_000),
    );
  });
});
