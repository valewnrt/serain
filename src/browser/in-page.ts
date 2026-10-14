import type { Frame } from "playwright-core";
import { BROWSE_PAGE_CALL_MS, BROWSE_SETTLE_MS } from "../config/limits.js";

/**
 * As source text rather than a function: tsx (esbuild, keepNames) wraps inner functions in a helper `__name`
 * that does not exist in the page (measured 2026-09-20: "__name is not defined"). So the helper is passed
 * along; without tsx it simply goes unused.
 */
export const inPage = <Input, Output>(frame: Frame, run: (input: Input) => Output | Promise<Output>, input: Input, ms = BROWSE_PAGE_CALL_MS + BROWSE_SETTLE_MS): Promise<Output> =>
  bounded(frame.evaluate<Output>(`(() => { const __name = (fn) => fn; return (${run.toString()})(${JSON.stringify(input)}); })()`), ms);

/**
 * Playwright's `evaluate`, `count` and `frameElement` have no time limit: on a frame whose document never
 * arrives they wait forever (a news site, 2026-09-20: the snapshot never came back, and neither did the task).
 * No call into the page without a limit.
 */
export function bounded<T>(work: Promise<T>, ms = BROWSE_PAGE_CALL_MS): Promise<T> {
  let timer: NodeJS.Timeout;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`The page is not responding (${ms} ms).`)), ms);
  });
  // The original may fail later without bothering anyone.
  work.catch(() => undefined);
  return Promise.race([work, limit]).finally(() => clearTimeout(timer));
}
