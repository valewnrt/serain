import { z } from "zod";
import {
  CALENDAR_OFFER_TTL_MS,
  CALENDAR_FREE_LEAD_MS,
  CALENDAR_FREE_MAX_DAYS,
  CALENDAR_FREE_MAX_EVENTS,
  CALENDAR_FREE_MAX_SLOTS,
  CALENDAR_LIST_MAX_DAYS,
  CALENDAR_LIST_MAX_EVENTS,
  CALENDAR_REPEAT_MAX_DAYS,
  MAIL_MAX_RECIPIENTS,
  MAX_ACTIVE_SCHEDULES,
} from "../../config/limits.js";
import { audit } from "../../db/audit.js";
import { checkinReminderText, checkinTime, offerAsk, offerClock, offerDay, offerTimeLine, ownerCalendarName } from "../../calendar/offer.js";
import { BOOKING_KINDS, bookingKind } from "../../mail/findings.js";
import type { ScheduleStore } from "../../scheduler/store.js";
import { dayLabel, findFreeSlots, slotLabel } from "../../calendar/free.js";
import { busyLabel, calendarBusy, calendarCovers } from "../../calendar/match.js";
import { ownerNamedEvent } from "../../calendar/named.js";
import { CalendarError, WEEKDAYS, type Calendar, type CalendarEntry, type EntryDraft, type WeeklyRepeat } from "../../calendar/types.js";
import { t, textLanguage } from "../../i18n/catalog.js";
import { currentLocale } from "../../i18n/language.js";
import { tools as messages } from "../../i18n/messages/tools.js";
import { addDays, ownerDate, daysBetween, formatWallTime, parseWallTime, toWallTime, wallAnchor, wallTimeToUtc, type WallTime } from "../../time.js";
import { bulleted } from "../../text/list.js";
import { defineTool, type ToolDefinition, type ToolLevel, type ToolResult, type TurnState } from "./types.js";
import { owner } from "../../config/owner.js";

/**
 * Reading and writing the owner's calendar (D32, D54, W15). Which one it is,
 * iCloud or Google, is in `Calendar.label`; the tools are the same.
 *
 * **The level is decided by the consequence, not by the action (W1).** An
 * event only for the owner is `write_reversible`: it can be deleted, and
 * nobody else has seen it. An event with guests sends invitations to third
 * parties, and nobody takes those back: `irreversible`, so a preview. The same
 * when changing. Whether an existing event has guests only the calendar knows;
 * the model states it with `has_guests`, and `run` checks it against the real
 * event. If it is wrong, nothing runs: a model that claims "no guests" does not
 * get past the preview that way. Deleting is always level 3 per D8.3.
 *
 * Events that were read are untrusted content, as with the Mac (D28): an
 * invitation from anyone lands in the calendar with any title.
 *
 * If the calendar cannot invite guests (iCloud, `invites: false`), the tools
 * refuse events with guests before a preview is created: the owner should not
 * approve anything that then does not work.
 *
 * **Series** (`repeat`, live finding 2026-10-05): two weeks of working hours
 * are one call per block, not one per day. Seven single events had brought the
 * turn to the step limit.
 *
 * Previews are fixed texts from the catalog (`src/i18n/messages/tools.ts`)
 * with dates in the owner's locale; results for the model use the model's
 * date form (`formatWallTime` without a locale).
 */

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe(`Day as YYYY-MM-DD, calendar day in ${owner.timezone}.`);
const wall = z
  .string()
  .trim()
  .describe(`Wall time in ${owner.timezone}, format YYYY-MM-DD HH:mm. No time zone, no offset.`);
