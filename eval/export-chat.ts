import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { db } from "../src/db/client.js";
import { env } from "../src/config/env.js";
import { LOCAL_CHAT_FILE } from "./config.js";
import type { ChatCase, HistoryTurn } from "./types.js";

/**
 * Pulls the latest real turns from Supabase `messages` into the local
 * eval file.
 *
 * **This file never goes into the repo.** It ends up under `data/eval/`, and `data/`
 * is in `.gitignore`. The style comparison is only worth something if it runs on
 * the owner's real language; their messages still have no place in the repo
 * (AGENTS.md: no real chat content).
 *
 *   pnpm eval:export-chat            # last 30 turns
 *   pnpm eval:export-chat --limit 50
 */

const DEFAULT_LIMIT = 30;
/** This many preceding messages come along into a case as context. */
const HISTORY_DEPTH = 6;

interface Row {
  id: string;
  direction: string;
  body: string;
  created_at: string;
}

function parseLimit(argv: string[]): number {
  const index = argv.indexOf("--limit");
  if (index === -1) return DEFAULT_LIMIT;
  const value = Number(argv[index + 1]);
  if (!Number.isInteger(value) || value < 1) throw new Error("--limit needs an integer > 0");
  return value;
}

async function main(): Promise<void> {
  const limit = parseLimit(process.argv.slice(2));
  // Fetch enough rows that every case also gets context.
  const window = limit * (HISTORY_DEPTH + 1);

  const { data, error } = await db
    .from("messages")
    .select("id, direction, body, created_at")
    .eq("peer", env.ownerPhone)
    .order("created_at", { ascending: false })
    .limit(window);
  if (error) throw new Error(`messages not readable: ${error.message}`);

  const rows = ((data ?? []) as Row[]).reverse();
  const cases: ChatCase[] = [];

  for (const [index, row] of rows.entries()) {
    if (row.direction !== "inbound") continue;
    const text = row.body?.trim() ?? "";
    if (!text) continue;
    const history: HistoryTurn[] = rows
      .slice(Math.max(0, index - HISTORY_DEPTH), index)
      .filter((previous) => (previous.body ?? "").trim().length > 0)
      .map((previous) => ({
        role: previous.direction === "inbound" ? ("user" as const) : ("assistant" as const),
        content: previous.body.trim(),
      }));
    cases.push({
      id: `real-${row.created_at.slice(0, 19).replace(/[:T]/g, "-")}`,
      input: text,
      ...(history.length > 0 ? { history } : {}),
    });
  }

  const picked = cases.slice(-limit);
  if (picked.length === 0) {
    console.error("No inbound messages found. Nothing written.");
    process.exitCode = 1;
    return;
  }

  const path = resolve(process.cwd(), LOCAL_CHAT_FILE);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(picked, null, 2)}\n`, "utf8");
  console.log(`${picked.length} real turns written to ${path}.`);
  console.log("The file stays local: data/ is gitignored and must stay so.");
}

main().catch((error: unknown) => {
  console.error((error as Error).message);
  process.exitCode = 1;
});
