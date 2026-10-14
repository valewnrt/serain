import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMPANION_LIMITS, type CompanionErrorCode } from "../src/companion/protocol.js";
import { ToolFailure } from "./failure.js";

/**
 * Calls the Swift helper (`companion/apple/SerainApple.swift`). It is started
 * via `open`, i.e. via LaunchServices: only then is the bundle itself the
 * process that macOS assigns the permissions for calendars, reminders and
 * contacts to. Started directly from node, they would be attached to node,
 * and node has no usage descriptions in its Info.plist.
 *
 * Arguments go to `open` as an argument list, never through a shell.
 */
export type AppleRunner = (args: readonly string[]) => Promise<Record<string, unknown>>;

async function waitForJson(path: string, timeoutMs: number): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      // The helper writes exactly one object in one go; anything half written fails to parse.
      return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    } catch {
      if (Date.now() > deadline) throw new ToolFailure("timeout", "The Mac did not answer in time.");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

export function appleRunner(appPath: string): AppleRunner {
  return async (args) => {
    const dir = await mkdtemp(join(tmpdir(), "serain-apple-"));
    const out = join(dir, "out.json");
    try {
      // Without `-W`: the helper is often done before `open` can attach to it,
      // and `open` then reports an error although the answer was written long
      // ago (measured 2026-09-20). So we wait for the answer file, not for
      // the process.
      await new Promise<void>((resolve, reject) => {
        const child = spawn(
          "/usr/bin/open",
          ["-n", "-g", "--stdout", out, "--stderr", join(dir, "err.txt"), "-a", appPath, "--args", ...args],
          { stdio: "ignore" },
        );
        child.on("error", (error) => reject(new ToolFailure("failed", error.message)));
        child.on("close", (code) => {
          if (code === 0) resolve();
          else reject(new ToolFailure("failed", "The Apple helper could not be started."));
        });
      });
      const parsed = await waitForJson(out, COMPANION_LIMITS.appleTimeoutMs);
      if (parsed["ok"] !== true) {
        throw new ToolFailure(
          (typeof parsed["code"] === "string" ? parsed["code"] : "failed") as CompanionErrorCode,
          typeof parsed["error"] === "string" ? parsed["error"] : "The Apple helper failed.",
        );
      }
      return parsed;
    } catch (error) {
      if (error instanceof ToolFailure) throw error;
      throw new ToolFailure("failed", "The Apple helper's answer is not readable.");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
}
