/**
 * Confidential values do not leave the server (D29, W3). The chat knows the
 * user model and memory, the executor only the task text: what is in the task
 * can end up at a third party in a URL or search query. In a live test the
 * owner's full address was in there and went to a geocoding service; the rule
 * against it was only in the prompt.
 *
 * So here deterministically, without a model and without `judge` (D12): from
 * everything Serain has stored about the owner, addresses (street plus house
 * number), long numbers (phone, tax, account, ID) and mail addresses are
 * extracted. A text that carries one of these values is refused; so is every
 * valid IBAN, whoever's. The guard names only the kind of the finding, never
 * the value: the message also goes to the executor and into the audit log.
 *
 * Independent of language and country, and fail closed: numbers are compared
 * as digits in any script (Arabic-Indic, full-width) and with every country
 * calling code and trunk prefix taken off, so "+1 415 555 0123", "(415)
 * 555-0123" and "1-415-555-0123" are one number, like "+49 151 …" and
 * "0151 …". Addresses are found by structure where possible (house number next
 * to a postal code of the common formats), by German compound street names,
 * and by street-type words of many languages around a house number. In doubt
 * a value counts once too often rather than once too rarely.
 */

export type ConfidentialKind = "address" | "number" | "email" | "iban";

const KIND_LABEL: Record<ConfidentialKind, string> = {
  address: "an address (street and house number)",
  number: "a phone, account, tax or ID number",
  email: "a mail address",
  iban: "an IBAN",
};

/** The kinds in words, for tool results to the model (English). Never the values. */
export function describeKinds(kinds: readonly ConfidentialKind[]): string {
  return kinds.map((kind) => KIND_LABEL[kind]).join(" and ");
}

/** Shorter is no number that identifies anyone (postal code, year, amount). */
const MIN_NUMBER_DIGITS = 7;

/** German compound street names ("Musterstraße"), and the compound forms of Dutch and Scandinavian. */
const STREET_SUFFIX = "strasse|str|weg|allee|platz|gasse|ring|damm|ufer|pfad|steig|chaussee|straat|gracht|kade|laan|gatan|gata|gaten|vej|vei|veien|gade";

/**
 * Street-type words that stand on their own, next to the name, in many
 * languages (folded: lowercase, no diacritics). Only an anchor for finding the
 * house number in stored text; what is matched later is name plus number.
 */
const STREET_WORD = [
  // English
  "street", "st", "road", "rd", "avenue", "ave", "lane", "ln", "drive", "boulevard", "blvd", "court", "ct", "place", "way",
  "square", "sq", "terrace", "crescent", "close", "highway", "hwy", "parkway", "pkwy",
  // German, written apart ("Am Hang", "Allee der Kosmonauten")
  "strasse", "allee", "platz", "weg",
  // French
  "rue", "boulevard", "bd", "chemin", "impasse", "quai", "route",
  // Spanish, Portuguese, Italian
  "calle", "avenida", "avda", "av", "plaza", "paseo", "camino", "carrera", "rua", "travessa", "via", "viale", "piazza", "corso", "largo", "vicolo",
  // Dutch
  "straat", "plein", "singel",
  // Turkish
  "cadde", "caddesi", "cad", "sokak", "sokagi", "sok", "sk", "bulvar", "bulvari", "mahalle", "mah",
  // Polish
  "ulica", "ul", "aleja", "al",
].join("|");

/** Little words inside street names that say nothing on their own ("rue de la Paix"). */
const NAME_FILLER = new Set(["de", "la", "le", "les", "du", "des", "del", "della", "di", "da", "do", "dos", "das", "van", "von", "der", "den", "the", "of", "am", "an", "im", "in", "auf", "e", "y"]);

/**
 * Postal codes of the common formats after a house number, folded: 4 to 6
 * digits (most of Europe, US ZIP), "1234 ab" (NL), "00-950" (PL), "01310-100"
 * (BR), "100-0001" (JP), "sw1a 1aa" (UK), "k1a 0b1" (CA).
 */
