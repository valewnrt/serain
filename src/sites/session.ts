import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { z } from "zod";
import { BrowseError, launchSession } from "../browser/session.js";
import { focusPicker } from "../browser/shot.js";
import { showsCardNumber } from "../browser/screenshot.js";
import type { BrowserSession, PageSnapshot, PilotAction } from "../browser/pilot.js";
import { hostAllowed, SITE_NAME, type VaultEntry } from "../vault/entry.js";
import { totp } from "./totp.js";
import { VaultUnavailable, type VaultReader } from "./vault.js";
import { owner } from "../config/owner.js";
import { classifyButton, pageIsForeign, targetActs, type ButtonContext } from "../forms/classify.js";
import { t } from "../i18n/catalog.js";
import { forms } from "../i18n/messages/forms.js";

/**
 * Logged-in browser sessions on the server (D36, no longer on the owner's Mac
 * since D49).
 *
 * **Surrogation (W16):** this code logs in, not the model. It fills username,
 * password and TOTP from the vault, and only on a host that belongs to the
 * entry. The model gets snapshots without password fields, and whatever
 * resembles a secret is hidden.
 *
 * **Pinned:** the main page does not leave the entry's hosts, enforced in the
 * browser; subresources go through the filter proxy (D28). **Information only
 * (decision of 2026-09-20):** this session does not click buttons that buy,
 * book, pay, cancel, delete or send something (`blocksAction`). That is a
 * pattern over labels plus language-neutral signals, so a belt, not a
 * guarantee; on a page in a language without word lists it fails closed.
 * Anything that moves money is phase 5.
 *
 * Its own Chrome profile per site under `profilesDir`, so a login lasts a while
 * and Serain does not log in from a data centre for every task. One session per
 * site at a time (Chrome locks a profile against a second process). Profiles of
 * sites that are no longer in the vault are deleted on the next open.
 */

/** Words of acting in English and German (`src/forms/classify.ts` adds the language-neutral signals). */
export const ACTION_DENYLIST =
  /(kaufen|bestell|zahlungspflichtig|kostenpflichtig|buchen|buchung abschlie|bezahlen|zahlen|zur kasse|warenkorb|checkout|\bpay\b|\bbuy\b|purchase|\border\b|\bbook\b|add to cart|subscribe|abonnier|kündig|kuendig|\bcancel\b|stornier|lösch|loesch|delete|entfern|\bremove\b|überweis|ueberweis|transfer|senden|\bsend\b|submit|passwort ändern|change password|konto schlie|close account)/i;

/**
 * Does a click (or typing with Enter) on this element act? Information-only sessions have no preview, so whatever
 * would need one is blocked: the English and German words above, money by any signal, and, on a page in another
 * language, everything that is not harmless by structure (fail closed, `classifyButton`).
 */
export function blocksAction(labels: readonly string[], context: ButtonContext): boolean {
  if (labels.some((label) => ACTION_DENYLIST.test(label))) return true;
  const kind = classifyButton(labels, context);
  if (kind === "money") return true;
  // English or German: a search button or a link to the next page is information; the words above decide the rest.
  if (!context.foreign) return targetActs(context.target, false);
  return kind === "commit";
}

/** Stands for a secret in what the model sees. */
const MASK = "[hidden]";

const elementId = z.number().int().min(1).max(500);

/** What the executor can do in a logged-in session. No free text except what goes into a field. */
export const siteActionSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("click"), id: elementId }).strict(),
  z.object({ op: z.literal("type"), id: elementId, text: z.string().max(200), submit: z.boolean() }).strict(),
  z.object({ op: z.literal("select"), id: elementId, option: z.number().int().min(0).max(50) }).strict(),
  z.object({ op: z.literal("scroll") }).strict(),
  z.object({ op: z.literal("back") }).strict(),
]);
export type SiteAction = z.infer<typeof siteActionSchema>;

