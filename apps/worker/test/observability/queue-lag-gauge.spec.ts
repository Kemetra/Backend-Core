/**
 * Unit tests for `registerQueueLagGauge` and `createQueueLagCallback` (P4 W2).
 *
 * Uses `createQueueLagCallback` — the exported inner callback builder — to
 * invoke the real production callback path with a mock `QueueLagObservableResult`
 * and `getWaitingFn`. This exercises the actual lag calculation, re-entrancy
 * guard, per-queue error isolation, and negative-lag clamping without requiring
 * a live OTel MetricReader or Redis connection.
 *
 * `registerQueueLagGauge` itself is tested for the null/no-op contract and
 * stop idempotency (the OTel addCallback is a no-op in unit tests, so the
 * callback-path coverage lives in the `createQueueLagCallback` suites).
 *
 * Constitution §VII / FR-B-006 / P4 W2.
 */
import type { Queue } from "bullmq";

import {
  createQueueLagCallback,
  registerQueueLagGauge,
  WORKER_QUEUE_NAMES,
  type QueueLagObservableResult,
} from "../../src/observability/metrics/worker.metrics";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Observation = { value: number; queue: string };

function makeObservableResult(): {
  result: QueueLagObservableResult;
  observations: Observation[];
} {
  const observations: Observation[] = [];
  const result: QueueLagObservableResult = {
    observe(value: number, attributes: Record<string, unknown>) {
      observations.push({ value, queue: attributes["queue"] as string });
    },
  };
  return { result, observations };
}

/** Dummy Queue — only the getWaitingFn seam is called, never the real queue. */
function makeNullQueue(): Queue {
  return null as unknown as Queue;
}

/** Build a queues map for all 5 WORKER_QUEUE_NAMES. */
function makeFullQueues(): ReadonlyMap<string, Queue> {
  return new Map(WORKER_QUEUE_NAMES.map((n) => [n, makeNullQueue()]));
}

// ---------------------------------------------------------------------------
// 1. registerQueueLagGauge — null/no-op contract
// ---------------------------------------------------------------------------

describe("registerQueueLagGauge — null queues (no-Redis path)", () => {
  it("returns a handle with a stop function", () => {
    const handle = registerQueueLagGauge({ queues: null });
    expect(typeof handle.stop).toBe("function");
  });

  it("stop() does not throw on the null path", () => {
    const handle = registerQueueLagGauge({ queues: null });
    expect(() => handle.stop()).not.toThrow();
  });

  it("stop() is idempotent on the null path", () => {
    const handle = registerQueueLagGauge({ queues: null });
    expect(() => {
      handle.stop();
      handle.stop();
    }).not.toThrow();
  });

  it("multiple null registrations do not interfere", () => {
    const handles = Array.from({ length: 5 }, () =>
      registerQueueLagGauge({ queues: null }),
    );
    expect(() => handles.forEach((h) => h.stop())).not.toThrow();
  });
});

