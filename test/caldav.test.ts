import { beforeEach, describe, expect, it, vi } from "vitest";

const auditMock = vi.fn(async () => undefined);
vi.mock("../src/db/audit.js", () => ({ audit: (...args: unknown[]) => auditMock(...(args as [])) }));

const { caldavCalendar, decodeId, encodeId, iCloudDav, DavError } = await import("../src/calendar/caldav.js");
const { CalendarError } = await import("../src/calendar/types.js");
const { calendarTools } = await import("../src/agent/tools/calendar.js");
const { ToolRegistry } = await import("../src/agent/tools/registry.js");
const { TurnState } = await import("../src/agent/tools/types.js");
type DavApi = import("../src/calendar/caldav.js").DavApi;
type ToolDefinition = import("../src/agent/tools/types.js").ToolDefinition;

const HOME = "https://p42-caldav.icloud.com/1234/calendars/home/";
const WORK = "https://p42-caldav.icloud.com/1234/calendars/work/";
const ACCOUNT = "alex@example.org";

/** A CalDAV server in memory: files with ETag, nothing else. */
function fakeServer() {
  const files = new Map<string, { data: string; etag: string }>();
  const calls: string[] = [];
  let version = 0;
  const api: DavApi = {
    async calendars() {
      return [
        { url: HOME, name: "Privat" },
        { url: WORK, name: "Arbeit" },
      ];
    },
    async query(calendarUrl) {
      return [...files.entries()].filter(([url]) => url.startsWith(calendarUrl)).map(([url, file]) => ({ url, etag: file.etag, data: file.data }));
    },
    async get(url) {
      const file = files.get(url);
      return file ? { url, etag: file.etag, data: file.data } : null;
    },
    async put(url, data, etag) {
      calls.push(`PUT ${url} ${etag ?? "new"}`);
      const existing = files.get(url);
      if (etag === null && existing) throw new DavError("already exists", 412);
      if (etag !== null && existing?.etag !== etag) throw new DavError("The event was just changed elsewhere.", 412);
      files.set(url, { data, etag: `"${++version}"` });
    },
    async remove(url, etag) {
      calls.push(`DELETE ${url} ${etag}`);
      if (files.get(url)?.etag !== etag) throw new DavError("The event was just changed elsewhere.", 412);
      files.delete(url);
    },
  };
  return { api, files, calls };
}

const range = (from: string, to: string, limit = 50) => ({ from: new Date(from).toISOString(), to: new Date(to).toISOString(), limit });

