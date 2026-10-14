import { db } from "../db/client.js";
import { pgRows } from "../db/pg.js";
import { audit } from "../db/audit.js";
import { currentLanguage } from "../i18n/language.js";
import { parseCommand } from "../i18n/words.js";
import { log } from "../log.js";

/**
 * Kill switch (D8.2). A codeword, checked by the code, entirely outside the
 * LLM loop. Locks all tools until the owner releases them by hand. The state
 * lives in `agent_state`, so a restart does not lift it.
 */
const STATE_KEY = "kill_switch";

export type KillSwitchCommand = "engage" | "release" | null;

/**
 * "serain stop" (or "serain stopp", or the current language's stop word) at
 * the start of a message engages; "serain resume" ("serain weiter", or the
 * current language's word) releases. "serain stop" works in every language;
 * on a doubt, stop wins (`src/i18n/words.ts`).
 */
export function detectKillSwitchCommand(text: string, lang: string = currentLanguage()): KillSwitchCommand {
  const command = parseCommand(text, lang);
  if (command === "stop") return "engage";
  if (command === "resume") return "release";
  return null;
}

export interface KillSwitchState {
  engaged: boolean;
  since: string | null;
  reason: string | null;
}

export class KillSwitch {
  private state: KillSwitchState = { engaged: false, since: null, reason: null };

  /**
   * Reads the state from the database. Called on every inbound message, not
   * only at start: the database is the truth, not this process's memory.
   * Otherwise a restart or a second process would silently lift the lock, and
   * that is exactly what a kill switch must not allow.
   */
  async load(): Promise<KillSwitchState> {
    // Through Postgres (`pg.ts`): read on every message and on every scheduler round.
    let rows: Array<{ value: unknown }>;
    try {
      rows = await pgRows("Kill switch not readable", (sql) => sql`select value from public.agent_state where key = ${STATE_KEY}`);
    } catch (error) {
      // When in doubt, lock: an unreadable state must not release any tools.
      log.error("Kill switch state not readable, locking as a precaution:", (error as Error).message);
      this.state = { engaged: true, since: new Date().toISOString(), reason: "state_unreadable" };
      return this.state;
    }
    const value = rows[0]?.value as Partial<KillSwitchState> | undefined;
    this.state = {
      engaged: value?.engaged === true,
      since: typeof value?.since === "string" ? value.since : null,
      reason: typeof value?.reason === "string" ? value.reason : null,
    };
    if (this.state.engaged) {
      log.warn(`Kill switch active since ${this.state.since ?? "unknown"}`);
    }
    return this.state;
  }

  /** Last state read. For decisions use `load()`. */
  get engaged(): boolean {
    return this.state.engaged;
  }

  get since(): string | null {
    return this.state.since;
  }

  async engage(reason: string): Promise<void> {
    this.state = { engaged: true, since: new Date().toISOString(), reason };
    await this.persist();
    await audit("kill_switch", { reason, since: this.state.since });
    log.warn(`Kill switch engaged (${reason}). Tools are locked.`);
  }

  async release(reason: string): Promise<void> {
    this.state = { engaged: false, since: null, reason };
    await this.persist();
    await audit("kill_switch_release", { reason });
    log.info(`Kill switch released (${reason}).`);
  }

  private async persist(): Promise<void> {
    const { error } = await db
      .from("agent_state")
      .upsert({ key: STATE_KEY, value: this.state, updated_at: new Date().toISOString() });
    if (error) {
      log.error("Kill switch state could not be saved:", error.message);
      throw new Error("Kill switch state not persisted");
    }
  }
}
