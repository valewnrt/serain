import { createHash, randomBytes } from "node:crypto";
import type { ToolDefinition } from "../agent/tools/types.js";
import { CONNECTOR_IDLE_POLL_MS, CONNECTOR_POLL_MS } from "../config/limits.js";
import { instance, owner } from "../config/owner.js";
import { audit as auditLog } from "../db/audit.js";
import type { DataSource, DataSources } from "../datasets/sources.js";
import { open, seal } from "../integrations/seal.js";
import { log } from "../log.js";
import type { VaultKey } from "../vault/sealbox.js";
import { AUTHORIZE_MINUTES, callbackSealName, callbackUrl, connectorInfo, webOrigins } from "./catalog.js";
import type { ClientRegistry } from "./drivers/mcp-oauth.js";
import { McpError } from "./mcp.js";
import { OAuthError, type OAuthClient } from "./oauth.js";
import { ConnectorError, type ConnectorDriver, type Json, type LiveConnector, type Snapshot } from "./types.js";

/**
 * Connections from the web interface, on the server (D51). The web interface
 * cannot reach the server (D10, D49); it writes a request into `connectors`,
 * and this service checks every two seconds:
 *
 * - `starting`: prepare the authorization at the provider (PKCE,
 *   registration, bank session), store the URL for the browser.
 * - `finishing`: open the callback the browser sealed to the vault key, redeem
 *   it at the provider, store the tokens sealed, register the tools.
 * - `disconnecting`: unregister the tools, revoke at the provider, delete.
 * - `authorizing` after 15 minutes: expire.
 *
 * **Disconnecting takes effect immediately (W13).** Every tool asks before the
 * call whether the connection still exists. If it is `disconnecting` or gone,
 * nothing runs any more, even before this service has cleared it away.
 */

export type ConnectorStatus = "starting" | "authorizing" | "finishing" | "connected" | "failed" | "disconnecting";

export interface ConnectorRow {
  id: string;
  status: ConnectorStatus;
  origin: string;
  stateHash: string | null;
  pending: string | null;
  callback: string | null;
  sealed: string | null;
  requestedAt: Date;
  expiresAt: Date | null;
}

export interface ConnectorStore {
  /** What there is to do; `authorizing` only when started before `authorizeCutoff`. */
  work(authorizeCutoff: Date): Promise<ConnectorRow[]>;
  connected(): Promise<ConnectorRow[]>;
  status(id: string): Promise<ConnectorStatus | null>;
  authorizing(id: string, input: { authorizeUrl: string; stateHash: string; pending: string }): Promise<boolean>;
  connect(id: string, input: { sealed: string; account: string; tools: Snapshot; expiresAt: Date | null }): Promise<boolean>;
  fail(id: string, from: ConnectorStatus, message: string): Promise<boolean>;
  saveCredentials(id: string, sealed: string): Promise<boolean>;
  saveTools(id: string, tools: Snapshot): Promise<boolean>;
  remove(id: string): Promise<void>;
  client(issuer: string, redirectUri: string): Promise<string | null>;
  saveClient(issuer: string, redirectUri: string, sealed: string): Promise<void>;
}

export interface ToolHost {
  add(defs: readonly ToolDefinition[]): void;
  remove(names: readonly string[]): void;
}

