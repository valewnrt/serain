import { INTEGRATION_DISRUPTED_AFTER_MS, INTEGRATION_DOWN_AFTER_MS, CONNECTOR_EXPIRY_CHECK_MS, CONNECTOR_EXPIRY_WARN_MS } from "../config/limits.js";
import { instance } from "../config/owner.js";
import type { ConnectorGrant } from "../connectors/catalog.js";
import { audit } from "../db/audit.js";
import { t, textLanguage, type Message } from "../i18n/catalog.js";
import { currentLanguage, currentLocale } from "../i18n/language.js";
import { health as text } from "../i18n/messages/health.js";
import { log } from "../log.js";
import type { Calendar } from "../calendar/types.js";
import { inQuietHours } from "../proactive/heartbeat.js";
import { OWNER_TIMEZONE } from "../time.js";
import { deliveryReason } from "./delivery.js";
import type { Incident, IncidentComponent } from "./incidents.js";

/**
 * Reporting broken logins (audit 2026-10-05, W14). If the main mailbox fails,
 * the mail trigger falls silent, and exactly the moments it is there for
 * ("your appointment was moved") get lost silently. The owner only learns it
 * by looking into the audit log. The same for the heartbeat's calendar and for
 * a login that cannot be opened at start.
 *
 * **Unlike `channel` and `db`** (src/health/heartbeat.ts) the channel works
 * here: the owner gets the message when it happens, not only the all-clear.
 * Short dropouts stay silent: a report comes only when no access has worked
 * for `INTEGRATION_DOWN_AFTER_MS`, at night only at 8 o'clock. The all-clear
 * comes only if there was a warning. Whether the owner knows is noted on the
 * incident (`detail.notified`), so a restart reports nothing twice.
 *
 * **Plus the warning before an approval expires** (D51): the bank grants at
 * most 180 days. Seven days ahead Serain says so once, otherwise the owner is
 * without account data on exactly the day they ask.
 *
 * The code writes the texts, no model: it is about Serain's own technology,
 * none of it is foreign content. They come from the catalog in the owner's
 * language; for the `<context>` (`failing`) in English.
 */

/** What is affected: decides what is missing until it works again. */
export type IntegrationKind = "mail" | "calendar" | "setup";

/** What the login rejects: the password, an approval (OAuth) or the login as such. */
export type IntegrationCredential = "password" | "grant" | "login";

export interface IntegrationSubject {
  /** Stable per login, e.g. the id of the integration or "calendar". */
  id: string;
  kind: IntegrationKind;
  /** How the owner calls it, lowercase, in a language: "gmx", "gmail", "my mailbox". Stands at the start of the sentence. */
  name: (lang: string) => string;
  credential: IntegrationCredential;
  /** Reconnect with `pnpm integration connect <preset>`; without it there is no value to copy. */
  preset?: string;
}

/**
 * How the owner calls a mailbox (style round, addendum D23 of 2026-10-10). The
 * id is the name from `pnpm integration connect`, so also the command to
 * reconnect.
 */
export function mailSubject(account: { id: string; serains?: boolean }): IntegrationSubject {
  const google = account.id === "google";
  return {
    id: account.id,
    kind: "mail",
    name: (lang) => (account.serains ? t(text.nameOwnMailbox, undefined, lang) : google ? t(text.nameGmail, undefined, lang) : account.id),
    credential: google ? "grant" : "password",
    preset: account.id,
  };
}

/** The calendar behind the tools: iCloud over CalDAV or Google (D54). */
export function calendarSubject(id: string | null): IntegrationSubject {
  return {
    id: id ?? "calendar",
    kind: "calendar",
    name: (lang) => (id === "google" ? t(text.nameGoogleCalendar, undefined, lang) : (id ?? t(text.nameCalendar, undefined, lang))),
    credential: id === "google" ? "grant" : "password",
    ...(id ? { preset: id } : {}),
  };
}

/** A login that could not be opened at start (key, secret). Reconnecting seals it anew. */
export function setupSubject(id: string): IntegrationSubject {
  return { id, kind: "setup", name: (lang) => t(text.nameSetup, { id }, lang), credential: "login", preset: id };
}

