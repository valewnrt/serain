import type { Frame, Page } from "playwright-core";
import {
  BROWSE_ACTION_TIMEOUT_MS,
  BROWSE_FRAME_CALL_MS,
  FILE_MAX_BYTES,
  SCREENSHOT_CHOOSE_MS,
  SCREENSHOT_CONTENT_CHARS,
  SCREENSHOT_EMPTY_EDGE,
  SCREENSHOT_HEADING_GAP,
  SCREENSHOT_IMAGES_MS,
  SCREENSHOT_JPEG_QUALITY,
  SCREENSHOT_MAX_HEIGHT,
  SCREENSHOT_MAX_REGIONS,
  SCREENSHOT_MAX_SCREENS,
  SCREENSHOT_OVERLAY_SHARE,
  SCREENSHOT_PAD,
  SCREENSHOT_REGION_CHARS,
} from "../config/limits.js";
import { bounded, inPage } from "./in-page.js";
import { frameShot, hideOverlays, restoreOverlays, settleImages, shotRegions, stageShot, unstageShot, type ShotLayout, type ShotRect, type ShotRegion } from "./page-script.js";

/**
 * Screenshots that are nice to look at (style round, 2026-10-09). Before, the
 * raw viewport of the window went to the owner: 1280 × 1000 at single resolution,
 * with header, menu, an empty ad slot and a webcam, the forecast a narrow strip
 * in the middle. Now in three steps:
 *
 * 1. **Choose.** The page names its blocks with text (`shotRegions`, also in
 *    large embedded frames), a `ShotPicker` chooses those that together show
 *    the answer: in the executor's browser Jev, block by block, against the
 *    task's goal (`jevPicker`, `relevantGroup`), in a logged-in session the
 *    code by a text the executor names (nothing goes to Typesafe there).
 * 2. **Isolate.** Only the blocks and the heading above them stay visible,
 *    everything else becomes transparent for the capture, in its place: the
 *    layout stays as the page wants it. Inside the block, ad slots, floating
 *    bubbles and empty edges drop out; a long list ends between two entries.
 * 3. **Set.** Breathing room all around in the page's colour, a long row of
 *    tiles (days of a forecast) as a grid that fits a phone; where the edge is
 *    colourful, as a card with round corners. Double resolution (the session
 *    runs with `SCREENSHOT_SCALE`) so text is sharp on the iPhone.
 *
 * If the picker chooses nothing or a step fails, there is the visible viewport
 * as before, without overlays, only framed. The page afterwards stands as it
 * did before, at the same position too: a logged-in session continues.
 */

export interface ShotPicker {
  /** A text that should be in the image: marks the blocks it appears in (`ShotRegion.focus`). */
  focus?: string;
  /**
   * If it chooses nothing, there is no image instead of the visible viewport: for pages not known to show what was
   * asked (the pilot did not surely reach the goal).
   */
  strict?: boolean;
  /**
   * The ids of the blocks that go into the image together (one, or a group side by side in the same frame), or
   * null for the visible viewport.
   */
  choose(regions: readonly ShotRegion[]): Promise<number[] | null>;
}

export interface ShotOptions {
  picker?: ShotPicker;
  /** A blank sheet in the same session to frame on. The caller does not close it, `captureShot` does. */
  openSheet(): Promise<Page>;
}

/** Marks the blocks to choose from. */
const REGION_ATTRIBUTE = "data-serain-shot";
/** Remembers the old `style` of what was changed for the capture. */
const STYLE_ATTRIBUTE = "data-serain-shot-style";
/** Marks what was hidden for the capture in the fallback case. */
const OVERLAY_ATTRIBUTE = "data-serain-overlay";

interface Raw {
  png: Buffer;
  layout: ShotLayout;
  /** What the chosen blocks show; without a choice (the visible viewport) nothing. */
  shows?: string;
}

/** A finished screenshot. `shows`: what it shows when blocks were chosen (`ShotRegion.content`). */
export interface Shot {
  jpeg: Buffer;
  shows?: string;
}

