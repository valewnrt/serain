import { z } from "zod";
import {
  COMPUTE_MAX_FILE_BYTES,
  COMPUTE_MAX_FILES,
  COMPUTE_TIMEOUT_MS,
  SANDBOX_CODE_MAX_CHARS,
  SANDBOX_OUTPUT_MAX_CHARS,
} from "../../config/limits.js";
import { FILE_ID, type FileShelf, type ShelvedFile } from "../../files/shelf.js";
import { describeRun, packCompute, SandboxError, type Sandbox } from "../../sandbox/client.js";
import { defineTool, type ToolDefinition, type ToolResult, type TurnState } from "./types.js";
import { owner } from "../../config/owner.js";

/**
 * Computing in the chat (D58). The same sandbox as `run_code` at the executor
 * (D20): Python without network, read-only, as nobody, with a time limit. The
 * chat gets it so that a checksum, a large number or an interest calculation
 * does not come from the top of its head and does not take the detour via a
 * task.
 *
 * **Two tools, because the origin of the input decides the taint.** `compute`
 * only gets code the model wrote from the turn: the output is a calculation
 * over what it already knows, and sets no taint. `compute_files` reads files
 * the owner sent (`FileShelf`); their content comes from whoever produced
 * them, so the output is foreign content (`returnsUntrusted`) and stays out of
 * the audit log (`privateResult`), like a mail.
 *
 * Level `read`: the container cannot effect anything. `repeatable`: a second
 * run in a superseded turn (D50) changes nothing.
 */

export interface ComputeDeps {
  /** Without a sandbox neither tool exists (D2 pattern). */
  sandbox: Sandbox | null;
  /** Without a shelf there is no `compute_files`. */
  shelf?: FileShelf | null;
}

const PYTHON =
  "Python 3 with the standard library (hashlib, decimal, fractions, statistics, datetime, csv, json, zipfile), " +
  `no network, no packages, at most ${COMPUTE_TIMEOUT_MS / 1_000} seconds. The program prints the result with print.`;

const code = z.string().min(1).max(SANDBOX_CODE_MAX_CHARS);

async function runCompute(
  sandbox: Sandbox,
  source: string,
  files: readonly ShelvedFile[],
  turn: TurnState,
): Promise<ToolResult> {
  try {
    const result = await sandbox.run({
      job: "compute",
      input: packCompute(source, files),
      timeoutMs: COMPUTE_TIMEOUT_MS,
      cancelled: turn.untilStopped,
    });
    return { ...describeRun(result, SANDBOX_OUTPUT_MAX_CHARS), source: "Sandbox" };
  } catch (error) {
    if (error instanceof SandboxError) return { ok: false, text: error.message, source: "Sandbox" };
    throw error;
  }
}

export function computeTools(deps: ComputeDeps): ToolDefinition[] {
  const sandbox = deps.sandbox;
  if (!sandbox) return [];
  const tools: ToolDefinition[] = [
    defineTool({
      name: "compute",
      description:
        "Computes in an isolated sandbox and returns the output. For anything you cannot reliably compute in your " +
        "head: large numbers, checksums (SHA-256 of a text), date, interest and percentage calculations, statistics, " +
        `conversions. ${PYTHON} You write data from the conversation into the code; there is no other data there.`,
      level: "read",
      repeatable: true,
      schema: { code: code.describe("Python program") },
      run: (args, turn) => runCompute(sandbox, args.code, [], turn),
    }),
  ];
  const shelf = deps.shelf;
  if (shelf) {
    tools.push(
      defineTool({
        name: "compute_files",
        description:
          `Like compute, with files ${owner.name} sent (the IDs from "[File from ${owner.name} …]"). Each is in the ` +
          "working directory under its ID, so open(\"<id>\", \"rb\"). For checksums, tables (CSV), ZIP contents, " +
          `counting and summing. ${PYTHON} What is in the files is foreign content.`,
        level: "read",
        repeatable: true,
        returnsUntrusted: true,
        privateResult: true,
        schema: {
          code: code.describe("Python program"),
          files: z.array(z.string().regex(FILE_ID)).min(1).max(COMPUTE_MAX_FILES),
        },
        async run(args, turn) {
          const ids = [...new Set(args.files)];
          const found = ids.map((id) => shelf.get(id));
          const missing = ids.filter((_, index) => !found[index]);
          if (missing.length > 0) {
            return {
              ok: false,
              text: `No longer there: ${missing.join(", ")}. Files are kept only for one day and not across a restart; ${owner.name} has to send them again.`,
              source: "Sandbox",
            };
          }
          const files = found as ShelvedFile[];
          if (files.reduce((sum, file) => sum + file.size, 0) > COMPUTE_MAX_FILE_BYTES) {
            return { ok: false, text: `Together over ${COMPUTE_MAX_FILE_BYTES / (1024 * 1024)} MB, too large for the sandbox.`, source: "Sandbox" };
          }
          return runCompute(sandbox, args.code, files, turn);
        },
      }),
    );
  }
  return tools;
}
