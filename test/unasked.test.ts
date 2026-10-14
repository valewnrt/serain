import { beforeEach, describe, expect, it, vi } from "vitest";

const audits: Array<{ event: string; detail: Record<string, unknown> }> = [];
vi.mock("../src/db/audit.js", () => ({
  audit: async (event: string, detail: Record<string, unknown> = {}) => void audits.push({ event, detail }),
}));

const { namesDay, mentionsBirthday, untilLabel } = await import("../src/security/unasked.js");
const { scheduleTools } = await import("../src/agent/tools/schedule.js");
const { watchTools } = await import("../src/agent/tools/watch.js");
const { ToolRegistry } = await import("../src/agent/tools/registry.js");
const { TurnState } = await import("../src/agent/tools/types.js");
const { ConfidentialGuard } = await import("../src/security/confidential.js");
const { pickPlaybooks } = await import("../src/agent/playbooks.js");
const { FakeScheduleStore } = await import("./schedule-store.fake.js");
type WatcherRow = import("../src/watch/types.js").WatcherRow;
type WatcherStore = import("../src/watch/types.js").WatcherStore;
type TurnOrigin = import("../src/agent/tools/types.js").TurnOrigin;

/**
 * Creating unasked (addendum D62 of 2026-10-10): yearly reminder for a
 * birthday, mail watcher with a deadline. Only from Alex's own message, with
 * the day in their words; never from foreign content. All names are made up.
 * Owner messages are German and English test data; other languages only
 * count through digits and 🎂 (fail closed).
 */

// Friday, 2026-10-09, 10:00 in Berlin.
const NOW = new Date("2026-10-09T08:00:00Z");

beforeEach(() => void (audits.length = 0));

function turn(ownerWords: string, options: { origin?: TurnOrigin; taint?: string[]; followUp?: boolean } = {}) {
  return new TurnState({
    origin: options.origin ?? "owner_message",
    triggerExternalId: "m-1",
    triggerMessageId: "db-1",
    reactableIds: ["m-1"],
    ownerWords,
    ...(options.taint ? { taintSources: options.taint } : {}),
    ...(options.followUp ? { followUp: true } : {}),
  });
}

