import { describe, expect, it } from "vitest";
import { systemPrompt, turnContext } from "../src/agent/prompt.js";
import {
  FORBIDDEN_OPENERS,
  FORBIDDEN_PHRASES,
  findForbiddenOpeners,
  findForbiddenPhrases,
  openersFor,
  phrasesFor,
  styleBlock,
} from "../src/agent/style.js";
import { FORBIDDEN_PHRASES as EVAL_PHRASES } from "../eval/config.js";
import { checkNoForbiddenPhrases } from "../eval/checks.js";

/**
 * The style was worked out with the owner and approved (2026-09-18). These
 * tests pin down that every one of the nine rules stands in the prompt and that
 * prompt and eval check use the same filler lists. Without the second part the
 * eval at some point measures something other than what the prompt demands.
 */

describe("Filler lists", () => {
  it("are the same lists in the eval as in the prompt", () => {
    expect(EVAL_PHRASES).toBe(FORBIDDEN_PHRASES);
  });

  it("exist for English and German, and German is the approved list", () => {
    expect(Object.keys(FORBIDDEN_PHRASES).sort()).toEqual(["de", "en"]);
    expect(FORBIDDEN_PHRASES.de).toContain("wie kann ich dir helfen");
    expect(FORBIDDEN_PHRASES.de).toContain("spannende frage");
    expect(FORBIDDEN_PHRASES.de).toHaveLength(29);
    expect(FORBIDDEN_OPENERS.de).toEqual(["gerne", "klar", "natürlich"]);
    expect(FORBIDDEN_PHRASES.en).toContain("how can i help you");
    expect(FORBIDDEN_PHRASES.en.length).toBeGreaterThanOrEqual(FORBIDDEN_PHRASES.de.length);
  });

  it("stand completely in the style block, per language", () => {
    const block = styleBlock().toLowerCase();
    for (const list of Object.values(FORBIDDEN_PHRASES)) for (const phrase of list) expect(block).toContain(phrase);
    for (const list of Object.values(FORBIDDEN_OPENERS)) for (const opener of list) expect(block).toContain(`${opener}!`);
    expect(block).toContain("nor their equivalent in any other language");
  });

  it("apply English in every language, plus the language's own list", () => {
    expect(phrasesFor("en")).toEqual([...FORBIDDEN_PHRASES.en]);
    expect(phrasesFor("de")).toEqual([...FORBIDDEN_PHRASES.en, ...FORBIDDEN_PHRASES.de]);
    // A third language without a list of its own: English only (the assistant sound leaks into every language).
    expect(phrasesFor("tr")).toEqual([...FORBIDDEN_PHRASES.en]);
    expect(openersFor("tr")).toEqual([...FORBIDDEN_OPENERS.en]);
    // Unknown language: every built-in list.
    expect(phrasesFor(null)).toEqual([...FORBIDDEN_PHRASES.en, ...FORBIDDEN_PHRASES.de]);
  });

  it("finds phrases regardless of case", () => {
    expect(findForbiddenPhrases("Gerne geschehen!", "de")).toEqual(["gerne geschehen"]);
    expect(findForbiddenPhrases("mach ich, bis später", "de")).toEqual([]);
    expect(findForbiddenPhrases("Happy to help! Let me know if you need anything else.", "en")).toEqual([
      "happy to help",
      "let me know if you need anything else",
      "let me know if",
    ]);
    expect(findForbiddenPhrases("on it, see you later", "en")).toEqual([]);
    // German filler only counts in German.
    expect(findForbiddenPhrases("Gerne geschehen!", "en")).toEqual([]);
    expect(findForbiddenPhrases("Tamam, how can I help you?", "tr")).toEqual(["how can i help you", "how can i help"]);
  });

  it("hits openers only as an opener", () => {
    expect(findForbiddenOpeners("Klar! Mach ich.", "de")).toEqual(["klar"]);
    expect(findForbiddenOpeners("Natürlich. Ich kümmere mich drum.", "de")).toEqual(["natürlich"]);
    // Normal German that starts the same way stays allowed.
    expect(findForbiddenOpeners("klar, mach ich", "de")).toEqual([]);
    expect(findForbiddenOpeners("das ist natürlich blöd.", "de")).toEqual([]);
    expect(findForbiddenOpeners("Sure! On it.", "en")).toEqual(["sure"]);
    expect(findForbiddenOpeners("Of course. I'll handle it.", "en")).toEqual(["of course"]);
    expect(findForbiddenOpeners("sure, on it", "en")).toEqual([]);
    expect(findForbiddenOpeners("that's surely annoying.", "en")).toEqual([]);
  });

  it("checks the second bubble too", () => {
    expect(findForbiddenOpeners("mach ich\nGerne!", "de")).toEqual(["gerne"]);
    expect(findForbiddenOpeners("on it\nAbsolutely!", "en")).toEqual(["absolutely"]);
  });

  it("hangs on the same check as the rest", () => {
    expect(checkNoForbiddenPhrases("Klar! Ist erledigt.", "de").passed).toBe(false);
    expect(checkNoForbiddenPhrases("ist erledigt", "de").passed).toBe(true);
    expect(checkNoForbiddenPhrases("Sure! Done.", "en").passed).toBe(false);
    expect(checkNoForbiddenPhrases("done", "en").passed).toBe(true);
  });
});

