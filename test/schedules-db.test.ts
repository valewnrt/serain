import { describe, expect, it, vi } from "vitest";

/** What `schedules` returns in Postgres: the inserted row, or a fixed list for `active()`. */
const stored: Array<Record<string, unknown>> = [];
vi.mock("../src/db/client.js", () => ({
  db: {
    from: () => ({
      insert: (row: Record<string, unknown>) => ({
        select: () => ({
          single: async () => {
            const data = { id: "s-1", prompt: row["prompt"], payload: row["payload"], next_run_at: row["next_run_at"], attempts: 0, created_at: "2027-03-27T22:00:00Z" };
            stored.push(data);
            return { data, error: null };
          },
        }),
      }),
      select: () => ({ in: () => ({ order: async () => ({ data: stored, error: null }) }) }),
    }),
  },
}));

const { scheduleStore } = await import("../src/db/schedules.js");

const base = { prompt: "x", attempts: 0, created_at: "2026-10-01T00:00:00Z" };

describe("schedules: the anchor is the intended wall time (D15, addendum 2026-10-10)", () => {
  it("stores 02:30 even if the first run is at 03:30, and reads it back that way", async () => {
    const row = await scheduleStore.insert({
      mode: "reminder",
      text: "x",
      repeat: "daily",
      nextRunAt: "2027-03-28T01:30:00.000Z",
      anchor: { year: 2027, month: 3, day: 28, hour: 2, minute: 30, millis: 17_400 },
      sourceMessageId: "db-1",
      taintSources: [],
    });
    expect((stored[0]!["payload"] as Record<string, unknown>)["anchor_wall"]).toBe("2027-03-28 02:30:17.400");
    expect(row.anchor).toEqual({ year: 2027, month: 3, day: 28, hour: 2, minute: 30, millis: 17_400 });
  });

  it("reads older entries as before: time of the first run, otherwise `next_run_at`", async () => {
    stored.length = 0;
    stored.push(
      { ...base, id: "a", payload: { repeat: "daily", anchor: "2026-10-09T07:00:12.500Z" }, next_run_at: "2026-10-11T07:00:12.500Z" },
      { ...base, id: "b", payload: { repeat: "daily" }, next_run_at: "2026-11-02T08:15:00.000Z" },
    );
    const [withInstant, without] = await scheduleStore.active();
    expect(withInstant!.anchor).toEqual({ year: 2026, month: 10, day: 9, hour: 9, minute: 0, millis: 12_500 });
    expect(without!.anchor).toEqual({ year: 2026, month: 11, day: 2, hour: 9, minute: 15, millis: 0 });
  });
});
