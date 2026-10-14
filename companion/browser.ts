import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkUrl } from "../src/executor/netguard.js";
import { COMPANION_LIMITS, type CompanionResults } from "../src/companion/protocol.js";
import { startFilterProxy } from "./proxy.js";
import { ToolFailure } from "./failure.js";

const DUMP_IDLE_MS = 1_500;

export const CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/**
 * Renders a public page with JavaScript and returns the finished HTML
 * (D28). For pages where `web_fetch` fails: JS apps and pages that block
 * data center addresses.
 *
 * Deliberately **not** the owner's browser: every time a fresh throwaway profile without
 * cookies, logins or extensions (D8.7), all connections through the
 * filter proxy, no downloads, a hard time limit. What remains is Chrome's own
 * sandbox between a foreign page and the owner's Mac, the same as for every
 * link they click themselves.
 */
export async function renderPage(rawUrl: string, chromePath = CHROME_PATH): Promise<CompanionResults["browser_render"]> {
  const verdict = checkUrl(rawUrl);
  if (!verdict.ok) throw new ToolFailure("blocked", verdict.reason);

  const profile = await mkdtemp(join(tmpdir(), "serain-browser-"));
  const proxy = await startFilterProxy();
  try {
    const args = [
      "--headless=new",
      "--dump-dom",
      `--user-data-dir=${profile}`,
      `--proxy-server=http://127.0.0.1:${proxy.port}`,
      // Loopback goes through the proxy too (and fails there).
      "--proxy-bypass-list=<-loopback>",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-sync",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-features=Translate,MediaRouter,OptimizationHints",
      "--mute-audio",
      "--hide-scrollbars",
      "--virtual-time-budget=10000",
      verdict.url.toString(),
    ];
    const html = await new Promise<{ html: string; truncated: boolean }>((resolve, reject) => {
      // Own process group: Chrome starts helpers, and at the end the whole group
      // is killed.
      const child = spawn(chromePath, args, { stdio: ["ignore", "pipe", "ignore"], detached: true });
      const chunks: Buffer[] = [];
      let size = 0;
      let truncated = false;
      let settled = false;
      let idle: NodeJS.Timeout | null = null;
      const killGroup = () => {
        try {
          if (child.pid) process.kill(-child.pid, "SIGKILL");
        } catch {
          // Already gone.
        }
      };
      const finish = (error?: ToolFailure) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (idle) clearTimeout(idle);
        killGroup();
        if (error) reject(error);
        else resolve({ html: Buffer.concat(chunks).toString("utf8"), truncated });
      };
      const timer = setTimeout(
        () => finish(new ToolFailure("timeout", "The page took too long.")),
        COMPANION_LIMITS.browserTimeoutMs,
      );
      child.stdout.on("data", (chunk: Buffer) => {
        if (size < COMPANION_LIMITS.browserMaxBytes) {
          chunks.push(chunk.subarray(0, COMPANION_LIMITS.browserMaxBytes - size));
        } else {
          truncated = true;
        }
        size += chunk.length;
        // `--dump-dom` writes the finished DOM in one go and on macOS does not
        // reliably exit by itself afterwards (measured 2026-09-20: DOM after
        // 1 s, process still there after 30 s). Once nothing more arrives for
        // a while, the DOM is complete.
        if (idle) clearTimeout(idle);
        idle = setTimeout(() => finish(), DUMP_IDLE_MS);
      });
      child.on("error", (error) => finish(new ToolFailure("failed", `Chrome does not start: ${error.message}`)));
      child.on("close", () => finish());
    });
    // If the main page itself was rejected, Chrome shows its own error page;
    // that is not content.
    if (proxy.blocked.some((entry) => entry.includes(verdict.url.hostname))) {
      throw new ToolFailure("blocked", "The page points to an internal address.");
    }
    if (!html.html.trim() || html.html.includes('id="main-frame-error"')) {
      throw new ToolFailure("failed", "The page could not be loaded.");
    }
    return { url: verdict.url.toString(), ...html };
  } finally {
    await proxy.close();
    await rm(profile, { recursive: true, force: true });
  }
}
