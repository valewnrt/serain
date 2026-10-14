import { randomUUID } from "node:crypto";
import ICAL from "ical.js";
import { DAVClient, type DAVCalendar } from "tsdav";
import { CALDAV_CALENDAR_CACHE_MS, CALDAV_MAX_OCCURRENCES, CALDAV_TIMEOUT_MS } from "../config/limits.js";
import type { CaldavSecret } from "../integrations/types.js";
import { log, redactValue } from "../log.js";
import { OWNER_TIMEZONE, parseDay, toWallTime, wallTimeToUtc } from "../time.js";
import { CalendarError, weeklyRule, type Calendar, type CalendarEntry, type EntryDraft } from "./types.js";
import { buildVTimezone } from "./vtimezone.js";
import { owner } from "../config/owner.js";
import { t } from "../i18n/catalog.js";
import { calendar as calendarText } from "../i18n/messages/calendar.js";

/**
 * The owner's iCloud calendar over CalDAV (D54): what Serain enters should
 * show up on the iPhone.
 *
 * **Access:** Apple ID with an app-specific password, sealed in
 * `integrations` (D30). The password leaves this module only in the
 * Authorization header, and only to iCloud hosts: a typo in a URL or a
 * crafted response carries it nowhere else.
 *
 * **Reading** across all event calendars of the account. **Writing** into the
 * one that fits the event (Serain picks, `EntryDraft.calendar`), else into the
 * default the owner chose when connecting. Serain does not invite guests here
 * (`invites: false`): iCloud sends invitations itself as soon as an event has
 * attendees, and that cannot be taken back without a preview.
 *
 * **Series** are expanded here (ical.js), not by the server: every event of a
 * series has its own ID from path and recurrence ID. Changing creates an
 * exception, deleting an EXDATE; the series itself stays.
 *
 * **A concurrent change** on the iPhone is never overwritten by Serain: every
 * write carries the ETag it read.
 */

export interface DavObject {
  url: string;
  etag: string | null;
  data: string;
}

/** What the adapter needs from the server. Small, so the test can play a server without network. */
export interface DavApi {
  /** Event calendars of the account (VEVENT), without reminder lists. */
  calendars(): Promise<Array<{ url: string; name: string }>>;
  query(calendarUrl: string, range: { start: string; end: string }): Promise<DavObject[]>;
  get(url: string): Promise<DavObject | null>;
  /** `etag` null means create: fails if the file already exists. */
  put(url: string, data: string, etag: string | null): Promise<void>;
  remove(url: string, etag: string | null): Promise<void>;
}

export class DavError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "DavError";
  }
}

export const ICLOUD_CALDAV = "https://caldav.icloud.com";

function iCloudHost(url: URL): boolean {
  return url.protocol === "https:" && (url.hostname === "caldav.icloud.com" || url.hostname.endsWith(".icloud.com"));
}