export async function captureShot(page: Page, options: ShotOptions): Promise<Shot> {
  const scale = await bounded(page.evaluate<number>("window.devicePixelRatio")).catch(() => 1);
  const chosen = options.picker ? await focused(page, options.picker).catch(() => null) : null;
  if (!chosen && options.picker?.strict) throw new Error("the page does not show what was asked");
  const raw = chosen ?? (await visible(page));
  const sheet = await options.openSheet();
  try {
    await inPage(sheet.mainFrame(), frameShot, { src: `data:image/png;base64,${raw.png.toString("base64")}`, scale, pad: SCREENSHOT_PAD, layout: raw.layout });
    const shot = sheet.locator("#shot");
    const done = (jpeg: Buffer): Shot => (raw.shows ? { jpeg, shows: raw.shows } : { jpeg });
    for (const quality of [SCREENSHOT_JPEG_QUALITY, 65, 45]) {
      const jpeg = await shot.screenshot({ type: "jpeg", quality, timeout: BROWSE_ACTION_TIMEOUT_MS * 3 });
      if (jpeg.length <= FILE_MAX_BYTES) return done(jpeg);
    }
    // A very long block: then at single resolution, rather blurry than not at all.
    const small = await shot.screenshot({ type: "jpeg", quality: 60, scale: "css", timeout: BROWSE_ACTION_TIMEOUT_MS * 3 });
    if (small.length <= FILE_MAX_BYTES) return done(small);
    throw new Error("The screenshot is too large for iMessage.");
  } finally {
    await sheet.close().catch(() => undefined);
  }
}

/**
 * The chosen block, isolated. Null when the picker chooses nothing. Blocks in
 * large embedded frames are candidates too: timetable lookups often live
 * entirely in one (a regional transit site). Then it isolates twice, the frame
 * on the page and the block in the frame, and converts the clip to the page.
 */
async function focused(page: Page, picker: ShotPicker): Promise<Raw | null> {
  const main = page.mainFrame();
  const markers = { attribute: REGION_ATTRIBUTE, mark: STYLE_ATTRIBUTE };
  const frames = [main, ...(await embedded(page))];
  // Afterwards the session stands where it stood: a logged-in one continues.
  const scroll = await bounded(page.evaluate<[number, number]>("[window.scrollX, window.scrollY]")).catch(() => null);
  try {
    const owner = new Map<number, Frame>();
    const regions: ShotRegion[] = [];
    for (const frame of frames) {
      const found = await inPage(frame, shotRegions, {
        attribute: REGION_ATTRIBUTE,
        max: SCREENSHOT_MAX_REGIONS - regions.length,
        excerptChars: SCREENSHOT_REGION_CHARS,
        contentChars: SCREENSHOT_CONTENT_CHARS,
        maxScreens: SCREENSHOT_MAX_SCREENS,
        startId: regions.length,
        ...(picker.focus ? { focus: picker.focus } : {}),
      }).catch(() => [] as ShotRegion[]);
      for (const region of found) owner.set(region.id, frame);
      regions.push(...found.map((region) => ({ ...region, frame: frames.indexOf(frame) })));
      if (regions.length >= SCREENSHOT_MAX_REGIONS) break;
    }
    if (regions.length === 0) return null;
    const chosen = await bounded(picker.choose(regions), SCREENSHOT_CHOOSE_MS);
    const frame = chosen?.[0] === undefined ? undefined : owner.get(chosen[0]);
    if (!chosen || !frame) return null;
    const ids = chosen.filter((id) => owner.get(id) === frame);
    const shows = ids.map((id) => regions.find((region) => region.id === id)?.content ?? "").filter(Boolean).join(" | ").slice(0, SCREENSHOT_CONTENT_CHARS);
    // What lay below the fold may not have loaded its images yet.
    await frame.locator(`[${REGION_ATTRIBUTE}="${ids[0]}"]`).scrollIntoViewIfNeeded({ timeout: BROWSE_ACTION_TIMEOUT_MS });
    await inPage(frame, settleImages, { attribute: REGION_ATTRIBUTE, ids, maxMs: SCREENSHOT_IMAGES_MS }, SCREENSHOT_IMAGES_MS + 1_000);
    let staged = await inPage(frame, stageShot, { ...markers, ids, headingGap: SCREENSHOT_HEADING_GAP, maxHeight: SCREENSHOT_MAX_HEIGHT, emptyEdge: SCREENSHOT_EMPTY_EDGE, inFrame: frame !== main });
    if (!staged) return null;
    if (frame !== main) {
      // On the page, the frame itself is the block: everything around it becomes transparent.
      const host = await frame.frameElement();
      await bounded(host.evaluate((element, attribute) => (element as Element).setAttribute(attribute, "-1"), REGION_ATTRIBUTE));
      const outer = await inPage(main, stageShot, { ...markers, ids: [-1], headingGap: 0, maxHeight: Number.MAX_SAFE_INTEGER, emptyEdge: SCREENSHOT_EMPTY_EDGE, inFrame: false });
      if (!outer) return null;
      const origin = { x: outer.block.x + outer.inset.x - staged.scroll.x, y: outer.block.y + outer.inset.y - staged.scroll.y };
      const move = (rect: ShotRect): ShotRect => ({ ...rect, x: rect.x + origin.x, y: rect.y + origin.y });
      staged = {
        ...staged,
        block: move(staged.block),
        heading: staged.heading ? move(staged.heading) : null,
        tiles: staged.tiles?.map(move) ?? null,
        gaps: staged.gaps.map((gap) => ({ ...gap, y: gap.y + origin.y })),
        pageWidth: outer.pageWidth,
        pageHeight: outer.pageHeight,
      };
    }
    const { block, heading, tiles, gaps } = staged;
    if (block.width < 1 || block.height < 1) return null;
    // With an edge as far as the page reaches: from it `frameShot` sees which colour the block sits on.
    const shown = heading ? union(block, heading) : block;
    const left = Math.max(0, shown.x - SCREENSHOT_PAD);
    const top = Math.max(0, shown.y - SCREENSHOT_PAD);
    const clip = { x: left, y: top, width: Math.min(staged.pageWidth, shown.x + shown.width + SCREENSHOT_PAD) - left, height: Math.min(staged.pageHeight, shown.y + shown.height + SCREENSHOT_PAD) - top };
    const png = await page.screenshot({ type: "png", fullPage: true, clip, timeout: BROWSE_ACTION_TIMEOUT_MS * 3 });
    const local = (rect: ShotRect): ShotRect => ({ ...rect, x: rect.x - left, y: rect.y - top });
    return {
      png,
      ...(shows ? { shows } : {}),
      layout: {
        block: local(block),
        heading: heading ? local(heading) : null,
        tiles: tiles ? tiles.map(local) : null,
        gaps: gaps.map((gap) => ({ ...gap, y: gap.y - top })),
        columns: tiles ? gridColumns(tiles, heading?.height ?? 0) : 1,
      },
    };
  } finally {
    for (const frame of frames) await inPage(frame, unstageShot, markers).catch(() => undefined);
    if (scroll) await bounded(page.evaluate(`window.scrollTo(${scroll[0]}, ${scroll[1]})`)).catch(() => undefined);
  }
}

