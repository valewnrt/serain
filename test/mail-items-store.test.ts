import { describe, expect, it, vi } from "vitest";

vi.mock("../src/db/client.js", () => ({ db: {} }));
vi.mock("../src/db/pg.js", () => ({ columns: () => "", pgRows: async () => [], pgRun: async () => undefined }));

const { commitment } = await import("../src/db/mail-items.js");

describe("Reading mail_items: a booking's appointment stays whole (addendum D62 of 2026-10-10)", () => {
  it("keeps the kind of booking, otherwise the sentence above the preview only says \"your booking\"", () => {
    const event = { title: "ICE nach Berlin", start: "2026-10-16 07:12", end: "2026-10-16 11:20", place: "Frankfurt (Main) Hbf", kind: "train" };
    expect(commitment({ what: "ICE nach Berlin", when: "Fr", due: null, event })?.event).toEqual(event);
  });

  it("drops an unknown kind instead of passing it through", () => {
    const event = { title: "Etwas", start: "2026-10-16", end: null, place: "", kind: "rakete" };
    expect(commitment({ what: "Etwas", when: "", due: null, event })?.event).toEqual({ title: "Etwas", start: "2026-10-16", end: null, place: "" });
  });
});
