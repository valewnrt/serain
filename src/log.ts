/**
 * Logger that never lets secrets through. All known secrets are replaced by
 * `[redacted]` before output (D8.5), even when they accidentally appear in an
 * error text or a server response.
 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type LogLevel = keyof typeof LEVELS;

const secrets = new Set<string>();

/** Registers a value that must never appear in logs. */
export function redactValue(value: string | undefined | null): void {
  if (value && value.length >= 8) secrets.add(value);
}

function scrub(input: string): string {
  let out = input;
  for (const secret of secrets) {
    if (out.includes(secret)) out = out.split(secret).join("[redacted]");
  }
  // Key patterns we don't know but recognise.
  out = out.replace(/\b(sb_secret_|sb_publishable_|sk-or-v1-|sk-ant-(?:api|oat|admin)\d{2}-|cm_live_)[A-Za-z0-9_-]{6,}/g, "$1[redacted]");
  return out;
}

function format(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

let threshold: number = LEVELS.info;

export function setLogLevel(level: string): void {
  threshold = LEVELS[level as LogLevel] ?? LEVELS.info;
}

function emit(level: LogLevel, parts: unknown[]): void {
  if (LEVELS[level] < threshold) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${parts.map(format).join(" ")}`;
  const stream = LEVELS[level] >= LEVELS.warn ? process.stderr : process.stdout;
  stream.write(`${scrub(line)}\n`);
}

export const log = {
  debug: (...parts: unknown[]) => emit("debug", parts),
  info: (...parts: unknown[]) => emit("info", parts),
  warn: (...parts: unknown[]) => emit("warn", parts),
  error: (...parts: unknown[]) => emit("error", parts),
};