const email = z.string().trim().toLowerCase().regex(/^[^\s@<>,;"']+@[^\s@<>,;"']+\.[a-z]{2,}$/, "not a mail address");
const eventId = z.string().trim().regex(/^[A-Za-z0-9_-]{5,1024}$/, "id from calendar_events or from your note on creating it");
// The id of an event Serain created or changed itself is in full in the history
// (`ToolResult.ref`). Reading it again first cost a step and about 7 s live (2026-10-13).
const EVENT_SOURCE = "The id comes from calendar_events or, for an event you created or changed, from your note about it in the history.";
const weekday = z.enum(WEEKDAYS as [WeeklyRepeat["weekdays"][number], ...WeeklyRepeat["weekdays"][number][]]);

const pad = (value: number) => String(value).padStart(2, "0");
const isoWall = (time: WallTime) => `${time.year}-${pad(time.month)}-${pad(time.day)}T${pad(time.hour)}:${pad(time.minute)}:00`;

function failure(error: unknown): ToolResult {
  if (error instanceof CalendarError) return { ok: false, text: `${error.message} Tell ${owner.name} instead of guessing.` };
  throw error;
}

function entryLine(entry: CalendarEntry): string {
  const when = entry.allDay
    ? `${entry.start}, all day`
    : `${formatWallTime(new Date(entry.start))} to ${formatWallTime(new Date(entry.end))}`;
  return [
    `- [${entry.id}] ${when}: ${entry.title || "(no title)"}`,
    entry.location ? `(${entry.location.replace(/\s+/g, " ")})` : "",
    entry.guests.length > 0 ? `guests: ${entry.guests.join(", ")}` : "",
    entry.calendar ? `{calendar ${entry.calendar}}` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/** Start and end as checked wall times, plus the instants for the labels. */
interface Times {
  start: string;
  end: string;
  from: Date;
  to: Date;
}

/** Start and end checked as wall time. Without an end: one hour. */
function resolveTimes(start: string, end: string | undefined): Times | { error: string } {
  const from = parseWallTime(start);
  if (!from) return { error: "start is not a wall time in the format YYYY-MM-DD HH:mm." };
  const startUtc = wallTimeToUtc(from);
  let endUtc = new Date(startUtc.getTime() + 3_600_000);
  if (end !== undefined) {
    const to = parseWallTime(end);
    if (!to) return { error: "end is not a wall time in the format YYYY-MM-DD HH:mm." };
    endUtc = wallTimeToUtc(to);
    if (endUtc <= startUtc) return { error: "end is not after start." };
  }
  // Back to wall time, so the default end is right across a clock change too.
  return { start: isoWall(from), end: isoWall(toWallTime(endUtc)), from: startUtc, to: endUtc };
}

/** The span for the model. */
const modelRange = (times: Times): string => `${formatWallTime(times.from)} to ${formatWallTime(times.to)}`;

/** The span for the owner, in the language of the preview. */
const ownerRange = (times: Times, lang: string): string =>
  t(messages.timeRange, { from: formatWallTime(times.from, currentLocale(lang)), to: formatWallTime(times.to, currentLocale(lang)) }, lang);

/** Weekday of a calendar day in the owner's time zone, as a key from `WEEKDAYS`. */
function weekdayOf(day: string): WeeklyRepeat["weekdays"][number] {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  return WEEKDAYS[(new Date(Date.UTC(year, month - 1, date)).getUTCDay() + 6) % 7]!;
}

/** A checked series: how many events, on which weekdays, until which day. */
interface Series {
  count: number;
  weekdays: WeeklyRepeat["weekdays"][number][];
  until: string;
}

/**
 * Checks a series against its start and counts the events. The start day must
 * itself be part of it: otherwise there would be an event on the start day the
 * owner did not mean (RFC 5545 always counts DTSTART).
 */
function resolveRepeat(startDay: string, repeat: WeeklyRepeat): Series | { error: string } {
  if (!parseWallTime(`${repeat.until} 00:00`)) return { error: "repeat.until is not a valid day." };
  const span = daysBetween(startDay, repeat.until);
  if (span < 0) return { error: "repeat.until is before the start." };
  if (span > CALENDAR_REPEAT_MAX_DAYS) return { error: `A series reaches at most ${CALENDAR_REPEAT_MAX_DAYS} days ahead.` };
  if (!repeat.weekdays.includes(weekdayOf(startDay))) {
    return { error: "The start is not on any of the weekdays in repeat.weekdays. Start the series on the first real event." };
  }
  let count = 0;
  for (let offset = 0; offset <= span; offset++) if (repeat.weekdays.includes(weekdayOf(addDays(startDay, offset)))) count++;
  return { count, weekdays: WEEKDAYS.filter((day) => repeat.weekdays.includes(day)), until: repeat.until };
}

/** Short weekday names in a locale, from a Monday (2024-01-01) on: the keys of `WEEKDAYS` in order. */
function weekdayNames(series: Series, locale: string): string {
  const format = new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" });
  return series.weekdays.map((key) => format.format(new Date(Date.UTC(2024, 0, 1 + WEEKDAYS.indexOf(key))))).join(", ");
}

/** A calendar day as a date in a locale ("10/12/2026", "12.10.2026"). */
function dayIn(day: string, locale: string, options: Intl.DateTimeFormatOptions): string {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  return new Intl.DateTimeFormat(locale, { ...options, timeZone: "UTC" }).format(new Date(Date.UTC(year, month - 1, date)));
}

/** The series for the model. */
const modelSeries = (series: Series): string => `${series.count} events, ${weekdayNames(series, "en-GB")} until ${series.until}`;

/** The series for the owner, in the language of the preview. */
function ownerSeries(series: Series, lang: string): string {
  const locale = currentLocale(lang);
  return t(
    messages.seriesLabel,
    { count: series.count, days: weekdayNames(series, locale), until: dayIn(series.until, locale, { day: "2-digit", month: "2-digit", year: "numeric" }) },
    lang,
  );
}

const guestLevel = (hasGuests: boolean): ToolLevel => (hasGuests ? "irreversible" : "write_reversible");

/**
 * Times for `calendar_offer`: wall time with a clock time as for
 * `calendar_create`, or whole days. For all day, `end` is the last day; the
 * calendar wants the day after (DTEND is exclusive). The label is for the
 * model; the preview has its own line (`offerTimeLine`).
 */
function offerTimes(
  start: string,
  end: string | undefined,
): { start: string; end: string; label: string; span: { from: Date; to: Date; allDay: boolean } } | { error: string } {
  const isDay = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value);
  if (!isDay(start)) {
    const times = resolveTimes(start, end);
    if ("error" in times) return times;
    return { start: times.start, end: times.end, label: modelRange(times), span: { from: times.from, to: times.to, allDay: false } };
  }
  const last = end ?? start;
  if (!isDay(last) || !parseWallTime(`${start} 00:00`) || !parseWallTime(`${last} 00:00`)) return { error: "end is not a day in the format YYYY-MM-DD." };
  if (daysBetween(start, last) < 0) return { error: "end is before start." };
  const after = addDays(last, 1);
  const from = wallTimeToUtc(parseWallTime(`${start} 00:00`)!);
  const to = wallTimeToUtc(parseWallTime(`${after} 00:00`)!);
  return { start, end: after, label: last === start ? `${start}, all day` : `${start} to ${last}, all day`, span: { from, to, allDay: true } };
}

const clock = z.string().trim().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "clock time as HH:mm");
const minutesOf = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));

