import { createServer, type Server } from "node:http";
import { lookup } from "node:dns";
import type { AddressInfo, LookupFunction } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FetchError, fetchPage, htmlToText, pageFacts, withFacts } from "../src/executor/fetch.js";
import { FETCH_MAX_BYTES, FETCH_MAX_CHARS, PAGE_FACTS_LD_BLOCK_MAX_CHARS, PAGE_FACTS_MAX_CHARS } from "../src/config/limits.js";

/**
 * Against a real local server. The SSRF protection rightly blocks it; that is
 * the first test. All others switch off lookup and URL check to test
 * redirects, sizes and content types.
 */

/** Made up: a store with JSON-LD, phone link and footer. */
const SHOP =
  "<html><head><title>Laden</title>" +
  '<script type="application/ld+json">{"@context":"https://schema.org","@type":"HardwareStore","name":"Werkzeug Beispiel",' +
  '"telephone":"+49 1234 000000","address":{"@type":"PostalAddress","streetAddress":"Musterweg 1","postalCode":"12345","addressLocality":"Musterstadt"},' +
  '"openingHoursSpecification":[{"dayOfWeek":["https://schema.org/Monday","https://schema.org/Friday"],"opens":"09:00:00","closes":"18:00:00"}],' +
  '"specialOpeningHoursSpecification":[{"validFrom":"2026-12-24","validThrough":"2026-12-24","opens":"00:00","closes":"00:00"}],' +
  '"description":"NICHT-ERLAUBT","review":{"reviewBody":"NICHT-ERLAUBT","author":{"name":"NICHT-ERLAUBT"}}}</script>' +
  "</head><body><main><p>Willkommen im Laden.</p></main>" +
  '<a href="tel:+4912340000009">Anrufen</a>' +
  "<footer><p>Impressum | Datenschutz | Karriere</p><p>Öffnungszeiten: Sa 10:00 bis 14:00</p></footer></body></html>";

let server: Server;
let base: string;

const open = {
  lookup: lookup as unknown as LookupFunction,
  checkUrl: (raw: string) => ({ ok: true as const, url: new URL(raw) }),
};

