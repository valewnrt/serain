import { baseLanguage, classify as detectLanguage, loadEld, type Detector } from "../i18n/language.js";

/**
 * What an element on a page does (D63, part C). The same rules guard forms
 * (`src/forms/session.ts`), logged-in sessions (`src/sites/session.ts`) and the
 * browser pilot (`src/browser/pilot.ts`). Four kinds:
 *
 * - `money`: buy, order, book, pay, with a charge. Never, not even with a
 *   preview: money is phase 5 (D8, W18). "Book" belongs here even when a
 *   doctor's appointment costs nothing: in an account with a stored payment
 *   method the label cannot tell the difference (W1). Undoing ("revoke order")
 *   is not a purchase as long as no purchase word stands there besides the object.
 * - `commit`: every button that submits a form, whatever its name (also "next":
 *   a multi-page form on the server sends at every step), and every other
 *   element whose label sounds like submitting, confirming, cancelling or
 *   deleting, a link too (actions by GET). Only through `form_submit`, i.e.
 *   with a preview and the owner's 👍.
 * - `next`, `plain`: everything else, e.g. a "next" that only opens a section of
 *   the same page, tabs, checkboxes. The executor may click those itself.
 *
 * Signals in this order (principle 3 of the language spec, `src/i18n/README.md`):
 *
 * 1. **Language neutral first.** HTML says more than words: a submit button
 *    (`type=submit`), a price with a currency on the element, a link or form
 *    target on a checkout or payment path, payment fields on the page
 *    (`autocomplete=cc-*`). These hold on every page in every language.
 * 2. **Words in English and German**, the built-in lists below.
 * 3. **Fail closed** on a page in any other language (`<html lang>`, or a text
 *    sample through the language detector of `src/i18n/language.ts`): the word
 *    lists know nothing there, so every element that may have an effect counts
 *    as `commit` (preview first, or not at all where there is no preview), and
 *    a price on the element makes it `money`. Plain stays only what is
 *    harmless by structure: checkboxes, radio buttons, tabs, options, calendar
 *    cells, disclosures, symbols, and links to ordinary paths.
 *
 * Every label the element carries is checked (visible text, `aria-label`,
 * `title`, value): a page must not be able to present a delete button as
 * "show more". Patterns over labels stay a belt; the boundary is that submit
 * buttons are never clicked directly and Enter never submits (security review
 * of 2026-10-13).
 */

export type ButtonKind = "money" | "next" | "commit" | "plain";

/** Languages whose words the patterns below know. Every other language is fail closed. */
export const WORD_LANGUAGES: ReadonlySet<string> = new Set(["en", "de"]);

export const MONEY_PATTERN =
  /(kaufen\b|\bbestell|zahlungspflichtig|kostenpflichtig|bezahl|\bzahlen\b|zur kasse|\bcheckout\b|warenkorb|jetzt buchen|buchen\b|abonnieren|\bbuy\b|\bpay\b|purchase|place order|add to (cart|basket)|subscribe)/i;

const COMMIT_PATTERN =
  /(absend|abschick|\bsenden\b|einreich|beantrag|bestätig|bestaetig|eintragen|kündig|kuendig|widerruf|widersprech|lösch|loesch|entfern|registrier|abmelden|austragen|speichern|übermitteln|zustimm|akzeptier|einwillig|\bsubmit\b|\bsend\b|\bconfirm|\bapply\b|\bdelete\b|\bremove\b|\bcancel\b|unsubscribe|register|\bsave\b|\bagree\b|\baccept\b)/i;

const NEXT_PATTERN = /^\s*(weiter|nächste[rs]?( schritt)?|naechste[rs]?|fortfahren|continue|next|zurück|zurueck|back)\s*[›»>→]*\s*$/i;

/** What costs money in any case, whatever else stands there. */
const PAYING_PATTERN = /(zahlungspflichtig|kostenpflichtig|bezahl|\bzahlen\b|zur kasse|\bcheckout\b|\bpay\b)/i;

/** Undoing instead of buying: "revoke order", "cancel subscription", "cancel booking". */
const UNDO_PATTERN = /(widerruf|kündig|kuendig|storn|\bcancel|zurückgeb|zurueckgeb|rücksend|ruecksend|retour|reklam|erstatt)/i;

