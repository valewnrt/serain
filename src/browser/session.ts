import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beginWork } from "../health/work.js";
import { childEnv } from "../security/child-env.js";
import { chromium, devices, type Frame, type Locator, type Page, type Request } from "playwright-core";
import {
  BROWSE_ACTION_TIMEOUT_MS,
  BROWSE_MAX_ELEMENTS,
  BROWSE_MAX_FRAMES,
  BROWSE_MAX_OPTIONS,
  BROWSE_PAGE_CALL_MS,
  BROWSE_FRAME_CALL_MS,
  BROWSE_GRACE_MS,
  BROWSE_HYDRATE_MS,
  BROWSE_QUIET_MS,
  BROWSE_SETTLE_MS,
  BROWSE_STATE_TEXT_CHARS,
  BROWSE_SUGGEST_MS,
  BROWSE_FIELD_RECHECK_MS,
  BROWSE_THIRD_PARTY_MS,
  BROWSE_WAIT_MS,
  FETCH_MAX_CHARS,
  SCREENSHOT_SCALE,
} from "../config/limits.js";
import { checkUrl } from "../executor/netguard.js";
import { bounded, inPage } from "./in-page.js";
import { armMutations, collectPage, findSuggestion, waitForQuiet, type CollectInput } from "./page-script.js";
import type { ActHelp, BrowserSession, PageSnapshot, PilotAction } from "./pilot.js";
import { startFilterProxy } from "./proxy.js";
import { captureShot, type ShotPicker } from "./shot.js";
import { valueForField } from "./values.js";
import { OWNER_TIMEZONE } from "../time.js";
import { owner } from "../config/owner.js";
import { currentLocale } from "../i18n/language.js";
import { PAYMENT_FIELD } from "../forms/classify.js";

/**
 * A browser session for the pilot (D35): an installed Chrome, driven by
 * Playwright. The same bolts as for rendering on the Mac (D28): a fresh
 * throwaway profile without cookies and logins, every connection through the
 * filter proxy (only public addresses, only 80 and 443), no downloads, no
 * permissions, hard time limits.
 */

/** The element from the snapshot no longer exists: the page has been rebuilt since. Look again, do not give up. */
export class StaleElementError extends Error {
  constructor() {
    super("The element is no longer on the page.");
    this.name = "StaleElementError";
  }
}

export class BrowseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowseError";
  }
}

const ATTRIBUTE = "data-serain-id";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Cookie dialogs lie over the page and swallow every click (live test 2026-09-20: on rmv.de every click ran
 * into the timeout). They are clicked away beforehand, fixed in code instead of through the pilot, and always
 * with the most frugal choice: reject or only what is necessary. If there is only "accept", the dialog stays;
 * nobody consents here on the owner's behalf. English and German, plus the common wording of the big consent
 * tools in French, Spanish, Italian, Dutch, Portuguese, Polish and Turkish; in any other language the dialog
 * stays and the pilot sees it as elements (its rules prefer reject). Playwright finds the buttons in shadow DOM
 * and in embedded frames too.
 */
const CONSENT_DECLINE = new RegExp(
  [
    String.raw`^(alle[s]? )?(ablehnen|verweigern)$`,
    String.raw`^nur (notwendige|erforderliche|essenzielle)( cookies)?( akzeptieren| zulassen| erlauben)?$`,
    String.raw`^(reject|decline) all( cookies)?$`,
    String.raw`^(only )?(necessary|essential)( cookies)?( only)?$`,
    String.raw`^ablehnen und schlie(ß|ss)en$`,
    String.raw`^alle optionalen ablehnen$`,
    String.raw`^(tout refuser|refuser tout|refuser)$`,
    String.raw`^(rechazar todo|rechazar todas|rechazar)$`,
    String.raw`^(rifiuta tutto|rifiuta tutti|rifiuta)$`,
    String.raw`^(alles weigeren|alle weigeren|weigeren)$`,
    String.raw`^(rejeitar tudo|rejeitar todos|recusar tudo|rejeitar)$`,
    String.raw`^(odrzuć wszystkie|odrzuć wszystko|odrzuć)$`,
    String.raw`^(tümünü reddet|hepsini reddet|reddet)$`,
  ].join("|"),
  "iu",
);

/**
 * The browser's language (`Accept-Language`, `navigator.language`): the owner's current language, with the
 * owner's country as region when the language tag has none (`tr` and `DE` → `tr-DE`), so pages come in the
 * language the owner reads and with the right local formats.
 */
