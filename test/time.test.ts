import { describe, expect, it } from "vitest";
import {
  formatAnchor,
  formatWallDay,
  formatWallTime,
  nextOccurrence,
  parseAnchor,
  parseWallTime,
  toWallTime,
  wallAnchor,
  wallTimeToUtc,
} from "../src/time.js";

const utc = (wall: string) => wallTimeToUtc(parseWallTime(wall)!).toISOString();

describe("wall time Europe/Berlin", () => {
  it("converts summer and winter time itself", () => {
    expect(utc("2026-09-20 09:00")).toBe("2026-09-20T07:00:00.000Z");
    expect(utc("2026-12-20T09:00")).toBe("2026-12-20T08:00:00.000Z");
  });

  it("gets through the nights the clocks change", () => {
    // 2026-03-29: 02:30 does not exist. 2026-10-25: 02:30 exists twice, the first one counts.
    expect(utc("2026-03-29 02:30")).toBe("2026-03-29T01:30:00.000Z");
    expect(utc("2026-10-25 02:30")).toBe("2026-10-25T00:30:00.000Z");
  });

  it("round-trips", () => {
    const wall = parseWallTime("2026-11-02 18:45")!;
    expect(toWallTime(wallTimeToUtc(wall))).toEqual(wall);
  });

  it("rejects what is not a point in time", () => {
    for (const bad of ["morgen um 9", "2026-02-31 09:00", "2026-09-20 25:00", "2026-09-20", ""]) {
      expect(parseWallTime(bad)).toBeNull();
    }
  });
});

describe("day and time for the model and for the owner", () => {
  // 2026-10-22 is a Thursday; 12:05 UTC is 14:05 summer time.
  const instant = new Date("2026-10-22T12:05:00.000Z");

  it("names the month as a word for the model, without a locale", () => {
    expect(formatWallTime(instant)).toBe("Thu 22 Oct, 14:05");
    expect(formatWallDay(instant)).toBe("Thu 22 Oct");
  });

  it("uses the owner's short form with a locale", () => {
    expect(formatWallTime(instant, "de")).toBe("Do., 22.10., 14:05");
    expect(formatWallDay(instant, "de")).toBe("Do., 22.10.");
    expect(formatWallTime(instant, "en")).toBe("Thu, 10/22, 14:05");
    expect(formatWallDay(instant, "en")).toBe("Thu, 10/22");
  });

  it("names the day in the owner's time zone, not in UTC", () => {
    // 23:30 UTC on Thursday is already Friday in Europe/Berlin.
    expect(formatWallDay(new Date("2026-10-22T23:30:00.000Z"))).toBe("Fri 23 Oct");
  });
});

describe("anchor of a repetition", () => {
  it("round-trips as wall time with milliseconds", () => {
    const anchor = wallAnchor(new Date("2026-10-23T05:59:17.400Z"));
    expect(formatAnchor(anchor)).toBe("2026-10-23 07:59:17.400");
    expect(parseAnchor(formatAnchor(anchor))).toEqual(anchor);
    // The skipped hour is valid as an anchor: 02:30 was meant.
    expect(parseAnchor("2027-03-28 02:30:00.000")).toEqual({ year: 2027, month: 3, day: 28, hour: 2, minute: 30, millis: 0 });
  });

  it("rejects what is none, including an instant with an offset", () => {
    for (const bad of ["2026-10-09T07:00:00.000Z", "2026-10-09 07:00", "2026-02-31 09:00:00.000", "2026-10-09 07:00:60.000"]) {
      expect(parseAnchor(bad)).toBeNull();
    }
  });
});

describe("repetitions", () => {
  const at = (wall: string) => wallTimeToUtc(parseWallTime(wall)!);

  it("keeps the wall time across the clock change", () => {
    const next = nextOccurrence(at("2026-10-24 09:00"), "daily", at("2026-10-24 09:00"));
    expect(next.toISOString()).toBe("2026-10-25T08:00:00.000Z");
  });

  it("skips the weekend", () => {
    // 2026-09-18 is a Friday.
    const next = nextOccurrence(at("2026-09-18 08:00"), "weekdays", at("2026-09-18 08:00"));
    expect(toWallTime(next)).toMatchObject({ day: 21, hour: 8 });
  });

  it("does not catch up on every missed run after a long outage", () => {
    const next = nextOccurrence(at("2026-09-01 07:00"), "weekly", at("2026-09-19 12:00"));
    expect(toWallTime(next)).toMatchObject({ month: 9, day: 22, hour: 7 });
  });

  it("takes the last day at the end of the month", () => {
    const next = nextOccurrence(at("2027-01-31 10:00"), "monthly", at("2027-01-31 10:00"));
    expect(toWallTime(next)).toMatchObject({ month: 2, day: 28 });
  });
});
