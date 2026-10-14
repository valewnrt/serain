/**
 * Date and time are not judgements: a value like "21.09.2026" belongs in the date field, "04:00" in the time field,
 * and the browser only accepts ISO there. Jev does not compute or compare dates (Typesafe, notes on jev-1.13:
 * "compute in code"); live on 2026-09-20 the pilot clicked through a calendar on a transit site for twenty steps
 * while the date and time fields stood open on the start page.
 *
 * Only unambiguous notations count as a date: ISO and day.month.year with dots. Slashed dates ("09/10/2026") mean
 * different days in different countries and stay text.
 */

export type TypedKind = "date" | "time";

const DOTTED_DATE = /^(\d{1,2})\.(\d{1,2})\.(\d{2}|\d{4})$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** "4:00", "04.00", "16h30", "04:00 Uhr", "4:00 h", "4:30 pm". */
const TIME = /^(\d{1,2})[:.h](\d{2})(?:\s*(?:uhr|h))?(?:\s*([ap])\.?\s?m\.?)?$/i;

/** What kind of value is this, and how does a native field write it? */
export function typedValue(text: string): { kind: TypedKind; value: string } | null {
  const trimmed = text.trim();
  if (ISO_DATE.test(trimmed)) return { kind: "date", value: trimmed };
  const date = DOTTED_DATE.exec(trimmed);
  if (date) {
    const year = date[3]!.length === 2 ? `20${date[3]}` : date[3]!;
    return { kind: "date", value: `${year}-${date[2]!.padStart(2, "0")}-${date[1]!.padStart(2, "0")}` };
  }
  const time = TIME.exec(trimmed);
  if (!time) return null;
  let hour = Number(time[1]);
  const minute = Number(time[2]);
  const meridiem = time[3]?.toLowerCase();
  if (meridiem) {
    // 12-hour clock: 1 to 12 only, 12 am is midnight and 12 pm is noon.
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (meridiem === "p" ? 12 : 0);
  }
  if (hour >= 24 || minute >= 60) return null;
  return { kind: "time", value: `${String(hour).padStart(2, "0")}:${time[2]}` };
}

/** The text written into a field of this type. Other fields get the value as it is. */
export function valueForField(text: string, type: string): string {
  const typed = typedValue(text);
  return typed && typed.kind === type ? typed.value : text;
}

/**
 * A date in the format of a text field that already holds one: "10.10.2026" gets "13.10.2026", "10.10.26" gets
 * "13.10.26", ISO stays ISO. The format comes from what the field shows, not from a language. Otherwise the dotted
 * day.month.year that hand-built fields usually parse. `iso` is YYYY-MM-DD.
 */
export function dateLike(iso: string, current: string | undefined): string {
  const [year, month, day] = iso.split("-") as [string, string, string];
  const now = current?.trim() ?? "";
  if (ISO_DATE.test(now)) return iso;
  const dotted = DOTTED_DATE.exec(now);
  if (dotted) return `${dotted[1]!.length === 1 ? String(Number(day)) : day}.${dotted[2]!.length === 1 ? String(Number(month)) : month}.${dotted[3]!.length === 2 ? year.slice(2) : year}`;
  return `${day}.${month}.${year}`;
}