describe("does Alex's text prove the day?", () => {
  it("recognises date, month names, ISO, today/tomorrow/the day after and weekdays (German)", () => {
    expect(namesDay("anna hat am 14.3. geburtstag", "2027-03-14", NOW, true)).toBe(true);
    expect(namesDay("anna hat am 14.03 geburtstag", "2027-03-14", NOW, true)).toBe(true);
    expect(namesDay("anna hat am 14. März geburtstag", "2027-03-14", NOW, true)).toBe(true);
    expect(namesDay("anna hat am 14ten maerz geburtstag", "2027-03-14", NOW, true)).toBe(true);
    expect(namesDay("geburtstag 2027-03-14", "2027-03-14", NOW, true)).toBe(true);
    expect(namesDay("ben hat morgen geburtstag", "2027-10-10", NOW, true)).toBe(true);
    expect(namesDay("ben hat heute geburtstag", "2027-10-09", NOW, true)).toBe(true);
    expect(namesDay("die versicherung meldet sich bis freitag", "2026-10-16", NOW, false)).toBe(true);
    expect(namesDay("die versicherung meldet sich bis übermorgen", "2026-10-11", NOW, false)).toBe(true);
    expect(namesDay("die versicherung meldet sich bis zum 16.10.", "2026-10-16", NOW, false)).toBe(true);
  });

  it("proves nothing that is not there", () => {
    // Another day, another number, a time instead of a date.
    expect(namesDay("anna hat am 14.3. geburtstag", "2027-03-15", NOW, true)).toBe(false);
    expect(namesDay("anna hat am 4.3. geburtstag", "2027-03-14", NOW, true)).toBe(false);
    expect(namesDay("treffen um 14.30", "2027-03-14", NOW, true)).toBe(false);
    expect(namesDay("anna hat bald geburtstag", "2027-03-14", NOW, true)).toBe(false);
    // "bis freitag" does not mean the Friday in three weeks, and "morgens" is not "morgen".
    expect(namesDay("meldet sich bis freitag", "2026-10-30", NOW, false)).toBe(false);
    expect(namesDay("meldet sich morgens", "2026-10-10", NOW, false)).toBe(false);
    expect(namesDay("meldet sich bis ende der woche", "2026-10-16", NOW, false)).toBe(false);
    expect(namesDay("", "2026-10-16", NOW, false)).toBe(false);
  });

  it("recognises the birthday by the word", () => {
    expect(mentionsBirthday("anna hat am 14.3. Geburtstag")).toBe(true);
    expect(mentionsBirthday("annas bday ist am 14.3.")).toBe(true);
    expect(mentionsBirthday("anna hat am 14.3. jahrestag")).toBe(false);
    expect(mentionsBirthday("ich hab am 14.3. einen termin")).toBe(false);
  });

  it("recognises the same in English", () => {
    expect(namesDay("anna's birthday is on March 14", "2027-03-14", NOW, true)).toBe(true);
    expect(namesDay("anna's birthday is on the 14th of march", "2027-03-14", NOW, true)).toBe(true);
    expect(namesDay("anna's bday: 14 Mar", "2027-03-14", NOW, true)).toBe(true);
    expect(namesDay("it's ben's birthday tomorrow", "2027-10-10", NOW, true)).toBe(true);
    expect(namesDay("the insurance will get back to me by friday", "2026-10-16", NOW, false)).toBe(true);
    expect(namesDay("they'll reply the day after tomorrow", "2026-10-11", NOW, false)).toBe(true);
    // Unambiguous slash dates in either order; "3/4" could be either and proves nothing.
    expect(namesDay("anna's birthday 3/14", "2027-03-14", NOW, true)).toBe(true);
    expect(namesDay("anna's birthday 14/3", "2027-03-14", NOW, true)).toBe(true);
    expect(namesDay("anna's birthday 3/4", "2027-04-03", NOW, true)).toBe(false);
    expect(namesDay("anna's birthday 3/4", "2027-03-04", NOW, true)).toBe(false);
    // Not there: another day, a time, "mornings", the end of the week, a three-letter word.
    expect(namesDay("anna's birthday is on March 15", "2027-03-14", NOW, true)).toBe(false);
    expect(namesDay("meeting at march 14:30", "2027-03-14", NOW, true)).toBe(false);
    expect(namesDay("they call mornings", "2026-10-10", NOW, false)).toBe(false);
    expect(namesDay("they'll reply by the end of the week", "2026-10-16", NOW, false)).toBe(false);
    expect(namesDay("enjoy the sun", "2026-10-11", NOW, false)).toBe(false);
    expect(mentionsBirthday("it's anna's birthday on March 14")).toBe(true);
    expect(mentionsBirthday("anna's b-day")).toBe(true);
    expect(mentionsBirthday("anna's anniversary on March 14")).toBe(false);
  });

  it("counts only digits and 🎂 in a language without built-in words (fail closed)", () => {
    // Turkish: numeric and ISO dates prove the day, month and weekday names do not.
    expect(namesDay("ayşe'nin doğum günü 14.3.", "2027-03-14", NOW, true)).toBe(true);
    expect(namesDay("ayşe'nin doğum günü 2027-03-14", "2027-03-14", NOW, true)).toBe(true);
    expect(namesDay("ayşe'nin doğum günü 14 mart", "2027-03-14", NOW, true)).toBe(false);
    expect(namesDay("sigorta cuma günü dönecek", "2026-10-16", NOW, false)).toBe(false);
    expect(namesDay("sigorta yarın dönecek", "2026-10-10", NOW, false)).toBe(false);
    // The birthday word is not recognised; the emoji is, in every language.
    expect(mentionsBirthday("ayşe'nin doğum günü 14.3.")).toBe(false);
    expect(mentionsBirthday("ayşe 14.3. 🎂")).toBe(true);
  });

  it("names the deadline for the model's example sentence", () => {
    expect(untilLabel("2026-10-16", NOW)).toBe("16 Oct");
    expect(untilLabel("2026-10-14", NOW)).toBe("wednesday");
    expect(untilLabel("2026-10-10", NOW)).toBe("tomorrow");
    expect(untilLabel("2026-10-09", NOW)).toBe("today");
  });
});

describe("playbook \"von selbst\" (unasked)", () => {
  const ids = (text: string) => pickPlaybooks(text).map((playbook) => playbook.id);
  it("comes with a birthday and an announced reply, otherwise not", () => {
    expect(ids("anna hat am 14.3. geburtstag")).toEqual(["von-selbst"]);
    expect(ids("die versicherung meldet sich bis freitag")).toEqual(["von-selbst", "recherche-tiefe"]);
    expect(ids("der vermieter wollte mir bis montag bescheid geben")).toContain("von-selbst");
    expect(ids("bis später")).toEqual([]);
    expect(ids("meld dich mal")).toEqual([]);
    expect(ids("trag mir morgen 10 Uhr Zahnarzt ein")).toEqual([]);
  });
});

