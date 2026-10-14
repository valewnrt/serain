import { describe, expect, it } from "vitest";
import { easterSunday, holidayLine, holidayName, holidays, holidaysBetween } from "../src/holidays.js";
import { installTranslations } from "../src/i18n/catalog.js";
import { core } from "../src/i18n/messages/core.js";
import { turnContext } from "../src/agent/prompt.js";
import { executorIncoming, executorPrompt } from "../src/executor/run.js";

/** Names in the owner's language: German in tests (OWNER_LANGUAGE=de). */
const dates = (year: number) => holidays(year).map((holiday) => `${holiday.date} ${holidayName(holiday)}`);

describe("public holidays (nationwide and Hesse)", () => {
  it("computes Easter for early, late and ordinary years", () => {
    expect(easterSunday(2024)).toBe("2024-03-31");
    expect(easterSunday(2025)).toBe("2025-04-20");
    expect(easterSunday(2026)).toBe("2026-04-05");
    expect(easterSunday(2027)).toBe("2027-03-28");
    // Earliest and latest possible date.
    expect(easterSunday(2285)).toBe("2285-03-22");
    expect(easterSunday(2038)).toBe("2038-04-25");
  });

  it("knows all public holidays in Hesse, with Corpus Christi and without the Sundays", () => {
    expect(dates(2026)).toEqual([
      "2026-01-01 Neujahr",
      "2026-04-03 Karfreitag",
      "2026-04-06 Ostermontag",
      "2026-05-01 Tag der Arbeit",
      "2026-05-14 Christi Himmelfahrt",
      "2026-05-25 Pfingstmontag",
      "2026-06-04 Fronleichnam",
      "2026-10-03 Tag der Deutschen Einheit",
      "2026-12-25 Erster Weihnachtstag",
      "2026-12-26 Zweiter Weihnachtstag",
    ]);
    expect(dates(2027)).toContain("2027-03-29 Ostermontag");
    expect(dates(2027)).toContain("2027-05-17 Pfingstmontag");
    expect(dates(2027)).toContain("2027-05-27 Fronleichnam");
    expect(holidays(2026).filter((holiday) => holiday.scope === "HE").map((holiday) => holiday.id)).toEqual(["corpusChristi"]);
    expect(() => holidays(1500)).toThrow();
    // Before 1995 other law applied (Day of Repentance nationwide); the function does not compute that.
    expect(() => holidays(1994)).toThrow();
  });

  it("finds holidays across the turn of the year", () => {
    expect(holidaysBetween("2026-12-20", 14).map((holiday) => holiday.date)).toEqual(["2026-12-25", "2026-12-26", "2027-01-01"]);
    expect(holidaysBetween("2026-12-27", 4)).toEqual([]);
    expect(holidaysBetween("2026-12-27", 5).map((holiday) => holiday.id)).toEqual(["newYear"]);
  });

  it("writes an English line with weekday, by the owner's calendar day, names in the owner's language", () => {
    expect(holidayLine(new Date("2026-12-20T11:00:00Z"))).toBe(
      "Public holidays in the next 14 days (nationwide and Hessen): Fri 25 Dec: Erster Weihnachtstag; Sat 26 Dec: Zweiter Weihnachtstag; Fri 1 Jan: Neujahr.",
    );
    // 23:30 UTC on Dec 31 is already New Year's Day in Berlin.
    expect(holidayLine(new Date("2026-12-31T23:30:00Z"))).toContain("Fri 1 Jan: Neujahr (today)");
    expect(holidayLine(new Date("2026-10-02T08:00:00Z"))).toContain("Sat 3 Oct: Tag der Deutschen Einheit (tomorrow)");
    expect(holidayLine(new Date("2026-05-21T08:00:00Z"))).toBe(
      "Public holidays in the next 14 days (nationwide and Hessen): Mon 25 May: Pfingstmontag; Thu 4 Jun: Fronleichnam (in Hessen).",
    );
    expect(holidayLine(new Date("2026-10-10T08:00:00Z"))).toBeNull();
  });

  it("names the holidays in English, and in a translated language once its catalog is there", () => {
    const line = (lang: string) => holidayLine(new Date("2026-05-21T08:00:00Z"), 14, "HE", "DE", lang);
    expect(line("en")).toBe("Public holidays in the next 14 days (nationwide and Hessen): Mon 25 May: Whit Monday; Thu 4 Jun: Corpus Christi (in Hessen).");
    // Not translated yet: English.
    expect(line("tr")).toContain("Whit Monday");
    installTranslations("tr", { [core.holidayWhitMonday.en]: "Pentekost Pazartesisi" });
    expect(line("tr")).toContain("Mon 25 May: Pentekost Pazartesisi; Thu 4 Jun: Corpus Christi (in Hessen)");
  });

  it("has no holiday line for an owner outside Germany, and no error", () => {
    const now = new Date("2026-12-20T11:00:00Z");
    expect(holidayLine(now, 14, null, "US")).toBeNull();
    expect(holidayLine(now, 14, null, "TR")).toBeNull();
    expect(holidayLine(now, 14, null, null)).toBeNull();
  });

  it("is in the chat's <context> and before the executor's task, only when one is coming up", () => {
    const before = new Date("2026-09-25T08:00:00Z");
    const quiet = new Date("2026-10-10T08:00:00Z");
    expect(turnContext(before)).toContain("Sat 3 Oct: Tag der Deutschen Einheit");
    expect(turnContext(quiet)).not.toContain("Public holidays");
    expect(executorIncoming(before, "Wann hat der Wertstoffhof offen?")).toMatch(/^It is .*\nPublic holidays .*3 Oct.*\n\nWann hat/);
    expect(executorIncoming(quiet, "Wann hat der Wertstoffhof offen?")).not.toContain("Public holidays");
    // The executor's system prompt stays stable (D50): the rule is there, the days are not.
    expect(executorPrompt(true)).toContain("A public holiday\ncounts like Sunday");
    expect(executorPrompt(true)).not.toMatch(/\d{1,2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/);
  });
});

const regional = (year: number, region: Parameters<typeof holidays>[1]) =>
  holidays(year, region)
    .filter((holiday) => holiday.scope !== "bund")
    .map((holiday) => `${holiday.date} ${holidayName(holiday)}${holiday.where ? ` (${holiday.where})` : ""}`);

describe("public holidays by state", () => {
  it("takes only the nationwide ones without a state and says so in the line", () => {
    expect(holidays(2026, null).map((holiday) => holidayName(holiday))).toEqual([
      "Neujahr",
      "Karfreitag",
      "Ostermontag",
      "Tag der Arbeit",
      "Christi Himmelfahrt",
      "Pfingstmontag",
      "Tag der Deutschen Einheit",
      "Erster Weihnachtstag",
      "Zweiter Weihnachtstag",
    ]);
    expect(holidayLine(new Date("2026-05-21T08:00:00Z"), 14, null)).toBe(
      "Public holidays in the next 14 days (nationwide only, no state is set): Mon 25 May: Pfingstmontag.",
    );
  });

  it("knows Bavaria, with Assumption Day only in many municipalities", () => {
    expect(regional(2026, "BY")).toEqual([
      "2026-01-06 Heilige Drei Könige",
      "2026-06-04 Fronleichnam",
      "2026-08-15 Mariä Himmelfahrt (many_municipalities)",
      "2026-11-01 Allerheiligen",
    ]);
    expect(holidayLine(new Date("2026-08-10T08:00:00Z"), 14, "BY")).toBe(
      "Public holidays in the next 14 days (nationwide and Bayern): Sat 15 Aug: Mariä Himmelfahrt (in many municipalities in Bayern).",
    );
    expect(holidayLine(new Date("2026-05-21T08:00:00Z"), 14, "BY")).toContain("Thu 4 Jun: Fronleichnam (in Bayern)");
  });

  it("knows the other states with Epiphany, Corpus Christi, Assumption Day and All Saints' Day", () => {
    expect(regional(2026, "BW")).toEqual(["2026-01-06 Heilige Drei Könige", "2026-06-04 Fronleichnam", "2026-11-01 Allerheiligen"]);
    expect(regional(2026, "ST")).toEqual(["2026-01-06 Heilige Drei Könige", "2026-10-31 Reformationstag"]);
    expect(regional(2026, "NW")).toEqual(["2026-06-04 Fronleichnam", "2026-11-01 Allerheiligen"]);
    expect(regional(2026, "RP")).toEqual(["2026-06-04 Fronleichnam", "2026-11-01 Allerheiligen"]);
    expect(regional(2026, "SL")).toEqual(["2026-06-04 Fronleichnam", "2026-08-15 Mariä Himmelfahrt", "2026-11-01 Allerheiligen"]);
    expect(regional(2026, "BB")).toEqual(["2026-10-31 Reformationstag"]);
    expect(holidayLine(new Date("2026-10-25T08:00:00Z"), 14, "SL")).toContain("Sun 1 Nov: Allerheiligen (in Saarland)");
  });

  it("knows Women's Day in Berlin since 2019 and in Mecklenburg-Vorpommern since 2023, plus Berlin's one-off holidays", () => {
    expect(regional(2018, "BE")).toEqual([]);
    expect(regional(2019, "BE")).toEqual(["2019-03-08 Internationaler Frauentag"]);
    expect(regional(2020, "BE")).toEqual(["2020-03-08 Internationaler Frauentag", "2020-05-08 Tag der Befreiung"]);
    expect(regional(2025, "BE")).toEqual(["2025-03-08 Internationaler Frauentag", "2025-05-08 Tag der Befreiung"]);
    expect(regional(2026, "BE")).toEqual(["2026-03-08 Internationaler Frauentag"]);
    expect(regional(2028, "BE")).toEqual(["2028-03-08 Internationaler Frauentag", "2028-06-17 Jahrestag des Volksaufstands in der DDR"]);
    expect(regional(2022, "MV")).toEqual(["2022-10-31 Reformationstag"]);
    expect(regional(2023, "MV")).toEqual(["2023-03-08 Internationaler Frauentag", "2023-10-31 Reformationstag"]);
  });

  it("computes the Day of Repentance in Saxony as the Wednesday before November 23", () => {
    const repentance = (year: number) => holidays(year, "SN").find((holiday) => holiday.id === "repentance")?.date;
    expect(repentance(2022)).toBe("2022-11-16");
    expect(repentance(2023)).toBe("2023-11-22");
    expect(repentance(2024)).toBe("2024-11-20");
    expect(repentance(2025)).toBe("2025-11-19");
    expect(repentance(2026)).toBe("2026-11-18");
    expect(regional(2026, "SN")).toEqual([
      "2026-06-04 Fronleichnam (some_municipalities)",
      "2026-10-31 Reformationstag",
      "2026-11-18 Buß- und Bettag",
    ]);
    expect(holidays(2026, "BY").map((holiday) => holiday.id)).not.toContain("repentance");
    expect(holidayLine(new Date("2026-11-10T08:00:00Z"), 14, "SN")).toBe(
      "Public holidays in the next 14 days (nationwide and Sachsen): Wed 18 Nov: Buß- und Bettag (in Sachsen).",
    );
  });

  it("knows World Children's Day in Thuringia since 2019", () => {
    expect(regional(2018, "TH")).toEqual(["2018-05-31 Fronleichnam (some_municipalities)", "2018-10-31 Reformationstag"]);
    expect(regional(2019, "TH")).toEqual([
      "2019-06-20 Fronleichnam (some_municipalities)",
      "2019-09-20 Weltkindertag",
      "2019-10-31 Reformationstag",
    ]);
    expect(holidayLine(new Date("2026-09-15T08:00:00Z"), 14, "TH")).toBe(
      "Public holidays in the next 14 days (nationwide and Thüringen): Sun 20 Sept: Weltkindertag (in Thüringen).",
    );
  });

  it("knows Reformation Day in the north only since 2018 and everywhere once in 2017", () => {
    expect(regional(2016, "NI")).toEqual([]);
    expect(regional(2018, "NI")).toEqual(["2018-10-31 Reformationstag"]);
    for (const region of ["HB", "HH", "SH"] as const) {
      expect(regional(2016, region)).toEqual([]);
      expect(regional(2026, region)).toEqual(["2026-10-31 Reformationstag"]);
    }
    // 2017 nationwide, in every state exactly once, also where it applies anyway.
    for (const region of [null, "HE", "NI", "SN"] as const) {
      const reformation = holidays(2017, region).filter((holiday) => holiday.id === "reformation");
      expect(reformation).toEqual([{ date: "2017-10-31", id: "reformation", scope: "bund" }]);
    }
    expect(holidays(2018, "HE").map((holiday) => holiday.id)).not.toContain("reformation");
    expect(holidayLine(new Date("2017-10-25T08:00:00Z"), 14, "HE")).toBe(
      "Public holidays in the next 14 days (nationwide and Hessen): Tue 31 Oct: Reformationstag.",
    );
  });

  it("follows the owner's state without an argument (Hesse in tests)", () => {
    expect(holidays(2026)).toEqual(holidays(2026, "HE"));
    expect(holidaysBetween("2026-05-21", 14)).toEqual(holidaysBetween("2026-05-21", 14, "HE"));
  });
});