/**
 * What `calendar_offer` needs besides the calendar: the reminder path for the
 * check-in on flights (addendum D62 of 2026-10-10). Without it the tool offers
 * no check-in reminder.
 */
export interface CalendarToolDeps {
  reminders?: Pick<ScheduleStore, "insert" | "countActive">;
}

/**
 * `targets` are the calendars Serain chooses between when creating (iCloud:
 * work, private, …), read at start. The names are in the description so the
 * model knows them; whether the named one really exists the calendar checks
 * when creating.
 */
export function calendarTools(
  calendar: Calendar,
  targets?: { names: string[]; fallback: string },
  now: () => Date = () => new Date(),
  deps: CalendarToolDeps = {},
): ToolDefinition[] {
  const choice = targets && targets.names.length > 1 ? targets : null;
  /** The real event decides, not the model's claim. Null means: matches. */
  const guestMismatch = (entry: CalendarEntry, claimed: boolean): ToolResult | null => {
    // Without invitations (iCloud) Serain does not touch an event others depend on: every change would go to them.
    if (!calendar.invites && (entry.guests.length > 0 || !entry.organizerSelf)) {
      return { ok: false, text: `Not done: others depend on this event. ${owner.name} changes it themselves in the calendar app; tell them.` };
    }
    return entry.guests.length > 0 && !claimed
      ? { ok: false, text: `Not done: the event has guests. Call it with has_guests: true, then ${owner.name} gets a preview.` }
      : null;
  };
  /**
   * What overlaps with an event before it is created (addendum D54 of
   * 2026-10-13): only times, never titles, so the result stays free of
   * untrusted text (like `calendar_free`). For a series the first event counts.
   * If the calendar does not read, it is created as before.
   */
  const overlapsOf = async (times: Times): Promise<string[]> => {
    const busy = await calendarBusy(calendar, { from: times.from, to: times.to }).catch(() => []);
    return busy.map(busyLabel);
  };
  /**
   * The offer from the mail, from the checked arguments: times, kind, and
   * whether a check-in reminder belongs to it (only for a flight, only if its
   * time is still to come, only with a reminder path).
   */
  const offerOf = (args: Record<string, unknown>) => {
    const times = offerTimes(String(args["start"]), typeof args["end"] === "string" ? args["end"] : undefined);
    const span = "error" in times ? null : times.span;
    const kind = bookingKind(args["kind"]);
    const planned = deps.reminders ? checkinTime(kind, span) : null;
    return { span, kind, planned, checkin: planned && planned.getTime() > now().getTime() ? planned : null };
  };
  /**
   * The check-in reminder for a confirmed flight, via the scheduler's reminder
   * path (D15): fixed text from the code, without title and without a link
   * from the mail. If its time has passed meanwhile, it is dropped. Returns the
   * line for the result, empty without a flight.
   */
  const checkinReminder = async (args: Record<string, unknown>, turn: TurnState): Promise<string> => {
    const offer = offerOf(args);
    if (!offer.planned || !offer.span || !deps.reminders) return "";
    if (!offer.checkin) return `The check-in reminder (if it was in the preview) is not created: its time has already passed. Tell ${owner.name} in half a sentence.`;
    try {
      if ((await deps.reminders.countActive()) >= MAX_ACTIVE_SCHEDULES) {
        return `The check-in reminder is not created: too many reminders are already pending. Tell ${owner.name} in half a sentence.`;
      }
      const row = await deps.reminders.insert({
        mode: "reminder",
        text: checkinReminderText(offer.span.from, offer.checkin, now()),
        repeat: null,
        nextRunAt: offer.checkin.toISOString(),
        anchor: wallAnchor(offer.checkin),
        sourceMessageId: turn.triggerMessageId,
        taintSources: [...turn.taintSources],
      });
      await audit("schedule_created", { schedule_id: row.id, mode: "reminder", repeat: null, next_run_at: row.nextRunAt, via: "calendar_offer" }, turn.triggerMessageId);
      return `Check-in reminder set for ${formatWallTime(offer.checkin)}.`;
    } catch (error) {
      return `The check-in reminder is not created (${(error as Error).message}). Tell ${owner.name} in half a sentence.`;
    }
  };
  /** Before every preview: guests only where the calendar can invite. */
  const noInvites = (withGuests: boolean): ToolResult | null =>
    withGuests && !calendar.invites
      ? { ok: false, text: `Not done: in ${calendar.label} Serain does not invite guests. Create the event without guests and tell ${owner.name} to send the invitation themselves.` }
      : null;

  return [
    defineTool({
      name: "calendar_events",
      description:
        `Reads events from ${calendar.label}, for a period of at most 31 days. Returns for every event ` +
        "the id that calendar_update and calendar_delete need. Every event of a series has its own id.",
      level: "read",
      repeatable: true,
      returnsUntrusted: true,
      privateResult: true,
      schema: { from: day, to: day },
      async run(args) {
        const from = parseWallTime(`${args.from} 00:00`);
        const to = parseWallTime(`${args.to} 00:00`);
        if (!from || !to) return { ok: false, text: "from or to is not a valid day." };
        const start = wallTimeToUtc(from);
        const end = new Date(wallTimeToUtc(to).getTime() + 86_400_000);
        if (end <= start) return { ok: false, text: "to is before from." };
        if (end.getTime() - start.getTime() > (CALENDAR_LIST_MAX_DAYS + 1) * 86_400_000) {
          return { ok: false, text: `At most ${CALENDAR_LIST_MAX_DAYS} days at once.` };
        }
        try {
          const result = await calendar.list({ from: start.toISOString(), to: end.toISOString(), limit: CALENDAR_LIST_MAX_EVENTS });
          const lines = result.entries.map(entryLine);
          return {
            ok: true,
            source: calendar.label,
            text: lines.length > 0 ? [...lines, result.truncated ? "(shortened, there are more)" : ""].filter(Boolean).join("\n") : "No events in this period.",
          };
        } catch (error) {
          return failure(error);
        }
      },
    }),

    defineTool({
      name: "calendar_free",
      description:
        `Finds free times in ${calendar.label} for an event with others: at most ${CALENDAR_FREE_MAX_SLOTS} suggestions, ` +
        `spread over different days, in a period of at most ${CALENDAR_FREE_MAX_DAYS} days. Accounts for a buffer ` +
        "around existing events and travel time around events with a location (work, meetings). Without details: weekdays 09:00 to 18:00, " +
        `15 minutes buffer, 45 minutes travel. If you know ${owner.name}'s travel time from memory, set travel_minutes. If nothing comes up, ` +
        `ask again with a later latest or weekends before you ask ${owner.name}.`,
      level: "read",
      repeatable: true,
      // Only times, no titles: untrusted text does not get through here. It is private nonetheless.
      privateResult: true,
      schema: {
        from: day,
        to: day,
        minutes: z.number().int().min(15).max(480).describe("Duration of the event in minutes."),
        earliest: clock.default("09:00").describe("Earliest start per day, HH:mm."),
        latest: clock.default("18:00").describe("Latest end per day, HH:mm."),
        weekends: z.boolean().default(false),
        buffer_minutes: z.number().int().min(0).max(120).default(15),
        travel_minutes: z.number().int().min(0).max(180).default(45).describe("Travel to and from events with a location, before and after."),
      },
      async run(args) {
        if (!parseWallTime(`${args.from} 00:00`) || !parseWallTime(`${args.to} 00:00`)) return { ok: false, text: "from or to is not a valid day." };
        const span = daysBetween(args.from, args.to);
        if (span < 0) return { ok: false, text: "to is before from." };
        if (span >= CALENDAR_FREE_MAX_DAYS) return { ok: false, text: `At most ${CALENDAR_FREE_MAX_DAYS} days at once.` };
        const earliest = minutesOf(args.earliest);
        const latest = minutesOf(args.latest);
        if (latest - earliest < args.minutes) return { ok: false, text: "The event does not fit between earliest and latest." };
        const start = wallTimeToUtc({ ...parseWallTime(`${args.from} 00:00`)!, hour: 0, minute: 0 });
        const end = new Date(wallTimeToUtc(parseWallTime(`${args.to} 00:00`)!).getTime() + 86_400_000);
        try {
          const listed = await calendar.list({ from: start.toISOString(), to: end.toISOString(), limit: CALENDAR_FREE_MAX_EVENTS });
          // A truncated calendar would have gaps where events are: then rather no suggestions.
          if (listed.truncated) return { ok: false, text: "Too many events in this period to compute safely. Take a shorter one." };
          const result = findFreeSlots(listed.entries, {
            from: args.from,
            to: args.to,
            minutes: args.minutes,
            earliest,
            latest,
            weekends: args.weekends,
            bufferMinutes: args.buffer_minutes,
            travelMinutes: args.travel_minutes,
            notBefore: new Date(now().getTime() + CALENDAR_FREE_LEAD_MS),
            maxSlots: CALENDAR_FREE_MAX_SLOTS,
          });
          const allDay =
            result.allDayDays.length > 0
              ? `All-day entries (not counted as busy) on ${result.allDayDays.map(dayLabel).join(", ")}. ` +
                "If there is a vacation or a trip, read it with calendar_events before you suggest one of those days."
              : "";
          if (result.slots.length === 0) {
            return { ok: true, text: [`No free time in this frame. Ask ${owner.name} for a different period or window.`, allDay].filter(Boolean).join("\n") };
          }
          return {
            ok: true,
            text: [`Free in ${calendar.label}:`, ...result.slots.map((slot) => `- ${slotLabel(slot)}`), allDay].filter(Boolean).join("\n"),
          };
        } catch (error) {
          return failure(error);
        }
      },
    }),

    defineTool({
      name: "calendar_create",
      description:
        `Creates an event in ${calendar.label}. Without end it lasts one hour. If the same event repeats ` +
        "on several days (working hours, lectures, training), create it once with repeat instead of every day " +
        "separately: start is then the first event. " +
        (choice
          ? `With calendar you choose the calendar that fits best (${choice.names.join(", ")}); ` +
            `work into the one for work, vacation into the one for vacation. If none fits better, ${choice.fallback}. `
          : "") +
        (calendar.invites
          ? `With guests, invitations go out to these addresses; then ${owner.name} gets a preview first. `
          : "Serain does not invite guests in this calendar. ") +
        "If something is already at this time, it adds nothing and tells you; if it is the same event (e.g. one " +
        "added earlier with open details), change it with calendar_update instead of creating it twice. " +
        `Tell ${owner.name} the time you entered.`,
      level: "write_reversible",
      schema: {
        title: z.string().trim().min(1).max(200),
        start: wall,
        end: wall.optional(),
        location: z.string().trim().max(200).optional(),
        description: z.string().trim().max(1_000).optional(),
        guests: z.array(email).max(MAIL_MAX_RECIPIENTS).default([]),
        repeat: z
          .object({
            weekdays: z.array(weekday).min(1).max(7).describe("Weekdays of the series: mo, di, mi, do, fr, sa, so (Monday to Sunday)."),
            until: day.describe("Last day of the series, inclusive, YYYY-MM-DD."),
          })
          .strict()
          .optional()
          .describe("Series: the same event at the same time on these weekdays, from the day of start until until."),
        despite_overlap: z
          .boolean()
          .default(false)
          .describe("true only if calendar_create reported that something is already at this time and calendar_events showed it is a different event."),
        ...(choice
          ? { calendar: z.string().trim().min(1).max(100).optional().describe(`Calendar the event goes into: ${choice.names.join(", ")}.`) }
          : {}),
      },
      // Without invitations `run` refuses guests right away: then there is nothing to approve either.
      consequence: (args) => guestLevel(args.guests.length > 0 && calendar.invites),
      confirm: {
        preview(args) {
          const lang = textLanguage(messages.createAsk);
          const times = resolveTimes(args.start, args.end);
          const series = args.repeat && !("error" in times) ? resolveRepeat(times.start.slice(0, 10), args.repeat) : null;
          return [
            t(messages.createAsk, { title: args.title }, lang),
            "error" in times ? t(messages.invalidTime, { value: args.start }, lang) : ownerRange(times, lang),
            series ? ("error" in series ? t(messages.seriesInvalid, undefined, lang) : t(messages.series, { series: ownerSeries(series, lang) }, lang)) : "",
            args.location ? t(messages.location, { location: args.location }, lang) : "",
            ...bulleted(t(messages.guestsLead, undefined, lang), args.guests),
          ]
            .filter(Boolean)
            .join("\n");
        },
        undo: () => t(messages.createUndo),
      },
      async run(args) {
        const refused = noInvites(args.guests.length > 0);
        if (refused) return refused;
        const times = resolveTimes(args.start, args.end);
        if ("error" in times) return { ok: false, text: times.error };
        const series = args.repeat ? resolveRepeat(times.start.slice(0, 10), args.repeat) : null;
        if (series && "error" in series) return { ok: false, text: series.error };
        try {
          // Before, not after (live finding 2026-10-13): a placeholder from the morning and the invitation
          // in the afternoon were in twice, because Serain only saw the overlap after creating it.
          if (!args.despite_overlap) {
            const overlaps = await overlapsOf(times);
            if (overlaps.length > 0) {
              return {
                ok: false,
                text:
                  `Not added: something is already at this time (${overlaps.join(", ")}). Read it with calendar_events. ` +
                  "If it is the same event, bring it up to date with calendar_update instead of creating it twice. " +
                  `If it is a different one, call calendar_create again with despite_overlap: true and tell ${owner.name} about the overlap in half a sentence.`,
              };
            }
          }
          const draft: EntryDraft = {
            title: args.title,
            start: times.start,
            end: times.end,
            ...(args.location ? { location: args.location } : {}),
            ...(args.description ? { description: args.description } : {}),
            ...(args.guests.length > 0 ? { guests: args.guests } : {}),
            ...(args.repeat ? { repeat: args.repeat } : {}),
            ...(typeof args.calendar === "string" ? { calendar: args.calendar } : {}),
          };
          const entry = await calendar.create(draft);
          return {
            ok: true,
            // The instruction is in the result, not only in the prompt: live on 2026-09-20 Serain created
            // "dentist" and ended the turn without a word. To the owner that looked like being ignored.
            text:
              `Event "${args.title}" is in ${calendar.label}${entry.calendar ? ` (calendar ${entry.calendar})` : ""}: ${modelRange(times)}${series ? `, series: ${modelSeries(series)}` : ""}` +
              `${args.guests.length > 0 ? `, invitation to ${args.guests.join(", ")}` : ""}.\n` +
              `${owner.name} has not seen anything of it yet: tell them now in a short sentence, with the time you entered.`,
            ref: entry.id,
          };
        } catch (error) {
          return failure(error);
        }
      },
    }),

    // Finds from the mail (addendum D33 of 2026-10-10): a booking from a mail that is not in the
    // calendar yet. The event itself would be `write_reversible`, but here untrusted content writes into
    // the owner's calendar without them asking. Hence level 3: always a preview, never a standing
    // approval, only in the mail turn, never with guests.
    defineTool({
      name: "calendar_offer",
      description:
        `Offers ${owner.name} a booking from their mail as an event in ${calendar.label}. They get a preview and ` +
        "approve with 👍; only then is the event in. Take exactly the details from \"For calendar_offer\". " +
        "start and end as YYYY-MM-DD HH:mm, or as YYYY-MM-DD for whole days (end is then the last day). " +
        (choice ? `With calendar you choose the fitting calendar (${choice.names.join(", ")}); if none fits better, ${choice.fallback}.` : ""),
      level: "irreversible",
      origins: ["untrusted"],
      textToOwner: true,
      schema: {
        title: z.string().trim().min(1).max(120),
        start: z.string().trim().max(16),
        end: z.string().trim().max(16).optional(),
        location: z.string().trim().max(200).optional(),
        kind: z.enum(BOOKING_KINDS).optional().describe("Kind of booking, from \"For calendar_offer\"."),
        ...(choice
          ? { calendar: z.string().trim().min(1).max(100).optional().describe(`Calendar the event goes into: ${choice.names.join(", ")}.`) }
          : {}),
      },
      // Form from the style round (addendum D62 of 2026-10-10): Serain's sentence instead of "shall I?", built here in the code.
      confirm: {
        preview(args) {
          const lang = textLanguage(messages.offerTitle);
          const offer = offerOf(args);
          return [
            t(messages.offerTitle, { title: String(args.title) }, lang),
            offer.span ? offerTimeLine(offer.span, now()) : t(messages.invalidTime, { value: String(args.start) }, lang),
            typeof args.location === "string" ? t(messages.location, { location: args.location }, lang) : "",
            t(messages.offerCalendar, { calendar: typeof args.calendar === "string" ? args.calendar : (choice?.fallback ?? ownerCalendarName(calendar.provider, lang)) }, lang),
            offer.checkin ? t(messages.offerCheckin, { day: offerDay(ownerDate(offer.checkin), now()), time: offerClock(offer.checkin) }, lang) : "",
          ]
            .filter(Boolean)
            .join("\n");
        },
        undo: (args) => t(offerOf(args).checkin ? messages.offerUndoBoth : messages.offerUndo),
        ask: (args) => {
          const offer = offerOf(args);
          return offerAsk(offer.kind, offer.span, now());
        },
        // An event that has already started (all day: that is over) does not come again as an offer.
        stale: (args) => {
          const { span } = offerOf(args);
          return !span || (span.allDay ? span.to : span.from).getTime() <= now().getTime();
        },
        ttlMs: CALENDAR_OFFER_TTL_MS,
      },
      async run(args, turn) {
        const times = offerTimes(args.start, args.end);
        if ("error" in times) return { ok: false, text: times.error };
        let text: string;
        let ref: string | undefined;
        try {
          // The owner may have added it themselves in the meantime. Then not twice.
          if (await calendarCovers(calendar, times.span)) {
            text = `There is already an event at this time in ${calendar.label}, so nothing added. Tell ${owner.name} in half a sentence.`;
          } else {
            const entry = await calendar.create({
              title: args.title,
              start: times.start,
              end: times.end,
              allDay: times.span.allDay,
              ...(args.location ? { location: args.location } : {}),
              ...(typeof args.calendar === "string" ? { calendar: args.calendar } : {}),
            });
            text =
              `Event "${args.title}" is in ${calendar.label}${entry.calendar ? ` (calendar ${entry.calendar})` : ""}: ${times.label}.\n` +
              `Tell ${owner.name} in a short sentence.`;
            ref = entry.id;
          }
        } catch (error) {
          return failure(error);
        }
        // A 👍 was for both: the reminder comes even if the event was already there.
        const checkin = await checkinReminder(args, turn);
        return { ok: true, text: checkin ? `${text}\n${checkin}` : text, ...(ref ? { ref } : {}) };
      },
    }),

    defineTool({
      name: "calendar_update",
      description:
        `Changes title, time, location or note of an event. ${EVENT_SOURCE} For a series only this one event. ` +
        "A note that is no longer true (\"time still unclear\") you replace with description, empty deletes it. " +
        `has_guests says whether the event has guests: then they get the change, and ${owner.name} a preview first. ` +
        "current_title is the current title, as a check.",
      level: "write_reversible",
      schema: {
        event_id: eventId,
        current_title: z.string().trim().max(200),
        has_guests: z.boolean(),
        title: z.string().trim().min(1).max(200).optional(),
        start: wall.optional(),
        end: wall.optional(),
        location: z.string().trim().max(200).optional(),
        description: z.string().trim().max(1_000).optional(),
      },
      consequence: (args) => guestLevel(args.has_guests && calendar.invites),
      confirm: {
        preview(args) {
          const lang = textLanguage(messages.updateAsk);
          const times = args.start ? resolveTimes(args.start, args.end) : null;
          return [
            t(messages.updateAsk, { title: args.current_title }, lang),
            args.title ? t(messages.newTitle, { title: args.title }, lang) : "",
            times
              ? "error" in times
                ? t(messages.newTimeInvalid, { value: args.start ?? "" }, lang)
                : t(messages.newTime, { time: ownerRange(times, lang) }, lang)
              : "",
            args.location !== undefined
              ? args.location
                ? t(messages.newLocation, { location: args.location }, lang)
                : t(messages.newLocationNone, undefined, lang)
              : "",
            args.description !== undefined
              ? args.description
                ? t(messages.newNote, { note: args.description }, lang)
                : t(messages.newNoteNone, undefined, lang)
              : "",
          ]
            .filter(Boolean)
            .join("\n");
        },
        undo: () => t(messages.updateUndo),
      },
      async run(args) {
        const refused = noInvites(args.has_guests);
        if (refused) return refused;
        if (args.title === undefined && args.start === undefined && args.location === undefined && args.description === undefined) {
          return { ok: false, text: "Nothing to change: give title, start, location or description." };
        }
        if (args.end !== undefined && args.start === undefined) return { ok: false, text: "end only works together with start." };
        const times = args.start ? resolveTimes(args.start, args.end) : null;
        if (times && "error" in times) return { ok: false, text: times.error };
        try {
          const entry = await calendar.get(args.event_id);
          if (!entry) return { ok: false, text: "This event does not exist (anymore)." };
          // The preview named this title. If it does not match the event, the owner approved something else.
          if (entry.title.trim() !== args.current_title) {
            return { ok: false, text: "Not done: current_title does not match the event. Read it again with calendar_events." };
          }
          const mismatch = guestMismatch(entry, args.has_guests);
          if (mismatch) return mismatch;
          if (entry.allDay && times) return { ok: false, text: `I can't move all-day events. Tell ${owner.name}.` };
          const updated = await calendar.update(
            args.event_id,
            {
              ...(args.title !== undefined ? { title: args.title } : {}),
              ...(times ? { start: times.start, end: times.end } : {}),
              ...(args.location !== undefined ? { location: args.location } : {}),
              ...(args.description !== undefined ? { description: args.description } : {}),
            },
            entry.guests.length > 0,
          );
          return {
            ok: true,
            text: `Event "${updated.title}" changed${times ? `: ${modelRange(times)}` : ""}.\n${owner.name} has not seen anything of it yet: tell them now in a short sentence.`,
            ref: updated.id,
          };
        } catch (error) {
          return failure(error);
        }
      },
    }),

    defineTool({
      name: "calendar_delete",
      description:
        `Deletes an event, for a series only this one. ${EVENT_SOURCE} If ${owner.name} just named it themselves ` +
        `and said delete, and it has no guests, it runs right away, otherwise ${owner.name} gets a preview. If the ` +
        "event has guests, they get a cancellation. current_title is the current title, as a check.",
      level: "irreversible",
      schema: { event_id: eventId, current_title: z.string().trim().max(200), has_guests: z.boolean() },
      confirm: {
        preview: (args) => t(args.has_guests ? messages.deleteAskGuests : messages.deleteAsk, { title: args.current_title }),
        undo: (args) => (args.has_guests ? t(messages.deleteUndoGuests, { undo: calendar.deleteUndo }) : calendar.deleteUndo),
        // "delete the duplicate start award" needs no question (addendum D8 of 2026-10-13), see `ownerNamedEvent`.
        namedByOwner: (args, ownerWords) => ownerNamedEvent(args, ownerWords),
      },
      async run(args, turn) {
        try {
          const entry = await calendar.get(args.event_id);
          if (!entry) return { ok: false, text: "This event does not exist (anymore)." };
          if (entry.title.trim() !== args.current_title) {
            return { ok: false, text: "Not done: current_title does not match the event. Read it again with calendar_events." };
          }
          const mismatch = guestMismatch(entry, args.has_guests);
          if (mismatch) return mismatch;
          await calendar.remove(args.event_id, entry.guests.length > 0);
          // Ran without a preview because the owner asked for exactly this: then the tapback is the whole answer.
          const asked = turn.origin === "owner_message" && ownerNamedEvent(args, turn.ownerWords) !== null;
          return {
            ok: true,
            text: `Event "${entry.title}" is deleted.${asked ? `\n${owner.name} asked for exactly this: a 👍 (signal ok) on their message is the whole answer, no text.` : ""}`,
          };
        } catch (error) {
          return failure(error);
        }
      },
    }),
  ];
}
