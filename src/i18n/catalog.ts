import { createHash } from "node:crypto";
import { z } from "zod";
import { log } from "../log.js";
import { currentLanguage, currentLocale, onLanguageChange } from "./language.js";
import { formatMessage, messageShape, messageText, pluralCategories, type MessageParams } from "./icu.js";

/**
 * The catalog of fixed texts that go to the owner past the model: previews'
 * frame, kill-switch replies, greetings, health and budget notices, and the
 * words the confirmation protocol accepts (`words.ts`). Everything the model
 * writes it writes in the owner's language by itself; this is for the rest.
 *
 * Every module keeps its texts in `src/i18n/messages/<module>.ts`:
 *
 *     export const mail = defineMessages({
 *       sent: { en: "sent to {to}.", de: "ist an {to} raus." },
 *     });
 *     t(mail.sent, { to: address });
 *
 * English and German are built in. Any other language is translated once from
 * the complete English catalog through the model layer (cheap role, structured
 * output), checked line by line and cached in `agent_state` under
 * `catalog:<lang>` with a hash of the English catalog; until then, and for any
 * line that fails the check, the owner reads English. Placeholder values are
 * inserted after translation and never translated: recipients, mail text,
 * subjects, amounts, names and titles stay verbatim. Nothing but the fixed
 * catalog ever goes into a translation request (D8): no message content, no
 * parameter value, nothing from a foreign source.
 */

export interface MessageDef {
  readonly en: string;
  readonly de: string;
  /** Context for the translator, when the English alone is ambiguous. Never content. */
  readonly note?: string;
}

export interface WordsDef {
  readonly en: readonly string[];
  readonly de: readonly string[];
  readonly note?: string;
}

/** A catalog entry. `P` are the placeholder names, derived from the English text. */
export interface Message<P extends string = string> {
  /** `text` renders through `t()`; `words` is a list of short expressions for `words.ts`. */
  readonly kind: "text" | "words";
  readonly en: string;
  readonly de: string;
  readonly note: string | null;
  /** Type-level only: the placeholders `t()` requires. */
  readonly params?: P;
}

// Placeholder names of an English text, at the type level. Best effort: a
// placeholder right after one of the plural selectors (`… other {name}`) reads
// as a plural branch and is not required by the type; `t()` still throws at
// runtime when it is missing.
type Trim<S extends string> = S extends ` ${infer R}` ? Trim<R> : S extends `${infer R} ` ? Trim<R> : S;
type Selector = "zero" | "one" | "two" | "few" | "many" | "other" | `=${number}`;
type OpensBranch<Pre extends string> = Trim<Pre> extends `${string}${Selector}` ? true : false;
type Segment<Rest extends string> = Rest extends `${infer Close}}${string}`
  ? Close extends `${infer Open}{${string}`
    ? Open
    : Close
  : Rest extends `${infer Open}{${string}`
    ? Open
    : Rest;
type NameOf<Seg extends string> = Seg extends `${infer Name},${string}`
  ? Trim<Name>
  : Seg extends `${string} ${string}` | `${string}#${string}` | ""
    ? never
    : Seg;
export type ParamsOf<S extends string> = S extends `${infer Pre}{${infer Rest}`
  ? (OpensBranch<Pre> extends true ? never : NameOf<Segment<Rest>>) | ParamsOf<Rest>
  : never;

/** Every message defined in this process, by English source: what a cached or installed line may translate. */
const defined = new Map<string, Message>();

function define(message: Message): Message {
  const known = defined.get(message.en);
  if (known && known.kind !== message.kind) throw new Error(`Same English text as text and as words: ${message.en.slice(0, 80)}`);
  if (!known) defined.set(message.en, message);
  return message;
}

export function defineMessages<const T extends Record<string, MessageDef>>(defs: T): { readonly [K in keyof T]: Message<ParamsOf<T[K]["en"]>> } {
  const out: Record<string, Message> = {};
  for (const [key, def] of Object.entries(defs)) {
    // Fails at load time, not when the owner is waiting for the text.
    messageShape(def.en);
    messageShape(def.de);
    out[key] = define(Object.freeze({ kind: "text", en: def.en, de: def.de, note: def.note ?? null }));
  }
  return Object.freeze(out) as { readonly [K in keyof T]: Message<ParamsOf<T[K]["en"]>> };
}

