import { DATA_CALENDAR_MAX_ROWS, DATA_MAIL_MAX_ROWS } from "../config/limits.js";
import type { Calendar } from "../calendar/types.js";
import type { MailAccount, MailSearchFolder } from "../mail/types.js";
import { owner } from "../config/owner.js";

/**
 * Own data for analysis (D63, building block D). A source delivers rows (JSON
 * objects) from a period; `analyze_data` puts them as a file into the sandbox,
 * where the model analyses them with Python. The sandbox has no network, so
 * what lies there cannot leave the server; only the program's output comes
 * back, and it is untrusted content like the source itself.
 *
 * Sources come and go: a mailbox with `exportHeaders`, the calendar, and every
 * connection whose driver offers data (`LiveConnector.datasets`). Hence a
 * registry filled at runtime instead of a fixed list.
 */

export interface DataRequest {
  /** Start, inclusive. */
  from: Date;
  /** End, exclusive. */
  to: Date;
  /** Mail only: which folder. */
  folder?: MailSearchFolder;
  signal?: Promise<void>;
}

export interface DataRows {
  rows: Record<string, unknown>[];
  /** There was more than delivered; the analysis says so. */
  truncated: boolean;
}

export interface DataSource {
  /** Name in the tool, e.g. `mail_gmx`, `calendar`, `bank`. */
  readonly name: string;
  /** One line for the description: what a row is and which fields it has. */
  readonly fields: string;
  /** Can the source reach into the future (events)? Otherwise every period ends now at the latest. */
  readonly future?: boolean;
  /** Does the source have folders (mail)? */
  readonly folders?: boolean;
  load(request: DataRequest): Promise<DataRows>;
}

/** The sources of this process. Tool and connections share the same object. */
export class DataSources {
  private readonly entries = new Map<string, DataSource>();

  add(source: DataSource): void {
    this.entries.set(source.name, source);
  }

  remove(name: string): void {
    this.entries.delete(name);
  }

  get(name: string): DataSource | undefined {
    return this.entries.get(name);
  }

  list(): DataSource[] {
    return [...this.entries.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
}

const MAIL_FIELDS =
  "one row per mail, headers only, never the body: id, account, folder, date (received, ISO), headers (the raw header " +
  "with Received chain, Return-Path, To/Delivered-To, Authentication-Results, DKIM-Signature, List-*; readable with " +
  "email.parser.HeaderParser)";

/** A mailbox as a source, when it can deliver headers in bulk. */
export function mailSource(account: MailAccount, name: string): DataSource | null {
  const exportHeaders = account.exportHeaders?.bind(account);
  if (!exportHeaders) return null;
  return {
    name,
    fields: `Mailbox ${account.address}: ${MAIL_FIELDS}`,
    folders: true,
    async load(request) {
      const { rows, truncated } = await exportHeaders({
        folder: request.folder ?? "all",
        since: request.from,
        before: request.to,
        max: DATA_MAIL_MAX_ROWS,
      });
      return {
        rows: rows.map((row) => ({ id: `${account.id}:${row.providerId}`, account: account.id, folder: row.folder, date: row.date, headers: row.headers })),
        truncated,
      };
    },
  };
}

/** The calendar as a source: times, title and location. Titles are written by whoever invites: untrusted content. */
export function calendarSource(calendar: Calendar): DataSource {
  return {
    name: "calendar",
    fields:
      `${calendar.label}: one row per event: start, end (ISO, the day for all-day events), all_day, title, location, calendar ` +
      `(which calendar, when there are several), declined (${owner.name} declined)`,
    future: true,
    async load(request) {
      const { entries, truncated } = await calendar.list({
        from: request.from.toISOString(),
        to: request.to.toISOString(),
        limit: DATA_CALENDAR_MAX_ROWS,
      });
      return {
        rows: entries.map((entry) => ({
          start: entry.start,
          end: entry.end,
          all_day: entry.allDay,
          title: entry.title,
          location: entry.location,
          calendar: entry.calendar ?? "",
          declined: entry.declined,
        })),
        truncated,
      };
    },
  };
}
