/**
 * In-process circuit breaker for the console limiter (RT-619, RT-574 D4).
 *
 * Fail-open alone is not enough: during a sustained Redis outage every
 * console request would still wait out the 250 ms timeout. After
 * `failureThreshold` consecutive failures the breaker opens and the guard
 * skips the limiter (allowing, counted as `fail_open`). After `openMs` it
 * lets ONE probe through; a good probe closes it, a bad one re-opens it.
 *
 * Per process, not shared: each API instance learns about the outage on its
 * own, which is what bounds its own latency.
 */
export interface ConsoleRateLimitBreakerOptions {
  readonly failureThreshold: number;
  readonly openMs: number;
}

export class ConsoleRateLimitBreaker {
  private consecutiveFailures = 0;
  private openedAt: number | null = null;
  private probeInFlight = false;

  constructor(
    private readonly options: ConsoleRateLimitBreakerOptions,
    private readonly now: () => number = Date.now,
  ) {}

  /** True when the caller may call the limiter now; false means skip (fail open). */
  tryAcquire(): boolean {
    if (this.openedAt === null) return true;
    if (this.probeInFlight) return false;
    if (this.now() - this.openedAt < this.options.openMs) return false;
    this.probeInFlight = true;
    return true;
  }

  onSuccess(): void {
    this.consecutiveFailures = 0;
    this.openedAt = null;
    this.probeInFlight = false;
  }

  onFailure(): void {
    if (this.probeInFlight) {
      this.probeInFlight = false;
      this.openedAt = this.now();
      return;
    }
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.options.failureThreshold) {
      this.openedAt = this.now();
    }
  }
}
