import { describe, expect, it } from "vitest";
import {
  baseLanguage,
  classify,
  currentLanguage,
  currentLocale,
  loadEld,
  OwnerLanguage,
  wordsOf,
  type LanguageStore,
  type StoredLanguage,
} from "../src/i18n/language.js";

/**
 * The owner's language (src/i18n/language.ts): detection with eld on real,
 * short chat sentences, the hysteresis, persistence through a fake store and
 * loading at start.
 */

const detect = await loadEld();

class FakeStore implements LanguageStore {
  saved: StoredLanguage[] = [];
  constructor(
    public stored: StoredLanguage | null = null,
    private readonly failing = false,
  ) {}
  async load() {
    if (this.failing) throw new Error("database down");
    return this.stored;
  }
  async save(value: StoredLanguage) {
    this.saved.push(value);
    this.stored = value;
  }
}

function fresh(stored: StoredLanguage | null = null, fallback = "en") {
  const store = new FakeStore(stored);
  const language = new OwnerLanguage({ store, detector: detect, fallback, now: () => new Date("2026-10-14T08:00:00Z") });
  return { store, language };
}

const SENTENCES: Record<string, string[]> = {
  de: ["kannst du mir morgen früh den zug nach frankfurt raussuchen", "was steht diese woche im kalender", "räum mal mein postfach auf bitte"],
  en: ["can you find me a train to london tomorrow morning", "what's on my calendar this week", "clean up my inbox please"],
  tr: ["yarın sabah ankara'ya tren bulabilir misin", "bu hafta takvimde ne var", "gelen kutumu temizle lütfen"],
  es: ["puedes buscarme un tren a madrid mañana por la mañana", "qué tengo en el calendario esta semana", "limpia mi bandeja de entrada por favor"],
  fr: ["tu peux me trouver un train pour paris demain matin", "qu'est-ce que j'ai dans mon agenda cette semaine", "nettoie ma boîte de réception s'il te plaît"],
};

describe("detection", () => {
  it("recognises short chat sentences in de, en, tr, es, fr", () => {
    for (const [lang, sentences] of Object.entries(SENTENCES)) {
      for (const sentence of sentences) expect(classify(sentence, detect).language, sentence).toBe(lang);
    }
  });

  it("ignores short messages, links, numbers, emoji and the codeword name", () => {
    for (const text of ["ok", "ja", "👍", "ja immer", "yes always", "https://example.com/a/b?c=1", "483920", "serain stopp", "serain weiter bitte", "15:30 ok", "lol ok"]) {
      expect(classify(text, detect), text).toMatchObject({ readable: false, language: null });
    }
    expect(wordsOf("schau mal https://example.com und alex@example.com 👀 42")).toEqual(["schau", "mal", "und"]);
  });

  it("keeps the sentence's language when it borrows a word", () => {
    expect(classify("das ist so ein nice feature honestly, oder", detect).language).toBe("de");
  });

  it("only knows tags Intl accepts", () => {
    expect(baseLanguage("de-AT")).toBe("de");
    expect(baseLanguage("pt_BR")).toBeNull();
    expect(baseLanguage("")).toBeNull();
  });
});

describe("hysteresis", () => {
  it("switches at once on a clear message and saves the switch", async () => {
    const { store, language } = fresh(null, "en");
    await language.observe("kannst du mir morgen früh den zug nach frankfurt raussuchen");
    expect(language.current).toBe("de");
    expect(store.saved).toEqual([{ code: "de", since: "2026-10-14T08:00:00.000Z", source: "text" }]);
  });

  it("switches synchronously, before the save is done", () => {
    const { language } = fresh(null, "en");
    void language.observe("yarın sabah ankara'ya tren bulabilir misin");
    expect(language.current).toBe("tr");
  });

  it("needs two short readable messages in a row", async () => {
    const { store, language } = fresh(null, "de");
    await language.observe("thanks a lot");
    expect(language.current).toBe("de");
    await language.observe("see you later");
    expect(language.current).toBe("en");
    expect(store.saved).toHaveLength(1);
  });

  it("forgets a candidate when the next readable message is in the current language", async () => {
    const { language } = fresh(null, "de");
    await language.observe("thanks a lot");
    await language.observe("und wie wird das wetter");
    await language.observe("see you later");
    expect(language.current).toBe("de");
  });

  it("is not moved by short replies in between", async () => {
    const { store, language } = fresh(null, "tr");
    for (const text of ["ok", "👍", "ja", "yes", "serain stop", "https://example.com"]) await language.observe(text);
    expect(language.current).toBe("tr");
    expect(store.saved).toEqual([]);
  });

  it("tells listeners about a switch", async () => {
    const { language } = fresh(null, "en");
    const seen: string[] = [];
    language.onChange((lang) => seen.push(lang));
    await language.observe("puedes buscarme un tren a madrid mañana por la mañana");
    expect(seen).toEqual(["es"]);
  });
});

describe("persistence and start", () => {
  it("loads the stored language", async () => {
    const { language } = fresh({ code: "tr", since: "2026-10-01T00:00:00Z", source: "text" }, "en");
    expect(await language.load()).toBe("tr");
    expect(language.current).toBe("tr");
  });

  it("starts with the starting language without a stored one", async () => {
    const { language } = fresh(null, "es");
    expect(await language.load()).toBe("es");
  });

  it("keeps the starting language when the state is unreadable", async () => {
    const language = new OwnerLanguage({ store: new FakeStore(null, true), detector: detect, fallback: "fr" });
    expect(await language.load()).toBe("fr");
  });

  it("starts from OWNER_LANGUAGE (de in tests)", () => {
    expect(currentLanguage()).toBe("de");
    expect(currentLocale()).toBe("de");
    expect(currentLocale("tr")).toBe("tr");
  });
});
