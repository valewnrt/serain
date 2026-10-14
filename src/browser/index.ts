import { jevPicker, runPilot, type BrowserSession, type PilotResult } from "./pilot.js";
import { BROWSE_HARD_MARGIN_MS, BROWSE_TIMEOUT_MS, SCREENSHOT_CONTENT_CHARS } from "../config/limits.js";
import { BrowseError, openBrowserSession } from "./session.js";
import type { Shot } from "./shot.js";
import { typesafeClient, type SystemOne } from "./typesafe.js";
import { owner } from "../config/owner.js";

/**
 * The executor's browser for public pages (D35): Chrome on the server, Jev as
 * pilot. Exists only with both, an installed Chrome (`SERAIN_CHROME_PATH`) and
 * a Typesafe key; otherwise the tool is missing and the executor prompt does
 * not mention it (D2 pattern: capability or no tool).
 */
export interface WebBrowser {
  /**
   * `inputs`: the values that may be typed into fields. The caller has already filtered them (D29).
   * `screenshot`: take a screenshot at the end (addendum D48 of 2026-10-08), of the block Jev picks for the
   * goal (`src/browser/shot.ts`); if that fails, the reason is in `screenshotFailed` and the result still
   * counts.
   */
  browse(url: string, goal: string, inputs: readonly string[], options?: { screenshot?: boolean }): Promise<BrowseResult>;
}

export type BrowseResult = PilotResult & { screenshot?: Shot; screenshotFailed?: string };

/** Does the address point to a PDF? */
export function isPdfAddress(url: string): boolean {
  try {
    return /\.pdf$/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/** The site's start page when the address is a subpage; otherwise nothing. */
function startPage(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.pathname === "/" && !parsed.search ? null : `${parsed.origin}/`;
  } catch {
    return null;
  }
}

export function jevBrowser(options: {
  apiKey: string;
  chromePath: string;
  jev?: SystemOne;
  open?: (url: string, chromePath: string) => Promise<BrowserSession>;
}): WebBrowser {
  const jev = options.jev ?? typesafeClient(options.apiKey);
  const open = options.open ?? openBrowserSession;
  return { browse: run };

  async function run(url: string, goal: string, inputs: readonly string[], runOptions: { screenshot?: boolean } = {}): Promise<BrowseResult> {
    // A subaddress that does not exist (404, 503, not loadable): the executor guesses addresses, and the answer
    // is still on the site. Then once from its start page instead of handing the task back.
    const home = startPage(url);
    let preface: string | undefined;
    let session: BrowserSession;
    try {
      session = await open(url, options.chromePath);
      const first = home ? await session.snapshot() : null;
      if (home && first && (first.status ?? 200) >= 400) {
        await session.close();
        preface = `Address answered with ${first.status}, starting from ${home}`;
        session = await open(home, options.chromePath);
      }
    } catch (error) {
      if (!home || !(error instanceof BrowseError)) throw error;
      preface = `Address could not be opened, starting from ${home}`;
      session = await open(home, options.chromePath);
    }
    // The pilot checks its time limit between steps. This one also holds when a step itself never comes back:
    // a task may fail at the browser, but not hang on it.
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new BrowseError("The browser did not answer in time.")), BROWSE_TIMEOUT_MS + BROWSE_HARD_MARGIN_MS);
    });
    try {
      const result: BrowseResult = await Promise.race([runPilot(session, goal, { jev, inputs, ...(preface ? { preface } : {}) }), deadline]);
      if (!runOptions.screenshot) return result;
      // If the pilot did not surely reach the goal, there is only an image when Jev finds, block by block, something that
      // shows what was asked, and never the visible viewport as a substitute: live 2026-10-09 the owner got Chrome's grey
      // PDF area with ☹ that way. The same day the pilot got stuck on a booking site while the answer ("nothing left
      // that day") was already there, and a screenshot was missing although the page had it.
      const reached = result.outcome === "goal_met" || result.outcome === "done";
      // Live 2026-10-09: a PDF in the page's viewer, with toolbar and cut off halfway. If web_fetch reads it, the
      // owner gets every page whole as an image.
      if (isPdfAddress(result.page.url)) {
        return { ...result, screenshotFailed: `the page is a PDF; read it with web_fetch, then ${owner.name} gets every page whole as an image` };
      }
      if (!session.screenshot) return { ...result, screenshotFailed: "this browser cannot take screenshots" };
      try {
        const shot = await Promise.race([session.screenshot(jevPicker(jev, goal, result.page, { strict: !reached })), deadline]);
        // Without a chosen block the image shows the visible viewport, and the pilot read that last.
        const shows = shot.shows ?? result.page.view.slice(0, SCREENSHOT_CONTENT_CHARS);
        return { ...result, screenshot: shows ? { ...shot, shows } : shot };
      } catch (error) {
        return { ...result, screenshotFailed: (error as Error).message.split("\n")[0] ?? "unknown" };
      }
    } finally {
      clearTimeout(timer);
      await session.close();
    }
  }
}
