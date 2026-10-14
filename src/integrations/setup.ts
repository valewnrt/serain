import { caldavCalendar, iCloudDav } from "../calendar/caldav.js";
import { googleCalendar } from "../calendar/google.js";
import { CalendarError, type Calendar } from "../calendar/types.js";
import { audit } from "../db/audit.js";
import { GMAIL_MODIFY_SCOPE, googleClient } from "../google/client.js";
import { log } from "../log.js";
import { gmailAccount } from "../mail/gmail.js";
import { imapAccount } from "../mail/imap.js";
import { MailError, type MailAccount } from "../mail/types.js";
import type { Integrations } from "./service.js";

/**
 * At startup, the connected credentials become the services that tools and
 * triggers use (D30). The mailboxes in the order they were connected
 * (`IntegrationStore.list`): the one connected first is the main mailbox, no
 * matter which provider. Reconnecting changes nothing about that, only
 * disconnecting and connecting again. Serain's own mailbox always comes last
 * (addendum D31 of 2026-10-08).
 *
 * **Disconnecting takes effect immediately, not only after a restart (W13).**
 * Every access first checks whether the credential still exists. If it is
 * gone, the service closes its connection and answers "disconnected" from then
 * on: otherwise the secret would live on in the process's memory although the
 * owner deleted it.
 */

export interface ConnectedServices {
  mail: MailAccount[];
  /**
   * The calendar for the tools. iCloud when connected (D54); otherwise Google. Always exactly one: two calendars to write
   * into would mean guessing which one is meant.
   */
  calendar: Calendar | null;
  /** The integration behind `calendar`, for notices about its state. */
  calendarId: string | null;
}

/**
 * The error a disconnected credential throws carries `disconnected`: the owner
 * disconnected, that is no outage src/health/integrations.ts should report.
 */
function disconnected(error: Error): Error {
  return Object.assign(error, { disconnected: true });
}

function guarded<T extends object>(target: T, stillConnected: () => Promise<boolean>, gone: () => Error, onGone: () => Promise<void>): T {
  let closed = false;
  const wrap = <O extends object>(inner: O): O =>
    new Proxy(inner, {
      get(object, property, receiver) {
        const value = Reflect.get(object, property, receiver) as unknown;
        // A capability like `cleanup` (D37) is an object with its own methods: the same check, the same state.
        if (typeof value === "object" && value !== null) return wrap(value);
        if (typeof value !== "function" || property === "close") return value;
        return async (...args: unknown[]) => {
          if (closed || !(await stillConnected())) {
            if (!closed) {
              closed = true;
              await onGone().catch(() => undefined);
            }
            throw disconnected(gone());
          }
          return (value as (...inner: unknown[]) => unknown).apply(object, args);
        };
      },
    });
  return wrap(target);
}

export async function connectServices(
  integrations: Integrations,
  /** A credential could not be opened (key, secret): missing until the next start, so worth a notice. */
  onUnusable?: (id: string, error: unknown) => void,
): Promise<ConnectedServices> {
  const services: ConnectedServices = { mail: [], calendar: null, calendarId: null };
  if (!integrations.enabled) return services;
  const rows = await integrations.list();
  // Before every call: disconnecting happens on the Mac, in another process (D30). Only the ID, never the sealed part.
  const exists = (id: string) => () => integrations.has(id);

  for (const row of rows) {
    try {
      if (row.kind === "caldav") {
        const secret = await integrations.secret(row.id, "caldav");
        services.calendarId = row.id;
        services.calendar = guarded(
          caldavCalendar(iCloudDav(secret), { account: row.account, writeCalendarUrl: secret.writeCalendarUrl }),
          exists(row.id),
          () => new CalendarError("iCloud calendar is disconnected."),
          async () => undefined,
        );
      } else if (row.kind === "imap") {
        const account = imapAccount(row.id, row.account, await integrations.secret(row.id, "imap"));
        services.mail.push(guarded(account, exists(row.id), () => new MailError(`Mailbox ${row.id} is disconnected.`), () => account.close()));
      } else {
        const google = googleClient(await integrations.secret(row.id, "google"));
        // Cleanup only when the owner granted `gmail.modify` (addendum D37 of 2026-10-13); older credentials have `gmail.readonly`.
        const account = gmailAccount(row.id, row.account, google, { cleanup: row.scopes.includes(GMAIL_MODIFY_SCOPE) });
        services.mail.push(guarded(account, exists(row.id), () => new MailError(`Mailbox ${row.id} is disconnected.`), async () => undefined));
        // A connected iCloud calendar takes precedence, no matter in which order the rows come.
        if (!rows.some((other) => other.kind === "caldav")) {
          if (!services.calendar) {
            services.calendarId = row.id;
            services.calendar = guarded(googleCalendar(google), exists(row.id), () => new CalendarError("Google Calendar is disconnected."), async () => undefined);
          }
        }
      }
    } catch (error) {
      // A credential that cannot be opened (wrong key) does not take the others down with it.
      log.error(`Integration ${row.id} not usable:`, (error as Error).message);
      onUnusable?.(row.id, error);
      await audit("error", { stage: "integration_setup", id: row.id, reason: (error as Error).message });
    }
  }
  // Serain's own mailbox never first: the first is the owner's main mailbox, the default of every mail tool.
  services.mail.sort((a, b) => Number(a.serains === true) - Number(b.serains === true));
  return services;
}
