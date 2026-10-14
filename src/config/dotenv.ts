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
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (process.env[key] !== undefined) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}
