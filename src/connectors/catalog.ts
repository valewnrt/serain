import { connectors as instanceConnectors } from "@instance/catalog.js";

/**
 * What can be connected in the web interface (D51). Three sides read this
 * file: the client shows the cards from it, the worker checks names and
 * origin, the server builds the tools from it (`src/connectors/drivers/`).
 * Hence without dependencies (never `src/config/owner.ts` or `src/i18n`): the
 * texts here are those of the web interface, in English. An instance adds its
 * own services from `instance/catalog.ts` (docs/INSTANCE.md), data only too.
 *
 * Every tool stands here with level and name for the owner. Whatever else a
 * service offers, Serain does not get: a new tool at the provider is only
 * usable once it stands here, with a level we set, not the provider.
 */

export type ConnectorTier = "read" | "write_reversible";

/** Approvals with a name of their own in the expiry warning. */
export type ConnectorGrant = "bank";

export interface ConnectorToolInfo {
  /** Name of the tool at Serain, e.g. `coros_sleep`. */
  name: string;
  /** What it does, for the owner. */
  label: string;
  level: ConnectorTier;
}

export interface ConnectorInfo {
  id: string;
  name: string;
  /** One sentence: what Serain can do with it. */
  summary: string;
  /** Where the owner sees and can revoke the connection at the provider themselves. */
  manageUrl?: string;
  /** How long a connection lasts when the provider sets it (banks: PSD2). */
  validity?: string;
  /**
   * Which fixed name the owner reads for the approval in the warning before it
   * expires (addendum D23 of 2026-10-10; texts in `src/i18n/messages/health.ts`).
   * Without: "the approval for <name>".
   */
  grantName?: ConnectorGrant;
  /**
   * The provider allows only one registered https return address: the public
   * origin of the web interface (`SERAIN_WEB_ORIGIN`). Without it the server
   * does not offer this service. If the web interface runs elsewhere (locally),
   * the owner pastes the address they land on after the approval themselves.
   * The origin itself is not here: this file also runs in the browser and in
   * the worker, without env.
   */
  fixedRedirect?: true;
  tools: readonly ConnectorToolInfo[];
}

/** The services of the core, without the instance; the public directory (`site/`) lists these. */
export const BUILT_IN_CONNECTORS: readonly ConnectorInfo[] = [
  {
    id: "coros",
    name: "COROS",
    summary: "Sleep, HRV, recovery, training load and activities from your COROS watch. Read only.",
    tools: [
      { name: "coros_daily_health", label: "Daily values: steps, stress, sleep", level: "read" },
      { name: "coros_sleep", label: "Sleep", level: "read" },
      { name: "coros_sleep_hrv", label: "HRV during sleep", level: "read" },
      { name: "coros_recovery", label: "Recovery", level: "read" },
      { name: "coros_resting_hr", label: "Resting heart rate", level: "read" },
      { name: "coros_stress", label: "Stress", level: "read" },
      { name: "coros_training_load", label: "Training load", level: "read" },
      { name: "coros_fitness", label: "VO2max, threshold, predictions", level: "read" },
      { name: "coros_activities", label: "Search activities", level: "read" },
      { name: "coros_activity", label: "One activity in detail", level: "read" },
      { name: "coros_schedule", label: "Training plan of the week", level: "read" },
    ],
  },
  {
    id: "bank",
    name: "Bank",
    summary: "Balance and transactions of your bank account, read only. Serain cannot make transfers with it. Approval in your bank's app, via Enable Banking.",
    validity: "The bank grants access for at most 180 days, then reconnect.",
    grantName: "bank",
    // The return address must be registered at Enable Banking and be https, so always the public origin (D51).
    fixedRedirect: true,
    tools: [
      { name: "bank_balance", label: "Balance", level: "read" },
      { name: "bank_transactions", label: "Transactions of the last 90 days", level: "read" },
      { name: "bank_subscriptions", label: "Subscriptions and recurring debits", level: "read" },
    ],
  },
];

/**
 * Built-in services plus those of the instance. A service or tool name twice
 * would make the worker, the audit and the registry disagree about what a name
 * means, so that fails at load, in every process that reads the catalog.
 */
export function withInstance(builtIn: readonly ConnectorInfo[], extra: readonly ConnectorInfo[]): readonly ConnectorInfo[] {
  const all = [...builtIn, ...extra];
  const ids = new Set<string>();
  const tools = new Set<string>();
  for (const info of all) {
    if (ids.has(info.id)) throw new Error(`Connection ${info.id} is in the catalog twice.`);
    ids.add(info.id);
    for (const tool of info.tools) {
      if (tools.has(tool.name)) throw new Error(`Tool ${tool.name} is in the catalog twice.`);
      tools.add(tool.name);
    }
  }
  return all;
}

export const CONNECTORS: readonly ConnectorInfo[] = withInstance(BUILT_IN_CONNECTORS, instanceConnectors);

export const connectorInfo = (id: string): ConnectorInfo | undefined => CONNECTORS.find((info) => info.id === id);

/** "COROS: Sleep" for the audit, or undefined when the tool belongs to no service. */
export function connectorToolLabel(tool: string): string | undefined {
  for (const info of CONNECTORS) {
    const found = info.tools.find((entry) => entry.name === tool);
    if (found) return `${info.name}: ${found.label}`;
  }
  return undefined;
}

/** The web interface locally (`pnpm web:dev`). */
export const LOCAL_WEB_ORIGIN = "http://localhost:8787";

/**
 * Origins of the web interface a provider may send the owner back to: local
 * and, if there is one, the public one (`instance.webOrigin`). The server
 * builds the return address only from this list, never from what is in the
 * database.
 */
export function webOrigins(publicOrigin: string | null): readonly string[] {
  return publicOrigin ? [LOCAL_WEB_ORIGIN, publicOrigin] : [LOCAL_WEB_ORIGIN];
}

export const CALLBACK_PATH = "/connections/callback";

export function callbackUrl(origin: string, allowed: readonly string[]): string {
  if (!allowed.includes(origin)) throw new Error(`Unknown origin ${origin}.`);
  return `${origin}${CALLBACK_PATH}`;
}

/** Name under which the browser seals the way back for the server (AAD, src/vault/sealbox.ts). */
export const callbackSealName = (id: string) => `connector:${id}`;

/** How long the owner has at the provider before a started connection lapses. */
export const AUTHORIZE_MINUTES = 15;
