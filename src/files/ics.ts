import ICAL from "ical.js";
import { t } from "../i18n/catalog.js";
import { media } from "../i18n/messages/media.js";
import { addDays, parseDay, parseWallTime, wallTimeToUtc } from "../time.js";

/**
 * An event as .ics to forward or tap (sending files, audit 2026-10-05). Unlike
 * `calendar_create` this enters nothing: the owner taps the file and decides
 * which calendar it goes into, or forwards it to someone. Times go out as UTC,
 * so the file needs no time zone definition, and every calendar app shows them
 * correctly.
 *
 * `summary` is the caption under the file, a fixed text to the owner in their
 * language (`media.icsAllDay`); dates in it stay as given. `reason` goes to the
 * model.
 */

export interface IcsEvent {
  title: string;
  /** `YYYY-MM-DD HH:mm` wall time in the owner's time zone, or `YYYY-MM-DD` for all day. */
  start: string;
  /** Like `start`; without it one hour or one day. Inclusive for all-day events. */
  end?: string | undefined;
  location?: string | undefined;
  description?: string | undefined;
}

export type IcsResult = { ok: true; body: Buffer; summary: string } | { ok: false; reason: string };

export function buildIcs(event: IcsEvent, options: { uid: string; now: Date }): IcsResult {
  const root = new ICAL.Component(["vcalendar", [], []]);
  root.updatePropertyWithValue("prodid", "-//Serain//EN");
  root.updatePropertyWithValue("version", "2.0");
  root.updatePropertyWithValue("calscale", "GREGORIAN");
  root.updatePropertyWithValue("method", "PUBLISH");
  const vevent = new ICAL.Component("vevent");
  vevent.updatePropertyWithValue("uid", options.uid);
  vevent.updatePropertyWithValue("dtstamp", ICAL.Time.fromJSDate(options.now, true));
  vevent.updatePropertyWithValue("summary", event.title);

  let summary: string;
  if (parseDay(event.start)) {
    const last = event.end ?? event.start;
    if (!parseDay(last)) return { ok: false, reason: "An all-day event needs end as YYYY-MM-DD." };
    if (last < event.start) return { ok: false, reason: "end is before start." };
    vevent.updatePropertyWithValue("dtstart", ICAL.Time.fromDateString(event.start));
    // For all-day events DTEND is the day after (RFC 5545).
    vevent.updatePropertyWithValue("dtend", ICAL.Time.fromDateString(addDays(last, 1)));
    summary = last === event.start ? t(media.icsAllDay, { day: event.start }) : t(media.icsAllDayRange, { from: event.start, to: last });
  } else {
    const from = parseWallTime(event.start);
    if (!from) return { ok: false, reason: "start is neither YYYY-MM-DD HH:mm nor YYYY-MM-DD." };
    const startUtc = wallTimeToUtc(from);
    let endUtc = new Date(startUtc.getTime() + 3_600_000);
    if (event.end !== undefined) {
      const to = parseWallTime(event.end);
      if (!to) return { ok: false, reason: "end is not a wall time in the format YYYY-MM-DD HH:mm." };
      endUtc = wallTimeToUtc(to);
      if (endUtc <= startUtc) return { ok: false, reason: "end is not after start." };
    }
    vevent.updatePropertyWithValue("dtstart", ICAL.Time.fromJSDate(startUtc, true));
    vevent.updatePropertyWithValue("dtend", ICAL.Time.fromJSDate(endUtc, true));
    summary = event.start;
  }
  if (event.location) vevent.updatePropertyWithValue("location", event.location);
  if (event.description) vevent.updatePropertyWithValue("description", event.description);
  root.addSubcomponent(vevent);
  return { ok: true, body: Buffer.from(root.toString().replace(/\r?\n/g, "\r\n") + "\r\n", "utf8"), summary };
}
