import { describe, expect, it } from "vitest";
import type { ShotRegion } from "../src/browser/page-script.js";
import { jevPicker, relevantGroup } from "../src/browser/pilot.js";
import { focusPicker, gridColumns } from "../src/browser/shot.js";
import type { SystemOneAnswer, SystemOneQuestion } from "../src/browser/typesafe.js";

/** Screenshots to look at (style round, 2026-10-09): which block goes into the image and how a row of tiles wraps. */

/** A block to choose from; position and size in CSS pixels. */
const block = (id: number, x: number, y: number, width: number, height: number, extra: Partial<ShotRegion> = {}): ShotRegion => ({
  id,
  where: "in_view",
  x,
  y,
  width,
  height,
  text: `Block ${id}`,
  ...extra,
});

/** Scripted Jev: per block an estimate of whether it shows what the goal wants. */
function jevScoring(scores: Record<number, number>) {
  const calls: Array<{ state: unknown; questions: Record<string, SystemOneQuestion> }> = [];
  return {
    calls,
    jev: {
      ask: async (state: unknown, questions: Record<string, SystemOneQuestion>): Promise<Record<string, SystemOneAnswer>> => {
        calls.push({ state, questions });
        return Object.fromEntries(Object.keys(questions).map((key) => [key, { type: "noul", noul: scores[Number(key.slice(1))] ?? 0 } as SystemOneAnswer]));
      },
    },
  };
}

const score = (entries: Record<number, number>) => new Map(Object.entries(entries).map(([id, value]) => [Number(id), value]));

describe("jevPicker", () => {
  it("asks Jev in one request per block and returns the group", async () => {
    const regions = [block(0, 0, 0, 1145, 58, { text: "Ihr Wetter Regenradar Wetterkarten" }), block(1, 0, 400, 1151, 71, { text: "Fr 09.10. 10° 6° So 11.10. 14° 7°" })];
    const { jev, calls } = jevScoring({ 0: 0.02, 1: 0.95 });
    expect(await jevPicker(jev, "weather on Sunday in Kassel", { url: "https://www.wetter.com/kassel", title: "Wetter Kassel" }).choose(regions)).toEqual([1]);
    expect(calls).toHaveLength(1);
    expect(Object.keys(calls[0]!.questions)).toEqual(["b0", "b1"]);
    expect(calls[0]!.questions.b1!.type).toBe("noul");
    expect(calls[0]!.state).toEqual({ goal: "weather on Sunday in Kassel", page: { url: "https://www.wetter.com/kassel", title: "Wetter Kassel" } });
  });

  it("returns nothing when no block shows what the goal wants: then there is the visible viewport", async () => {
    const { jev } = jevScoring({ 0: 0.2, 1: 0.4 });
    expect(await jevPicker(jev, "goal of the search", { url: "https://example.org/", title: "Example" }).choose([block(0, 0, 0, 800, 200), block(1, 0, 300, 800, 200)])).toBeNull();
  });
});

describe("relevantGroup", () => {
  it("takes all connections of a lookup together, without notice lines as separators and without the map behind", () => {
    const regions = [
      block(7, 0, 158, 427, 762),
      block(10, 4, 314, 423, 112, { parent: 7 }),
      block(13, 4, 426, 423, 107, { parent: 7, text: "Info Halt entfällt" }),
      block(15, 0, 534, 427, 116, { parent: 7 }),
      block(18, 0, 650, 427, 112, { parent: 7 }),
      block(31, 0, 0, 1280, 920, { text: "Karte" }),
    ];
    expect(relevantGroup(regions, score({ 7: 0.55, 10: 0.94, 13: 0.08, 15: 0.93, 18: 0.92, 31: 0.89 }))).toEqual([10, 15, 18]);
  });

  it("splits at a large foreign area (webcam), but allows small links and gaps", () => {
    const regions = [
      block(1, 40, 600, 725, 335, { text: "Webcam" }),
      block(2, 40, 1000, 725, 222, { text: "Wie wird das Wetter Sonntag" }),
      block(3, 40, 1300, 725, 115, { text: "Morgens" }),
      block(4, 40, 1420, 725, 41, { text: "Alle Werte im Detail" }),
      block(5, 40, 1980, 725, 125, { text: "Mittags" }),
      block(6, 40, 200, 725, 120, { text: "Sonntag kurz" }),
    ];
    // 6 lies above the webcam: a group of its own, weaker. 3 and 5 are separated only by a link and an empty ad slot.
    expect(relevantGroup(regions, score({ 1: 0.05, 2: 0.8, 3: 0.85, 4: 0.19, 5: 0.86, 6: 0.82 }))).toEqual([2, 3, 5]);
  });

  it("rounds a table row up to the table with its header, but not to the whole section", () => {
    const regions = [block(7, 0, 0, 752, 1114), block(15, 0, 600, 752, 410, { parent: 7 }), block(17, 0, 680, 355, 327, { parent: 15 }), block(19, 0, 740, 354, 267, { parent: 17 })];
    expect(relevantGroup(regions, score({ 7: 0.92, 15: 0.96, 17: 0.96, 19: 0.96 }))).toEqual([17]);
  });

  it("takes only what lies near the best, and among equally strong groups the one where the browser stood", () => {
    const strip = block(5, 0, 545, 1151, 71);
    const today = block(17, 40, 1500, 724, 272);
    expect(relevantGroup([strip, today], score({ 5: 0.95, 17: 0.65 }))).toEqual([5]);
    const above = block(1, 0, 100, 800, 300, { where: "above" });
    const here = block(2, 0, 2000, 800, 300);
    expect(relevantGroup([above, here], score({ 1: 0.9, 2: 0.88 }))).toEqual([2]);
    expect(relevantGroup([above, here], score({ 1: 0.3, 2: 0.4 }))).toBeNull();
  });
});

describe("focusPicker", () => {
  const regions: ShotRegion[] = [
    block(0, 0, 0, 1200, 900, { text: "Mein Konto Bestellungen Bestellung 4711", focus: true }),
    block(1, 0, 100, 600, 240, { text: "Bestellung 4711 geliefert", focus: true }),
    block(2, 0, 120, 300, 40, { text: "Bestellung 4711", focus: true }),
    block(3, 0, 400, 600, 240, { text: "Bestellung 4712", focus: false }),
  ];

  it("takes the smallest block with the text that still looks like a block", async () => {
    expect(await focusPicker("Bestellung 4711").choose(regions)).toEqual([1]);
  });

  it("falls back to the smallest hit, and without a hit takes nothing", async () => {
    expect(await focusPicker("4711").choose([regions[2]!])).toEqual([2]);
    expect(await focusPicker("4799").choose([regions[3]!])).toBeNull();
  });
});

describe("gridColumns", () => {
  const tile = (x: number) => ({ x, y: 0, width: 164, height: 71 });

  it("wraps a weekly forecast into a grid that is almost square", () => {
    // Seven tiles of 164 × 71: two columns, four rows, instead of a strip of 1,150 × 71.
    expect(gridColumns([0, 1, 2, 3, 4, 5, 6].map((index) => tile(index * 165)), 40)).toBe(2);
  });

  it("keeps narrow, tall tiles side by side", () => {
    const tall = [0, 1, 2, 3].map((index) => ({ x: index * 100, y: 0, width: 90, height: 360 }));
    expect(gridColumns(tall, 0)).toBe(4);
  });
});
