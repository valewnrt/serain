import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Locally, credentials and settings live in `.dev.vars` (gitignored); on the
 * server, systemd provides `/etc/serain/serain.env` as EnvironmentFile. Variables
 * that are already set always win: the file never overrides tests or systemd.
 */
let loaded = false;

export function loadDevVars(): void {
  if (loaded) return;
  loaded = true;
  const path = resolve(process.cwd(), ".dev.vars");
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return;
  }
  for (const [key, value] of Object.entries(parseEnv(raw))) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

/**
 * The lines `NAME=value` of an env file, as Serain reads them: comments and
 * blank lines skipped, value trimmed, one pair of surrounding quotes removed.
 * `pnpm setup:check` compares `.dev.vars` and the server's file with the same rules.
 */
export function parseEnv(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (key in result) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}
