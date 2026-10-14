/**
 * Prevents spam from a flickering component: the same component triggers a
 * report to the owner at most every `minIntervalMs`. Independent of the
 * general rate limit in the OutboundGate (D8.8), which caps the amount of
 * messages overall, not repetitions of the same kind of incident.
 *
 * Asking and recording are separate, and that is the point: the old version
 * had only a `shouldNotify` that already recorded when asked. Whoever then did
 * not send after all (outage too short, bundled report) silently burned the
 * component's time window and would have swallowed the next, real report for
 * 30 min.
 */
export class IncidentNotificationLimiter {
  private readonly lastNotifiedAt = new Map<string, number>();

  constructor(private readonly minIntervalMs: number) {}

  /** A pure question, without side effect. */
  allows(component: string, now: number = Date.now()): boolean {
    const last = this.lastNotifiedAt.get(component);
    return last === undefined || now - last >= this.minIntervalMs;
  }

  /** Call only once the report really went out. */
  record(components: readonly string[], now: number = Date.now()): void {
    for (const component of components) this.lastNotifiedAt.set(component, now);
  }
}