describe("set_reminder with unasked: yearly for a birthday", () => {
  function rig() {
    const store = new FakeScheduleStore();
    const registry = new ToolRegistry().registerAll(scheduleTools({ store, now: () => NOW, busyAt: () => null }));
    return { store, registry };
  }
  const BIRTHDAY = { text: "anna hat heute geburtstag", at: "2027-03-14 09:00", repeat: "yearly", unasked: true };
  const WORDS = "anna hat am 14.3. geburtstag";

  it("creates it from Alex's own message and says how they learn about it", async () => {
    const { store, registry } = rig();
    const result = await registry.execute("set_reminder", BIRTHDAY, turn(WORDS));
    expect(result.ok).toBe(true);
    expect(result.text).toContain('"i\'ll remind you every year on 14 Mar"');
    expect(result.text).toContain("no ⏰");
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]?.repeat).toBe("yearly");
    expect(audits).toContainEqual({ event: "schedule_created", detail: expect.objectContaining({ unasked: true, repeat: "yearly" }) });
  });

  it("creates nothing when the turn has read foreign content, and catches up in the clean turn", async () => {
    const { store, registry } = rig();
    // First the owner's message, then the turn reads a mail (mail_read sets the taint).
    const tainted = turn(WORDS, { followUp: true });
    tainted.taint("mail from anna@example.com");
    const result = await registry.execute("set_reminder", BIRTHDAY, tainted);
    expect(result.ok).toBe(false);
    expect(tainted.deferred).toEqual(["set_reminder"]);
    expect(store.rows).toHaveLength(0);
    expect(audits).toContainEqual({ event: "tool_denied", detail: { tool: "set_reminder", reason: "turn_tainted", unasked: true } });
  });

  it("creates nothing in turns Alex did not trigger (mail, task, heartbeat, schedule)", async () => {
    const { store, registry } = rig();
    for (const origin of ["untrusted", "task", "heartbeat", "schedule", "approval", "owner_reaction"] as const) {
      const result = await registry.execute("set_reminder", BIRTHDAY, turn(WORDS, { origin }));
      expect(result.ok).toBe(false);
    }
    expect(store.rows).toHaveLength(0);
  });

  it("creates nothing when the day is not in Alex's words (say from a mail in the history)", async () => {
    const { store, registry } = rig();
    for (const words of ["was schreibt anna?", "anna hat bald geburtstag", "anna hat am 15.3. geburtstag", "ich hab am 14.3. einen termin bei anna"]) {
      const result = await registry.execute("set_reminder", BIRTHDAY, turn(words));
      expect(result.ok).toBe(false);
      expect(result.text).toContain("names a birthday with its day");
    }
    expect(store.rows).toHaveLength(0);
  });

  it("creates only yearly ones on its own", async () => {
    const { store, registry } = rig();
    const { repeat: _yearly, ...once } = BIRTHDAY;
    expect((await registry.execute("set_reminder", once, turn(WORDS))).ok).toBe(false);
    expect((await registry.execute("set_reminder", { ...BIRTHDAY, repeat: "monthly" }, turn(WORDS))).ok).toBe(false);
    expect(store.rows).toHaveLength(0);
  });

  it("creates no second one for the same person, but one for another person on the same day", async () => {
    const { store, registry } = rig();
    await registry.execute("set_reminder", BIRTHDAY, turn(WORDS));
    const again = await registry.execute("set_reminder", { ...BIRTHDAY, text: "heute hat anna geburtstag" }, turn(WORDS));
    expect(again.ok).toBe(true);
    expect(again.text).toContain("Nothing created");
    expect(store.rows).toHaveLength(1);
    const other = await registry.execute("set_reminder", { ...BIRTHDAY, text: "ben hat heute geburtstag" }, turn("ben hat auch am 14.3. geburtstag"));
    expect(other.ok).toBe(true);
    expect(store.rows).toHaveLength(2);
  });

  it("puts no self-chosen time in the middle of an event", async () => {
    const store = new FakeScheduleStore();
    const busy = { start: new Date("2027-03-14T07:30:00Z"), end: new Date("2027-03-14T09:00:00Z") };
    const registry = new ToolRegistry().registerAll(scheduleTools({ store, now: () => NOW, busyAt: () => busy }));
    const result = await registry.execute("set_reminder", BIRTHDAY, turn(WORDS));
    expect(result.ok).toBe(false);
    expect(result.text).toContain("falls in an event");
    expect(store.rows).toHaveLength(0);
  });

  it("leaves reminders Alex asks for as they are", async () => {
    const { store, registry } = rig();
    const asked = await registry.execute("set_reminder", { text: "müll raus", at: "2026-10-10 19:00" }, turn("erinner mich morgen an den müll", { taint: ["https://abfall.example"] }));
    expect(asked.ok).toBe(true);
    expect(store.rows).toHaveLength(1);
  });
});

