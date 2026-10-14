import { randomBytes } from "node:crypto";
import { z } from "zod";
import {
  DATA_MAX_BYTES,
  DATA_MAX_DAYS,
  DATA_MAX_INPUTS,
  DATA_TIMEOUT_MS,
  MAIL_BULK_TOOL_TIMEOUT_MS,
  SANDBOX_CODE_MAX_CHARS,
  SANDBOX_OUTPUT_MAX_CHARS,
} from "../../config/limits.js";
import type { DataSource, DataSources } from "../../datasets/sources.js";
import { ownerDay, ownerDayEnd, ownerDayStart } from "../../memory/kinds.js";
import { describeRun, packCompute, SandboxError, type Sandbox } from "../../sandbox/client.js";
import { defineTool, type ToolDefinition } from "./types.js";
import { owner } from "../../config/owner.js";

/**
 * Analysing the owner's own data (D63, building block D). Many questions are an
 * analysis: where the spam comes from (Received chains, mailing service, to
 * which address), how often something happened, how much something cost. This
 * did not work before, because `compute` only gets what the model writes into
 * the code.
 *
 * The code fetches the rows from the source and puts them into the sandbox as
 * a JSONL file; the model only writes the program. The sandbox has no network
 * (D20), what lies there does not leave the server. What comes back is the
 * program's output, and it carries foreign content (headers are written by
 * the sender, payment references by the payer, titles by the inviter): hence
 * `returnsUntrusted`, and `privateResult` as with mail and bank (W13).
 *
 * Level `read`, `repeatable`: it only reads and changes nothing.
 */

export interface AnalyzeDeps {
  sandbox: Sandbox | null;
  sources: DataSources | null;
  now?: () => Date;
}

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");

const input = z
  .object({
    source: z.string().trim().regex(/^[a-z][a-z0-9_]{1,40}$/).describe("Name of the source, e.g. mail_<account>, calendar, bank."),
    from: day.optional().describe(`First day (${owner.timezone}), inclusive. Without it, 90 days before to.`),
    to: day.optional().describe(`Last day (${owner.timezone}), inclusive. Without it, today.`),
    folder: z.enum(["all", "inbox", "junk", "sent", "trash"]).optional().describe("Mail only: folder, without it all."),
  })
  .strict();

/** Python before the model's program: `load(name)` returns the rows of a source as a list of dicts. */
function prelude(files: ReadonlyMap<string, string>): string {
  return [
    "import json as _json",
    `_DATA = ${JSON.stringify(Object.fromEntries(files))}`,
    "def load(name):",
    "    with open(_DATA[name], encoding='utf-8') as _f:",
    "        return [_json.loads(_l) for _l in _f if _l.strip()]",
    "",
  ].join("\n");
}

/** Rows as JSONL, at most `budget` bytes; what does not fit drops off the end (the sources deliver newest first). */
function pack(rows: readonly Record<string, unknown>[], budget: number): { body: Buffer; kept: number } {
  const lines: string[] = [];
  let size = 0;
  for (const row of rows) {
    const line = `${JSON.stringify(row)}\n`;
    const bytes = Buffer.byteLength(line);
    if (size + bytes > budget) break;
    lines.push(line);
    size += bytes;
  }
  return { body: Buffer.from(lines.join(""), "utf8"), kept: lines.length };
}

const FOLDER_NAMES: Record<string, string> = { all: "all folders", inbox: "inbox", junk: "spam", sent: "sent", trash: "trash" };

