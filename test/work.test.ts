import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { beginWork, reportWorkTo, withWork, workReport } from "../src/health/work.js";

const ROOT = resolve(import.meta.dirname, "..");

/** Exactly the script deploy.sh uses before the restart to ask whether Serain is working. */
function deployCheck(file: string): string {
  const script = readFileSync(resolve(ROOT, "deploy/deploy.sh"), "utf8");
  const match = /^work_state\(\) \{\n {2}node -e '([^']*)' \/run\/serain\/work\.json$/m.exec(script);
  if (!match?.[1]) throw new Error("work state query not found in deploy.sh");
  return execFileSync("node", ["-e", match[1], file], { encoding: "utf8" }).trim();
}

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "serain-work-"));
  file = join(dir, "work.json");
});

afterEach(() => {
  reportWorkTo(null);
  rmSync(dir, { recursive: true, force: true });
});

describe("work state (src/health/work.ts)", () => {
  it("counts work, not processes, and writes every change", () => {
    reportWorkTo(file);
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ pid: process.pid, busy: 0, work: {} });

    const endTurn = beginWork("turn");
    const endModel = beginWork("model");
    const endModel2 = beginWork("model");
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ busy: 3, work: { turn: 1, model: 2 } });

    endModel();
    endModel(); // ended twice counts once
    expect(workReport().work).toEqual({ turn: 1, model: 1 });
    endModel2();
    endTurn();
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ busy: 0, work: {} });
  });

  it("ends the work even when it fails", async () => {
    reportWorkTo(file);
    await expect(
      withWork("task", async () => {
        expect(workReport().work).toEqual({ task: 1 });
        throw new Error("broken");
      }),
    ).rejects.toThrow("broken");
    expect(workReport().busy).toBe(0);
  });
});

/**
 * On 2026-10-04 every deploy waited five minutes: it counted claude processes,
 * and the warm pool (D50) always keeps some ready, even without a turn.
 */
describe("deploy.sh: waits only for real work", () => {
  it("restarts immediately when nothing is working", () => {
    reportWorkTo(file);
    expect(deployCheck(file)).toBe("");
  });

  it("waits while a turn or browser is running", () => {
    reportWorkTo(file);
    const endTurn = beginWork("turn");
    const endBrowser = beginWork("browser");
    expect(deployCheck(file)).toBe("turn=1 browser=1");
    endTurn();
    endBrowser();
    expect(deployCheck(file)).toBe("");
  });

  it("also waits for a kind it does not know yet", () => {
    writeFileSync(file, JSON.stringify({ pid: process.pid, busy: 2, work: { new: 2 } }));
    expect(deployCheck(file)).toBe("busy=2");
  });

  it("without a file or with a dead process nobody is working", () => {
    expect(deployCheck(file)).toBe("");
    const dead = spawnSync("true").pid;
    writeFileSync(file, JSON.stringify({ pid: dead, busy: 1, work: { turn: 1 } }));
    expect(deployCheck(file)).toBe("");
  });

  it("prints no text from the file", () => {
    writeFileSync(file, JSON.stringify({ pid: process.pid, busy: 1, work: { turn: "\u001b[2J" } }));
    expect(deployCheck(file)).toBe("busy=1");
  });
});
