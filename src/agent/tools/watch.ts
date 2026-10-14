import { z } from "zod";
import {
  WATCH_DEFAULT_DAYS,
  WATCH_MAX_ACTIVE,
  WATCH_MAX_DAYS,
  WATCH_RESOLVE_CANDIDATES,
  WATCH_URL_INTERVAL_MS,
} from "../../config/limits.js";
import { audit } from "../../db/audit.js";
import { describeKinds, type ConfidentialGuard } from "../../security/confidential.js";
import { formatLater } from "../../security/later.js";
import { ownerDate, formatWallDay, formatWallTime, parseWallTime, wallTimeToUtc } from "../../time.js";
import { namesDay, unaskedTurnBlocker, untilLabel } from "../../security/unasked.js";
import { compareValue, displayCurrency, formatThreshold, wordTokens } from "../../watch/extract.js";
import { defaultFetcher, hostOf, readUrlWatch, type PageFetcher, type UrlReading } from "../../watch/read.js";
import { QUOTE_ASSETS, QUOTE_INTERVAL_MS, quoteStand, quoteTarget, readQuote, formatQuote, type QuoteSpec } from "../../watch/quote.js";
import {
  parseSpec,
  type StatusChangesSpec,
  type UrlValueSpec,
  type WatcherRow,
  type WatcherStore,
  type WatchKind,
  type WatchSpec,
  type WatchState,
} from "../../watch/types.js";
import { defineTool, type ToolDefinition, type ToolResult, type TurnState } from "./types.js";
import { owner } from "../../config/owner.js";
import { t, textLanguage } from "../../i18n/catalog.js";
import { currentLocale } from "../../i18n/language.js";
import { tools as messages } from "../../i18n/messages/tools.js";

/**
 * Watchers (H2, W28, D43): "tell me when the price drops below 100 € / the mail
 * from X arrives / the status changes". The check runs in code (`src/watch/`),
 * a model only runs on a hit.
 *
 * **`watch_create` is owner-only and only in a clean turn** (like
 * `schedule_task`, D15). A watcher is a recurring check whose result Serain
 * reads later. If a turn that has just read a foreign page or mail could
 * create one, the page could decide which URL Serain fetches every 30 min from
 * then on (with the owner's data in it) and which text later comes back as a
 * hit. **`watch_cancel` is owner-only** like `cancel_schedule`: a crafted mail
 * must not switch off the owner's watchers.
 *
 * **The result of `watch_create` is not `returnsUntrusted`, although it comes
 * from a foreign page.** With taint, the turn would afterwards be blocked for
 * `run_task`, `schedule_task` and a second watcher: "watch A and B" would not
 * work, and a wrong anchor could not be retried with another one in the same
 * turn. Taint protects against text of a page being read as an instruction;
 * here no text of the page reaches the model. The result consists of the
 * owner's own input (anchor, URL, threshold), the host, fixed sentences and a
 * number that the code parsed from digits and formatted anew itself, with a
 * currency sign from a fixed list (`src/watch/extract.ts`). Failure reasons
 * are our own words as well (`describeFetchError`: not even the file type from
 * the other side's header gets through). What a page can steer this way is a
 * number and whether the anchor was found. For the status watcher the result
 * therefore names only the length of the section, not its beginning.
 *
 * **The address is as much a guess as the anchor** (live test 2026-10-02:
 * `…/raspberry-pi-5-8gb` instead of `…/raspberry-pi-5-8gb-ram`, 404). If the
 * page is reachable but the wrong one, the code searches the same host for the
 * anchor and tries the first hits. Here too no text of the search reaches the
 * model: titles, excerpts and even the found address stay in code, the result
 * only says that another page of the same host fit. What the search can steer
 * is which page of this host is read; the host comes from the owner's turn,
 * and hits on other hosts are discarded, even if the provider returns them
 * despite the domain filter.
 *
 * **Unasked only the mail watcher with a deadline from the owner's own
 * message** (addendum D62 of 2026-10-10). If the owner says "the insurance
 * gets back to me by friday", Serain creates a `mail_arrives` watcher with
 * `report_if_none` until then, using `unasked`. Owner-only and clean apply
 * anyway; in addition the day of `until` must be in the owner's words
 * (`src/security/unasked.ts`), so that a follow-up turn cannot derive anything
 * from a mail it read either. If one like it is already running for the same
 * sender, no second one is created.
 */