/** `no_code`: the page wanted a code, and the owner did not send one in time (D56). */
export type SiteLogin = "done" | "no_form" | "incomplete" | "no_code";

export class SiteFailure extends Error {
  constructor(
    readonly code: "bad_request" | "blocked" | "busy" | "failed",
    message: string,
  ) {
    super(message);
    this.name = "SiteFailure";
  }
}

export type Launched = BrowserSession & { page: Page };
export type SiteLauncher = (url: string, profileDir: string, allow: (hostname: string) => boolean) => Promise<Launched>;

export interface SiteSessionsDeps {
  vault: VaultReader;
  profilesDir: string;
  chromePath: string;
  launch?: SiteLauncher;
  now?: () => number;
  /**
   * Asks the owner for a code the vault does not have (D56) and waits for
   * their answer. Null on expiry or cancellation. Without it: no code, the login
   * stays incomplete as before.
   */
  askCode?: (site: string, cancelled?: Promise<void>) => Promise<string | null>;
}

const USER_FIELD =
  'input[autocomplete="username"]:visible, input[type="email"]:visible, input[name*="user" i]:visible, input[name*="mail" i]:visible, input[name*="login" i]:visible, input[id*="user" i]:visible, input[id*="mail" i]:visible';
const PASSWORD_FIELD = 'input[type="password"]:visible';
const OTP_FIELD =
  'input[autocomplete="one-time-code"]:visible, input[name*="otp" i]:visible, input[name*="totp" i]:visible, input[id*="otp" i]:visible, input[name*="code" i]:visible, input[id*="code" i]:visible';

/**
 * Logs in as far as there are fields for it: username and password on one
 * page or one after the other, then TOTP. Secrets are only typed while the
 * page is on an allowed host.
 *
 * If a code field follows the password and the vault has no TOTP, `askCode`
 * asks the owner (D56), once per login and only here: after the login nobody
 * fills a code field any more, so a TAN for a payment would never get in.
 */
export async function autoLogin(
  page: Page,
  entry: VaultEntry,
  now: number,
  askCode?: () => Promise<string | null>,
): Promise<SiteLogin> {
  let typedPassword = false;
  let askedCode = false;
  for (let round = 0; round < 4; round += 1) {
    if (!hostAllowed(entry, new URL(page.url()).hostname)) return "incomplete";
    const password = page.locator(PASSWORD_FIELD).first();
    const user = page.locator(USER_FIELD).first();
    const otp = page.locator(OTP_FIELD).first();
    if ((await password.count()) > 0) {
      if ((await user.count()) > 0 && !(await user.inputValue().catch(() => "x"))) await user.fill(entry.username);
      await password.fill(entry.password);
      await password.press("Enter");
      typedPassword = true;
    } else if ((await otp.count()) > 0 && entry.totpSecret) {
      await otp.fill(totp(entry.totpSecret, now));
      await otp.press("Enter");
    } else if (typedPassword && !askedCode && askCode && (await otp.count()) > 0) {
      askedCode = true;
      const code = await askCode();
      if (!code) return "no_code";
      // The owner had minutes; the page may be somewhere else by now.
      if (!hostAllowed(entry, new URL(page.url()).hostname)) return "incomplete";
      await otp.fill(code);
      await otp.press("Enter");
    } else if (!typedPassword && (await user.count()) > 0 && !(await user.inputValue().catch(() => "x"))) {
      await user.fill(entry.username);
      await user.press("Enter");
    } else {
      break;
    }
    await page.waitForLoadState("networkidle", { timeout: 6_000 }).catch(() => undefined);
  }
  if (!typedPassword) return "no_form";
  // If the password field is still there, the page did not accept the login (wrong password, captcha, code by SMS).
  return (await page.locator(PASSWORD_FIELD).count()) > 0 || (await page.locator(OTP_FIELD).count()) > 0 ? "incomplete" : "done";
}

