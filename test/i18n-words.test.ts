import { describe, expect, it, vi } from "vitest";

vi.mock("../src/db/audit.js", () => ({ audit: async () => undefined }));

const { installTranslations, t } = await import("../src/i18n/catalog.js");
const { security } = await import("../src/i18n/messages/security.js");
const { words } = await import("../src/i18n/messages/words.js");
const { parseCommand, parseConsent, primaryWord, wordSet } = await import("../src/i18n/words.js");
const { parseDecision, isRevokeCommand, laterReply, renderPreview, expiredText } = await import("../src/security/approvals.js");
const { detectKillSwitchCommand } = await import("../src/security/killswitch.js");
const { formatLater, parseLater } = await import("../src/security/later.js");

/**
 * Consent and codewords in English, German, a translated language (Turkish,
 * from a fake catalog) and a language without translations (fail-safe):
 * the union rule, no wins, unknown is never consent (src/i18n/words.ts).
 */

// A translated Turkish catalog, as the model would deliver it (checked on install).
expect(
  installTranslations("tr", {
    [words.yes.en]: "evet|tamam|olur",
    [words.no.en]: "hayır|yok|iptal",
    [words.always.en]: "her zaman",
    [words.stop.en]: "dur",
    [words.resume.en]: "devam",
    [words.revoke.en]: "geri al",
    [security.killEngaged.en]: "durdum. \"serain {resume}\" yazana kadar hiçbir şey yapmıyorum.",
    [security.laterWhen.en]: "{day} {time}",
    [security.laterScheduled.en]: "tamam, {when} gidiyor. o zamana kadar burada \"{no}\" yeterli.",
    [security.standingFor.en]: "\"{yes} {always}\" bundan sonra {scope} için geçerli.",
  }),
).toEqual([]);

// A language whose translation failed completely: nothing but English and German.
installTranslations("fi", {});

// A broken translation: a word that is both yes and no, and a resume word that is also a stop word.
expect(
  installTranslations("az", {
    [words.yes.en]: "bəli|yox|no",
    [words.no.en]: "yox",
    [words.stop.en]: "dayan",
    [words.resume.en]: "dayan|davam",
  }),
).toEqual([]);

describe("consent", () => {
  it("reads German as before", () => {
    expect(parseDecision("ja", "de")).toBe("approve");
    expect(parseDecision(" Ja! ", "de")).toBe("approve");
    expect(parseDecision("ja immer", "de")).toBe("approve_standing");
    expect(parseDecision("Ja, immer.", "de")).toBe("approve_standing");
    expect(parseDecision("nö", "de")).toBe("deny");
    expect(parseDecision("lass es", "de")).toBe("deny");
    expect(parseDecision("ja aber änder noch den betreff", "de")).toBeNull();
    expect(parseDecision("jaja", "de")).toBeNull();
    expect(parseDecision("jaimmer", "de")).toBeNull();
  });

  it("reads English, in every language", () => {
    for (const lang of ["en", "de", "tr", "fi"]) {
      expect(parseDecision("yes", lang), lang).toBe("approve");
      expect(parseDecision("Go ahead!", lang), lang).toBe("approve");
      expect(parseDecision("yes always", lang), lang).toBe("approve_standing");
      expect(parseDecision("yes, always", lang), lang).toBe("approve_standing");
      expect(parseDecision("nope", lang), lang).toBe("deny");
      expect(parseDecision("don’t", lang), lang).toBe("deny");
      expect(parseDecision("yes but change the subject", lang), lang).toBeNull();
      // German works in every language too.
      expect(parseDecision("ja immer", lang), lang).toBe("approve_standing");
    }
  });

  it("reads the translated words of the current language", () => {
    expect(parseDecision("Evet.", "tr")).toBe("approve");
    expect(parseDecision("evet her zaman", "tr")).toBe("approve_standing");
    expect(parseDecision("hayır", "tr")).toBe("deny");
    expect(parseDecision("İPTAL", "tr")).toBe("deny");
    expect(parseDecision("evet ama konuyu değiştir", "tr")).toBeNull();
    // Not the current language: Turkish is conversation.
    expect(parseDecision("evet", "en")).toBeNull();
    expect(parseDecision("evet", "de")).toBeNull();
  });

  it("is fail-safe in a language without translations", () => {
    for (const text of ["kyllä", "joo", "ei", "kyllä aina", "sí", "oui", "da", "hai", "はい", "да"]) {
      expect(parseDecision(text, "fi"), text).toBeNull();
    }
  });

  it("lets no win over yes", () => {
    expect(parseConsent("yox", "az")).toBe("deny");
    expect(parseConsent("no", "az")).toBe("deny");
    expect(parseConsent("yox always", "az")).toBe("deny");
    expect(parseConsent("bəli", "az")).toBe("approve");
  });

  it("shows only words that are accepted", () => {
    for (const lang of ["en", "de", "tr", "fi"]) {
      for (const kind of ["yes", "no", "always", "stop", "resume", "revoke"] as const) {
        const word = primaryWord(kind, lang);
        expect([...wordSet(kind, lang)].includes(word.toLowerCase()), `${kind} ${lang}`).toBe(true);
      }
    }
    expect(primaryWord("yes", "de")).toBe("ja");
    expect(primaryWord("yes", "tr")).toBe("evet");
    expect(primaryWord("resume", "fi")).toBe("resume");
  });
});

