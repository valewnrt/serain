import { SCHEDULER_BATCH } from "../config/limits.js";
import { audit } from "../db/audit.js";
import { t, textLanguage } from "../i18n/catalog.js";
import { currentLanguage, currentLocale } from "../i18n/language.js";
import { core } from "../i18n/messages/core.js";
import { ownerDate, daysBetween, OWNER_TIMEZONE } from "../time.js";
import type { ScheduleRow } from "./store.js";

/**
 * Reminders that never arrived (D15, addendum 2026-10-10). If a one-off
 * reminder fails after the last attempt too, the scheduler notes it here, in
 * `agent_state.missed_reminders`. As soon as anything gets through to the owner
 * after that (a reply, a hit, another reminder), the channel is back, and it
 * follows: the same text, the same bracket "(was due at 8 AM)" as every late
 * reminder, no new sentence.
 *
 * Deliberately no test send of its own: when the channel was down for 80
 * minutes, only a real success knows that it works again. The kill switch
 * stops this like every run of the scheduler; rate limit and duplicate block
 * apply in the `OutboundGate` as for every message.
 */

export interface MissedReminder {
  scheduleId: string;
  text: string;
  /** Due time, for the bracket. */
  dueAt: string;
  /** Origin as at the original send (D8.4, addendum 2026-10-02). */
  taintSources: string[];
  failedAt: string;
  /** The last attempt to deliver it late; after that it takes another success. */
  triedAt: string | null;
}

export interface MissedReminderStore {
  load(): Promise<MissedReminder[]>;
  save(entries: MissedReminder[]): Promise<void>;
}

/** How the message arrived at the channel: `duplicate` means the owner already has it (D9, "no double send"). */
export type MissedSend = (text: string, entry: MissedReminder) => Promise<"sent" | "duplicate" | "failed">;

export interface MissedRemindersDeps {
  store: MissedReminderStore;
  /** When a message to the owner last got through at the channel; null if none since the start. */
  lastDelivered(): number | null;
  send: MissedSend;
  now?: () => Date;
}

/**
 * The clock time as one says it in the owner's locale: "8" and "8:30" in
 * German, "8 AM" and "8:30 AM" in English. Full hours without ":00".
 */
function spokenTime(instant: Date, locale: string): string {
  const parts = new Intl.DateTimeFormat(locale, { timeZone: OWNER_TIMEZONE, hour: "numeric", minute: "2-digit" }).formatToParts(instant);
  const minute = parts.find((part) => part.type === "minute")?.value;
  if (minute !== "00") return parts.map((part) => part.value).join("");
  // Drop the minutes and the separator right before them; keep the rest (day period, "h").
  const index = parts.findIndex((part) => part.type === "minute");
  return parts
    .filter((_, at) => at !== index && !(at === index - 1 && parts[at]!.type === "literal"))
    .map((part) => part.value)
    .join("")
    .trim();
}

/** "fr., 09.10." / "fri, 10/09": a short weekday and date in the owner's locale, lowercase like the rest. */
function spokenDay(instant: Date, locale: string): string {
  return new Intl.DateTimeFormat(locale, { timeZone: OWNER_TIMEZONE, weekday: "short", day: "2-digit", month: "2-digit" })
    .format(instant)
    .toLocaleLowerCase(locale);
}

/**
 * A reminder with the bracket when it comes late (`dueAt` set): when it should
 * have come, with the day only if that was not today ("(sollte gestern um 8
 * kommen)", "(was due fri, 10/09 at 8 AM)"). The same wording for every delay,
 * chosen in the style round (addendum D23 of 2026-10-10). The reminder text
 * itself stays as it was written.
 */
export function reminderText(text: string, dueAt: Date | null, now: Date, lang: string = currentLanguage()): string {
  if (!dueAt) return text;
  const ago = daysBetween(ownerDate(dueAt), ownerDate(now));
  const message = ago === 0 ? core.reminderLateToday : ago === 1 ? core.reminderLateYesterday : core.reminderLateDay;
  const used = textLanguage(message, lang);
  const locale = currentLocale(used);
  const time = spokenTime(dueAt, locale);
  const bracket =
    ago === 0
      ? t(core.reminderLateToday, { time }, used)
      : ago === 1
        ? t(core.reminderLateYesterday, { time }, used)
        : t(core.reminderLateDay, { day: spokenDay(dueAt, locale), time }, used);
  return `${text}\n${bracket}`;
}

export class MissedReminders {
  private readonly now: () => Date;
  /** Checked up to this success already; only a newer one is worth a look into the database. */
  private checkedThrough = 0;

  constructor(private readonly deps: MissedRemindersDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** Notes a one-off reminder that failed for good. Throws if it could not be stored. */
  async record(row: ScheduleRow, reason: string): Promise<void> {
    const entries = await this.deps.store.load();
    if (entries.some((entry) => entry.scheduleId === row.id)) return;
    entries.push({
      scheduleId: row.id,
      text: row.text,
      dueAt: row.dueAt,
      taintSources: [...row.taintSources],
      failedAt: this.now().toISOString(),
      triedAt: null,
    });
    await this.deps.store.save(entries);
    await audit("schedule_missed", { schedule_id: row.id, due_at: row.dueAt, reason, waiting: entries.length });
  }

  /**
   * Runs after every round of the scheduler. Delivers late what failed before
   * the last success at the channel, oldest first, at most `SCHEDULER_BATCH`
   * per round. If one fails, the rest waits for the next success.
   */
  async flush(): Promise<void> {
    const delivered = this.deps.lastDelivered();
    if (delivered === null || delivered <= this.checkedThrough) return;
    const entries = await this.deps.store.load();
    // Only a success after the failure (or after the last late attempt) shows that the channel works again.
    const due = entries
      .filter((entry) => delivered > new Date(entry.triedAt ?? entry.failedAt).getTime())
      .sort((a, b) => a.dueAt.localeCompare(b.dueAt));
    // If something stays due after this round, the next one looks again, even without a new success.
    if (due.length <= SCHEDULER_BATCH) this.checkedThrough = delivered;
    if (due.length === 0) return;

    const done = new Set<string>();
    for (const entry of due.slice(0, SCHEDULER_BATCH)) {
      const outcome = await this.deps.send(reminderText(entry.text, new Date(entry.dueAt), this.now()), entry);
      if (outcome === "failed") {
        // The channel does not work after all: everything else waits for the next success.
        this.checkedThrough = delivered;
        entry.triedAt = this.now().toISOString();
        await audit("schedule_missed_retry_failed", { schedule_id: entry.scheduleId });
        break;
      }
      done.add(entry.scheduleId);
      await audit("schedule_missed_delivered", {
        schedule_id: entry.scheduleId,
        late_ms: this.now().getTime() - new Date(entry.dueAt).getTime(),
        ...(outcome === "duplicate" ? { duplicate: true } : {}),
      });
    }
    // Sent first, then forgotten: if the process dies in between, the duplicate block
    // (which survives a restart) catches the second one.
    await this.deps.store.save(entries.filter((entry) => !done.has(entry.scheduleId)));
  }
}