/** Text of all frames plus the value of every field, password fields too. */
const PAGE_TEXT =
  "[document.body ? document.body.innerText : '', ...Array.from(document.querySelectorAll('input, textarea, select'), (el) => el.value || '')].join('\\n')";

/** Why no screenshot of a page may go to the owner (addendum D48 of 2026-10-08). */
export type ShotBlock = "password_field" | "code_field" | "unreadable" | "credentials" | "card_number";

const SHOT_BLOCK_REASON: Record<ShotBlock, string> = {
  password_field: "there is a password field on the page",
  code_field: "there is a field for a code on the page",
  unreadable: "the page could not be checked",
  credentials: "login details are on the page",
  card_number: "a card number is on the page",
};

const SHOT_BLOCK_TEXT = {
  password_field: forms.shotPasswordField,
  code_field: forms.shotCodeField,
  unreadable: forms.shotUnreadable,
  credentials: forms.shotCredentials,
  card_number: forms.shotCardNumber,
} as const satisfies Record<ShotBlock, unknown>;

/** The reason for the model (tool results, English). */
export function shotBlockReason(block: ShotBlock): string {
  return SHOT_BLOCK_REASON[block];
}

/** The reason for the owner (a preview without a picture), in their language. */
export function shotBlockText(block: ShotBlock, lang?: string): string {
  return lang ? t(SHOT_BLOCK_TEXT[block], {}, lang) : t(SHOT_BLOCK_TEXT[block]);
}

/**
 * Why no screenshot of this page may go to the owner (addendum D48 of
 * 2026-10-08), else null: a visible password or code field, a secret of this
 * session in the text or in a field (password, TOTP secret and codes, a code
 * from the owner), a card number. A frame that cannot be read means no. What
 * stands on the page as an image, this does not see.
 */
export async function screenshotBlocker(page: Page, secrets: readonly string[]): Promise<ShotBlock | null> {
  if ((await page.locator(PASSWORD_FIELD).count()) > 0) return "password_field";
  if ((await page.locator(OTP_FIELD).count()) > 0) return "code_field";
  let text: string;
  try {
    text = (await Promise.all(page.frames().map((frame) => frame.evaluate(PAGE_TEXT) as Promise<string>))).join("\n");
  } catch {
    return "unreadable";
  }
  if (secrets.some((secret) => secret.length >= 4 && text.includes(secret))) return "credentials";
  if (showsCardNumber(text)) return "card_number";
  return null;
}

export function maskSecrets(snapshot: PageSnapshot, secrets: readonly string[]): PageSnapshot {
  const real = secrets.filter((secret) => secret.length >= 4);
  const clean = (text: string) => real.reduce((out, secret) => out.split(secret).join(MASK), text);
  return {
    ...snapshot,
    url: clean(snapshot.url),
    title: clean(snapshot.title),
    text: clean(snapshot.text),
    view: clean(snapshot.view),
    scroll: snapshot.scroll,
    elements: snapshot.elements.map((element) => ({
      ...element,
      label: clean(element.label),
      ...(element.value !== undefined ? { value: clean(element.value) } : {}),
      ...(element.target !== undefined ? { target: clean(element.target) } : {}),
    })),
  };
}

/** The TOTP codes valid right now, with the window before and after: they stand nowhere else. */
export function currentCodes(totpSecret: string | null, now: number): string[] {
  return totpSecret ? [-30_000, 0, 30_000].map((offset) => totp(totpSecret, now + offset)) : [];
}

/** Logged in and pinned, without rules for buttons (D63, part C). The secrets grow by codes from the owner. */
export interface RawSiteSession {
  readonly site: string;
  readonly login: SiteLogin;
  readonly launched: Launched;
  readonly secrets: readonly string[];
  readonly totpSecret: string | null;
  hostAllowed(hostname: string): boolean;
  close(): Promise<void>;
}

