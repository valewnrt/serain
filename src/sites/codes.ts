import { SITE_CODE_LATE_MS, SITE_CODE_WAIT_MS } from "../config/limits.js";

/**
 * Two-step codes for logged-in sessions (D56). If a login wants a code after
 * the password that the vault does not have (SMS, an app without TOTP secret),
 * the code asks the owner for it and intercepts their answer before it is
 * stored or a model sees it, like the kill switch (D8.2). The code goes
 * straight into the page's field.
 *
 * **Language neutral first.** A message that is essentially one code (one
 * number of 4 to 8 digits, or 3+3, and at most a few words around it, in any
 * language and script: "483920", "kod 483920", "código: 483920", "код 483920",
 * "コード483920") is a code. English and German words are only an addition, for
 * a forwarded SMS with more text around the number; a few common stems of other
 * languages count there too, as a bonus. In doubt, while a login waits, a message
 * is rather intercepted than handed to the model (D56).
 *
 * **Only one request at a time:** a message with a number does not say which
 * site it is for. A second session that wants a code does not wait, it gets none.
 *
 * **Late is not free:** a code that comes after expiry is still intercepted
 * (for `SITE_CODE_LATE_MS`), so it does not end up as the owner's words with
 * the model and in the history.
 */

/** A code as the owner types or pastes it: one group of 4 to 8 digits, or 3+3 ("483 920", "483-920"). */
const NUMBERS = /(?<![\d])(\d{3}[ -]\d{3}|\d{4,8})(?![\d])/g;
/** At most this many words besides the code ("the code is", "el código es", "G-"). */
const AROUND_MAX_WORDS = 3;
const AROUND_MAX_LETTERS = 24;
/** A forwarded SMS usually says what it is about: English and German, plus common stems of other languages. */
const CODE_WORDS =
  /(?<![\p{L}])(code|codes|tan|otp|pin|passcode|einmal\p{L}*|bestätigung\p{L}*|verifi\p{L}*|sicherheits\p{L}*|security|login|anmeld\p{L}*|kod\p{L}*|c[oó]dig\p{L}*|codice|код\p{L}*|コード|認証|验证码|驗證碼|인증|코드|رمز)/iu;
/** Longer is no SMS any more, but a message that happens to contain a number. */
const FORWARDED_MAX_CHARS = 300;

/** The single code-shaped number in a text, digits only; null for none or several. */
function singleCode(text: string): { code: string; rest: string } | null {
  const found = [...text.matchAll(NUMBERS)];
  const codes = new Set(found.map((match) => match[1]!.replace(/[ -]/g, "")));
  if (codes.size !== 1) return null;
  return { code: [...codes][0]!, rest: text.replace(NUMBERS, " ") };
}

/** The code from the owner's message, digits only; else null. */
export function extractCode(text: string): string | null {
  const single = singleCode(text);
  if (!single) return null;
  // Essentially just the code: no other digits, at most a few words of any language around it.
  if (!/\d/.test(single.rest)) {
    const words = single.rest.split(/[^\p{L}\p{M}]+/u).filter(Boolean);
    const letters = words.join("").length;
    if (words.length <= AROUND_MAX_WORDS && letters <= AROUND_MAX_LETTERS) return single.code;
  }
  if (text.length > FORWARDED_MAX_CHARS || !CODE_WORDS.test(text)) return null;
  return single.code;
}

export interface CodeRequestsDeps {
  /** Asks the owner for the code. False if the message did not go out: then nothing waits. */
  ask(site: string): Promise<boolean>;
  now?: () => number;
  waitMs?: number;
  lateMs?: number;
}

/** What happened to an intercepted message. */
export interface CodeDelivery {
  site: string;
  /** Came after expiry or cancellation: the login no longer waits. */
  late: boolean;
}

export class CodeRequests {
  private pending: { site: string; resolve: (code: string | null) => void } | null = null;
  private recent: { site: string; until: number } | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: CodeRequestsDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** For which site a code is expected right now, or null. */
  get waiting(): string | null {
    return this.pending?.site ?? null;
  }

  /**
   * Waits for the owner's code, at most `SITE_CODE_WAIT_MS`. Null on expiry,
   * cancellation or when another login is already waiting.
   */
  async request(site: string, cancelled?: Promise<void>): Promise<string | null> {
    if (this.pending) return null;
    let resolve: (code: string | null) => void = () => undefined;
    const answer = new Promise<string | null>((done) => {
      resolve = done;
    });
    this.pending = { site, resolve };
    this.recent = null;
    let timer: NodeJS.Timeout | undefined;
    let asked = false;
    try {
      asked = await this.deps.ask(site);
      if (!asked) return null;
      const timeout = new Promise<null>((done) => {
        timer = setTimeout(() => done(null), this.deps.waitMs ?? SITE_CODE_WAIT_MS);
      });
      return await Promise.race([answer, timeout, ...(cancelled ? [cancelled.then(() => null)] : [])]);
    } finally {
      clearTimeout(timer);
      if (this.pending?.resolve === resolve) {
        this.pending = null;
        // Only someone who was asked may still send a code afterwards.
        if (asked) this.recent = { site, until: this.now() + (this.deps.lateMs ?? SITE_CODE_LATE_MS) };
      }
    }
  }

  /** Would this message be a code someone expects (or expected)? Consumes nothing. */
  matches(text: string): boolean {
    if (!this.pending && !(this.recent && this.recent.until > this.now())) return false;
    return extractCode(text) !== null;
  }

  /** Hands the code to the waiting login. Null if the message is none or nobody asks. */
  deliver(text: string): CodeDelivery | null {
    const code = extractCode(text);
    if (!code) return null;
    if (this.pending) {
      const { site, resolve } = this.pending;
      resolve(code);
      return { site, late: false };
    }
    if (this.recent && this.recent.until > this.now()) return { site: this.recent.site, late: true };
    return null;
  }

  /** Kill switch: no login keeps waiting. */
  cancelAll(): void {
    this.pending?.resolve(null);
  }
}
