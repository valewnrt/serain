/**
 * Secret scan before every commit (AGENTS.md, git workflow). Runs as
 * `.githooks/pre-commit`; set up once per checkout with
 *
 *   git config core.hooksPath .githooks
 *
 * Two checks over what is staged:
 *
 * 1. gitleaks with `.gitleaks.toml`: known key formats and German phone
 *    numbers.
 * 2. Every real value from `.dev.vars` verbatim, phone numbers also in other
 *    notations. This catches what has no pattern (your own number, the server
 *    address, a password), and never fires on made-up test values.
 *    Without `.dev.vars` this check is skipped with a notice.
 *
 * Without git, over a whole folder (say before the first commit or for an
 * export), with the values from another env file:
 *
 *   pnpm exec tsx scripts/secret-scan.ts --no-git [--vars <env-file>] [<folder>]
 *
 * For another repository, say the private one that holds your instance
 * (docs/INSTANCE.md), from its own pre-commit hook: its staged changes, its
 * `.gitleaks.toml` if it has one, and its `.dev.vars` unless `--vars` names
 * another file:
 *
 *   tsx <serain>/scripts/secret-scan.ts --repo <repository>
 *
 * Reported are file, line and variable name, never the value.
 * No script recognizes names of third parties and real chat content; those
 * remain a manual check.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "dotenv";

const ROOT = resolve(import.meta.dirname, "..");
/** Anything shorter matches by chance too easily, and no real credential is that short. */
const MIN_SECRET_LENGTH = 8;

export interface AddedLine {
  file: string;
  line: number;
  text: string;
}

export interface ValueHit {
  file: string;
  line: number;
  name: string;
}

/** The added lines from `git diff -U0`, with file and line number in the new state. */
export function addedLines(diff: string): AddedLine[] {
  const lines: AddedLine[] = [];
  let file = "";
  let next = 0;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+++ ")) {
      file = raw === "+++ /dev/null" ? "" : raw.slice(4).replace(/^b\//, "");
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      next = Number(hunk[1]);
      continue;
    }
    if (raw.startsWith("+") && file) {
      lines.push({ file, line: next, text: raw.slice(1) });
      next += 1;
    }
  }
  return lines;
}

/**
 * The forms in which a value can show up in the repo. A number rarely appears
 * exactly as in the env: `+49 151 …`, `0151/…` or digits only. It is then
 * compared against the line's digits.
 */
export function needles(value: string): { literal: string[]; digits: string[] } {
  const trimmed = value.trim();
  if (/^\+\d{8,15}$/.test(trimmed)) {
    const digits = trimmed.slice(1);
    // Country code has one to three digits; without it, with a leading zero (national).
    const national = [1, 2, 3].map((cc) => `0${digits.slice(cc)}`);
    return { literal: [], digits: [digits, ...national] };
  }
  return { literal: [trimmed], digits: [] };
}

/** Folders that never go into the repo (see .gitignore) or only hold dependencies and build output; paths relative to the scanned folder. */
const SKIPPED_DIRS = new Set([".git", "node_modules", "dist", ".wrangler", "data", "supabase/.temp", ".claude/worktrees"]);
/** Gitignored files with real values: holding secrets is their purpose. `.env.example` goes into the repo and is checked. */
const SKIPPED_FILES = /^(?:\.dev\.vars|\.env(?:\.(?!example$).+)?)$/;

/** All lines of a text file, in the format of `addedLines`. Binary content (a null byte near the start) does not count. */
export function fileLines(file: string, content: Buffer): AddedLine[] {
  if (content.subarray(0, 8000).includes(0)) return [];
  return content.toString("utf8").split("\n").map((text, index) => ({ file, line: index + 1, text }));
}

/** All files under `root`, relative to it, without the folders and files that never go into the repo. */
export function treeFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name) && !SKIPPED_DIRS.has(relative(root, path))) walk(path);
      } else if (entry.isFile() && !SKIPPED_FILES.test(entry.name)) {
        files.push(relative(root, path));
      }
    }
  };
  walk(root);
  return files.sort();
}

/**
 * Settings that are neither secret nor personal: a time zone, a country, a
 * budget, a public host name. Their values ("Europe/Berlin") stand in code and
 * tests on purpose. Whatever names the owner (name, city, phone, domain) stays
 * in the comparison.
 */