describe("codewords", () => {
  it("stops with serain stop in every language", () => {
    for (const lang of ["en", "de", "tr", "fi", "az"]) {
      expect(detectKillSwitchCommand("serain stop", lang), lang).toBe("engage");
      expect(detectKillSwitchCommand("Serain, STOPP!", lang), lang).toBe("engage");
      expect(detectKillSwitchCommand("serain stoppuhr", lang), lang).toBeNull();
      expect(detectKillSwitchCommand("kannst du serain stoppen", lang), lang).toBeNull();
    }
  });

  it("resumes and revokes with the English, German and current word", () => {
    expect(detectKillSwitchCommand("serain resume", "de")).toBe("release");
    expect(detectKillSwitchCommand("serain weiter", "en")).toBe("release");
    expect(detectKillSwitchCommand("serain devam et", "tr")).toBe("release");
    expect(detectKillSwitchCommand("serain dur", "tr")).toBe("engage");
    expect(detectKillSwitchCommand("serain devam", "en")).toBeNull();
    expect(detectKillSwitchCommand("serain jatka", "fi")).toBeNull();
    expect(isRevokeCommand("serain revoke", "de")).toBe(true);
    expect(isRevokeCommand("serain widerruf", "en")).toBe(true);
    expect(isRevokeCommand("Serain, geri al", "tr")).toBe(true);
    expect(isRevokeCommand("kannst du das widerrufen", "de")).toBe(false);
  });

  it("lets stop win when a word is both stop and resume", () => {
    expect(parseCommand("serain dayan", "az")).toBe("stop");
    expect(parseCommand("serain davam", "az")).toBe("resume");
  });
});