/** CalDAV against iCloud. `fetchImpl` only for tests. */
export function iCloudDav(secret: Pick<CaldavSecret, "user" | "password">, fetchImpl: typeof fetch = fetch): DavApi {
  redactValue(secret.password);
  const authorization = `Basic ${Buffer.from(`${secret.user}:${secret.password}`).toString("base64")}`;
  redactValue(authorization);

  const guarded: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (!iCloudHost(url)) throw new CalendarError(`iCloud: ${url.hostname} is not an iCloud server, request not sent.`);
    return fetchImpl(input, { ...init, signal: AbortSignal.timeout(CALDAV_TIMEOUT_MS) });
  };

  const client = new DAVClient({
    serverUrl: ICLOUD_CALDAV,
    credentials: { username: secret.user, password: secret.password },
    authMethod: "Basic",
    defaultAccountType: "caldav",
    fetch: guarded,
  });
  let loggedIn: Promise<void> | null = null;
  let cached: { at: number; calendars: DAVCalendar[] } | null = null;

  const login = () => {
    loggedIn ??= client.login().catch((error: unknown) => {
      loggedIn = null;
      throw error;
    });
    return loggedIn;
  };
  const calendars = async (): Promise<DAVCalendar[]> => {
    if (cached && Date.now() - cached.at < CALDAV_CALENDAR_CACHE_MS) return cached.calendars;
    await login();
    const all = await client.fetchCalendars();
    const events = all.filter((calendar) => (calendar.components ?? ["VEVENT"]).includes("VEVENT"));
    cached = { at: Date.now(), calendars: events };
    return events;
  };
  const request = async (url: string, init: RequestInit): Promise<Response> =>
    guarded(url, { ...init, headers: { ...(init.headers as Record<string, string>), authorization } });
  const failed = (what: string, response: Response) =>
    new DavError(
      response.status === 412
        ? "The event was just changed elsewhere. Read it again before you change anything."
        : response.status === 401
          ? `iCloud rejects the login. ${owner.name} has to reconnect the access (pnpm integration connect icloud).`
          : `${what} failed (HTTP ${response.status}).`,
      response.status,
    );

  return {
    async calendars() {
      return (await calendars()).map((calendar) => ({
        url: calendar.url,
        name: typeof calendar.displayName === "string" ? calendar.displayName : calendar.url,
      }));
    },
    async query(calendarUrl, range) {
      const calendar = (await calendars()).find((candidate) => candidate.url === calendarUrl);
      if (!calendar) return [];
      const objects = await client.fetchCalendarObjects({ calendar, timeRange: range });
      return objects
        .filter((object) => typeof object.data === "string" && object.data.length > 0)
        .map((object) => ({ url: object.url, etag: object.etag ?? null, data: object.data as string }));
    },
    async get(url) {
      const response = await request(url, { method: "GET" });
      if (response.status === 404 || response.status === 410) return null;
      if (!response.ok) throw failed("Reading the event", response);
      return { url, etag: response.headers.get("etag"), data: await response.text() };
    },
    async put(url, data, etag) {
      const response = await request(url, {
        method: "PUT",
        body: data,
        headers: { "content-type": "text/calendar; charset=utf-8", ...(etag ? { "if-match": etag } : { "if-none-match": "*" }) },
      });
      if (!response.ok) throw failed("Saving the event", response);
    },
    async remove(url, etag) {
      const response = await request(url, { method: "DELETE", headers: etag ? { "if-match": etag } : {} });
      if (!response.ok && response.status !== 404) throw failed("Deleting the event", response);
    },
  };
}

// --- iCalendar -------------------------------------------------------------

/** The owner's time zone as a VTIMEZONE (`vtimezone.ts`). For events that Serain creates itself. */
const OWNER_VTIMEZONE = buildVTimezone(OWNER_TIMEZONE);

function ownerZoneComponent(): ICAL.Component {
  return new ICAL.Component(ICAL.parse(OWNER_VTIMEZONE) as unknown[]);
}
ICAL.TimezoneService.register(ownerZoneComponent());

function parseCalendar(data: string): ICAL.Component {
  let root: ICAL.Component;
  try {
    root = new ICAL.Component(ICAL.parse(data) as unknown[]);
  } catch {
    throw new CalendarError("iCloud returned an event that cannot be read.");
  }
  // Before the first access to a time: ical.js looks up the TZID when reading.
  for (const zone of root.getAllSubcomponents("vtimezone")) {
    const tzid = zone.getFirstPropertyValue("tzid");
    if (typeof tzid === "string" && tzid !== OWNER_TIMEZONE) ICAL.TimezoneService.register(zone);
  }
  return root;
}

/** Instant of an iCal time. Without a known zone (floating) it counts as the owner's wall time. */
function instant(time: ICAL.Time): Date {
  const zone = time.zone;
  if (time.isDate || !zone || zone.tzid === "floating") {
    return wallTimeToUtc({ year: time.year, month: time.month, day: time.day, hour: time.isDate ? 0 : time.hour, minute: time.isDate ? 0 : time.minute });
  }
  return time.toJSDate();
}

const pad = (value: number) => String(value).padStart(2, "0");
const dateOf = (time: ICAL.Time) => `${time.year}-${pad(time.month)}-${pad(time.day)}`;

/** Recurrence ID as a key: day `YYYYMMDD` or UTC `YYYYMMDDTHHMMSSZ`. */
function ridKey(time: ICAL.Time): string {
  if (time.isDate) return dateOf(time).replaceAll("-", "");
  const at = instant(time);
  return `${at.getUTCFullYear()}${pad(at.getUTCMonth() + 1)}${pad(at.getUTCDate())}T${pad(at.getUTCHours())}${pad(at.getUTCMinutes())}${pad(at.getUTCSeconds())}Z`;
}