/** An open session that belongs to a task. Whoever opens it closes it. */
export interface SiteSession {
  readonly site: string;
  readonly login: SiteLogin;
  readonly page: PageSnapshot;
  look(): Promise<PageSnapshot>;
  act(action: SiteAction): Promise<PageSnapshot>;
  /**
   * A screenshot as JPEG: the smallest block that holds `focus`, else the visible part
   * (`src/browser/shot.ts`). Throws `SiteFailure` "blocked" when login details are visible (addendum D48).
   */
  screenshot(focus?: string): Promise<Buffer>;
  close(): Promise<void>;
}

export class SiteSessions {
  private readonly busy = new Set<string>();
  private readonly now: () => number;
  private readonly launch: SiteLauncher;

  constructor(private readonly deps: SiteSessionsDeps) {
    this.now = deps.now ?? Date.now;
    this.launch =
      deps.launch ?? ((url, profileDir, allow) => launchSession(url, deps.chromePath, { profileDir, allowNavigation: allow }));
  }

  list(): Promise<string[]> {
    return this.deps.vault.list();
  }

  async open(site: string, opts: { cancelled?: Promise<void> } = {}): Promise<SiteSession> {
    const raw = await this.openRaw(site, opts);
    return this.wrap(site, raw);
  }

  /**
   * Logged in, but without the shell for information: for forms (D63, part C),
   * which have their own rule for buttons. Whoever opens it calls `close`.
   */
  async openRaw(site: string, opts: { cancelled?: Promise<void> } = {}): Promise<RawSiteSession> {
    if (!SITE_NAME.test(site)) throw new SiteFailure("bad_request", "Not a valid name for a vault entry.");
    if (this.busy.has(site)) throw new SiteFailure("busy", `A session at ${site} is already running.`);
    this.busy.add(site);
    try {
      return await this.start(site, opts.cancelled);
    } catch (error) {
      this.busy.delete(site);
      throw error;
    }
  }

  private async start(site: string, cancelled?: Promise<void>): Promise<RawSiteSession> {
    let entry: VaultEntry | null;
    try {
      entry = await this.deps.vault.get(site);
    } catch (error) {
      if (error instanceof VaultUnavailable) throw new SiteFailure("failed", error.message);
      throw error;
    }
    if (!entry) throw new SiteFailure("bad_request", "This site is not in the vault.");
    await this.pruneProfiles();
    const profileDir = join(this.deps.profilesDir, entry.site);
    await mkdir(profileDir, { recursive: true, mode: 0o700 });
    const allowed = entry;
    let session: Launched;
    try {
      session = await this.launch(entry.loginUrl, profileDir, (hostname) => hostAllowed(allowed, hostname));
    } catch (error) {
      if (error instanceof BrowseError) throw new SiteFailure("failed", error.message);
      throw error;
    }
    const secrets = [entry.password, entry.totpSecret ?? ""];
    const askCode = this.deps.askCode;
    let login: SiteLogin;
    try {
      login = await autoLogin(
        session.page,
        entry,
        this.now(),
        askCode
          ? async () => {
              const code = await askCode(site, cancelled);
              // The code never stands in a snapshot for the model either.
              if (code) secrets.push(code);
              return code;
            }
          : undefined,
      );
    } catch (error) {
      await session.close().catch(() => undefined);
      throw new SiteFailure("failed", `Login failed: ${(error as Error).message.split("\n")[0]}`);
    }
    let closed = false;
    return {
      site,
      login,
      launched: session,
      secrets,
      totpSecret: entry.totpSecret ?? null,
      hostAllowed: (hostname) => hostAllowed(allowed, hostname),
      close: async () => {
        if (closed) return;
        closed = true;
        this.busy.delete(site);
        await session.close().catch(() => undefined);
      },
    };
  }

