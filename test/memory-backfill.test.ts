import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BackfillRow, BackfillStore } from "../src/memory/backfill.js";

/**
 * The backfill (D13 addendum) catches up on embeddings for facts created before memory v1
 * without a vector. Tested here exclusively against a fake store and a fake
 * embedder, never against the real database or a real model call.
 * The facts below are synthetic, no real data.
 */

const auditMock = vi.fn(async () => undefined);
vi.mock("../src/db/audit.js", () => ({
  audit: (...args: unknown[]) => auditMock(...(args as [])),
}));

const { runBackfill, estimateCostUsd, DEFAULT_BACKFILL_COST_CAP_USD } = await import(
  "../src/memory/backfill.js"
);

class FakeBackfillStore implements BackfillStore {
  rows: Array<BackfillRow & { embedding: number[] | null }>;

  constructor(rows: Array<{ id: string; content: string; embedding?: number[] | null }>) {
    this.rows = rows.map((row) => ({ id: row.id, content: row.content, embedding: row.embedding ?? null }));
  }

  async factsWithoutEmbedding(): Promise<BackfillRow[]> {
    return this.rows
      .filter((row) => row.embedding === null)
      .map((row) => ({ id: row.id, content: row.content }));
  }

  async totalFactCount(): Promise<number> {
    return this.rows.length;
  }

  async writeEmbedding(id: string, embedding: number[]): Promise<void> {
    const row = this.rows.find((entry) => entry.id === id);
    if (!row) throw new Error(`unknown fact ID in the fake store: ${id}`);
    row.embedding = embedding;
  }
}

function fakeEmbedder(vectorFor: (text: string) => number[] = () => [1, 2, 3]) {
  const calls: string[][] = [];
  const embed = vi.fn(async (texts: readonly string[]) => {
    calls.push([...texts]);
    return texts.map((text) => vectorFor(text));
  });
  return { embed, calls };
}

function facts(n: number, prefix = "fakt"): Array<{ id: string; content: string }> {
  return Array.from({ length: n }, (_, i) => ({
    id: `${prefix}-${i}`,
    content: `synthetischer Testinhalt Nummer ${i}`,
  }));
}

beforeEach(() => {
  auditMock.mockClear();
});

describe("estimateCostUsd", () => {
  it("is 0 for no texts", () => {
    expect(estimateCostUsd([])).toBe(0);
  });

  it("grows with text length", () => {
    expect(estimateCostUsd(["x".repeat(1000)])).toBeGreaterThan(estimateCostUsd(["x".repeat(10)]));
  });
});