const POSTAL = "\\d{5}(?!\\d)|\\d{4}(?:\\s?[a-z]{2})?(?![a-z0-9])|\\d{6}(?!\\d)|\\d{2,5}-\\d{3,4}(?!\\d)|[a-z]{1,2}\\d[a-z\\d]?\\s?\\d[a-z]{2}(?![a-z])|[a-z]\\d[a-z]\\s?\\d[a-z]\\d(?![a-z0-9])";

/**
 * Digits of any script as ASCII: "٠٥٣٢" and full-width "０５３２" are "0532".
 * Decimal digits come in runs of ten from zero, so a digit's value is its
 * distance from the zero of its run.
 */
function asciiDigits(text: string): string {
  return text.replace(/\p{Nd}/gu, (char) => {
    const code = char.codePointAt(0)!;
    if (code <= 0x39) return char;
    let zero = code;
    // Back to the start of the contiguous run of digits: every run starts at a zero.
    while (code - zero < 100 && /\p{Nd}/u.test(String.fromCodePoint(zero - 1))) zero -= 1;
    return String((code - zero) % 10);
  });
}

/** Fold both sides the same way: "Müllerstraße", "Muellerstrasse" and "MÜLLERSTR." are the same street. */
function fold(text: string): string {
  return asciiDigits(text)
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    // Latin letters that do not decompose into a base letter and a mark.
    .replace(/[ıłøđħæœþ]/g, (char) => ({ ı: "i", ł: "l", ø: "o", đ: "d", ħ: "h", æ: "ae", œ: "oe", þ: "th" })[char] ?? char)
    .normalize("NFD")
    .replace(/\p{M}/gu, "");
}