describe("iCloud calendar (D54)", () => {
  let server: ReturnType<typeof fakeServer>;
  let calendar: ReturnType<typeof caldavCalendar>;
  beforeEach(() => {
    server = fakeServer();
    calendar = caldavCalendar(server.api, { account: ACCOUNT, writeCalendarUrl: HOME });
  });

  it("creates an event in Alex's wall time and reads it back with the right instant", async () => {
    const entry = await calendar.create({ title: "Zahnarzt", start: "2026-10-15T08:30:00", end: "2026-10-15T09:15:00", location: "Musterstadt" });
    expect(entry).toMatchObject({ title: "Zahnarzt", start: "2026-10-15T06:30:00.000Z", end: "2026-10-15T07:15:00.000Z", location: "Musterstadt", guests: [], organizerSelf: true });
    const [url, file] = [...server.files.entries()][0]!;
    expect(url.startsWith(HOME)).toBe(true);
    expect(file.data).toContain("DTSTART;TZID=Europe/Berlin:20261015T083000");
    expect(file.data).toContain("BEGIN:VTIMEZONE");
    expect(server.calls[0]).toMatch(/ new$/);
    const { entries } = await calendar.list(range("2026-10-15T00:00:00Z", "2026-10-16T00:00:00Z"));
    expect(entries).toEqual([entry]);
  });

  it("creates a series as one file and reads every event individually, also across the clock change", async () => {
    await calendar.create({
      title: "Nordwind Consulting",
      start: "2026-10-19T08:30:00",
      end: "2026-10-19T17:00:00",
      repeat: { weekdays: ["mo", "di", "mi", "do", "fr"], until: "2026-10-26" },
    });
    expect(server.files.size).toBe(1);
    const { entries } = await calendar.list(range("2026-10-18T00:00:00Z", "2026-10-31T00:00:00Z"));
    expect(entries.map((entry) => entry.start)).toEqual([
      "2026-10-19T06:30:00.000Z",
      "2026-10-20T06:30:00.000Z",
      "2026-10-21T06:30:00.000Z",
      "2026-10-22T06:30:00.000Z",
      "2026-10-23T06:30:00.000Z",
      // After 25 Oct standard time: 08:30 Berlin is 07:30 UTC.
      "2026-10-26T07:30:00.000Z",
    ]);
    expect(new Set(entries.map((entry) => entry.id)).size).toBe(6);
  });

  it("changes only one event of a series and leaves the others", async () => {
    await calendar.create({ title: "Nordwind", start: "2026-10-06T15:00:00", end: "2026-10-06T17:30:00", repeat: { weekdays: ["di", "mi", "do", "fr"], until: "2026-10-09" } });
    const before = (await calendar.list(range("2026-10-05T00:00:00Z", "2026-10-10T00:00:00Z"))).entries;
    const thursday = before[2]!;
    const updated = await calendar.update(thursday.id, { start: "2026-10-08T16:00:00", end: "2026-10-08T18:00:00", location: "Frankfurt" }, false);
    expect(updated).toMatchObject({ id: thursday.id, start: "2026-10-08T14:00:00.000Z", location: "Frankfurt" });
    const after = (await calendar.list(range("2026-10-05T00:00:00Z", "2026-10-10T00:00:00Z"))).entries;
    expect(after.map((entry) => [entry.start, entry.location])).toEqual([
      ["2026-10-06T13:00:00.000Z", ""],
      ["2026-10-07T13:00:00.000Z", ""],
      ["2026-10-08T14:00:00.000Z", "Frankfurt"],
      ["2026-10-09T13:00:00.000Z", ""],
    ]);
    expect(await calendar.get(thursday.id)).toMatchObject({ location: "Frankfurt" });
    // Written with the ETag that was read.
    expect(server.calls.at(-1)).toMatch(/PUT .* "1"$/);
  });

  it("deletes an event of a series by EXDATE, a single one by DELETE", async () => {
    await calendar.create({ title: "Nordwind", start: "2026-10-06T15:00:00", end: "2026-10-06T17:30:00", repeat: { weekdays: ["di", "mi", "do", "fr"], until: "2026-10-09" } });
    const series = (await calendar.list(range("2026-10-05T00:00:00Z", "2026-10-10T00:00:00Z"))).entries;
    await calendar.remove(series[1]!.id, false);
    const left = (await calendar.list(range("2026-10-05T00:00:00Z", "2026-10-10T00:00:00Z"))).entries;
    expect(left.map((entry) => entry.start.slice(0, 10))).toEqual(["2026-10-06", "2026-10-08", "2026-10-09"]);
    expect(await calendar.get(series[1]!.id)).toBeNull();
    expect([...server.files.values()][0]!.data).toContain("EXDATE;TZID=Europe/Berlin:20261007T150000");

    const single = await calendar.create({ title: "Zahnarzt", start: "2026-10-15T08:30:00", end: "2026-10-15T09:15:00" });
    await calendar.remove(single.id, false);
    expect(server.calls.at(-1)).toMatch(/^DELETE /);
    expect(await calendar.get(single.id)).toBeNull();
  });

  it("reads all calendars, writes only into the chosen one", async () => {
    server.files.set(`${WORK}invite.ics`, {
      etag: '"w1"',
      data: [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "BEGIN:VEVENT",
        "UID:invite-1",
        "DTSTAMP:20261001T100000Z",
        "DTSTART:20261007T080000Z",
        "DTEND:20261007T090000Z",
        "SUMMARY:Onboarding",
        "ORGANIZER:mailto:chefin@example.com",
        `ATTENDEE;PARTSTAT=ACCEPTED:mailto:${ACCOUNT}`,
        "ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:kollege@example.com",
        "END:VEVENT",
        "END:VCALENDAR",
      ].join("\r\n"),
    });
    await calendar.create({ title: "Eigenes", start: "2026-10-07T12:00:00", end: "2026-10-07T13:00:00" });
    const { entries } = await calendar.list(range("2026-10-07T00:00:00Z", "2026-10-08T00:00:00Z"));
    expect(entries.map((entry) => entry.title)).toEqual(["Onboarding", "Eigenes"]);
    expect(entries[0]).toMatchObject({ guests: ["kollege@example.com"], organizerSelf: false, declined: false });
    expect([...server.files.keys()].filter((url) => url.startsWith(WORK))).toEqual([`${WORK}invite.ics`]);
  });

  it("skips a broken file instead of losing the other events", async () => {
    server.files.set(`${HOME}kaputt.ics`, { etag: '"x"', data: "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART:kaputt\r\n" });
    server.files.set(`${HOME}leer.ics`, { etag: '"y"', data: "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR" });
    await calendar.create({ title: "Bleibt", start: "2026-10-07T12:00:00", end: "2026-10-07T13:00:00" });
    const { entries } = await calendar.list(range("2026-10-07T00:00:00Z", "2026-10-08T00:00:00Z"));
    expect(entries.map((entry) => entry.title)).toEqual(["Bleibt"]);
  });

  it("overwrites no change from the iPhone: a stale ETag fails visibly", async () => {
    const entry = await calendar.create({ title: "Zahnarzt", start: "2026-10-15T08:30:00", end: "2026-10-15T09:15:00" });
    const real = server.api.get;
    // Between reading and writing, Alex changes the event on the iPhone.
    server.api.get = async (url) => {
      const object = await real(url);
      server.files.set(url, { ...server.files.get(url)!, etag: '"iphone"' });
      return object;
    };
    const failed = await calendar.update(entry.id, { title: "Zahnarzt Dr. B" }, false).catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(CalendarError);
    expect((failed as Error).message).toContain("changed elsewhere");
    expect([...server.files.values()][0]!.data).not.toContain("Dr. B");
  });

  it("writes into the named calendar, else into the default, and guesses no name", async () => {
    const work = await calendar.create({ title: "Nordwind", start: "2026-10-06T15:00:00", end: "2026-10-06T17:30:00", calendar: "arbeit" });
    expect(work.calendar).toBe("Arbeit");
    const own = await calendar.create({ title: "Laufen", start: "2026-10-06T19:00:00", end: "2026-10-06T20:00:00" });
    expect(own.calendar).toBe("Privat");
    expect([...server.files.keys()].map((url) => url.startsWith(WORK))).toEqual([true, false]);
    await expect(calendar.create({ title: "x", start: "2026-10-06T19:00:00", end: "2026-10-06T20:00:00", calendar: "Uni" })).rejects.toThrow(/Available: Privat, Arbeit/);
    expect(await calendar.targets!()).toEqual({ names: ["Privat", "Arbeit"], fallback: "Privat" });
    const { entries } = await calendar.list(range("2026-10-06T00:00:00Z", "2026-10-07T00:00:00Z"));
    expect(entries.map((entry) => entry.calendar)).toEqual(["Arbeit", "Privat"]);
  });

  it("invites no guests", async () => {
    await expect(calendar.create({ title: "Sync", start: "2026-10-15T08:30:00", end: "2026-10-15T09:00:00", guests: ["anna@example.org"] })).rejects.toThrow(/invitations/);
    expect(server.files.size).toBe(0);
  });

  it("names itself in English for the model and tells the owner the way back in their language", () => {
    expect(calendar.label).toBe("Alex's iCloud calendar");
    expect(calendar.provider).toBe("icloud");
    expect(calendar.deleteUndo).toBe("Zur Not holst du auf icloud.com unter Datenwiederherstellung einen früheren Stand des Kalenders.");
  });

  it("accepts only IDs that point to an .ics file", () => {
    expect(decodeId(encodeId("/1234/calendars/home/A.ics", "20261007T130000Z"))).toEqual({ path: "/1234/calendars/home/A.ics", rid: "20261007T130000Z" });
    expect(decodeId(encodeId("/1234/calendars/home/../../x.ics", null))).toBeNull();
    expect(decodeId(encodeId("/1234/calendars/home/", null))).toBeNull();
    expect(decodeId(encodeId("/1234/a.ics", "morgen"))).toBeNull();
    expect(decodeId("nicht-base64!")).toBeNull();
  });
});