/** The object that is undone: without it, only whether anything else is bought remains. */
const UNDO_OBJECT = /(bestellung\w*|buchung\w*|abonnement\w*|\babos?\b|\border\b|booking|subscription)/gi;

/**
 * Fields that look like payment data: on such a page the code submits nothing. Matched against label, name and
 * `autocomplete`; `autocomplete=cc-*` counts on its own (`readFieldsInPage`, `collectPage`). The words beyond
 * English and German are a bonus, not a promise.
 */
export const PAYMENT_FIELD =
  /(karten?nummer|card ?number|cardnumber|cc[-_ ]?(number|num|exp|csc|cvc)|\bcvc\b|\bcvv\b|\bcvn\b|prüfziffer|ablaufdatum|expir|\biban\b|\bbic\b|kontonummer|bankleitzahl|lastschrift|sepa|tarjeta|carte bancaire|numéro de carte|kart numaras|kredi kart|numero carta|cartão|カード番号|卡号|카드번호|номер карты)/i;

const CURRENCY = String.raw`[€$£¥₺₹₽₩₪₫฿₴₦₱₲₵₡]|R\$|(?<!\p{L})(?:eur|usd|gbp|chf|try|tl|jpy|cny|rmb|inr|rub|pln|zł|sek|nok|dkk|kr|czk|kč|huf|ft|brl|mxn|aud|cad|nzd|zar|aed|sar|krw|ils|lei|ron)(?!\p{L})`;
const AMOUNT = String.raw`\d{1,3}(?:[.,\s  ]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?`;

/** A price: an amount next to a currency, in either order ("12,99 €", "$5", "299 TL", "¥1,200"). Language neutral. */
export const PRICE_PATTERN = new RegExp(String.raw`(?:${CURRENCY})\s?(?:${AMOUNT})|(?:${AMOUNT})\s?(?:${CURRENCY})`, "iu");