const RID_PATTERN = /^\d{8}(T\d{6}Z)?$/;

export function encodeId(path: string, rid: string | null): string {
  return Buffer.from(`${path}\n${rid ?? ""}`, "utf8").toString("base64url");
}

export function decodeId(id: string): { path: string; rid: string | null } | null {
  const [path, rid, ...rest] = Buffer.from(id, "base64url").toString("utf8").split("\n");
  if (rest.length > 0 || !path || !path.startsWith("/") || !path.endsWith(".ics") || path.includes("..")) return null;
  if (rid && !RID_PATTERN.test(rid)) return null;
  return { path, rid: rid || null };
}

interface Occurrence {
  rid: string | null;
  start: ICAL.Time;
  end: ICAL.Time;
  item: ICAL.Event;
}

function mailOf(value: unknown): string {
  return typeof value === "string" ? value.replace(/^mailto:/i, "").trim().toLowerCase() : "";
}

function toEntry(path: string, occurrence: Occurrence, account: string, calendar?: string): CalendarEntry | null {
  const component = occurrence.item.component;
  const status = String(component.getFirstPropertyValue("status") ?? "CONFIRMED").toLowerCase();
  if (status === "cancelled") return null;
  const self = account.toLowerCase();
  const attendees = component.getAllProperties("attendee");
  const organizer = mailOf(component.getFirstPropertyValue("organizer"));
  const allDay = occurrence.start.isDate;
  return {
    id: encodeId(path, occurrence.rid),
    title: occurrence.item.summary ?? "",
    start: allDay ? dateOf(occurrence.start) : instant(occurrence.start).toISOString(),
    end: allDay ? dateOf(occurrence.end) : instant(occurrence.end).toISOString(),
    allDay,
    location: occurrence.item.location ?? "",
    guests: attendees.map((attendee) => mailOf(attendee.getFirstValue())).filter((mail) => mail && mail !== self),
    status,
    // Without an organizer it is an own event; with someone else's an invitation.
    organizerSelf: !organizer || organizer === self,
    declined: attendees.some(
      (attendee) => mailOf(attendee.getFirstValue()) === self && String(attendee.getParameter("partstat") ?? "").toUpperCase() === "DECLINED",
    ),
    ...(calendar ? { calendar } : {}),
  };
}

function masterOf(root: ICAL.Component): ICAL.Component | null {
  return root.getAllSubcomponents("vevent").find((event) => !event.hasProperty("recurrence-id")) ?? null;
}

/**
 * The events of a file starting before `until`, in order of the series.
 * Exceptions replace their occurrence; a series without end stops at
 * `CALDAV_MAX_OCCURRENCES`, so that an RRULE per minute does not hold the turn.
 */
function occurrences(root: ICAL.Component, until: Date): Occurrence[] {
  const events = root.getAllSubcomponents("vevent");
  const master = masterOf(root);
  const exceptions = events.filter((event) => event.hasProperty("recurrence-id"));
  const single = (event: ICAL.Event, rid: string | null): Occurrence => ({ rid, start: event.startDate, end: event.endDate, item: event });
  if (!master) return exceptions.map((component) => new ICAL.Event(component)).map((event) => single(event, ridKey(event.recurrenceId)));

  const event = new ICAL.Event(master, { exceptions, strictExceptions: false });
  if (!event.isRecurring()) return [single(event, null)];

  const found: Occurrence[] = [];
  const seen = new Set<string>();
  const iterator = event.iterator();
  for (let index = 0; index < CALDAV_MAX_OCCURRENCES; index++) {
    const next = iterator.next();
    if (!next || instant(next) >= until) break;
    const details = event.getOccurrenceDetails(next);
    const rid = ridKey(details.recurrenceId);
    seen.add(rid);
    found.push({ rid, start: details.startDate, end: details.endDate, item: details.item });
  }
  // An exception moved forward from a later occurrence did not come up above.
  // In ical.js `exceptions` is an object keyed by recurrence ID, not a list.
  for (const exception of Object.values(event.exceptions ?? {}) as ICAL.Event[]) {
    const rid = ridKey(exception.recurrenceId);
    if (!seen.has(rid) && instant(exception.startDate) < until) found.push(single(exception, rid));
  }
  return found;
}

function overlaps(occurrence: Occurrence, from: Date, to: Date): boolean {
  return instant(occurrence.start) < to && instant(occurrence.end) > from;
}