describe("iCloud access", () => {
  it("sends the password only to iCloud", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 404 }));
    const dav = iCloudDav({ user: ACCOUNT, password: "abcd-efgh-ijkl-mnop" }, fetchImpl as unknown as typeof fetch);
    await expect(dav.get("https://evil.example.com/1234/calendars/home/a.ics")).rejects.toThrow(/not an iCloud server/);
    await expect(dav.get("http://p42-caldav.icloud.com/a.ics")).rejects.toThrow(/not an iCloud server/);
    await expect(dav.get("https://icloud.com.evil.example/a.ics")).rejects.toThrow(/not an iCloud server/);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await dav.get(`${HOME}a.ics`)).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("says login when iCloud rejects the password, so health reads it as a login problem", async () => {
    const { failureKind } = await import("../src/health/integrations.js");
    const fetchImpl = vi.fn(async () => new Response("", { status: 401 }));
    const dav = iCloudDav({ user: ACCOUNT, password: "abcd-efgh-ijkl-mnop" }, fetchImpl as unknown as typeof fetch);
    const error: Error = await dav.get(`${HOME}a.ics`).then(() => new Error("no error"), (caught: Error) => caught);
    expect(error.message).toBe("iCloud rejects the login. Alex has to reconnect the access (pnpm integration connect icloud).");
    expect(failureKind(error.message)).toBe("auth");
  });
});

