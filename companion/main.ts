import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { COMPANION_MAC_PORT } from "../src/companion/protocol.js";
import { appleRunner } from "./apple.js";
import { renderPage } from "./browser.js";
import { createCompanionServer } from "./server.js";

/**
 * Entry point of the Mac companion (D28). Started by launchd
 * (`com.serain.companion`), set up by `companion/install.sh`.
 *
 * Configuration: `~/Library/Application Support/Serain Companion/config.json`,
 * readable only by the user it belongs to. The token is stored there and nowhere else on the Mac.
 */
const home = join(homedir(), "Library", "Application Support", "Serain Companion");
const configPath = process.env["SERAIN_COMPANION_CONFIG"] ?? join(home, "config.json");

if ((statSync(configPath).mode & 0o077) !== 0) {
  throw new Error(`${configPath} is readable by others. chmod 600, then restart.`);
}
const config = JSON.parse(readFileSync(configPath, "utf8")) as {
  token?: string;
  port?: number;
  browser?: boolean;
  appleApp?: string;
};

const stamp = () => new Date().toISOString();
const server = createCompanionServer({
  token: config.token ?? "",
  apple: appleRunner(config.appleApp ?? join(home, "Serain Apple.app")),
  render: config.browser === false ? null : (url) => renderPage(url),
  log: (line) => console.log(`${stamp()} ${line}`),
});

const port = config.port ?? COMPANION_MAC_PORT;
// Loopback only: the server can reach the service exclusively through the
// SSH tunnel that launchd keeps up next to it.
server.listen(port, "127.0.0.1", () => console.log(`${stamp()} Companion listening on 127.0.0.1:${port}`));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
