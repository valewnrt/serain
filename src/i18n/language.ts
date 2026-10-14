import { owner } from "../config/owner.js";
import { log } from "../log.js";

/**
 * The owner's language. Serain answers in the language the owner writes in, in
 * any language. The model sees that from the chat itself; this module is for
 * everything that goes to the owner past the model (fixed texts through
 * `t()`, dates through `Intl`) and for the word lists of the confirmation
 * protocol (`words.ts`).
 *
 * Detection runs on every inbound owner message (`observeOwnerText`), after the
 * ingress allowlist and after a login code was intercepted, never on foreign
 * content. It uses `eld` (Efficient Language Detector, Apache-2.0, pure
 * JavaScript, no native build): chosen 2026-10-14 over `tinyld` (MIT) on 65
 * short chat sentences in de/en/tr/es/fr, where `eld` got all of them right,
 * `tinyld/light` missed two and the full `tinyld` was three times slower.
 * The `small` database is loaded lazily, so tests and tools that never detect
 * anything do not pay for it.
 *
 * Hysteresis: short messages ("ok", "ja", an emoji, a link, a number, a
 * codeword like "serain stop") change nothing. A clear message of four words
 * or more switches at once; a shorter readable one (three words) only when the
 * next readable message says the same. A mixed
 * message keeps whatever the detector puts first, which is the language of
 * the sentence, not of a borrowed word.
 *
 * The result lives in `agent_state.owner_language`, so a restart keeps it.
 * Reading happens once at start and writing only on a switch, neither recurs
 * on a timer, so both go through `db` like the kill switch's write (the
 * `serain_server` role of `pg.ts` may only read the recurring keys). `db` is
 * imported on first use, so modules that only render texts do not need the
 * database configuration.
 */

export const LANGUAGE_STATE_KEY = "owner_language";

/** What the detector decided about one message. */
export interface Detection {
  /** Base language (`de`), or null when nothing was recognised. */
  language: string | null;
  /** Clear enough to switch on its own. */
  sure: boolean;
  /** Long enough to count at all (as the first of two in a row). */
  readable: boolean;
}

export interface StoredLanguage {
  code: string;
  since: string;
  source: "text";
}

/** The seam to `agent_state`, so the state machine is testable without Supabase. */
export interface LanguageStore {
  load(): Promise<StoredLanguage | null>;
  save(value: StoredLanguage): Promise<void>;
}

export type Detector = (text: string) => { language: string; scores: Record<string, number>; reliable: boolean };

/** Fewer letters or words than this never count. */
const MIN_LETTERS = 10;
const MIN_WORDS = 3;
/** From here on a reliable detection switches at once. */
const SURE_LETTERS = 20;
const SURE_WORDS = 4;
/** The runner-up must be at least this far behind for a sure switch. */
const SURE_MARGIN = 0.04;
/** Longer texts are cut before detection; the first sentences say enough. */
const MAX_CHARS = 600;

