import { APPROVAL_TTL_MS, FORM_HOLD_GRACE_MS, FORM_MAX_HELD } from "../config/limits.js";
import { log } from "../log.js";
import { FormFailure, type FormSession, type HeldForm } from "./session.js";

/**
 * Filled forms waiting for the owner's 👍 (D63, part C). Only in memory: an
 * open browser cannot be stored, and after a restart the form is gone; then
 * `web_submit` says so, nothing was submitted. Every form waits as long as its
 * preview is valid plus two minutes, then the browser closes by itself.
 */
export class FormHolds {
  private readonly held = new Map<string, { form: HeldForm; session: FormSession; timer: NodeJS.Timeout }>();

  constructor(private readonly ttlMs: number = APPROVAL_TTL_MS + FORM_HOLD_GRACE_MS) {}

  get size(): number {
    return this.held.size;
  }

  /** Is the maximum already waiting? Then the executor fills in no further one. */
  get full(): boolean {
    return this.held.size >= FORM_MAX_HELD;
  }

  add(form: HeldForm, session: FormSession): void {
    const timer = setTimeout(() => void this.drop(form.token, "expired"), this.ttlMs);
    timer.unref();
    this.held.set(form.token, { form, session, timer });
  }

  get(token: string): HeldForm | null {
    return this.held.get(token)?.form ?? null;
  }

  /** Submits and closes the browser, however it turns out. */
  async submit(token: string): Promise<string> {
    const entry = this.held.get(token);
    if (!entry) throw new FormFailure("changed", "This form is no longer open (expired or after a restart). Nothing was submitted.");
    this.held.delete(token);
    clearTimeout(entry.timer);
    try {
      return await entry.session.submitHeld(entry.form);
    } finally {
      await entry.session.close().catch(() => undefined);
    }
  }

  async drop(token: string, why: string): Promise<void> {
    const entry = this.held.get(token);
    if (!entry) return;
    this.held.delete(token);
    clearTimeout(entry.timer);
    log.info(`Form ${token} closed (${why})`);
    await entry.session.close().catch(() => undefined);
  }

  /** Kill switch and shutdown: nothing stays open. */
  async dropAll(why: string): Promise<void> {
    await Promise.all([...this.held.keys()].map((token) => this.drop(token, why)));
  }
}
