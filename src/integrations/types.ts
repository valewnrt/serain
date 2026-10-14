import { z } from "zod";

/**
 * Access to the owner's accounts (D7, D30). Three kinds: a mailbox over
 * IMAP/SMTP (GMX, Posteo, mailbox.org, an own host, …), Google through our own
 * OAuth app (Gmail, Calendar) and iCloud over CalDAV (calendar, D54). No
 * aggregator holds a token.
 */

export const imapSecretSchema = z.object({
  kind: z.literal("imap"),
  user: z.string().min(3),
  password: z.string().min(1),
  imapHost: z.string().min(3),
  imapPort: z.number().int().positive(),
  smtpHost: z.string().min(3),
  smtpPort: z.number().int().positive(),
  /**
   * Whose mailbox (addendum D31 of 2026-10-08): if missing, it is the owner's
   * (`owner`). `serain` is Serain's own address, from which it writes as
   * itself. Lives in the sealed part, so nobody with write access to the
   * database can turn the owner's mailbox into Serain's or the other way round.
   */
  owner: z.enum(["owner", "serain"]).optional(),
});

export const googleSecretSchema = z.object({
  kind: z.literal("google"),
  clientId: z.string().min(10),
  clientSecret: z.string().min(5),
  refreshToken: z.string().min(10),
});

/**
 * iCloud calendar over CalDAV (D54): Apple ID and app-specific password, plus
 * the calendar Serain writes into. The URL is no secret, but lives with the
 * credential so both disappear together.
 */
export const caldavSecretSchema = z.object({
  kind: z.literal("caldav"),
  user: z.string().min(3),
  password: z.string().min(1),
  writeCalendarUrl: z.string().url(),
});

export const integrationSecretSchema = z.discriminatedUnion("kind", [imapSecretSchema, googleSecretSchema, caldavSecretSchema]);

export type ImapSecret = z.infer<typeof imapSecretSchema>;
export type GoogleSecret = z.infer<typeof googleSecretSchema>;
export type CaldavSecret = z.infer<typeof caldavSecretSchema>;
export type IntegrationSecret = z.infer<typeof integrationSecretSchema>;
export type IntegrationKind = IntegrationSecret["kind"];

/** What is readable without the key. `sealed` is worthless without `SERAIN_INTEGRATION_KEY`. */
export interface IntegrationRow {
  id: string;
  kind: IntegrationKind;
  /** Mail address of the account. For previews and the prompt, not a secret. */
  account: string;
  sealed: string;
  scopes: string[];
  /** The trigger's bookmark (last UID, history ID). Never a secret. */
  state: Record<string, unknown>;
}

export interface RemovedIntegration {
  /** Rows in `mail_items` deleted together with the credential (W13). */
  mailItems: number;
}

export interface IntegrationStore {
  /** All credentials in the order they were first connected: the first mailbox is the main mailbox. */
  list(): Promise<IntegrationRow[]>;
  /** Whether the credential is still connected, without loading the sealed part. */
  has(id: string): Promise<boolean>;
  get(id: string): Promise<IntegrationRow | null>;
  put(row: IntegrationRow): Promise<void>;
  saveState(id: string, state: Record<string, unknown>): Promise<void>;
  /** Deletes the credential and everything attached to it. Null when it did not exist. */
  remove(id: string): Promise<RemovedIntegration | null>;
}