beforeAll(async () => {
  server = createServer((req, res) => {
    switch (req.url) {
      case "/page":
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.end(
          "<html><head><title>Fahrplan &amp; Preise</title><script>alert('x')</script></head>" +
            "<body><h1>Z&uuml;ge</h1><p>ICE 14:32</p><!-- geheim --><style>p{}</style><p>Gleis&nbsp;7</p></body></html>",
        );
        return;
      case "/laden":
        res.setHeader("content-type", "text/html");
        res.end(SHOP);
        return;
      case "/json":
        res.setHeader("content-type", "application/json");
        res.end('{"ok":true}');
        return;
      case "/pdf":
        res.setHeader("content-type", "application/pdf");
        res.end("%PDF");
        return;
      case "/menu":
        res.setHeader("content-type", "text/html");
        res.end(
          '<html><body><p>Unsere Karte</p><a href="menu/karte_1.pdf"><img src="k.png"></a>' +
            '<a href="/files/impressum.pdf">Impressum</a><a href="menu/karte_1.pdf">doppelt</a>' +
            '<a href="javascript:x.pdf">nie</a><a href="/seite.html">keine PDF</a></body></html>',
        );
        return;
      case "/hop":
        res.writeHead(302, { location: "/page" }).end();
        return;
      case "/loop":
        res.writeHead(302, { location: "/loop" }).end();
        return;
      case "/to-metadata":
        res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data" }).end();
        return;
      case "/big":
        res.setHeader("content-type", "text/plain");
        res.end("a".repeat(FETCH_MAX_BYTES + 50_000));
        return;
      default:
        res.writeHead(404, { "content-type": "text/plain" }).end("nichts hier");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => void server.close(() => resolve())));

describe("fetchPage", () => {
  it("fetches nothing local with the default settings", async () => {
    await expect(fetchPage(`${base}/page`)).rejects.toThrow(/standard ports|Internal addresses/);
    await expect(fetchPage("http://127.0.0.1/")).rejects.toThrow(/Internal addresses/);
    await expect(fetchPage("http://127.0.0.1/")).rejects.toMatchObject({ kind: "refused" });
  });

  it("turns HTML into readable text, without scripts, styles and comments", async () => {
    const page = await fetchPage(`${base}/page`, open);
    expect(page.title).toBe("Fahrplan & Preise");
    expect(page.text).toBe("Züge\nICE 14:32\nGleis 7");
    expect(page.status).toBe(200);
  });

  it("reads JSON raw", async () => {
    expect((await fetchPage(`${base}/json`, open)).text).toBe('{"ok":true}');
  });

  it("refuses content types that are not text", async () => {
    await expect(fetchPage(`${base}/pdf`, open)).rejects.toThrow(/application\/pdf/);
    // Code decides by the kind, never by the message (I18N-SPEC, principle 4).
    await expect(fetchPage(`${base}/pdf`, open)).rejects.toMatchObject({ name: "FetchError", kind: "unreadable_type" });
  });

  it("hands a PDF to the reader from the sandbox, only if there is one (addendum D20 of 2026-10-09)", async () => {
    const seen: string[] = [];
    const page = await fetchPage(`${base}/pdf`, { ...open, readPdf: async (body) => (seen.push(body.toString()), "  Wagyu Katsu Sando 100,00  ") });
    expect(seen).toEqual(["%PDF"]);
    expect(page).toMatchObject({ contentType: "application/pdf", text: "Wagyu Katsu Sando 100,00", status: 200 });
    // A page names its PDFs because its text carries no links; without a reader there is no list.
    const menu = await fetchPage(`${base}/menu`, { ...open, readPdf: async () => "nie" });
    expect(menu.documents).toEqual([
      { url: `${base}/menu/karte_1.pdf`, label: "" },
      { url: `${base}/files/impressum.pdf`, label: "Impressum" },
    ]);
    expect((await fetchPage(`${base}/menu`, open)).documents).toBeUndefined();
    // Broken HTML with many open links stays linear, and a large page stays at FETCH_MAX_BYTES.
    const { pdfLinks } = await import("../src/executor/fetch.js");
    const started = Date.now();
    expect(pdfLinks('<a href="x.pdf">'.repeat(200_000), new URL(base))).toHaveLength(1);
    expect(pdfLinks("<a ".repeat(200_000), new URL(base))).toEqual([]);
    // Alone under 1 s. The limit catches quadratic behaviour (hours with 200,000 open links), not
    // load: in the full `pnpm test` a hundred files run side by side, and 2 s were no longer enough there.
    expect(Date.now() - started).toBeLessThan(5_000);
    const big = await fetchPage(`${base}/big`, { ...open, readPdf: async () => "nie" });
    expect(big.truncated).toBe(true);
    // HTML stays HTML, also with a reader.
    expect((await fetchPage(`${base}/page`, { ...open, readPdf: async () => "nie" })).text).toBe("Züge\nICE 14:32\nGleis 7");
  });

  it("follows redirects, but not endlessly", async () => {
    expect((await fetchPage(`${base}/hop`, open)).url).toBe(`${base}/page`);
    await expect(fetchPage(`${base}/loop`, open)).rejects.toThrow(/Too many redirects/);
    await expect(fetchPage(`${base}/loop`, open)).rejects.toMatchObject({ kind: "redirect" });
  });

  it("also checks the target of a redirect", async () => {
    // Only the first hop may be local; from then on the real check applies.
    const { checkUrl } = await import("../src/executor/netguard.js");
    let first = true;
    const firstHopOnly = {
      lookup: open.lookup,
      checkUrl: (raw: string) => {
        if (!first) return checkUrl(raw);
        first = false;
        return open.checkUrl(raw);
      },
    };
    await expect(fetchPage(`${base}/to-metadata`, firstHopOnly)).rejects.toThrow(/Internal addresses/);
  });

  it("cuts off instead of loading any amount", async () => {
    const page = await fetchPage(`${base}/big`, open);
    expect(page.truncated).toBe(true);
    expect(page.text).toHaveLength(FETCH_MAX_CHARS);
  });

  it("reports the status instead of taking an error for content", async () => {
    const page = await fetchPage(`${base}/gibtsnicht`, open);
    expect(page.status).toBe(404);
  });
});

describe("htmlToText", () => {
  it("takes the content part and leaves out the scaffolding of the page", () => {
    const filler = "Abfahrt 04:31 ab Gleis 7. ".repeat(30);
    const html =
      "<body><header><a>Logo</a></header><nav><a>Start</a><a>Tickets</a></nav>" +
      `<main><h1>Fahrplan</h1><p>${filler}</p><form><select><option>Deutsch</option></select></form></main>` +
      "<aside>Werbung</aside><footer>Impressum</footer></body>";
    const { text } = htmlToText(html);
    expect(text.startsWith("Fahrplan\nAbfahrt 04:31")).toBe(true);
    for (const junk of ["Logo", "Tickets", "Deutsch", "Werbung", "Impressum"]) {
      expect(text).not.toContain(junk);
    }
  });

  it("stays with the whole page when there is no noteworthy content part", () => {
    expect(htmlToText("<main>kurz</main><p>der eigentliche Text</p>").text).toContain("der eigentliche Text");
  });

  it("decodes entities and keeps paragraphs", () => {
    expect(htmlToText("<p>A &#8364; B</p><p>&#x41;&hellip;</p>").text).toBe("A € B\nA…");
  });
});

describe("pageFacts (structured page data)", () => {
  const ld = (json: string) => `<script type="application/ld+json">${json}</script>`;

  it("reads opening hours, special hours, phone and address, and only those", () => {
    const facts = pageFacts(SHOP);
    expect(facts).toBe(
      [
        "Page data (schema.org):",
        "- Werkzeug Beispiel (HardwareStore): Opening hours Mon, Fri 09:00-18:00 | Special opening hours 2026-12-24 closed | " +
          "Phone +49 1234 000000 | Address Musterweg 1, 12345 Musterstadt",
        "Phone numbers on the page: +4912340000009",
        "From the page footer:",
        "- Öffnungszeiten: Sa 10:00 bis 14:00",
      ].join("\n"),
    );
    expect(facts).not.toContain("NICHT-ERLAUBT");
    expect(facts).not.toContain("Impressum");
  });

  it("reads final price, availability, shipping and whether an event is cancelled", () => {
    const facts = pageFacts(
      ld('[{"@type":"Product","name":"Stuhl","offers":{"@type":"Offer","price":"49.99","priceCurrency":"eur","availability":"https://schema.org/SoldOut",' +
        '"shippingDetails":{"shippingRate":{"value":"4.90","currency":"EUR"},"deliveryTime":{"handlingTime":{"minValue":0,"maxValue":1},"transitTime":{"minValue":1,"maxValue":3}}}}},' +
        '{"@type":"MusicEvent","name":"Konzert","startDate":"2026-10-12T20:00","eventStatus":"https://schema.org/EventCancelled","location":{"name":"Stadthalle"}}]'),
    );
    expect(facts).toContain("- Stuhl (Product): Offer price 49.99 EUR, sold out, shipping 4.90 EUR, delivery 1 to 4 days");
    expect(facts).toContain("- Konzert (MusicEvent): Event 2026-10-12T20:00, cancelled, location Stadthalle");
  });

  it("finds entries in @graph and in mainEntity, also in CDATA", () => {
    const facts = pageFacts(
      ld('/*<![CDATA[*/{"@graph":[{"@type":"WebPage","name":"Start","mainEntity":{"@type":"Library","name":"Bücherei","openingHours":["Mo-Fr 10:00-18:00"]}}]}/*]]>*/'),
    );
    expect(facts).toBe("Page data (schema.org):\n- Bücherei (Library): Opening hours Mo-Fr 10:00-18:00");
  });

  it("skips broken, too deep and too large JSON-LD without losing the rest", () => {
    const good = ld('{"@type":"Store","name":"Gut","telephone":"01234 000017"}');
    const html = [
      ld('{"@type":"Store","name":"Kaputt",'),
      ld(`${"[".repeat(5_000)}${"]".repeat(5_000)}`),
      ld(`{"@type":"Store","name":"Groß","telephone":"01234 000071","x":"${"a".repeat(PAGE_FACTS_LD_BLOCK_MAX_CHARS)}"}`),
      '<script type="text/javascript">{"@type":"Store","name":"Kein JSON-LD","telephone":"01234 000011"}</script>',
      good,
    ].join("");
    expect(pageFacts(html)).toBe("Page data (schema.org):\n- Gut (Store): Phone 01234 000017");
  });

  it("takes along no control characters and no tags from the page, and stays under the limit", () => {
    const facts = pageFacts(ld('{"@type":"Store","name":"A\\u0000\\u202e<b>B</b>\\nC","telephone":"0 6 1 9 2 1 2 3"}'));
    expect(facts).toBe("Page data (schema.org):\n- A b B /b C (Store): Phone 0 6 1 9 2 1 2 3");
    const many = Array.from({ length: 40 }, (_, i) => ld(`{"@type":"Store","name":"Filiale ${i} ${"x".repeat(100)}","openingHours":"Mo-Sa 09:00-20:00"}`)).join("");
    expect(pageFacts(many).length).toBeLessThanOrEqual(PAGE_FACTS_MAX_CHARS);
  });

  it("stands separate from the text in fetchPage, and withFacts puts it before within the limit", async () => {
    const page = await fetchPage(`${base}/laden`, open);
    expect(page.text).toBe(htmlToText(SHOP).text);
    expect(page.facts).toContain("Werkzeug Beispiel (HardwareStore)");
    expect(withFacts(page.facts, page.text).text).toBe(`${page.facts}\n\n${page.text}`);
    const long = withFacts("Data", "x".repeat(FETCH_MAX_CHARS));
    expect(long.text.length).toBe(FETCH_MAX_CHARS);
    expect(long.cut).toBe(true);
    expect(withFacts(undefined, "only text")).toEqual({ text: "only text", cut: false });
  });
});

describe("pageFacts: footer lines in several languages (comfort, not a safety check)", () => {
  const footer = (...lines: string[]) => `<html><body><main>x</main><footer>${lines.map((line) => `<p>${line}</p>`).join("")}</footer></body></html>`;

  it("finds opening hours and contact in German and English footers", () => {
    expect(pageFacts(footer("Impressum", "Öffnungszeiten: Mo-Fr 9-18 Uhr", "Musterweg 1, 12345 Musterstadt"))).toBe(
      "From the page footer:\n- Öffnungszeiten: Mo-Fr 9-18 Uhr\n- Musterweg 1, 12345 Musterstadt",
    );
    expect(pageFacts(footer("Privacy | Terms", "Monday to Friday 9am to 5pm", "Saturday 10:00 to 14:00", "Call us: +44 20 7946 0000"))).toBe(
      "From the page footer:\n- Monday to Friday 9am to 5pm\n- Saturday 10:00 to 14:00\n- Call us: +44 20 7946 0000",
    );
  });

  it("finds them in French, Spanish and Dutch footers too", () => {
    expect(pageFacts(footer("Mentions légales", "Horaires : du lundi au samedi", "lundi 9h00 - 19h00"))).toBe(
      "From the page footer:\n- Horaires : du lundi au samedi\n- lundi 9h00 - 19h00",
    );
    expect(pageFacts(footer("Aviso legal", "sábados 10:00 - 14:00"))).toBe("From the page footer:\n- sábados 10:00 - 14:00");
    expect(pageFacts(footer("Privacyverklaring", "zaterdag 10.00 - 17.00 uur"))).toBe("From the page footer:\n- zaterdag 10.00 - 17.00 uur");
  });

  it("takes no word for a day inside another word, and a footer in another language simply has no facts", () => {
    expect(pageFacts(footer("money back within 30 days", "Sunday Times bestseller 2026"))).toBe("");
    // Japanese: nothing recognised, nothing invented; the page text still goes to the model.
    expect(pageFacts(footer("営業時間 10時から19時まで"))).toBe("");
  });
});

describe("FetchError", () => {
  it("carries a kind for code and defaults to other", () => {
    expect(new FetchError("x").kind).toBe("other");
    expect(new FetchError("The page took too long.", "timeout").kind).toBe("timeout");
  });
});
