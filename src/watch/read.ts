import { describeKinds, type ConfidentialGuard } from "../security/confidential.js";
import { FetchError, fetchPage, type FetchedPage } from "../executor/fetch.js";
import { BlockedAddressError } from "../executor/netguard.js";
import { extractSection, extractValue, sectionHash, type ExtractedValue } from "./extract.js";
import type { StatusChangesSpec, UrlValueSpec } from "./types.js";

/**
 * Reading a page for a watcher (D43). Fetched **only** through the executor's
 * SSRF-protected fetch (D16: address checked at the socket, every redirect
 * anew, only 80/443, only text), and before that the protection of
 * confidential values checks the URL (D29), just as `run_task` checks the task
 * text. The URL comes from a chat turn, and that one knows the user model and
 * the memory.
 *
 * Reasons are in our own words, never with text of the other side: they go to
 * the model, into the audit log and into the notice of a broken watcher.
 */

export type PageFetcher = (url: string) => Promise<FetchedPage>;

export const defaultFetcher: PageFetcher = (url) => fetchPage(url);

/** `url`: the page the fetch actually loaded (after redirects), as `web_fetch` reports it as a source. */
export type UrlReading =
  | { ok: true; kind: "value"; value: ExtractedValue; url: string }
  | { ok: true; kind: "status"; section: string; hash: string; url: string }
  | {
      ok: false;
      reason: string;
      final: boolean;
      /** The page was reachable but the wrong one: 4xx, anchor missing or no number after it. */
      wrongPage?: true;
      /** Network, timeout, 5xx, 429: the source is disrupted, not wrong (`isTransientStatus`). */
      transient?: true;
    };

/**
 * The error of a fetch in our own words. `FetchError` and the network guard
 * word their messages themselves, except for the content type the server names
 * in its header (`unreadable_type`): that is text of the other side and does
 * not pass here. Node's network errors appear only with their code.
 */
export function describeFetchError(error: unknown): string {
  if (error instanceof BlockedAddressError) return "the address points into the internal network";
  if (error instanceof FetchError) {
    if (error.kind === "unreadable_type") return "the page is not readable text";
    return error.message.replace(/\.$/, "");
  }
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code ? `unreachable (${code.replace(/[^A-Z0-9_]/g, "").slice(0, 30)})` : "unreachable";
}

/**
 * Transient means: a later attempt can work without anyone changing anything.
 * These are Node's network errors (connection, DNS, aborted) and the fetch's
 * timeout. Not included are the network guard (the address points inward) and
 * everything the fetch itself rejects (content type, redirects, size): that
 * does not change by itself.
 */
export function isTransientFetchError(error: unknown): boolean {
  if (error instanceof BlockedAddressError) return false;
  // The only message of `fetchPage` that carries no verdict about the page.
  if (error instanceof FetchError) return error.kind === "timeout";
  return true;
}

/** 5xx, 429 (too many requests) and 408 (timeout at the server): the source is disrupted, not wrong. */
export function isTransientStatus(status: number): boolean {
  return status >= 500 || status === 429 || status === 408;
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "unknown";
  }
}

/**
 * Reads a page for `url_value` or `status_changes`. `final` means: a second
 * attempt changes nothing, the watcher is broken at once (the URL carries a
 * confidential value). `transient` means: the source is disrupted, the watcher
 * waits longer instead of counting the attempt. Everything else counts as a
 * single failed attempt.
 */
export async function readUrlWatch(
  watch: { kind: "url_value"; spec: UrlValueSpec } | { kind: "status_changes"; spec: StatusChangesSpec },
  guard: ConfidentialGuard,
  fetcher: PageFetcher,
): Promise<UrlReading> {
  const leaks = guard.check(watch.spec.url);
  if (leaks.length > 0) {
    return { ok: false, final: true, reason: `the address contains ${describeKinds(leaks)} from memory` };
  }
  let page: FetchedPage;
  try {
    page = await fetcher(watch.spec.url);
  } catch (error) {
    return { ok: false, final: false, reason: describeFetchError(error), ...(isTransientFetchError(error) ? { transient: true as const } : {}) };
  }
  if (page.status >= 400) {
    return {
      ok: false,
      final: false,
      reason: `the page answers with status ${page.status}`,
      // Disrupted is not wrong: on 429 or 5xx `watch_create` does not look for another page.
      ...(isTransientStatus(page.status) ? { transient: true as const } : { wrongPage: true as const }),
    };
  }

  if (watch.kind === "url_value") {
    const result = extractValue(page.text, watch.spec.anchor);
    if (!result.ok) {
      return {
        ok: false,
        final: false,
        wrongPage: true,
        reason:
          result.reason === "anchor_missing"
            ? `"${watch.spec.anchor}" is not on the page`
            : `there is no number after "${watch.spec.anchor}"`,
      };
    }
    return { ok: true, kind: "value", value: result.value, url: page.url };
  }
  const result = extractSection(page.text, watch.spec.anchor);
  if (!result.ok) {
    return {
      ok: false,
      final: false,
      wrongPage: true,
      reason: result.reason === "anchor_missing" ? `"${watch.spec.anchor ?? ""}" is not on the page` : "the page is empty",
    };
  }
  return { ok: true, kind: "status", section: result.section, hash: sectionHash(result.section), url: page.url };
}