export interface ConnectorServiceDeps {
  store: ConnectorStore;
  /** `SERAIN_INTEGRATION_KEY`: seals tokens and intermediate states. */
  sealKey: Buffer;
  /** `SERAIN_VAULT_KEY`: opens what the browser sealed. */
  vaultKey: () => Promise<VaultKey>;
  drivers: (clients: ClientRegistry) => ConnectorDriver[];
  tools: ToolHost;
  /** Where a connection's data for `analyze_data` goes (D63); without: nowhere. */
  data?: DataSources;
  /** Tools or prompt have changed (new warm pool, D50). */
  onChange: () => void;
  now?: () => Date;
  /** Origins of the web interface; only the end-to-end test (own port) sets a different list. */
  origins?: readonly string[];
  /**
   * Public origin of the web interface, default `instance.webOrigin`. Without it
   * there are no services with a fixed redirect address (`fixedRedirect`, bank);
   * an existing connection keeps reading. Only tests set it differently.
   */
  publicOrigin?: string | null;
  /** Only for the end-to-end test with a throwaway database; otherwise the audit log in Supabase. */
  audit?: (event: "connector_connected" | "connector_failed" | "connector_disconnected" | "error", detail: Record<string, unknown>) => Promise<void>;
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/**
 * Error messages go into the web interface and the audit: only our own, otherwise a generic one.
 * Checked by class, not by name: the MCP SDK also calls its errors "McpError", and their text
 * is written by the provider itself, of any length (fuzzing 2026-10-04).
 */
function reason(error: unknown): string {
  if (error instanceof ConnectorError || error instanceof OAuthError || error instanceof McpError) return error.message;
  if ((error as Error | null)?.name === "TimeoutError") return "The provider did not answer in time.";
  return "Unexpected error on the server, details in the journal.";
}

export class ConnectorService {
  private readonly drivers = new Map<string, ConnectorDriver>();
  private readonly live = new Map<string, { connector: LiveConnector; names: string[]; datasets: string[] }>();
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private running: Promise<void> | null = null;
  /** Until then at the dense rate: a round had work, the callback from the provider can come any moment. */
  private busyUntil = 0;
  private readonly now: () => Date;
  private readonly audit: NonNullable<ConnectorServiceDeps["audit"]>;
  private readonly publicOrigin: string | null;
  private readonly origins: readonly string[];

  constructor(private readonly deps: ConnectorServiceDeps) {
    this.now = deps.now ?? (() => new Date());
    this.publicOrigin = deps.publicOrigin === undefined ? instance.webOrigin : deps.publicOrigin;
    this.origins = deps.origins ?? webOrigins(this.publicOrigin);
    this.audit = deps.audit ?? ((event, detail) => auditLog(event, detail));
    const clients: ClientRegistry = {
      get: async (issuer, redirectUri) => {
        const sealed = await deps.store.client(issuer, redirectUri);
        return sealed ? (open(deps.sealKey, sealed) as OAuthClient) : null;
      },
      put: (issuer, redirectUri, client) => deps.store.saveClient(issuer, redirectUri, seal(deps.sealKey, client)),
    };
    for (const driver of deps.drivers(clients)) {
      if (!connectorInfo(driver.id)) throw new Error(`Driver ${driver.id} is not in the catalog.`);
      this.drivers.set(driver.id, driver);
    }
  }

  /** The sentences for the system prompt: one per connected service. */
  promptLines(): string[] {
    return [...this.live.keys()].sort().map((id) => this.drivers.get(id)!.promptLine);
  }

  /** Can the service be connected right now? With a fixed redirect address only when there is a public origin. */
  private offered(id: string): boolean {
    return !connectorInfo(id)?.fixedRedirect || this.publicOrigin !== null;
  }

  /** Services that could be connected but are not: for the setup hint in the prompt. */
  unconnectedNames(): string[] {
    return [...this.drivers.keys()]
      .filter((id) => !this.live.has(id) && this.offered(id))
      .sort()
      .map((id) => connectorInfo(id)?.name ?? id);
  }

  async start(): Promise<void> {
    for (const row of await this.deps.store.connected()) {
      try {
        this.attach(row);
      } catch (error) {
        log.error(`Connection ${row.id} not usable:`, (error as Error).message);
        await this.audit("error", { stage: "connector_open", id: row.id, reason: reason(error) });
      }
    }
    if (this.live.size > 0) this.deps.onChange();
    log.info(`Connections: ${[...this.live.keys()].join(", ") || "none"}`);
    this.stopped = false;
    this.schedule();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.running;
    for (const id of [...this.live.keys()]) await this.detach(id);
  }

