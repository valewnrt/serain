import { db } from "./db/client.js";
import { audit } from "./db/audit.js";
import { log } from "./log.js";
import { owner } from "./config/owner.js";
import { t } from "./i18n/catalog.js";
import { currentLanguage } from "./i18n/language.js";
import { core } from "./i18n/messages/core.js";
import { primaryWord } from "./i18n/words.js";

/**
 * The first message (W2), in the starting language (`OWNER_LANGUAGE`): it goes
 * out before the owner has written anything Serain could read a language
 * from. It names the emergency stop with the word that works right now
 * (`primaryWord`). Wording in the catalog (`core.hello`), for the style round.
 *
 * **Exactly once in the life of this installation.** It used to hang on the
 * environment variable `SERAIN_HELLO`: set meant "on every start", empty meant
 * "never". Both are wrong: a restart or a deploy is no reason to introduce
 * itself again, and a new server is no reason never to do it. So the marker
 * lives in `agent_state` and survives restart and deploy.
 *
 * It is atomic through the primary key: the marker is created with `insert`,
 * not with `upsert`. Two processes starting at the same time get exactly one
 * winner; the second runs into the unique constraint and stays silent.
 *
 * And: **existing history means already greeted.** If the owner is already
 * writing with Serain, the first start with this code must not send the
 * introduction after the fact; it marks it as done and sends nothing.
 */
export function helloMessage(lang: string = currentLanguage()): string {
  return t(core.hello, { stop: primaryWord("stop", lang) }, lang);
}

const STATE_KEY = "hello_sent";
const UNIQUE_VIOLATION = "23505";

export interface HelloStore {
  /**
   * Creates the marker. `false` if it already existed: that is the atomic step
   * that decides who may send.
   */
  claim(reason: string): Promise<boolean>;
  /** Are there already messages in this conversation, in either direction? */
  hasHistory(peer: string): Promise<boolean>;
}

export const supabaseHelloStore: HelloStore = {
  async claim(reason: string): Promise<boolean> {
    const { error } = await db.from("agent_state").insert({
      key: STATE_KEY,
      value: { at: new Date().toISOString(), reason },
    });
    if (!error) return true;
    if (error.code === UNIQUE_VIOLATION) return false;
    throw new Error(`Greeting marker not settable: ${error.message}`);
  },

  async hasHistory(peer: string): Promise<boolean> {
    const { count, error } = await db
      .from("messages")
      .select("id", { count: "exact", head: true })
      .eq("peer", peer);
    if (error) throw new Error(`History not checkable: ${error.message}`);
    return (count ?? 0) > 0;
  },
};

/**
 * May the first message go out now?
 *
 * Fail closed in both directions: if the state is not readable or the marker
 * not settable, nothing is sent. A missed introduction is caught up by the
 * next start; a double one would be in the owner's chat and could not be
 * taken back.
 */
export async function claimFirstMessage(
  peer: string,
  store: HelloStore = supabaseHelloStore,
): Promise<boolean> {
  let greetedBefore: boolean;
  try {
    greetedBefore = await store.hasHistory(peer);
  } catch (error) {
    log.error("History not checkable, rather not greeting:", (error as Error).message);
    return false;
  }

  let claimed: boolean;
  try {
    claimed = await store.claim(greetedBefore ? "existing_history" : "first_start");
  } catch (error) {
    log.error("Greeting marker not settable, rather not greeting:", (error as Error).message);
    return false;
  }

  if (!claimed) return false;
  if (greetedBefore) {
    // Marker set, but nothing sent: you are already writing with each other.
    await audit("hello", { sent: false, reason: "existing_history" });
    log.info(`First message skipped: there is already history with ${owner.name}.`);
    return false;
  }
  return true;
}
