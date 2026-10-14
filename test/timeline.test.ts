import { describe, expect, it } from "vitest";
import { timeMarkers } from "../src/agent/timeline.js";
import type { ChatTurn } from "../src/agent/model.js";

/** Time markers in the history (finding 2026-10-09). Synthetic. */
const turn = (at: string | undefined, role: ChatTurn["role"] = "user"): ChatTurn => ({ role, content: "x", ...(at ? { at } : {}) });

describe("timeMarkers", () => {
  it("sets the first marker and then only on a new day or a long pause", () => {
    const markers = timeMarkers([
      turn("2026-10-08T21:21:00Z"),
      turn("2026-10-08T21:22:00Z", "assistant"),
      turn("2026-10-08T21:32:00Z"),
      // 00:10 in Berlin: a new calendar day, although only 38 minutes later.
      turn("2026-10-08T22:10:00Z"),
      // The next morning.
      turn("2026-10-09T07:18:00Z"),
      turn("2026-10-09T07:40:00Z", "assistant"),
      turn("2026-10-09T08:10:00Z"),
    ]);
    expect(markers).toEqual([
      "[Thursday 8 October at 23:21]",
      null,
      null,
      "[Friday 9 October at 00:10]",
      "[Friday 9 October at 09:18]",
      null,
      "[Friday 9 October at 10:10]",
    ]);
  });

  it("skips notes without a point in time and counts the pause from the last message", () => {
    const markers = timeMarkers([turn("2026-10-08T21:21:00Z"), turn(undefined, "assistant"), turn("2026-10-08T21:40:00Z")]);
    expect(markers).toEqual(["[Thursday 8 October at 23:21]", null, null]);
  });

  it("without points in time the history stays as it was", () => {
    expect(timeMarkers([turn(undefined), turn(undefined, "assistant")])).toEqual([null, null]);
  });
});
