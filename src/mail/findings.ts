import { FINDING_EVENT_MAX_HOURS, FINDING_EVENT_MAX_DAYS_AHEAD, MAIL_CLASSIFY_MIN_CONFIDENCE } from "../config/limits.js";
import type { JudgeChoiceAnswer, JudgeChoiceQuestion } from "../agent/judge/types.js";
import { parseWallTime, wallTimeToUtc } from "../time.js";
import { owner } from "../config/owner.js";
import { knownLanguage } from "./codes.js";

/**
 * Findings from the mail (addendum D33 of 2026-10-10). The mail trigger only
 * reports what may interrupt the owner now, and confirmations, tickets and
 * pickup notices rightly may not. Still, they hold something that belongs to
 * the owner and otherwise silently disappears in the mailbox: an event that
 * never lands in the calendar, a pickup deadline they miss. Like the hotel
 * that finds the hairpin while cleaning: not reporting it, but putting it back
 * where it belongs.
 *
 * - `booking`: the mail confirms a fixed appointment to the owner. If it is not
 *   in the calendar yet, Serain offers it with a preview (`calendar_offer`).
 * - `lapse`: after a date something lapses or costs something. Reported not
 *   now, but through the heartbeat's deadlines the day before and on the day
 *   itself (D46).
 *
 * Code first, then `judge` (D19, D33): bulk and machine mail only reaches
 * `judge` when subject or start sound like it (`looksLikeFinding`).
 */

export type Finding = "booking" | "lapse" | "none";

/**
 * Words in English and German without which no bulk or machine mail costs a
 * question to `judge`. Deliberately wide: only what is certainly no booking
 * and no deadline drops out here; whether it is one, `judge` decides.
 */
const HINT =
  /(buchung|gebucht|reservier|booking|reservation|ticket|fahrkarte|bahncard|flug|flight|boarding|check-?in|zugbindung|reiseplan|itinerary|hotel|unterkunft|termin|appointment|abhol|packstation|paketshop|filiale|postfiliale|rücksend|ruecksend|rückgabe|rueckgabe|retoure|widerruf|probe(abo|monat|zeitraum|phase)|test(phase|zeitraum)|trial|gutschein|guthaben|verfällt|verfaellt|läuft ab|laeuft ab|expires?|kündig|kuendig|einlass|veranstaltung|konzert|eintritt|anmeldung|teilnahme|einladung|registrierung|pick-?up|voucher|deadline|concert)/i;

/** Attachments that are a booking in any language: a calendar entry or a wallet pass. */
const BOOKING_FILE = /\.(ics|pkpass)$/i;

/**
 * Also the names of the attachments: a registration confirmation often
 * carries the ticket only as a PDF ("Ticket_Firstname_Lastname.pdf"), and
 * subject and text say "Bestätigung Ihrer Anmeldung" (live finding
 * 2026-10-13).
 *
 * The words exist for English and German only. A mail in any other language
 * always goes to `judge`, which reads every language: the filter only saves
 * questions, it must not hide a booking because of its language.
 */
export function looksLikeFinding(subject: string, text: string, attachments: readonly string[] = []): boolean {
  const start = text.slice(0, 600);
  if (HINT.test(subject) || HINT.test(start) || attachments.some((name) => HINT.test(name) || BOOKING_FILE.test(name))) return true;
  return !knownLanguage(`${subject}\n${start}`);
}

export const FINDING_INSTRUCTIONS = [
  `Does \`mail\` contain something that belongs to ${owner.name} and would otherwise get lost in the mailbox, even if the mail asks nothing of them?`,
  `It is only about ${owner.name} themselves: they booked, ordered, reserved or got an appointment. Advertising never counts, not even with a date, "today only" or a voucher for everyone.`,
].join("\n");

export const FINDING_OPTIONS = [
  {
    key: "booking",
    criterion:
      `The mail confirms to ${owner.name} a fixed appointment on a specific day at which they themselves are somewhere or something takes place for them: train, flight, hotel, rental car, table at a restaurant, ticket for a concert, cinema, game or event, doctor's, authority, garage or hairdresser appointment, delivery or tradesperson with a time window. Also a reminder of such an appointment.`,
  },
  {
    key: "lapse",
    criterion:
      `No appointment, but on a named day something lapses or costs ${owner.name} something if they do nothing: a parcel waits for pickup only until a day, the return or withdrawal period of an order, a trial subscription or test phase becomes paid from a day on, their voucher or credit lapses, a ticket must be activated by a day.`,
  },
  {
    key: "none",
    criterion: `None of that: advertising, newsletters, status messages without a date, invoices, codes, notifications, or the appointment does not concern ${owner.name}.`,
  },
] as const;

