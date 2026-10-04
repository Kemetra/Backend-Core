/**
 * queue.config spec — shared single source of truth (T092 + T301-partial).
 *
 * Pure unit tests against the exported constants. No BullMQ runtime,
 * no Redis, no `ioredis-mock`, no Testcontainers.
 *
 * Three flavours of assertion:
 *   1. Value pinning — every load-bearing number is asserted by literal,
 *      so a future PR that changes a default must deliberately update
 *      the spec and explain why.
 *   2. Invariants — relationships between values that, if violated,
 *      would defeat the policy.
 *   3. Immutability — `Object.freeze` makes accidental mutation throw
 *      in strict mode (TypeScript's `Readonly<>` is structural only).
 *
 * This file replaces `apps/worker/test/queues/queue.config.spec.ts`
 * (PR #17 / T092) — the values moved up one layer to the shared
 * package; the assertions follow them.
 */
import {
  deepFreeze,
  DEFAULT_JOB_OPTIONS,
  DEFAULT_WORKER_OPTIONS,
  QUEUE_NAMES,
} from "../../src/queues/queue.config";

describe("DEFAULT_JOB_OPTIONS — pinned values", () => {
  it("retries up to 5 times (1 initial + 4 retries)", () => {
    expect(DEFAULT_JOB_OPTIONS.attempts).toBe(5);
  });

  it("backs off exponentially with a 1000ms base", () => {
    expect(DEFAULT_JOB_OPTIONS.backoff).toEqual({
      type: "exponential",
      delay: 1_000,
    });
  });

  it("retains completed jobs for 24h up to 1000 entries", () => {
    expect(DEFAULT_JOB_OPTIONS.removeOnComplete).toEqual({
      age: 24 * 3600,
      count: 1_000,
    });
  });

  it("retains failed jobs for 7 days up to 10000 entries (DLQ retention)", () => {
    expect(DEFAULT_JOB_OPTIONS.removeOnFail).toEqual({
      age: 7 * 24 * 3600,
      count: 10_000,
    });
  });
});

describe("DEFAULT_JOB_OPTIONS — invariants", () => {
  it("attempts is at least 2 (1 attempt = no retry, defeats the policy)", () => {
    expect(DEFAULT_JOB_OPTIONS.attempts).toBeGreaterThanOrEqual(2);
  });

  it("failed-set retention age >= completed-set retention age (failures are forensic)", () => {
    expect(DEFAULT_JOB_OPTIONS.removeOnFail.age).toBeGreaterThanOrEqual(
      DEFAULT_JOB_OPTIONS.removeOnComplete.age,
    );
  });

  it("failed-set retention count >= completed-set retention count", () => {
    expect(DEFAULT_JOB_OPTIONS.removeOnFail.count).toBeGreaterThanOrEqual(
      DEFAULT_JOB_OPTIONS.removeOnComplete.count,
    );
  });

  it("backoff base delay is at least 100ms (sub-100ms thrashes Redis on recovery)", () => {
    expect(DEFAULT_JOB_OPTIONS.backoff.delay).toBeGreaterThanOrEqual(100);
  });
});

describe("DEFAULT_WORKER_OPTIONS — pinned values", () => {
  it("runs 4 jobs concurrently per worker process", () => {
    expect(DEFAULT_WORKER_OPTIONS.concurrency).toBe(4);
  });

  it("holds a job lock for 30s before another worker can reclaim it", () => {
    expect(DEFAULT_WORKER_OPTIONS.lockDuration).toBe(30_000);
  });

  it("checks for stalled jobs every 30s", () => {
    expect(DEFAULT_WORKER_OPTIONS.stalledInterval).toBe(30_000);
  });

  it("gives a stalled job exactly one re-pickup before failing", () => {
    expect(DEFAULT_WORKER_OPTIONS.maxStalledCount).toBe(1);
  });
});

