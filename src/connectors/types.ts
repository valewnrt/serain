import type { ToolDefinition } from "../agent/tools/types.js";
import type { ConnectorTier } from "./catalog.js";
import type { DataSource } from "../datasets/sources.js";

/**
 * A driver connects a service from the catalog (D51): start the authorization
 * at the provider, redeem the callback, build tools with the credentials,
 * revoke on disconnect. Only the driver sees credentials; the tools get a
 * ready connection (surrogation as in D30).
 */

export type Json = Record<string, unknown>;

export interface ToolSnapshot {
  name: string;
  label: string;
  level: ConnectorTier;
  /** Does the provider currently offer the tool? */
  available: boolean;
}

/** What the web interface shows about a connection: our tools and what else the provider has. */
export interface Snapshot {
  tools: ToolSnapshot[];
  /** Provider tools Serain does not get (not in the catalog). Names only. */
  unlisted: string[];
}

/** The credentials of a connection. A driver stores renewed tokens here. */
export interface CredentialSlot {
  get(): Json;
  save(next: Json): Promise<void>;
}

export interface LiveConnector {
  tools: ToolDefinition[];
  /** Data for `analyze_data` (D63, building block D), read-only, while connected. */
  datasets?: DataSource[];
  snapshot(): Promise<Snapshot>;
  close(): Promise<void>;
}

export interface ConnectorDriver {
  readonly id: string;
  /** A paragraph for the system prompt, while connected. */
  readonly promptLine: string;
  begin(input: { redirectUri: string; state: string }): Promise<{ authorizeUrl: string; pending: Json }>;
  complete(input: { pending: Json; code: string; redirectUri: string }): Promise<{ credentials: Json; account: string; expiresAt: Date | null }>;
  open(credentials: CredentialSlot): LiveConnector;
  /** True: revoked; false: failed; null: the provider has no revocation. */
  revoke(credentials: Json): Promise<boolean | null>;
}

export class ConnectorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectorError";
  }
}