const PUBLIC_SETTINGS = new Set([
  "OWNER_TIMEZONE",
  "OWNER_COUNTRY",
  "OWNER_REGION",
  "OWNER_LANGUAGE",
  "ENABLE_BANKING_COUNTRY",
  "SERAIN_API_BUDGET_USD",
  "SERAIN_TOTAL_BUDGET_USD",
  "SERAIN_FIXED_COST_USD",
  "SERAIN_MEDIA_DOWNLOAD",
  "SERAIN_LOG_LEVEL",
  "SUPABASE_POOLER_HOST",
]);

/** Values from `.dev.vars` that can be a secret. Paths and public settings are not. */
export function secretValues(vars: Record<string, string>): Array<{ name: string; value: string }> {
  return Object.entries(vars)
    .filter(([name]) => !PUBLIC_SETTINGS.has(name))
    .map(([name, value]) => ({ name, value: value.trim() }))
    .filter(({ value }) => value.length >= MIN_SECRET_LENGTH && !value.startsWith("/"));
}

export function findValueHits(lines: AddedLine[], secrets: Array<{ name: string; value: string }>): ValueHit[] {
  const prepared = secrets.map(({ name, value }) => ({ name, ...needles(value) }));
  const hits: ValueHit[] = [];
  for (const line of lines) {
    const lineDigits = line.text.replace(/\D/g, "");
    for (const secret of prepared) {
      const found =
        secret.literal.some((needle) => line.text.includes(needle)) ||
        secret.digits.some((needle) => lineDigits.includes(needle));
      if (found) hits.push({ file: line.file, line: line.line, name: secret.name });
    }
  }
  return hits;
}

/**
 * gitleaks over what is staged (`git`) or over a whole folder (`dir`),
 * always with the repo's configuration. Started in the folder itself: the
 * paths in the allowlists of `.gitleaks.toml` are relative to it.
 */
function runGitleaks(repo: string, target: { staged: true } | { dir: string }): boolean {
  const args = "staged" in target ? ["git", "--staged"] : ["dir"];
  const config = existsSync(join(repo, ".gitleaks.toml")) ? join(repo, ".gitleaks.toml") : join(ROOT, ".gitleaks.toml");
  const result = spawnSync("gitleaks", [...args, "--no-banner", "--redact", "--config", config, "."], {
    cwd: "staged" in target ? repo : target.dir,
    stdio: "inherit",
  });
  if (result.error) {
    console.error("Secret scan: gitleaks is missing (github.com/gitleaks/gitleaks, e.g. brew install gitleaks). Aborting.");
    return false;
  }
  return result.status === 0;
}

export interface Options {
  git: boolean;
  /** The repository whose staged changes are checked. */
  repo: string;
  vars: string;
  dir: string;
}

export function options(argv: string[]): Options {
  const result: Options = { git: true, repo: ROOT, vars: "", dir: ROOT };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--no-git") result.git = false;
    else if (arg === "--repo" && argv[index + 1]) result.repo = resolve(argv[(index += 1)]!);
    else if (arg === "--vars" && argv[index + 1]) result.vars = resolve(argv[(index += 1)]!);
    else if (!arg.startsWith("-") && !result.git) result.dir = resolve(arg);
    else throw new Error(`Secret scan: unknown argument ${arg}. Usage: secret-scan.ts [--repo <repository>] [--no-git [--vars <env-file>] [<folder>]]`);
  }
  if (!result.vars) result.vars = resolve(result.repo, ".dev.vars");
  return result;
}

function main(): void {
  const opts = options(process.argv.slice(2));
  const gitleaksOk = runGitleaks(opts.repo, opts.git ? { staged: true } : { dir: opts.dir });

  const varsName = relative(process.cwd(), opts.vars) || opts.vars;
  let valueHits: ValueHit[] = [];
  if (existsSync(opts.vars)) {
    const lines = opts.git
      ? addedLines(execFileSync("git", ["diff", "--cached", "-U0", "--no-color", "--no-ext-diff"], { cwd: opts.repo, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }))
      : treeFiles(opts.dir).flatMap((file) => fileLines(file, readFileSync(join(opts.dir, file))));
    valueHits = findValueHits(lines, secretValues(parse(readFileSync(opts.vars))));
    for (const hit of valueHits) console.error(`Secret scan: ${hit.file}:${hit.line} contains the value of ${hit.name} from ${varsName}`);
  } else {
    console.error(`Secret scan: no ${varsName}, skipping the comparison with real values.`);
  }

  if (!gitleaksOk || valueHits.length > 0) {
    console.error(`Secret scan: ${opts.git ? "commit aborted" : "hits found"}. Values belong in .dev.vars, .env or Supabase, never in the repo.`);
    process.exit(1);
  }
  if (!opts.git) console.log(`Secret scan: ${relative(process.cwd(), opts.dir) || "."} has no hits.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
