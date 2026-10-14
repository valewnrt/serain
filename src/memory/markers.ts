import { createHmac } from "node:crypto";
import { owner } from "../config/owner.js";

/**
 * Markers for forgotten facts (D40). A deletion list that contains the
 * deleted content itself would be no deletion. That is why for every
 * forgotten fact `forgotten_markers` only holds a set of HMACs of its
 * distinctive words, with a key that lives only in the server's env.
 *
 * What for: the nightly consolidation and `memory:push` must not bring back
 * what was forgotten. The consolidation no longer sees it in its inputs (fact,
 * summaries and user model are cleaned), a model can still write it out of
 * nothing, and the owner's local `data/user-model.md` does not know about the
 * deletion at all. The marker is the belt to these braces.
 *
 * Limit, honestly: words, not meaning. A paraphrase without the distinctive
 * words slips through; a new sentence that happens to share two of them is
 * rejected. That is the right direction for an error.
 *
 * **Languages.** Which words are distinctive is decided by length (five
 * letters or more, numbers from four digits) and by the filler word lists
 * below, built in for English and German and always applied together (facts,
 * the user model and the owner's words can mix both). In any other language
 * no filler word is filtered out, so more of its words count as distinctive:
 * `forget_fact` deletes facts that share two of them rather than keeping them
 * (when in doubt, delete), and a text in that language that shares the
 * marker's filler words is rejected sooner (when in doubt, keep the old user
 * model). Both are the cautious direction. The limit above stays: a marker is
 * words, so a paraphrase in another language slips through in any case.
 */

/**
 * Frequent words that reveal nothing about a fact, plus the owner's name (it
 * is the subject of every fact). Kept short: everything under five letters
 * drops out anyway. Compared in normalised form (`normalize`).
 */
const FILLER_WORDS: Readonly<Record<"en" | "de", readonly string[]>> = {
  en: [
    "forget", "forgot", "forgotten", "please", "never", "always", "again", "about", "these", "those",
    "there", "their", "theirs", "which", "would", "could", "should", "might", "because", "while",
    "after", "before", "other", "others", "still", "really", "maybe", "today", "tomorrow", "right",
    "thing", "things", "something", "nothing", "everything", "anything", "where", "being", "having",
    "without", "through", "between", "against", "during", "under", "above", "rather", "doesn",
    "didn", "wasn", "weren", "haven", "hasn", "shouldn", "wouldn", "couldn", "user", "users",
  ],
  de: [
    "vergiss", "vergessen", "bitte", "nicht", "keine", "keinen", "einen", "einem", "einer", "eines",
    "diese", "dieser", "dieses", "immer", "schon", "wieder", "gerade", "jetzt", "heute", "morgen",
    "sein", "seine", "seiner", "seinen", "ihrer", "unser", "dass", "damit", "wenn", "weil", "aber",
    "oder", "sondern", "haben", "hatte", "wurde", "werden", "worden", "kann", "könnte", "müssen",
    "sollte", "würde", "gerne", "lieber", "selbst", "etwas", "nichts", "alles", "andere", "anderen",
    "zwischen", "während", "nach", "über", "unter", "durch", "gegen", "ohne", "mehr", "weniger",
    "nutzer", "nutzers",
  ],
};

/** A word in comparable form: lowercase, without accents, ß as ss. */
function normalize(word: string): string {
  return word.toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "").replace(/ß/g, "ss");
}

/** All words of a text in comparable form, in order. */
export function normalizedWords(text: string): string[] {
  return text.split(/[^\p{L}\p{N}]+/u).filter(Boolean).map(normalize);
}

const STOPWORDS = new Set([
  ...[...FILLER_WORDS.en, ...FILLER_WORDS.de].map(normalize),
  "serain",
  ...normalizedWords(`${owner.name} ${owner.genitive} ${owner.possessive}`),
]);

/** The distinctive words of a text: five letters or more, no filler words, no plain numbers under four digits. */
export function distinctiveTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const raw of text.split(/[^\p{L}\p{N}]+/u)) {
    const word = normalize(raw);
    if (/^\d+$/.test(word) ? word.length < 4 : [...word].length < 5) continue;
    if (STOPWORDS.has(word)) continue;
    tokens.add(word);
  }
  return tokens;
}

export function tokenHmac(key: Buffer, token: string): string {
  return createHmac("sha256", key).update(token, "utf8").digest("hex");
}

/**
 * A marker only counts from two distinctive words. With a single word
 * ("Mainz") it would block every later sentence about that city.
 */
export const MIN_MARKER_TOKENS = 2;

export function markerFor(key: Buffer, text: string): string[] | null {
  const hmacs = [...distinctiveTokens(text)].map((token) => tokenHmac(key, token));
  return hmacs.length >= MIN_MARKER_TOKENS ? hmacs : null;
}

/**
 * Does `text` carry one of the markers? A hit means: at least two and at
 * least 60 % of the marker's words are in it. `exempt` are texts the owner has
 * said again themself since (current facts): if they tell it anew, that is
 * their decision, and the marker no longer applies to it.
 */
export function matchesMarker(
  key: Buffer,
  markers: readonly (readonly string[])[],
  text: string,
  exempt: readonly string[] = [],
): boolean {
  const present = new Set([...distinctiveTokens(text)].map((token) => tokenHmac(key, token)));
  const allowed = new Set(exempt.flatMap((entry) => [...distinctiveTokens(entry)].map((token) => tokenHmac(key, token))));
  for (const marker of markers) {
    const hits = marker.filter((hmac) => present.has(hmac) && !allowed.has(hmac)).length;
    if (hits >= MIN_MARKER_TOKENS && hits >= Math.ceil(marker.length * 0.6)) return true;
  }
  return false;
}

/** Key for the markers, derived from the integration key. Without it there are no markers. */
export function markerKeyFrom(integrationKey: string): Buffer | null {
  if (!integrationKey) return null;
  return createHmac("sha256", integrationKey).update("serain/forgotten-markers/v1").digest();
}
