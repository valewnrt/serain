import { describe, expect, it } from "vitest";
import { dropUnbackedLinks, findLinks, linkDropped, previewTarget, stripTracking, unbackedLinks } from "../src/security/links.js";

/** Links after untrusted content (addendum D8.4 of 2026-10-08). */

describe("findLinks", () => {
  it("detects what iMessage shows as a link: with scheme, with www and as a bare name", () => {
    expect(findLinks("hier: https://www.spotify.com/de/premium/ oder www.spotify.de")).toEqual([
      "https://www.spotify.com/de/premium/",
      "www.spotify.de",
    ]);
    expect(findLinks("geh auf spotify.com/de/student, dann passt das.")).toEqual(["spotify.com/de/student"]);
    expect(findLinks("das läuft über spotlfy-deals.xyz")).toEqual(["spotlfy-deals.xyz"]);
  });

  it("does not take trailing punctuation along", () => {
    expect(findLinks("(siehe https://example.com/a).")).toEqual(["https://example.com/a"]);
  });

  it("leaves mail addresses, file names and abbreviations alone", () => {
    expect(findLinks("schreib an max.muster@example.de oder hi@example.org")).toEqual([]);
    expect(findLinks("Anhang: Rechnung.pdf und Serain Tresortest.pdf")).toEqual([]);
    expect(findLinks("z.B. 17,99€ am 3.10. bzw. ca. 5 Min., d.h. Mo.-Fr.")).toEqual([]);
  });

  it("still counts a file extension with a scheme as a link", () => {
    expect(findLinks("https://evil.example/rechnung.pdf")).toEqual(["https://evil.example/rechnung.pdf"]);
  });
});

describe("unbackedLinks", () => {
  const opened = ["https://www.spotify.com/de/premium/", "https://example.com/suche?q=a"];

  it("lets the opened page through, however it is written", () => {
    for (const text of ["spotify.com/de/premium", "https://spotify.com/de/premium/", "http://www.spotify.com/de/premium#abos"]) {
      expect(unbackedLinks(text, opened)).toEqual([]);
    }
  });

  it("stops another page of the same host and every foreign host", () => {
    expect(unbackedLinks("spotify.com/de/account", opened)).toEqual(["spotify.com/de/account"]);
    expect(unbackedLinks("spotify-studenten.de", opened)).toEqual(["spotify-studenten.de"]);
  });

  it("lets a query through only if it was opened exactly like that", () => {
    expect(unbackedLinks("https://example.com/suche?q=a", opened)).toEqual([]);
    expect(unbackedLinks("https://example.com/suche", opened)).toEqual([]);
    expect(unbackedLinks("https://spotify.com/de/premium?next=https://evil.example", opened)).toHaveLength(1);
  });

  it("in the emergency exit replaces only what is not backed", () => {
    expect(dropUnbackedLinks("erst spotify.com/de/premium, dann evil.example/login", opened)).toBe(
      `erst spotify.com/de/premium, dann ${linkDropped()}`,
    );
  });
});

describe("link preview (addendum D48 of 2026-10-08)", () => {
  it("removes tracking parameters and anchor, keeps the rest of the query", () => {
    expect(stripTracking("https://shop.example/p/1?v=2&utm_source=mail&utm_medium=x&fbclid=a&gclid=b#preis")).toBe("https://shop.example/p/1?v=2");
    expect(stripTracking("https://open.spotify.com/track/1?si=abc")).toBe("https://open.spotify.com/track/1");
    expect(stripTracking("kein link")).toBeNull();
  });

  it("points only to an opened page and returns its address, never the model's", () => {
    const opened = ["https://www.spotify.com/de/premium/?utm_source=x"];
    expect(previewTarget("http://spotify.com/de/premium", opened)).toBe("https://www.spotify.com/de/premium/");
    expect(previewTarget("https://www.spotify.com/de/premium/#faq", opened)).toBe("https://www.spotify.com/de/premium/");
    expect(previewTarget("https://www.spotify.com/de/student", opened)).toBeNull();
    expect(previewTarget("https://www.spotify.com/de/premium?next=https://evil.example", opened)).toBeNull();
    expect(previewTarget("https://spotify.com.evil.example/de/premium", opened)).toBeNull();
    expect(previewTarget("https://www.spotify.com/de/premium", [])).toBeNull();
  });

  it("never over http, never to internal addresses, even if they were opened", () => {
    expect(previewTarget("http://alt.example/seite", ["http://alt.example/seite"])).toBeNull();
    expect(previewTarget("https://localhost/admin", ["https://localhost/admin"])).toBeNull();
    expect(previewTarget("https://10.0.0.7/x", ["https://10.0.0.7/x"])).toBeNull();
    expect(previewTarget("https://user:pw@shop.example/p", ["https://user:pw@shop.example/p"])).toBeNull();
  });
});
