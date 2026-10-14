import { DEFAULT_RUN_CAP_USD, MAX_REQUESTS_PER_RUN } from "./config.js";

/**
 * Hard cap per eval run. The monthly cap from `src/config/limits.ts` still
 * applies and is checked in the model layer (`viaOpenRouter` throws
 * `BudgetExceededError`); this one is the second belt against a
 * mistyped command.
 *
 * Measured **after** each request: the cost is only known from the response.
 * In the worst case exactly one request goes over the cap, after that the
 * run is over. A limit on the number of requests additionally catches the
 * case where everything costs 0 $ (subscription path) and the run still derails.
 */

export class RunCapReached extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "RunCapReached";
  }
}

export class RunCap {
  spentUsd = 0;
  requests = 0;

  constructor(
    readonly capUsd: number = DEFAULT_RUN_CAP_USD,
    readonly maxRequests: number = MAX_REQUESTS_PER_RUN,
  ) {
    if (!(capUsd > 0)) throw new Error("The run cap must be greater than 0");
  }

  /** May another request go out? Returns the reason if not. */
  blockedReason(): string | null {
    if (this.spentUsd >= this.capUsd) {
      return `Run cap reached: ${this.spentUsd.toFixed(4)} of ${this.capUsd.toFixed(2)} $`;
    }
    if (this.requests >= this.maxRequests) {
      return `Too many requests in one run: ${this.requests} of ${this.maxRequests}`;
    }
    return null;
  }

  /** Throws when the cap is reached. Call before every request. */
  assertOpen(): void {
    const reason = this.blockedReason();
    if (reason) throw new RunCapReached(reason);
  }

  record(costUsd: number): void {
    this.requests += 1;
    this.spentUsd += Number.isFinite(costUsd) ? Math.max(0, costUsd) : 0;
  }
}
