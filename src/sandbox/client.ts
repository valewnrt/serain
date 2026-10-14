import net from "node:net";

/**
 * Client of the sandbox helper (D8.7, D20). Serain never starts a container
 * itself: the service is not in the group `docker` and never should be. It
 * sends a named job over a Unix socket to the helper
 * (`deploy/sandbox/helper.mjs`), which runs a fixed `docker run` without
 * network for it. The protocol is described there.
 *
 * Without a socket path there is no sandbox, and so neither `run_code` nor
 * attachments: a capability or no tool (D2 pattern), never an unsafe fallback.
 */

export type SandboxJob =
  | "python"
  | "node"
  | "compute"
  | "audio_to_text"
  | "text_to_voice"
  | "audio_to_voice"
  | "image_to_jpeg"
  | "pdf_to_text"
  | "pdf_to_pages"
  | "media_fetch"
  | "video_compact";

export interface SandboxRequest {
  job: SandboxJob;
  input: Buffer;
  timeoutMs: number;
  /**
   * Only for `text_to_voice`: the language of the voice (`de`, `en`). The
   * helper accepts only a language it has a fixed voice for (`PIPER_VOICES` in
   * src/media/speech.ts) and refuses every other job that names one.
   */
  language?: string;
  /** Resolves when nobody is waiting any more. The helper stops the container as soon as the connection is gone. */
  cancelled?: Promise<void>;
}

export interface SandboxResult {
  exitCode: number;
  timedOut: boolean;
  /** stdout was longer than allowed and is cut off. */
  truncated: boolean;
  stdout: Buffer;
  stderr: string;
}

export class SandboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxError";
  }
}

export interface Sandbox {
  run(request: SandboxRequest): Promise<SandboxResult>;
}

/** The client never waits longer than this, whatever the helper does. */
const CLIENT_GRACE_MS = 10_000;
const MAX_RESPONSE_HEADER = 16 * 1024;

export function socketSandbox(socketPath: string): Sandbox {
  return {
    run(request) {
      return new Promise<SandboxResult>((resolve, reject) => {
        const socket = net.createConnection(socketPath);
        // Collected, not reassembled on every piece: a video comes in thousands of pieces.
        const chunks: Buffer[] = [];
        let received = 0;
        let headerSeen = false;
        let settled = false;
        const settle = (action: () => void) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          socket.destroy();
          action();
        };
        const timer = setTimeout(
          () => settle(() => reject(new SandboxError("sandbox does not answer"))),
          request.timeoutMs + CLIENT_GRACE_MS,
        );
        void request.cancelled?.then(() => settle(() => reject(new SandboxError("cancelled"))));

        socket.on("connect", () => {
          const header = {
            job: request.job,
            inputBytes: request.input.length,
            timeoutMs: request.timeoutMs,
            ...(request.language === undefined ? {} : { language: request.language }),
          };
          socket.write(`${JSON.stringify(header)}\n`);
          socket.write(request.input);
        });
        socket.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
          received += chunk.length;
          // The first newline ends the header; until then it must not grow without bound.
          if (!headerSeen) headerSeen = chunk.indexOf(0x0a) >= 0;
          if (!headerSeen && received > MAX_RESPONSE_HEADER) {
            settle(() => reject(new SandboxError("sandbox response does not follow the protocol")));
          }
        });
        socket.on("error", (error) =>
          settle(() => reject(new SandboxError(`sandbox not reachable: ${error.message}`))),
        );
        socket.on("end", () => settle(() => {
          try {
            resolve(parseResponse(Buffer.concat(chunks, received)));
          } catch (error) {
            reject(error);
          }
        }));
      });
    },
  };
}

export function parseResponse(raw: Buffer): SandboxResult {
  const newline = raw.indexOf(0x0a);
  if (newline < 0) throw new SandboxError("sandbox response is incomplete");
  let header: Record<string, unknown>;
  try {
    header = JSON.parse(raw.subarray(0, newline).toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new SandboxError("sandbox response is not JSON");
  }
  if (header["ok"] !== true) throw new SandboxError(String(header["error"] ?? "sandbox refused"));
  const outputBytes = Number(header["outputBytes"] ?? 0);
  const stdout = raw.subarray(newline + 1);
  if (stdout.length !== outputBytes) throw new SandboxError("sandbox response is cut off");
  return {
    exitCode: Number(header["exitCode"] ?? -1),
    timedOut: header["timedOut"] === true,
    truncated: header["truncated"] === true,
    stdout,
    stderr: String(header["stderr"] ?? ""),
  };
}

/**
 * Input for the job `compute` (D58): one JSON line with the lengths, then the
 * code, then the files in the same order. The start program in the helper
 * stores each file under its ID.
 */
export function packCompute(code: string, files: ReadonlyArray<{ id: string; body: Buffer }>): Buffer {
  const source = Buffer.from(code, "utf8");
  const head = { code: source.length, files: files.map((file) => ({ id: file.id, size: file.body.length })) };
  return Buffer.concat([Buffer.from(`${JSON.stringify(head)}\n`), source, ...files.map((file) => file.body)]);
}

/** What the model sees of a program run: exit code, output, error output, shortened. */
export function describeRun(result: SandboxResult, maxChars: number): { ok: boolean; text: string } {
  const stdout = result.stdout.toString("utf8");
  const shown = stdout.slice(0, maxChars);
  const head = [
    result.timedOut ? "Time limit reached, stopped" : `Exit ${result.exitCode}`,
    result.truncated || shown.length < stdout.length ? "(output truncated)" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const text = [
    head,
    shown.trim() ? `Output:\n${shown.trim()}` : "No output.",
    result.stderr.trim() ? `Error output:\n${result.stderr.trim().slice(0, 1_500)}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  return { ok: !result.timedOut && result.exitCode === 0, text };
}