/** A link or form target on a path that pays: checkout, payment, cart. URLs are mostly English, whatever the page's language. */
const MONEY_TARGET = /(?:^|[/?#&=._-])(?:checkout|check-out|payments?|pay|paypal|purchase|buy|cart|basket|kasse|warenkorb|billing)(?=$|[/?#&=._-])/i;
/** A target that acts: deleting, cancelling, transferring. */
const ACTION_TARGET = /(?:^|[/?#&=._-])(?:delete|remove|cancel(?:lation)?|unsubscribe|terminate|transfer|close-account|deactivate)(?=$|[/?#&=._-])/i;
/** On a page in another language a target that may act counts too: confirming, sending, booking, signing up. */
const MAYBE_ACTION_TARGET = /(?:^|[/?#&=._-])(?:confirm\w*|submit|send|book(?:ing)?|reserv\w*|order|apply|register|signup|sign-up|subscribe|join|accept|agree|consent|logout|signout)(?=$|[/?#&=._-])/i;

/** Roles that only change a value or a view on the same page. Harmless on a page in any language. */
const VIEW_ROLES = new Set(["checkbox", "radio", "tab", "option", "menuitemradio", "menuitemcheckbox", "gridcell", "treeitem", "combobox", "readonly field, opens a picker"]);

/** No letters at all: arrows, numbers, symbols ("›", "2", "+"). */
const NO_WORDS = /^[^\p{L}]*$/u;

export interface ButtonContext {
  /** Submits a form in HTML terms (`type=submit`/`image`, or a `button` without a type in a form). */
  submits: boolean;
  /** Where a link leads or a submit button sends to (path and query are enough). */
  target?: string | null;
  /** Kind of element from the page snapshot (`link`, `button`, …). */
  kind?: string;
  /** Role from the page snapshot (`checkbox`, `tab`, …). */
  role?: string;
  /** State from the page snapshot (`expanded`, `collapsed`, …). */
  state?: string;
  /** The page reads in a language outside `WORD_LANGUAGES` (or none could be told): fail closed. */
  foreign?: boolean;
  /** The page (or the element's form) has payment fields. */
  payment?: boolean;
}

function cleanLabels(labels: string | readonly string[]): string[] {
  return (typeof labels === "string" ? [labels] : labels).map((label) => label.replace(/[​-‏⁠﻿­]/g, "").trim()).filter(Boolean);
}

function moneyWords(label: string): boolean {
  if (PAYING_PATTERN.test(label)) return true;
  if (UNDO_PATTERN.test(label)) return MONEY_PATTERN.test(label.replace(UNDO_OBJECT, " "));
  return MONEY_PATTERN.test(label);
}

/** Money by language-neutral signals or English/German words. The pilot uses it next to its own words for the rest. */
export function looksLikeMoney(labels: string | readonly string[], context: ButtonContext): boolean {
  const all = cleanLabels(labels);
  if (all.some(moneyWords)) return true;
  if (context.target && MONEY_TARGET.test(context.target)) return true;
  const priced = all.some((label) => PRICE_PATTERN.test(label));
  // A submit button with a price ("12,99 € zahlen", "Öde 299 TL") pays; so does any submit on a page with payment fields.
  if (context.submits && (priced || context.payment)) return true;
  // In a language without word lists a price on anything that may act is enough.
  return Boolean(context.foreign && priced && !VIEW_ROLES.has(context.role ?? ""));
}

/** Does a link or submit target act (delete, cancel, transfer; on a foreign page also confirm, send, book, sign up), or is it a script? */
export function targetActs(target: string | null | undefined, foreign: boolean): boolean {
  if (!target) return false;
  if (target === "javascript:") return foreign;
  return ACTION_TARGET.test(target) || (foreign && MAYBE_ACTION_TARGET.test(target));
}

/** Harmless by structure alone, in any language: a view control, a disclosure, a symbol, a link to an ordinary path. */
function harmlessByStructure(all: readonly string[], context: ButtonContext): boolean {
  if (context.submits) return false;
  if (VIEW_ROLES.has(context.role ?? "")) return true;
  if (/\b(expanded|collapsed)\b/.test(context.state ?? "")) return true;
  if (all.length > 0 && all.every((label) => NO_WORDS.test(label))) return true;
  if (context.kind === "link" && context.target) return !targetActs(context.target, true);
  return false;
}

/** `labels`: every label of the element. Empty ones do not count. */
export function classifyButton(labels: string | readonly string[], context: ButtonContext): ButtonKind {
  const all = cleanLabels(labels);
  if (looksLikeMoney(all, context)) return "money";
  if (context.submits) return "commit";
  if (all.some((label) => UNDO_PATTERN.test(label) || COMMIT_PATTERN.test(label))) return "commit";
  if (targetActs(context.target, context.foreign === true)) return "commit";
  if (context.foreign) {
    if (!harmlessByStructure(all, context)) return "commit";
    return all.length > 0 && all.every((label) => NO_WORDS.test(label) && /[›»>→]/.test(label)) ? "next" : "plain";
  }
  return all.length > 0 && all.every((label) => NEXT_PATTERN.test(label)) ? "next" : "plain";
}

/** What a page says about its language: the `lang` attribute and a sample of its text. */
export interface PageLanguageInput {
  lang?: string | null;
  title?: string;
  text: string;
}

/**
 * Does the page read in a language the word lists know? Sync, with a detector.
 * Fail closed: a declared other language, a detected other language, or nothing
 * to tell (no `lang` and too little text) all count as foreign. A page declared
 * English or German whose text reads as another language is foreign too:
 * templates often keep `lang="en"` around translated content.
 */
export function readsInWordLanguage(page: PageLanguageInput, detect: Detector): boolean {
  const declared = page.lang ? baseLanguage(page.lang) : null;
  if (declared && !WORD_LANGUAGES.has(declared)) return false;
  const sample = [page.title ?? "", page.text].join("\n");
  const seen = detectLanguage(sample, detect);
  if (seen.language) return WORD_LANGUAGES.has(seen.language);
  return declared !== null;
}

/** `readsInWordLanguage` with the shared detector (`eld`, loaded on first use). Without a detector the page is foreign. */
export async function pageIsForeign(page: PageLanguageInput): Promise<boolean> {
  let detect: Detector;
  try {
    detect = await loadEld();
  } catch {
    return true;
  }
  return !readsInWordLanguage(page, detect);
}