export function browserLocale(locale: string = currentLocale(), country: string | null = owner.country): string {
  try {
    const parsed = new Intl.Locale(locale);
    if (!parsed.region && country) return new Intl.Locale(parsed.language, { region: country }).toString();
    return parsed.toString();
  } catch {
    return "en";
  }
}

async function dismissConsent(page: Page, dead: Set<Frame>): Promise<boolean> {
  // All frames at once, each with a short limit: a frame that never loads does not hold up the others.
  const found = await Promise.all(
    page.frames().filter((frame) => !dead.has(frame)).map(async (frame) => {
      const button = frame.getByRole("button", { name: CONSENT_DECLINE }).first();
      try {
        return (await bounded(button.count(), BROWSE_FRAME_CALL_MS)) > 0 ? button : null;
      } catch {
        dead.add(frame);
        return null;
      }
    }),
  );
  for (const button of found) {
    if (!button) continue;
    try {
      await button.click({ timeout: 2_000 });
      return true;
    } catch {
      // Not clickable: then the dialog stays, and the pilot sees it as elements.
    }
  }
  return false;
}

export interface LaunchOptions {
  /**
   * A fixed profile instead of a throwaway one: for logged-in sessions (D36),
   * so a login is not needed again for every task. Not deleted after the
   * session.
   */
  profileDir?: string;
  /** May the main page go to this host? Without it: anywhere the filter proxy lets through. */
  allowNavigation?: (hostname: string) => boolean;
}

export const openBrowserSession = (rawUrl: string, chromePath: string): Promise<BrowserSession> => launchSession(rawUrl, chromePath);