describe("fixed texts", () => {
  it("name the words that work in the owner's language", () => {
    expect(t(security.killEngaged, { resume: primaryWord("resume", "de") }, "de")).toBe("gestoppt. ich mach nichts mehr, bis du „serain weiter“ schreibst.");
    expect(t(security.killEngaged, { resume: primaryWord("resume", "en") }, "en")).toBe("stopped. i'm not doing anything until you write \"serain resume\".");
    expect(t(security.killEngaged, { resume: primaryWord("resume", "tr") }, "tr")).toBe("durdum. \"serain devam\" yazana kadar hiçbir şey yapmıyorum.");
    // Not translated: English text, but still a word that works.
    expect(t(security.killEngaged, { resume: primaryWord("resume", "fi") }, "fi")).toBe("stopped. i'm not doing anything until you write \"serain resume\".");
  });

  it("render the preview's standing line in each language", () => {
    expect(renderPreview("Mail an X", "keiner", "Mails an X", null, "de")).toBe("Mail an X\nkeiner\n„ja immer“ gilt ab dann für Mails an X.");
    expect(renderPreview("Mail to X", "none", "mails to x", null, "en")).toBe("Mail to X\nnone\n\"yes always\" covers mails to x from then on.");
    expect(renderPreview("X", "yok", "mails to x", null, "tr")).toBe("X\nyok\n\"evet her zaman\" bundan sonra mails to x için geçerli.");
    expect(renderPreview("X", "none", "mails to x", null, "fi")).toBe("X\nnone\n\"yes always\" covers mails to x from then on.");
    expect(expiredText("en")).toBe("this one expired.");
  });

  it("answer a later approval in each language", () => {
    const at = new Date("2026-10-09T06:00:00Z");
    expect(laterReply({ kind: "scheduled", at }, "de")).toBe("ok, geht Fr., 09.10. um 08:00 raus. bis dahin reicht „nein“ hier im thread.");
    expect(laterReply({ kind: "scheduled", at }, "en")).toBe("ok, goes out Fri, Oct 9 at 8:00 AM. until then a \"no\" here in the thread is enough.");
    expect(laterReply({ kind: "scheduled", at }, "tr")).toBe("tamam, 9 Eki Cum 8:00 gidiyor. o zamana kadar burada \"hayır\" yeterli.");
    // Not translated: the whole line in English, date included.
    expect(formatLater(at, "fi")).toBe("Fri, Oct 9 at 8:00 AM");
    expect(laterReply({ kind: "refused", reason: "too_soon" }, "de")).toBe("das ist in weniger als 2 minuten. dann einfach „ja“.");
    expect(laterReply({ kind: "refused", reason: "too_far" }, "de")).toBe("weiter als 7 tage plan ich nichts ein. sag hier eine nähere zeit oder „ja“ für sofort.");
    expect(laterReply({ kind: "refused", reason: "too_many" }, "de")).toBe("es sind schon 5 sachen eingeplant. erst eine absagen oder „ja“ für sofort.");
    expect(laterReply({ kind: "refused", reason: "not_supported" }, "tr")).toBe("this only works right away: \"evet\" or \"hayır\".");
    expect(laterReply({ kind: "refused", reason: "past", at }, "en")).toBe("Fri, Oct 9 at 8:00 AM is already over. tell me a later time here, e.g. \"yes tomorrow at 8\".");
    expect(laterReply({ kind: "refused", reason: "past" }, "de")).toBe("die zeit ist schon vorbei. sag mir hier eine spätere zeit, z. B. „ja morgen um 8“.");
  });
});

describe("later in English", () => {
  // Thursday, 2026-10-08, 19:00 in Berlin (summer time, UTC+2).
  const NOW = new Date("2026-10-08T17:00:00Z");
  const ok = (text: string) => {
    const parsed = parseLater(text, NOW);
    expect(parsed?.ok, text).toBe(true);
    return parsed?.at.toISOString();
  };

  it("reads day and time in the owner's wall time", () => {
    expect(ok("yes tomorrow at 8")).toBe("2026-10-09T06:00:00.000Z");
    expect(ok("Yes, but only tomorrow at 8!")).toBe("2026-10-09T06:00:00.000Z");
    expect(ok("yes at 8 tomorrow")).toBe("2026-10-09T06:00:00.000Z");
    expect(ok("ok at 8pm")).toBe("2026-10-08T18:00:00.000Z");
    expect(ok("sure, at 9:30 pm")).toBe("2026-10-08T19:30:00.000Z");
    expect(ok("yes 7 am")).toBe("2026-10-09T05:00:00.000Z");
    expect(ok("yes the day after tomorrow at 9:30")).toBe("2026-10-10T07:30:00.000Z");
    expect(ok("yes on monday at 7")).toBe("2026-10-12T05:00:00.000Z");
    expect(ok("go ahead on fri at 12 pm")).toBe("2026-10-09T10:00:00.000Z");
    expect(ok("yes in 2 hours")).toBe("2026-10-08T19:00:00.000Z");
    expect(ok("yep in 45 mins")).toBe("2026-10-08T17:45:00.000Z");
  });

  it("is no decision otherwise", () => {
    for (const text of ["yes tomorrow", "yes 8", "yes at 13pm", "yes at 8 and change the subject", "no tomorrow at 8", "tomorrow at 8", "yes on 10/12 at 8", "yes tonight at 8"]) {
      expect(parseLater(text, NOW), text).toBeNull();
    }
  });

  it("does not schedule in other languages", () => {
    for (const text of ["evet yarın 8'de", "evet 9:30", "sí mañana a las 8", "oui demain à 8h"]) {
      expect(parseLater(text, NOW), text).toBeNull();
    }
  });
});
