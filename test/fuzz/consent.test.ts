import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { hostileString, params } from "./helpers.js";

vi.mock("../../src/db/audit.js", () => ({ audit: async () => undefined }));

const { installTranslations } = await import("../../src/i18n/catalog.js");
const { words } = await import("../../src/i18n/messages/words.js");
const { normalizePhrase, parseCommand, wordSet } = await import("../../src/i18n/words.js");
const { parseDecision } = await import("../../src/security/approvals.js");
const { detectKillSwitchCommand } = await import("../../src/security/killswitch.js");

/**
 * Consent at the trust boundary (D8.3): the owner's reply in the thread of a
 * preview is read by the code, in any language. Random text in many languages
 * must never count as consent, unless the whole message (trailing ".", "!"
 * aside) is exactly one yes word of the accepted set: English, German and the
 * current language, minus every word that is also a no word.
 */

installTranslations("tr", {
  [words.yes.en]: "evet|tamam|olur",
  [words.no.en]: "hayır|yok|iptal",
  [words.always.en]: "her zaman",
  [words.resume.en]: "devam",
});
// No translation at all: English and German only.
installTranslations("fi", {});

const LANGUAGES = ["en", "de", "tr", "fi"] as const;

/** Yes-like and no-like words from many languages, accepted or not, plus filler. */
const VOCABULARY = [
  ...words.yes.en.split("|"), ...words.yes.de.split("|"), ...words.no.en.split("|"), ...words.no.de.split("|"),
  "always", "immer", "her zaman", "evet", "tamam", "hayır", "iptal", "sí", "si", "claro", "dale", "oui", "d'accord", "non",
  "da", "нет", "да", "конечно", "hai", "はい", "いいえ", "是", "好", "不", "نعم", "لا", "ken", "kyllä", "ei", "tak", "nie",
  "sim", "não", "ja", "nej", "jawohl", "jein", "vielleicht", "maybe", "later", "morgen", "tomorrow", "please", "bitte",
  "aber", "but", "change", "subject", "the", "send", "it", "do", "go", "ahead", "nicht", "not", "never", "nie", "kein",
  "👍", "👎", "🙂", "ok?", "yes?", "ja?",
];

const SEPARATORS = [" ", "  ", ", ", ",", "\t", "\n", "​", "-", "/", " und ", " and "];
const ENDINGS = ["", ".", "!", "!!", "...", "…", "?", " 🙂", " ", "​"];

const caseVariant = (word: string) =>
  fc.constantFrom(word, word.toUpperCase(), word.charAt(0).toUpperCase() + word.slice(1), word.normalize("NFD"));

const phrase = fc
  .tuple(
    fc.array(fc.constantFrom(...VOCABULARY).chain(caseVariant), { minLength: 1, maxLength: 4 }),
    fc.array(fc.constantFrom(...SEPARATORS), { minLength: 3, maxLength: 3 }),
    fc.constantFrom(...ENDINGS),
    fc.constantFrom("", " ", "  "),
  )
  .map(([parts, seps, end, lead]) => lead + parts.map((part, i) => (i === 0 ? part : `${seps[i - 1] ?? " "}${part}`)).join("") + end);

const anyText = fc.oneof(
  { weight: 5, arbitrary: phrase },
  { weight: 2, arbitrary: hostileString },
  { weight: 1, arbitrary: fc.string({ unit: "grapheme", maxLength: 30 }) },
  { weight: 1, arbitrary: fc.string({ unit: "grapheme-ascii", maxLength: 12 }) },
);

/** The phrase as the code compares it: normalized, without trailing ".", "!", "…". */
function phraseOf(text: string): string {
  return normalizePhrase(text).replace(/[\s.!…]+$/u, "");
}

describe("consent", () => {
  it("is never given by random text, unless the message is exactly one accepted yes word", () => {
    fc.assert(
      fc.property(anyText, fc.constantFrom(...LANGUAGES), (text, lang) => {
        const decision = parseDecision(text, lang);
        const value = phraseOf(text);
        const yes = wordSet("yes", lang);
        const no = wordSet("no", lang);
        if (decision === "approve") {
          expect(yes.has(value), `${JSON.stringify(text)} in ${lang}`).toBe(true);
          expect(no.has(value), `${JSON.stringify(text)} in ${lang}`).toBe(false);
        }
        if (decision === "approve_standing") {
          const always = [...wordSet("always", lang)].find((word) => value.endsWith(word));
          expect(always, `${JSON.stringify(text)} in ${lang}`).toBeDefined();
          const head = value.slice(0, -always!.length).replace(/[\s,]+$/, "");
          expect(value.slice(head.length, -always!.length), JSON.stringify(text)).toMatch(/^[\s,]+$/);
          expect(yes.has(head) && !no.has(head), `${JSON.stringify(text)} in ${lang}`).toBe(true);
        }
        // A no word is never read as consent, in any combination.
        if (no.has(value)) expect(decision).toBe("deny");
      }),
      params(3_000),
    );
  });

  it("does not take a yes word from a language that is not accepted", () => {
    fc.assert(
      fc.property(fc.constantFrom("evet", "tamam", "olur", "sí", "oui", "да", "はい", "kyllä", "sim", "tak"), fc.constantFrom("en", "de", "fi"), (word, lang) => {
        expect(parseDecision(word, lang)).toBeNull();
      }),
      params(200),
    );
  });

  it("never throws and stays fast on long text", () => {
    for (const text of ["ja " + "immer ".repeat(20_000), "yes".repeat(50_000), ",".repeat(60_000) + "always", " ".repeat(60_000)]) {
      const started = performance.now();
      for (const lang of LANGUAGES) parseDecision(text, lang);
      expect(performance.now() - started).toBeLessThan(500);
    }
  });
});

describe("codewords", () => {
  it("only act on serain plus an accepted word, and stop beats everything else", () => {
    fc.assert(
      fc.property(anyText, fc.constantFrom(...LANGUAGES), fc.boolean(), (text, lang, prefixed) => {
        const message = prefixed ? `serain ${text}` : text;
        const command = parseCommand(message, lang);
        if (!command) return;
        expect(normalizePhrase(message).startsWith("serain")).toBe(true);
        const rest = normalizePhrase(message).replace(/^serain[\s,]+/u, "");
        expect([...wordSet(command, lang)].some((word) => rest.startsWith(word)), message).toBe(true);
        if ([...wordSet("stop", lang)].some((word) => rest.startsWith(word) && /^$|^[\s\p{P}\p{S}]/u.test(rest.slice(word.length)))) {
          expect(command).toBe("stop");
          expect(detectKillSwitchCommand(message, lang)).toBe("engage");
        }
      }),
      params(2_000),
    );
  });
});