  /** One round. If one is still running, this one does not wait but is skipped. */
  tick(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.round()
      .catch((error: unknown) => log.warn("Connections: round failed:", (error as Error).message))
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }

  /** The next round: rare when idle, dense after work (`CONNECTOR_IDLE_POLL_MS`). */
  private schedule(): void {
    if (this.stopped) return;
    const delay = this.now().getTime() < this.busyUntil ? CONNECTOR_POLL_MS : CONNECTOR_IDLE_POLL_MS;
    this.timer = setTimeout(() => void this.tick().finally(() => this.schedule()), delay);
    this.timer.unref();
  }

  private async round(): Promise<void> {
    const cutoff = new Date(this.now().getTime() - AUTHORIZE_MINUTES * 60_000);
    const work = await this.deps.store.work(cutoff);
    if (work.length > 0) this.busyUntil = this.now().getTime() + AUTHORIZE_MINUTES * 60_000;
    for (const row of work) {
      try {
        if (row.status === "starting") await this.begin(row);
        else if (row.status === "finishing") await this.complete(row);
        else if (row.status === "disconnecting") await this.disconnect(row);
        else if (row.status === "authorizing") await this.expire(row);
      } catch (error) {
        log.error(`Connection ${row.id} (${row.status}):`, error);
        if (row.status === "disconnecting") continue;
        const message = reason(error);
        if (await this.deps.store.fail(row.id, row.status, message)) await this.audit("connector_failed", { id: row.id, stage: row.status, reason: message });
      }
    }
  }

  private driver(id: string): ConnectorDriver {
    const driver = this.drivers.get(id);
    if (!driver) throw new ConnectorError(`This server does not know ${id}.`);
    return driver;
  }

  private redirectFor(row: ConnectorRow): string {
    const info = connectorInfo(row.id);
    if (info?.fixedRedirect && !this.publicOrigin) {
      throw new ConnectorError(`${info.name} needs a public address of the web interface (SERAIN_WEB_ORIGIN), and this server has none.`);
    }
    try {
      return callbackUrl(info?.fixedRedirect && this.publicOrigin ? this.publicOrigin : row.origin, this.origins);
    } catch {
      throw new ConnectorError(`The web interface at ${row.origin} may not start connections.`);
    }
  }

  private async begin(row: ConnectorRow): Promise<void> {
    const driver = this.driver(row.id);
    const redirectUri = this.redirectFor(row);
    const state = randomBytes(32).toString("base64url");
    const { authorizeUrl, pending } = await driver.begin({ redirectUri, state });
    await this.deps.store.authorizing(row.id, {
      authorizeUrl,
      stateHash: sha256(state),
      pending: seal(this.deps.sealKey, { ...pending, redirectUri }),
    });
  }

  private async complete(row: ConnectorRow): Promise<void> {
    const driver = this.driver(row.id);
    if (!row.callback || !row.pending || !row.stateHash) throw new ConnectorError("The callback is incomplete, please connect again.");
    const opened = (await (await this.deps.vaultKey()).open(callbackSealName(row.id), row.callback)) as { code?: unknown; state?: unknown };
    const code = typeof opened.code === "string" ? opened.code : "";
    // The database function already checked the `state`; here once more against the sealed part, which it cannot read.
    if (!code || typeof opened.state !== "string" || sha256(opened.state) !== row.stateHash) throw new ConnectorError("The callback does not match this authorization.");
    const pending = open(this.deps.sealKey, row.pending) as Json & { redirectUri: string };
    const result = await driver.complete({ pending, code, redirectUri: pending.redirectUri });

    let credentials = result.credentials;
    const live = driver.open({
      get: () => credentials,
      save: async (next) => {
        credentials = next;
      },
    });
    let snapshot: Snapshot;
    try {
      snapshot = await live.snapshot();
    } finally {
      await live.close();
    }
    const sealed = seal(this.deps.sealKey, credentials);
    const stored = await this.deps.store.connect(row.id, { sealed, account: result.account, tools: snapshot, expiresAt: result.expiresAt });
    if (!stored) {
      // The owner disconnected in the meantime: what we just got goes straight back.
      await driver.revoke(credentials).catch(() => null);
      return;
    }
    // A renewed authorization (bank after 180 days) replaces the old connection in the process.
    await this.detach(row.id);
    this.attach({ ...row, status: "connected", sealed });
    this.deps.onChange();
    await this.audit("connector_connected", {
      id: row.id,
      tools: snapshot.tools.filter((tool) => tool.available).map((tool) => tool.name),
      missing: snapshot.tools.filter((tool) => !tool.available).map((tool) => tool.name),
      expires_at: result.expiresAt?.toISOString() ?? null,
    });
  }

