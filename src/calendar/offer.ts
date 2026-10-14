import { t, textLanguage, type Message } from "../i18n/catalog.js";
import { currentLanguage, currentLocale } from "../i18n/language.js";
import { calendar as text } from "../i18n/messages/calendar.js";
import { addDays, ownerDate, daysBetween, OWNER_TIMEZONE, toWallTime } from "../time.js";
import type { BookingKind } from "../mail/findings.js";
import type { Span } from "./match.js";

/**
 * The form of the offer from the mail (`calendar_offer`, addendum D62 of
 * 2026-10-10, style round, decision 2). Instead of "Should I?" Serain's own
 * sentence stands above the preview ("your train booking for friday isn't in
 * the calendar yet, add it? 👍"), the preview below it.
 *
 * **The sentence comes from the code, never from the model** (D8.3, D14): a
 * model that read the mail could otherwise put a harmless headline above an
 * action. It is built from two things the tool knows from the checked
 * arguments: the kind of booking (a fixed vocabulary, `BOOKING_KINDS`) and the
 * day it starts. No foreign text stands in it; the title from the mail stands
 * as before only in the preview itself, in quotes. Frame and dates come in the
 * owner's language (catalog, `Intl`).
 */

/**
 * The owner's calendar as the owner reads it in a preview ("your iCloud
 * calendar"), by provider. `Calendar.label` is the model's name for it, in
 * English; a calendar the provider names ("Work") stays verbatim and does not
 * come through here.
 */
export function ownerCalendarName(provider: "icloud" | "google" | undefined, lang: string = currentLanguage()): string {
  return t(provider === "icloud" ? text.nameIcloud : provider === "google" ? text.nameGoogle : text.nameAny, undefined, lang);
}

/** One whole sentence per kind, with and without the day, so every language can inflect the noun itself. */
const ASK: Record<BookingKind | "booking", { plain: Message<never>; when: Message<"when"> }> = {
  train: { plain: text.offerTrain, when: text.offerTrainFor },
  flight: { plain: text.offerFlight, when: text.offerFlightFor },
  hotel: { plain: text.offerHotel, when: text.offerHotelFor },
  car: { plain: text.offerCar, when: text.offerCarFor },
  table: { plain: text.offerTable, when: text.offerTableFor },
  ticket: { plain: text.offerTicket, when: text.offerTicketFor },
  appointment: { plain: text.offerAppointment, when: text.offerAppointmentFor },
  delivery: { plain: text.offerDelivery, when: text.offerDeliveryFor },
  booking: { plain: text.offerBooking, when: text.offerBookingFor },
};

/** A calendar day `YYYY-MM-DD` as noon UTC; `format` reads it in UTC, so it always shows that very day. */
function noonOf(day: string): Date {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, date, 12));
}

const format = (locale: string, options: Intl.DateTimeFormatOptions, at: Date) =>
  new Intl.DateTimeFormat(locale, { ...options, timeZone: "UTC" }).format(at);

/**
 * "Fr. 16.10.", with year only when it is not the one of `now` ("Fr.
 * 08.01.2027"); in English "Fri, Oct 16". German keeps its numeric day and
 * month (style round), every other language gets the month's name, which no
 * reader can misread as month/day.
 */
export function offerDay(day: string, now: Date, lang: string = currentLanguage()): string {
  const at = noonOf(day);
  const locale = currentLocale(lang);
  const year = Number(day.slice(0, 4)) === toWallTime(now).year ? {} : { year: "numeric" as const };
  if (lang === "de") {
    // The weekday as `Intl` writes it next to a date ("Fr."), without the comma after it.
    const parts = new Intl.DateTimeFormat(locale, { weekday: "short", day: "2-digit", month: "2-digit", timeZone: "UTC" }).formatToParts(at);
    const weekday = parts.find((part) => part.type === "weekday")?.value ?? "";
    return `${weekday} ${format(locale, { day: "2-digit", month: "2-digit", ...year }, at)}`;
  }
  return format(locale, { weekday: "short", day: "numeric", month: "short", ...year }, at);
}

/** "07:12" at the owner's; "7:12 AM" where the locale writes it like that. */
export function offerClock(instant: Date, lang: string = currentLanguage()): string {
  const numeric = lang === "de";
  return new Intl.DateTimeFormat(currentLocale(lang), { hour: numeric ? "2-digit" : "numeric", minute: "2-digit", timeZone: OWNER_TIMEZONE }).format(instant);
}

