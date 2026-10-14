import { renameSync, writeFileSync } from "node:fs";
import { log } from "../log.js";

/**
 * What the service is doing right now, reported by itself. `deploy/deploy.sh`
 * reads it before the restart: a restart in the middle of a turn or task
 * breaks it off, and the owner waits for an answer that never comes
 * (2026-09-20).
 *
 * Before, the deploy counted processes by name. Since the warm pool (D50),
 * however, prewarmed claude processes wait all the time doing nothing; the
 * deploy therefore always thought the service busy (2026-10-04). Now work is
 * counted, not processes: a prewarmed process only counts once a model call
 * takes it.
 *
 * - `inbound`: a message or reaction from the owner on its way into the queue.
 * - `turn`: the queue has a turn running or waiting in the window.
 * - `task`: a background task of the executor (D4).
 * - `attachment`: attachments being read right now (D20, D21).
 * - `followup`: follow-up after the answer (memory, budget notice).
 * - `model`: a running model call, no matter whose (also mail verdict, consolidation).
 * - `browser`: an open Chrome on the server (D35, D36).
 */
export type WorkKind = "inbound" | "turn" | "task" | "attachment" | "followup" | "model" | "browser";

export interface WorkReport {
  pid: number;
  updated_at: string;
  /** Sum over all kinds. 0 means: a restart breaks nothing off. */
  busy: number;
  work: Partial<Record<WorkKind, number>>;
}

const active = new Map<WorkKind, number>();
let reportFile: string | null = null;

/**
 * From now on write every change to `path` (null: only in memory). Under
 * systemd that is `/run/serain/work.json` (`RuntimeDirectory=`); the directory
 * disappears with the service, so no old state is left lying around.
 */
export function reportWorkTo(path: string | null): void {
  reportFile = path;
  write();
}

/** Starts a piece of work. The returned function ends it; called several times it counts once. */
export function beginWork(kind: WorkKind): () => void {
  active.set(kind, (active.get(kind) ?? 0) + 1);
  write();
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    const left = (active.get(kind) ?? 1) - 1;
    if (left > 0) active.set(kind, left);
    else active.delete(kind);
    write();
  };
}

/** `work` as work of kind `kind`, while it runs. */
export async function withWork<T>(kind: WorkKind, work: () => Promise<T>): Promise<T> {
  const end = beginWork(kind);
  try {
    return await work();
  } finally {
    end();
  }
}

export function workReport(): WorkReport {
  const work = Object.fromEntries(active) as Partial<Record<WorkKind, number>>;
  const busy = [...active.values()].reduce((sum, count) => sum + count, 0);
  return { pid: process.pid, updated_at: new Date().toISOString(), busy, work };
}

/**
 * Replace atomically: the deploy never reads half a file. If writing fails,
 * the service keeps running; a work report is no reason not to answer the
 * owner.
 */
function write(): void {
  if (!reportFile) return;
  const tmp = `${reportFile}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(workReport())}\n`, { mode: 0o644 });
    renameSync(tmp, reportFile);
  } catch (error) {
    log.warn(`Work report not written (${reportFile}):`, (error as Error).message);
  }
}