  private async wrap(site: string, raw: RawSiteSession): Promise<SiteSession> {
    const session = raw.launched;
    const secrets = raw.secrets;
    const login = raw.login;
    const masked = (snapshot: PageSnapshot) => maskSecrets(snapshot, secrets);
    let last: PageSnapshot;
    try {
      last = await session.snapshot();
    } catch (error) {
      await raw.close();
      throw new SiteFailure("failed", `Login failed: ${(error as Error).message.split("\n")[0]}`);
    }
    let open = true;
    const require = () => {
      if (!open) throw new SiteFailure("bad_request", "The session is already closed.");
    };
    return {
      site,
      login,
      page: masked(last),
      look: async () => {
        require();
        last = await session.snapshot();
        return masked(last);
      },
      act: async (action) => {
        require();
        const target = "id" in action ? last.elements.find((element) => element.id === action.id) : undefined;
        if ("id" in action && !target) throw new SiteFailure("bad_request", "This element is not (or no longer) on the page. Look again first.");
        // Information only: nothing that looks like acting is clicked or submitted.
        const acts = action.op === "click" || (action.op === "type" && action.submit);
        if (acts && target) {
          const foreign = await pageIsForeign({ lang: last.lang ?? null, title: last.title, text: last.view || last.text });
          const labels = [target.label, action.op === "type" ? "" : (target.value ?? "")];
          const context: ButtonContext = {
            // Enter in a field submits its form.
            submits: action.op === "type" || target.submits === true,
            target: target.target ?? null,
            kind: target.kind,
            ...(target.role ? { role: target.role } : {}),
            ...(target.state ? { state: target.state } : {}),
            foreign,
            payment: last.payment === true,
          };
          if (blocksAction(labels, context)) {
            throw new SiteFailure(
              "blocked",
              foreign
                ? `"${target.label}" is not clicked in a logged-in session: the page is in a language whose action words this code does not know, so anything that may act stays with ${owner.name}.`
                : `"${target.label}" is not clicked in a logged-in session: it looks like buying, booking, deleting or sending. ${owner.name} does that themselves.`,
            );
          }
        }
        const pilot: PilotAction =
          action.op === "type" ? { op: "type", id: action.id, submit: action.submit } : action.op === "select" ? { op: "select", id: action.id, option: action.option } : action.op === "click" ? { op: "click", id: action.id } : { op: action.op };
        try {
          await session.act(pilot, action.op === "type" ? action.text : undefined);
        } catch (error) {
          throw new SiteFailure("failed", `Action failed: ${(error as Error).message.split("\n")[0]}`);
        }
        last = await session.snapshot();
        return masked(last);
      },
      screenshot: async (focus?: string) => {
        require();
        // The codes valid right now, with the window before and after: they stand nowhere else.
        const check = () => screenshotBlocker(session.page, [...secrets, ...currentCodes(raw.totpSecret, this.now())]);
        const before = await check();
        if (before) throw new SiteFailure("blocked", `No screenshot: ${shotBlockReason(before)}.`);
        let jpeg: Buffer;
        try {
          if (!session.screenshot) throw new Error("this browser cannot take screenshots");
          // Only the picture: what a logged-in page shows does not go into the history as text (unlike `web_browse`).
          jpeg = (await session.screenshot(focus ? focusPicker(focus) : undefined)).jpeg;
        } catch (error) {
          throw new SiteFailure("failed", `Screenshot failed: ${(error as Error).message.split("\n")[0]}`);
        }
        // Once more afterwards: the page may have changed between the check and the capture.
        const after = await check();
        if (after) throw new SiteFailure("blocked", `No screenshot: ${shotBlockReason(after)}.`);
        return jpeg;
      },
      close: async () => {
        if (!open) return;
        open = false;
        await raw.close();
      },
    };
  }

  /** What is no longer in the vault has no profile with cookies any more (W13). */
  private async pruneProfiles(): Promise<void> {
    const known = new Set(await this.deps.vault.list());
    const present = await readdir(this.deps.profilesDir).catch(() => [] as string[]);
    for (const name of present) {
      if (!known.has(name) && !this.busy.has(name)) await rm(join(this.deps.profilesDir, name), { recursive: true, force: true });
    }
  }
}
