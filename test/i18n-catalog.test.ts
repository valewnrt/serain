import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  Catalog,
  catalogHash,
  checkTranslation,
  defineMessages,
  defineWords,
  installTranslations,
  t,
  translationPrompt,
  type CachedCatalog,
  type CatalogEntry,
  type CatalogStore,
  type TranslationRequest,
} from "../src/i18n/catalog.js";
import { messageShape } from "../src/i18n/icu.js";
import { catalogEntries, MESSAGE_MODULES } from "../src/i18n/messages/index.js";

/**
 * The catalog (src/i18n/catalog.ts): registry complete, English and German
 * for every message with the same placeholders, values verbatim, plurals for
 * de/en/ru/ar, and the translation of other languages with a fake model:
 * rejected lines stay English, a changed English line is translated again,
 * and nothing but the fixed catalog ever reaches the translator.
 */

const MESSAGES_DIR = join(import.meta.dirname, "../src/i18n/messages");

describe("registry", () => {
  it("lists every message module in src/i18n/messages", async () => {
    const registered = new Set<unknown>(Object.values(MESSAGE_MODULES));
    for (const file of readdirSync(MESSAGES_DIR).filter((name) => name.endsWith(".ts") && name !== "index.ts")) {
      const module = (await import(join(MESSAGES_DIR, file))) as Record<string, unknown>;
      const exported = Object.values(module);
      expect(exported.length, file).toBeGreaterThan(0);
      for (const value of exported) expect(registered.has(value), `${file} is not in messages/index.ts`).toBe(true);
    }
  });

  it("defines messages only in src/i18n/messages", () => {
    const root = join(import.meta.dirname, "../src");
    for (const file of readdirSync(root, { recursive: true }) as string[]) {
      if (!file.endsWith(".ts") || file.startsWith(join("i18n", "messages")) || file === join("i18n", "catalog.ts")) continue;
      const text = readFileSync(join(root, file), "utf8");
      expect(/\bdefine(Messages|Words)\(/.test(text), file).toBe(false);
    }
  });

  it("has English and German with the same placeholders for every message", () => {
    const entries = catalogEntries();
    expect(entries.length).toBeGreaterThan(0);
    const ids = new Set<string>();
    for (const { id, message } of entries) {
      expect(ids.has(id), id).toBe(false);
      ids.add(id);
      expect(message.en.trim(), id).not.toBe("");
      expect(message.de.trim(), id).not.toBe("");
      if (message.kind === "words") {
        // The built-in lists pass the same check as translated ones.
        expect(checkTranslation(message, message.en, "en"), id).toBeNull();
        expect(checkTranslation(message, message.de, "de"), id).toBeNull();
        continue;
      }
      const en = messageShape(message.en);
      const de = messageShape(message.de);
      expect([...de.args].sort(), id).toEqual([...en.args].sort());
      expect(de.plurals.map((plural) => plural.name).sort(), id).toEqual(en.plurals.map((plural) => plural.name).sort());
      // A built-in text passes the checks a translation must pass (German against English).
      expect(checkTranslation(message, message.de, "de"), id).toBeNull();
    }
  });
});

const sample = defineMessages({
  greet: { en: "hi {name}, {count, plural, one {# new mail} other {# new mails}}.", de: "hi {name}, {count, plural, one {# neue mail} other {# neue mails}}." },
  plain: { en: "all good.", de: "alles gut." },
  exact: { en: "{count, plural, =0 {nothing left} one {# left} other {# left}}", de: "{count, plural, =0 {nichts mehr} one {# übrig} other {# übrig}}" },
  amount: { en: "{value} on {when}", de: "{value} am {when}" },
});

describe("t()", () => {
  it("renders German in tests and English on request", () => {
    expect(t(sample.plain)).toBe("alles gut.");
    expect(t(sample.plain, undefined, "en")).toBe("all good.");
  });

  it("inserts values verbatim, never as syntax", () => {
    const hostile = "{count, plural, one {x} other {y}} # <b>{name}</b> — https://evil.example";
    expect(t(sample.greet, { name: hostile, count: 1 }, "en")).toBe(`hi ${hostile}, 1 new mail.`);
    expect(t(sample.amount, { value: "1.234,50 €", when: "Fr., 09.10." })).toBe("1.234,50 € am Fr., 09.10.");
  });

  it("picks plurals with Intl.PluralRules, exact matches first", () => {
    expect(t(sample.greet, { name: "Alex", count: 1 })).toBe("hi Alex, 1 neue mail.");
    expect(t(sample.greet, { name: "Alex", count: 3 })).toBe("hi Alex, 3 neue mails.");
    expect(t(sample.greet, { name: "Alex", count: 1.5 }, "en")).toBe("hi Alex, 1.5 new mails.");
    expect(t(sample.greet, { name: "Alex", count: 1.5 })).toBe("hi Alex, 1,5 neue mails.");
    expect(t(sample.exact, { count: 0 }, "en")).toBe("nothing left");
    expect(t(sample.exact, { count: 2 }, "en")).toBe("2 left");
  });

  it("uses every CLDR category of a translated language (ru, ar)", () => {
    expect(
      installTranslations("ru", {
        [sample.greet.en]: "привет {name}, {count, plural, one {# новое письмо} few {# новых письма} many {# новых писем} other {# нового письма}}.",
      }),
    ).toEqual([]);
    expect(t(sample.greet, { name: "Alex", count: 1 }, "ru")).toBe("привет Alex, 1 новое письмо.");
    expect(t(sample.greet, { name: "Alex", count: 3 }, "ru")).toBe("привет Alex, 3 новых письма.");
    expect(t(sample.greet, { name: "Alex", count: 5 }, "ru")).toBe("привет Alex, 5 новых писем.");
    expect(t(sample.greet, { name: "Alex", count: 21 }, "ru")).toBe("привет Alex, 21 новое письмо.");

    expect(
      installTranslations("ar", {
        [sample.greet.en]:
          "مرحبا {name}، {count, plural, zero {لا رسائل} one {رسالة واحدة} two {رسالتان} few {# رسائل} many {# رسالة} other {# رسالة}}.",
      }),
    ).toEqual([]);
    expect(t(sample.greet, { name: "Alex", count: 0 }, "ar")).toBe("مرحبا Alex، لا رسائل.");
    expect(t(sample.greet, { name: "Alex", count: 2 }, "ar")).toBe("مرحبا Alex، رسالتان.");
    expect(t(sample.greet, { name: "Alex", count: 3 }, "ar")).toBe("مرحبا Alex، 3 رسائل.");
    expect(t(sample.greet, { name: "Alex", count: 11 }, "ar")).toBe("مرحبا Alex، 11 رسالة.");
    // Not translated: English, with English number formatting.
    expect(t(sample.plain, undefined, "ar")).toBe("all good.");
  });

  it("throws on a missing value: a bug in the caller, not a text to send", () => {
    // @ts-expect-error name is required by the English text
    expect(() => t(sample.greet, { count: 1 })).toThrow(/needs \{name\}/);
  });

  it("derives the required placeholders from the English text", () => {
    // @ts-expect-error a message without placeholders takes no values
    t(sample.plain, { name: "x" });
    // @ts-expect-error count is required
    void (() => t(sample.exact, {}));
    expect(t(sample.exact, { count: 1 }, "en")).toBe("1 left");
  });
});

describe("checkTranslation", () => {
  it("rejects lines that change what the owner reads", () => {
    const check = (text: string, lang = "tr") => checkTranslation(sample.greet, text, lang);
    expect(check("merhaba {name}, {count, plural, one {# yeni posta} other {# yeni posta}}.")).toBeNull();
    expect(check("merhaba, {count, plural, one {# yeni posta} other {# yeni posta}}.")).toBe("placeholders differ");
    expect(check("merhaba {name} {other}, {count, plural, one {#} other {#}}.")).toBe("placeholders differ");
    expect(check("merhaba {name}, {count, plural, other {# yeni posta}}.")).toBe("plural count misses one");
    expect(check("merhaba {name}, {count, plural, one {#} few {#} other {#}}.")).toBe("plural selector few not valid for tr");
    expect(check("merhaba {name}, 5 {count, plural, one {#} other {#}}.")).toBe("new digits");
    expect(check("merhaba {name} https://evil.example, {count, plural, one {#} other {#}}.")).toMatch(/new link|new "\/"/);
    expect(check("merhaba {name} — {count, plural, one {#} other {#}}.")).toBe('new "—"');
    expect(check("merhaba <b>{name}</b> {count, plural, one {#} other {#}}.")).toBe('new "<"');
    expect(check("merhaba {name {count}")).toBe("bad syntax");
    expect(check(`${"çok ".repeat(80)}{name} {count, plural, one {#} other {#}}`)).toBe("too long");
    expect(check("   ")).toBe("empty");
  });

  it("keeps Serain's name, which is part of the codewords", () => {
    const stop = defineMessages({ stop: { en: "write \"serain {resume}\".", de: "schreib „serain {resume}“." } }).stop;
    expect(checkTranslation(stop, "\"serain {resume}\" yaz.", "tr")).toBeNull();
    expect(checkTranslation(stop, "\"{resume}\" yaz.", "tr")).toBe("name changed");
    expect(checkTranslation(stop, "\"серейн {resume}\" напиши.", "ru")).toBe("name changed");
  });

  it("accepts only short plain expressions for word lists", () => {
    const list = defineWords({ test_yes: { en: ["yes", "go ahead"], de: ["ja"] } }).test_yes;
    expect(checkTranslation(list, "evet|tamam|olur", "tr")).toBeNull();
    expect(checkTranslation(list, "evet|tamam, yap", "tr")).toMatch(/not a short expression/);
    expect(checkTranslation(list, "evet|1", "tr")).toMatch(/not a short expression/);
    expect(checkTranslation(list, "evet|bu çok uzun bir ifade", "tr")).toMatch(/not a short expression/);
    expect(checkTranslation(list, Array.from({ length: 11 }, (_, i) => "evet".repeat(i + 1)).join("|"), "tr")).toBe("too many words");
  });
});

class MemoryStore implements CatalogStore {
  data = new Map<string, CachedCatalog>();
  saves = 0;
  async load(lang: string) {
    return this.data.get(lang) ?? null;
  }
  async save(lang: string, value: CachedCatalog) {
    this.saves += 1;
    this.data.set(lang, structuredClone(value));
  }
}

const tr = defineMessages({
  sent: { en: "sent to {to}.", de: "ist an {to} raus." },
  count: { en: "{count, plural, one {# thing} other {# things}} left.", de: "{count, plural, one {# sache} other {# sachen}} übrig." },
  dash: { en: "all done.", de: "alles erledigt." },
  number: { en: "back in a bit.", de: "gleich wieder da." },
});
const trWords = defineWords({ test_no: { en: ["no", "nope"], de: ["nein"] } });

const TURKISH: Record<string, string> = {
  "test.sent": "{to} adresine gönderildi.",
  "test.count": "{count, plural, one {# şey} other {# şey}} kaldı.",
  // Rejected: a dash the source does not have.
  "test.dash": "hepsi bitti — tamam.",
  // Rejected: a new digit.
  "test.number": "5 dakikaya dönerim.",
  "test.no": "hayır|yok",
};

function setup(entries: CatalogEntry[], answers: Record<string, string> = TURKISH, store = new MemoryStore()) {
  const requests: TranslationRequest[] = [];
  let now = 0;
  const make = () =>
    new Catalog({
      store,
      entries: async () => entries,
      translate: async (request) => {
        requests.push(structuredClone(request));
        return Object.fromEntries(request.items.flatMap((item) => (answers[item.id] ? [[item.id, answers[item.id]!]] : [])));
      },
      retryMs: 1_000,
      now: () => now,
    });
  return { store, requests, make, tick: (ms: number) => (now += ms) };
}

const ENTRIES: CatalogEntry[] = [
  { id: "test.sent", message: tr.sent },
  { id: "test.count", message: tr.count },
  { id: "test.dash", message: tr.dash },
  { id: "test.number", message: tr.number },
  { id: "test.no", message: trWords.test_no },
];

describe("translation", () => {
  it("translates once, keeps rejected lines English and caches with the hash", async () => {
    const { store, requests, make } = setup(ENTRIES);
    const catalog = make();
    expect(catalog.render(tr.sent, { to: "anna@example.com" }, "tr")).toBe("sent to anna@example.com.");
    const result = await catalog.prepare("tr");
    expect(result.translated).toBe(3);
    expect(result.rejected).toEqual([
      { id: "test.dash", reason: 'new "—"' },
      { id: "test.number", reason: "new digits" },
    ]);
    expect(catalog.render(tr.sent, { to: "anna@example.com" }, "tr")).toBe("anna@example.com adresine gönderildi.");
    expect(catalog.render(tr.count, { count: 2 }, "tr")).toBe("2 şey kaldı.");
    expect(catalog.render(tr.dash, undefined, "tr")).toBe("all done.");
    expect(catalog.render(tr.number, undefined, "tr")).toBe("back in a bit.");
    expect(catalog.translatedWords(trWords.test_no, "tr")).toEqual(["hayır", "yok"]);
    expect(store.data.get("tr")?.hash).toBe(catalogHash(ENTRIES));
    expect(requests).toHaveLength(1);
    expect(requests[0]!.pluralCategories).toEqual(["one", "other"]);

    // Next process: everything from the cache, no model call.
    const again = make();
    const cached = await again.prepare("tr");
    expect(cached).toMatchObject({ translated: 0, fromCache: 3 });
    expect(requests).toHaveLength(1);
    expect(again.render(tr.count, { count: 1 }, "tr")).toBe("1 şey kaldı.");
  });

  it("translates again only what changed in English", async () => {
    const store = new MemoryStore();
    await setup(ENTRIES, TURKISH, store).make().prepare("tr");
    const changed = defineMessages({ sent: { en: "it went to {to}.", de: "ging an {to}." } });
    const entries = ENTRIES.map((entry) => (entry.id === "test.sent" ? { id: "test.sent", message: changed.sent } : entry));
    const second = setup(entries, { ...TURKISH, "test.sent": "{to} adresine gitti." }, store);
    const catalog = second.make();
    await catalog.prepare("tr");
    // The changed line, and the two that were rejected last time; the rest comes from the cache.
    expect(second.requests).toHaveLength(1);
    expect(second.requests[0]!.items.map((item) => item.id).sort()).toEqual(["test.dash", "test.number", "test.sent"]);
    expect(catalog.render(changed.sent, { to: "x@example.com" }, "tr")).toBe("x@example.com adresine gitti.");
    expect(catalog.render(tr.count, { count: 4 }, "tr")).toBe("4 şey kaldı.");
    expect(store.data.get("tr")?.hash).toBe(catalogHash(entries));
    expect(Object.keys(store.data.get("tr")!.entries)).not.toContain(tr.sent.en);
  });

  it("never sends anything but the fixed catalog to the translator", async () => {
    const { requests, make } = setup(ENTRIES);
    const catalog = make();
    const canary = "KANARIE-7f3a9c";
    // Rendering with content before and while the translation runs.
    catalog.render(tr.sent, { to: `${canary}@example.com` }, "tr");
    await catalog.prepare("tr");
    catalog.render(tr.sent, { to: canary }, "tr");
    const sent = JSON.stringify(requests);
    expect(sent).not.toContain(canary);
    const allowed = new Set(ENTRIES.flatMap(({ message }) => [message.en, message.de, message.note ?? ""]));
    for (const request of requests) {
      for (const item of request.items) {
        expect(allowed.has(item.en) && allowed.has(item.de)).toBe(true);
      }
      const { system, prompt } = translationPrompt(request);
      expect(system + prompt).not.toContain(canary);
    }
  });

  it("stays English after a failure and tries again later, not on every text", async () => {
    const store = new MemoryStore();
    let calls = 0;
    let now = 0;
    const catalog = new Catalog({
      store,
      entries: async () => ENTRIES,
      translate: async () => {
        calls += 1;
        throw new Error("model down");
      },
      retryMs: 1_000,
      now: () => now,
    });
    await catalog.prepare("tr");
    expect(calls).toBe(1);
    expect(catalog.render(tr.sent, { to: "a@example.com" }, "tr")).toBe("sent to a@example.com.");
    // Incomplete: cached without the hash, so the next start asks again.
    expect(store.data.get("tr")?.hash).toBe("");
    await catalog.prepare("tr");
    expect(calls).toBe(1);
    now += 1_001;
    await catalog.prepare("tr");
    expect(calls).toBe(2);
  });

  it("does not translate English or German", async () => {
    const { requests, make } = setup(ENTRIES);
    const catalog = make();
    await catalog.prepare("en");
    await catalog.prepare("de");
    expect(requests).toEqual([]);
  });
});