describe("watch_create with unasked: mail watcher with a deadline", () => {
  function memoryStore() {
    const rows: WatcherRow[] = [];
    const store: WatcherStore = {
      async insert(input) {
        const row: WatcherRow = {
          id: `00000000-0000-4000-8000-${String(rows.length + 1).padStart(12, "0")}`,
          kind: input.kind,
          label: input.label,
          spec: structuredClone(input.spec),
          state: structuredClone(input.state),
          status: "active",
          nextCheckAt: input.nextCheckAt,
          lastCheckedAt: null,
          failures: 0,
          expiresAt: input.expiresAt,
          createdAt: NOW.toISOString(),
        };
        rows.push(row);
        return structuredClone(row);
      },
      active: async () => rows.filter((row) => row.status === "active").map((row) => structuredClone(row)),
      countActive: async () => rows.filter((row) => row.status === "active").length,
      due: async () => [],
      claim: async () => false,
      update: async () => false,
      cancel: async () => false,
    };
    return { store, rows };
  }
  function rig() {
    const { store, rows } = memoryStore();
    const registry = new ToolRegistry().registerAll(
      watchTools({ store, confidential: async () => ConfidentialGuard.from([]), now: () => NOW }),
    );
    return { rows, registry };
  }
  const WATCH = { kind: "mail_arrives", label: "Antwort der Versicherung", from: "musterversicherung", report_if_none: true, until: "2026-10-16 18:00", unasked: true };
  const WORDS = "die versicherung meldet sich bis freitag";

  it("creates it from Alex's own message, without tapback, with half a sentence", async () => {
    const { rows, registry } = rig();
    const result = await registry.execute("watch_create", WATCH, turn(WORDS));
    expect(result.ok).toBe(true);
    expect(result.text).toContain('"i\'ll let you know if nothing comes by 16 Oct"');
    expect(result.text).not.toContain("Set watching");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.spec).toEqual({ from: "musterversicherung", report_if_none: true });
    expect(audits).toContainEqual({ event: "watcher", detail: expect.objectContaining({ action: "created", unasked: true, report_if_none: true }) });
  });

  it("creates nothing after foreign content or in turns Alex did not trigger", async () => {
    const { rows, registry } = rig();
    expect((await registry.execute("watch_create", WATCH, turn(WORDS, { taint: ["mail from service@musterversicherung.example"] }))).ok).toBe(false);
    for (const origin of ["untrusted", "task", "heartbeat", "schedule"] as const) {
      expect((await registry.execute("watch_create", WATCH, turn(WORDS, { origin }))).ok).toBe(false);
    }
    expect(rows).toHaveLength(0);
  });

  it("creates nothing when Alex does not name the day themselves (in the clean follow-up turn too)", async () => {
    const { rows, registry } = rig();
    const result = await registry.execute("watch_create", WATCH, turn("was schreibt die versicherung?"));
    expect(result.ok).toBe(false);
    expect(result.text).toContain("names the day in their message themselves");
    expect(audits).toContainEqual({ event: "tool_denied", detail: { tool: "watch_create", reason: "unasked_not_named", unasked: true } });
    expect(rows).toHaveLength(0);
  });

  it("exists unasked only as a mail watcher with report_if_none and until", async () => {
    const { rows, registry } = rig();
    expect((await registry.execute("watch_create", { ...WATCH, report_if_none: false }, turn(WORDS))).ok).toBe(false);
    const { until: _until, ...withoutUntil } = WATCH;
    expect((await registry.execute("watch_create", { ...withoutUntil, days: 7 }, turn(WORDS))).ok).toBe(false);
    expect(
      (
        await registry.execute(
          "watch_create",
          { kind: "quote", label: "BTC", asset: "crypto", symbol: "BTC", currency: "EUR", compare: "below", threshold: 1, until: "2026-10-16 18:00", unasked: true },
          turn(WORDS),
        )
      ).ok,
    ).toBe(false);
    expect(rows).toHaveLength(0);
  });

  it("creates no second one for the same sender", async () => {
    const { rows, registry } = rig();
    await registry.execute("watch_create", WATCH, turn(WORDS));
    const again = await registry.execute("watch_create", { ...WATCH, from: "MusterVersicherung" }, turn(WORDS));
    expect(again.ok).toBe(true);
    expect(again.text).toContain("Nothing created");
    expect(rows).toHaveLength(1);
  });
});