export async function launchSession(rawUrl: string, chromePath: string, options: LaunchOptions = {}): Promise<BrowserSession & { page: Page }> {
  const verdict = checkUrl(rawUrl);
  if (!verdict.ok) throw new BrowseError(verdict.reason);
  if (options.allowNavigation && !options.allowNavigation(verdict.url.hostname)) throw new BrowseError("This address does not belong to the site.");
  const profile = options.profileDir ?? (await mkdtemp(join(tmpdir(), "serain-browse-")));
  const proxy = await startFilterProxy();
  const cleanup = async () => {
    await proxy.close();
    if (!options.profileDir) await rm(profile, { recursive: true, force: true });
  };
  let page: Page;
  /** Status of the last loaded main document, for the snapshot. */
  let mainStatus: number | null = null;
  const popups: Page[] = [];
  let closeBrowser: () => Promise<void> = async () => undefined;
  /** An empty sheet to frame a screenshot (`src/browser/shot.ts`): no tab the session should follow. */
  let openSheet: () => Promise<Page> = () => Promise.reject(new Error("No browser."));
  // An open Chrome is work until the session closes: the deploy waits for it (src/health/work.ts).
  const endWork = beginWork("browser");
  try {
    const launch = {
      executablePath: chromePath,
      headless: true,
      // Otherwise Playwright starts Chrome with --no-sandbox. The sandbox is the
      // last layer between a foreign page and the machine (D28).
      chromiumSandbox: true,
      // Without `env` Chrome inherits the server's secrets (src/security/child-env.ts).
      env: childEnv(),
      proxy: { server: `http://127.0.0.1:${proxy.port}`, bypass: "<-loopback>" },
      acceptDownloads: false,
      permissions: [],
      serviceWorkers: "block" as const,
      locale: browserLocale(),
      timezoneId: OWNER_TIMEZONE,
      // Taller than needed for desktop layouts: more page per snapshot, fewer scroll steps.
      viewport: { width: 1280, height: 1000 },
      // Double resolution for screenshots that are sharp on the iPhone; the pilot reads text and notices nothing of it.
      deviceScaleFactor: SCREENSHOT_SCALE,
      // Cover for all tabs and frames: a regular desktop Chrome user agent without "Headless",
      // and Blink does not set `navigator.webdriver`.
      userAgent: devices["Desktop Chrome"]!.userAgent,
      args: ["--disable-blink-features=AutomationControlled", "--disable-extensions", "--disable-sync", "--disable-background-networking", "--disable-component-update", "--mute-audio", "--no-first-run"],
    };
    const context = await chromium.launchPersistentContext(profile, launch);
    closeBrowser = () => context.close();
    context.setDefaultTimeout(BROWSE_ACTION_TIMEOUT_MS);
    page = context.pages()[0] ?? (await context.newPage());
    const allow = options.allowNavigation;
    if (allow) {
      // Enforced in the browser, not in the prompt: the main page does not leave the allowed hosts.
      // Embedded resources (scripts, images) still only run through the filter proxy.
      await context.route("**/*", (route) => {
        const request = route.request();
        // Every main page, also that of an adopted tab (see `adopt`).
        const leaves = request.isNavigationRequest() && request.frame().parentFrame() === null && !allow(new URL(request.url()).hostname);
        return leaves ? route.abort("blockedbyclient") : route.continue();
      });
    }
    // Collect new tabs; after the action `perform` decides whether the session follows them.
    let sheets = 0;
    context.on("page", (popup) => void (sheets === 0 && popups.push(popup)));
    openSheet = async () => {
      sheets += 1;
      try {
        return await context.newPage();
      } finally {
        sheets -= 1;
      }
    };
    mainStatus = (await page.goto(verdict.url.toString(), { waitUntil: "domcontentloaded", timeout: 20_000 }))?.status() ?? null;
  } catch (error) {
    // The browser too: otherwise a blocked address leaves a Chrome without an owner behind.
    await closeBrowser().catch(() => undefined);
    endWork();
    await cleanup();
    throw new BrowseError(`The page could not be opened: ${(error as Error).message.split("\n")[0]}`);
  }

  /** Roughly the registrable domain: `shop.flixbus.de` and `www.flixbus.de` are the same site. */
  const site = (url: string) => {
    try {
      return new URL(url).hostname.split(".").slice(-2).join(".");
    } catch {
      return "";
    }
  };
  // What is loading right now and can still change the page: documents and script fetches. Not images, fonts and
  // tracking pixels; and whatever is still open after four seconds is permanent polling (pattern: browser-use
  // `dom_watchdog.py`). Scripts only count when an action triggered them: then the page is loading what should
  // react to the click (github.com opens its search only once its code is there). On first load ad scripts would join.
  const inflight = new Map<Request, { since: number; limitMs: number }>();
  let acting = false;
  /** Since when the page has been reacting to the last action. Null on first load. */
  let reactingSince: number | null = null;
  // And only what belongs to the site: on spiegel.de a dozen ad frames load their documents for cookie syncing after
  // every click, and every action therefore ran into the full wait (4 s, measured 2026-09-20). What counts is the
  // main document and fetches from frames of the same website (the timetable of rmv.de lives in one).
  const onRequest = (request: Request) => {
    const type = request.resourceType();
    if (!["document", "xhr", "fetch"].includes(type) && !(acting && type === "script")) return;
    let frame: Frame | null = null;
    try {
      frame = request.frame();
    } catch {
      return;
    }
    const top = frame.parentFrame() === null;
    if (type === "document" ? !top : !top && site(frame.url()) !== site(page.url())) return;
    // The main document and fetches to the own website count up to the limit. Fetches to foreign websites
    // (banners, tracking) after an action only at first: rmv.de asks for new banners every 100 ms, and every fetch
    // would have reset the clock (2026-10-02). On first load they count fully: there a foreign service often loads
    // the cookie dialog late, and a snapshot before it let the pilot type on wetter.com before the dialog covered
    // everything.
    const own = type === "document" || site(request.url()) === site(page.url());
    const now = Date.now();
    const limitMs = own || reactingSince === null ? BROWSE_SETTLE_MS : reactingSince + BROWSE_THIRD_PARTY_MS - now;
    if (limitMs > 0) inflight.set(request, { since: now, limitMs });
  };
  /** When a script triggered by an action last arrived. After that it takes a moment until it runs and rebuilds the page. */
  let lazyScriptAt = 0;
  const finished = (request: Request) => {
    if (inflight.delete(request) && request.resourceType() === "script") lazyScriptAt = Date.now();
  };
  const watch = (target: Page) => {
    target.on("response", (response) => {
      if (response.request().isNavigationRequest() && response.frame() === target.mainFrame()) mainStatus = response.status();
    });
    target.on("request", onRequest);
    target.on("requestfinished", finished);
    target.on("requestfailed", finished);
  };
  watch(page);
  popups.length = 0;

  /**
   * Did the action open a new tab? Flixbus shows the results in a new tab and sends the old one to an ad partner
   * (2026-09-20). The session follows the tab that belongs to the site; if only something foreign opens, it follows
   * it when the old tab stood still (then the new one was the click's effect), else not. It stays at one tab: the
   * other one is closed.
   */
  const adopt = async (urlBefore: string) => {
    const popup = popups.pop();
    for (const other of popups.splice(0)) void other.close().catch(() => undefined);
    if (!popup || popup.isClosed()) return;
    await popup.waitForLoadState("domcontentloaded", { timeout: BROWSE_SETTLE_MS }).catch(() => undefined);
    const follows = site(popup.url()) === site(urlBefore) || page.url() === urlBefore;
    if (!follows || popup.url() === "about:blank") return void popup.close().catch(() => undefined);
    const old = page;
    page = popup;
    watch(page);
    void old.close().catch(() => undefined);
  };
  const loading = () => {
    let open = false;
    for (const [request, { since, limitMs }] of inflight) {
      if (Date.now() - since > limitMs) inflight.delete(request);
      else open = true;
    }
    return open;
  };

  /** The page is done when it adds nothing new for a moment and loads nothing more. At most `BROWSE_SETTLE_MS`. */
  const settle = async (graceMs = BROWSE_QUIET_MS) => {
    const deadline = Date.now() + BROWSE_SETTLE_MS;
    while (Date.now() < deadline) {
      try {
        await page.waitForLoadState("domcontentloaded", { timeout: Math.max(1, deadline - Date.now()) });
        await inPage(page.mainFrame(), waitForQuiet, { quietMs: BROWSE_QUIET_MS, graceMs, maxMs: Math.max(1, Math.min(1_500, deadline - Date.now())) });
      } catch {
        // The action started a navigation and pulled the page away: wait for the new one.
        await sleep(50);
        continue;
      }
      if (!loading() && Date.now() - lazyScriptAt >= BROWSE_HYDRATE_MS) return;
      await sleep(80);
    }
  };
  // Only once the page's scripts are there does it react to clicks (github.com, 2026-09-20: the first click on
  // the search fizzled because the page was quiet but not wired up yet).
  await page.waitForLoadState("load", { timeout: 2_500 }).catch(() => undefined);
  await settle();

  /** The cookie dialog often comes only after loading: look before the first three snapshots per host. */
  /** Frames that did not answer a call (their document never arrived): do not ask again. */
  const deadFrames = new Set<Frame>();
  const consented = new Map<string, number>();
  const consent = async () => {
    const host = new URL(page.url()).host;
    const tries = consented.get(host) ?? 0;
    if (tries >= 3) return;
    consented.set(host, tries + 1);
    if (await dismissConsent(page, deadFrames)) {
      consented.set(host, 3);
      await settle();
    }
  };

  /** Which element lies in which frame. Refilled with every snapshot. */
  let frameOf = new Map<number, Frame>();
  /** Where an embedded frame lies in the window: mouse clicks need the page's coordinates. */
  const frameOffset = new Map<Frame, { x: number; y: number }>();
  let types = new Map<number, string>();
  let scrollPoint = { x: 640, y: 500 };
  const locate = (id: number) => (frameOf.get(id) ?? page.mainFrame()).locator(`[${ATTRIBUTE}="${id}"]`);

  const collect = (frame: Frame, startId: number, maxElements: number, scale: number, ms?: number) => {
    const input: CollectInput = {
      attribute: ATTRIBUTE,
      maxElements,
      maxChars: Math.floor(FETCH_MAX_CHARS * scale),
      maxViewChars: Math.floor(BROWSE_STATE_TEXT_CHARS * scale),
      maxOptions: BROWSE_MAX_OPTIONS,
      startId,
      payment: PAYMENT_FIELD.source,
    };
    return inPage(frame, collectPage, input, ms);
  };

  return {
    get page() {
      return page;
    },
    screenshot: (picker?: ShotPicker) => captureShot(page, { ...(picker ? { picker } : {}), openSheet }),
    async snapshot() {
      await consent();
      let main: PageSnapshot;
      try {
        main = await collect(page.mainFrame(), 1, BROWSE_MAX_ELEMENTS, 1);
      } catch {
        // In the middle of a navigation: wait for the new page, once.
        await settle();
        main = await collect(page.mainFrame(), 1, BROWSE_MAX_ELEMENTS, 1);
      }
      frameOf = new Map(main.elements.map((element) => [element.id, page.mainFrame()]));
      // Embedded frames belong to the page: timetable forms, booking flows and payment pages often live
      // entirely in one (live test 2026-09-20: rmv.de, the pilot only saw the menu around it).
      // Measure first, all at once and with a short limit; only large, answering frames are read.
      const frames = page.frames().filter((frame) => frame !== page.mainFrame() && !deadFrames.has(frame) && !frame.isDetached());
      const boxes = await Promise.all(
        frames.map((frame) =>
          bounded(frame.frameElement().then((element) => element.boundingBox()), BROWSE_FRAME_CALL_MS).catch(() => {
            deadFrames.add(frame);
            return null;
          }),
        ),
      );
      const large = frames.flatMap((frame, index) => {
        const box = boxes[index];
        return box && box.width >= 150 && box.height >= 100 ? [{ frame, box }] : [];
      });
      for (const { frame, box } of large.slice(0, BROWSE_MAX_FRAMES)) {
        const room = BROWSE_MAX_ELEMENTS - main.elements.length;
        if (room <= 0) break;
        try {
          frameOffset.set(frame, { x: box.x, y: box.y });
          const inner = await collect(frame, main.elements.length + 1, room, 0.5, BROWSE_FRAME_CALL_MS);
          for (const element of inner.elements) {
            frameOf.set(element.id, frame);
            // Coordinates in the frame; those of the page are needed.
            if (element.box) element.box = { ...element.box, x: element.box.x + Math.round(box.x), y: element.box.y + Math.round(box.y) };
          }
          main.elements.push(...inner.elements);
          // Payment fields in an embedded checkout count for the whole page.
          if (inner.payment) main.payment = true;
          // The frame first: for timetables and booking flows it is the content, the main document only menu
          // and footer. Appended, live on 2026-09-20 it was cut off behind 12,000 characters of menu, and the
          // executor reloaded the page three times to "read" the connections.
          if (inner.text) main.text = `[Embedded part]\n${inner.text}\n\n[Rest of the page]\n${main.text}`.slice(0, FETCH_MAX_CHARS);
          if (inner.view) main.view = `${inner.view}\n${main.view}`.slice(0, BROWSE_STATE_TEXT_CHARS);
        } catch {
          // A frame that is loading, disappears or never arrives is missing from this snapshot and the next ones.
          deadFrames.add(frame);
        }
      }
      types = new Map(main.elements.map((element) => [element.id, element.role ?? ""]));
      const centers = main.elements.flatMap((element) => (element.box ? [{ x: element.box.x + element.box.width / 2, y: element.box.y + element.box.height / 2 }] : []));
      const median = (values: number[]) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
      scrollPoint = { x: median(centers.map((center) => center.x)) ?? 640, y: Math.min(Math.max(median(centers.map((center) => center.y)) ?? 500, 200), 800) };
      if (mainStatus !== null) main.status = mainStatus;
      return main;
    },

    async act(action: PilotAction, text?: string, help?: ActHelp) {
      acting = true;
      reactingSince = Date.now();
      try {
        return await perform(action, text, help);
      } finally {
        acting = false;
      }
    },

    async close() {
      await closeBrowser().catch(() => undefined);
      endWork();
      await cleanup();
    },
  };

  async function perform(action: PilotAction, text?: string, help?: ActHelp): Promise<string | undefined> {
    {
      let note: string | undefined;
      const urlBefore = page.url();
      const reacts = action.op === "click" || action.op === "type" || action.op === "select" || action.op === "enter";
      if (reacts) await inPage(page.mainFrame(), armMutations, null).catch(() => undefined);
      if (action.op === "wait") await sleep(BROWSE_WAIT_MS);
      else if (action.op === "scroll" || action.op === "scroll_up") {
        // The wheel scrolls whatever lies under the mouse, also a menu or a list with its own scroll bar. So go where
        // the operable things are: with an open menu (spiegel.de: the sections stand below the menu's edge) everything
        // reachable lies in the menu, else roughly in the middle of the page.
        await page.mouse.move(scrollPoint.x, scrollPoint.y);
        await page.mouse.wheel(0, action.op === "scroll" ? 800 : -800);
        await sleep(120);
      } else if (action.op === "back") await page.goBack({ waitUntil: "domcontentloaded" });
      else if ((await bounded(locate(action.id).count())) === 0) throw new StaleElementError();
      else if (action.op === "click") await click(locate(action.id));
      else if (action.op === "type") {
        const target = locate(action.id);
        const value = valueForField(text ?? "", types.get(action.id) ?? "");
        const frame = frameOf.get(action.id) ?? page.mainFrame();
        // What kind of field it is, asked once before typing: afterwards it is not the same element on some pages
        // (Wikipedia swaps the search field on the first key press), and the question ran into the two-second
        // limit there every time (2026-10-02).
        const before = await kind(target, BROWSE_ACTION_TIMEOUT_MS);
        try {
          await target.fill(value);
        } catch {
          if ((await bounded(target.count())) === 0) throw new StaleElementError();
          // Not a field in the browser's sense (a `div` that catches keys): click into it and type.
          await click(target);
          await page.keyboard.press("ControlOrMeta+A");
          await page.keyboard.type(value, { delay: 15 });
        }
        // A field with a suggestion list: the list comes after a pause of the page and a fetch, so wait longer and
        // look until entries are there (jev-ultrafast waits for `[role=option]` the same way).
        // And once more shortly after: a suggestion list sometimes only registers while typing (`aria-controls`).
        const after = await kind(target, BROWSE_FIELD_RECHECK_MS);
        const autocomplete = before.autocomplete || after.autocomplete;
        // Do not wait for quiet first: as soon as a matching entry is there, it is chosen. Until an entry matches, not
        // just until any is there: pages first show popular or recently searched items.
        // `stale`: the list of the previous search. Until the page has replaced it, it does not count as an answer
        // (rmv.de, after "Musterstadt", still shows the list for "Musterstadt(Main)", and "Musterstadt" stands in it too).
        const suggest = async (query: string, stale?: readonly string[]) => {
          const look = () => inPage(frame, findSuggestion, { attribute: ATTRIBUTE, id: action.id, typed: query }).catch((): ReturnType<typeof findSuggestion> => ({ options: 0 }));
          const old = (found: ReturnType<typeof findSuggestion>) => stale !== undefined && (found.rows ?? []).map((row) => row.text).join("\n") === stale.join("\n");
          if (!autocomplete) await settle();
          let found = await look();
          for (let waited = 0; autocomplete && (found.text === undefined || old(found)) && waited < BROWSE_SUGGEST_MS; waited += 100) {
            await sleep(100);
            found = await look();
          }
          return found;
        };
        let picked = await suggest(value);
        if (picked.options === 0 && autocomplete) {
          // Some suggestion lists only listen to real keys, not to a set value.
          await target.fill("");
          await target.pressSequentially(value, { delay: 20 });
          picked = await suggest(value);
        }
        // When submitting, only a suggestion that is exactly what was typed counts; else Enter decides.
        // A search field is no choice field: its suggestion submits the search at once, and a second field (place,
        // category) would stay empty (kleinanzeigen.de). There a suggestion only counts when submitting, and only the exact one.
        const searchbox = before.searchbox || after.searchbox;
        const wanted = action.submit ? picked.exact : !searchbox;
        let spot: { text: string; x: number; y: number } | null =
          picked.text !== undefined && picked.x !== undefined && picked.y !== undefined ? { text: picked.text, x: picked.x, y: picked.y } : null;
        // Unambiguous is an entry that is exactly what was typed, or the only entry of the list. Otherwise the session
        // asks whoever knows the goal (`ActHelp`): a list with several entries is a question about what is meant.
        const rows = picked.rows ?? [];
        const decisive = picked.exact === true || (rows.length === 1 && rows[0]!.all);
        // Only for text: a number (day, hour, postal code) is no name under which someone could mean something.
        if (wanted && !decisive && !action.submit && /\p{L}/u.test(value) && (rows.length > 0 || autocomplete) && help?.chooseSuggestion) {
          const choose = help.chooseSuggestion;
          const label = await bounded(target.evaluate((element) => element.getAttribute("aria-label") ?? (element as HTMLInputElement).labels?.[0]?.innerText ?? element.getAttribute("placeholder") ?? ""), BROWSE_PAGE_CALL_MS).catch(() => "");
          const field = label.trim().slice(0, 80);
          const ask = async (query: string, list: typeof rows) => {
            if (list.length === 0) return null;
            const index = await choose(query, field, list.map((row) => row.text)).catch(() => undefined);
            // If the question fails, the text comparison stays; a clear "none" means: choose nothing.
            return index === undefined ? undefined : index === null ? null : list[index]!;
          };
          const first = await ask(value, rows);
          if (first !== undefined) spot = first;
          // Nothing meant in the list: type less, like a human. Live on 2026-10-10 bahn.de suggested only stops with
          // "Main" in their name for "Musterstadt(Main)"; the station only for "Musterstadt".
          if (first === null || (first === undefined && rows.length === 0)) {
            let shown = rows.map((row) => row.text);
            for (const query of narrower(value)) {
              await target.fill("");
              await target.pressSequentially(query, { delay: 20 });
              const list = (await suggest(query, shown)).rows ?? [];
              shown = list.map((row) => row.text);
              const found = await ask(query, list);
              if (!found) continue;
              spot = found;
              note = `searched as "${query}"`;
              break;
            }
            // Without a hit the field holds what was typed again, not the shortened search.
            if (!spot && (await target.inputValue().catch(() => value)) !== value) await target.fill(value).catch(() => undefined);
          }
        }
        if (spot && wanted) {
          const offset = frameOffset.get(frame) ?? { x: 0, y: 0 };
          await page.mouse.click(offset.x + spot.x, offset.y + spot.y);
          note = `suggestion "${spot.text}" chosen${note ? `, ${note}` : ""}`;
        }
        // Enter through the keyboard, not through the element: some pages swap the field for another on the first
        // key press (Wikipedia), the focus stays, the number does not.
        else if (action.submit) await page.keyboard.press("Enter");
      } else if (action.op === "enter") await locate(action.id).press("Enter");
      else if (action.op === "select") await locate(action.id).selectOption({ index: action.option });
      await settle(reacts ? BROWSE_GRACE_MS : BROWSE_QUIET_MS);
      if (popups.length > 0) {
        await adopt(urlBefore);
        await settle();
      }
      return note;
    }
  }
}

