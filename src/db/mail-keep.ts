import type { MailKeepStore } from "../mail/keep.js";
import { db } from "./client.js";

/** Keep list for cleanup (D37), in `agent_state`. Third-party addresses belong in the database, never in the repo. */

const STATE_KEY = "mail_keep";

export const mailKeepStore: MailKeepStore = {
  async load() {
    const { data, error } = await db.from("agent_state").select("value").eq("key", STATE_KEY).maybeSingle();
    if (error) throw new Error(`Keep list not readable: ${error.message}`);
    const entries = (data?.value as { entries?: unknown } | null)?.entries;
    return Array.isArray(entries) ? entries.filter((entry): entry is string => typeof entry === "string") : [];
  },

  async save(entries) {
    const { error } = await db.from("agent_state").upsert({ key: STATE_KEY, value: { entries }, updated_at: new Date().toISOString() });
    if (error) throw new Error(`Keep list not saved: ${error.message}`);
  },
};
