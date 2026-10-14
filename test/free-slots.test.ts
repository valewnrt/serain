import { describe, expect, it, vi } from "vitest";
import { busySpanAt } from "../src/calendar/busy.js";
import { findFreeSlots, slotLabel } from "../src/calendar/free.js";
import type { CalendarEntry } from "../src/calendar/types.js";
import { calendarTools } from "../src/agent/tools/calendar.js";
import type { Calendar } from "../src/calendar/types.js";
import { TurnState } from "../src/agent/tools/types.js";

/** Scheduling: the code computes the gaps. */

const entry = (start: string, end: string, extra: Partial<CalendarEntry> = {}): CalendarEntry => ({
  id: `e-${start}`,
  title: "Geheimer Titel",
  start,
  end,
  allDay: false,
  location: "",
  guests: [],
  status: "confirmed",
  organizerSelf: true,
  declined: false,
  ...extra,
});

// Mon 2026-10-12 to Fri 2026-10-16, still daylight saving time (+02:00).
const base = {
  from: "2026-10-12",
  to: "2026-10-16",
  minutes: 60,
  earliest: 9 * 60,
  latest: 18 * 60,
  weekends: false,
  bufferMinutes: 15,
  travelMinutes: 45,
  notBefore: new Date("2026-10-12T05:00:00Z"),
  maxSlots: 3,
};

describe("findFreeSlots", () => {
  it("spreads three suggestions over three days and avoids events with a buffer", () => {
    const busy = [entry("2026-10-12T09:00:00+02:00", "2026-10-12T10:00:00+02:00")];
    const { slots } = findFreeSlots(busy, base);
    expect(slots.map(slotLabel)).toEqual(["Mon 12 Oct, 10:30 to 11:30", "Tue 13 Oct, 09:00 to 10:00", "Wed 14 Oct, 09:00 to 10:00"]);
  });

  it("leaves out weekends unless wanted, and does not count declined events as busy", () => {
    const weekend = { ...base, from: "2026-10-17", to: "2026-10-18" };
    expect(findFreeSlots([], weekend).slots).toEqual([]);
    expect(new Set(findFreeSlots([], { ...weekend, weekends: true }).slots.map((slot) => slot.day))).toEqual(new Set(["2026-10-17", "2026-10-18"]));
    const declined = entry("2026-10-12T09:00:00+02:00", "2026-10-12T18:00:00+02:00", { declined: true });
    expect(slotLabel(findFreeSlots([declined], base).slots[0]!)).toBe("Mon 12 Oct, 09:00 to 10:00");
  });

  it("takes a second slot on the same day only with a gap, when there are too few days", () => {
    const oneDay = { ...base, to: "2026-10-12" };
    const { slots } = findFreeSlots([], oneDay);
    expect(slots.map(slotLabel)).toEqual(["Mon 12 Oct, 09:00 to 10:00", "Mon 12 Oct, 11:00 to 12:00", "Mon 12 Oct, 13:00 to 14:00"]);
  });

  it("suggests nothing that is already over, and starts on the half hour", () => {
    const { slots } = findFreeSlots([], { ...base, to: "2026-10-12", notBefore: new Date("2026-10-12T14:10:00Z") });
    expect(slotLabel(slots[0]!)).toBe("Mon 12 Oct, 16:30 to 17:30");
  });

  it("accounts for travel time around events with a location (work until 17:00 in another city)", () => {
    const work = entry("2026-10-12T08:30:00+02:00", "2026-10-12T17:00:00+02:00", { location: "Musterweg 7, 12345 Musterstadt" });
    const oneDay = { ...base, to: "2026-10-12", minutes: 30 };
    expect(findFreeSlots([work], oneDay).slots).toEqual([]);
    expect(slotLabel(findFreeSlots([work], { ...oneDay, latest: 20 * 60 }).slots[0]!)).toBe("Mon 12 Oct, 18:00 to 18:30");
    // Without a location it stays at the buffer.
    expect(slotLabel(findFreeSlots([{ ...work, location: "" }], { ...oneDay, latest: 20 * 60 }).slots[0]!)).toBe("Mon 12 Oct, 17:30 to 18:00");
  });

  it("does not block with all-day entries, but names the day", () => {
    const holiday = entry("2026-10-13", "2026-10-15", { allDay: true });
    const result = findFreeSlots([holiday], base);
    expect(result.allDayDays).toEqual(["2026-10-13", "2026-10-14"]);
    expect(result.slots).toHaveLength(3);
  });
});

