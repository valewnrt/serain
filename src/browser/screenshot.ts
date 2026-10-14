/**
 * Screenshots at the owner's request (addendum D48 of 2026-10-08). Taken by the executor's browser
 * (`web_browse`) or in a logged-in session (`site_look`), as a JPEG of the part of the page that shows
 * the answer (`src/browser/shot.ts`). They live only in memory: with the report into the result turn,
 * from there with `send_file` to the owner, never into the database, never into the audit log.
 */
export interface Screenshot {
  /** Short and unique only within this task ("s1"). */
  id: string;
  jpeg: Buffer;
  /** Public page or logged-in session. */
  origin: "web" | "site";
  /** Host of the page (web) or name of the vault entry (site). */
  label: string;
  /**
   * What it shows, only for public pages (`src/browser/shot.ts`): the owner sees the image, Serain otherwise only
   * the file placeholder in the history (`src/outbound.ts`). Live on 2026-10-09 the owner asked about Wednesday and Saturday of the week in the image,
   * and Serain twice checked the days of a different one.
   */
  shows?: string;
}

/**
 * Does the text contain a card number? 13 to 19 digits, also grouped with spaces or hyphens, with a valid
 * check digit (Luhn). For logged-in pages: an image of it does not go to the owner (D8).
 */
export function showsCardNumber(text: string): boolean {
  for (const match of text.matchAll(/(?<![\d])\d(?:[ -]?\d){12,18}(?![\d])/g)) {
    const digits = match[0].replace(/\D/g, "");
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) return true;
  }
  return false;
}

function luhn(digits: string): boolean {
  let sum = 0;
  for (let index = 0; index < digits.length; index += 1) {
    let digit = Number(digits[digits.length - 1 - index]);
    if (index % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}
