import { describe, expect, it } from "vitest";
import { dedupeKey, plainOutbound, prepareOutbound, splitIntoBubbles, stripMarkdown, styledBubble } from "../src/text/format.js";

describe("stripMarkdown", () => {
  it("removes markup, keeps the text", () => {
    expect(stripMarkdown("**wichtig** und *kursiv*")).toBe("wichtig und kursiv");
    expect(stripMarkdown("## Überschrift\nText")).toBe("Überschrift\nText");
    expect(stripMarkdown("`pnpm test` läuft")).toBe("pnpm test läuft");
    expect(stripMarkdown("> zitat")).toBe("zitat");
  });

  it("keeps links including the URL", () => {
    expect(stripMarkdown("[Doku](https://example.com)")).toBe("Doku (https://example.com)");
  });

  it("turns list items into bullets", () => {
    expect(stripMarkdown("- eins\n- zwei")).toBe("• eins\n• zwei");
  });

  it("keeps code from fences without the fences", () => {
    expect(stripMarkdown("```ts\nconst a = 1;\n```")).toBe("const a = 1;");
  });

  it("leaves normal text alone", () => {
    expect(stripMarkdown("3 * 4 = 12")).toBe("3 * 4 = 12");
    expect(stripMarkdown("die Datei user_model heißt so")).toBe("die Datei user_model heißt so");
    expect(stripMarkdown("kurz und gut")).toBe("kurz und gut");
    expect(stripMarkdown("user_model_v2 und a*b*c")).toBe("user_model_v2 und a*b*c");
  });
});

describe("[D48] Emphasis", () => {
  const styled = (input: string) => splitIntoBubbles(prepareOutbound(input)).map(styledBubble);

  it("turns bold, italic and strikethrough into UTF-16 ranges", () => {
    expect(styled("um **15 uhr**, *wirklich*, nicht ~~14~~ 👍🏽 **ok**")).toEqual([
      {
        text: "um 15 uhr, wirklich, nicht 14 👍🏽 ok",
        styles: [
          { type: "bold", start: 3, length: 6 },
          { type: "italic", start: 11, length: 8 },
          { type: "strikethrough", start: 27, length: 2 },
          { type: "bold", start: 35, length: 2 },
        ],
      },
    ]);
  });

  it("nests, but never overlaps", () => {
    expect(styled("**a *b* c**")).toEqual([
      { text: "a b c", styles: [{ type: "bold", start: 0, length: 5 }, { type: "italic", start: 2, length: 1 }] },
    ]);
  });

  it("emphasizes nothing mid-word; double asterisks are dropped anyway", () => {
    expect(styled("tages**geld**konto")).toEqual([{ text: "tagesgeldkonto", styles: [] }]);
  });

  it("carries emphasis across a bubble boundary", () => {
    const long = `**${"wort ".repeat(30).trim()}. ${"satz ".repeat(30).trim()}.**`;
    const bubbles = splitIntoBubbles(prepareOutbound(long), { maxChars: 200 }).map(styledBubble);
    expect(bubbles).toHaveLength(2);
    for (const bubble of bubbles) expect(bubble.styles).toEqual([{ type: "bold", start: 0, length: bubble.text.length }]);
  });

  it("does not read private-use characters in model text as markers", () => {
    expect(styled("a\uE000b\uE001c")).toEqual([{ text: "abc", styles: [] }]);
  });
});

describe("The code enforces the no-dashes rule (2026-10-13)", () => {
  it("turns a dash between words into a comma", () => {
    expect(prepareOutbound("ah ok, wusst ich nicht – dann passt das")).toBe("ah ok, wusst ich nicht, dann passt das");
    expect(prepareOutbound("das ist — glaub ich — richtig")).toBe("das ist, glaub ich, richtig");
    expect(prepareOutbound("nicht—dann")).toBe("nicht, dann");
  });

  it("keeps ranges as a hyphen", () => {
    expect(prepareOutbound("von 10–12 uhr, Mo–Fr, seite 3 — 4")).toBe("von 10-12 uhr, Mo-Fr, seite 3-4");
  });

  it("removes it after punctuation and at line end, and turns list dashes into bullets", () => {
    expect(prepareOutbound("ja, – klar")).toBe("ja, klar");
    expect(prepareOutbound("fertig –\nweiter")).toBe("fertig\nweiter");
    expect(prepareOutbound("– eins\n– zwei")).toBe("• eins\n• zwei");
  });

  it("leaves hyphens and literal values alone", () => {
    expect(prepareOutbound("e-mail, 3 - 4")).toBe("e-mail, 3 - 4");
    expect(plainOutbound("A1–B2")).toBe("A1–B2");
  });
});

describe("splitIntoBubbles", () => {
  it("keeps short answers as one message", () => {
    expect(splitIntoBubbles("Passt, mache ich.")).toEqual(["Passt, mache ich."]);
  });

  it("returns nothing for empty text", () => {
    expect(splitIntoBubbles("   \n\n ")).toEqual([]);
  });

  it("turns paragraphs into separate bubbles", () => {
    expect(splitIntoBubbles("Erstens.\n\nZweitens.")).toEqual(["Erstens.", "Zweitens."]);
  });

  it("splits long paragraphs at sentence boundaries", () => {
    const text = `${"a".repeat(60)}. ${"b".repeat(60)}. ${"c".repeat(60)}.`;
    const bubbles = splitIntoBubbles(text, { maxChars: 80, maxBubbles: 4 });
    expect(bubbles.length).toBe(3);
    for (const bubble of bubbles) expect(bubble.length).toBeLessThanOrEqual(80);
  });

  it("cuts an overlong sentence at word boundaries", () => {
    const text = `${"wort ".repeat(40)}Ende.`;
    const bubbles = splitIntoBubbles(text, { maxChars: 50, maxBubbles: 8 });
    for (const bubble of bubbles) {
      expect(bubble.length).toBeLessThanOrEqual(50);
      expect(bubble.startsWith(" ")).toBe(false);
    }
    expect(bubbles.join(" ")).toContain("Ende.");
  });

  it("respects the bubble limit", () => {
    const text = Array.from({ length: 10 }, (_, i) => `Absatz ${i}.`).join("\n\n");
    const bubbles = splitIntoBubbles(text, { maxChars: 200, maxBubbles: 3 });
    expect(bubbles.length).toBe(3);
    expect(bubbles.join("\n")).toContain("Absatz 9.");
  });

  it("truncates when even merged nothing fits any more", () => {
    const text = Array.from({ length: 6 }, () => "x".repeat(40)).join("\n\n");
    const bubbles = splitIntoBubbles(text, { maxChars: 40, maxBubbles: 2 });
    expect(bubbles.length).toBe(2);
    expect(bubbles[1]?.endsWith("…")).toBe(true);
  });
});

describe("dedupeKey", () => {
  it("ignores whitespace and case", () => {
    expect(dedupeKey(" Hallo   Alex ")).toBe(dedupeKey("hallo alex"));
    expect(dedupeKey("Hallo")).not.toBe(dedupeKey("Hallo?"));
  });
});