export const FINDING_QUESTION: JudgeChoiceQuestion = {
  key: "finding",
  type: "choice",
  instructions: FINDING_INSTRUCTIONS,
  options: FINDING_OPTIONS,
};

/** The answer of `judge` as a finding. Below the threshold it is none: better to miss a booking than to offer the owner advertising. */
export function judgedFinding(answer: JudgeChoiceAnswer | undefined): Finding {
  if (!answer) return "none";
  const choice = answer.choice;
  if (choice !== "booking" && choice !== "lapse") return "none";
  return (answer.probabilities[choice] ?? answer.confidence) >= MAIL_CLASSIFY_MIN_CONFIDENCE ? choice : "none";
}

/**
 * Kind of booking (addendum D62 of 2026-10-10). From it the code builds the
 * sentence above the preview ("your train booking for friday …"), and for a
 * flight it offers the check-in reminder too. A fixed vocabulary: whatever
 * else the digest delivers is no kind, and the sentence says "booking".
 */
export const BOOKING_KINDS = ["train", "flight", "hotel", "car", "table", "ticket", "appointment", "delivery"] as const;
export type BookingKind = (typeof BOOKING_KINDS)[number];

export function bookingKind(value: unknown): BookingKind | null {
  return typeof value === "string" && (BOOKING_KINDS as readonly string[]).includes(value.trim()) ? (value.trim() as BookingKind) : null;
}

/** An event from a booking mail, as the digest reads it. Foreign content except for the times. */
export interface BookingEvent {
  title: string;
  /** `YYYY-MM-DD HH:mm` wall time of the owner, or `YYYY-MM-DD` when all day. */
  start: string;
  end: string | null;
  place: string;
  /** Missing in entries from before 2026-10-10 and when the digest named no known kind. */
  kind?: BookingKind;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function instant(value: string): Date | null {
  const trimmed = value.trim();
  const wall = parseWallTime(DAY.test(trimmed) ? `${trimmed} 00:00` : trimmed);
  return wall ? wallTimeToUtc(wall) : null;
}

/**
 * Checks the event the digest model read. The code only takes what can be a
 * real event: a valid time, not before the mail arrived, not more than
 * `FINDING_EVENT_MAX_DAYS_AHEAD` ahead, end after start and at most
 * `FINDING_EVENT_MAX_HOURS` long (a week of hotel is an event, a subscription
 * is not). All day stays all day. Everything else is null and is never offered.
 */
export function validEvent(raw: unknown, receivedAt: string, now: Date): BookingEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const title = typeof value["title"] === "string" ? value["title"].replace(/\s+/g, " ").trim().slice(0, 120) : "";
  const start = typeof value["start"] === "string" ? value["start"].trim() : "";
  const endRaw = typeof value["end"] === "string" && value["end"].trim() ? value["end"].trim() : null;
  const place = typeof value["place"] === "string" ? value["place"].replace(/\s+/g, " ").trim().slice(0, 200) : "";
  if (!title || !start) return null;
  const allDay = DAY.test(start);
  if (endRaw && DAY.test(endRaw) !== allDay) return null;
  const from = instant(start);
  const to = endRaw ? instant(endRaw) : null;
  if (!from || (endRaw && !to)) return null;
  const received = new Date(receivedAt);
  const floor = Number.isNaN(received.getTime()) ? now : received;
  // On the day of arrival the event may already have started (all day: 00:00), before that not.
  if (from.getTime() < floor.getTime() - 24 * 3_600_000) return null;
  if (from.getTime() > now.getTime() + FINDING_EVENT_MAX_DAYS_AHEAD * 86_400_000) return null;
  if (to) {
    if (allDay ? to < from : to <= from) return null;
    if (to.getTime() - from.getTime() > FINDING_EVENT_MAX_HOURS * 3_600_000) return null;
  }
  const kind = bookingKind(value["kind"]);
  return { title, start, end: endRaw, place, ...(kind ? { kind } : {}) };
}

/** Start and end as instants, for the comparison with the calendar. Without an end: one hour, all day: the day. */
export function eventSpan(event: BookingEvent): { from: Date; to: Date; allDay: boolean } | null {
  const from = instant(event.start);
  if (!from) return null;
  const allDay = DAY.test(event.start);
  const end = event.end ? instant(event.end) : null;
  const to = allDay ? new Date((end ?? from).getTime() + 24 * 3_600_000) : (end ?? new Date(from.getTime() + 3_600_000));
  return { from, to, allDay };
}