  private async disconnect(row: ConnectorRow): Promise<void> {
    await this.detach(row.id);
    let revoked: boolean | null = null;
    if (row.sealed) {
      try {
        revoked = await this.driver(row.id).revoke(open(this.deps.sealKey, row.sealed) as Json);
      } catch (error) {
        revoked = false;
        log.error(`Revocation for ${row.id} failed, deleting anyway:`, (error as Error).message);
      }
    }
    await this.deps.store.remove(row.id);
    this.deps.onChange();
    await this.audit("connector_disconnected", { id: row.id, revoked });
  }

  private async expire(row: ConnectorRow): Promise<void> {
    if (await this.deps.store.fail(row.id, "authorizing", "The authorization at the provider did not come back within 15 minutes.")) {
      await this.audit("connector_failed", { id: row.id, stage: "authorizing", reason: "expired" });
    }
  }

  /** Registers a connection's tools. Every call first checks whether it still exists. */
  private attach(row: ConnectorRow): void {
    if (this.live.has(row.id)) return;
    if (!row.sealed) throw new ConnectorError("No credentials stored.");
    const driver = this.driver(row.id);
    let credentials = open(this.deps.sealKey, row.sealed) as Json;
    const connector = driver.open({
      get: () => credentials,
      save: async (next) => {
        credentials = next;
        if (!(await this.deps.store.saveCredentials(row.id, seal(this.deps.sealKey, next)))) throw new ConnectorError(`The connection to ${row.id} is disconnected.`);
      },
    });
    const tools = connector.tools.map((def) => this.guard(row.id, def));
    this.deps.tools.add(tools);
    const datasets = (connector.datasets ?? []).map((dataset) => this.guardData(row.id, dataset));
    for (const dataset of datasets) this.deps.data?.add(dataset);
    this.live.set(row.id, { connector, names: tools.map((def) => def.name), datasets: datasets.map((dataset) => dataset.name) });
  }

  private guard(id: string, def: ToolDefinition): ToolDefinition {
    return {
      ...def,
      run: async (args, turn) => {
        if ((await this.deps.store.status(id)) !== "connected") {
          await this.detach(id);
          this.deps.onChange();
          return { ok: false, text: `${connectorInfo(id)?.name ?? id} is disconnected. Tell ${owner.name}.` };
        }
        try {
          return await def.run(args, turn);
        } catch (error) {
          log.error(`${def.name} failed:`, error);
          return { ok: false, text: `${reason(error)} Tell ${owner.name} instead of guessing.` };
        }
      },
    };
  }

  /** The same check as for the tools (`guard`): disconnected means no data any more, not even from memory. */
  private guardData(id: string, dataset: DataSource): DataSource {
    return {
      ...dataset,
      load: async (request) => {
        if ((await this.deps.store.status(id)) !== "connected") {
          await this.detach(id);
          this.deps.onChange();
          throw new ConnectorError(`${connectorInfo(id)?.name ?? id} is disconnected.`);
        }
        return dataset.load(request);
      },
    };
  }

  private async detach(id: string): Promise<void> {
    const entry = this.live.get(id);
    if (!entry) return;
    this.live.delete(id);
    this.deps.tools.remove(entry.names);
    for (const name of entry.datasets) this.deps.data?.remove(name);
    await entry.connector.close().catch(() => undefined);
  }
}