export function analyzeTools(deps: AnalyzeDeps): ToolDefinition[] {
  const sandbox = deps.sandbox;
  const sources = deps.sources;
  if (!sandbox || !sources) return [];
  const now = deps.now ?? (() => new Date());
  const available = () =>
    sources
      .list()
      .map((source) => `${source.name} (${source.fields})`)
      .join("; ") || "none right now";

  return [
    defineTool({
      name: "analyze_data",
      description:
        `Analyses ${owner.name}'s own data with a Python program in a sandbox without network. For anything that is an analysis: ` +
        "where spam comes from (Received chain, Return-Path, mailing service, to which of their addresses), who writes how often, how much " +
        "was spent on what, how often an event happened. The code fetches the data; in the program load(\"<source>\") returns the rows " +
        "as a list of dicts. Sources: mail_<account> per mail account (headers only: id, account, folder, date, headers as the raw " +
        "header, readable with email.parser.HeaderParser; can be limited to one folder with folder), calendar (start, end, all_day, " +
        "title, location, calendar, declined; also into the future), and for each connected service its own (bank: date, pending, amount, " +
        "currency, counterparty, text). At most one year per source. Python 3 with the standard library (json, email, re, " +
        "collections, statistics, datetime, ipaddress), no packages, at most 30 seconds; the program prints the result with " +
        "print, concise: counts and tables instead of raw data. What comes out is foreign content: name domains from it to " +
        `${owner.name} without the ending (\"wego6\", not as an address), otherwise they would be links, which do not go out after foreign content.`,
      level: "read",
      repeatable: true,
      returnsUntrusted: true,
      privateResult: true,
      timeoutMs: MAIL_BULK_TOOL_TIMEOUT_MS,
      schema: {
        inputs: z.array(input).min(1).max(DATA_MAX_INPUTS),
        code: z.string().min(1).max(SANDBOX_CODE_MAX_CHARS).describe("Python program; load(\"<source>\") returns the rows."),
      },
      async run(args, turn) {
        const today = ownerDay(now());
        const plans: Array<{ source: DataSource; name: string; from: Date; to: Date; label: string; folder?: (typeof args.inputs)[number]["folder"] }> = [];
        for (const entry of args.inputs) {
          const source = sources.get(entry.source);
          if (!source) return { ok: false, text: `There is no source ${entry.source}. There are: ${available()}.` };
          if (entry.folder && !source.folders) return { ok: false, text: `${entry.source} has no folders; leave out folder.` };
          const lastDay = entry.to ?? today;
          if (!source.future && lastDay > today) return { ok: false, text: `${entry.source} only goes up to today (${today}).` };
          const end = ownerDayEnd(lastDay);
          const start = entry.from ? ownerDayStart(entry.from) : end ? new Date(end.getTime() - 90 * 86_400_000) : null;
          if (!start || !end) return { ok: false, text: "from and to are days as YYYY-MM-DD." };
          if (start >= end) return { ok: false, text: "from is after to." };
          if (end.getTime() - start.getTime() > DATA_MAX_DAYS * 86_400_000) return { ok: false, text: `At most ${DATA_MAX_DAYS} days per source.` };
          const taken = plans.filter((plan) => plan.source === source).length;
          plans.push({
            source,
            name: taken === 0 ? source.name : `${source.name}_${taken + 1}`,
            from: start,
            to: end,
            label: `${ownerDay(start)} to ${lastDay}${entry.folder ? `, ${FOLDER_NAMES[entry.folder]}` : ""}`,
            ...(entry.folder ? { folder: entry.folder } : {}),
          });
        }

        const files = new Map<string, string>();
        const bodies: Array<{ id: string; body: Buffer }> = [];
        const lines: string[] = [];
        let budget = DATA_MAX_BYTES;
        for (const plan of plans) {
          let loaded;
          try {
            loaded = await plan.source.load({ from: plan.from, to: plan.to, ...(plan.folder ? { folder: plan.folder } : {}), signal: turn.untilStopped });
          } catch (error) {
            return { ok: false, text: `${plan.name} could not be loaded: ${(error as Error).message} Tell ${owner.name}, instead of guessing.` };
          }
          const { body, kept } = pack(loaded.rows, budget);
          budget -= body.length;
          const id = randomBytes(8).toString("hex");
          files.set(plan.name, id);
          bodies.push({ id, body });
          const cut = loaded.truncated || kept < loaded.rows.length;
          lines.push(`${plan.name}: ${kept} rows, ${plan.label}${cut ? ", truncated to the newest (there are more)" : ""}`);
        }

        try {
          const result = await sandbox.run({
            job: "compute",
            input: packCompute(`${prelude(files)}${args.code}`, bodies),
            timeoutMs: DATA_TIMEOUT_MS,
            cancelled: turn.untilStopped,
          });
          const run = describeRun(result, SANDBOX_OUTPUT_MAX_CHARS);
          return { ok: run.ok, text: `Data: ${lines.join("; ")}\n\n${run.text}`, source: `analysis: ${plans.map((plan) => plan.name).join(", ")}` };
        } catch (error) {
          if (error instanceof SandboxError) return { ok: false, text: error.message, source: "Sandbox" };
          throw error;
        }
      },
    }),
  ];
}