/** Searches pages for an anchor on a host; returns addresses, best first. Empty means: nothing found or quota used up. */
export type SitePageFinder = (host: string, query: string) => Promise<string[]>;

export interface WatchToolDeps {
  store: WatcherStore;
  /** The confidential values (D29), fresh for each creation. Throws if they cannot be loaded. */
  confidential(): Promise<ConfidentialGuard>;
  fetch?: PageFetcher;
  /** Without a search provider it stays with the given address. */
  findPages?: SitePageFinder;
  now?: () => Date;
}

/** The words in the path of an address ("/en/raspberry-pi-5-8gb-ram" → en, raspberry, pi, 5, 8, gb, ram). */
function pathWords(url: string): string[] {
  try {
    const path = new URL(url).pathname;
    try {
      return wordTokens(decodeURIComponent(path));
    } catch {
      return wordTokens(path);
    }
  } catch {
    return [];
  }
}

/**
 * How well the path of a hit fits what is wanted (Jaccard over words). Live
 * on 2026-10-02 the search for "Raspberry Pi 5 8GB" returned the starter kit
 * before the board, and both pages carry the anchor with a price. The path
 * with the fewest foreign words is the product itself, not the bundle around
 * it.
 */
function closeness(url: string, wanted: ReadonlySet<string>): number {
  const words = new Set(pathWords(url));
  let shared = 0;
  for (const word of words) if (wanted.has(word)) shared += 1;
  const union = words.size + wanted.size - shared;
  return union === 0 ? 0 : shared / union;
}

/** The same host, with or without "www.": shop.example and www.shop.example are one site. */
function sameSite(a: string, b: string): boolean {
  const bare = (host: string) => host.toLowerCase().replace(/^www\./, "");
  return bare(a) === bare(b);
}

const RELOCATED = " (on another page of the same host, the given address did not fit)";

/** Where a watcher looks, in one line for the model. Also for the overview (`overview`). */
export function watchTarget(row: WatcherRow, flags = true): string {
  const parsed = parseSpec(row.kind, row.spec);
  if (!parsed.ok) return "invalid";
  const watch = parsed.value;
  if (watch.kind === "mail_arrives") {
    // For a promise one of the two is enough (`mailMatches`).
    const which = [watch.spec.from ? `sender "${watch.spec.from}"` : "", watch.spec.subject ? `subject "${watch.spec.subject}"` : ""].filter(Boolean);
    if (watch.spec.awaited) return [`mail with ${which.join(" or ")}`, flags ? `you promised ${owner.name} to get back to them` : ""].filter(Boolean).join(", ");
    return [
      watch.spec.from ? `mail from "${watch.spec.from}"` : "mail",
      watch.spec.subject ? `subject "${watch.spec.subject}"` : "",
      flags && watch.spec.report_if_none ? "also reports if none arrives" : "",
    ]
      .filter(Boolean)
      .join(", ");
  }
  if (watch.kind === "quote") return quoteTarget(watch.spec);
  return `${hostOf(watch.spec.url)}${watch.spec.anchor ? ` after "${watch.spec.anchor}"` : ""}`;
}

/** How often a page or quote watcher looks, from the code. */
function intervalMs(row: Pick<WatcherRow, "kind" | "spec">): number {
  const parsed = parseSpec(row.kind, row.spec);
  return parsed.ok && parsed.value.kind === "quote" ? QUOTE_INTERVAL_MS[parsed.value.spec.asset] : WATCH_URL_INTERVAL_MS;
}

/** "every 10 min", "hourly": how often a watcher looks, from the code, for the model. */
export function watchCadence(row: Pick<WatcherRow, "kind" | "spec">): string {
  if (row.kind === "mail_arrives") return "checks every new mail";
  const ms = intervalMs(row);
  return ms === 60 * 60_000 ? "hourly" : `every ${Math.round(ms / 60_000)} min`;
}

/**
 * The first sentence to the owner once a watcher stands (style round, addendum
 * D23 of 2026-10-08): cadence and end, both from the code. If the owner named
 * an end with a time (`until`), it is included; otherwise the day is enough.
 */
export function watchConfirmation(row: Pick<WatcherRow, "kind" | "spec">, expiresAt: Date, withClock: boolean): string {
  const ms = intervalMs(row);
  const message = row.kind === "mail_arrives" ? messages.watchEveryMail : ms === 60 * 60_000 ? messages.watchHourly : messages.watchEvery;
  // Date and words in the same language: the one the sentence really renders in.
  const lang = textLanguage(message);
  // A date like "Fr., 16.10." brings its own period; the sentence ends with one anyway.
  const end = (withClock ? formatLater(expiresAt, lang) : formatWallDay(expiresAt, currentLocale(lang))).replace(/\.$/, "");
  return t(message, { end, minutes: Math.round(ms / 60_000) }, lang);
}

