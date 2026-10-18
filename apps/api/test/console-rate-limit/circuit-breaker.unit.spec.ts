/**
 * RT-619 — the console limiter's circuit breaker (RT-574 D4): open after 5
 * consecutive failures, let ONE probe through after 10 s, close on a good
 * probe and re-open on a bad one.
 */
import { ConsoleRateLimitBreaker } from "../../src/console-rate-limit/circuit-breaker";

function breakerAt(start = 1_000_000) {
  let now = start;
  const breaker = new ConsoleRateLimitBreaker({ failureThreshold: 5, openMs: 10_000 }, () => now);
  return {
    breaker,
    advance(ms: number) {
      now += ms;
    },
  };
}

function fail(breaker: ConsoleRateLimitBreaker, times: number): void {
  for (let i = 0; i < times; i++) {
    expect(breaker.tryAcquire()).toBe(true);
    breaker.onFailure();
  }
}

describe("ConsoleRateLimitBreaker", () => {
  it("stays closed below the threshold", () => {
    const { breaker } = breakerAt();
    fail(breaker, 4);
    expect(breaker.tryAcquire()).toBe(true);
  });

  it("a success resets the consecutive-failure count", () => {
    const { breaker } = breakerAt();
    fail(breaker, 4);
    breaker.onSuccess();
    fail(breaker, 4);
    expect(breaker.tryAcquire()).toBe(true);
  });

  it("opens after 5 consecutive failures and skips checks for 10 s", () => {
    const { breaker, advance } = breakerAt();
    fail(breaker, 5);
    expect(breaker.tryAcquire()).toBe(false);
    advance(9_999);
    expect(breaker.tryAcquire()).toBe(false);
  });

  it("after 10 s lets exactly one probe through while it is in flight", () => {
    const { breaker, advance } = breakerAt();
    fail(breaker, 5);
    advance(10_000);
    expect(breaker.tryAcquire()).toBe(true);
    expect(breaker.tryAcquire()).toBe(false);
    expect(breaker.tryAcquire()).toBe(false);
  });

  it("a successful probe closes the breaker", () => {
    const { breaker, advance } = breakerAt();
    fail(breaker, 5);
    advance(10_000);
    expect(breaker.tryAcquire()).toBe(true);
    breaker.onSuccess();
    expect(breaker.tryAcquire()).toBe(true);
    expect(breaker.tryAcquire()).toBe(true);
  });

  it("a failed probe re-opens the breaker for another 10 s", () => {
    const { breaker, advance } = breakerAt();
    fail(breaker, 5);
    advance(10_000);
    expect(breaker.tryAcquire()).toBe(true);
    breaker.onFailure();
    expect(breaker.tryAcquire()).toBe(false);
    advance(9_999);
    expect(breaker.tryAcquire()).toBe(false);
    advance(1);
    expect(breaker.tryAcquire()).toBe(true);
  });
});
