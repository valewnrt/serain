import {
  DELIVERY_MAX_CONSECUTIVE_FAILURES,
  DELIVERY_MAX_FAILURE_RATIO,
  DELIVERY_RATIO_MIN_ATTEMPTS,
  DELIVERY_REASON_MAX_CHARS,
  DELIVERY_WINDOW_MS,
} from "../config/limits.js";

/**
 * Delivery as a health component (D44). The channel only reports whether
 * Photon's stream stands (D38); whether messages arrive is only seen when
 * sending. What counts is what `channel.send` throws: incoming read receipts
 * never arrive in production and are no use as a signal.
 *
 * Pure bookkeeping without input and output: the `OutboundGate` records, the
 * heartbeat reads. Separate, so window and thresholds can be tested without a
 * channel and without a database.
 */

export interface DeliveryHealth {
  healthy: boolean;
  /**
   * No send attempt yet since this process started. Then the process knows
   * nothing about delivery; the heartbeat therefore leaves an incident from the
   * last run open instead of reporting a restart as a recovery.
   */
  idle: boolean;
  /** Attempts and failures in the last `DELIVERY_WINDOW_MS`. */
  attempts: number;
  failures: number;
  consecutiveFailures: number;
  /** Shortened and without numbers, see `deliveryReason`. */
  lastError: string | null;
}

/**
 * Error reason for the audit log and `component_status`. Photon's reasons carry
 * no content ("Target not allowed for this project", "Photon did not confirm
 * the delivery"); Spectrum, however, writes phone numbers into some errors
 * ("No iMessage client serves phone …"). Those go, and everything is cut to
 * `DELIVERY_REASON_MAX_CHARS` in case an SDK ever writes more into it.
 */
export function deliveryReason(raw: string): string {
  const cleaned = raw
    .replace(/\+?\d(?:[\s/().-]?\d){6,}/g, "<number>")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > DELIVERY_REASON_MAX_CHARS ? `${cleaned.slice(0, DELIVERY_REASON_MAX_CHARS - 1)}…` : cleaned;
}

interface Attempt {
  at: number;
  ok: boolean;
}

export class DeliveryLog {
  private attempts: Attempt[] = [];
  private consecutiveFailures = 0;
  private everAttempted = false;
  private failing = false;
  private lastError: string | null = null;
  private lastSuccessAt: number | null = null;

  /**
   * Records a send attempt and says whether the state flipped.
   *
   * Delivery becomes sick only here, on failure, and healthy only on success.
   * The window ages, the state does not: three failed replies followed by half
   * an hour of silence are no recovery, but exactly the case in which the
   * owner gets nothing any more.
   */
  record(at: number, ok: boolean, reason = ""): boolean {
    const before = this.failing;
    this.everAttempted = true;
    this.attempts = this.attempts.filter((attempt) => at - attempt.at < DELIVERY_WINDOW_MS);
    this.attempts.push({ at, ok });
    if (ok) {
      this.lastSuccessAt = at;
      this.consecutiveFailures = 0;
      this.failing = false;
    } else {
      this.consecutiveFailures += 1;
      this.lastError = deliveryReason(reason);
      const failures = this.attempts.filter((attempt) => !attempt.ok).length;
      const ratioTripped =
        this.attempts.length >= DELIVERY_RATIO_MIN_ATTEMPTS && failures / this.attempts.length >= DELIVERY_MAX_FAILURE_RATIO;
      if (this.consecutiveFailures >= DELIVERY_MAX_CONSECUTIVE_FAILURES || ratioTripped) this.failing = true;
    }
    return before !== this.failing;
  }

  /** The last attempt that went through at the channel; null if none since start. */
  lastSuccess(): number | null {
    return this.lastSuccessAt;
  }

  /** Pure evaluation at `now`, without side effect. Without attempts: healthy, silence is no error. */
  health(now: number): DeliveryHealth {
    const recent = this.attempts.filter((attempt) => now - attempt.at < DELIVERY_WINDOW_MS);
    return {
      healthy: !this.failing,
      idle: !this.everAttempted,
      attempts: recent.length,
      failures: recent.filter((attempt) => !attempt.ok).length,
      consecutiveFailures: this.consecutiveFailures,
      lastError: this.lastError,
    };
  }
}