describe("calendar tools with iCloud", () => {
  const turn = () => new TurnState({ origin: "owner_message", triggerExternalId: "x", triggerMessageId: "m", reactableIds: [] });

  function setup() {
    const server = fakeServer();
    const calendar = caldavCalendar(server.api, { account: ACCOUNT, writeCalendarUrl: HOME });
    const previews: string[] = [];
    const gate = {
      covered: async () => false,
      request: async (def: ToolDefinition, _level: string, args: Record<string, unknown>) => {
        previews.push(await def.confirm!.preview(args));
        return { ok: true, text: "waiting for Alex" };
      },
    };
    return { server, previews, registry: new ToolRegistry(gate).registerAll(calendarTools(calendar, { names: ["Privat", "Arbeit"], fallback: "Privat" })) };
  }

  it("creates two weeks of working hours in two calls", async () => {
    const { registry, server } = setup();
    const first = await registry.execute(
      "calendar_create",
      { title: "Nordwind Consulting", start: "2026-10-06 15:00", end: "2026-10-06 17:30", repeat: { weekdays: ["di", "mi", "do", "fr"], until: "2026-10-09" } },
      turn(),
    );
    expect(first.ok).toBe(true);
    expect(first.text).toContain("4 events, Tue, Wed, Thu, Fri until 2026-10-09");
    const second = await registry.execute(
      "calendar_create",
      { title: "Nordwind Consulting", start: "2026-10-12 08:30", end: "2026-10-12 17:00", repeat: { weekdays: ["mo", "di", "mi", "do", "fr"], until: "2026-10-16" } },
      turn(),
    );
    expect(second.text).toContain("5 events");
    expect(server.files.size).toBe(2);
    const listed = await registry.execute("calendar_events", { from: "2026-10-05", to: "2026-10-18" }, turn());
    expect(listed.text.match(/Nordwind Consulting/g)).toHaveLength(9);
  });

  it("names the calendars to the model and creates in the chosen one", async () => {
    const { registry, server } = setup();
    const create = registry.get("calendar_create")!;
    expect(create.description).toContain("Privat, Arbeit");
    const result = await registry.execute("calendar_create", { title: "Nordwind Consulting", start: "2026-10-06 15:00", end: "2026-10-06 17:30", calendar: "Arbeit" }, turn());
    expect(result.text).toContain("(calendar Arbeit)");
    expect([...server.files.keys()][0]!.startsWith(WORK)).toBe(true);
    const listed = await registry.execute("calendar_events", { from: "2026-10-06", to: "2026-10-06" }, turn());
    expect(listed.text).toContain("{calendar Arbeit}");
  });

  it("rejects a series whose start is on none of its weekdays", async () => {
    const { registry, server } = setup();
    const result = await registry.execute(
      "calendar_create",
      { title: "Vorlesung", start: "2026-10-20 10:00", repeat: { weekdays: ["mo"], until: "2026-12-31" } },
      turn(),
    );
    expect(result.ok).toBe(false);
    expect(result.text).toContain("not on any of the weekdays");
    expect(server.files.size).toBe(0);
  });

  it("rejects guests without sending Alex a preview", async () => {
    const { registry, previews, server } = setup();
    const result = await registry.execute("calendar_create", { title: "Sync", start: "2026-10-15 08:30", guests: ["anna@example.org"] }, turn());
    expect(result.ok).toBe(false);
    expect(result.text).toContain("does not invite guests");
    expect(previews).toEqual([]);
    expect(server.files.size).toBe(0);
  });

  it("names the ID as its own handle, so it stays unshortened in the history (live finding 2026-10-13)", async () => {
    const { registry, server } = setup();
    auditMock.mockClear();
    const created = await registry.execute("calendar_create", { title: "serainprobe", start: "2026-10-14 06:00" }, turn());
    expect(created.ok).toBe(true);
    const id = created.ref!;
    expect(id.length).toBeGreaterThan(60);
    // For this turn it stands in the first line, where the history picks up the fact.
    expect(created.text.split("\n")[0]).toMatch(new RegExp(`: Wed 14 Oct, 06:00 .*\\. ID ${id}\\.$`));
    // In the audit log as its own field, from which the history reads it.
    const call = auditMock.mock.calls.map((args) => args as unknown[]).find((args) => args[0] === "tool_call");
    expect(call?.[1]).toMatchObject({ tool: "calendar_create", ref: id });
    // With exactly this handle the next turn deletes the event, without asking, because Alex names it.
    const next = new TurnState({ origin: "owner_message", triggerExternalId: "y", triggerMessageId: "n", reactableIds: [], ownerWords: "lösch serainprobe wieder" });
    const removed = await registry.execute("calendar_delete", { event_id: id, current_title: "serainprobe", has_guests: false }, next);
    expect(removed.ok).toBe(true);
    expect(server.files.size).toBe(0);
  });

  it("does not touch an invitation from someone else", async () => {
    const { registry, server } = setup();
    server.files.set(`${WORK}invite.ics`, {
      etag: '"w1"',
      data: ["BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VEVENT", "UID:i", "DTSTAMP:20261001T100000Z", "DTSTART:20261007T080000Z", "DTEND:20261007T090000Z", "SUMMARY:Onboarding", "ORGANIZER:mailto:chefin@example.com", `ATTENDEE:mailto:${ACCOUNT}`, "END:VEVENT", "END:VCALENDAR"].join("\r\n"),
    });
    const id = encodeId("/1234/calendars/work/invite.ics", null);
    const result = await registry.execute("calendar_update", { event_id: id, current_title: "Onboarding", has_guests: false, location: "Büro" }, turn());
    expect(result.ok).toBe(false);
    expect(result.text).toContain("others depend on");
    expect(server.files.get(`${WORK}invite.ics`)!.etag).toBe('"w1"');
  });
});

