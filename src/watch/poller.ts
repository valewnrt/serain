import {
  PROACTIVE_QUIET_UNTIL_HOUR,
  WATCH_BACKOFF_MAX_MS,
  WATCH_CLAIM_LEASE_MS,
  WATCH_CONFIRM_DELAY_MS,
  WATCH_DUE_BATCH,
  WATCH_FETCHES_PER_ROUND,
  WATCH_GIVE_UP_AFTER_MS,
  WATCH_INCOMING_SECTION_CHARS,
  WATCH_MAX_FAILURES,
  WATCH_MAX_HITS_PER_DAY,
  WATCH_PENDING_MAILS,
  WATCH_SEEN_MAIL_IDS,
  WATCH_URL_INTERVAL_MS,
} from "../config/limits.js";
import { audit } from "../db/audit.js";
import { owner } from "../config/owner.js";
import { log } from "../log.js";
import { inQuietHours } from "../proactive/heartbeat.js";
import { WHENCE_RULE } from "../proactive/whence.js";
import type { ConfidentialGuard } from "../security/confidential.js";
import { stripTracking } from "../security/links.js";
import { wrapUntrusted } from "../security/untrusted.js";
import { formatWallTime, toWallTime, wallTimeToUtc } from "../time.js";
import { compareValue, displayCurrency, formatThreshold, mailMatches } from "./extract.js";
import { defaultFetcher, hostOf, readUrlWatch, type PageFetcher } from "./read.js";
import { formatQuote, QUOTE_CONFIRM_MS, QUOTE_INTERVAL_MS, QUOTE_SOURCE, quoteHitSentence, quoteStand, quoteTarget, readQuote } from "./quote.js";
import {
  parseSpec,
  type PendingHit,
  type WatchExtreme,
  type WatcherPatch,
  type WatcherRow,
  type WatcherStore,
  type WatchPollerStateStore,
  type WatchSpec,
  type WatchState,
} from "./types.js";

/**
 * The watchers' poller (H2, W28, D43). Runs along with the scheduler's 30 s tick,
 * like the heartbeat and the mail trigger, and almost always does nothing that
 * costs a model: claim due watchers, read the page through the protected fetch,
 * compare number or fingerprint in code, write the state. Only a **hit** becomes
 * a turn (or a sign-off, or the expiry of a page or quote watcher: the owner
 * should never believe someone is still looking), and the poller does not build
 * it: it hands a text to `fire`, from which the runtime makes a turn of origin
 * `untrusted` with the three-tool box.
 *
 * **A hit always takes the same path** (`deliver`): first noted as
 * `pendingHit`, then delivered as soon as it may. At night (22:00 to 8:00) and
 * at its own daily cap it is deferred until 8:00, not dropped as with the mail
 * trigger (D33): the owner explicitly waited for this report. The heartbeat's
 * grace period (D26) does not apply for the same reason.
 */

/** What a hit turn gets. The registry refuses everything else. */
export const WATCH_TURN_TOOLS = ["send_message", "cancel_silently", "end_turn"] as const;

/** Source of untrusted content for hits from the mailbox. */
const MAILBOX_SOURCE = `${owner.name}'s inbox`;

export interface WatchPollerDeps {
  store: WatcherStore;
  state: WatchPollerStateStore;
  /** Kill switch (D8.2): then it checks, fetches and reports nothing. */
  paused(): Promise<boolean>;
  /** The confidential values (D29), fresh before every fetch. Throws if they cannot be loaded. */
  confidential(): Promise<ConfidentialGuard>;
  /**
   * Queues the hit turn. `incoming` is built by the code, untrusted content in it is framed.
   * `openedPages`: the page the poller loaded for this hit, without tracking parameters,
   * nothing else (addendum D48 of 2026-10-10). The turn gets it as opened (`TurnSetup.openedPages`),
   * like a task result gets the executor's pages.
   */
  fire(incoming: string, taintSources: string[], openedPages: string[]): void;
  fetch?: PageFetcher;
  now?: () => Date;
}

/** A new mail as the watcher sees it: without its body (D31, W3). */
export interface WatchedMail {
  id: string;
  from: string;
  subject: string;
  date: string;
}

function ownerDay(now: Date): string {
  const wall = toWallTime(now);
  return `${wall.year}-${String(wall.month).padStart(2, "0")}-${String(wall.day).padStart(2, "0")}`;
}

