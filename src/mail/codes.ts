/**
 * Codes and login links in mails (W17). A one-time code is an authentication
 * factor: whoever reads it can complete a login or a payment. So it is not
 * part of "reading mail": `mail_search` and `mail_read` hide it before a
 * model sees the text, and only `mail_code` hands it out, on its own terms.
 *
 * Recognised by pattern, not by a model (D12). Mails come in every language,
 * so the signals are:
 *
 * - **Language-neutral:** a code-shaped token alone on its line (how services
 *   set a code apart), a subject or sender that reads like a login mail
 *   (`CodeHints`), and words that are the same in many languages (`otp`,
 *   `pin`, `2fa`, the stems `cod`, `kod`, `код`).
 * - **Words in English and German** near the token ("verification",
 *   "Bestätigungscode", "sign in", "Anmeldung").
 * - **Fail closed:** when the text is not recognisably English or German,
 *   every code-shaped token is hidden, keyword or not. Better an order number
 *   too many hidden than a code too few.
 */

/** English and German words near a code, plus stems that are the same in many languages. */
const KEYWORD =
  /(code|cod[ei]|código|kod|код|\bpin\b|\btan\b|\botp\b|passcode|password|kennwort|einmal|verifizier|verification|verify|bestätig|bestaetig|confirm|sicherheit|security|anmeld|login|log-in|sign[- ]?in|zugang|authenti|freigabe|2fa|mfa|two-factor|zwei-faktor|one-time)/i;
/** 4 to 8 digits, "123 456", "123-456", or 6 to 10 capitals/digits with at least one digit. */
const TOKEN = /\b(\d{3}[ -]\d{3}|\d{4,8}|(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{6,10})\b/g;
const WINDOW = 90;
const LINK = /https?:\/\/[^\s<>"')\]]+/g;
const LINK_SECRET = /(token|code|key|auth|verify|verif|confirm|magic|reset|otp|signature|sig|login|session|invite|activate|bestaet)/i;
/** The local part of a sender of login mails, in any language: `verify@`, `no-reply-security@`, `otp@`. */
const AUTH_SENDER = /(verif|security|secure|auth|login|signin|otp|2fa|mfa|identity|account|passcode|code)/i;

export const CODE_MASK = "[code hidden]";
export const LINK_MASK = "[login link hidden]";

/** What else is known about the mail besides the text. A login mail by these signs loses every code-shaped token. */
export interface CodeHints {
  subject?: string;
  /** Sender address, or `Name <address>`. */
  from?: string;
}

/**
 * Frequent short words of English and German. A text in which they are rare
 * is in a language this module has no words for: then every code-shaped token
 * counts (fail closed). Words that are also everyday words of neighbouring
 * languages ("in", "a", "de", "en", "no", "die" aside) are left out.
 */
const KNOWN_WORDS = new Set(
  (
    "the and you your for with this that from have has are was were will please our not can here " +
    "der das und ist ihr ihre ihren sie wir uns nicht mit für fuer bitte ein eine einen dem den des auf sich " +
    "auch wird werden haben hat oder bei zum zur von vom wenn noch nur dein deine dich dir"
  ).split(" "),
);

/** Is the text recognisably English or German? A short text without such words is not: fail closed. */
export function knownLanguage(text: string): boolean {
  const words = text
    .replace(LINK, " ")
    .toLowerCase()
    .split(/[^\p{L}]+/u)
    .filter(Boolean);
  if (words.length === 0) return false;
  const hits = words.filter((word) => KNOWN_WORDS.has(word)).length;
  return hits >= 1 && hits / words.length >= (words.length <= 6 ? 0.15 : 0.08);
}

function authHints(hints: CodeHints): boolean {
  if (hints.subject && KEYWORD.test(hints.subject)) return true;
  const address = hints.from?.match(/<([^>]+)>/)?.[1] ?? hints.from ?? "";
  return address.includes("@") && AUTH_SENDER.test(address.split("@")[0] ?? "");
}

function isYearOrDate(text: string, index: number, token: string): boolean {
  if (/^(19|20)\d{2}$/.test(token)) return true;
  // Part of a date, a time or an amount: 21.09.2026, 14:30, 1.250,00 €.
  // A full stop after the code does not count: what is meant is a separator between digits.
  const before = text.slice(Math.max(0, index - 2), index);
  const after = text.slice(index + token.length, index + token.length + 3);
  return /\d[.:,/]$/.test(before) || /^[.:,/]\d/.test(after) || /^\s?[€$£¥₺₽]/.test(after) || /[€$£¥₺₽]\s?$/.test(before);
}

/** The token is the only thing on its line, punctuation aside: how mails in every language set a code apart. */
function standsAlone(text: string, index: number, token: string): boolean {
  const start = text.lastIndexOf("\n", index - 1) + 1;
  const end = text.indexOf("\n", index + token.length);
  const line = text.slice(start, index) + text.slice(index + token.length, end === -1 ? text.length : end);
  return /^[\s:.!*_>"'“”„«»()[\]-]*$/.test(line);
}

function findCodes(text: string, hints: CodeHints): Array<{ index: number; token: string }> {
  const everyToken = authHints(hints) || !knownLanguage(text);
  const found: Array<{ index: number; token: string }> = [];
  for (const match of text.matchAll(TOKEN)) {
    const token = match[0];
    const index = match.index;
    if (isYearOrDate(text, index, token)) continue;
    const around = text.slice(Math.max(0, index - WINDOW), index + token.length + WINDOW);
    if (everyToken || standsAlone(text, index, token) || KEYWORD.test(around)) found.push({ index, token });
  }
  return found;
}

/**
 * Hides codes and links with a secret in the address. `hints` from the same
 * mail widen it: mask a body with subject and sender, a subject with the
 * sender.
 */
export function maskCodes(text: string, hints: CodeHints = {}): string {
  let out = text.replace(LINK, (url) => {
    const query = url.includes("?") ? url.slice(url.indexOf("?")) : "";
    const path = url.replace(/^https?:\/\/[^/]+/, "");
    // A secret sits in the query or in a long, random-looking part of the path.
    const opaque = /[A-Za-z0-9_-]{24,}/.test(path);
    return (query && LINK_SECRET.test(url)) || opaque ? LINK_MASK : url;
  });
  const codes = findCodes(out, hints);
  for (const { index, token } of codes.reverse()) {
    out = out.slice(0, index) + CODE_MASK + out.slice(index + token.length);
  }
  return out;
}

/**
 * The excerpt of a search hit. Links go before anything is cut: a logo link at
 * the start of an HTML mail otherwise filled the 220 characters, and of the
 * actual text half a sentence was left (ChatGPT codes on 2026-10-10: "Please
 * ignore this email if this was", the decisive rest was missing).
 *
 * Masking comes first, on the whole text as in `mail_read`: a link
 * (`…/login?token=…`) is often the only keyword next to a code, without it the
 * code would stay. Only then do the links go, and cutting comes last, so no
 * cut-off code is left.
 */
export function mailSnippet(text: string, chars = 220, hints: CodeHints = {}): string {
  return maskCodes(text, hints)
    .split(LINK_MASK)
    .join(" ")
    .replace(LINK, " ")
    .replace(/[[(<]\s*[\])>]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, chars);
}

/** The codes themselves, without separators, without duplicates, by the rules of `maskCodes`. Only for `mail_code`. */
export function extractCodes(text: string, hints: CodeHints = {}): string[] {
  const withoutLinks = text.replace(LINK, " ");
  return [...new Set(findCodes(withoutLinks, hints).map(({ token }) => token.replace(/[ -]/g, "")))];
}