export interface ExpiringConnector {
  id: string;
  name: string;
  /** Which fixed name the owner reads for the approval (`ConnectorInfo.grantName`); without: "the approval for <name>". */
  grantName?: ConnectorGrant;
  expiresAt: Date | null;
}

export interface IntegrationHealthDeps {
  /**
   * Sends the owner a text of the code (OutboundGate). False when nothing went out.
   * `verbatim`: a value to copy, verbatim as its own bubble (addendum D23 of 2026-10-08).
   */
  send(text: string, context: Record<string, unknown>, options?: { verbatim?: boolean }): Promise<boolean>;
  incidents: {
    find(component: IncidentComponent): Promise<Incident | null>;
    open(component: IncidentComponent, cause: string): Promise<Incident | null>;
    close(component: IncidentComponent, note: string): Promise<void>;
    markNotified(incident: Incident): Promise<void>;
  };
  /** Connected services with an expiry (D51). Without: no warning. */
  connectors?: () => Promise<ExpiringConnector[]>;
  /** For which expiry a warning already went out, per service (`agent_state`). */
  expiryWarned: { load(): Promise<Record<string, string>>; save(value: Record<string, string>): Promise<void> };
  /** Kill switch: then this falls silent too. */
  paused(): Promise<boolean>;
  now?: () => Date;
}

interface Streak {
  subject: IntegrationSubject;
  /** Since when it fails; null means: the last access worked. */
  failingSince: number | null;
  lastError: string;
  /** After the first success in this process or after an outage: check whether an incident is open. */
  settle: boolean;
}

/** The error comes from the owner having disconnected the login (src/integrations/setup.ts): that is no outage. */
export function isDisconnected(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { disconnected?: unknown }).disconnected === true;
}

/**
 * Whether it is the login: then the owner can do something (password,
 * approval). Otherwise it is "not reachable". Reads error texts of the
 * providers and of our adapters, which say "login" when the login is rejected.
 */
export function failureKind(reason: string): "auth" | "unreachable" {
  return /login|authenti|invalid_grant|unauthori[sz]ed|\b40[13]\b|passwor|credential/i.test(reason) ? "auth" : "unreachable";
}

const DOWN_AUTH: Record<IntegrationKind, Record<Exclude<IntegrationCredential, "login">, Message<"name" | "minutes">>> = {
  mail: { password: text.downAuthMailPassword, grant: text.downAuthMailGrant },
  calendar: { password: text.downAuthCalendarPassword, grant: text.downAuthCalendarGrant },
  setup: { password: text.downAuthSetup, grant: text.downAuthSetup },
};
const DOWN: Record<IntegrationKind, Message<"name" | "minutes">> = { mail: text.downMail, calendar: text.downCalendar, setup: text.downSetup };

/**
 * Fixed texts to the owner in Serain's tone (style round, addendum D23 of
 * 2026-10-10). Also stand in the `<context>`, there in English.
 */
export function describeDown(subject: IntegrationSubject, minutes: number, reason: string, lang: string = currentLanguage()): string {
  const message =
    failureKind(reason) !== "auth" ? DOWN[subject.kind] : subject.credential === "login" ? text.downAuthSetup : DOWN_AUTH[subject.kind][subject.credential];
  const used = textLanguage(message, lang);
  return t(message, { name: subject.name(used), minutes }, used);
}

/** The command to reconnect as its own bubble, only when it is the login: only then does it help. */
export function reconnectCommand(subject: IntegrationSubject, reason: string): string | null {
  return subject.preset && failureKind(reason) === "auth" ? `pnpm integration connect ${subject.preset}` : null;
}

export function describeUp(subject: IntegrationSubject, lang: string = currentLanguage()): string {
  const used = textLanguage(text.up, lang);
  return t(text.up, { name: subject.name(used) }, used);
}