/** The next morning at 8:00 in the owner's wall time; before 8:00 that is today. */
export function nextMorning(now: Date): Date {
  const wall = toWallTime(now);
  const day = new Date(Date.UTC(wall.year, wall.month - 1, wall.day));
  if (wall.hour >= PROACTIVE_QUIET_UNTIL_HOUR) day.setUTCDate(day.getUTCDate() + 1);
  return wallTimeToUtc({
    year: day.getUTCFullYear(),
    month: day.getUTCMonth() + 1,
    day: day.getUTCDate(),
    hour: PROACTIVE_QUIET_UNTIL_HOUR,
    minute: 0,
  });
}

/** The line the model reads about the watcher itself: everything from the owner or the code. */
function header(row: WatcherRow, watch: WatchSpec): string {
  const where =
    watch.kind === "mail_arrives"
      ? `mailbox, ${[watch.spec.from ? `sender "${watch.spec.from}"` : "", watch.spec.subject ? `subject "${watch.spec.subject}"` : ""].filter(Boolean).join(", ")}`
      : watch.kind === "quote"
        ? `price ${quoteTarget(watch.spec)}`
        : `${hostOf(watch.spec.url)}, ${watch.spec.url}`;
  return `Watcher "${row.label}" (created ${formatWallTime(new Date(row.createdAt))}; ${where}).`;
}

/**
 * The reading lowest and highest value start with when the state does not know
 * them yet (watchers from before 2026-10-10): the last read value.
 */
function startExtreme(row: WatcherRow): WatchExtreme | null {
  const { value, display } = row.state;
  return typeof value === "number" && typeof display === "string" ? { value, display, at: row.lastCheckedAt ?? row.createdAt } : null;
}

/** A reading flows into the lowest and highest value. */
function withExtremes(row: WatcherRow, state: WatchState, value: number, display: string, at: Date): WatchState {
  const reading: WatchExtreme = { value, display, at: at.toISOString() };
  const low = state.low ?? startExtreme(row);
  const high = state.high ?? startExtreme(row);
  return { ...state, low: !low || value < low.value ? reading : low, high: !high || value > high.value ? reading : high };
}

/** A successful fetch ends every series of failures. */
function recovered(state: WatchState): WatchState {
  return { ...state, lastError: null, failingSince: null, hardFailures: 0 };
}

const HOUR = 60 * 60_000;