describe("registerQueueLagGauge — non-null queues (registration smoke)", () => {
  it("returns a handle with a stop function when queues are provided", () => {
    const handle = registerQueueLagGauge({
      queues: makeFullQueues(),
      getWaitingFn: async () => [],
    });
    expect(typeof handle.stop).toBe("function");
    handle.stop();
  });

  it("stop() does not throw after registration", () => {
    const handle = registerQueueLagGauge({
      queues: makeFullQueues(),
      getWaitingFn: async () => [],
    });
    expect(() => handle.stop()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 2. createQueueLagCallback — lag calculation via the real callback path
// ---------------------------------------------------------------------------

describe("createQueueLagCallback — lag calculation (real callback path)", () => {
  it("observes 0 for every queue when no jobs are waiting", async () => {
    const { result, observations } = makeObservableResult();
    const callback = createQueueLagCallback(
      makeFullQueues(),
      async () => [],
    );
    await callback(result);

    expect(observations).toHaveLength(WORKER_QUEUE_NAMES.length);
    for (const obs of observations) {
      expect(obs.value).toBe(0);
    }
    expect(observations.map((o) => o.queue).sort()).toEqual(
      [...WORKER_QUEUE_NAMES].sort(),
    );
  });

  it("observes positive lag when a waiting job exists", async () => {
    const { result, observations } = makeObservableResult();
    const twoSecondsAgo = Date.now() - 2000;
    const callback = createQueueLagCallback(
      makeFullQueues(),
      async () => [{ timestamp: twoSecondsAgo }],
    );
    await callback(result);

    for (const obs of observations) {
      expect(obs.value).toBeGreaterThanOrEqual(1.9);
      expect(obs.value).toBeLessThan(4);
    }
  });

  it("clamps lag to >= 0 when job timestamp is in the future (clock drift)", async () => {
    const { result, observations } = makeObservableResult();
    const futureTimestamp = Date.now() + 60_000;
    const callback = createQueueLagCallback(
      makeFullQueues(),
      async () => [{ timestamp: futureTimestamp }],
    );
    await callback(result);

    for (const obs of observations) {
      expect(obs.value).toBe(0);
    }
  });

  it("observes lag only for queues present in the map", async () => {
    const { result, observations } = makeObservableResult();
    // Only 'email' in the map — the other 4 queues are absent.
    const singleQueue = new Map<string, Queue>([
      ["email", makeNullQueue()],
    ]);
    const callback = createQueueLagCallback(
      singleQueue,
      async () => [{ timestamp: Date.now() - 1000 }],
    );
    await callback(result);

    expect(observations).toHaveLength(1);
    expect(observations[0]?.queue).toBe("email");
  });

  it("labels each observation with the correct queue name", async () => {
    const { result, observations } = makeObservableResult();
    const callback = createQueueLagCallback(makeFullQueues(), async () => []);
    await callback(result);

    const observedQueues = observations.map((o) => o.queue).sort();
    expect(observedQueues).toEqual([...WORKER_QUEUE_NAMES].sort());
  });
});

// ---------------------------------------------------------------------------
// 3. createQueueLagCallback — re-entrancy guard
// ---------------------------------------------------------------------------

describe("createQueueLagCallback — re-entrancy guard", () => {
  it("skips a second concurrent invocation while the first is in-flight", async () => {
    let resolveFirst!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    let firstComplete = false;

    const { result: r1, observations: obs1 } = makeObservableResult();
    const { result: r2, observations: obs2 } = makeObservableResult();

    const callback = createQueueLagCallback(
      makeFullQueues(),
      async () => {
        resolveFirst();
        // Pause until the test advances (simulates a slow Redis call)
        await new Promise<void>((res) => setTimeout(res, 20));
        firstComplete = true;
        return [];
      },
    );

    // Start first call but don't await yet
    const first = callback(r1);
    await firstStarted; // first is now in-flight

    // Second call while first is still running — should be skipped
    await callback(r2);
    expect(obs2).toHaveLength(0); // skipped

    await first;
    expect(firstComplete).toBe(true);
    expect(obs1).toHaveLength(WORKER_QUEUE_NAMES.length);
  });

  it("allows a second invocation after the first has completed", async () => {
    const { result: r1 } = makeObservableResult();
    const { result: r2, observations: obs2 } = makeObservableResult();

    const callback = createQueueLagCallback(makeFullQueues(), async () => []);

    await callback(r1);
    await callback(r2);

    // Second call should have been allowed since first is done
    expect(obs2).toHaveLength(WORKER_QUEUE_NAMES.length);
  });
});

// ---------------------------------------------------------------------------
// 4. createQueueLagCallback — per-queue error isolation
// ---------------------------------------------------------------------------

describe("createQueueLagCallback — per-queue error isolation", () => {
  it("continues observing other queues when one throws", async () => {
    const { result, observations } = makeObservableResult();

    // Use distinct objects so reference equality correctly identifies each queue
    const emailQueue = {} as unknown as Queue;
    const auditQueue = {} as unknown as Queue;
    const queuesMap = new Map<string, Queue>([
      ["email", emailQueue],
      ["audit", auditQueue],
    ]);

    const callback = createQueueLagCallback(queuesMap, async (queue) => {
      if (queue === emailQueue) throw new Error("Redis connection refused");
      return [];
    });

    const stderrLines: string[] = [];
    jest
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: unknown) => {
        stderrLines.push(String(chunk));
        return true;
      });

    await callback(result);

    jest.restoreAllMocks();

    // "audit" observed (lag 0); "email" skipped due to throw
    expect(observations).toHaveLength(1);
    expect(observations[0]?.queue).toBe("audit");
    // One stderr line written for the "email" error
    expect(stderrLines).toHaveLength(1);
    const logged = JSON.parse(stderrLines[0] ?? "{}") as Record<string, string>;
    expect(logged["errorName"]).toBe("Error");
    expect(logged["queue"]).toBe("email");
  });

  it("callback does not throw even when all queues error", async () => {
    const { result } = makeObservableResult();
    jest.spyOn(process.stderr, "write").mockReturnValue(true);

    const callback = createQueueLagCallback(makeFullQueues(), async () => {
      throw new Error("total failure");
    });

    await expect(callback(result)).resolves.toBeUndefined();
    jest.restoreAllMocks();
  });
});