/** A URL carries the same value as `%20`, `+` or double-encoded. */
function decoded(text: string): string {
  let current = text.replace(/\+/g, " ");
  for (let round = 0; round < 2; round += 1) {
    try {
      const next = decodeURIComponent(current);
      if (next === current) break;
      current = next;
    } catch {
      break;
    }
  }
  return current;
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Name parts to match: the last one or two significant words, never filler words. */
function nameParts(raw: string): string[] {
  return raw
    .split(/[\s.\-']+/)
    .filter((part) => part.length > 0 && !NAME_FILLER.has(part))
    .slice(-2);
}

/**
 * The pattern for one address: the name and the house number in either order
 * (German "Musterstraße 12", the geocoders' "12 Musterstraße", English "221b
 * Baker Street", French "12 rue de la Paix"), with at most a few separators,
 * street-type words, filler words or "no." in between.
 */
function addressPattern(parts: readonly string[], number: string): RegExp {
  const street = parts
    .map((part) => {
      const suffix = /^(.*?)(strasse|str)$/.exec(part);
      // "Musterstr.", "Muster-Straße" and "Musterstrasse" hit the same pattern.
      const name = suffix ? `${escapeRegex(suffix[1] as string)}[\\s\\-]?str(?:asse|\\.)?` : escapeRegex(part);
      // "ü" folds to "ue" the German way; written without the dots elsewhere it is a plain "u".
      return name.replace(/([aou])e/g, "$1e?");
    })
    .join("[\\s.\\-]*");
  const between = `(?:[\\s,.:#]{0,3}(?:(?:${STREET_WORD}|${[...NAME_FILLER].join("|")}|nr|no|n)\\.?:?(?![a-z]))?){0,4}[\\s,.:#]{0,3}`;
  const num = escapeRegex(number).replace(/([a-z])$/, "\\s?$1");
  return new RegExp(`(?<![a-z0-9])${street}${between}${num}(?![0-9a-z])|(?<![0-9])${num}${between}${street}(?![a-z])`);
}

/**
 * Addresses in a stored text. Street names have no fixed form, so there are
 * several anchors, and each yields name plus house number:
 * - a postal code after the house number ("Am Hang 3, 12345 Town", "Kerkstraat
 *   12, 1234 AB Town"): language-neutral;
 * - a German or Nordic compound street name before it ("Musterstraße 12a");
 * - a street-type word of many languages around it ("221B Baker Street",
 *   "12 rue de la Paix", "Calle Mayor 5", "Atatürk Cad. No: 12").
 * House numbers have at most three digits before a postal code (else "since
 * 2019, 12345 Town" would be an address) and at most five next to a street word.
 */
function addressPatterns(source: string): RegExp[] {
  const text = fold(source);
  const found = new Map<string, RegExp>();
  const add = (rawName: string, number: string) => {
    const parts = nameParts(rawName);
    if (parts.length === 0 || parts.every((part) => part.length < 3)) return;
    const key = `${parts.join("-")} ${number}`;
    if (!found.has(key)) found.set(key, addressPattern(parts, number));
  };
  const word = "[a-z][a-z'\\-]*\\.?";
  for (const match of text.matchAll(new RegExp(`(?<![a-z0-9])([a-z][a-z.\\-]*)\\s+(\\d{1,3}(?:\\s?[a-z](?![a-z]))?)(?=\\s*,?\\s+(?:${POSTAL}))`, "g"))) {
    add(match[1] as string, (match[2] as string).replace(/\s/g, ""));
  }
  for (const match of text.matchAll(new RegExp(`(?<![a-z0-9])([a-z][a-z.\\-]*[a-z.\\-]{2}(?:${STREET_SUFFIX})\\.?)\\s+(\\d{1,3})(?!\\d)`, "g"))) {
    add(match[1] as string, match[2] as string);
  }
  // Number, name, street word: "221b baker street", "1600 pennsylvania ave".
  for (const match of text.matchAll(new RegExp(`(?<![a-z0-9])(\\d{1,5}[a-z]?)\\s+((?:${word}\\s+){1,3}?)(?:${STREET_WORD})\\.?(?![a-z])`, "g"))) {
    add(match[2] as string, match[1] as string);
  }
  // Number, street word, name: "12 rue de la paix".
  for (const match of text.matchAll(new RegExp(`(?<![a-z0-9])(\\d{1,5}[a-z]?),?\\s+(?:${STREET_WORD})\\.?\\s+((?:${word}\\s*){1,4})`, "g"))) {
    add(match[2] as string, match[1] as string);
  }
  // Street word, name, number: "calle mayor 5", "via roma 10".
  for (const match of text.matchAll(new RegExp(`(?<![a-z0-9])(?:${STREET_WORD})\\.?\\s+((?:${word}\\s+){1,4}?)(?:(?:nr|no|n)\\.?:?\\s*)?(\\d{1,5}[a-z]?)(?![0-9a-z])`, "g"))) {
    add(match[1] as string, match[2] as string);
  }
  // Name, street word, number: "ataturk cad. no: 12", "main st 5".
  for (const match of text.matchAll(new RegExp(`(?<![a-z0-9])(${word}(?:\\s+${word})?)\\s+(?:${STREET_WORD})\\.?,?\\s*(?:(?:nr|no|n)\\.?:?\\s*)?(\\d{1,5}[a-z]?)(?![0-9a-z])`, "g"))) {
    add(match[1] as string, match[2] as string);
  }
  return [...found.values()];
}

/** A date or a span of years is no number, even if eight digits come together. */
function isDateLike(raw: string): boolean {
  const trimmed = raw.trim();
  if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(trimmed)) return true;
  const span = /^(\d{4})\s?[-/ ]\s?(\d{4})$/.exec(trimmed);
  if (!span) return false;
  return [span[1], span[2]].every((year) => Number(year) >= 1900 && Number(year) <= 2100);
}

/** Separators people write inside numbers, besides the ones the caller adds: thin and non-breaking spaces. */
const SPACES = "\\u00a0\\u2007\\u2009\\u202f";

/** Digit runs as people write them: groups with spaces, hyphen, slash, parentheses. Digits of any script count. */
function digitRuns(text: string, separators: string): string[] {
  const run = new RegExp(`(?:\\+|00)?\\d(?:[${separators}${SPACES}]{0,3}\\d)+`, "g");
  const runs: string[] = [];
  for (const match of asciiDigits(text).matchAll(run)) {
    if (isDateLike(match[0])) continue;
    runs.push(match[0]);
  }
  return runs;
}

/**
 * The parts of a stored number that appear in every way of writing it, in any
 * country: the digits without the international prefix ("+", "00") or the
 * national trunk zeros, and the same with the first one to three digits taken
 * off, which removes a country calling code ("+1", "+49", "+356") or a trunk
 * prefix that is not a zero ("8 912 …" is "+7 912 …"). Derived parts of a
 * national number need one digit more, so they stay specific. Every part is
 * matched on its own: more parts, more findings (fail closed).
 */
function numberCores(raw: string): string[] {
  const international = /^\s*(?:\+|00)/.test(raw);
  const digits = raw.replace(/\D/g, "").replace(international ? /^00/ : /^0+/, "");
  const cores = new Set([digits]);
  for (let cut = 1; cut <= 3; cut += 1) {
    const rest = digits.slice(cut);
    if (rest.length >= MIN_NUMBER_DIGITS + (international ? 0 : 1)) cores.add(rest);
  }
  return [...cores].filter((core) => core.length >= MIN_NUMBER_DIGITS);
}

function ibanValid(candidate: string): boolean {
  const iban = candidate.replace(/\s/g, "").toUpperCase();
  if (iban.length < 15 || iban.length > 34) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const char of rearranged) {
    const value = char >= "A" ? String(char.charCodeAt(0) - 55) : char;
    for (const digit of value) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

const EMAIL = /[a-z0-9._%+\-]+@[a-z0-9\-]+(?:\.[a-z0-9\-]+)+/g;
const IBAN = /(?<![A-Za-z0-9])[A-Za-z]{2}\d{2}(?:[ ]?[A-Za-z0-9]{4}){2,7}(?:[ ]?[A-Za-z0-9]{1,3})?(?![A-Za-z0-9])/g;

export class ConfidentialGuard {
  private constructor(
    private readonly addresses: RegExp[],
    private readonly numbers: string[],
    private readonly emails: string[],
  ) {}

  /** `sources` is everything the chat gets to see about the owner: user model, facts, summaries. */
  static from(sources: readonly string[]): ConfidentialGuard {
    const addresses: RegExp[] = [];
    const numbers = new Set<string>();
    const emails = new Set<string>();
    for (const source of sources) {
      addresses.push(...addressPatterns(source));
      // Narrow separators in the stored text: a dot belongs to dates and amounts there.
      for (const run of digitRuns(source, " \\-/()")) {
        for (const core of numberCores(run)) numbers.add(core);
      }
      for (const match of source.toLowerCase().matchAll(EMAIL)) emails.add(match[0]);
    }
    return new ConfidentialGuard(addresses, [...numbers], [...emails]);
  }

  /** How many values are protected. Zero means: the guard has nothing to check, and that belongs in the log. */
  get size(): number {
    return this.addresses.length + this.numbers.length + this.emails.length;
  }

  /** Empty means clean. Otherwise the kinds of the findings, never the values. */
  check(text: string): ConfidentialKind[] {
    const kinds = new Set<ConfidentialKind>();
    for (const variant of new Set([text, decoded(text)])) {
      const folded = fold(variant);
      if (this.addresses.some((pattern) => pattern.test(folded))) kinds.add("address");
      // Wide separators in the checked text: rather one number too many recognised.
      const runs = digitRuns(variant, " \\-/().").map((run) => run.replace(/\D/g, ""));
      if (this.numbers.some((number) => runs.some((run) => run.includes(number)))) kinds.add("number");
      const lower = variant.toLowerCase();
      if (this.emails.some((email) => lower.includes(email))) kinds.add("email");
      for (const match of variant.matchAll(IBAN)) {
        if (ibanValid(match[0])) kinds.add("iban");
      }
    }
    return [...kinds];
  }
}