/** Wall time `YYYY-MM-DDTHH:mm:00` or day `YYYY-MM-DD` as an iCal time in the owner's zone. */
function ownerTime(value: string, allDay: boolean): ICAL.Time {
  if (allDay) {
    if (!parseDay(value)) throw new CalendarError(`${value} is not a valid day.`);
    return ICAL.Time.fromDateString(value);
  }
  const time = ICAL.Time.fromDateTimeString(value);
  time.zone = ICAL.TimezoneService.get(OWNER_TIMEZONE) as ICAL.Timezone;
  return time;
}

const ridDay = (rid: string) => `${rid.slice(0, 4)}-${rid.slice(4, 6)}-${rid.slice(6, 8)}`;

/** The instant of a recurrence ID; a day counts from midnight at the owner's. */
function ridInstant(rid: string): Date {
  if (rid.length === 8) return wallTimeToUtc({ ...parseDay(ridDay(rid))!, hour: 0, minute: 0 });
  return new Date(
    Date.UTC(Number(rid.slice(0, 4)), Number(rid.slice(4, 6)) - 1, Number(rid.slice(6, 8)), Number(rid.slice(9, 11)), Number(rid.slice(11, 13)), Number(rid.slice(13, 15))),
  );
}

/** A time in the same zone and kind as `like` (for RECURRENCE-ID and EXDATE). */
function asLike(rid: string, like: ICAL.Time): ICAL.Time {
  if (rid.length === 8) return ICAL.Time.fromDateString(ridDay(rid));
  const at = ridInstant(rid);
  const zone = like.zone;
  if (zone && zone.tzid === "UTC") return ICAL.Time.fromJSDate(at, true);
  if (zone && zone.tzid !== "floating") return ICAL.Time.fromJSDate(at, true).convertToZone(zone);
  const wall = toWallTime(at);
  return ICAL.Time.fromData({ year: wall.year, month: wall.month, day: wall.day, hour: wall.hour, minute: wall.minute, second: 0 });
}

/**
 * A time as a property, with TZID when it has a real zone. ical.js does not
 * set the parameter itself when writing; without it the time would be
 * floating, and the iPhone would show it in whatever zone it is in.
 */
function setTime(component: ICAL.Component, name: string, time: ICAL.Time, add = false): void {
  const property = add ? component.addPropertyWithValue(name, time) : component.updatePropertyWithValue(name, time);
  const tzid = time.zone?.tzid;
  if (time.isDate || !tzid || tzid === "UTC" || tzid === "floating") property.removeParameter("tzid");
  else property.setParameter("tzid", tzid);
}

function stamp(component: ICAL.Component): void {
  component.updatePropertyWithValue("dtstamp", ICAL.Time.fromJSDate(new Date(), true));
  component.updatePropertyWithValue("last-modified", ICAL.Time.fromJSDate(new Date(), true));
}

function setText(component: ICAL.Component, name: string, value: string | undefined): void {
  if (value === undefined) return;
  if (value === "") component.removeAllProperties(name);
  else component.updatePropertyWithValue(name, value);
}

function applyDraft(component: ICAL.Component, draft: EntryDraft): void {
  setText(component, "summary", draft.title);
  setText(component, "location", draft.location);
  setText(component, "description", draft.description);
  if (draft.start !== undefined) {
    const allDay = draft.allDay === true;
    component.removeAllProperties("duration");
    setTime(component, "dtstart", ownerTime(draft.start, allDay));
    if (draft.end !== undefined) setTime(component, "dtend", ownerTime(draft.end, allDay));
  }
}

function bumpSequence(component: ICAL.Component): void {
  const current = Number(component.getFirstPropertyValue("sequence") ?? 0);
  component.updatePropertyWithValue("sequence", Number.isFinite(current) ? current + 1 : 1);
  stamp(component);
}

export interface CaldavOptions {
  /** The Apple ID: who the owner is in ATTENDEE and ORGANIZER. */
  account: string;
  /** Serain writes here; reading is from all event calendars. */
  writeCalendarUrl: string;
}

