import { PROFILE_FIELDS, type OwnerProfile, type ProfileStore } from "../forms/profile.js";
import { db } from "./client.js";

/** The owner's details for forms (D63, building block C), in `agent_state`. Personal data belongs in the database, never in the repo. */

const STATE_KEY = "owner_profile";

export const profileStore: ProfileStore = {
  async load() {
    const { data, error } = await db.from("agent_state").select("value").eq("key", STATE_KEY).maybeSingle();
    if (error) throw new Error(`Profile not readable: ${error.message}`);
    const raw = (data?.value ?? {}) as Record<string, unknown>;
    const profile: OwnerProfile = {};
    for (const field of PROFILE_FIELDS) if (typeof raw[field] === "string" && raw[field]) profile[field] = raw[field];
    return profile;
  },

  async save(profile) {
    const { error } = await db.from("agent_state").upsert({ key: STATE_KEY, value: profile, updated_at: new Date().toISOString() });
    if (error) throw new Error(`Profile not saved: ${error.message}`);
  },
};