/**
 * Shorter searches for a suggestion list that has nothing meant for what was typed: without a bracketed addition
 * ("Musterstadt(Main)" → "Musterstadt", "Frankfurt(Main)Hbf" → "Frankfurt Hbf"), then only the first word. Only text
 * with letters; numbers, dates and times are not shortened.
 */
export function narrower(value: string): string[] {
  if (!/\p{L}/u.test(value)) return [];
  const words = (text: string) => text.split(/[\s,;/]+/).filter(Boolean);
  const bare = words(value.replace(/\([^)]*\)|\[[^\]]*\]/g, " ")).join(" ");
  const head = words(bare || value)[0] ?? "";
  const seen = new Set([value.trim().toLowerCase()]);
  return [bare, head].filter((query) => query.length >= 3 && !seen.has(query.toLowerCase()) && seen.add(query.toLowerCase()));
}

/** Is the field a search, does it have a suggestion list? A field that does not exist (any more) is neither. */
async function kind(target: Locator, timeoutMs: number): Promise<{ autocomplete: boolean; searchbox: boolean }> {
  // `bounded` on top: on a frame whose document never arrives, Playwright's time limit would never come either.
  return bounded(
    target.evaluate(
      (element) => ({
        autocomplete:
          element.getAttribute("role") === "combobox" ||
          element.hasAttribute("aria-autocomplete") ||
          element.hasAttribute("aria-controls") ||
          element.hasAttribute("list"),
        searchbox: element.getAttribute("role") === "searchbox" || element.getAttribute("type") === "search",
      }),
      undefined,
      { timeout: timeoutMs },
    ),
    timeoutMs + BROWSE_FRAME_CALL_MS,
  ).catch(() => ({ autocomplete: false, searchbox: false }));
}

/**
 * Clicks like a human; if that does not take (an animation is still running, a transparent frame lies over it),
 * then without Playwright's checks, last by script. Covered elements are not offered at all (`page-script.ts`),
 * so a failure here is rarely real covering.
 */
async function click(target: Locator, patienceMs = BROWSE_ACTION_TIMEOUT_MS): Promise<void> {
  // Open target=_blank in the same tab: so it stays at one tab. Whatever still opens by script, `adopt` handles.
  await target.evaluate((element) => element.removeAttribute("target")).catch(() => undefined);
  try {
    await target.click({ timeout: patienceMs });
  } catch {
    try {
      await target.click({ force: true, timeout: 1_000 });
    } catch {
      await target.evaluate((element) => (element as HTMLElement).click());
    }
  }
}
