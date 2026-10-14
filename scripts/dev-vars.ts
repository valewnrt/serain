import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * What the setup scripts (`pnpm db:password`, `pnpm web …`) share: reading
 * and writing lines in `.dev.vars`, finding the Supabase project and the
 * management token. Runs on the owner's machine, never on the server.
 */

export const ROOT = resolve(import.meta.dirname, "..");
export const ROOT_VARS = join(ROOT, ".dev.vars");
export const WEB_VARS = join(ROOT, "web", ".dev.vars");

/** One line `NAME=value` from an env file, without quotes; empty if it is missing. */
export function readVar(file: string, name: string): string {
  if (!existsSync(file)) return "";
  const line = readFileSync(file, "utf8").split("\n").find((entry) => entry.startsWith(`${name}=`));
  return line ? line.slice(name.length + 1).trim().replace(/^["']|["']$/g, "") : "";
}

/** The set environment wins, otherwise `.dev.vars` (like `src/config/dotenv.ts`). */
export function setting(name: string): string {
  return process.env[name]?.trim() || readVar(ROOT_VARS, name);
}

/** Sets or replaces a line `NAME=value`; the file stays readable only by the current user. */
export function writeVar(file: string, name: string, value: string, comment: string): void {
  const lines = existsSync(file) ? readFileSync(file, "utf8").split("\n") : [];
  const index = lines.findIndex((entry) => entry.startsWith(`${name}=`));
  if (index >= 0) lines[index] = `${name}=${value}`;
  else lines.push(`# ${comment}`, `${name}=${value}`);
  writeFileSync(file, `${lines.join("\n").replace(/\n+$/, "")}\n`, { mode: 0o600 });
}

/** The project ID from `SUPABASE_URL` (`https://<id>.supabase.co`). */
export function projectRef(url = setting("SUPABASE_URL")): string {
  if (!url) throw new Error("SUPABASE_URL is missing in .dev.vars (https://<project-id>.supabase.co).");
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error(`SUPABASE_URL is not a URL: ${url}`);
  }
  const match = /^([a-z0-9]+)\.supabase\.co$/.exec(host);
  if (!match) throw new Error(`SUPABASE_URL does not point to a Supabase project (https://<project-id>.supabase.co): ${url}`);
  return match[1]!;
}

/** Keychain entry for the management token on macOS, when it should not live in a file. */
export const KEYCHAIN_SERVICE = "supabase-serain";

/**
 * Personal access token for the Supabase Management API
 * (supabase.com/dashboard/account/tokens). From `SUPABASE_ACCESS_TOKEN` or,
 * on macOS, from the keychain:
 *
 *   security add-generic-password -s supabase-serain -a "$USER" -w
 *
 * The token can change every project of the account; the keychain is a
 * better place than `.dev.vars`.
 */
export function managementToken(): string {
  const fromEnv = setting("SUPABASE_ACCESS_TOKEN");
  if (fromEnv) return fromEnv;
  if (process.platform === "darwin") {
    try {
      const token = execFileSync("/usr/bin/security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      if (token) return token;
    } catch {
      // No entry: abort below with a hint.
    }
  }
  throw new Error(
    `No Supabase management token. Set SUPABASE_ACCESS_TOKEN in .dev.vars${process.platform === "darwin" ? ` or store it in the keychain (security add-generic-password -s ${KEYCHAIN_SERVICE} -a "$USER" -w)` : ""}.`,
  );
}