/** Word lists (`yes`, `no`, …) for `words.ts`. Stored as `a|b|c`, translated like any line. */
export function defineWords<const T extends Record<string, WordsDef>>(defs: T): { readonly [K in keyof T]: Message<never> } {
  const out: Record<string, Message> = {};
  for (const [key, def] of Object.entries(defs)) {
    out[key] = define(Object.freeze({ kind: "words", en: def.en.join("|"), de: def.de.join("|"), note: def.note ?? null }));
  }
  return Object.freeze(out) as { readonly [K in keyof T]: Message<never> };
}

export interface CatalogEntry {
  /** `<module>.<key>`, from the registry (`messages/index.ts`). */
  id: string;
  message: Message;
}

/** Built in, never translated. */
export const BUILTIN_LANGUAGES = ["en", "de"] as const;

function isBuiltin(lang: string): lang is (typeof BUILTIN_LANGUAGES)[number] {
  return (BUILTIN_LANGUAGES as readonly string[]).includes(lang);
}

/** Bumped when the translation prompt or the checks change, so cached catalogs are redone. */
const TRANSLATION_VERSION = 1;

/** Hash of the English catalog: a changed or new English line invalidates the cache. */
export function catalogHash(entries: readonly CatalogEntry[]): string {
  const lines = [...new Set(entries.map(({ message }) => `${message.kind}\u0000${message.en}`))].sort();
  return createHash("sha256").update(JSON.stringify([TRANSLATION_VERSION, lines])).digest("hex");
}

// ---------------------------------------------------------------------------
// Checks for one translated line
// ---------------------------------------------------------------------------

