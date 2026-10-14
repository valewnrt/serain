import { z } from "zod";
import { quoteSpec, type QuoteSpec } from "./quote.js";

/**
 * Watchers without a model (H2, W28, D43). Fixed types whose `spec` is checked
 * here with Zod, on creation and on every read from the database. There is
 * deliberately no further type "script": code that a model writes after
 * reading a foreign page and that then runs repeatedly would be the time-bomb
 * injection from D15.
 *
 *   url_value       first number after an anchor on a public page, with a comparison
 *   status_changes  section after an anchor (or the page), change by fingerprint
 *   mail_arrives    new mail whose sender and/or subject matches
 *   quote           price of crypto, a currency or a stock from a fixed source in the code (addendum D43 of 2026-10-08)
 */

export const WATCH_KINDS = ["url_value", "status_changes", "mail_arrives", "quote"] as const;
export type WatchKind = (typeof WATCH_KINDS)[number];

export type WatchStatus = "active" | "done" | "cancelled" | "failed" | "expired";

const webUrl = z
  .string()
  .trim()
  .max(2_000)
  .refine((raw) => {
    try {
      const url = new URL(raw);
      return url.protocol === "https:" || url.protocol === "http:";
    } catch {
      return false;
    }
  }, "not an http or https URL");

const anchor = z.string().trim().min(2).max(80);

export const urlValueSpec = z
  .object({
    url: webUrl,
    anchor,
    compare: z.enum(["below", "above", "changes"]),
    threshold: z.number().finite().optional(),
  })
  .strict()
  .refine((spec) => spec.compare === "changes" || spec.threshold !== undefined, {
    message: "threshold is required for below and above",
    path: ["threshold"],
  });

export const statusChangesSpec = z.object({ url: webUrl, anchor: anchor.optional() }).strict();

export const mailArrivesSpec = z
  .object({
    from: z.string().trim().min(2).max(120).optional(),
    subject: z.string().trim().min(2).max(120).optional(),
    /**
     * "Tell me if X hasn't answered by Friday": reports on expiry if no matching
     * mail came by then, and is done with the first matching one.
     */
    report_if_none: z.boolean().optional(),
    /**
     * Serain promised the owner to get back as soon as this mail is there
     * (`expect_mail`, addendum D33 of 2026-10-13). Then not the watcher itself
     * reports but the mail trigger, with a summary and without `judge`; sender
     * or subject is enough. Only `expect_mail` sets this, never `watch_create`.
     */
    awaited: z.literal(true).optional(),
  })
  .strict()
  .refine((spec) => !(spec.awaited && spec.report_if_none), { message: "a promise does not report an absence" })
  .refine((spec) => spec.from !== undefined || spec.subject !== undefined, {
    message: "give from or subject, at least one",
  });

export type UrlValueSpec = z.infer<typeof urlValueSpec>;
export type StatusChangesSpec = z.infer<typeof statusChangesSpec>;
export type MailArrivesSpec = z.infer<typeof mailArrivesSpec>;

export type WatchSpec =
  | { kind: "url_value"; spec: UrlValueSpec }
  | { kind: "status_changes"; spec: StatusChangesSpec }
  | { kind: "mail_arrives"; spec: MailArrivesSpec }
  | { kind: "quote"; spec: QuoteSpec };

export type SpecResult = { ok: true; value: WatchSpec } | { ok: false; reason: string };