/**
 * The time line of the preview: "Fr. 16.10., 07:12 bis 11:20", the day at the
 * end only when it is another one; all day "Fr. 16.10., ganztägig" or
 * "Fr. 16.10. bis So. 18.10., ganztägig" (`span.to` is the day after).
 */
export function offerTimeLine(span: Span, now: Date, lang: string = currentLanguage()): string {
  const first = ownerDate(span.from);
  if (span.allDay) {
    const last = addDays(ownerDate(span.to), -1);
    if (last === first) {
      const used = textLanguage(text.allDayOne, lang);
      return t(text.allDayOne, { day: offerDay(first, now, used) }, used);
    }
    const used = textLanguage(text.allDayMany, lang);
    return t(text.allDayMany, { day: offerDay(first, now, used), endDay: offerDay(last, now, used) }, used);
  }
  const end = ownerDate(span.to);
  if (end === first) {
    const used = textLanguage(text.spanSameDay, lang);
    return t(text.spanSameDay, { day: offerDay(first, now, used), from: offerClock(span.from, used), to: offerClock(span.to, used) }, used);
  }
  const used = textLanguage(text.spanTwoDays, lang);
  return t(
    text.spanTwoDays,
    { day: offerDay(first, now, used), from: offerClock(span.from, used), endDay: offerDay(end, now, used), to: offerClock(span.to, used) },
    used,
  );
}

/** "heute", "morgen", "freitag" (within a week), else "den 23.10.": in the owner's language, lowercase like the sentence. */
export function offerWhen(day: string, now: Date, lang: string = currentLanguage()): string {
  const ahead = daysBetween(ownerDate(now), day);
  if (ahead === 0) return t(text.whenToday, undefined, lang);
  if (ahead === 1) return t(text.whenTomorrow, undefined, lang);
  const locale = currentLocale(lang);
  const at = noonOf(day);
  if (ahead > 1 && ahead < 7) return format(locale, { weekday: "long" }, at).toLocaleLowerCase(locale);
  const used = textLanguage(text.whenDate, lang);
  const date =
    used === "de"
      ? format(currentLocale(used), { day: "2-digit", month: "2-digit" }, at)
      : format(currentLocale(used), { day: "numeric", month: "short" }, at).toLocaleLowerCase(currentLocale(used));
  return t(text.whenDate, { date }, used);
}

/**
 * The sentence above the preview. Without a known kind "your booking",
 * without a valid day without "for …": rather general than guessed.
 */
export function offerAsk(kind: BookingKind | null, span: Span | null, now: Date, lang: string = currentLanguage()): string {
  const ask = ASK[kind ?? "booking"];
  if (!span) return t(ask.plain, undefined, lang);
  const used = textLanguage(ask.when, lang);
  return t(ask.when, { when: offerWhen(ownerDate(span.from), now, used) }, used);
}

/** Before departure, this far ahead Serain reminds of the check-in (decision of 2026-10-10). */
export const CHECKIN_LEAD_MS = 24 * 3_600_000;

/**
 * When the check-in reminder would come: 24 h before departure, only for a
 * flight with a time. Whether the time is still to come, the caller checks
 * against its clock.
 */
export function checkinTime(kind: BookingKind | null, span: Span | null): Date | null {
  if (kind !== "flight" || !span || span.allDay) return null;
  return new Date(span.from.getTime() - CHECKIN_LEAD_MS);
}

/**
 * The text of the reminder, entirely from the code: no title, no place, no
 * link from the mail (D48: links only to pages a tool opened). The reminder
 * goes out verbatim at its time and so carries no foreign text. It is stored
 * in the language of the moment it was offered.
 */
export function checkinReminderText(departure: Date, at: Date, now: Date, lang: string = currentLanguage()): string {
  const day = ownerDate(departure);
  if (daysBetween(ownerDate(at), day) === 1) {
    const used = textLanguage(text.checkinTomorrow, lang);
    return t(text.checkinTomorrow, { time: offerClock(departure, used) }, used);
  }
  const used = textLanguage(text.checkinOn, lang);
  return t(text.checkinOn, { day: offerDay(day, now, used), time: offerClock(departure, used) }, used);
}
