import type { z } from "zod";
import type { ClientRegistry, mcpOAuthDriver } from "../connectors/drivers/mcp-oauth.js";
import type { remoteTool } from "../connectors/tools.js";
import type { ConnectorDriver } from "../connectors/types.js";

/**
 * What an instance adds to the core (docs/INSTANCE.md). An instance is the
 * owner's own directory `instance/` next to `src/`, outside this repository:
 * services only this owner uses, and rules only this owner has. Without it
 * the core runs with the empty defaults in `src/instance/defaults/`.
 *
 * Instance files import from the core only types (`import type … from
 * "@serain/…"`). Everything they need at runtime comes in through
 * {@link InstanceDriverApi}, so they resolve the same way wherever the
 * directory really lives (a symlink into the owner's private repository).
 */

/** What the core hands a driver factory of the instance. */
export interface InstanceDriverApi {
  z: typeof z;
  remoteTool: typeof remoteTool;
  mcpOAuthDriver: typeof mcpOAuthDriver;
  clients: ClientRegistry;
  /** Tests only: a transport without network. Pass it on to the driver. */
  fetch?: typeof fetch;
}

/** `instance/server.ts` exports this as `server`. */
export interface InstanceServer {
  /**
   * One driver per service in `instance/catalog.ts`, same ids. They run through
   * the same registry, guards and fuzz harness as the built-in ones (D51, D53).
   */
  drivers?: (api: InstanceDriverApi) => ConnectorDriver[];
  /**
   * The owner's own rules for which mails matter (`src/mail/rules.ts`), one
   * line each, in English. They take precedence over the general rules.
   * Measure before and after with `pnpm eval:mail`.
   */
  mailRules?: readonly string[];
}