describe("busySpanAt", () => {
  const at = (iso: string) => new Date(iso);
  it("names the contiguous busy span around the instant, without declined, cancelled and all-day entries", () => {
    const entries = [
      entry("2026-10-12T10:00:00+02:00", "2026-10-12T11:00:00+02:00"),
      // Overlaps and follows without a gap: all one span.
      entry("2026-10-12T10:30:00+02:00", "2026-10-12T12:00:00+02:00"),
      entry("2026-10-12T12:00:00+02:00", "2026-10-12T12:30:00+02:00"),
      entry("2026-10-12T13:00:00+02:00", "2026-10-12T14:00:00+02:00"),
      entry("2026-10-12T15:00:00+02:00", "2026-10-12T16:00:00+02:00", { declined: true }),
      entry("2026-10-12T16:00:00+02:00", "2026-10-12T17:00:00+02:00", { status: "cancelled" }),
      entry("2026-10-12", "2026-10-13", { allDay: true }),
    ];
    expect(busySpanAt(entries, at("2026-10-12T10:15:00+02:00"))).toEqual({
      start: at("2026-10-12T10:00:00+02:00"),
      end: at("2026-10-12T12:30:00+02:00"),
    });
    expect(busySpanAt(entries, at("2026-10-12T12:45:00+02:00"))).toBeNull();
    expect(busySpanAt(entries, at("2026-10-12T14:00:00+02:00"))).toBeNull();
    expect(busySpanAt(entries, at("2026-10-12T15:30:00+02:00"))).toBeNull();
    expect(busySpanAt(entries, at("2026-10-12T16:30:00+02:00"))).toBeNull();
    expect(busySpanAt(entries, at("2026-10-12T08:00:00+02:00"))).toBeNull();
  });
});

describe("calendar_free", () => {
  const calendar = (entries: CalendarEntry[], truncated = false): Calendar => ({
    label: "Alex' iCloud-Kalender",
    invites: false,
    deleteUndo: "",
    list: async () => ({ entries, truncated }),
    get: async () => null,
    create: async () => {
      throw new Error("no");
    },
    update: async () => {
      throw new Error("no");
    },
    remove: async () => undefined,
  });
  const tool = (cal: Calendar) => calendarTools(cal, undefined, () => new Date("2026-10-12T05:00:00Z")).find((def) => def.name === "calendar_free")!;
  const turn = () => new TurnState({ origin: "owner_message", triggerExternalId: "", triggerMessageId: "", reactableIds: [] });
  const args = { from: "2026-10-12", to: "2026-10-16", minutes: 30, earliest: "09:00", latest: "18:00", weekends: false, buffer_minutes: 15, travel_minutes: 45 };

  it("returns only times, never titles, and does not count as foreign content", async () => {
    const def = tool(calendar([entry("2026-10-12T09:00:00+02:00", "2026-10-12T12:00:00+02:00")]));
    expect(def.returnsUntrusted).toBeUndefined();
    expect(def.level).toBe("read");
    const result = await def.run(args, turn());
    expect(result.ok).toBe(true);
    expect(result.text).not.toContain("Geheimer Titel");
    expect(result.text.split("\n").filter((line) => line.startsWith("- "))).toHaveLength(3);
  });

  it("does not compute with a truncated calendar or over two weeks", async () => {
    expect((await tool(calendar([], true)).run(args, turn())).ok).toBe(false);
    expect((await tool(calendar([])).run({ ...args, to: "2026-10-30" }, turn())).text).toContain("At most 14 days");
  });
});

describe("scheduling in a zone offset by three quarters of an hour", () => {
  it("starts on the full or half hour of wall time, not of UTC", async () => {
    vi.resetModules();
    vi.stubEnv("OWNER_TIMEZONE", "Asia/Kathmandu");
    try {
      const free = await import("../src/calendar/free.js");
      // 09:40 UTC is 15:25 in Nepal (+05:45): the next suggestion is 15:30 (09:45 UTC), not 15:45 (10:00 UTC).
      const { slots } = free.findFreeSlots([], { ...base, from: "2026-10-12", to: "2026-10-12", latest: 20 * 60, notBefore: new Date("2026-10-12T09:40:00Z") });
      expect(slots[0]?.start.toISOString()).toBe("2026-10-12T09:45:00.000Z");
      expect(free.slotLabel(slots[0]!)).toBe("Mon 12 Oct, 15:30 to 16:30");
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});
