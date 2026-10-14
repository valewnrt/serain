import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "../config/env.js";
import { keepAliveFetch } from "../net/keepalive.js";

/**
 * One client for the whole process, with the secret key. The key bypasses RLS;
 * that is why there is exactly this one path into the database and none from
 * the browser. No session persistence, the process is not a user.
 */
export const db: SupabaseClient = createClient(env.supabaseUrl, env.supabaseSecretKey, {
  auth: { persistSession: false, autoRefreshToken: false },
  // The connection stays open between messages (D50).
  global: { headers: { "x-application-name": "serain" }, fetch: keepAliveFetch },
});