/** Embedded frames large enough for an answer (as in the pilot's snapshot), at most three. */
async function embedded(page: Page): Promise<Frame[]> {
  const found: Frame[] = [];
  for (const frame of page.frames()) {
    if (frame === page.mainFrame() || frame.isDetached() || found.length >= 3) continue;
    const box = await bounded(frame.frameElement().then((element) => element.boundingBox()), BROWSE_FRAME_CALL_MS).catch(() => null);
    if (box && box.width >= 400 && box.height >= 300) found.push(frame);
  }
  return found;
}

/** The visible viewport, without what is fixed on top of it (ad windows, dimmers). */
async function visible(page: Page): Promise<Raw> {
  await page.evaluate(hideOverlays, { attribute: OVERLAY_ATTRIBUTE, minShare: SCREENSHOT_OVERLAY_SHARE }).catch(() => 0);
  try {
    const png = await page.screenshot({ type: "png", timeout: BROWSE_ACTION_TIMEOUT_MS * 3 });
    const size = page.viewportSize() ?? { width: 1280, height: 1000 };
    return { png, layout: { block: { x: 0, y: 0, ...size }, heading: null, tiles: null, gaps: [], columns: 1 } };
  } finally {
    await page.evaluate(restoreOverlays, { attribute: OVERLAY_ATTRIBUTE }).catch(() => undefined);
  }
}

const union = (a: ShotRect, b: ShotRect): ShotRect => {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
};

/**
 * How many columns a row of tiles gets as a grid: the count that makes the
 * image closest to square. On the phone iMessage shows a square image large
 * and a wide strip tiny.
 */
export function gridColumns(tiles: readonly ShotRect[], headingHeight: number): number {
  const width = Math.max(...tiles.map((tile) => tile.width));
  const height = Math.max(...tiles.map((tile) => tile.height));
  const gap = 8;
  let best = { columns: tiles.length, score: Infinity };
  for (let columns = 1; columns <= tiles.length; columns += 1) {
    const rows = Math.ceil(tiles.length / columns);
    const ratio = (columns * width + (columns - 1) * gap) / (rows * height + (rows - 1) * gap + headingHeight);
    const score = Math.abs(Math.log(ratio));
    if (score < best.score) best = { columns, score };
  }
  return best.columns;
}

/**
 * For logged-in sessions: the smallest block that contains `focus` and still
 * looks like a block, otherwise the smallest with the text at all. Without a
 * hit, the visible viewport.
 */
export function focusPicker(focus: string): ShotPicker {
  return {
    focus,
    choose: async (regions) => {
      const hits = regions.filter((region) => region.focus).sort((a, b) => a.width * a.height - b.width * b.height);
      const hit = hits.find((region) => region.width >= 280 && region.height >= 80) ?? hits[0];
      return hit ? [hit.id] : null;
    },
  };
}
