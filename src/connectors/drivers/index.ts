import { z } from "zod";
import { server as instance } from "@instance/server.js";
import { remoteTool } from "../tools.js";
import type { ConnectorDriver } from "../types.js";
import { corosDriver } from "./coros.js";
import { enableBankingDriver, type EnableBankingConfig } from "./enable-banking.js";
import { mcpOAuthDriver, type ClientRegistry } from "./mcp-oauth.js";

/**
 * All drivers the server knows (D51), in one place. A new service is an entry
 * in the catalog, a driver and a line here; a service of the instance is the
 * same in `instance/catalog.ts` and `instance/server.ts`. The fuzz harness
 * (`test/fuzz/connectors.test.ts`) builds the drivers through the same function
 * and fails as soon as the catalog has a service it does not deliver.
 */
export interface ConnectorDriverDeps {
  clients: ClientRegistry;
  /** The bank app from the env; without it the bank driver reports on connect what is missing. */
  enableBanking: EnableBankingConfig | null;
  /** Tests only: a transport without network. */
  fetch?: typeof fetch;
}

export function connectorDrivers(deps: ConnectorDriverDeps): ConnectorDriver[] {
  const transport = deps.fetch ? { fetch: deps.fetch } : {};
  return [
    corosDriver({ clients: deps.clients, ...transport }),
    enableBankingDriver(deps.enableBanking, { id: "bank", ...transport }),
    ...(instance.drivers?.({ z, remoteTool, mcpOAuthDriver, clients: deps.clients, ...transport }) ?? []),
  ];
}
