import { z } from "zod";

/**
 * Protocol between Serain (server) and the Mac companion (D28). Both sides read
 * this one file: the server before it asks, the Mac before it answers. The Mac
 * does not trust the server: it checks every argument again itself and only
 * knows these tools, and they can only read. Logged-in sessions also ran here
 * until D49; they moved to the server, and the vault with them.
 */
export const COMPANION_PROTOCOL_VERSION = 1;

/** Port of the companion on the Mac (loopback only). */
export const COMPANION_MAC_PORT = 47811;
/** Port on the server where the SSH tunnel makes the Mac appear (loopback only). */
export const COMPANION_SERVER_PORT = 47812;

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date as YYYY-MM-DD");

/** Narrow scope per call (W3): one period, one list, one name, one page. Never "everything". */
export const COMPANION_TOOLS = {
  calendar_events: z.object({ from: day, to: day }).strict(),
  reminders_open: z.object({ list: z.string().trim().min(1).max(100).optional() }).strict(),
  contacts_search: z.object({ query: z.string().trim().min(2).max(80) }).strict(),
  browser_render: z.object({ url: z.string().trim().min(8).max(2_000) }).strict(),
} as const;

export type CompanionTool = keyof typeof COMPANION_TOOLS;

export function isCompanionTool(name: string): name is CompanionTool {
  return Object.hasOwn(COMPANION_TOOLS, name);
}

/** Hard caps the Mac enforces, whatever the server asks for. */
export const COMPANION_LIMITS = {
  calendarMaxDays: 31,
  calendarMaxEvents: 50,
  remindersMax: 50,
  contactsMax: 10,
  browserMaxBytes: 2_000_000,
  browserTimeoutMs: 25_000,
  appleTimeoutMs: 20_000,
  /** Calls per window: a person asks a few times a day, no tool a hundred times. */
  callsPerWindow: 30,
  windowMs: 10 * 60_000,
  maxBodyBytes: 8_192,
} as const;

export interface CalendarEvent {
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  calendar: string;
  location: string;
}
export interface OpenReminder {
  title: string;
  due: string | null;
  list: string;
}
export interface ContactCard {
  name: string;
  organization: string;
  phones: string[];
  emails: string[];
}

export interface CompanionResults {
  calendar_events: { events: CalendarEvent[]; truncated: boolean };
  reminders_open: { reminders: OpenReminder[]; truncated: boolean };
  /**
   * `matchedBy`: a query with "@" searches the mail addresses, otherwise the name.
   * Without the field the helper on the Mac is older and searched by name.
   */
  contacts_search: { contacts: ContactCard[]; truncated: boolean; matchedBy?: "name" | "email" };
  browser_render: { url: string; html: string; truncated: boolean };
}

export type CompanionErrorCode =
  | "unauthorized"
  | "bad_request"
  | "unknown_tool"
  | "rate_limited"
  | "not_authorized"
  | "disabled"
  | "blocked"
  | "timeout"
  | "failed";

export type CompanionResponse<T = unknown> =
  | { ok: true; result: T }
  | { ok: false; code: CompanionErrorCode; error: string };
