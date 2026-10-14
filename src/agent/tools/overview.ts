import type { ActiveMission } from "../../missions/book.js";
import type { MorningOutlook } from "../../proactive/heartbeat.js";
import type { ScheduleRow, ScheduleStore } from "../../scheduler/store.js";
import type { ApprovalRow } from "../../security/approvals.js";
import { wrapDerived } from "../../security/untrusted.js";
import { formatWallTime, type Repeat, type WallAnchor } from "../../time.js";
import type { WatcherRow, WatcherStore } from "../../watch/types.js";
import { describeRunning, type RunningTaskInfo } from "./task.js";
import { defineTool, type ToolDefinition } from "./types.js";
import { watchCadence, watchTarget } from "./watch.js";
import { owner } from "../../config/owner.js";

/**
 * "What is running for me?" (package 2 of 2026-10-08): one
 * read tool over everything Serain does in the background for the owner, each
 * with next run, cadence and end. Replaces `list_schedules` and `watch_list`;
 * two lists meant that the owner only heard half after "what's running?".
 *
 * Everything here comes from the code: times, cadences and ends are in the
 * tables or in `src/config/limits.ts`, the model guesses none of it. Text that
 * a turn with foreign content created (a reminder after a research, D15) is
 * framed as in the history (D8.4). Watcher labels and running tasks come from
 * clean turns (`watch_create`, `run_task` are `cleanTurnOnly`).
 */

export interface OverviewDeps {
  schedules: ScheduleStore;
  watchers: WatcherStore;
  /** Scheduled approvals ("yes, but tomorrow at 8", addendum D14 of 2026-10-08). */
  approvals?: { scheduled(): Promise<ApprovalRow[]> };
  /** Running background tasks of this process, with the numbers of `cancel_task`. */
  tasks(): RunningTaskInfo[];
  /** Next morning look (D46). Missing when there is no heartbeat. */
  morning?(): Promise<MorningOutlook>;
  /** Kill switch (D8.2): then none of it runs. */
  paused(): Promise<boolean>;
  /** Budget throttled (addendum D3 of 2026-10-08): heartbeat and morning look are off. */
  throttled?(): Promise<boolean>;
  /** Open missions with next look (D63, building block B). */
  missions?(): ActiveMission[];
  now?: () => Date;
}

/** Weekday and day of a wall date for the model; UTC, because the wall date is already the owner's day. */
const WEEKDAY = new Intl.DateTimeFormat("en", { weekday: "long", timeZone: "UTC" });
const MONTH_DAY = new Intl.DateTimeFormat("en", { month: "long", day: "numeric", timeZone: "UTC" });

/** The cadence of a repetition in wall time, with time and day from the meant wall time (`anchor`). */
function cadence(repeat: Repeat, wall: WallAnchor): string {
  const at = `${String(wall.hour).padStart(2, "0")}:${String(wall.minute).padStart(2, "0")}`;
  const date = new Date(Date.UTC(wall.year, wall.month - 1, wall.day));
  switch (repeat) {
    case "daily":
      return `daily at ${at}`;
    case "weekdays":
      return `on weekdays at ${at}`;
    case "weekly":
      return `every ${WEEKDAY.format(date)} at ${at}`;
    case "monthly":
      return `monthly on day ${wall.day} at ${at}`;
    case "yearly":
      return `yearly on ${MONTH_DAY.format(date)} at ${at}`;
  }
}

function scheduleLine(row: ScheduleRow): string {
  const text = row.text.replace(/\s+/g, " ").trim();
  const shown = row.taintSources.length > 0 ? wrapDerived(text, row.taintSources) : `"${text}"`;
  const when = row.repeat
    ? `${cadence(row.repeat, row.anchor)}, next ${formatWallTime(new Date(row.nextRunAt))}, no end until cancelled`
    : `once ${formatWallTime(new Date(row.nextRunAt))}`;
  return `- ${when}: ${shown} (ID ${row.id})`;
}

/** At most this much of the preview: which action, not the whole mail text. */
const PREVIEW_CHARS = 160;