describe("DEFAULT_WORKER_OPTIONS — invariants", () => {
  it("concurrency is positive", () => {
    expect(DEFAULT_WORKER_OPTIONS.concurrency).toBeGreaterThan(0);
  });

  it("lockDuration > 1s (sub-second locks would thrash)", () => {
    expect(DEFAULT_WORKER_OPTIONS.lockDuration).toBeGreaterThan(1_000);
  });

  it("stalledInterval > 0", () => {
    expect(DEFAULT_WORKER_OPTIONS.stalledInterval).toBeGreaterThan(0);
  });

  it("maxStalledCount >= 1 (zero would fail any worker restart)", () => {
    expect(DEFAULT_WORKER_OPTIONS.maxStalledCount).toBeGreaterThanOrEqual(1);
  });
});

describe("Immutability", () => {
  it("DEFAULT_JOB_OPTIONS is frozen at the top level", () => {
    expect(Object.isFrozen(DEFAULT_JOB_OPTIONS)).toBe(true);
  });

  it("DEFAULT_JOB_OPTIONS.backoff is frozen (deep freeze)", () => {
    expect(Object.isFrozen(DEFAULT_JOB_OPTIONS.backoff)).toBe(true);
  });

  it("DEFAULT_JOB_OPTIONS.removeOnComplete is frozen (deep freeze)", () => {
    expect(Object.isFrozen(DEFAULT_JOB_OPTIONS.removeOnComplete)).toBe(true);
  });

  it("DEFAULT_JOB_OPTIONS.removeOnFail is frozen (deep freeze)", () => {
    expect(Object.isFrozen(DEFAULT_JOB_OPTIONS.removeOnFail)).toBe(true);
  });

  it("DEFAULT_WORKER_OPTIONS is frozen at the top level", () => {
    expect(Object.isFrozen(DEFAULT_WORKER_OPTIONS)).toBe(true);
  });

  it("mutating a frozen default throws in strict mode", () => {
    "use strict";
    expect(() => {
      (DEFAULT_JOB_OPTIONS as unknown as { attempts: number }).attempts = 1;
    }).toThrow();
  });

  it("mutating a nested frozen field throws in strict mode", () => {
    "use strict";
    expect(() => {
      (DEFAULT_JOB_OPTIONS.backoff as unknown as { delay: number }).delay = 99;
    }).toThrow();
  });
});

describe("deepFreeze helper", () => {
  it("freezes the top-level object", () => {
    const out = deepFreeze({ a: 1 });
    expect(Object.isFrozen(out)).toBe(true);
  });

  it("freezes nested objects", () => {
    const obj = { a: { b: 1 } };
    deepFreeze(obj);
    expect(Object.isFrozen(obj.a)).toBe(true);
  });

  it("returns the same reference (does not clone)", () => {
    const obj = { a: 1 };
    expect(deepFreeze(obj)).toBe(obj);
  });

  it("is idempotent on already-frozen objects", () => {
    const obj = Object.freeze({ a: 1 });
    expect(() => deepFreeze(obj)).not.toThrow();
  });

  it("handles null gracefully", () => {
    expect(deepFreeze(null)).toBeNull();
  });

  it("returns primitives unchanged", () => {
    expect(deepFreeze(42)).toBe(42);
    expect(deepFreeze("hi")).toBe("hi");
  });
});

describe("QUEUE_NAMES (RT-125)", () => {
  it("pins the BullMQ wire names (Redis keys — never rename without draining)", () => {
    expect(QUEUE_NAMES).toEqual({
      email: "email",
      audit: "audit",
      auditRetention: "audit-retention",
      saleProcessing: "sale-processing",
      outboxRetention: "outbox-retention",
      erpnextStockReconciliationSweep: "erpnext-stock-reconciliation-sweep",
    });
  });

  it("is frozen", () => {
    expect(Object.isFrozen(QUEUE_NAMES)).toBe(true);
  });
});
