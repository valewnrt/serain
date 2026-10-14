import {
  COMPANION_PROTOCOL_VERSION,
  type CompanionErrorCode,
  type CompanionResponse,
  type CompanionResults,
  type CompanionTool,
} from "./protocol.js";

/**
 * Serain's side of the Mac companion (D28). The Mac appears on the server as a
 * loopback port as long as its SSH tunnel is up. When it is not (Mac closed, no
 * network), that is no error but the normal case: `CompanionOffline`, and
 * Serain tells the owner.
 */
export class CompanionOffline extends Error {
  constructor() {
    super("The Mac is not reachable right now.");
    this.name = "CompanionOffline";
  }
}

export class CompanionFailure extends Error {
  constructor(
    readonly code: CompanionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CompanionFailure";
  }
}

export interface Companion {
  call<T extends CompanionTool>(tool: T, args: Record<string, unknown>, timeoutMs?: number): Promise<CompanionResults[T]>;
  /** Which tools the Mac offers right now. Throws `CompanionOffline` when it is not there. */
  hello(): Promise<{ version: number; tools: string[] }>;
}

/**
 * Remembers whether the Mac was reachable on the last attempt, for the
 * `<context>` (audit 2026-10-05). Only "not reachable" counts: a refused call
 * means the Mac was there.
 */
export function trackedCompanion(base: Companion, onReachable: (reachable: boolean) => void): Companion {
  const watch = async <T>(work: Promise<T>): Promise<T> => {
    try {
      const result = await work;
      onReachable(true);
      return result;
    } catch (error) {
      onReachable(!(error instanceof CompanionOffline));
      throw error;
    }
  };
  return {
    call: (tool, args, timeoutMs) => watch(base.call(tool, args, timeoutMs)),
    hello: () => watch(base.hello()),
  };
}

const CONNECT_ERRORS = new Set(["ECONNREFUSED", "ECONNRESET", "EPIPE", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT"]);

function isOffline(error: unknown): boolean {
  const cause = (error as { cause?: { code?: string } }).cause;
  return (error as Error).name === "TimeoutError" || (cause?.code !== undefined && CONNECT_ERRORS.has(cause.code));
}

export function httpCompanion(options: { port: number; token: string; fetch?: typeof fetch }): Companion {
  const fetchImpl = options.fetch ?? fetch;
  const base = `http://127.0.0.1:${options.port}`;
  const headers = { authorization: `Bearer ${options.token}` };

  const request = async (path: string, init: RequestInit, timeoutMs: number): Promise<unknown> => {
    let response: Response;
    try {
      response = await fetchImpl(`${base}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      if (isOffline(error)) throw new CompanionOffline();
      throw new CompanionFailure("failed", "Connection to the Mac failed.");
    }
    // If the tunnel is up but the companion behind it is not, sshd answers with
    // a dropped connection; a 401 on the other hand means: wrong token.
    const body = (await response.json().catch(() => null)) as CompanionResponse | Record<string, unknown> | null;
    if (!body) throw new CompanionFailure("failed", "Response from the Mac not readable.");
    return body;
  };

  return {
    async hello() {
      const body = (await request("/v1/hello", { method: "GET", headers }, 4_000)) as {
        ok?: boolean;
        version?: number;
        tools?: string[];
      };
      if (body.ok !== true) {
        const refused = body as { code?: CompanionErrorCode; error?: string };
        throw new CompanionFailure(refused.code ?? "failed", refused.error ?? "The Mac refused.");
      }
      if (body.version !== COMPANION_PROTOCOL_VERSION) {
        throw new CompanionFailure("failed", "The companion on the Mac does not match this version.");
      }
      return { version: body.version, tools: body.tools ?? [] };
    },

    async call(tool, args, timeoutMs = 30_000) {
      const body = (await request(
        "/v1/call",
        { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ tool, args }) },
        timeoutMs,
      )) as CompanionResponse;
      if (!body.ok) throw new CompanionFailure(body.code ?? "failed", body.error ?? "The Mac refused.");
      return body.result as never;
    },
  };
}
