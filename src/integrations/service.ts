import { audit } from "../db/audit.js";
import { log, redactValue } from "../log.js";
import { open, seal } from "./seal.js";
import {
  integrationSecretSchema,
  type IntegrationRow,
  type IntegrationSecret,
  type IntegrationStore,
} from "./types.js";

/**
 * Connect, use, disconnect (D30).
 *
 * **Credential surrogation (W16):** the secret leaves this class only towards
 * an adapter that builds a connection with it (`src/mail/`, `src/google/`).
 * Tools see accounts, never credentials; so a tool result cannot contain one,
 * and every opened secret is registered with the logger as a value to redact.
 *
 * **Disconnecting really deletes (W13):** first the revocation at the
 * provider, then the credential with everything stored from it, then an audit
 * entry with numbers. If the revocation fails, it is deleted anyway and the
 * failure is in the entry: a token we no longer have, we cannot misuse
 * either.
 */

export class IntegrationUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntegrationUnavailable";
  }
}

export interface DisconnectResult {
  id: string;
  existed: boolean;
  mailItems: number;
  /** null: the provider has no revocation (IMAP). */
  revoked: boolean | null;
}

export class Integrations {
  constructor(
    private readonly store: IntegrationStore,
    /** Without a key there are no integrations: nothing can be opened. */
    private readonly key: Buffer | null,
    private readonly revokers: Partial<Record<IntegrationSecret["kind"], (secret: IntegrationSecret) => Promise<void>>> = {},
  ) {}

  get enabled(): boolean {
    return this.key !== null;
  }

  async list(): Promise<IntegrationRow[]> {
    return this.enabled ? this.store.list() : [];
  }

  async has(id: string): Promise<boolean> {
    return this.enabled && this.store.has(id);
  }

  /** Only for adapters. Never into a tool result, never into a log. */
  async secret<K extends IntegrationSecret["kind"]>(id: string, kind: K): Promise<Extract<IntegrationSecret, { kind: K }>> {
    if (!this.key) throw new IntegrationUnavailable("SERAIN_INTEGRATION_KEY is missing.");
    const row = await this.store.get(id);
    if (!row) throw new IntegrationUnavailable(`Integration "${id}" is not connected.`);
    const secret = integrationSecretSchema.parse(open(this.key, row.sealed));
    if (secret.kind !== kind) throw new IntegrationUnavailable(`Integration "${id}" is not a ${kind} integration.`);
    // Only the secrets themselves: a redacted host name made logs unreadable.
    if (secret.kind === "imap" || secret.kind === "caldav") redactValue(secret.password);
    else for (const value of [secret.clientSecret, secret.refreshToken]) redactValue(value);
    return secret as Extract<IntegrationSecret, { kind: K }>;
  }

  async connect(input: { id: string; account: string; scopes: string[]; secret: IntegrationSecret }): Promise<void> {
    if (!this.key) throw new IntegrationUnavailable("SERAIN_INTEGRATION_KEY is missing.");
    const secret = integrationSecretSchema.parse(input.secret);
    const existing = await this.store.get(input.id);
    await this.store.put({
      id: input.id,
      kind: secret.kind,
      account: input.account,
      sealed: seal(this.key, secret),
      scopes: input.scopes,
      // Reconnecting keeps the bookmark: otherwise the trigger would read the mailbox from the start.
      state: existing?.account === input.account ? existing.state : {},
    });
    await audit("integration_connected", { id: input.id, kind: secret.kind, scopes: input.scopes, reconnect: existing !== null });
  }

  async saveState(id: string, state: Record<string, unknown>): Promise<void> {
    await this.store.saveState(id, state);
  }

  async disconnect(id: string, via: string): Promise<DisconnectResult> {
    const row = await this.store.get(id);
    if (!row) return { id, existed: false, mailItems: 0, revoked: null };
    let revoked: boolean | null = null;
    const revoke = this.revokers[row.kind];
    if (revoke) {
      try {
        await revoke(await this.secret(id, row.kind));
        revoked = true;
      } catch (error) {
        revoked = false;
        log.error(`Revocation for ${id} failed, deleting anyway:`, (error as Error).message);
      }
    }
    const removed = await this.store.remove(id);
    const result = { id, existed: true, mailItems: removed?.mailItems ?? 0, revoked };
    // Own entry about the deletion (W13): what, how much, on whose instruction. Never the content.
    await audit("integration_disconnected", { id, kind: row.kind, via, mail_items: result.mailItems, revoked });
    return result;
  }
}
