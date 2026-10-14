import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "..");

/** The rsync calls from deploy.sh, with line continuations joined. */
function rsyncCalls(): string[] {
  const script = readFileSync(resolve(ROOT, "deploy/deploy.sh"), "utf8").replace(/\\\n\s*/g, " ");
  return script.split("\n").filter((line) => /^\s*rsync\s/.test(line));
}

/**
 * With rsync -a, /opt/serain takes over the local UID of your own computer
 * during a deploy (mode 0700 from mktemp) until the chown -R runs. During that
 * time the running service cannot get into its own directory, and the Agent SDK
 * does not find its binary. Owner and group of the source must therefore never
 * reach the server.
 */
describe("deploy.sh", () => {
  it("never transfers owner or group from your own computer", () => {
    const calls = rsyncCalls();
    expect(calls.filter((line) => line.includes(":$APP_DIR/"))).toHaveLength(1);
    for (const line of calls) {
      for (const flag of line.trim().split(/\s+/).filter((part) => part.startsWith("-"))) {
        if (flag.startsWith("--")) expect(["--archive", "--owner", "--group"]).not.toContain(flag);
        else expect(flag, line).not.toMatch(/[aog]/);
      }
    }
  });
});
