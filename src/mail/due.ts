import { DUE_MAX_DAYS } from "../config/limits.js";
import { ownerDate, daysBetween, parseDay } from "../time.js";

/**
 * Due date of a commitment from a mail (V4). `when` stays free text, as the
 * mail says it ("by Friday", "next week Tuesday"); the heartbeat however needs
 * a day to recognise "due today". The digest model resolves it relative to the
 * date received; it is checked here in code: a real date, no further than
 * `DUE_MAX_DAYS` from receipt. Everything else is null and never counts as a
 * deadline. Better to miss a deadline than to message the owner because of a
 * misreading.
 */
export function validDue(due: string | null | undefined, receivedAt: string): string | null {
  if (typeof due !== "string") return null;
  const day = due.trim();
  if (!parseDay(day)) return null;
  const received = new Date(receivedAt);
  if (Number.isNaN(received.getTime())) return null;
  return Math.abs(daysBetween(ownerDate(received), day)) <= DUE_MAX_DAYS ? day : null;
}
