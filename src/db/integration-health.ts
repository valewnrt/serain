import { applyHealthTransition, findOpenIncident, markIncidentNotified, reportUnhealthy } from "../health/incidents.js";
import type { IntegrationHealthDeps } from "../health/integrations.js";
import { db } from "./client.js";

/** Incidents and remembered advance warnings for src/health/integrations.ts. */
export const integrationIncidents: IntegrationHealthDeps["incidents"] = {
  find: findOpenIncident,
  open: reportUnhealthy,
  close: async (component, note) => void (await applyHealthTransition(component, true, note)),
  markNotified: markIncidentNotified,
};

/** Which connection expiry the owner has already been warned about (`agent_state.connector_expiry`). */
const STATE_KEY = "connector_expiry";

export const connectorExpiryWarned: IntegrationHealthDeps["expiryWarned"] = {
  async load() {
    const { data, error } = await db.from("agent_state").select("value").eq("key", STATE_KEY).maybeSingle();
    if (error) throw new Error(`Advance warnings not readable: ${error.message}`);
    const value = (data?.value ?? {}) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  },
  async save(value) {
    const { error } = await db.from("agent_state").upsert({ key: STATE_KEY, value, updated_at: new Date().toISOString() });
    if (error) throw new Error(`Advance warnings not saved: ${error.message}`);
  },
};
