import { join } from "node:path";
import { env } from "./config/env.js";
import { log, setLogLevel } from "./log.js";
import { PhotonChannel } from "./channel/photon/adapter.js";
import { Runtime } from "./runtime.js";
import { audit } from "./db/audit.js";
import { reportWorkTo } from "./health/work.js";

setLogLevel(env.logLevel);
// Secrets are registered as redacted where they are read (`src/config/env.ts`, D8.5), before anything is logged.

async function main(): Promise<void> {
  log.info(`Serain starting (channel photon, echoOnly=${env.echoOnly})`);
  // Before anything else: from here on the deploy sees whether a restart cuts something off.
  reportWorkTo(env.runtimeDir ? join(env.runtimeDir, "work.json") : null);

  const channel = new PhotonChannel({
    projectId: env.photonProjectId,
    projectSecret: env.photonProjectSecret,
    onStatus: ({ externalId, status, detail }) => {
      void audit("outbound_status", { external_id: externalId, status, ...detail });
    },
    onFatal: (status, reason) => {
      log.error(`Photon rejects the credentials (${status} ${reason}). Serain exits.`);
      void audit("error", { stage: "channel_fatal", status, reason }).finally(() => process.exit(1));
    },
  });

  const runtime = new Runtime(channel);
  await runtime.start();
  log.info("Serain is running.");

  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info(`${signal} received, shutting down.`);
    runtime
      .stop()
      .catch((error: unknown) => log.error("Shutdown error:", error))
      .finally(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((error: unknown) => {
  log.error("Serain could not start:", error);
  process.exit(1);
});
