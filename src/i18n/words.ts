import { catalog, type Message } from "./catalog.js";
import { currentLanguage } from "./language.js";
import { words } from "./messages/words.js";

/**
 * The words the code reads from the owner without the model: consent in the
 * thread of a preview (D8.3) and the codewords after "serain" (D8.2, W4).
 *
 * Safety rules, all here and nowhere else:
 * - Accepted is the union of English, German and the current language. The
 *   current language's words come from the translated catalog and only after
 *   its line check (short plain expressions); until then English and German.
 * - A word that is both yes and no counts as no. `stop` beats `revoke` beats
 *   `resume`: on a doubt the safer command wins.
 * - Only a whole message is a decision: one yes word, or one yes word plus one
 *   always word. Anything else, in any language, is never consent; it goes to
 *   the model as conversation, and the model cannot approve anything.
 * - 👍 and 👎 work in every language (`decisionFromReaction`).
 */

export type WordKind = keyof typeof words;
export type Consent = "approve" | "approve_standing" | "deny";
export type Command = "stop" | "resume" | "revoke";

/** Case, accents, apostrophes and spacing do not matter: "Nö", "no", "NO" compare equal. */
export function normalizePhrase(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[’‘`´]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** The words of one kind in one language, display form, first one preferred. Null when not available. */
function listOf(message: Message, lang: string): string[] | null {
  if (lang === "en") return message.en.split("|");
  if (lang === "de") return message.de.split("|");
  return catalog.translatedWords(message, lang);
}

const sets = new Map<string, ReadonlySet<string>>();

/** All accepted words of a kind: English, German and `lang`, normalized. */
export function wordSet(kind: WordKind, lang: string = currentLanguage()): ReadonlySet<string> {
  const message = words[kind];
  const lists = [listOf(message, "en"), listOf(message, "de"), lang === "en" || lang === "de" ? null : listOf(message, lang)];
  // Cached per list content: a newly installed translation yields a new key.
  const key = `${kind}\u0000${lists.map((list) => list?.join("|") ?? "").join("\u0001")}`;
  let found = sets.get(key);
  if (!found) {
    found = new Set(lists.flatMap((list) => list ?? []).map(normalizePhrase).filter(Boolean));
    sets.set(key, found);
  }
  return found;
}

/**
 * The word fixed texts show for a kind: the first of the current language,
 * else the English one. Always a member of `wordSet(kind, lang)`.
 */
export function primaryWord(kind: WordKind, lang: string = currentLanguage()): string {
  const message = words[kind];
  return listOf(message, lang)?.[0] ?? message.en.split("|")[0]!;
}

/** Trailing ".", "!" and "…" do not change a decision ("ja!", "no."). */
function phraseOf(text: string): string {
  return normalizePhrase(text).replace(/[\s.!…]+$/u, "");
}

/**
 * A whole message as a decision on a preview, or null (conversation).
 * "yes", "yes always", "no" in English, German and the current language.
 */
export function parseConsent(text: string, lang: string = currentLanguage()): Consent | null {
  const phrase = phraseOf(text);
  if (!phrase || phrase.length > 60) return null;
  const yes = wordSet("yes", lang);
  const no = wordSet("no", lang);
  if (no.has(phrase)) return "deny";
  for (const always of wordSet("always", lang)) {
    if (!phrase.endsWith(always) || phrase.length === always.length) continue;
    const before = phrase.slice(0, -always.length);
    // "ja immer", "yes, always"; never "jaimmer" glued together.
    if (!/[\s,]$/.test(before)) continue;
    const head = before.replace(/[\s,]+$/, "");
    if (no.has(head)) return "deny";
    if (yes.has(head)) return "approve_standing";
  }
  if (yes.has(phrase)) return "approve";
  return null;
}

const ORDER: readonly Command[] = ["stop", "revoke", "resume"];

/**
 * "serain <word>" at the start of a message: stop, revoke or resume. The word
 * must end there (end, space or punctuation): "serain stoppuhr" is nothing.
 * "serain stop" and "serain stopp" work in every language.
 */
export function parseCommand(text: string, lang: string = currentLanguage()): Command | null {
  const match = /^serain[\s,]+(.+)$/su.exec(normalizePhrase(text));
  if (!match) return null;
  const rest = match[1]!;
  for (const command of ORDER) {
    for (const word of wordSet(command, lang)) {
      if (!rest.startsWith(word)) continue;
      const next = rest.slice(word.length, word.length + 1);
      if (next === "" || /[\s\p{P}\p{S}]/u.test(next)) return command;
    }
  }
  return null;
}
