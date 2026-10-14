import { owner, REGIONS, type Region } from "./config/owner.js";
import { t, type Message } from "./i18n/catalog.js";
import { currentLanguage } from "./i18n/language.js";
import { core } from "./i18n/messages/core.js";
import { addDays, ownerDate, parseDay } from "./time.js";

/**
 * Public holidays in Germany, nationwide and in the owner's state
 * (`owner.region`). Only for owners living in Germany (`owner.country === "DE"`);
 * for every other country there is no holiday line, and nothing guesses one. A
 * pure function without network: opening hours and timetables depend on it (a
 * holiday counts like Sunday), and neither the chat nor the executor should
 * have to guess or look it up first.
 *
 * Easter Sunday and Whit Sunday are left out on purpose: they are always a
 * Sunday and change nothing about opening hours and timetables. Christmas Eve
 * and New Year's Eve are no public holidays. Holidays that only apply in some
 * municipalities (Corpus Christi in parts of Saxony and Thuringia, Assumption
 * Day in Bavaria) carry `where`; city holidays like the Augsburg Peace Festival
 * are missing.
 *
 * The rules are the law since 1995 (Day of Repentance and Prayer only in
 * Saxony since then), with the later changes and their year: Reformation Day
 * nationwide in 2017 and in the north since 2018, Women's Day in Berlin since
 * 2019 and in Mecklenburg-Western Pomerania since 2023, World Children's Day in
 * Thuringia since 2019, plus Berlin's one-off holidays. The function does not
 * compute earlier years.
 *
 * Names come from the catalog (`core.holiday*`) in the owner's language
 * (`holidayName`); the data itself only carries an id.
 */

export type HolidayId =
  | "newYear"
  | "goodFriday"
  | "easterMonday"
  | "labourDay"
  | "ascension"
  | "whitMonday"
  | "germanUnity"
  | "christmas"
  | "secondChristmas"
  | "reformation"
  | "epiphany"
  | "womensDay"
  | "liberation"
  | "corpusChristi"
  | "uprising"
  | "assumption"
  | "childrensDay"
  | "allSaints"
  | "repentance";

const NAMES: Record<HolidayId, Message<never>> = {
  newYear: core.holidayNewYear,
  goodFriday: core.holidayGoodFriday,
  easterMonday: core.holidayEasterMonday,
  labourDay: core.holidayLabourDay,
  ascension: core.holidayAscension,
  whitMonday: core.holidayWhitMonday,
  germanUnity: core.holidayGermanUnity,
  christmas: core.holidayChristmas,
  secondChristmas: core.holidaySecondChristmas,
  reformation: core.holidayReformation,
  epiphany: core.holidayEpiphany,
  womensDay: core.holidayWomensDay,
  liberation: core.holidayLiberation,
  corpusChristi: core.holidayCorpusChristi,
  uprising: core.holidayUprising,
  assumption: core.holidayAssumption,
  childrensDay: core.holidayChildrensDay,
  allSaints: core.holidayAllSaints,
  repentance: core.holidayRepentance,
};

/** Where a regional holiday applies when not in the whole state. */
export type HolidayWhere = "some_municipalities" | "many_municipalities";

const WHERE: Record<HolidayWhere, string> = {
  some_municipalities: "in some municipalities",
  many_municipalities: "in many municipalities",
};

export interface Holiday {
  /** Calendar day `YYYY-MM-DD`. */
  date: string;
  id: HolidayId;
  /** `bund`: everywhere in Germany; otherwise the state where it applies. */
  scope: "bund" | Region;
  /** Only for holidays that do not apply in the whole state: where. */
  where?: HolidayWhere;
}

/** The name of a holiday in the owner's language (or `lang`). */
export function holidayName(holiday: Pick<Holiday, "id">, lang: string = currentLanguage()): string {
  return t(NAMES[holiday.id], undefined, lang);
}

/** From this year on the rules below are right (Day of Repentance and Prayer only in Saxony since 1995). */
const FIRST_YEAR = 1995;