export function caldavCalendar(api: DavApi, options: CaldavOptions): Calendar {
  const origin = new URL(options.writeCalendarUrl).origin;
  const writeUrl = options.writeCalendarUrl.endsWith("/") ? options.writeCalendarUrl : `${options.writeCalendarUrl}/`;
  const urlOf = (path: string) => new URL(path, origin).href;
  const pathOf = (url: string) => new URL(url, origin).pathname;

  const wrap = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      if (error instanceof CalendarError) throw error;
      if (error instanceof DavError) throw new CalendarError(`iCloud calendar: ${error.message}`);
      // Network, timeout, broken XML: the message into the journal, to the model only that it did not work.
      log.error("iCloud calendar:", (error as Error).message);
      throw new CalendarError("iCloud calendar is not reachable right now.");
    }
  };

  /** Name of the calendar a file is in; the file lies under its URL. */
  const calendarOf = async (url: string) =>
    (await api.calendars()).find((calendar) => new URL(url, origin).href.startsWith(new URL(calendar.url, origin).href))?.name;
  /** Target for creating: the named calendar, else the default. An unknown name is not guessed. */
  const targetUrl = async (name: string | undefined) => {
    if (!name) return writeUrl;
    const calendars = await api.calendars();
    const match = calendars.find((calendar) => calendar.name.trim().toLowerCase() === name.trim().toLowerCase());
    if (!match) throw new CalendarError(`There is no calendar "${name}". Available: ${calendars.map((calendar) => calendar.name).join(", ")}.`);
    return match.url.endsWith("/") ? match.url : `${match.url}/`;
  };

  const load = async (id: string) => {
    const ref = decodeId(id);
    if (!ref) return null;
    const object = await api.get(urlOf(ref.path));
    if (!object) return null;
    const root = parseCalendar(object.data);
    return { ref, object, root };
  };

  /** The occurrence for an ID, or null if it does not exist (any more). */
  const find = (root: ICAL.Component, rid: string | null): Occurrence | null => {
    if (!rid) {
      const master = masterOf(root);
      if (!master) return null;
      const event = new ICAL.Event(master);
      return event.isRecurring() ? null : { rid: null, start: event.startDate, end: event.endDate, item: event };
    }
    // Until shortly after the recurrence ID: moved occurrences keep their ID.
    return occurrences(root, new Date(ridInstant(rid).getTime() + 2 * 86_400_000)).find((occurrence) => occurrence.rid === rid) ?? null;
  };

  return {
    label: `${owner.name}'s iCloud calendar`,
    provider: "icloud",
    invites: false,
    targets: () =>
      wrap(async () => {
        const calendars = await api.calendars();
        const fallback = calendars.find((calendar) => new URL(calendar.url, origin).href === new URL(writeUrl, origin).href)?.name ?? calendars[0]?.name ?? "";
        return { names: calendars.map((calendar) => calendar.name), fallback };
      }),
    // Last line under the delete preview, straight to the owner: in their language, at the time of the preview.
    get deleteUndo() {
      return t(calendarText.deleteUndoIcloud);
    },

    list: ({ from, to, limit }) =>
      wrap(async () => {
        const start = new Date(from);
        const end = new Date(to);
        const calendars = await api.calendars();
        const objects = (
          await Promise.all(
            calendars.map(async (calendar) => (await api.query(calendar.url, { start: from, end: to })).map((object) => ({ ...object, calendar: calendar.name }))),
          )
        ).flat();
        const entries: CalendarEntry[] = [];
        for (const object of objects) {
          // An invitation from anyone can be broken; it does not take the other events down with it.
          try {
            const root = parseCalendar(object.data);
            for (const occurrence of occurrences(root, end)) {
              if (!overlaps(occurrence, start, end)) continue;
              const entry = toEntry(pathOf(object.url), occurrence, options.account, object.calendar);
              if (entry) entries.push(entry);
            }
          } catch (error) {
            log.warn(`iCloud calendar: skipped an unreadable event (${object.data.length} characters): ${(error as Error).message.slice(0, 120)}`);
          }
        }
        const at = (entry: CalendarEntry) => (entry.allDay ? wallTimeToUtc({ ...parseDay(entry.start)!, hour: 0, minute: 0 }) : new Date(entry.start)).getTime();
        entries.sort((a, b) => at(a) - at(b));
        return { entries: entries.slice(0, limit), truncated: entries.length > limit };
      }),

    get: (id) =>
      wrap(async () => {
        const loaded = await load(id);
        if (!loaded) return null;
        const occurrence = find(loaded.root, loaded.ref.rid);
        return occurrence ? toEntry(loaded.ref.path, occurrence, options.account, await calendarOf(loaded.object.url)) : null;
      }),

    create: (draft) =>
      wrap(async () => {
        if ((draft.guests ?? []).length > 0) throw new CalendarError("Serain does not send invitations through iCloud.");
        if (draft.start === undefined || draft.end === undefined) throw new CalendarError("Start and end are missing.");
        const uid = randomUUID().toUpperCase();
        const root = new ICAL.Component(["vcalendar", [], []]);
        root.updatePropertyWithValue("prodid", "-//Serain//EN");
        root.updatePropertyWithValue("version", "2.0");
        root.updatePropertyWithValue("calscale", "GREGORIAN");
        if (draft.allDay !== true) root.addSubcomponent(ownerZoneComponent());
        const event = new ICAL.Component("vevent");
        event.updatePropertyWithValue("uid", uid);
        event.updatePropertyWithValue("created", ICAL.Time.fromJSDate(new Date(), true));
        stamp(event);
        applyDraft(event, draft);
        if (draft.repeat) event.addPropertyWithValue("rrule", ICAL.Recur.fromString(weeklyRule(draft.repeat)));
        root.addSubcomponent(event);
        const url = `${await targetUrl(draft.calendar)}${uid}.ics`;
        await api.put(url, root.toString(), null);
        const first = occurrences(root, new Date(8.64e15))[0];
        if (!first) throw new CalendarError(`The event is created but has no occurrence. Tell ${owner.name}.`);
        const entry = toEntry(pathOf(url), first, options.account, await calendarOf(url));
        if (!entry) throw new CalendarError(`The event is created but cannot be read. Tell ${owner.name}.`);
        return entry;
      }),

    update: (id, draft) =>
      wrap(async () => {
        if ((draft.guests ?? []).length > 0) throw new CalendarError("Serain does not send invitations through iCloud.");
        const loaded = await load(id);
        if (!loaded) throw new CalendarError("This event does not exist (any more).");
        const { ref, object, root } = loaded;
        const occurrence = find(root, ref.rid);
        if (!occurrence) throw new CalendarError("This event does not exist (any more).");
        const master = masterOf(root);
        let target: ICAL.Component;
        if (!ref.rid || !master) {
          target = occurrence.item.component;
        } else {
          const existing = root
            .getAllSubcomponents("vevent")
            .find((event) => event.hasProperty("recurrence-id") && ridKey(new ICAL.Event(event).recurrenceId) === ref.rid);
          if (existing) {
            target = existing;
          } else {
            // Exception for exactly this occurrence: a copy without repetition, with RECURRENCE-ID.
            target = new ICAL.Component(structuredClone(master.toJSON()) as unknown[]);
            for (const name of ["rrule", "rdate", "exdate", "duration"]) target.removeAllProperties(name);
            setTime(target, "recurrence-id", asLike(ref.rid, new ICAL.Event(master).startDate));
            setTime(target, "dtstart", occurrence.start);
            setTime(target, "dtend", occurrence.end);
            root.addSubcomponent(target);
          }
        }
        applyDraft(target, draft);
        bumpSequence(target);
        await api.put(object.url, root.toString(), object.etag);
        const updated = find(root, ref.rid);
        const entry = updated ? toEntry(ref.path, updated, options.account) : null;
        if (!entry) throw new CalendarError(`Changed, but no longer readable. Tell ${owner.name}.`);
        return entry;
      }),

    remove: (id) =>
      wrap(async () => {
        const loaded = await load(id);
        if (!loaded) throw new CalendarError("This event does not exist (any more).");
        const { ref, object, root } = loaded;
        const master = masterOf(root);
        if (!ref.rid || !master) {
          await api.remove(object.url, object.etag);
          return;
        }
        // An occurrence of a series: EXDATE on the original, an exception for it is dropped.
        for (const event of root.getAllSubcomponents("vevent")) {
          if (event.hasProperty("recurrence-id") && ridKey(new ICAL.Event(event).recurrenceId) === ref.rid) root.removeSubcomponent(event);
        }
        setTime(master, "exdate", asLike(ref.rid, new ICAL.Event(master).startDate), true);
        bumpSequence(master);
        await api.put(object.url, root.toString(), object.etag);
      }),
  };
}