/** "do. 25.03." in German (style round), "Thu, Mar 25" in English: the month as a word wherever the order could mislead. */
function spokenDay(at: Date, lang: string): string {
  const locale = currentLocale(lang);
  if (lang === "de") {
    const parts = new Intl.DateTimeFormat(locale, { timeZone: OWNER_TIMEZONE, weekday: "short", day: "2-digit", month: "2-digit" }).formatToParts(at);
    const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? "";
    return `${part("weekday").replace(/\.$/, "").toLowerCase()}. ${part("day")}.${part("month")}.`;
  }
  return new Intl.DateTimeFormat(locale, { timeZone: OWNER_TIMEZONE, weekday: "short", day: "numeric", month: "short" }).format(at);
}

/**
 * Where to reconnect: the host of the web interface, the way one types it
 * ("serain.example.com, under connections"), without `SERAIN_WEB_ORIGIN` only
 * the tab.
 */
function whereToConnect(webOrigin: string | null, lang: string): string {
  return webOrigin ? t(text.whereHost, { host: new URL(webOrigin).host.toLowerCase() }, lang) : t(text.whereWeb, undefined, lang);
}

export function describeExpiry(connector: ExpiringConnector, now: Date, webOrigin: string | null = instance.webOrigin, lang: string = currentLanguage()): string {
  const at = connector.expiresAt!;
  const bank = connector.grantName === "bank";
  const name = connector.name.toLowerCase();
  if (at.getTime() <= now.getTime()) {
    const message = bank ? text.expiredBank : text.expiredGrant;
    const used = textLanguage(message, lang);
    return bank ? t(text.expiredBank, { where: whereToConnect(webOrigin, used) }, used) : t(text.expiredGrant, { name, where: whereToConnect(webOrigin, used) }, used);
  }
  const message = bank ? text.expiringBank : text.expiringGrant;
  const used = textLanguage(message, lang);
  const day = spokenDay(at, used);
  return bank
    ? t(text.expiringBank, { day, where: whereToConnect(webOrigin, used) }, used)
    : t(text.expiringGrant, { name, day, where: whereToConnect(webOrigin, used) }, used);
}

export class IntegrationHealth {
  private readonly streaks = new Map<string, Streak>();
  private readonly now: () => Date;
  private lastExpiryCheck = 0;
  private running = false;

  constructor(private readonly deps: IntegrationHealthDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** One access to a login, good or bad. Synchronous and cheap: runs on every fetch. */
  record(subject: IntegrationSubject, ok: boolean, error?: unknown): void {
    if (!ok && isDisconnected(error)) return this.forget(subject.id);
    const known = this.streaks.get(subject.id);
    if (ok) {
      if (!known) this.streaks.set(subject.id, { subject, failingSince: null, lastError: "", settle: true });
      else if (known.failingSince !== null) Object.assign(known, { subject, failingSince: null, settle: true });
      return;
    }
    const reason = deliveryReason(error instanceof Error ? error.message : String(error ?? "unknown"));
    if (known && known.failingSince !== null) Object.assign(known, { subject, lastError: reason });
    else this.streaks.set(subject.id, { subject, failingSince: this.now().getTime(), lastError: reason, settle: false });
  }

  /**
   * What did not work at the last access, as the code's sentence for the
   * `<context>` (audit 2026-10-05), in English like everything the model reads:
   * without the other side's error text, only whether it is the login. Only
   * after `INTEGRATION_DISRUPTED_AFTER_MS`, so a dropout does not become turn
   * knowledge.
   */
  failing(): string[] {
    const now = this.now().getTime();
    return [...this.streaks.values()]
      .filter((streak) => streak.failingSince !== null && now - streak.failingSince >= INTEGRATION_DISRUPTED_AFTER_MS)
      .map((streak) => describeDown(streak.subject, Math.max(1, Math.round((now - streak.failingSince!) / 60_000)), streak.lastError, "en"));
  }

  /** The owner disconnected the login: no outage, an open incident is closed silently. */
  forget(id: string): void {
    const known = this.streaks.get(id);
    if (known) Object.assign(known, { failingSince: null, settle: true });
  }

  /** Runs along with the scheduler's beat. */
  async maybeRun(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      if (await this.deps.paused()) return;
      for (const [id, streak] of [...this.streaks]) {
        try {
          await this.check(id, streak);
        } catch (error) {
          log.error(`State of ${id} not checked:`, error);
        }
      }
      await this.checkExpiry().catch((error: unknown) => log.error("Expiry of the connections not checked:", error));
    } finally {
      this.running = false;
    }
  }