/** What the model does with the sentence. The rest is a half sentence, so that a wrong anchor or quote shows at once. */
function confirmationAsk(sentence: string, rest: string): string {
  return `Set watching on ${owner.name}'s message and write to them, as your first sentence, verbatim "${sentence}"${rest}`;
}

export function watchTools(deps: WatchToolDeps): ToolDefinition[] {
  const now = deps.now ?? (() => new Date());
  const fetcher = deps.fetch ?? defaultFetcher;

  /**
   * The given address was the wrong page: search the same host for the anchor
   * and read the first hits. The search query is the anchor, and like the URL
   * it only goes out after the check for confidential values (D29).
   */
  async function findOnSite(
    watch: { kind: "url_value"; spec: UrlValueSpec } | { kind: "status_changes"; spec: StatusChangesSpec },
    anchor: string,
    guard: ConfidentialGuard,
    messageId: string,
  ): Promise<{ url: string; reading: UrlReading & { ok: true } } | null> {
    if (!deps.findPages || guard.check(anchor).length > 0) return null;
    const host = hostOf(watch.spec.url);
    let urls: string[];
    try {
      urls = await deps.findPages(host, anchor);
    } catch (error) {
      await audit("watcher", { action: "relocate", ok: false, host, reason: (error as Error).message }, messageId);
      return null;
    }
    // What is wanted: the anchor and the words of the guessed address. With equal closeness the order of the search counts.
    const wanted = new Set([...wordTokens(anchor), ...pathWords(watch.spec.url)]);
    const candidates = [...new Set(urls)]
      .filter((url) => url !== watch.spec.url && sameSite(hostOf(url), host))
      .map((url, rank) => ({ url, rank, score: closeness(url, wanted) }))
      .sort((a, b) => b.score - a.score || a.rank - b.rank)
      .slice(0, WATCH_RESOLVE_CANDIDATES)
      .map((candidate) => candidate.url);
    for (const [index, url] of candidates.entries()) {
      const reading = await readUrlWatch({ ...watch, spec: { ...watch.spec, url } } as typeof watch, guard, fetcher);
      if (reading.ok) {
        await audit("watcher", { action: "relocate", ok: true, host, tried: index + 1 }, messageId);
        return { url, reading };
      }
    }
    await audit("watcher", { action: "relocate", ok: false, host, tried: candidates.length }, messageId);
    return null;
  }

  async function create(
    args: {
      kind: WatchKind;
      label: string;
      url?: string | undefined;
      anchor?: string | undefined;
      asset?: QuoteSpec["asset"] | undefined;
      symbol?: string | undefined;
      currency?: string | undefined;
      compare?: "below" | "above" | "changes" | undefined;
      threshold?: number | undefined;
      from?: string | undefined;
      subject?: string | undefined;
      report_if_none?: boolean | undefined;
      days?: number | undefined;
      until?: string | undefined;
      unasked?: boolean | undefined;
    },
    turn: TurnState,
  ): Promise<ToolResult> {
    const { kind, label, days = WATCH_DEFAULT_DAYS, until, unasked = false, ...fields } = args;
    if (until !== undefined && args.days !== undefined) return { ok: false, text: "Not created: days or until, not both." };
    // Only mail needs this: pages and quotes report their end anyway, with lowest and highest value.
    if (fields.report_if_none !== undefined && kind !== "mail_arrives") return { ok: false, text: "Not created: report_if_none only exists for mail_arrives." };
    if (fields.report_if_none === false) delete fields.report_if_none;
    // Only the fields that are set: the schema of the kind rejects foreign ones ("url" with mail_arrives).
    const raw = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
    const parsed = parseSpec(kind, raw);
    if (!parsed.ok) return { ok: false, text: `Not created: ${parsed.reason}.` };
    const watch = parsed.value;
    if ((await deps.store.countActive()) >= WATCH_MAX_ACTIVE) {
      return { ok: false, text: `${WATCH_MAX_ACTIVE} watchers are already running. Cancel one first (overview, watch_cancel).` };
    }

    const started = now();
    let expiresAt = new Date(started.getTime() + days * 86_400_000);
    if (until !== undefined) {
      const wall = parseWallTime(until);
      if (!wall) return { ok: false, text: `Not created: until as YYYY-MM-DD HH:MM (local time, ${owner.timezone}).` };
      expiresAt = wallTimeToUtc(wall);
      if (expiresAt.getTime() <= started.getTime()) return { ok: false, text: "Not created: until is not in the future." };
      if (expiresAt.getTime() - started.getTime() > WATCH_MAX_DAYS * 86_400_000) {
        return { ok: false, text: `Not created: at most ${WATCH_MAX_DAYS} days.` };
      }
    }
    if (unasked) {
      const denied = await unaskedDenial(watch, until, expiresAt, turn);
      if (denied) return denied;
    }
    if (watch.kind === "quote") return createQuote(watch.spec, label, started, expiresAt, until !== undefined, turn);
    let state: WatchState = {};
    let found = "";
    let relocated = false;
    if (watch.kind !== "mail_arrives") {
      let guard: ConfidentialGuard;
      try {
        guard = await deps.confidential();
      } catch (error) {
        await audit(
          "tool_denied",
          { tool: "watch_create", reason: "confidential_unavailable", detail: (error as Error).message },
          turn.triggerMessageId,
        );
        return {
          ok: false,
          text: `Not possible right now: your memory is not readable, and without it the address cannot be checked. Tell ${owner.name} that directly.`,
        };
      }
      // Like `run_task` (D29): if the URL carries a confidential value, it is never fetched.
      const leaks = guard.check(watch.spec.url);
      if (leaks.length > 0) {
        await audit("tool_denied", { tool: "watch_create", reason: "confidential", kinds: leaks }, turn.triggerMessageId);
        return {
          ok: false,
          text:
            `Not created: the address contains ${describeKinds(leaks)} from your memory, and it would be fetched every ` +
            `30 minutes. Use an address without personal details, or tell ${owner.name} that it does not work this way.`,
        };
      }
      // Read once right away: Serain tells the owner what it watches, and a wrong anchor shows now, not in two weeks.
      let reading = await readUrlWatch(watch, guard, fetcher);
      if (!reading.ok && reading.wrongPage && watch.spec.anchor && deps.findPages) {
        const found = await findOnSite(watch, watch.spec.anchor, guard, turn.triggerMessageId);
        if (found) {
          watch.spec.url = found.url;
          reading = found.reading;
          relocated = true;
        }
      }
      if (!reading.ok) {
        await audit("watcher", { action: "check", ok: false, reason: reading.reason, during: "create" }, turn.triggerMessageId);
        return {
          ok: false,
          text:
            `Not created: ${reading.reason}. ` +
            (watch.kind === "url_value" || watch.spec.anchor
              ? `Try another anchor (the text right before the number, the product name) or ask ${owner.name} where on the page it is.`
              : `Ask ${owner.name} for another page.`),
        };
      }
      if (reading.kind === "value" && watch.kind === "url_value") {
        const { compare, threshold } = watch.spec;
        // Already met: a watcher that fires immediately in 30 min is none. The owner learns it now.
        if (compare !== "changes" && compareValue(compare, reading.value.value, null, threshold)) {
          await audit("watcher", { action: "check", ok: true, value: reading.value.value, during: "create", already: true }, turn.triggerMessageId);
          return {
            ok: true,
            text:
              `No watcher needed: after "${watch.spec.anchor}" it already says ${reading.value.display}, that is ` +
              `${compare === "below" ? "below" : "above"} ${formatThreshold(threshold ?? 0, displayCurrency(reading.value.display))}. Tell ${owner.name} that.`,
          };
        }
        state = { value: reading.value.value, display: reading.value.display };
        found = `found: ${reading.value.display} after "${watch.spec.anchor}"${relocated ? RELOCATED : ""}`;
      } else if (reading.kind === "status") {
        state = { hash: reading.hash };
        found = `watching ${watch.spec.anchor ? `the section after "${watch.spec.anchor}"` : "the whole page"} (${reading.section.length} characters)${relocated ? RELOCATED : ""}`;
      }
    }

    const row = await deps.store.insert({
      kind,
      label,
      spec: watch.spec,
      state,
      // Mail watchers wait for new mails and only become due at their end.
      nextCheckAt: (kind === "mail_arrives" ? expiresAt : new Date(started.getTime() + WATCH_URL_INTERVAL_MS)).toISOString(),
      expiresAt: expiresAt.toISOString(),
      sourceMessageId: turn.triggerMessageId,
    });
    await audit(
      "watcher",
      {
        action: "created",
        watcher_id: row.id,
        kind,
        ...(watch.kind === "mail_arrives" ? {} : { host: hostOf(watch.spec.url) }),
        ...(watch.kind === "url_value" ? { compare: watch.spec.compare, value: state.value ?? null } : {}),
        ...(watch.kind === "mail_arrives" && watch.spec.report_if_none ? { report_if_none: true } : {}),
        ...(unasked ? { unasked: true } : {}),
        expires_at: expiresAt.toISOString(),
      },
      turn.triggerMessageId,
    );
    const condition =
      watch.kind === "url_value"
        ? watch.spec.compare === "changes"
          ? "reports every change of the value"
          : `reports when the value goes ${watch.spec.compare === "below" ? "below" : "above"} ${formatThreshold(watch.spec.threshold ?? 0, displayCurrency(state.display ?? ""))}`
        : watch.kind === "status_changes"
          ? "reports when anything about it changes"
          : watch.spec.report_if_none
            ? `reports the first new ${watchTarget(row, false)} and tells you if none arrives by the end`
            : `reports every new ${watchTarget(row)}`;
    // The wall time is in the result so that Serain names it to the owner (W20), and the find along with it.
    return {
      ok: true,
      text:
        `Watcher set (ID ${row.id})${found ? `, ${found}` : ""}. It ${condition}` +
        `${watch.kind === "mail_arrives" ? "" : `, checked ${watchCadence(row)}`}, until ${formatWallTime(expiresAt)}.\n` +
        (unasked
          ? `${owner.name} did not ask for it: no tapback. Tell them in your reply in half a sentence, lowercase, something like ` +
            `"i'll let you know if nothing comes by ${untilLabel(ownerDate(expiresAt), started)}".`
          : confirmationAsk(
              watchConfirmation(row, expiresAt, until !== undefined),
              watch.kind === "mail_arrives" ? "; nothing more is needed." : ", then in half a sentence what you found.",
            )),
    };
  }

  /**
   * May this watcher be created unasked (addendum D62 of 2026-10-10)? Null
   * means yes. Only the one form the owner decided on: a mail with a deadline
   * they named themselves.
   */
  async function unaskedDenial(
    watch: WatchSpec,
    until: string | undefined,
    expiresAt: Date,
    turn: TurnState,
  ): Promise<ToolResult | null> {
    const deny = async (reason: string, message: string): Promise<ToolResult> => {
      await audit("tool_denied", { tool: "watch_create", reason, unasked: true }, turn.triggerMessageId);
      return { ok: false, text: message };
    };
    // The registry has already checked origin and taint (ownerOriginOnly, cleanTurnOnly); once more here, so that the boundary does not hang on a flag.
    const blocker = unaskedTurnBlocker(turn);
    if (blocker) return deny(blocker, `Not created: on your own you only create something ${owner.name} has just written to you themselves.`);
    if (watch.kind !== "mail_arrives" || watch.spec.report_if_none !== true || until === undefined) {
      return deny(
        "unasked_shape",
        `Not created: on your own there is only the mail watcher, when ${owner.name} says someone gets back by a certain day: ` +
          "mail_arrives with report_if_none true and until.",
      );
    }
    if (!namesDay(turn.ownerWords, ownerDate(expiresAt), now(), false)) {
      return deny(
        "unasked_not_named",
        `Not created: on your own only if ${owner.name} names the day in their message themselves ("by friday"), and until ` +
          "falls on exactly that day. What is in a mail or in the history does not count. Leave it, or ask them briefly.",
      );
    }
    const from = (watch.spec.from ?? "").trim().toLowerCase();
    const subject = (watch.spec.subject ?? "").trim().toLowerCase();
    const running = (await deps.store.active()).find((row) => {
      if (row.kind !== "mail_arrives") return false;
      const parsed = parseSpec(row.kind, row.spec);
      return (
        parsed.ok &&
        parsed.value.kind === "mail_arrives" &&
        (parsed.value.spec.from ?? "").trim().toLowerCase() === from &&
        (parsed.value.spec.subject ?? "").trim().toLowerCase() === subject
      );
    });
    if (running) {
      await audit("tool_denied", { tool: "watch_create", reason: "unasked_exists", watcher_id: running.id }, turn.triggerMessageId);
      return { ok: true, text: `Nothing created: a watcher for this mail is already running (ID ${running.id}). Say nothing about it.` };
    }
    return null;
  }

  /**
   * A quote watcher (addendum D43 of 2026-10-08). Read once right away: if the
   * symbol is unknown or the condition already met, none is created. The
   * result carries only what the owner or the code produced (symbol, currency,
   * threshold, a newly formatted number, the fixed source, an exchange code
   * from a list), hence no taint, as above.
   */
  async function createQuote(spec: QuoteSpec, label: string, started: Date, expiresAt: Date, withClock: boolean, turn: TurnState): Promise<ToolResult> {
    let guard: ConfidentialGuard;
    try {
      guard = await deps.confidential();
    } catch (error) {
      await audit("tool_denied", { tool: "watch_create", reason: "confidential_unavailable", detail: (error as Error).message }, turn.triggerMessageId);
      return { ok: false, text: `Not possible right now: your memory is not readable, and without it the query cannot be checked. Tell ${owner.name} that directly.` };
    }
    const reading = await readQuote(spec, guard, fetcher);
    if (!reading.ok) {
      await audit(
        "watcher",
        { action: reading.final ? "unknown_symbol" : "check", ok: false, kind: "quote", asset: spec.asset, symbol: spec.symbol, reason: reading.reason, during: "create" },
        turn.triggerMessageId,
      );
      return {
        ok: false,
        text:
          `Not created: ${reading.reason}. ` +
          (spec.asset === "stock"
            ? "Stocks and ETFs with the Yahoo symbol and the exchange (SAP.DE for Xetra, AAPL for Nasdaq) and in the currency they are listed in there."
            : spec.asset === "fx"
              ? "Currencies as ISO codes that the ECB publishes (USD, GBP, CHF, JPY …)."
              : "Crypto with the ticker (BTC, ETH, SOL …) in EUR or USD."),
      };
    }
    const { quote } = reading;
    const word = spec.compare === "below" ? "below" : "above";
    const threshold = formatQuote(spec.threshold, spec.currency, spec.asset);
    const stand = quoteStand(quote, spec.asset);
    if (compareValue(spec.compare, quote.value, null, spec.threshold)) {
      await audit("watcher", { action: "check", ok: true, kind: "quote", value: quote.value, during: "create", already: true }, turn.triggerMessageId);
      return { ok: true, text: `No watcher needed: ${quoteTarget(spec)} is already at ${quote.display}${stand ? ` (${stand})` : ""}, that is ${word} ${threshold}. Tell ${owner.name} that.` };
    }
    const row = await deps.store.insert({
      kind: "quote",
      label,
      spec,
      state: { value: quote.value, display: quote.display },
      nextCheckAt: new Date(started.getTime() + QUOTE_INTERVAL_MS[spec.asset]).toISOString(),
      expiresAt: expiresAt.toISOString(),
      sourceMessageId: turn.triggerMessageId,
    });
    await audit(
      "watcher",
      {
        action: "created",
        watcher_id: row.id,
        kind: "quote",
        asset: spec.asset,
        symbol: spec.symbol,
        currency: spec.currency,
        compare: spec.compare,
        threshold: spec.threshold,
        value: quote.value,
        source: quoteTarget(spec),
        expires_at: expiresAt.toISOString(),
      },
      turn.triggerMessageId,
    );
    return {
      ok: true,
      text:
        `Watcher set (ID ${row.id}), ${quoteTarget(spec)} is now at ${quote.display}${stand ? ` (${stand})` : ""}. ` +
        `It reports when the quote goes ${word} ${threshold}, checked ${watchCadence(row)}, until ${formatWallTime(expiresAt)}. ` +
        "A hit only counts once the next fetch confirms it.\n" +
        confirmationAsk(watchConfirmation(row, expiresAt, withClock), ", then in half a sentence where the quote is right now."),
    };
  }

  return [
    defineTool({
      name: "watch_create",
      comesBack: true,
      description:
        `Creates a watcher that checks in the background and only reports on a hit. Only on ${owner.name}'s ` +
        "explicit request (\"tell me when …\"), unasked only with unasked. Four kinds: url_value (a number on a " +
        "public page, e.g. " +
        "a price, with below/above and threshold or changes), status_changes (a section of a page changes, " +
        "e.g. a shipment or application status), mail_arrives (a mail from a sender or with a " +
        "subject arrives), quote (a quote, without url and anchor: asset crypto with symbol BTC, ETH, SOL … in EUR " +
        "or USD via Kraken; asset fx with symbol and currency as ISO codes, ECB reference rate, once per " +
        "business day; asset stock for stocks and ETFs with the Yahoo symbol including the exchange, SAP.DE, VWCE.DE, AAPL, " +
        "and the currency they are listed in there; plus below/above and threshold). For quotes always quote, never " +
        "url_value on an exchange page. The anchor is text that stands on the page right before the number or the section, " +
        "preferably the product name; punctuation and whitespace do not count. General words like \"price\" only if you " +
        "know they are there. If the address does not fit, the watcher itself searches the same host for " +
        "the anchor and takes the page whose address fits the anchor best. " +
        "You usually do not know the page; the result names the starting " +
        `value found, and you tell ${owner.name}, so that a wrong anchor shows at once. If nothing is found, ` +
        "nothing is created, and you can try another anchor. \"Tell me if X has not answered by Friday\" is " +
        "mail_arrives with report_if_none and until: it reports the answer as soon as it arrives, or at the end that none came. " +
        "For fixed times use set_reminder.",
      level: "write_reversible",
      ownerOriginOnly: true,
      cleanTurnOnly: true,
      schema: {
        kind: z.enum(["url_value", "status_changes", "mail_arrives", "quote"]),
        label: z
          .string()
          .trim()
          .min(3)
          .max(160)
          .describe(`${owner.name}'s request in one sentence, the way you will need to understand it later: "Price of the Sony WH-1000XM5 below 250 €".`),
        url: z.string().trim().max(2_000).optional().describe("For url_value and status_changes: the public page, http or https."),
        anchor: z
          .string()
          .trim()
          .optional()
          .describe("Required for url_value, recommended for status_changes: text on the page right before the number or section."),
        asset: z.enum(QUOTE_ASSETS).optional().describe("Only quote: crypto, fx or stock."),
        symbol: z.string().trim().optional().describe("Only quote: BTC, USD, SAP.DE …"),
        currency: z.string().trim().optional().describe("Only quote: currency as ISO code in which the quote applies (EUR, USD …)."),
        compare: z.enum(["below", "above", "changes"]).optional().describe("url_value and quote (there only below or above)."),
        threshold: z
          .number()
          .optional()
          .describe("url_value and quote, required with below and above: the threshold as a number, without currency."),
        from: z.string().trim().optional().describe("Only mail_arrives: part of the sender address or name."),
        subject: z.string().trim().optional().describe("Only mail_arrives: keyword in the subject."),
        report_if_none: z
          .boolean()
          .optional()
          .describe("Only mail_arrives: reports at the end if no matching mail came by then, and ends with the first matching one."),
        days: z
          .number()
          .int()
          .min(1)
          .max(WATCH_MAX_DAYS)
          .optional()
          .describe(`Duration in days, default ${WATCH_DEFAULT_DAYS}, at most ${WATCH_MAX_DAYS}.`),
        until: z
          .string()
          .trim()
          .optional()
          .describe(`Instead of days: end as YYYY-MM-DD HH:MM local time (${owner.timezone}), for "by Friday". Without a time from ${owner.name}, use 18:00.`),
        unasked: z
          .boolean()
          .optional()
          .describe(
            `true if ${owner.name} did not ask for the watcher and you create it on your own: only mail_arrives with ` +
              `report_if_none and until, when ${owner.name} says in this message themselves that someone gets back by a certain day. The code checks this.`,
          ),
      },
      run: (args, turn) => create(args, turn),
    }),

    defineTool({
      name: "expect_mail",
      description:
        `Records a promise: you tell ${owner.name} you will get back as soon as a mail is there ("place and time are still coming from the ` +
        "organizer, i'll get back then\"). When a matching mail arrives, the mail trigger reports it with a summary, even if it otherwise " +
        "would not be important enough. Without this you forget the promise. Sender (part of the name or the address) and " +
        "keyword in the subject: one of the two has to match, so give both if you know both. No confirmation " +
        `to ${owner.name} needed, your message with the promise is enough. For an answer to a mail you sent yourself ` +
        "you do not need it, the trigger reports those anyway.",
      level: "write_reversible",
      // Only in the owner's turns, but also after foreign content (decision of 2026-10-13): the promise is often made after Serain
      // searched the mailbox. A mail watcher fetches nothing and sends nothing out; what a crafted mail can achieve with it
      // is that the owner gets a matching mail reported with a summary. Hence neither
      // `ownerOriginOnly` nor `cleanTurnOnly` (both block after taint), but `origins`.
      origins: ["owner_message"],
      comesBack: true,
      schema: {
        label: z
          .string()
          .trim()
          .min(3)
          .max(160)
          .describe(`What ${owner.name} is waiting for, in one sentence: "Tickets and venue for the concert from the organizer".`),
        from: z.string().trim().optional().describe("Part of the sender address or name, as it will appear in the mail."),
        subject: z
          .string()
          .trim()
          .optional()
          .describe(
            "Keyword that will surely be in the subject of this mail and only this one: name of the event, order or file number. " +
              "No general word like \"appointment\" or \"confirmation\", which fits every other mail.",
          ),
        until: z
          .string()
          .trim()
          .optional()
          .describe(
            `By when the mail has to arrive, as YYYY-MM-DD HH:MM local time (${owner.timezone}), such as the day of the event. Without: ${WATCH_DEFAULT_DAYS} days, at most ${WATCH_MAX_DAYS}.`,
          ),
      },
      async run(args, turn) {
        const parsed = parseSpec("mail_arrives", {
          ...(args.from ? { from: args.from } : {}),
          ...(args.subject ? { subject: args.subject } : {}),
          awaited: true,
        });
        if (!parsed.ok || parsed.value.kind !== "mail_arrives") return { ok: false, text: `Not recorded: ${parsed.ok ? "wrong kind" : parsed.reason}.` };
        const spec = parsed.value.spec;
        const started = now();
        let expiresAt = new Date(started.getTime() + WATCH_DEFAULT_DAYS * 86_400_000);
        if (args.until !== undefined) {
          const wall = parseWallTime(args.until);
          if (!wall) return { ok: false, text: `Not recorded: until as YYYY-MM-DD HH:MM (local time, ${owner.timezone}).` };
          expiresAt = wallTimeToUtc(wall);
          if (expiresAt.getTime() <= started.getTime()) return { ok: false, text: "Not recorded: until is not in the future." };
          if (expiresAt.getTime() - started.getTime() > WATCH_MAX_DAYS * 86_400_000) return { ok: false, text: `Not recorded: at most ${WATCH_MAX_DAYS} days.` };
        }
        const same = (a: string | undefined, b: string | undefined) => (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();
        const running = (await deps.store.active()).find((row) => {
          const other = row.kind === "mail_arrives" ? parseSpec(row.kind, row.spec) : null;
          return other?.ok && other.value.kind === "mail_arrives" && other.value.spec.awaited && same(other.value.spec.from, spec.from) && same(other.value.spec.subject, spec.subject);
        });
        if (running) return { ok: true, text: `Already set (ID ${running.id}), until ${formatWallTime(new Date(running.expiresAt))}.` };
        if ((await deps.store.countActive()) >= WATCH_MAX_ACTIVE) {
          return {
            ok: false,
            text: `Not recorded: ${WATCH_MAX_ACTIVE} watchers are already running. Tell ${owner.name} that you cannot get back on your own as long as none of them ends.`,
          };
        }
        const row = await deps.store.insert({
          kind: "mail_arrives",
          label: args.label,
          spec,
          state: {},
          nextCheckAt: expiresAt.toISOString(),
          expiresAt: expiresAt.toISOString(),
          sourceMessageId: turn.triggerMessageId,
        });
        await audit("watcher", { action: "created", watcher_id: row.id, kind: "mail_arrives", awaited: true, expires_at: expiresAt.toISOString() }, turn.triggerMessageId);
        return {
          ok: true,
          text: `Recorded (ID ${row.id}): the mail trigger reports the first new ${watchTarget(row, false)}, until ${formatWallTime(expiresAt)}. Say nothing extra to ${owner.name} about it.`,
        };
      },
    }),

    defineTool({
      name: "watch_cancel",
      description: "Cancels a watcher. The ID comes from overview.",
      level: "write_reversible",
      ownerOriginOnly: true,
      schema: { id: z.string().uuid() },
      async run(args, turn) {
        const cancelled = await deps.store.cancel(args.id);
        if (!cancelled) return { ok: false, text: "That watcher does not exist or is no longer running." };
        await audit("watcher", { action: "cancelled", watcher_id: args.id }, turn.triggerMessageId);
        return { ok: true, text: "Cancelled." };
      },
    }),
  ];
}
