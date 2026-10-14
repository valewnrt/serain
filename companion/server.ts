import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  COMPANION_LIMITS,
  COMPANION_PROTOCOL_VERSION,
  COMPANION_TOOLS,
  isCompanionTool,
  type CompanionResponse,
  type CompanionResults,
  type CompanionTool,
} from "../src/companion/protocol.js";
import type { AppleRunner } from "./apple.js";
import { ToolFailure } from "./failure.js";

/**
 * The Mac companion (D28): a small HTTP service, loopback only, that offers a
 * fixed list of read-only tools. It does not trust the server: it checks token,
 * arguments, caps and rate itself, and it cannot do more than this list, no
 * matter who asks. No shell, no files, nothing that writes.
 */
export interface CompanionDeps {
  token: string;
  apple: AppleRunner;
  /** Null when the local browser is turned off in the configuration. */
  render: ((url: string) => Promise<CompanionResults["browser_render"]>) | null;
  log?: (line: string) => void;
  now?: () => number;
}

function sameToken(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function daysBetween(from: string, to: string): number {
  return (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
}

export function createCompanionServer(deps: CompanionDeps): Server {
  if (deps.token.length < 32) throw new Error("Companion token missing or too short");
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => undefined);
  let calls: number[] = [];

  const handlers: { [T in CompanionTool]: (args: never) => Promise<CompanionResults[T]> } = {
    calendar_events: async (args: { from: string; to: string }) => {
      const span = daysBetween(args.from, args.to);
      if (!(span >= 0 && span < COMPANION_LIMITS.calendarMaxDays)) {
        throw new ToolFailure("bad_request", `Invalid range or longer than ${COMPANION_LIMITS.calendarMaxDays} days.`);
      }
      return (await deps.apple(["calendar", args.from, args.to])) as unknown as CompanionResults["calendar_events"];
    },
    reminders_open: async (args: { list?: string }) =>
      (await deps.apple(args.list ? ["reminders", args.list] : ["reminders"])) as unknown as CompanionResults["reminders_open"],
    contacts_search: async (args: { query: string }) =>
      (await deps.apple(["contacts", args.query])) as unknown as CompanionResults["contacts_search"],
    browser_render: async (args: { url: string }) => {
      if (!deps.render) throw new ToolFailure("disabled", "The local browser is turned off on the Mac.");
      return deps.render(args.url);
    },
  };

  const send = (res: ServerResponse, status: number, body: CompanionResponse | Record<string, unknown>) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };

  const readBody = (req: IncomingMessage) =>
    new Promise<string>((resolve, reject) => {
      let size = 0;
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > COMPANION_LIMITS.maxBodyBytes) {
          reject(new ToolFailure("bad_request", "Request too large."));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      req.on("error", reject);
    });

  return createServer((req, res) => {
    void (async () => {
      // A web page in the owner's browser can call `fetch("http://127.0.0.1:…")`.
      // It does not have the token; on top of that, everything that looks like a
      // browser is rejected.
      if (req.headers.origin !== undefined || req.headers["sec-fetch-site"] !== undefined) {
        return send(res, 403, { ok: false, code: "unauthorized", error: "Not from a browser." });
      }
      const auth = req.headers.authorization ?? "";
      if (!auth.startsWith("Bearer ") || !sameToken(auth.slice(7), deps.token)) {
        log("rejected: wrong or missing token");
        return send(res, 401, { ok: false, code: "unauthorized", error: "Token missing or wrong." });
      }

      if (req.method === "GET" && req.url === "/v1/hello") {
        return send(res, 200, {
          ok: true,
          version: COMPANION_PROTOCOL_VERSION,
          tools: Object.keys(COMPANION_TOOLS).filter((tool) => tool !== "browser_render" || deps.render !== null),
        });
      }
      if (req.method !== "POST" || req.url !== "/v1/call") {
        return send(res, 404, { ok: false, code: "bad_request", error: "Unknown path." });
      }
      if (!(req.headers["content-type"] ?? "").startsWith("application/json")) {
        return send(res, 415, { ok: false, code: "bad_request", error: "Only application/json." });
      }

      calls = calls.filter((at) => now() - at < COMPANION_LIMITS.windowMs);
      if (calls.length >= COMPANION_LIMITS.callsPerWindow) {
        log("rejected: too many calls");
        return send(res, 429, { ok: false, code: "rate_limited", error: "Too many calls, try again shortly." });
      }
      calls.push(now());

      try {
        const parsed = JSON.parse(await readBody(req)) as { tool?: unknown; args?: unknown };
        if (typeof parsed.tool !== "string" || !isCompanionTool(parsed.tool)) {
          return send(res, 400, { ok: false, code: "unknown_tool", error: "This tool does not exist." });
        }
        const args = COMPANION_TOOLS[parsed.tool].safeParse(parsed.args ?? {});
        if (!args.success) {
          return send(res, 400, { ok: false, code: "bad_request", error: "Arguments do not match." });
        }
        // What gets logged is THAT something was asked, never what for and never the result.
        log(`call: ${parsed.tool}`);
        const result = await handlers[parsed.tool](args.data as never);
        return send(res, 200, { ok: true, result });
      } catch (error) {
        if (error instanceof ToolFailure) return send(res, 200, { ok: false, code: error.code, error: error.message });
        if (error instanceof SyntaxError) return send(res, 400, { ok: false, code: "bad_request", error: "Not JSON." });
        log(`error: ${(error as Error).name}`);
        return send(res, 200, { ok: false, code: "failed", error: "Something went wrong on the Mac." });
      }
    })();
  });
}