  private async check(id: string, streak: Streak): Promise<void> {
    const component: IncidentComponent = `integration:${id}`;
    const now = this.now();
    if (streak.failingSince === null) {
      if (!streak.settle) return;
      streak.settle = false;
      const open = await this.deps.incidents.find(component);
      if (!open) return;
      await this.deps.incidents.close(component, "detected automatically: ok again");
      const told = open.detail["notified"] === true;
      await audit("integration_health", { integration: id, healthy: true, notified: told });
      // Whoever was never warned needs no all-clear; at night it does not wait until 8 o'clock, by then it is old.
      if (told && !inQuietHours(now)) await this.deps.send(describeUp(streak.subject), { kind: "integration_health", integration: id, healthy: true });
      return;
    }
    const downMs = now.getTime() - streak.failingSince;
    if (downMs < INTEGRATION_DOWN_AFTER_MS) return;
    let incident = await this.deps.incidents.find(component);
    if (!incident) {
      incident = await this.deps.incidents.open(component, `detected automatically: ${streak.lastError}`);
      await audit("integration_health", { integration: id, healthy: false, reason: streak.lastError, kind: failureKind(streak.lastError) });
    }
    if (!incident || incident.detail["notified"] === true) return;
    // At night the incident stays open and unreported; at 8 o'clock the report comes if it still fails then.
    if (inQuietHours(now)) return;
    const minutes = Math.round(downMs / 60_000);
    const sent = await this.deps.send(describeDown(streak.subject, minutes, streak.lastError), {
      kind: "integration_health",
      integration: id,
      healthy: false,
    });
    if (!sent) return;
    await this.deps.incidents.markNotified(incident);
    const command = reconnectCommand(streak.subject, streak.lastError);
    if (command) await this.deps.send(command, { kind: "integration_health", integration: id, copy: true }, { verbatim: true });
  }

  /** Once an hour: does an approval expire in the next seven days? Exactly one report per expiry. */
  private async checkExpiry(): Promise<void> {
    if (!this.deps.connectors) return;
    const now = this.now();
    if (now.getTime() - this.lastExpiryCheck < CONNECTOR_EXPIRY_CHECK_MS || inQuietHours(now)) return;
    this.lastExpiryCheck = now.getTime();
    const due = (await this.deps.connectors()).filter(
      (connector) => connector.expiresAt !== null && connector.expiresAt.getTime() - now.getTime() <= CONNECTOR_EXPIRY_WARN_MS,
    );
    if (due.length === 0) return;
    const warned = await this.deps.expiryWarned.load();
    for (const connector of due) {
      const key = connector.expiresAt!.toISOString();
      if (warned[connector.id] === key) continue;
      const sent = await this.deps.send(describeExpiry(connector, now), { kind: "connector_expiry", connector: connector.id, expires_at: key });
      if (!sent) continue;
      warned[connector.id] = key;
      await this.deps.expiryWarned.save(warned);
    }
  }
}

/**
 * The calendar with bookkeeping: every `list` reports whether it worked. Only
 * `list`: everyone reads it (heartbeat, mail trigger, tools) with periods from
 * the code; when writing, an error can also be the event's fault.
 */
export function monitoredCalendar(calendar: Calendar, report: (ok: boolean, error?: unknown) => void): Calendar {
  return new Proxy(calendar, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (property !== "list" || typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        try {
          const result = (await (value as (...inner: unknown[]) => Promise<unknown>).apply(target, args)) as unknown;
          report(true);
          return result;
        } catch (error) {
          report(false, error);
          throw error;
        }
      };
    },
  });
}