describe("Style block in the system prompt", () => {
  const prompt = systemPrompt();

  it("stands as its own block before the protocol", () => {
    expect(prompt).toContain("<style>");
    expect(prompt.indexOf("<style>")).toBeLessThan(prompt.indexOf("<protocol>"));
    expect(prompt.indexOf("</style>")).toBeLessThan(prompt.indexOf("<protocol>"));
  });

  it("starts with the rule to answer in the owner's language", () => {
    const languageRule = prompt.indexOf("Always write in the language Alex writes in, whatever language that is.");
    expect(languageRule).toBeGreaterThan(0);
    expect(languageRule).toBeLessThan(prompt.indexOf("<style>"));
    expect(prompt.split("\n").slice(0, 4).join(" ")).toContain("their latest message decides");
    expect(prompt).toContain("If a message mixes languages,\nanswer in its main language.");
    // The old pin to one language is gone.
    expect(prompt).not.toContain("auf Deutsch");
  });

  it("carries all nine approved rules", () => {
    const block = styleBlock();
    // 1 mirror length, with an example
    expect(block).toContain("Mirror their length");
    expect(block).toContain("“hi” gets “hi”");
    // 2 mirror register (W21)
    expect(block).toContain("If they write in lowercase, you write in lowercase");
    expect(block).toContain("no textbook language");
    // 3 emoji only mirrored, never in a greeting or acknowledgement
    expect(block).toContain("at most one");
    expect(block).toContain("A greeting and an acknowledgement never contain an emoji");
    // 4 tapback instead of text
    expect(block).toContain("👍");
    // 5 no internal names, but honest when asked
    expect(block).toContain("send_message");
    expect(block).toContain("You never pretend not to");
    // 6 longer answers into the thread, several bubbles
    expect(block).toContain("thread of the triggering message");
    expect(block).toContain("bubbles");
    // 7 forbidden list (W2), in every language
    expect(block).toContain("Forbidden in every language: dashes as punctuation (– —)");
    expect(block).toContain("markdown");
    // 8 default instead of asking back (W20)
    expect(block).toContain("putting it in for tomorrow at 9");
    // 9 humour from the situation (W19)
    expect(block).toContain("Humour comes from the situation");
    // Style round (addendum to D23 of 2026-10-08), the owner's wording
    expect(block).toContain("If a reminder is exactly as Alex said it, ⏰ is enough.");
    expect(block).toContain("If an answer comes from opened pages, send the most important one along as a");
    expect(block).toContain("send it instead of the preview; logged-in pages only if Alex wants it.");
    // 2026-10-09: dishes as a list, with name and price.
    expect(block).toContain("things to choose from out of a research task");
  });

  it("uses an invented example for the list", () => {
    const block = styleBlock();
    expect(block).toContain("jonas (“best pizza in town”)");
    expect(block).not.toContain("eli");
    expect(block).not.toContain("spicy sticky sticks");
  });

  it("does not repeat the old single lines next to it", () => {
    // The three style lines from before are part of the block, they no longer
    // stand in the head of the prompt as well.
    expect(prompt).not.toContain("Keine Floskeln, keine Aufzählungen");
    expect(prompt).not.toContain("Antworte kurz und auf Deutsch");
  });

  it("leaves protocol and user model unchanged behind it", () => {
    const withModel = systemPrompt("Alex wohnt in Musterstadt.");
    expect(withModel.indexOf("</style>")).toBeLessThan(withModel.indexOf("<protocol>"));
    expect(withModel.indexOf("</protocol>")).toBeLessThan(withModel.indexOf("<user_model>"));
  });

  it("names the owner's interests from memory instead of a founder's when cleaning up mail", () => {
    const cleanup = systemPrompt("", { web: false, mail: ["alex@example.org"], mailCleanup: ["alex@example.org"] });
    expect(cleanup).toContain("everything that, according to your\nmemory, interests Alex");
    expect(cleanup).not.toMatch(/founder|investor|accelerator/i);
  });
});

describe("Owner's language in the <context>", () => {
  const now = new Date("2026-09-18T09:00:00Z");

  it("names the current language, in English", () => {
    expect(turnContext(now, "", [], [], [], [], "de")).toContain("Alex's language: German (de).");
    expect(turnContext(now, "", [], [], [], [], "tr")).toContain("Alex's language: Turkish (tr).");
    expect(turnContext(now)).toContain("Alex's language: German (de).");
  });

  it("writes the time in English with the owner's time zone", () => {
    expect(turnContext(now)).toContain("It is now Friday, 18 September 2026 at 11:00 (Europe/Berlin).");
  });
});

describe("Sentences from the style round that hang on a tool (addendum to D23 of 2026-10-08)", () => {
  it("mentions compute and voice only when the tools exist", () => {
    const bare = systemPrompt("", { web: true });
    expect(bare).not.toContain("you calculate with compute");
    expect(bare).not.toContain("you may answer briefly by voice");
    const full = systemPrompt("", { web: true, compute: true, voice: true });
    expect(full).toContain("Numbers you are not sure of in your head you calculate with compute instead of estimating.");
    expect(full).toContain("If Alex sends you a voice message, you may answer briefly by voice when spoken is more natural;");
  });
});
