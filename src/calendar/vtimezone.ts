/**
 * A VTIMEZONE (RFC 5545, 3.6.5) for an IANA time zone, built from what the
 * runtime knows about the zone (`Intl`). Events that Serain writes into a
 * CalDAV calendar carry wall time with TZID; a series across the clock change
 * thus stays at 9 o'clock and does not slip to 8 or 10. For that the file
 * needs the definition of the zone, and which zone it is, the owner decides
 * (`OWNER_TIMEZONE`), not the code.
 *
 * The transitions of a year are searched and written as a rule ("last Sunday
 * in March at 02:00") if the rule hits the next years the same way. Otherwise,
 * for zones with special cases, every transition of the years around the
 * reference year stands as its own section with its start. Without daylight
 * saving time there is only the fixed offset.
 */

const MINUTE = 60_000;
const DAY = 86_400_000;
/** This many years before and after the reference year when the transitions stand individually. */
const SINGLE_YEARS_BEFORE = 5;
const SINGLE_YEARS_AFTER = 15;

interface Transition {
  /** First moment with the new offset. */
  at: number;
  from: number;
  to: number;
}

function offsetFormatter(zone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset", year: "numeric" });
}

/** Offset to UTC in minutes, from "GMT+05:30", "GMT-03:00" or "GMT". */
function offsetAt(format: Intl.DateTimeFormat, instant: number): number {
  const name = format.formatToParts(new Date(instant)).find((part) => part.type === "timeZoneName")?.value ?? "GMT";
  const match = /^GMT(?:([+-])(\d{2}):(\d{2}))?$/.exec(name);
  if (!match) throw new Error(`Unknown offset ${name}.`);
  if (!match[1]) return 0;
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === "-" ? -minutes : minutes;
}

function transitionsIn(format: Intl.DateTimeFormat, year: number): Transition[] {
  const found: Transition[] = [];
  const end = Date.UTC(year + 1, 0, 1);
  let previous = offsetAt(format, Date.UTC(year, 0, 1));
  for (let day = Date.UTC(year, 0, 1); day < end; day += DAY) {
    const next = offsetAt(format, day + DAY);
    if (next === previous) continue;
    // Within the day to the minute: transitions lie on full minutes.
    let low = day;
    let high = day + DAY;
    while (high - low > MINUTE) {
      const middle = low + Math.floor((high - low) / 2 / MINUTE) * MINUTE;
      if (offsetAt(format, middle) === previous) low = middle;
      else high = middle;
    }
    found.push({ at: high, from: previous, to: next });
    previous = next;
  }
  return found;
}

const pad = (value: number, width = 2) => String(value).padStart(width, "0");

function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+";
  const absolute = Math.abs(minutes);
  return `${sign}${pad(Math.floor(absolute / 60))}${pad(absolute % 60)}`;
}

/** Wall time before the transition, the way DTSTART and RDATE write it in a VTIMEZONE. */
function localBefore(transition: Transition): Date {
  return new Date(transition.at + transition.from * MINUTE);
}

function localStamp(local: Date): string {
  return `${local.getUTCFullYear()}${pad(local.getUTCMonth() + 1)}${pad(local.getUTCDate())}T${pad(local.getUTCHours())}${pad(local.getUTCMinutes())}00`;
}

const ICAL_DAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

interface Rule {
  month: number;
  weekday: number;
  /** 1 to 4: the nth in the month, -1: the last. */
  nth: number;
  minuteOfDay: number;
}

function ruleOf(transition: Transition): Rule {
  const local = localBefore(transition);
  const date = local.getUTCDate();
  const daysInMonth = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + 1, 0)).getUTCDate();
  return {
    month: local.getUTCMonth() + 1,
    weekday: local.getUTCDay(),
    nth: date + 7 > daysInMonth ? -1 : Math.ceil(date / 7),
    minuteOfDay: local.getUTCHours() * 60 + local.getUTCMinutes(),
  };
}

/** The day in the month that the rule means in `year`. */
function ruleDay(rule: Rule, year: number): number {
  if (rule.nth === -1) {
    const last = new Date(Date.UTC(year, rule.month, 0));
    return last.getUTCDate() - ((last.getUTCDay() - rule.weekday + 7) % 7);
  }
  const first = new Date(Date.UTC(year, rule.month - 1, 1)).getUTCDay();
  return 1 + ((rule.weekday - first + 7) % 7) + (rule.nth - 1) * 7;
}

function sameRule(a: Rule, b: Rule): boolean {
  return a.month === b.month && a.weekday === b.weekday && a.nth === b.nth && a.minuteOfDay === b.minuteOfDay;
}

function component(kind: "STANDARD" | "DAYLIGHT", from: number, to: number, body: string[]): string[] {
  return [`BEGIN:${kind}`, `TZOFFSETFROM:${formatOffset(from)}`, `TZOFFSETTO:${formatOffset(to)}`, ...body, `END:${kind}`];
}

/** Daylight saving time is the larger of the two offsets. */
const kindOf = (transition: Transition): "STANDARD" | "DAYLIGHT" => (transition.to > transition.from ? "DAYLIGHT" : "STANDARD");

export function buildVTimezone(zone: string, year: number = new Date().getUTCFullYear()): string {
  const format = offsetFormatter(zone);
  const transitions = transitionsIn(format, year);
  const lines = ["BEGIN:VTIMEZONE", `TZID:${zone}`];

  if (transitions.length === 0) {
    const offset = offsetAt(format, Date.UTC(year, 0, 1));
    lines.push(...component("STANDARD", offset, offset, ["DTSTART:19700101T000000"]));
  } else {
    const rules = transitions.map(ruleOf);
    const regular =
      transitions.length === 2 &&
      [year + 1, year + 2].every((later) => {
        const next = transitionsIn(format, later);
        return next.length === 2 && next.every((transition, index) => sameRule(ruleOf(transition), rules[index]!) && transition.to === transitions[index]!.to);
      });
    if (regular) {
      transitions.forEach((transition, index) => {
        const rule = rules[index]!;
        const first = new Date(Date.UTC(1970, rule.month - 1, ruleDay(rule, 1970), 0, rule.minuteOfDay));
        lines.push(
          ...component(kindOf(transition), transition.from, transition.to, [
            `DTSTART:${localStamp(first)}`,
            `RRULE:FREQ=YEARLY;BYMONTH=${rule.month};BYDAY=${rule.nth}${ICAL_DAYS[rule.weekday]}`,
          ]),
        );
      });
    } else {
      for (let current = year - SINGLE_YEARS_BEFORE; current <= year + SINGLE_YEARS_AFTER; current++) {
        for (const transition of transitionsIn(format, current)) {
          const stamp = localStamp(localBefore(transition));
          lines.push(...component(kindOf(transition), transition.from, transition.to, [`DTSTART:${stamp}`]));
        }
      }
    }
  }
  lines.push("END:VTIMEZONE");
  return lines.join("\r\n");
}
