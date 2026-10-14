import { OWNER_TIMEZONE, toWallTime, wallTimeToUtc } from "../time.js";

/**
 * Kind and validity of a fact (V2, D39). Leaf-like, without database and
 * without SDK, because extraction, recall, consolidation and the eval need the
 * same rules.
 *
 * The distinction comes from the identity thesis of the audit of 2026-10-02: a
 * detail has to know whether it says who the owner is, what they like, what
 * holds right now or what happened once. Only the third kind expires, and
 * exactly that one used to sit in the context without a limit ("exams at the
 * weekend").
 *
 * The kind's name is also how it appears in prompts (`[category, situation,
 * until 2026-08-31]`); the extraction prompt explains the same four names.
 */
export const FACT_KINDS = ["identity", "preference", "situation", "episode"] as const;
export type FactKind = (typeof FACT_KINDS)[number];

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A calendar day YYYY-MM-DD, checked. Null when the day does not exist. */
function parseDay(value: string): { year: number; month: number; day: number } | null {
  const match = DAY.exec(value.trim());
  if (!match) return null;
  const [year, month, day] = match.slice(1).map(Number) as [number, number, number];
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  return { year, month, day };
}

/** Start of a calendar day in the owner's time zone, in UTC: "from 1 November" holds from 00:00 there. */
export function ownerDayStart(value: string): Date | null {
  const day = parseDay(value);
  return day ? wallTimeToUtc({ ...day, hour: 0, minute: 0 }) : null;
}

/**
 * End of a calendar day in the owner's time zone, as the start of the next
 * day: "until the end of August" still holds for all of 31 August.
 * `valid_until` is exclusive, like the query `valid_until > now` in
 * `search_facts`.
 */
export function ownerDayEnd(value: string): Date | null {
  const day = parseDay(value);
  if (!day) return null;
  const next = new Date(Date.UTC(day.year, day.month - 1, day.day + 1));
  return wallTimeToUtc({ year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate(), hour: 0, minute: 0 });
}

/** Calendar day in the owner's time zone as YYYY-MM-DD, for prompts. */
export function ownerDay(instant: Date): string {
  const wall = toWallTime(instant);
  return `${wall.year}-${String(wall.month).padStart(2, "0")}-${String(wall.day).padStart(2, "0")}`;
}

/** A date for the owner (`show_memory`) in the owner's time zone: "01.10.2026" in German, "10/01/2026" in English. */
export function shortDay(instant: Date, locale: string): string {
  return new Intl.DateTimeFormat(locale, { timeZone: OWNER_TIMEZONE, day: "2-digit", month: "2-digit", year: "numeric" }).format(instant);
}

export interface Validity {
  validFrom: string | null;
  validUntil: string | null;
}

/**
 * When a fact holds, as data: `on` for an episode (the day it happened),
 * `from` for something that only starts in the future, `until` for the last
 * day it still holds (not the exclusive instant after it). Prompts render it
 * in English (`validityLabel`), `show_memory` in the owner's language.
 */
export interface ValidityParts {
  start: { kind: "on" | "from"; day: Date } | null;
  until: Date | null;
}

/** The validity of a fact as data; null when it holds without a limit. */
export function validityParts(fact: Validity & { kind?: FactKind }, now: Date): ValidityParts | null {
  let start: ValidityParts["start"] = null;
  if (fact.validFrom) {
    const from = new Date(fact.validFrom);
    if (fact.kind === "episode") start = { kind: "on", day: from };
    else if (from > now) start = { kind: "from", day: from };
  }
  const until = fact.validUntil ? new Date(new Date(fact.validUntil).getTime() - 1) : null;
  return start || until ? { start, until } : null;
}

/**
 * How the validity appears in prompts: "from 2026-11-01", "until 2026-08-31",
 * "on 2026-07-01". Empty when the fact holds without a limit.
 */
export function validityLabel(fact: Validity & { kind?: FactKind }, now: Date): string {
  const parts = validityParts(fact, now);
  if (!parts) return "";
  return [parts.start ? `${parts.start.kind} ${ownerDay(parts.start.day)}` : "", parts.until ? `until ${ownerDay(parts.until)}` : ""]
    .filter(Boolean)
    .join(", ");
}

/** Does the fact (still) hold at this instant? Future facts count as valid: they are known, just not in effect yet. */
export function notExpired(fact: Pick<Validity, "validUntil">, now: Date): boolean {
  return fact.validUntil === null || new Date(fact.validUntil) > now;
}

/** A validity reaches at most this far into the future; anything beyond is a misreading by the model. */
const MAX_VALIDITY_YEARS = 5;

/**
 * The validity the model proposes, checked in code: real days, order, not
 * absurdly far away, `valid_until` not already over (then it was an episode
 * and not a state). Whatever does not hold falls back to "without a limit"
 * instead of dropping the fact: a fact without an end is the old, known
 * state, a lost fact would be a new error.
 */
export function resolveValidity(
  raw: { kind: FactKind; validFrom: string | null; validUntil: string | null },
  now: Date,
): Validity {
  const limit = new Date(now.getTime() + MAX_VALIDITY_YEARS * 365 * 86_400_000);
  const floor = new Date(now.getTime() - MAX_VALIDITY_YEARS * 365 * 86_400_000);
  const from = raw.validFrom ? ownerDayStart(raw.validFrom) : null;
  const until = raw.validUntil ? ownerDayEnd(raw.validUntil) : null;
  // For an episode, `valid_from` is the day it happened, so usually in the
  // past. For every other kind a past start only means "holds", and that is
  // already the normal case without a date.
  const validFrom =
    from && from < limit && (from > now || (raw.kind === "episode" && from > floor)) ? from : null;
  let validUntil = until && until > now && until < limit ? until : null;
  if (validFrom && validUntil && validUntil <= validFrom) validUntil = null;
  return {
    validFrom: validFrom ? validFrom.toISOString() : null,
    validUntil: validUntil ? validUntil.toISOString() : null,
  };
}
