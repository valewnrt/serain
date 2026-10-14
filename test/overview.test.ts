import { describe, expect, it, vi } from "vitest";
import { FakeScheduleStore } from "./schedule-store.fake.js";
import type { WatcherRow, WatcherStore } from "../src/watch/types.js";
import type { MorningOutlook } from "../src/proactive/heartbeat.js";
import type { RunningTaskInfo } from "../src/agent/tools/task.js";
import type { ApprovalRow } from "../src/security/approvals.js";

vi.mock("../src/db/audit.js", () => ({ audit: async () => undefined }));

const { overviewTools } = await import("../src/agent/tools/overview.js");
const { ToolRegistry } = await import("../src/agent/tools/registry.js");
const { TurnState } = await import("../src/agent/tools/types.js");
const { atWallTime } = await import("../src/time.js");

/**
 * Overview "what is running for me" (package 2 of 2026-10-08): everything from
 * the code, with next run, cadence and end, without the model guessing anything.
 */

const NOW = atWallTime("2026-10-08", 12, 0); // Thursday

function watcher(overrides: Partial<WatcherRow>): WatcherRow {
  return {
    id: "00000000-0000-4000-8000-0000000000aa",
    kind: "url_value",
    label: "Preis der Kopfhörer unter 100 €",
    spec: { url: "https://shop.example/kopfhoerer", anchor: "Preis", compare: "below", threshold: 100 },
    state: { value: 129, display: "129,00 €" },
    status: "active",
    nextCheckAt: atWallTime("2026-10-08", 12, 30).toISOString(),
    lastCheckedAt: NOW.toISOString(),
    failures: 0,
    expiresAt: atWallTime("2026-10-22", 12, 0).toISOString(),
    createdAt: NOW.toISOString(),
    ...overrides,
  };
}

function rig(options: {
  watchers?: WatcherRow[];
  tasks?: RunningTaskInfo[];
  morning?: MorningOutlook | null;
  paused?: boolean;
  throttled?: boolean;
  approvals?: ApprovalRow[];
} = {}) {
  const schedules = new FakeScheduleStore();
  const watchers = { active: async () => options.watchers ?? [] } as unknown as WatcherStore;
  const registry = new ToolRegistry().registerAll(
    overviewTools({
      schedules,
      watchers,
      tasks: () => options.tasks ?? [],
      approvals: { scheduled: async () => options.approvals ?? [] },
      ...(options.morning ? { morning: async () => options.morning as MorningOutlook } : {}),
      paused: async () => options.paused ?? false,
      throttled: async () => options.throttled ?? false,
      now: () => NOW,
    }),
  );
  const run = async (origin: "owner_message" | "untrusted" = "owner_message") =>
    (await registry.execute("overview", {}, new TurnState({ origin, triggerExternalId: "m-1", triggerMessageId: "db-1", reactableIds: [] }))).text;
  return { schedules, run };
}