describe("runBackfill · dry-run", () => {
  it("writes nothing and never calls the embedder", async () => {
    const store = new FakeBackfillStore(facts(5));
    const { embed, calls } = fakeEmbedder();

    const result = await runBackfill({ store, embed, dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.totalMissing).toBe(5);
    expect(result.processed).toBe(0);
    expect(calls).toHaveLength(0);
    expect(store.rows.every((row) => row.embedding === null)).toBe(true);
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("shows an estimated cost greater than 0 when facts are missing", async () => {
    const store = new FakeBackfillStore(facts(3));
    const { embed } = fakeEmbedder();
    const result = await runBackfill({ store, embed, dryRun: true });
    expect(result.estimatedCostUsd).toBeGreaterThan(0);
  });
});

describe("runBackfill · real run", () => {
  it("writes only the embedding column, nothing else", async () => {
    const store = new FakeBackfillStore(facts(3));
    const before = store.rows.map((row) => ({ ...row }));
    const { embed } = fakeEmbedder((text) => [text.length, 1, 1]);

    const result = await runBackfill({ store, embed, dryRun: false });

    expect(result.processed).toBe(3);
    expect(result.remainingNull).toBe(0);
    for (const [i, row] of store.rows.entries()) {
      expect(row.id).toBe(before[i]?.id);
      expect(row.content).toBe(before[i]?.content); // content untouched
      expect(row.embedding).not.toBeNull();
    }
  });

  it("books an audit entry with the count, never with fact contents", async () => {
    const store = new FakeBackfillStore(facts(2));
    const { embed } = fakeEmbedder();

    await runBackfill({ store, embed, dryRun: false });

    expect(auditMock).toHaveBeenCalledTimes(1);
    const [event, detail] = auditMock.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(event).toBe("memory_backfill");
    expect(detail["processed"]).toBe(2);
    expect(JSON.stringify(detail)).not.toContain("synthetischer Testinhalt");
  });

  it("is idempotent: a second run finds nothing more and writes nothing", async () => {
    const store = new FakeBackfillStore(facts(4));
    const { embed, calls } = fakeEmbedder();

    const first = await runBackfill({ store, embed, dryRun: false });
    expect(first.processed).toBe(4);
    expect(auditMock).toHaveBeenCalledTimes(1);

    calls.length = 0;
    auditMock.mockClear();
    const second = await runBackfill({ store, embed, dryRun: false });

    expect(second.totalMissing).toBe(0);
    expect(second.processed).toBe(0);
    expect(calls).toHaveLength(0); // no embedder call
    expect(auditMock).not.toHaveBeenCalled(); // no audit entry for "nothing done"
  });

  it("leaves existing facts with an embedding untouched", async () => {
    const store = new FakeBackfillStore([
      { id: "hat-schon", content: "x", embedding: [9, 9, 9] },
      ...facts(2, "fehlt"),
    ]);
    const { embed } = fakeEmbedder();

    await runBackfill({ store, embed, dryRun: false });

    const untouched = store.rows.find((row) => row.id === "hat-schon");
    expect(untouched?.embedding).toEqual([9, 9, 9]);
  });

  it("stops before the cap and writes nothing at all if the first batch would already be too expensive", async () => {
    const store = new FakeBackfillStore(facts(50));
    const { embed, calls } = fakeEmbedder();

    const result = await runBackfill({ store, embed, dryRun: false, costCapUsd: 1e-12, batchSize: 10 });

    expect(result.capExceeded).toBe(true);
    expect(result.processed).toBe(0);
    expect(calls).toHaveLength(0);
    expect(store.rows.every((row) => row.embedding === null)).toBe(true);
    // No progress means: no audit entry, as in the no-op case.
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("processes what fits under the cap and reports the rest as skipped", async () => {
    const store = new FakeBackfillStore(facts(25));
    const { embed } = fakeEmbedder();
    const perBatchEstimate = estimateCostUsd(facts(10).map((f) => f.content));
    // The cap covers exactly one batch of 10, but not two.
    const costCapUsd = perBatchEstimate * 1.5;

    const result = await runBackfill({ store, embed, dryRun: false, costCapUsd, batchSize: 10 });

    expect(result.capExceeded).toBe(true);
    expect(result.processed).toBe(10);
    expect(result.skippedDueToCap).toBe(15);
    expect(store.rows.filter((row) => row.embedding !== null)).toHaveLength(10);
    expect(auditMock).toHaveBeenCalledTimes(1);
  });

  it("checks the row count at the end (self-check)", async () => {
    const store = new FakeBackfillStore(facts(6));
    const { embed } = fakeEmbedder();

    const result = await runBackfill({ store, embed, dryRun: false });

    expect(result.factCountBefore).toBe(6);
    expect(result.factCountAfter).toBe(6);
    expect(result.factCountBefore).toBe(result.factCountAfter);
  });

  it("throws if the cost cap is not positive", async () => {
    const store = new FakeBackfillStore(facts(1));
    const { embed } = fakeEmbedder();
    await expect(runBackfill({ store, embed, dryRun: false, costCapUsd: 0 })).rejects.toThrow(/cost cap/);
  });
});

describe("DEFAULT_BACKFILL_COST_CAP_USD", () => {
  it("is the default required by the task ($0.05)", () => {
    expect(DEFAULT_BACKFILL_COST_CAP_USD).toBe(0.05);
  });
});
