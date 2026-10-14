import { GoogleError, type GoogleClient } from "../google/client.js";
import { CalendarError, weeklyRule, type Calendar, type CalendarEntry, type EntryDraft } from "./types.js";
import { owner } from "../config/owner.js";
import { OWNER_TIMEZONE } from "../time.js";
import { t } from "../i18n/catalog.js";
import { calendar as calendarText } from "../i18n/messages/calendar.js";

/**
 * Google Calendar, only the owner's primary calendar (D32). Scope `calendar.events`: read and
 * write events, create no calendars, change no sharing.
 *
 * Times go to Google as wall time plus time zone (`dateTime` without offset,
 * the owner's `timeZone`). Nothing is computed here: an offset that nobody
 * computes cannot be wrong at a clock change (D15).
 */

const BASE = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
export const CALENDAR_ZONE = OWNER_TIMEZONE;

interface GoogleEvent {
  id: string;
  status?: string;
  summary?: string;
  location?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  attendees?: Array<{ email?: string; self?: boolean; responseStatus?: string }>;
  organizer?: { self?: boolean };
}

function toEntry(event: GoogleEvent): CalendarEntry {
  return {
    id: event.id,
    title: event.summary ?? "",
    start: event.start?.dateTime ?? event.start?.date ?? "",
    end: event.end?.dateTime ?? event.end?.date ?? "",
    allDay: event.start?.date !== undefined,
    location: event.location ?? "",
    guests: (event.attendees ?? []).filter((guest) => !guest.self && guest.email).map((guest) => guest.email as string),
    status: event.status ?? "confirmed",
    // Without an organizer it is an event in the owner's own calendar that they created themselves.
    organizerSelf: event.organizer?.self ?? true,
    declined: (event.attendees ?? []).some((guest) => guest.self === true && guest.responseStatus === "declined"),
  };
}

function body(draft: EntryDraft): Record<string, unknown> {
  const when = (value: string) => (draft.allDay ? { date: value } : { dateTime: value, timeZone: CALENDAR_ZONE });
  return {
    ...(draft.title !== undefined ? { summary: draft.title } : {}),
    ...(draft.location !== undefined ? { location: draft.location } : {}),
    ...(draft.description !== undefined ? { description: draft.description } : {}),
    ...(draft.start !== undefined ? { start: when(draft.start) } : {}),
    ...(draft.end !== undefined ? { end: when(draft.end) } : {}),
    ...(draft.guests !== undefined ? { attendees: draft.guests.map((email) => ({ email })) } : {}),
    ...(draft.repeat ? { recurrence: [`RRULE:${weeklyRule(draft.repeat)}`] } : {}),
  };
}

export function googleCalendar(google: GoogleClient): Calendar {
  const wrap = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      if (error instanceof GoogleError) throw new CalendarError(`Google Calendar: ${error.message}`);
      throw error;
    }
  };
  const notify = (on: boolean) => `sendUpdates=${on ? "all" : "none"}`;

  return {
    label: `${owner.name}'s Google Calendar`,
    provider: "google",
    invites: true,
    // Last line under the delete preview, straight to the owner: in their language, at the time of the preview.
    get deleteUndo() {
      return t(calendarText.deleteUndoGoogle);
    },
    list: ({ from, to, limit }) =>
      wrap(async () => {
        const params = new URLSearchParams({
          timeMin: from,
          timeMax: to,
          singleEvents: "true",
          orderBy: "startTime",
          maxResults: String(limit + 1),
          timeZone: CALENDAR_ZONE,
        });
        const data = await google.request<{ items?: GoogleEvent[] }>(`${BASE}?${params}`);
        const entries = (data.items ?? []).filter((event) => event.status !== "cancelled").map(toEntry);
        return { entries: entries.slice(0, limit), truncated: entries.length > limit };
      }),

    get: (id) =>
      wrap(async () => {
        try {
          const event = await google.request<GoogleEvent>(`${BASE}/${encodeURIComponent(id)}`);
          return event.status === "cancelled" ? null : toEntry(event);
        } catch (error) {
          if (error instanceof GoogleError && (error.status === 404 || error.status === 410)) return null;
          throw error;
        }
      }),

    create: (draft) =>
      wrap(async () =>
        toEntry(
          await google.request<GoogleEvent>(`${BASE}?${notify((draft.guests ?? []).length > 0)}`, { method: "POST", body: body(draft) }),
        ),
      ),

    update: (id, draft, notifyGuests) =>
      wrap(async () =>
        toEntry(
          await google.request<GoogleEvent>(`${BASE}/${encodeURIComponent(id)}?${notify(notifyGuests)}`, { method: "PATCH", body: body(draft) }),
        ),
      ),

    remove: (id, notifyGuests) =>
      wrap(async () => void (await google.request<null>(`${BASE}/${encodeURIComponent(id)}?${notify(notifyGuests)}`, { method: "DELETE" }))),
  };
}