describe("overview", () => {
  it("shows reminders, tasks, watchers and morning look with next run, cadence and end", async () => {
    const { schedules, run } = rig({
      watchers: [
        watcher({}),
        watcher({
          id: "00000000-0000-4000-8000-0000000000bb",
          kind: "mail_arrives",
          label: "Antwort von Müller bis Freitag",
          spec: { from: "mueller", report_if_none: true },
          state: {},
          expiresAt: atWallTime("2026-10-09", 18, 0).toISOString(),
        }),
      ],
      tasks: [{ id: "1", task: "Hotel in Rom für zwei Nächte suchen", startedAt: new Date(NOW.getTime() - 4 * 60_000) }],
      morning: { at: atWallTime("2026-10-09", 7, 0), byEvent: true, calendar: true },
    });
    await schedules.insert({ mode: "reminder", text: "Tabletten nehmen", repeat: "daily", nextRunAt: atWallTime("2026-10-09", 8, 0).toISOString(), sourceMessageId: "db-1", taintSources: [] });
    await schedules.insert({ mode: "reminder", text: "Müll raus", repeat: "weekly", nextRunAt: atWallTime("2026-10-13", 19, 30).toISOString(), sourceMessageId: "db-1", taintSources: [] });
    await schedules.insert({ mode: "task", text: "Wetter fürs Wochenende prüfen", repeat: null, nextRunAt: atWallTime("2026-10-10", 18, 0).toISOString(), sourceMessageId: "db-1", taintSources: [] });

    const text = await run();
    expect(text).toContain('Reminders:\n- daily at 08:00, next Fri 9 Oct, 08:00, no end until cancelled: "Tabletten nehmen"');
    expect(text).toContain("- every Tuesday at 19:30, next Tue 13 Oct, 19:30");
    expect(text).toContain('Planned tasks:\n- once Sat 10 Oct, 18:00: "Wetter fürs Wochenende prüfen"');
    expect(text).toContain('Running tasks:\n- [1] for 4 min: "Hotel in Rom für zwei Nächte suchen"');
    expect(text).toContain('Preis der Kopfhörer unter 100 € | shop.example after "Preis" | every 30 min | last 129,00 € | next check Thu 8 Oct, 12:30 | end Thu 22 Oct, 12:00');
    expect(text).toContain('Antwort von Müller bis Freitag | mail from "mueller", also reports if none arrives | checks every new mail | end Fri 9 Oct, 18:00');
    expect(text).toContain("- Morning look: next Fri 9 Oct, 07:00 (30 min before the first event)");
    expect(text).toContain("Hourly look");
    // Order: reminders, tasks, watchers, then the look.
    expect(text.indexOf("Reminders:")).toBeLessThan(text.indexOf("Planned tasks:"));
    expect(text.indexOf("Watchers:")).toBeLessThan(text.indexOf("Morning look"));
  });

  it("names monthly, weekdays and yearly with day and time of the first run", async () => {
    const { schedules, run } = rig();
    await schedules.insert({ mode: "reminder", text: "Miete", repeat: "monthly", nextRunAt: atWallTime("2026-10-31", 9, 0).toISOString(), sourceMessageId: "db-1", taintSources: [] });
    await schedules.insert({ mode: "reminder", text: "Standup", repeat: "weekdays", nextRunAt: atWallTime("2026-10-09", 9, 15).toISOString(), sourceMessageId: "db-1", taintSources: [] });
    await schedules.insert({ mode: "reminder", text: "Anna hat Geburtstag", repeat: "yearly", nextRunAt: atWallTime("2027-03-14", 9, 0).toISOString(), sourceMessageId: "db-1", taintSources: [] });
    const text = await run();
    expect(text).toContain("monthly on day 31 at 09:00");
    expect(text).toContain("on weekdays at 09:15");
    expect(text).toContain("yearly on March 14 at 09:00");
  });

  it("frames text that was created after foreign content", async () => {
    const { schedules, run } = rig();
    await schedules.insert({ mode: "reminder", text: "Zug fährt 14:32", repeat: null, nextRunAt: atWallTime("2026-10-09", 14, 0).toISOString(), sourceMessageId: "db-1", taintSources: ["https://bahn.example"] });
    const text = await run();
    expect(text).not.toContain('"Zug fährt 14:32"');
    expect(text).toMatch(/derived from: https:\/\/bahn\.example/);
  });

  it("shows scheduled approvals with their time and frames a preview with origin (addendum D14 of 2026-10-08)", async () => {
    const approval = (overrides: Partial<ApprovalRow>): ApprovalRow => ({
      id: "00000000-0000-4000-8000-0000000000bb",
      tool: "mail_send",
      level: "irreversible",
      args: {},
      preview: "Mail von alex@gmx.example\nAn: hi@serain.example.com\nBetreff: Test",
      undo: "",
      grantKey: "",
      scope: "once",
      status: "scheduled",
      previewExternalId: "p-1",
      previewFileExternalIds: [],
      requestMessageId: null,
      expiresAt: NOW.toISOString(),
      executeAt: atWallTime("2026-10-09", 8, 0).toISOString(),
      laterPin: {},
      taintSources: [],
      reissuedFrom: null,
      ...overrides,
    });
    const text = await rig({ approvals: [approval({}), approval({ id: "00000000-0000-4000-8000-0000000000cc", taintSources: ["Mail von x"] })] }).run();
    expect(text).toContain("Scheduled approvals (Alex has already agreed, they run without asking again):");
    expect(text).toContain('- Fri 9 Oct, 08:00: mail_send, "Mail von alex@gmx.example An: hi@serain.example.com Betreff: Test" (ID 00000000-0000-4000-8000-0000000000bb)');
    expect(text).toMatch(/derived from: Mail von x/);
    expect(text).not.toMatch(/^No reminders/);
  });

  it("says when nothing is running, and that the kill switch stops everything", async () => {
    expect(await rig().run()).toMatch(/^No reminders, tasks or watchers\./);
    const paused = await rig({ paused: true }).run();
    expect(paused).toMatch(/^The kill switch is active.*\n\nNo reminders/);
  });

  it("shows the morning look as off while the budget is throttled", async () => {
    const text = await rig({ morning: { at: atWallTime("2026-10-09", 8, 0), byEvent: false, calendar: true }, throttled: true }).run();
    expect(text).toContain("off until the first of the month");
    expect(text).not.toContain("next Fri");
  });

  it("reports a due morning look that is waiting", async () => {
    const text = await rig({ morning: { at: atWallTime("2026-10-08", 8, 0), byEvent: false, calendar: false }, throttled: false }).run();
    expect(text).toContain("Morning look: due now");
    expect(text).toContain("no calendar read");
  });

  it("is read-only and also runs after foreign content", async () => {
    const { schedules, run } = rig();
    await schedules.insert({ mode: "reminder", text: "Pizza", repeat: null, nextRunAt: atWallTime("2026-10-08", 13, 0).toISOString(), sourceMessageId: "db-1", taintSources: [] });
    expect(await run("untrusted")).toContain('"Pizza"');
  });
});
