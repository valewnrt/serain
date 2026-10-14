import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { addedLines, fileLines, findValueHits, options, secretValues, treeFiles } from "../scripts/secret-scan.js";

// All values made up.
const PHONE = "+4915200007766";
const TOKEN = "sk-test-abcdefghijklmnop";

function diff(file: string, start: number, lines: string[]): string {
  return [`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`, `@@ -0,0 +${start},${lines.length} @@`, ...lines.map((line) => `+${line}`)].join("\n");
}

describe("secret scan: comparison with real values", () => {
  const secrets = secretValues({ OWNER_PHONE: PHONE, API_KEY: TOKEN, SERAIN_CHROME_PATH: "/usr/bin/chromium-browser", SHORT: "abc" });

  it("reads file and line of the added lines", () => {
    const lines = addedLines(diff("src/a.ts", 7, ["one", "two"]));
    expect(lines).toEqual([
      { file: "src/a.ts", line: 7, text: "one" },
      { file: "src/a.ts", line: 8, text: "two" },
    ]);
  });

  it("finds a key verbatim and names only the variable", () => {
    const hits = findValueHits(addedLines(diff("src/a.ts", 1, [`const key = "${TOKEN}";`])), secrets);
    expect(hits).toEqual([{ file: "src/a.ts", line: 1, name: "API_KEY" }]);
  });

  it("finds the number in other notations too", () => {
    const lines = addedLines(diff("docs/x.md", 1, ["+49 152 0000 7766", "0152/00007766", "4915200007766"]));
    expect(findValueHits(lines, secrets).map((hit) => hit.line)).toEqual([1, 2, 3]);
  });

  it("lets paths, short values and other numbers through", () => {
    const lines = addedLines(diff("src/a.ts", 1, ["/usr/bin/chromium-browser", "abc", "+4915100000000"]));
    expect(findValueHits(lines, secrets)).toEqual([]);
  });

  it("does not check removed lines", () => {
    const removed = ["--- a/src/a.ts", "+++ b/src/a.ts", "@@ -1,1 +0,0 @@", `-${TOKEN}`].join("\n");
    expect(findValueHits(addedLines(removed), secrets)).toEqual([]);
  });
});

describe("secret scan without git (--no-git)", () => {
  it("takes every line of a text file, but not binary content", () => {
    expect(fileLines("a.md", Buffer.from(`one\n${TOKEN}`))).toEqual([
      { file: "a.md", line: 1, text: "one" },
      { file: "a.md", line: 2, text: TOKEN },
    ]);
    expect(fileLines("image.png", Buffer.from([0x89, 0x50, 0x00, 0x47]))).toEqual([]);
    const hits = findValueHits(fileLines("a.md", Buffer.from(`x\n${TOKEN}`)), secretValues({ API_KEY: TOKEN }));
    expect(hits).toEqual([{ file: "a.md", line: 2, name: "API_KEY" }]);
  });

  it("walks the folder, skipping what never belongs in the repo, but with .env.example", () => {
    const root = mkdtempSync(join(tmpdir(), "secret-scan-"));
    for (const dir of ["src", "node_modules/x", "data", ".claude/worktrees/a", ".claude", "data.example"]) mkdirSync(join(root, dir), { recursive: true });
    for (const file of ["src/a.ts", "node_modules/x/b.js", "data/facts.json", ".claude/worktrees/a/c.ts", ".claude/settings.json", ".dev.vars", ".env", ".env.local", ".env.example", "data.example/facts.json"]) {
      writeFileSync(join(root, file), "x");
    }
    expect(treeFiles(root)).toEqual([".claude/settings.json", ".env.example", "data.example/facts.json", "src/a.ts"]);
  });
});

describe("public settings", () => {
  it("are not compared, while the owner's own values are", () => {
    const names = secretValues({ OWNER_TIMEZONE: "Europe/Berlin", SUPABASE_POOLER_HOST: "aws-0-eu-central-1.pooler.supabase.com", SERAIN_WEB_ORIGIN: "https://serain.example.com", OWNER_NAME: "Alexandra" }).map((entry) => entry.name);
    expect(names).toEqual(["SERAIN_WEB_ORIGIN", "OWNER_NAME"]);
  });
});

describe("options", () => {
  const root = resolve(import.meta.dirname, "..");

  it("checks this repository with its .dev.vars by default", () => {
    expect(options([])).toEqual({ git: true, repo: root, vars: resolve(root, ".dev.vars"), dir: root });
  });

  it("checks another repository with that repository's .dev.vars, unless --vars names one", () => {
    expect(options(["--repo", "/tmp/private"])).toMatchObject({ git: true, repo: "/tmp/private", vars: "/tmp/private/.dev.vars" });
    expect(options(["--repo", "/tmp/private", "--vars", "/tmp/other.env"])).toMatchObject({ repo: "/tmp/private", vars: "/tmp/other.env" });
  });

  it("refuses an unknown argument", () => {
    expect(() => options(["--force"])).toThrow(/unknown argument/);
  });
});