const URL = /\b(?:https?:\/\/|www\.)\S+/giu;
const EMAIL = /\S+@\S+\.\S+/gu;
const NON_LETTERS = /[^\p{L}\p{M}\s'’-]+/gu;
/** Serain's own name says nothing about the language ("serain stop" read as French). */
const OWN_NAME = /^serain$/i;

/** The letters and words of a message, without links, addresses, numbers, emoji and Serain's name. */
export function wordsOf(text: string): string[] {
  return text
    .slice(0, MAX_CHARS)
    .replace(URL, " ")
    .replace(EMAIL, " ")
    .replace(NON_LETTERS, " ")
    .split(/\s+/u)
    .map((word) => word.replace(/^['’-]+|['’-]+$/gu, ""))
    .filter((word) => /\p{L}/u.test(word) && !OWN_NAME.test(word));
}

/** A language tag `Intl` knows, reduced to its base subtag; null otherwise. */
export function baseLanguage(tag: string): string | null {
  try {
    const [canonical] = Intl.getCanonicalLocales(tag);
    if (!canonical) return null;
    const base = new Intl.Locale(canonical).language;
    return /^[a-z]{2,3}$/.test(base) ? base : null;
  } catch {
    return null;
  }
}

/** Classifies one message with a detector. Pure, for tests and for `OwnerLanguage`. */
export function classify(text: string, detect: Detector): Detection {
  const words = wordsOf(text);
  const letters = words.join("").replace(/[^\p{L}]/gu, "").length;
  if (words.length < MIN_WORDS || letters < MIN_LETTERS) return { language: null, sure: false, readable: false };
  const result = detect(words.join(" "));
  const language = result.language ? baseLanguage(result.language) : null;
  if (!language || !result.reliable) return { language: null, sure: false, readable: false };
  const ranked = Object.values(result.scores).sort((a, b) => b - a);
  const margin = (ranked[0] ?? 0) - (ranked[1] ?? 0);
  const sure = words.length >= SURE_WORDS && letters >= SURE_LETTERS && margin >= SURE_MARGIN;
  return { language, sure, readable: true };
}

let eldDetector: Detector | null = null;
let eldLoading: Promise<Detector> | null = null;

/** Loads `eld/small` once (about 100 ms, about 150 MB). */
export function loadEld(): Promise<Detector> {
  if (eldDetector) return Promise.resolve(eldDetector);
  eldLoading ??= import("eld/small").then(({ eld }) => {
    const detector: Detector = (text) => {
      const result = eld.detect(text);
      return { language: result.language, scores: result.getScores(), reliable: result.isReliable() };
    };
    eldDetector = detector;
    return detector;
  });
  return eldLoading;
}

const agentStateStore: LanguageStore = {
  async load() {
    const { db } = await import("../db/client.js");
    const { data, error } = await db.from("agent_state").select("value").eq("key", LANGUAGE_STATE_KEY).maybeSingle();
    if (error) throw new Error(`Owner language not readable: ${error.message}`);
    const value = (data?.value ?? null) as Partial<StoredLanguage> | null;
    const code = typeof value?.code === "string" ? baseLanguage(value.code) : null;
    if (!code) return null;
    return { code, since: typeof value?.since === "string" ? value.since : new Date(0).toISOString(), source: "text" };
  },
  async save(value) {
    const { db } = await import("../db/client.js");
    const { error } = await db
      .from("agent_state")
      .upsert({ key: LANGUAGE_STATE_KEY, value, updated_at: new Date().toISOString() });
    if (error) throw new Error(`Owner language not saved: ${error.message}`);
  },
};

export type LanguageListener = (language: string) => void;

export interface OwnerLanguageDeps {
  store?: LanguageStore;
  /** Synchronous detector; without one, `eld` is loaded on first use. */
  detector?: Detector;
  /** Starting language, `owner.language` by default. */
  fallback?: string;
  now?: () => Date;
}

/**
 * The state machine behind `currentLanguage()`. One instance per process
 * (`ownerLanguage`); tests build their own with a fake store and detector.
 */
export class OwnerLanguage {
  private code: string;
  /** A readable but not sure detection that waits for a second one. */
  private candidate: string | null = null;
  private readonly store: LanguageStore;
  private readonly fallback: string;
  private readonly now: () => Date;
  private detector: Detector | null;
  private readonly listeners = new Set<LanguageListener>();

  constructor(deps: OwnerLanguageDeps = {}) {
    this.store = deps.store ?? agentStateStore;
    this.fallback = deps.fallback ?? owner.language;
    this.code = this.fallback;
    this.detector = deps.detector ?? null;
    this.now = deps.now ?? (() => new Date());
  }

  get current(): string {
    return this.code;
  }

  /** Called with the new language after every switch and after `load`. */
  onChange(listener: LanguageListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * At start: the stored language, or the starting one. An unreadable state
   * keeps the starting language and is only logged; language is comfort, not
   * a safety gate. Starts loading the detector in the background.
   */
  async load(): Promise<string> {
    if (!this.detector) void loadEld().then((detector) => (this.detector ??= detector)).catch((error: unknown) => log.error("Language detector not loadable:", error));
    try {
      const stored = await this.store.load();
      this.code = stored?.code ?? this.fallback;
    } catch (error) {
      log.error("Owner language not readable, keeping the starting language:", (error as Error).message);
      this.code = this.fallback;
    }
    this.candidate = null;
    this.notify();
    return this.code;
  }

  /**
   * One message from the owner. Once the detector is loaded (`load` starts
   * that at boot), the in-memory language switches synchronously, before the
   * first `await`: a caller that does not wait still renders the next fixed
   * text in the new language. The returned promise only covers loading the
   * detector (if it was not loaded yet) and saving a switch.
   */
  observe(text: string): Promise<void> {
    if (!this.detector) {
      return loadEld().then((detector) => {
        this.detector ??= detector;
        return this.observe(text);
      });
    }
    const switched = this.step(classify(text, this.detector));
    if (!switched) return Promise.resolve();
    return this.store.save({ code: switched, since: this.now().toISOString(), source: "text" });
  }

  /** The hysteresis. Returns the new language on a switch, else null. */
  private step(detection: Detection): string | null {
    const { language } = detection;
    if (!detection.readable || !language) return null;
    if (language === this.code) {
      this.candidate = null;
      return null;
    }
    if (!detection.sure && this.candidate !== language) {
      this.candidate = language;
      return null;
    }
    this.code = language;
    this.candidate = null;
    log.info(`Owner language is now ${language}`);
    this.notify();
    return language;
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener(this.code);
      } catch (error) {
        log.error("Language listener failed:", error);
      }
    }
  }
}

/** The process-wide instance. */
export const ownerLanguage = new OwnerLanguage();

/** Base language of the owner right now (`de`, `en`, `tr`). Synchronous. */
export function currentLanguage(): string {
  return ownerLanguage.current;
}

/**
 * Locale for `Intl` in the current language: the full `OWNER_LANGUAGE` tag
 * while the owner still writes in that language (`de-AT`), else the base.
 */
export function currentLocale(language: string = currentLanguage()): string {
  return baseLanguage(owner.locale) === language ? owner.locale : language;
}

/** Loads the stored language at start. */
export function loadOwnerLanguage(): Promise<string> {
  return ownerLanguage.load();
}

/** See `OwnerLanguage.observe`: the switch is synchronous, the promise is persistence. */
export function observeOwnerText(text: string): Promise<void> {
  return ownerLanguage.observe(text);
}

export function onLanguageChange(listener: LanguageListener): () => void {
  return ownerLanguage.onChange(listener);
}
