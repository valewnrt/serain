import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { pageFacts } from "../../src/executor/fetch.js";
import { PAGE_FACTS_LD_BLOCK_MAX_CHARS, PAGE_FACTS_MAX_CHARS } from "../../src/config/limits.js";
import { CANARY, FUZZ_TIMEOUT_MS, hostileString, jsonFrom, params, timed } from "./helpers.js";

/**
 * Structured data of foreign pages (`pageFacts`, JSON-LD, `tel:`, footer).
 * Four questions: does it throw, does it grow arbitrarily large or slow, and does
 * anything get through that is not on the allowlist? The last one is the boundary:
 * a page can write whatever it wants in `description` or `review`, and that must
 * not stand before the text as "page data".
 */

/** Fields `pageFacts` may read, and their subfields. */
const ALLOWED = [
  "name", "openingHours", "openingHoursSpecification", "specialOpeningHoursSpecification", "dayOfWeek", "opens", "closes",
  "validFrom", "validThrough", "telephone", "address", "streetAddress", "postalCode", "addressLocality", "offers", "price",
  "priceCurrency", "availability", "shippingDetails", "shippingRate", "value", "currency", "deliveryTime", "handlingTime",
  "transitTime", "minValue", "maxValue", "startDate", "endDate", "eventStatus", "location", "@type", "@graph", "@context",
];
/** Fields that occur on real pages and must never get through. */
const FORBIDDEN = [
  "description", "review", "reviewBody", "sameAs", "url", "image", "email", "author", "aggregateRating", "brand", "sku",
  "keywords", "articleBody", "text", "headline", "potentialAction", "logo", "alternateName", "disambiguatingDescription", "slogan",
];

const ld = (json: string) => `<script type="application/ld+json">${json}</script>`;

/** A value for an allowed field: hostile, but without the canary. */
const allowedLeaf = fc.oneof(
  hostileString.map((text) => text.split(CANARY).join("")),
  fc.constantFrom("09:00", "18:00:00", "2026-12-24", "https://schema.org/SoldOut", "https://schema.org/Monday", "EUR", "49.99", "+49 1234 000000"),
  fc.integer(),
  fc.double(),
  fc.constant(null),
);

/**
 * JSON-LD in which every forbidden field carries the canary, at every depth, and
 * the allowed fields carry arbitrary values. An object under a forbidden field
 * may itself have allowed fields: no canary stands there then.
 */
const taggedJson: fc.Arbitrary<unknown> = fc.letrec<{ node: unknown }>((tie) => ({
  node: fc.oneof(
    { depthSize: "small", withCrossShrink: true },
    allowedLeaf,
    fc.array(tie("node"), { maxLength: 5 }),
    fc
      .tuple(
        fc.dictionary(fc.constantFrom(...ALLOWED), tie("node"), { maxKeys: 6 }),
        fc.dictionary(fc.constantFrom(...FORBIDDEN), fc.oneof(fc.constant(CANARY), fc.string({ maxLength: 10 }).map((s) => `${s}${CANARY}`)), { maxKeys: 4 }),
      )
      .map(([allowed, forbidden]) => ({ ...allowed, ...forbidden })),
  ),
})).node;

/** What a page writes around the blocks. */
const surround = fc.constantFrom("", "<html><head>", "</head><body><main>Text</main>", "<footer><p>Mo-Fr 09:00-18:00</p></footer>", '<a href="tel:+49 1234 000000">', "<script>var a = 1;</script>");

function wellFormed(facts: string): void {
  expect(facts.length).toBeLessThanOrEqual(PAGE_FACTS_MAX_CHARS);
  // Nothing with which a page influences the frame or the rendering.
  expect(facts).not.toMatch(/[<>\u0000-\u0009\u000b-\u001f\u007f\u2028\u2029\u202a-\u202e\u2066-\u2069]/);
}