/** "14 days", "5 hours": how long a watcher ran. */
function duration(ms: number): string {
  if (ms < 36 * HOUR) {
    const hours = Math.max(1, Math.round(ms / HOUR));
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  return `${Math.round(ms / (24 * HOUR))} days`;
}

/**
 * The facts about the expiry of a page or quote watcher, all from the code or
 * from the owner's turn: condition, running time, reported changes, lowest and
 * highest reading with source. The model does the wording; the sentence to the
 * owner is not fixed.
 * Returns the condition with the running time, the facts and what the sentence
 * should be about.
 */
function expiredLines(row: WatcherRow, watch: Exclude<WatchSpec, { kind: "mail_arrives" }>): [string, string, string] {
  const { state } = row;
  const ran = `It ran until ${formatWallTime(new Date(row.expiresAt))}, ${duration(new Date(row.expiresAt).getTime() - new Date(row.createdAt).getTime())}.`;
  const changes = state.changes ?? 0;
  const changed =
    changes > 0
      ? `In that time you reported ${changes} change${changes === 1 ? "" : "s"} to ${owner.name}.`
      : "Nothing changed the whole time.";
  const stale = state.lastError ? `The last fetches failed (${state.lastError}).` : null;
  if (watch.kind === "status_changes") {
    const what = watch.spec.anchor ? `of the section after "${watch.spec.anchor}"` : "of the page";
    return [`Condition: any change ${what}. ${ran}`, [changed, stale].filter(Boolean).join(" "), "and whether anything happened in that time"];
  }
  const low = state.low ?? startExtreme(row);
  const high = state.high ?? startExtreme(row);
  const source = watch.kind === "quote" ? QUOTE_SOURCE[watch.spec.asset] : hostOf(watch.spec.url);
  const values =
    !low || !high
      ? null
      : low.value === high.value
        ? `The value stood at ${low.display} the whole time, read on ${source}.`
        : `Lowest reading: ${low.display} (${formatWallTime(new Date(low.at))}), highest: ${high.display} ` +
          `(${formatWallTime(new Date(high.at))}), last ${state.display ?? high.display}, read on ${source}.`;
  let condition: string;
  let outcome: string;
  let focus: string;
  if (watch.kind === "quote") {
    const { compare, threshold, currency, asset } = watch.spec;
    condition = `Condition: price ${compare} ${formatQuote(threshold, currency, asset)}.`;
    outcome = "The condition was not met the whole time.";
    focus = compare === "below" ? "with the lowest reading" : "with the highest reading";
  } else if (watch.spec.compare === "changes") {
    condition = `Condition: any change of the value after "${watch.spec.anchor}".`;
    outcome = changed;
    focus = "with the last reading";
  } else {
    const { anchor, compare, threshold } = watch.spec;
    condition =
      `Condition: the value after "${anchor}" ${compare} ` +
      `${formatThreshold(threshold ?? 0, displayCurrency(state.display))}.`;
    outcome = "The condition was not met the whole time.";
    focus = compare === "below" ? "with the lowest reading" : "with the highest reading";
  }
  const facts = [outcome, values, stale, stale && values ? "The readings are from before that." : null];
  return [`${condition} ${ran}`, facts.filter(Boolean).join(" "), focus];
}

/**
 * Only the page the fetch for the hit really loaded (after redirects) counts as
 * opened, without tracking parameters (addendum D48 of 2026-10-10).
 */
function openedPage(url: string): { opened?: string } {
  const clean = stripTracking(url);
  return clean ? { opened: clean } : {};
}

/** The link to act on: only to the page the poller loaded for this hit. */
function linkLines(opened: string | null): string[] {
  if (!opened) return [];
  return [
    `The watcher opened this page for the hit, and that is where ${owner.name} acts: send it to them as a preview ` +
      "(links on send_message, not in the text). No other address works.",
    wrapUntrusted(opened, hostOf(opened)),
  ];
}

const ASK =
  `${owner.name} asked for this, so you write them exactly one short message with send_message: what happened, ` +
  "with the numbers, no preamble, no offer to do something.";
/** Only on a status change may the model stay silent: the code sees that something changed, not whether it matters. */
const ASK_STATUS =
  `If the change is obviously irrelevant to what ${owner.name} is waiting for (advertising, a date, a counter), call ` +
  "cancel_silently.";

/**
 * The text of the hit turn. Label, URL, anchor and threshold come from the
 * owner's clean turn, numbers and times from the code; only the changed section
 * of a page and the sender/subject of a mail are untrusted and therefore framed.
 */
export function watchIncoming(
  row: WatcherRow,
  watch: WatchSpec,
  hit: PendingHit,
  section: string | null,
  now: Date,
  opened: string | null,
): string {
  const late = now.getTime() - new Date(hit.foundAt).getTime() > WATCH_CLAIM_LEASE_MS;
  const when = late ? ` Found ${formatWallTime(new Date(hit.foundAt))}, deferred until now.` : "";
  const head = header(row, watch);
  switch (hit.kind) {
    case "failed":
      return [
        `Watcher switched off: ${head}`,
        `It no longer works: ${hit.reason}. It checks nothing from now on.${when}`,
        `Tell ${owner.name} in one short sentence with send_message, so they stop waiting for the report. ` +
          (watch.kind === "quote" ? "If they want, they set it up again later." : "If they want, they set it up again (different anchor, different page)."),
        WHENCE_RULE,
      ].join("\n");
    case "value": {
      if (watch.kind === "quote") {
        const { compare, threshold, currency, asset } = watch.spec;
        return [
          `Watcher hit: ${head}`,
          `The price is now ${compare} ${formatQuote(threshold, currency, asset)}: ${hit.current}, ` +
            `read twice in a row (before ${hit.previous ?? "unknown"}).${when} The watcher is done with this.`,
          `${owner.name} asked for this, so you send them exactly this sentence with send_message, in the language they write in: "${quoteHitSentence(watch.spec, hit.current)}" ` +
            `You may replace the symbol with the word ${owner.name} uses for it (BTC → bitcoin).${when ? " Say when the hit was." : ""} Nothing else.`,
        ].join("\n");
      }
      if (watch.kind !== "url_value") throw new Error(`value hit on a watcher of kind ${watch.kind}`);
      const { anchor, compare, threshold } = watch.spec;
      const from = hit.previous ?? "unknown";
      const what =
        compare === "changes"
          ? `The value after "${anchor}" changed: from ${from} to ${hit.current}.${when}`
          : `The value after "${anchor}" is now ${compare} ` +
            `${formatThreshold(threshold ?? 0, displayCurrency(hit.current))}: ${hit.current} (before ${from}).${when} ` +
            "The watcher is done with this.";
      return [`Watcher hit: ${head}`, what, ...linkLines(opened), ASK, WHENCE_RULE].join("\n");
    }
    case "status": {
      if (watch.kind !== "status_changes") throw new Error(`status hit on a watcher of kind ${watch.kind}`);
      const where = watch.spec.anchor ? `The section after "${watch.spec.anchor}"` : "The page";
      return [
        `Watcher hit: ${head}`,
        `${where} changed.${when}`,
        section
          ? `This is how it reads now (shortened):\n${wrapUntrusted(section.slice(0, WATCH_INCOMING_SECTION_CHARS), hostOf(watch.spec.url))}`
          : `The new state cannot be fetched right now; tell ${owner.name} that something changed.`,
        ...linkLines(opened),
        ASK,
        ASK_STATUS,
        WHENCE_RULE,
      ].join("\n");
    }
    case "expired": {
      if (watch.kind === "mail_arrives") throw new Error("the expiry of a mail watcher without report_if_none reports nothing");
      const [condition, facts, focus] = expiredLines(row, watch);
      return [
        `Watcher expired: ${head}`,
        `${condition}${when}`,
        facts,
        `From now on nobody looks anymore, and otherwise ${owner.name} thinks someone still does. Tell them with send_message ` +
          `in one short sentence that you stop looking, ${focus}. No preamble, no offer. If the ` +
          "history shows they no longer care (already bought, done), call cancel_silently instead.",
        WHENCE_RULE,
      ].join("\n");
    }
    case "none": {
      if (watch.kind !== "mail_arrives") throw new Error(`expiry report on a watcher of kind ${watch.kind}`);
      // No untrusted content: sender, subject and deadline come from the owner's turn, that nothing came the code knows.
      return [
        `Watcher expired: ${head}`,
        `No matching mail came until ${formatWallTime(new Date(row.expiresAt))}.${when}`,
        `${owner.name} wanted to know exactly that. Tell them in one short sentence with send_message. You may offer a ` +
          "follow-up in half a sentence; you write a mail only when they say so.",
        WHENCE_RULE,
      ].join("\n");
    }
    case "mail": {
      const mails = hit.mails
        .map((mail) => `Mailbox: ${mail.account}\nFrom: ${mail.from}\nSubject: ${mail.subject}\nReceived: ${formatWallTime(new Date(mail.receivedAt))}`)
        .join("\n\n");
      return [
        `Watcher hit: ${head}`,
        `Matching mail${hit.mails.length > 1 ? "s" : ""} arrived.${when}`,
        wrapUntrusted(mails, MAILBOX_SOURCE),
        ASK,
        WHENCE_RULE,
      ].join("\n");
    }
  }
}

export class WatchPoller {
  private readonly now: () => Date;
  private readonly fetcher: PageFetcher;
  private running = false;

  constructor(private readonly deps: WatchPollerDeps) {
    this.now = deps.now ?? (() => new Date());
    this.fetcher = deps.fetch ?? defaultFetcher;
  }

  /** Runs along with the scheduler's tick. Never overlaps with itself. */
  async maybeRun(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.round();
    } catch (error) {
      // A watcher that cannot read stays silent this round; the next comes in 30 s.
      log.error("watcher round failed:", error);
      await audit("watcher", { action: "check", ok: false, reason: "error", detail: (error as Error).message });
    } finally {
      this.running = false;
    }
  }

  private async round(): Promise<void> {
    if (await this.deps.paused()) return;
    const now = this.now();
    const due = await this.deps.store.due(now.toISOString(), WATCH_DUE_BATCH);
    let fetches = 0;
    for (const row of due) {
      const fetching = this.needsFetch(row, now);
      // The rest stay due and get their turn in the next round.
      if (fetching && fetches >= WATCH_FETCHES_PER_ROUND) continue;
      const lease = new Date(now.getTime() + WATCH_CLAIM_LEASE_MS).toISOString();
      if (!(await this.deps.store.claim(row.id, row.nextCheckAt, lease))) continue;
      if (fetching) fetches += 1;
      try {
        await this.process(row, now);
      } catch (error) {
        // A watcher failing here does not hold up the others. It is due again after the lease.
        log.error(`watcher ${row.id} failed:`, error);
        await audit("watcher", { action: "check", watcher_id: row.id, ok: false, reason: "error", detail: (error as Error).message });
      }
    }
  }

  /** Does this watcher cost a fetch in this round? */
  private needsFetch(row: WatcherRow, now: Date): boolean {
    if (row.kind === "mail_arrives") return false;
    const pending = row.state.pendingHit;
    // A deferred status change fetches the new state fresh instead of storing it overnight.
    if (pending) return pending.kind === "status" && !this.deferral(now, null);
    return new Date(row.expiresAt).getTime() > now.getTime();
  }

  private async process(row: WatcherRow, now: Date): Promise<void> {
    const parsed = parseSpec(row.kind, row.spec);
    if (!parsed.ok) {
      // Can only be an entry changed by hand: the tool checks the same schema on creation.
      await this.deps.store.update(row.id, { status: "failed", lastCheckedAt: now.toISOString() });
      await audit("watcher", { action: "failed", watcher_id: row.id, reason: "invalid_spec", detail: parsed.reason });
      return;
    }
    const watch = parsed.value;
    if (row.state.pendingHit) return this.deliver(row, watch, row.state, row.state.pendingHit, now, null);
    if (new Date(row.expiresAt).getTime() <= now.getTime()) {
      const ended = { lastCheckedAt: now.toISOString() };
      // Page and quote: the owner asked and is waiting. Expiring silently would mean they think someone still looks.
      if (watch.kind !== "mail_arrives") return this.deliver(row, watch, row.state, { kind: "expired", foundAt: now.toISOString() }, now, null, ended);
      // "Tell me if nothing comes by Friday": here the expiry without a hit is the report itself.
      if (watch.spec.report_if_none && (row.state.seenMailIds ?? []).length === 0) {
        return this.deliver(row, watch, row.state, { kind: "none", foundAt: now.toISOString() }, now, null, ended);
      }
      // Without report_if_none the owner asked about a mail, not about its absence.
      await this.deps.store.update(row.id, { status: "expired", ...ended });
      await audit("watcher", { action: "expired", watcher_id: row.id, kind: row.kind });
      return;
    }
    // A mail watcher waits for `onNewMail`; it only becomes due at its expiry.
    if (watch.kind === "mail_arrives") {
      await this.deps.store.update(row.id, { nextCheckAt: row.expiresAt });
      return;
    }
    if (watch.kind === "quote") return this.checkQuote(row, watch, now);
    await this.check(row, watch, now);
  }

  /** The confidential values (D29); without them no fetch, and the watcher comes back in the next interval. */
  private async guard(row: WatcherRow, watch: WatchSpec, now: Date): Promise<ConfidentialGuard | null> {
    try {
      return await this.deps.confidential();
    } catch (error) {
      // Fail closed like `run_task` (D29): not a failed attempt of the watcher, the source is not to blame.
      await this.deps.store.update(row.id, { nextCheckAt: this.later(now, watch, row) });
      await audit("watcher", { action: "check", watcher_id: row.id, ok: false, reason: "confidential_unavailable", detail: (error as Error).message });
      return null;
    }
  }

  /**
   * A quote (addendum D43 of 2026-10-08). A hit only counts when the next fetch
   * confirms it, 2 min later: a single wrong price of the source does not get
   * reported this way. Until then the last reported value stays, the candidate
   * lies next to it.
   */
  private async checkQuote(row: WatcherRow, watch: Extract<WatchSpec, { kind: "quote" }>, now: Date): Promise<void> {
    const guard = await this.guard(row, watch, now);
    if (!guard) return;
    const reading = await readQuote(watch.spec, guard, this.fetcher);
    if (!reading.ok) return this.failure(row, watch, now, reading);
    const { quote } = reading;
    const base = recovered(row.state);
    const patch: WatcherPatch = { failures: 0, lastCheckedAt: now.toISOString() };
    const hit = compareValue(watch.spec.compare, quote.value, null, watch.spec.threshold);
    const confirming = Boolean(row.state.candidate);
    await audit("watcher", { action: hit && !confirming ? "candidate" : "check", watcher_id: row.id, ok: true, kind: "quote", value: quote.value, hit });
    if (!hit) {
      await this.deps.store.update(row.id, {
        ...patch,
        state: withExtremes(row, { ...base, value: quote.value, display: quote.display, candidate: null }, quote.value, quote.display, now),
        nextCheckAt: this.later(now, watch, row),
      });
      return;
    }
    if (!confirming) {
      await this.deps.store.update(row.id, {
        ...patch,
        state: { ...base, candidate: { value: quote.value, display: quote.display, at: now.toISOString() } },
        nextCheckAt: new Date(now.getTime() + QUOTE_CONFIRM_MS).toISOString(),
      });
      return;
    }
    const stand = quoteStand(quote, watch.spec.asset);
    const pending: PendingHit = {
      kind: "value",
      foundAt: now.toISOString(),
      previous: row.state.display ?? null,
      current: `${quote.display}${stand ? ` (${stand})` : ""}`,
      then: "done",
    };
    const state = withExtremes(row, { ...base, value: quote.value, display: quote.display, candidate: null }, quote.value, quote.display, now);
    return this.deliver(row, watch, state, pending, now, null, patch);
  }

  private async check(
    row: WatcherRow,
    watch: Extract<WatchSpec, { kind: "url_value" | "status_changes" }>,
    now: Date,
  ): Promise<void> {
    const guard = await this.guard(row, watch, now);
    if (!guard) return;
    const reading = await readUrlWatch(watch, guard, this.fetcher);
    if (!reading.ok) return this.failure(row, watch, now, reading);

    const base = recovered(row.state);
    const patch: WatcherPatch = { failures: 0, lastCheckedAt: now.toISOString() };

    if (reading.kind === "value" && watch.kind === "url_value") {
      const previous = typeof row.state.value === "number" ? row.state.value : null;
      const { value, display } = reading.value;
      const read = withExtremes(row, { ...base, value, display }, value, display, now);
      const hit = compareValue(watch.spec.compare, value, previous, watch.spec.threshold);
      await audit("watcher", { action: "check", watcher_id: row.id, ok: true, value, hit });
      if (!hit) {
        await this.deps.store.update(row.id, { ...patch, state: read, nextCheckAt: this.later(now, watch, row) });
        return;
      }
      const state: WatchState = { ...read, changes: (row.state.changes ?? 0) + 1 };
      const pending: PendingHit = {
        kind: "value",
        foundAt: now.toISOString(),
        previous: row.state.display ?? null,
        current: reading.value.display,
        then: watch.spec.compare === "changes" ? "active" : "done",
        ...openedPage(reading.url),
      };
      return this.deliver(row, watch, state, pending, now, null, patch);
    }

    if (reading.kind === "status" && watch.kind === "status_changes") {
      const known = row.state.hash ?? null;
      if (reading.hash === known) {
        await audit("watcher", { action: "check", watcher_id: row.id, ok: true, changed: false });
        await this.deps.store.update(row.id, { ...patch, state: { ...base, candidateHash: null }, nextCheckAt: this.later(now, watch, row) });
        return;
      }
      if (row.state.candidateHash !== reading.hash) {
        // Seen for the first time: confirm first, and soon, not in 30 min.
        await audit("watcher", { action: "check", watcher_id: row.id, ok: true, changed: "unconfirmed" });
        await this.deps.store.update(row.id, {
          ...patch,
          state: { ...base, candidateHash: reading.hash },
          nextCheckAt: new Date(now.getTime() + WATCH_CONFIRM_DELAY_MS).toISOString(),
        });
        return;
      }
      await audit("watcher", { action: "check", watcher_id: row.id, ok: true, changed: true });
      const state: WatchState = { ...base, hash: reading.hash, candidateHash: null, changes: (row.state.changes ?? 0) + 1 };
      return this.deliver(row, watch, state, { kind: "status", foundAt: now.toISOString(), ...openedPage(reading.url) }, now, reading.section, patch);
    }
    throw new Error(`reading ${reading.kind} does not fit kind ${watch.kind}`);
  }

  /**
   * A failed attempt. The watcher is broken at once if a second attempt changes
   * nothing (`final`), after five real failures in a row (anchor gone, 404,
   * unreadable response) or after a day without a single success. A disruption
   * of the source (`transient`: network, timeout, 5xx, 429) does not count as a
   * failure, it only stretches the interval: an hour of Kraken being down does
   * not end a watcher the owner has been waiting on for a week.
   */
  private async failure(
    row: WatcherRow,
    watch: WatchSpec,
    now: Date,
    failed: { reason: string; final: boolean; transient?: true },
  ): Promise<void> {
    const { reason, final, transient } = failed;
    const failures = row.failures + 1;
    const failingSince = row.state.failingSince ?? now.toISOString();
    // Watchers from before 2026-10-10 do not know the difference: all their failures count.
    const hardFailures = (row.state.hardFailures ?? row.failures) + (transient ? 0 : 1);
    const failingFor = now.getTime() - new Date(failingSince).getTime();
    await audit("watcher", { action: "check", watcher_id: row.id, ok: false, reason, failures, ...(transient ? { transient: true } : {}) });
    const state: WatchState = { ...row.state, lastError: reason, failingSince, hardFailures };
    if (!final && hardFailures < WATCH_MAX_FAILURES && failingFor < WATCH_GIVE_UP_AFTER_MS) {
      await this.deps.store.update(row.id, {
        failures,
        lastCheckedAt: now.toISOString(),
        state,
        nextCheckAt: transient ? this.backoff(now, watch, row, failures) : this.later(now, watch, row),
      });
      return;
    }
    const hit: PendingHit = { kind: "failed", foundAt: now.toISOString(), reason };
    await this.deliver(row, watch, state, hit, now, null, { failures, lastCheckedAt: now.toISOString() });
  }

  /**
   * Why nothing may be reported right now, and until when. At night until 8:00,
   * at the daily cap until the next morning. `hitCount` null means: check only the time.
   */
  private deferral(now: Date, hitCountToday: number | null): { until: Date; reason: "quiet_hours" | "daily_limit" } | null {
    if (inQuietHours(now)) return { until: nextMorning(now), reason: "quiet_hours" };
    if (hitCountToday !== null && hitCountToday >= WATCH_MAX_HITS_PER_DAY) return { until: nextMorning(now), reason: "daily_limit" };
    return null;
  }

  /**
   * The one path of a hit to the owner. If it may not go now, it stays as
   * `pendingHit` on the watcher, and the watcher is due again at 8:00. If it may,
   * it goes to `fire`, counts against the daily cap, and the watcher takes on the
   * state after it: done, broken or still active with the new reading, so the
   * same change is never reported twice.
   */
  private async deliver(
    row: WatcherRow,
    watch: WatchSpec,
    state: WatchState,
    hit: PendingHit,
    now: Date,
    section: string | null,
    extra: WatcherPatch = {},
  ): Promise<void> {
    const counter = await this.deps.state.load();
    const today = ownerDay(now);
    const countToday = counter.hitDay === today ? counter.hitCount : 0;
    const deferred = this.deferral(now, countToday);
    if (deferred) {
      const updated = await this.deps.store.update(row.id, {
        ...extra,
        state: { ...state, pendingHit: hit },
        nextCheckAt: deferred.until.toISOString(),
      });
      if (updated) {
        await audit("watcher", { action: "hit", watcher_id: row.id, kind: hit.kind, deferred: deferred.reason, until: deferred.until.toISOString() });
      }
      return;
    }

    let fresh = section;
    // Opened is only the page of the fetch that found the hit; a deferred status change reads fresh.
    let opened = hit.kind === "value" || hit.kind === "status" ? (hit.opened ?? null) : null;
    if (fresh === null && hit.kind === "status" && watch.kind === "status_changes") {
      const reading = await this.freshSection(watch);
      if (reading) {
        fresh = reading.section;
        opened = openedPage(reading.url).opened ?? null;
      }
    }

    const then =
      hit.kind === "failed"
        ? "failed"
        : hit.kind === "value"
          ? hit.then
          : hit.kind === "none" || hit.kind === "expired"
            ? "expired"
            : // Whoever waits for an absence needs no further report after the first answer.
              watch.kind === "mail_arrives" && watch.spec.report_if_none
              ? "done"
              : "active";
    const nextCheckAt = watch.kind === "mail_arrives" ? row.expiresAt : this.later(now, watch, row);
    const patch: WatcherPatch = { ...extra, state: { ...state, pendingHit: null }, ...(then === "active" ? { nextCheckAt } : { status: then }) };
    // First the state, then the turn: better a hit that never arrives (it is in the audit log)
    // than one that comes twice after a crash. And a watcher the owner just cancelled reports
    // nothing anymore.
    if (!(await this.deps.store.update(row.id, patch))) return;
    await this.deps.state.save({ hitDay: today, hitCount: countToday + 1 });
    if (hit.kind === "failed") {
      await audit("watcher", { action: "failed", watcher_id: row.id, kind: row.kind, reason: hit.reason, failures: row.failures + 1 });
    } else if (hit.kind === "none" || hit.kind === "expired") {
      await audit("watcher", { action: "expired", watcher_id: row.id, kind: row.kind, reported: true });
    } else {
      await audit("watcher", { action: "hit", watcher_id: row.id, kind: hit.kind, delivered: true, found_at: hit.foundAt });
    }
    // No untrusted content: that no mail came and how often a page changed, the code knows.
    // Lowest and highest reading, however, come from the source, like the value of a hit.
    const taint =
      hit.kind === "none" || (hit.kind === "expired" && watch.kind === "status_changes")
        ? []
        : [watch.kind === "mail_arrives" ? MAILBOX_SOURCE : watch.kind === "quote" ? `price from ${QUOTE_SOURCE[watch.spec.asset]}` : `watcher: ${hostOf(watch.spec.url)}`];
    this.deps.fire(watchIncoming(row, watch, hit, fresh, now, opened), taint, opened ? [opened] : []);
  }

  /** The current section for a deferred status change, with the loaded page. Null if it cannot be read right now. */
  private async freshSection(watch: Extract<WatchSpec, { kind: "status_changes" }>): Promise<{ section: string; url: string } | null> {
    try {
      const reading = await readUrlWatch(watch, await this.deps.confidential(), this.fetcher);
      return reading.ok && reading.kind === "status" ? { section: reading.section, url: reading.url } : null;
    } catch {
      return null;
    }
  }

  private interval(watch: WatchSpec): number {
    return watch.kind === "quote" ? QUOTE_INTERVAL_MS[watch.spec.asset] : WATCH_URL_INTERVAL_MS;
  }

  /** The next regular fetch, never after the expiry: the report about it should not wait. */
  private later(now: Date, watch: WatchSpec, row: WatcherRow): string {
    return this.until(now.getTime() + this.interval(watch), row);
  }

  /**
   * The next fetch while the source is disrupted: the regular interval, then
   * twice as long each time, at most `WATCH_BACKOFF_MAX_MS` (hourly currencies
   * stay at one hour).
   */
  private backoff(now: Date, watch: WatchSpec, row: WatcherRow, failures: number): string {
    const base = this.interval(watch);
    const delay = Math.min(base * 2 ** Math.min(failures - 1, 16), Math.max(base, WATCH_BACKOFF_MAX_MS));
    return this.until(now.getTime() + delay, row);
  }

  private until(at: number, row: WatcherRow): string {
    return new Date(Math.min(at, new Date(row.expiresAt).getTime())).toISOString();
  }

  /**
   * A new mail from the mail trigger, however the classifier ranks it: "tell me
   * when the shipping mail comes" is mostly bulk mail. Only sender and subject
   * are checked. A hit is noted as `pendingHit` and delivered by the next
   * `maybeRun`, so quiet hours, cap and kill switch apply in exactly one place.
   *
   * A promise (`awaited`, addendum D33 of 2026-10-13) is not reported by the
   * watcher: it is done with the first matching mail, and `true` tells the mail
   * trigger that the owner is waiting for exactly this mail. The trigger then
   * reports it with a summary, without `judge`; otherwise there would be a second
   * report through the watcher without content.
   */
  async onNewMail(accountId: string, mail: WatchedMail): Promise<boolean> {
    const now = this.now();
    const watchers = (await this.deps.store.active()).filter((row) => row.kind === "mail_arrives");
    let awaited = false;
    for (const row of watchers) {
      if (new Date(row.expiresAt).getTime() <= now.getTime()) continue;
      const parsed = parseSpec(row.kind, row.spec);
      if (!parsed.ok || parsed.value.kind !== "mail_arrives") continue;
      const seen = row.state.seenMailIds ?? [];
      if (seen.includes(mail.id) || !mailMatches(parsed.value.spec, mail)) continue;

      if (parsed.value.spec.awaited) {
        const kept = await this.deps.store.update(row.id, { state: { ...row.state, seenMailIds: [...seen, mail.id].slice(-WATCH_SEEN_MAIL_IDS) }, status: "done" });
        // Just cancelled: then the owner no longer waits for it.
        if (!kept) continue;
        await audit("watcher", { action: "hit", watcher_id: row.id, kind: "mail_arrives", awaited: true });
        awaited = true;
        continue;
      }
      const entry = { account: accountId, from: mail.from.slice(0, 200), subject: mail.subject.slice(0, 200), receivedAt: mail.date };
      const pending = row.state.pendingHit;
      const hit: PendingHit =
        pending?.kind === "mail"
          ? { ...pending, mails: [...pending.mails, entry].slice(-WATCH_PENDING_MAILS) }
          : { kind: "mail", foundAt: now.toISOString(), mails: [entry] };
      const state: WatchState = { ...row.state, seenMailIds: [...seen, mail.id].slice(-WATCH_SEEN_MAIL_IDS), pendingHit: hit };
      // If a hit is already pending until 8:00, that time stays.
      const nextCheckAt = pending ? row.nextCheckAt : now.toISOString();
      await this.deps.store.update(row.id, { state, nextCheckAt });
      await audit("watcher", { action: "check", watcher_id: row.id, ok: true, kind: "mail_arrives", matched: true });
    }
    return awaited;
  }
}
