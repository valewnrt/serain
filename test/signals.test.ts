import { describe, expect, it } from "vitest";
import { MODEL_SIGNALS, SIGNALS, signalEmoji } from "../src/channel/signals.js";

describe("status signals (addendum D23 of 2026-10-08)", () => {
  it("maps every signal to exactly one emoji, none twice", () => {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    for (const emoji of Object.values(SIGNALS)) {
      expect([...segmenter.segment(emoji)]).toHaveLength(1);
      expect(emoji).toMatch(/\p{Extended_Pictographic}/u);
    }
    expect(new Set(Object.values(SIGNALS)).size).toBe(Object.keys(SIGNALS).length);
  });

  it("is the table the owner chose", () => {
    expect(SIGNALS).toEqual({ ok: "👍", love: "❤️", haha: "😂", scheduled: "⏰", watching: "👀", working: "🔍", done: "✅", failed: "❌" });
    expect(MODEL_SIGNALS).toEqual(["ok", "love", "haha", "scheduled", "watching"]);
  });

  it("reads old entries without a signal as null", () => {
    expect(signalEmoji("scheduled")).toBe("⏰");
    expect(signalEmoji("👍")).toBeNull();
    expect(signalEmoji("toString")).toBeNull();
    expect(signalEmoji(undefined)).toBeNull();
  });
});