function approvalLine(row: ApprovalRow): string {
  const text = row.preview.replace(/\s+/g, " ").trim();
  const clipped = text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS - 1)}…` : text;
  // A model chose the arguments; if it had seen foreign content, the preview is framed (D8.4).
  const shown = row.taintSources.length > 0 ? wrapDerived(clipped, row.taintSources) : `"${clipped}"`;
  return `- ${row.executeAt ? formatWallTime(new Date(row.executeAt)) : "later"}: ${row.tool}, ${shown} (ID ${row.id})`;
}

function watcherLine(row: WatcherRow): string {
  const parts = [row.label, watchTarget(row)];
  if (row.kind === "mail_arrives") {
    parts.push(watchCadence(row));
  } else {
    parts.push(watchCadence(row));
    if (row.state.display) parts.push(`last ${row.state.display}`);
    parts.push(
      row.state.pendingHit
        ? `hit waiting until ${formatWallTime(new Date(row.nextCheckAt))}`
        : `next check ${formatWallTime(new Date(row.nextCheckAt))}`,
    );
  }
  if (row.failures > 0) parts.push(`${row.failures} failed attempt(s) in a row`);
  parts.push(`end ${formatWallTime(new Date(row.expiresAt))}`);
  return `- ${parts.join(" | ")} (ID ${row.id})`;
}

function morningLine(outlook: MorningOutlook, now: Date): string {
  const when = outlook.at.getTime() <= now.getTime() ? "due now, runs as soon as you two are not in the middle of writing" : `next ${formatWallTime(outlook.at)}`;
  const why = outlook.byEvent
    ? "30 min before the first event"
    : outlook.calendar
      ? "no early event, at 08:00"
      : "at 08:00, no calendar read";
  return (
    `- Morning look: ${when} (${why}), daily between 06:30 and 08:00, no end. ` +
    "Only speaks up on an overlap, a deadline today or travel before 10:00, otherwise silent."
  );
}

export function overviewTools(deps: OverviewDeps): ToolDefinition[] {
  const now = deps.now ?? (() => new Date());
  return [
    defineTool({
      name: "overview",
      description:
        `Shows you everything running in the background for ${owner.name}: reminders, planned and running tasks, scheduled approvals, ` +
        "watchers and the morning look, each with next run, cadence and end. For \"what's running right now?\", " +
        "\"what have you planned for me?\" and before you cancel something (the IDs are here).",
      level: "read",
      repeatable: true,
      schema: {},
      async run() {
        const at = now();
        const [schedules, watchers, approvals, paused, throttled, morning] = await Promise.all([
          deps.schedules.active(),
          deps.watchers.active(),
          deps.approvals?.scheduled() ?? Promise.resolve([]),
          deps.paused(),
          deps.throttled?.() ?? Promise.resolve(false),
          deps.morning?.() ?? Promise.resolve(null),
        ]);
        const reminders = schedules.filter((row) => row.mode === "reminder");
        const planned = schedules.filter((row) => row.mode === "task");
        const running = deps.tasks();
        const missions = deps.missions?.() ?? [];

        const sections: string[] = [];
        if (paused) sections.push(`The kill switch is active: until ${owner.name} releases it, none of this runs.`);
        if (reminders.length > 0) sections.push(["Reminders:", ...reminders.map(scheduleLine)].join("\n"));
        if (planned.length > 0) sections.push(["Planned tasks:", ...planned.map(scheduleLine)].join("\n"));
        if (approvals.length > 0) {
          sections.push([`Scheduled approvals (${owner.name} has already agreed, they run without asking again):`, ...approvals.map(approvalLine)].join("\n"));
        }
        if (missions.length > 0) {
          sections.push(
            [
              "Missions (you stay on them and look again at the next check):",
              ...missions.map((entry) => `- ${entry.title}: ${entry.nextCheck ? `next check ${formatWallTime(new Date(entry.nextCheck))}` : "no check planned"} [${entry.id}]`),
            ].join("\n"),
          );
        }
        if (running.length > 0) {
          sections.push(["Running tasks:", ...running.map((info) => `- ${describeRunning(info, at)}`)].join("\n"));
        }
        if (watchers.length > 0) sections.push(["Watchers:", ...watchers.map(watcherLine)].join("\n"));
        if (morning) {
          sections.push(
            throttled
              ? "- Morning look and hourly look: off until the first of the month, the budget is throttled."
              : [
                  morningLine(morning, at),
                  "- Hourly look between 08:00 and 22:00 at calendar, deadlines and failed appointments, no end. Only speaks up when there is a reason.",
                ].join("\n"),
          );
        }
        if (reminders.length + planned.length + approvals.length + running.length + watchers.length + missions.length === 0) {
          sections.splice(paused ? 1 : 0, 0, "No reminders, tasks or watchers.");
        }
        sections.push(`IDs are for cancel_schedule, watch_cancel, cancel_task and the mission tools, not for ${owner.name}.`);
        return { ok: true, text: sections.join("\n\n") };
      },
    }),
  ];
}