/** Easter Sunday in the Gregorian calendar (Gauss, in the form of Meeus/Jones/Butcher). */
export function easterSunday(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Day of Repentance and Prayer: the Wednesday before November 23 (16th to 22nd). */
function repentanceDay(year: number): string {
  const weekday = new Date(Date.UTC(year, 10, 22)).getUTCDay();
  return addDays(`${year}-11-22`, -((weekday - 3 + 7) % 7));
}

/**
 * A holiday of the states: in which states, from which year, and whether only
 * in part of the municipalities. `only` names the years of one-off holidays.
 */
interface RegionalRule {
  id: HolidayId;
  date: (year: number, easter: string) => string;
  regions: Partial<Record<Region, { since?: number; only?: number[]; where?: HolidayWhere }>>;
}

const fixedDay = (month: number, day: number) => (year: number) =>
  `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

const REGIONAL: RegionalRule[] = [
  { id: "epiphany", date: fixedDay(1, 6), regions: { BW: {}, BY: {}, ST: {} } },
  { id: "womensDay", date: fixedDay(3, 8), regions: { BE: { since: 2019 }, MV: { since: 2023 } } },
  { id: "liberation", date: fixedDay(5, 8), regions: { BE: { only: [2020, 2025] } } },
  {
    id: "corpusChristi",
    date: (_year, easter) => addDays(easter, 60),
    regions: {
      BW: {},
      BY: {},
      HE: {},
      NW: {},
      RP: {},
      SL: {},
      SN: { where: "some_municipalities" },
      TH: { where: "some_municipalities" },
    },
  },
  { id: "uprising", date: fixedDay(6, 17), regions: { BE: { only: [2028] } } },
  // In Bavaria only in municipalities with a mainly Catholic population, which is most of them.
  { id: "assumption", date: fixedDay(8, 15), regions: { SL: {}, BY: { where: "many_municipalities" } } },
  { id: "childrensDay", date: fixedDay(9, 20), regions: { TH: { since: 2019 } } },
  {
    id: "reformation",
    date: fixedDay(10, 31),
    regions: {
      BB: {},
      MV: {},
      SN: {},
      ST: {},
      TH: {},
      HB: { since: 2018 },
      HH: { since: 2018 },
      NI: { since: 2018 },
      SH: { since: 2018 },
    },
  },
  { id: "allSaints", date: fixedDay(11, 1), regions: { BW: {}, BY: {}, NW: {}, RP: {}, SL: {} } },
  { id: "repentance", date: (year) => repentanceDay(year), regions: { SN: {} } },
];

/**
 * All public holidays of a year, by date: the nationwide ones and those of the
 * state. Without a state (`null`) only the nationwide ones.
 */
export function holidays(year: number, region: Region | null = owner.region): Holiday[] {
  if (!Number.isInteger(year) || year < FIRST_YEAR || year > 9999) {
    throw new Error(`Holidays are known here for the years ${FIRST_YEAR} to 9999, not for ${year}.`);
  }
  const easter = easterSunday(year);
  const fixed = (month: number, day: number) => fixedDay(month, day)(year);
  const list: Holiday[] = [
    { date: fixed(1, 1), id: "newYear", scope: "bund" },
    { date: addDays(easter, -2), id: "goodFriday", scope: "bund" },
    { date: addDays(easter, 1), id: "easterMonday", scope: "bund" },
    { date: fixed(5, 1), id: "labourDay", scope: "bund" },
    { date: addDays(easter, 39), id: "ascension", scope: "bund" },
    { date: addDays(easter, 50), id: "whitMonday", scope: "bund" },
    { date: fixed(10, 3), id: "germanUnity", scope: "bund" },
    { date: fixed(12, 25), id: "christmas", scope: "bund" },
    { date: fixed(12, 26), id: "secondChristmas", scope: "bund" },
  ];
  // 500 years of the Reformation: once everywhere in 2017.
  if (year === 2017) list.push({ date: fixed(10, 31), id: "reformation", scope: "bund" });
  if (region) {
    for (const rule of REGIONAL) {
      const entry = rule.regions[region];
      if (!entry) continue;
      if (entry.since !== undefined && year < entry.since) continue;
      if (entry.only !== undefined && !entry.only.includes(year)) continue;
      const date = rule.date(year, easter);
      // In 2017 Reformation Day is already there nationwide, also in states where it applies anyway.
      if (list.some((holiday) => holiday.date === date && holiday.id === rule.id)) continue;
      list.push({ date, id: rule.id, scope: region, ...(entry.where ? { where: entry.where } : {}) });
    }
  }
  return list.sort((x, y) => x.date.localeCompare(y.date));
}

/** Holidays from `from` up to and including `from` plus `days` days, across the turn of the year too. */
export function holidaysBetween(from: string, days: number, region: Region | null = owner.region): Holiday[] {
  const start = parseDay(from);
  if (!start) throw new Error(`Not a calendar day: ${from}`);
  const end = addDays(from, days);
  const endYear = Number(end.slice(0, 4));
  const found: Holiday[] = [];
  for (let year = start.year; year <= endYear; year += 1) {
    for (const holiday of holidays(year, region)) {
      if (holiday.date >= from && holiday.date <= end) found.push(holiday);
    }
  }
  return found;
}

/** How many days ahead the line in the context looks. */
export const HOLIDAY_LOOKAHEAD_DAYS = 14;

/** "Sat 3 Oct" for a calendar day, independent of the server's time zone. For the model, like `formatWallDay`. */
const DAY_LABEL = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });

function dayLabel(day: string): string {
  const parsed = parseDay(day)!;
  return DAY_LABEL.format(new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day, 12)));
}

/**
 * A line with the holidays from today to `HOLIDAY_LOOKAHEAD_DAYS` days ahead
 * (calendar day of the owner), null if none falls into it or the owner does
 * not live in Germany. For the executor's task and the chat's `<context>`;
 * never for the system prompt (D47). The line is English like everything the
 * model reads; the names are in the owner's language, the way they know them.
 * Without a state the line says that only the nationwide ones are in it, so
 * the model does not turn a missing Corpus Christi into a working day.
 */
export function holidayLine(
  now: Date,
  days = HOLIDAY_LOOKAHEAD_DAYS,
  region: Region | null = owner.region,
  country: string | null = owner.country,
  lang: string = currentLanguage(),
): string | null {
  if (country !== "DE") return null;
  const today = ownerDate(now);
  const tomorrow = addDays(today, 1);
  const found = holidaysBetween(today, days, region);
  if (found.length === 0) return null;
  const items = found.map((holiday) => {
    const where = holiday.scope === "bund" ? "" : [holiday.where ? WHERE[holiday.where] : "", `in ${REGIONS[holiday.scope]}`].filter(Boolean).join(" ");
    const notes = [holiday.date === today ? "today" : holiday.date === tomorrow ? "tomorrow" : "", where].filter(Boolean);
    return `${dayLabel(holiday.date)}: ${holidayName(holiday, lang)}${notes.length > 0 ? ` (${notes.join(", ")})` : ""}`;
  });
  const scope = region ? `nationwide and ${REGIONS[region]}` : "nationwide only, no state is set";
  return `Public holidays in the next ${days} days (${scope}): ${items.join("; ")}.`;
}