const WORD = /^[\p{L}\p{M}]+(?:['’ -][\p{L}\p{M}]+){0,2}$/u;
const MAX_WORDS = 10;
const MAX_WORD_CHARS = 32;

/** The digit runs of a text. */
function digitRuns(text: string): string[] {
  return text.match(/\d+/g) ?? [];
}

/** Characters a translation may only use when the English has them too. */
const GUARDED = ["<", ">", "*", "_", "`", "[", "]", "—", "–", "@", "/", "\\", "|", "\n", "\t"];

/**
 * Is `translated` an acceptable rendering of `message` in `lang`? Null when it
 * is, else the reason. Same placeholders, plural categories of the target
 * language, Serain's name kept, no new digits, links, markup or dashes,
 * bounded length. For `words`: short plain expressions only.
 */
export function checkTranslation(message: Message, translated: string, lang: string): string | null {
  const value = translated.trim();
  if (!value) return "empty";
  if (message.kind === "words") {
    const list = value.split("|").map((word) => word.trim());
    if (list.length > MAX_WORDS) return "too many words";
    for (const word of list) {
      if (!word || word.length > MAX_WORD_CHARS || !WORD.test(word)) return `not a short expression: ${word.slice(0, 40)}`;
    }
    return null;
  }
  if (value.length > Math.max(60, message.en.length * 3)) return "too long";
  let shape: ReturnType<typeof messageShape>;
  try {
    shape = messageShape(value);
  } catch {
    return "bad syntax";
  }
  const source = messageShape(message.en);
  const same = shape.args.size === source.args.size && [...shape.args].every((name) => source.args.has(name));
  if (!same) return "placeholders differ";
  const categories = new Set(pluralCategories(lang));
  const sourceExact = new Set(source.plurals.flatMap((plural) => plural.selectors.filter((selector) => selector.startsWith("="))));
  for (const plural of shape.plurals) {
    if (!source.plurals.some((other) => other.name === plural.name)) return `plural ${plural.name} not in the source`;
    for (const selector of plural.selectors) {
      if (selector.startsWith("=") ? !sourceExact.has(selector) : !categories.has(selector)) return `plural selector ${selector} not valid for ${lang}`;
    }
    for (const category of categories) {
      if (!plural.selectors.includes(category)) return `plural ${plural.name} misses ${category}`;
    }
  }
  const sourceText = messageText(message.en);
  const text = messageText(value);
  // Serain's name is part of the codewords ("serain resume") and is never translated.
  if ((text.match(/serain/gi) ?? []).length !== (sourceText.match(/serain/gi) ?? []).length) return "name changed";
  const digits = new Set(digitRuns(sourceText));
  if (digitRuns(text).some((run) => !digits.has(run))) return "new digits";
  if (/:\/\/|\bwww\./i.test(text) && !/:\/\/|\bwww\./i.test(sourceText)) return "new link";
  for (const char of GUARDED) {
    if (text.split(char).length > sourceText.split(char).length) return `new ${JSON.stringify(char)}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Translation through the model layer
// ---------------------------------------------------------------------------

export interface TranslationItem {
  id: string;
  kind: "text" | "words";
  en: string;
  de: string;
  note: string | null;
}

export interface TranslationRequest {
  language: string;
  /** CLDR plural categories of the target language. */
  pluralCategories: string[];
  items: TranslationItem[];
}

/** Translates one batch. Returns translated text by item id; missing ids stay English. */
export type Translator = (request: TranslationRequest) => Promise<Record<string, string>>;

const TRANSLATION_SCHEMA = z.object({
  translations: z.array(z.object({ id: z.string(), text: z.string() })),
});

export function translationPrompt(request: TranslationRequest): { system: string; prompt: string } {
  const name = new Intl.DisplayNames(["en"], { type: "language" }).of(request.language) ?? request.language;
  const system = [
    "You translate the fixed texts of Serain, a personal assistant that writes to its owner over iMessage like a friend:",
    "short, casual, natural, no filler phrases, no em dashes, lowercase where the source is lowercase.",
    "Rules:",
    "- Translate from the English text. The German text shows the intended tone; it is not the source.",
    "- Keep every placeholder in braces exactly as it is, e.g. {name}. Never translate, add or drop one.",
    `- Plurals use ICU syntax: {count, plural, one {…} other {…}}. Write one branch for each plural category of ${name}: ${request.pluralCategories.join(", ")}. Keep exact branches such as =0 if the source has them. # stands for the number.`,
    "- Do not add digits, links, markdown, emoji or dashes that the source does not have.",
    "- Items of kind \"words\" are lists of short expressions separated by |. Give the expressions a native speaker would type alone",
    "  in a chat to mean the same (at most 8, one to three words each, no punctuation), separated by |.",
    "- Quotation marks: use the ones that are usual in the target language.",
  ].join("\n");
  const prompt = [
    `Target language: ${name} (${request.language}).`,
    "Items (JSON):",
    JSON.stringify(request.items.map(({ id, kind, en, de, note }) => ({ id, kind, en, de, ...(note ? { note } : {}) }))),
    "Return every id with its translation.",
  ].join("\n");
  return { system, prompt };
}

/** The default translator: the cheap `extraction` role with structured output. */
const modelTranslator: Translator = async (request) => {
  const { runStructured } = await import("../agent/model.js");
  const { system, prompt } = translationPrompt(request);
  const result = await runStructured({
    role: "extraction",
    system,
    prompt,
    schema: TRANSLATION_SCHEMA,
    schemaName: "catalog_translation",
  });
  return Object.fromEntries(result.value.translations.map(({ id, text }) => [id, text]));
};

// ---------------------------------------------------------------------------
// Cache in agent_state
// ---------------------------------------------------------------------------

export interface CachedCatalog {
  hash: string;
  /** English source text → translation. Keyed by the source, so a changed line never keeps an old translation. */
  entries: Record<string, string>;
}

export interface CatalogStore {
  load(lang: string): Promise<CachedCatalog | null>;
  save(lang: string, value: CachedCatalog): Promise<void>;
}

const stateKey = (lang: string): string => `catalog:${lang}`;

/** Read once per language and process, written once per translation: not recurring, so `db` like the kill switch. */
const agentStateStore: CatalogStore = {
  async load(lang) {
    const { db } = await import("../db/client.js");
    const { data, error } = await db.from("agent_state").select("value").eq("key", stateKey(lang)).maybeSingle();
    if (error) throw new Error(`Catalog ${lang} not readable: ${error.message}`);
    const value = (data?.value ?? null) as Partial<CachedCatalog> | null;
    if (!value || typeof value.hash !== "string" || typeof value.entries !== "object" || value.entries === null) return null;
    const entries = Object.fromEntries(Object.entries(value.entries).filter((pair): pair is [string, string] => typeof pair[1] === "string"));
    return { hash: value.hash, entries };
  },
  async save(lang, value) {
    const { db } = await import("../db/client.js");
    const { error } = await db.from("agent_state").upsert({ key: stateKey(lang), value, updated_at: new Date().toISOString() });
    if (error) throw new Error(`Catalog ${lang} not saved: ${error.message}`);
  },
};

async function registryEntries(): Promise<CatalogEntry[]> {
  const { catalogEntries } = await import("./messages/index.js");
  return catalogEntries();
}

export interface CatalogDeps {
  store?: CatalogStore;
  translate?: Translator;
  /** The complete catalog; the registry by default. */
  entries?: () => Promise<CatalogEntry[]>;
  /** A failed translation is tried again after this long, not on every `t()`. */
  retryMs?: number;
  now?: () => number;
}

/** At most this many items and English characters per request, to stay well inside the output limit. */
const BATCH_ITEMS = 12;
const BATCH_CHARS = 1_000;
const RETRY_MS = 60 * 60_000;

export interface PrepareResult {
  translated: number;
  rejected: Array<{ id: string; reason: string }>;
  fromCache: number;
}

export class Catalog {
  /** Language → English source → accepted translation. */
  private readonly ready = new Map<string, Map<string, string>>();
  private readonly running = new Map<string, Promise<PrepareResult>>();
  private readonly retryAt = new Map<string, number>();
  private readonly store: CatalogStore;
  private readonly translate: Translator;
  private readonly entries: () => Promise<CatalogEntry[]>;
  private readonly retryMs: number;
  private readonly now: () => number;

  constructor(deps: CatalogDeps = {}) {
    this.store = deps.store ?? agentStateStore;
    this.translate = deps.translate ?? modelTranslator;
    this.entries = deps.entries ?? registryEntries;
    this.retryMs = deps.retryMs ?? RETRY_MS;
    this.now = deps.now ?? Date.now;
  }

  /** Is the catalog for this language loaded (possibly with English gaps)? */
  isReady(lang: string): boolean {
    return isBuiltin(lang) || this.ready.has(lang);
  }

  /**
   * The text of a message in a language, and the language it really is in:
   * the built-in English or German, an accepted translation, or English.
   * Starts preparing a missing language in the background.
   */
  lookup(message: Message, lang: string): { text: string; lang: string } {
    if (lang === "de") return { text: message.de, lang: "de" };
    if (lang === "en") return { text: message.en, lang: "en" };
    const translated = this.ready.get(lang)?.get(message.en);
    if (translated !== undefined) return { text: translated, lang };
    if (!this.ready.has(lang)) void this.prepare(lang).catch(() => undefined);
    return { text: message.en, lang: "en" };
  }

  /** Renders a message. Placeholder values go in verbatim, after translation. */
  render(message: Message, params: MessageParams | undefined, lang: string): string {
    if (message.kind !== "text") throw new Error("Word lists are read through words.ts, not t()");
    const { text, lang: used } = this.lookup(message, lang);
    try {
      return formatMessage(text, params ?? {}, currentLocale(used));
    } catch (error) {
      // A translation passed the checks, so this is a missing value in the caller: the English throws the same.
      if (used !== "en" && used !== "de") return formatMessage(message.en, params ?? {}, "en");
      throw error;
    }
  }

  /**
   * Installs translations (English source → text) for a language, each checked
   * like a model answer. Returns the rejected ones. Used after loading or
   * translating, and by tests for a translated catalog.
   */
  install(lang: string, translations: Record<string, string>): Array<{ en: string; reason: string }> {
    if (isBuiltin(lang)) throw new Error(`${lang} is built in`);
    const accepted = new Map<string, string>();
    const rejected: Array<{ en: string; reason: string }> = [];
    for (const [en, text] of Object.entries(translations)) {
      const message = defined.get(en);
      const reason = message ? checkTranslation(message, text, lang) : "not in the catalog";
      if (reason) rejected.push({ en, reason });
      else accepted.set(en, message!.kind === "words" ? normalizeWordList(text) : text.trim());
    }
    this.ready.set(lang, accepted);
    return rejected;
  }

  /**
   * Makes a language usable: cached translations at once, missing lines
   * through the translator. Once per language at a time; after a failure not
   * again before `retryMs`.
   */
  prepare(lang: string): Promise<PrepareResult> {
    if (isBuiltin(lang)) return Promise.resolve({ translated: 0, rejected: [], fromCache: 0 });
    const running = this.running.get(lang);
    if (running) return running;
    const retryAt = this.retryAt.get(lang);
    if (retryAt !== undefined && this.now() < retryAt) return Promise.resolve({ translated: 0, rejected: [], fromCache: 0 });
    const job = this.run(lang)
      .catch((error: unknown) => {
        log.error(`Catalog for ${lang} not prepared, English until then:`, error);
        this.retryAt.set(lang, this.now() + this.retryMs);
        return { translated: 0, rejected: [], fromCache: 0 };
      })
      .finally(() => this.running.delete(lang));
    this.running.set(lang, job);
    return job;
  }

  private async run(lang: string): Promise<PrepareResult> {
    const entries = await this.entries();
    const hash = catalogHash(entries);
    const unique = new Map<string, CatalogEntry>();
    for (const entry of entries) if (!unique.has(entry.message.en)) unique.set(entry.message.en, entry);

    let cached: CachedCatalog | null = null;
    try {
      cached = await this.store.load(lang);
    } catch (error) {
      log.warn(`Cached catalog for ${lang} not readable:`, (error as Error).message);
    }
    // Only lines whose English source still exists, checked again.
    const known: Record<string, string> = {};
    for (const [en, text] of Object.entries(cached?.entries ?? {})) if (unique.has(en)) known[en] = text;
    this.install(lang, known);
    const fromCache = this.ready.get(lang)?.size ?? 0;
    if (cached?.hash === hash) return { translated: 0, rejected: [], fromCache };

    const accepted = new Map(this.ready.get(lang));
    const missing = [...unique.values()].filter((entry) => !accepted.has(entry.message.en));
    const rejected: Array<{ id: string; reason: string }> = [];
    let complete = true;
    let translated = 0;
    const categories = pluralCategories(lang);
    for (const batch of batches(missing)) {
      let answer: Record<string, string>;
      try {
        answer = await this.translate({
          language: lang,
          pluralCategories: categories,
          items: batch.map(({ id, message }) => ({ id, kind: message.kind, en: message.en, de: message.de, note: message.note })),
        });
      } catch (error) {
        log.warn(`Catalog batch for ${lang} failed:`, (error as Error).message);
        complete = false;
        continue;
      }
      for (const { id, message } of batch) {
        const text = answer[id];
        if (typeof text !== "string") {
          rejected.push({ id, reason: "missing" });
          continue;
        }
        const reason = checkTranslation(message, text, lang);
        if (reason) {
          rejected.push({ id, reason });
          continue;
        }
        accepted.set(message.en, message.kind === "words" ? normalizeWordList(text) : text.trim());
        translated += 1;
      }
    }
    this.ready.set(lang, accepted);
    if (rejected.length > 0) log.warn(`Catalog ${lang}: ${rejected.length} lines stay English (${rejected.slice(0, 5).map((r) => `${r.id}: ${r.reason}`).join("; ")})`);
    // Incomplete (a batch failed): saved without the hash, so the next start asks for the rest.
    await this.store
      .save(lang, { hash: complete ? hash : "", entries: Object.fromEntries(accepted) })
      .catch((error: unknown) => log.warn(`Catalog ${lang} not cached:`, (error as Error).message));
    if (!complete) this.retryAt.set(lang, this.now() + this.retryMs);
    log.info(`Catalog ${lang}: ${translated} lines translated, ${fromCache} from cache, ${rejected.length} rejected`);
    return { translated, rejected, fromCache };
  }

  /** The accepted list for a `words` message in a language, or null (not translated, or built in). */
  translatedWords(message: Message, lang: string): string[] | null {
    if (isBuiltin(lang)) return null;
    const value = this.ready.get(lang)?.get(message.en);
    if (value === undefined) {
      if (!this.ready.has(lang)) void this.prepare(lang).catch(() => undefined);
      return null;
    }
    return value.split("|");
  }
}

function normalizeWordList(text: string): string {
  return text
    .split("|")
    .map((word) => word.trim().replace(/\s+/g, " "))
    .join("|");
}

function* batches(entries: readonly CatalogEntry[]): Generator<CatalogEntry[]> {
  let batch: CatalogEntry[] = [];
  let chars = 0;
  for (const entry of entries) {
    if (batch.length > 0 && (batch.length >= BATCH_ITEMS || chars + entry.message.en.length > BATCH_CHARS)) {
      yield batch;
      batch = [];
      chars = 0;
    }
    batch.push(entry);
    chars += entry.message.en.length;
  }
  if (batch.length > 0) yield batch;
}

/** The process-wide catalog. */
export const catalog = new Catalog();

// A switch to a language without a catalog starts its translation right away.
onLanguageChange((lang) => {
  if (!catalog.isReady(lang)) void catalog.prepare(lang);
});

type TArgs<P extends string> = [P] extends [never]
  ? [params?: Record<string, never>, lang?: string]
  : [params: Readonly<Record<P, string | number>>, lang?: string];

/**
 * Renders a fixed text in the owner's current language (or `lang`). Values
 * are inserted verbatim; numbers get the locale's decimal sign.
 */
export function t<P extends string>(message: Message<P>, ...[params, lang = currentLanguage()]: TArgs<P>): string {
  return catalog.render(message, params as MessageParams | undefined, lang);
}

/**
 * The language a message will really be rendered in: `lang` when built in or
 * translated, else English. For callers that format dates or lists around a
 * text, so the frame and its parts stay in one language.
 */
export function textLanguage(message: Message, lang: string = currentLanguage()): string {
  return catalog.lookup(message, lang).lang;
}

/** Installs a translated catalog for a language (checked line by line). For tests and tools. */
export function installTranslations(lang: string, translations: Record<string, string>): Array<{ en: string; reason: string }> {
  return catalog.install(lang, translations);
}
