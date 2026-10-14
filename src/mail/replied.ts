import { log } from "../log.js";
import type { MailAccount } from "./types.js";

/**
 * Has the owner already replied (addendum D33 of 2026-10-10)? A mail at 11 pm
 * that they answer from their phone at half past eleven should not be reported
 * to them again by Serain at 8. Like the hotel that does not return the
 * hairpin when the guest has already found it themselves.
 *
 * **Only for the report and as a hint in "what is open", never for deadlines.**
 * "ok, will do" answers the mail but does not get done what is due by Friday;
 * the heartbeat keeps reminding of the deadline (D46).
 *
 * Unknown means no: a mailbox without `repliedSince`, an error, a thread
 * without an identifier. Then the old behaviour stays, better reported once
 * too often than a deadline kept quiet.
 */
export interface ThreadRef {
  integrationId: string;
  threadKey: string;
  /** When the mail arrived: only what the owner wrote after that counts. */
  receivedAt: string;
}

export async function answered(accounts: readonly MailAccount[], ref: ThreadRef): Promise<boolean> {
  const account = accounts.find((candidate) => candidate.id === ref.integrationId);
  const since = new Date(ref.receivedAt);
  if (!account?.repliedSince || !ref.threadKey || Number.isNaN(since.getTime())) return false;
  try {
    return await account.repliedSince(ref.threadKey, since);
  } catch (error) {
    log.warn(`Reply in ${ref.integrationId} cannot be checked:`, (error as Error).message);
    return false;
  }
}

/** The entries the owner has already replied to, checked one after another (an IMAP mailbox reads serially). */
export async function answeredOf<T extends ThreadRef>(accounts: readonly MailAccount[], refs: readonly T[]): Promise<Set<T>> {
  const done = new Set<T>();
  for (const ref of refs) if (await answered(accounts, ref)) done.add(ref);
  return done;
}