/** Checks `spec` against the type. The message goes to the model, so it is in words. */
export function parseSpec(kind: WatchKind, raw: unknown): SpecResult {
  const schema =
    kind === "url_value" ? urlValueSpec : kind === "status_changes" ? statusChangesSpec : kind === "quote" ? quoteSpec : mailArrivesSpec;
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const reason = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || kind}: ${issue.message}`)
      .join("; ");
    return { ok: false, reason };
  }
  return { ok: true, value: { kind, spec: parsed.data } as WatchSpec };
}

/**
 * The page the poller loaded for this hit, without tracking parameters
 * (addendum D48 of 2026-10-10). Only for page watchers; only there may the hit
 * turn send a link or a preview. Missing for hits from before that day and for
 * quotes.
 */
const opened = z.string().optional();

/**
 * A hit that has not reached the owner yet: deferred at night or at the daily
 * cap until 8:00, or just found by a mail. It carries only what the code built
 * itself (numbers, instants) and, for mails, sender and subject, never page or
 * mail text. The delivery fetches the changed section of a page fresh instead of
 * keeping it in the database overnight.
 */
export const pendingHitSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("value"),
    foundAt: z.string(),
    previous: z.string().nullable(),
    current: z.string(),
    then: z.enum(["active", "done"]),
    opened,
  }),
  z.object({ kind: z.literal("status"), foundAt: z.string(), opened }),
  z.object({
    kind: z.literal("mail"),
    foundAt: z.string(),
    mails: z.array(z.object({ account: z.string(), from: z.string(), subject: z.string(), receivedAt: z.string() })),
  }),
  z.object({ kind: z.literal("failed"), foundAt: z.string(), reason: z.string() }),
  /** A mail watcher with `report_if_none` expired without a matching mail. */
  z.object({ kind: z.literal("none"), foundAt: z.string() }),
  /**
   * A page or quote watcher expired. What belongs to it (lowest and highest
   * reading, reported changes) is in the watcher's state.
   */
  z.object({ kind: z.literal("expired"), foundAt: z.string() }),
]);
export type PendingHit = z.infer<typeof pendingHitSchema>;

/** A reading with its instant, as the code read and formatted it. */
const extremeSchema = z.object({ value: z.number(), display: z.string(), at: z.string() });
export type WatchExtreme = z.infer<typeof extremeSchema>;

/** `watchers.state`. Last value or fingerprint, never page or mail text (0013_watchers.sql). */
export const watchStateSchema = z.object({
  /** url_value and quote: last seen number and how the model reads it ("129.00 €"). */
  value: z.number().nullable().optional(),
  display: z.string().nullable().optional(),
  /**
   * url_value and quote: lowest and highest reading since creation, for the
   * report on expiry. Numbers parsed by the code like `value`; an unconfirmed
   * quote candidate does not count. Missing for watchers from before
   * 2026-10-10; then the last read value counts as the start.
   */
  low: extremeSchema.nullable().optional(),
  high: extremeSchema.nullable().optional(),
  /** url_value with `changes` and status_changes: this many changes the watcher reported. */
  changes: z.number().int().nonnegative().optional(),
  /** quote: a first hit waiting for the confirming second fetch. */
  candidate: z.object({ value: z.number(), display: z.string(), at: z.string() }).nullable().optional(),
  /** status_changes: reported fingerprint, and a new one still waiting for confirmation. */
  hash: z.string().nullable().optional(),
  candidateHash: z.string().nullable().optional(),
  /** mail_arrives: mails already reported. */
  seenMailIds: z.array(z.string()).optional(),
  /** Last failure reason, in our own words (never text of the other side). */
  lastError: z.string().nullable().optional(),
  /**
   * The first failed attempt since the last successful fetch. After
   * `WATCH_GIVE_UP_AFTER_MS` without success the watcher signs off, even if
   * every failure was only transient.
   */
  failingSince: z.string().nullable().optional(),
  /**
   * Failed attempts in a row that were no disruption of the source (anchor gone,
   * 404). `failures` counts all; the watcher is switched off after
   * `WATCH_MAX_FAILURES` of these.
   */
  hardFailures: z.number().int().nonnegative().optional(),
  pendingHit: pendingHitSchema.nullable().optional(),
});
export type WatchState = z.infer<typeof watchStateSchema>;

export interface WatcherRow {
  id: string;
  kind: WatchKind;
  label: string;
  /** Raw from the database; read only through `parseSpec`. */
  spec: unknown;
  state: WatchState;
  status: WatchStatus;
  /** Raw, as the database returns it: `claim` compares exactly this value. */
  nextCheckAt: string;
  lastCheckedAt: string | null;
  failures: number;
  expiresAt: string;
  createdAt: string;
}

export interface NewWatcher {
  kind: WatchKind;
  label: string;
  spec: UrlValueSpec | StatusChangesSpec | MailArrivesSpec | QuoteSpec;
  state: WatchState;
  nextCheckAt: string;
  expiresAt: string;
  sourceMessageId: string;
}

export interface WatcherPatch {
  state?: WatchState;
  status?: Exclude<WatchStatus, "cancelled">;
  nextCheckAt?: string;
  lastCheckedAt?: string;
  failures?: number;
}

export interface WatcherStore {
  insert(row: NewWatcher): Promise<WatcherRow>;
  /** Active watchers, next check first. */
  active(): Promise<WatcherRow[]>;
  countActive(): Promise<number>;
  due(now: string, limit: number): Promise<WatcherRow[]>;
  /**
   * Claim atomically: `next_check_at` jumps to `leaseUntil`, but only if the
   * watcher is still active and `next_check_at` still reads `expected`. False if
   * someone was faster.
   */
  claim(id: string, expected: string, leaseUntil: string): Promise<boolean>;
  /** Writes only to an active watcher: a cancellation during the check stays a cancellation. */
  update(id: string, patch: WatcherPatch): Promise<boolean>;
  cancel(id: string): Promise<boolean>;
}

/** Global state of the poller (`agent_state.watch_poller`): the daily cap. */
export interface WatchPollerState {
  hitDay: string | null;
  hitCount: number;
}

export const EMPTY_WATCH_POLLER_STATE: WatchPollerState = { hitDay: null, hitCount: 0 };

export interface WatchPollerStateStore {
  load(): Promise<WatchPollerState>;
  save(state: WatchPollerState): Promise<void>;
}