describe("pageFacts: hostile JSON-LD", () => {
  it(
    "lets only allowed fields through, at every depth, and stays bounded",
    () => {
      fc.assert(
        fc.property(fc.array(fc.tuple(surround, taggedJson), { minLength: 1, maxLength: 10 }), (parts) => {
          const html = parts.map(([before, json]) => `${before}${ld(JSON.stringify(json))}`).join("");
          const facts = pageFacts(html);
          expect(facts).not.toContain(CANARY);
          wellFormed(facts);
        }),
        params(300),
      );
    },
    FUZZ_TIMEOUT_MS,
  );

  it(
    "never throws, also on arbitrary JSON with the words it looks for",
    () => {
      fc.assert(
        fc.property(fc.array(jsonFrom([...ALLOWED, ...FORBIDDEN, "Offer", "Event", "LocalBusiness", "PostalAddress"]), { minLength: 1, maxLength: 6 }), (values) => {
          wellFormed(pageFacts(values.map((value) => ld(JSON.stringify(value) ?? "null")).join("")));
        }),
        params(300),
      );
    },
    FUZZ_TIMEOUT_MS,
  );

  it(
    "survives broken JSON-LD: cut off, arbitrary bytes, without closing tag",
    () => {
      fc.assert(
        fc.property(taggedJson, fc.nat(), hostileString, fc.boolean(), (json, cut, junk, close) => {
          const text = JSON.stringify(json) ?? "";
          const broken = `${text.slice(0, cut % (text.length + 1))}${junk}`;
          const html = `<script type="application/ld+json">${broken}${close ? "</script>" : ""}<footer>${junk}</footer>`;
          const facts = pageFacts(html);
          expect(facts).not.toContain(CANARY);
          wellFormed(facts);
        }),
        params(300),
      );
    },
    FUZZ_TIMEOUT_MS,
  );
});

/** Building blocks for backtracking traps: many starts, no end, deep brackets, long digit runs, day names of every language the footer knows. */
const TRAP_UNITS = [
  "<script", "<script ", "<script>", '<script type="application/ld+json">', "</script>", "type=", "type=   ", "application/ld+json",
  "{", "[", "{\"a\":", "\"", "\\", "\\\"", "]", "}", "<footer>", "<footer", "</footer>", "<p>", "<br>", "href=\"tel:", "tel:", "+4", "0", "1", " ",
  "Mo ", "Mo-Fr ", "09:", "@", "a@", "12345 ", "Öffnungszeiten", "monday ", "sábados ", "lundi ", "9h", "9am", "<!--", "-->", "/*<![CDATA[*/", "\n", "<",
];
const trap = fc
  .tuple(fc.array(fc.constantFrom(...TRAP_UNITS), { minLength: 1, maxLength: 4 }), fc.integer({ min: 50_000, max: 300_000 }), fc.constantFrom("", ">", "</script>", "]}", "</footer>"))
  .map(([units, length, tail]) => `${units.join("").repeat(Math.ceil(length / units.join("").length)).slice(0, length)}${tail}`);

/** Linear, it takes a few milliseconds on 300,000 characters. */
const BUDGET_MS = 750;

describe("pageFacts: time (ReDoS) and size", () => {
  it(
    "stays under the time limit on pathological inputs",
    () => {
      fc.assert(
        fc.property(trap, (html) => {
          const ms = timed(() => wellFormed(pageFacts(html)));
          expect(ms, `${Math.round(ms)} ms for ${JSON.stringify(html.slice(0, 60))}… (${html.length})`).toBeLessThan(BUDGET_MS);
        }),
        params(30, { heavy: true }),
      );
    },
    FUZZ_TIMEOUT_MS,
  );

  it("[regression] deep, huge and many blocks do not hold the process", () => {
    const deep = ld(`${"[".repeat(PAGE_FACTS_LD_BLOCK_MAX_CHARS / 2 - 1)}${"]".repeat(PAGE_FACTS_LD_BLOCK_MAX_CHARS / 2 - 1)}`);
    const deepObject = ld(`${'{"a":'.repeat(10_000)}1${"}".repeat(10_000)}`);
    const huge = ld(`{"@type":"Store","name":"${"x".repeat(1_900_000)}"}`);
    const manyBlocks = ld('{"@type":"Store","name":"S","openingHours":"Mo 09:00-18:00"}').repeat(20_000);
    const footers = "<footer><p>Mo 09:00 bis 18:00 Tel. 01234 000017</p>".repeat(20_000);
    for (const html of [deep, deepObject, huge, manyBlocks, footers, `${deep}${huge}${manyBlocks}`]) {
      const ms = timed(() => wellFormed(pageFacts(html)));
      expect(ms, `${html.slice(0, 40)}… (${html.length})`).toBeLessThan(BUDGET_MS);
    }
    // What lies above the limit is not read, not even partly.
    expect(pageFacts(huge)).toBe("");
    expect(pageFacts(manyBlocks)).toBe("Page data (schema.org):\n- S (Store): Opening hours Mo 09:00-18:00");
  });
});