describe("VTIMEZONE from the owner's time zone", () => {
  it("writes the same rules for Europe/Berlin that Apple sends along", async () => {
    const { buildVTimezone } = await import("../src/calendar/vtimezone.js");
    const text = buildVTimezone("Europe/Berlin", 2026);
    expect(text.split("\r\n")).toEqual([
      "BEGIN:VTIMEZONE",
      "TZID:Europe/Berlin",
      "BEGIN:DAYLIGHT",
      "TZOFFSETFROM:+0100",
      "TZOFFSETTO:+0200",
      "DTSTART:19700329T020000",
      "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU",
      "END:DAYLIGHT",
      "BEGIN:STANDARD",
      "TZOFFSETFROM:+0200",
      "TZOFFSETTO:+0100",
      "DTSTART:19701025T030000",
      "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU",
      "END:STANDARD",
      "END:VTIMEZONE",
    ]);
  });

  it("knows the nth weekday, the southern hemisphere and zones without daylight saving time", async () => {
    const { buildVTimezone } = await import("../src/calendar/vtimezone.js");
    const newYork = buildVTimezone("America/New_York", 2026);
    expect(newYork).toContain("DTSTART:19700308T020000\r\nRRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU");
    expect(newYork).toContain("DTSTART:19701101T020000\r\nRRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU");
    const sydney = buildVTimezone("Australia/Sydney", 2026);
    expect(sydney).toContain("BEGIN:STANDARD\r\nTZOFFSETFROM:+1100\r\nTZOFFSETTO:+1000\r\nDTSTART:19700405T030000\r\nRRULE:FREQ=YEARLY;BYMONTH=4;BYDAY=1SU");
    expect(buildVTimezone("Asia/Kolkata", 2026)).toContain("BEGIN:STANDARD\r\nTZOFFSETFROM:+0530\r\nTZOFFSETTO:+0530\r\nDTSTART:19700101T000000\r\nEND:STANDARD");
  });

  it("reads the same instants with its own definition as the runtime, also across the transition", async () => {
    const ICAL = (await import("ical.js")).default;
    const { buildVTimezone } = await import("../src/calendar/vtimezone.js");
    for (const zone of ["America/New_York", "Australia/Sydney", "Asia/Kolkata", "America/Santiago"]) {
      const tz = new ICAL.Timezone(new ICAL.Component(ICAL.parse(buildVTimezone(zone, 2026)) as unknown[]));
      for (const day of ["2026-01-15", "2026-04-10", "2026-07-15", "2026-11-20", "2027-03-20"]) {
        const time = ICAL.Time.fromDateTimeString(`${day}T09:00:00`);
        time.zone = tz;
        const wall = new Intl.DateTimeFormat("en-CA", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
          .format(time.toJSDate())
          .replace(", ", "T");
        expect(wall, `${zone} ${day}`).toBe(`${day}T09:00`);
      }
    }
  });
});
