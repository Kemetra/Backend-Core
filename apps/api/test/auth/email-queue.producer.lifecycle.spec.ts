/**
 * email-queue.producer.lifecycle.spec.ts
 *
 * Pins `EmailQueueProducer`'s Nest `OnModuleDestroy` lifecycle contract.
 * Mirror of `audit-queue.producer.lifecycle.spec.ts`; see that file's
 * header docstring for the full rationale.
 *
 * Coverage:
 *   1. onModuleDestroy() -> queue.close() exactly once.
 *   2. Second onModuleDestroy() is a no-op.
 *   3. Queue without close() (test doubles) is tolerated.
 *   4. Errors from close() are swallowed.
 *   5. Nest moduleRef.close() reaches the hook in the DI container.
 *
 * No bullmq runtime, no ioredis. The producer accepts `Queue | QueueLike`
 * and we exercise both shapes via tiny hand-written doubles.
 */
import { Test } from "@nestjs/testing";
import {
  EmailQueueProducer,
  type QueueLike,
} from "../../src/auth/email-queue.producer";

// ---------------------------------------------------------------------------
// Hand-written doubles
// ---------------------------------------------------------------------------

class FakeQueueWithClose implements QueueLike {
  addCalls = 0;
  closeCalls = 0;
  async add(): Promise<unknown> {
    this.addCalls += 1;
    return {};
  }
  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

class FakeQueueNoClose implements QueueLike {
  async add(): Promise<unknown> {
    return {};
  }
}

class FakeQueueCloseThrows implements QueueLike {
  closeAttempts = 0;
  async add(): Promise<unknown> {
    return {};
  }
  async close(): Promise<void> {
    this.closeAttempts += 1;
    throw new Error("close failed (simulated)");
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("EmailQueueProducer.onModuleDestroy", () => {
  it("calls queue.close() exactly once when the underlying queue exposes it", async () => {
    const queue = new FakeQueueWithClose();
    const producer = new EmailQueueProducer(queue);
    await producer.onModuleDestroy();
    expect(queue.closeCalls).toBe(1);
  });

  it("is idempotent: a second onModuleDestroy() does not re-close", async () => {
    const queue = new FakeQueueWithClose();
    const producer = new EmailQueueProducer(queue);
    await producer.onModuleDestroy();
    await producer.onModuleDestroy();
    expect(queue.closeCalls).toBe(1);
  });

  it("tolerates a queue without close() (in-memory test doubles)", async () => {
    const queue = new FakeQueueNoClose();
    const producer = new EmailQueueProducer(queue);
    await expect(producer.onModuleDestroy()).resolves.toBeUndefined();
  });

  it("swallows errors from queue.close() (best-effort shutdown)", async () => {
    const queue = new FakeQueueCloseThrows();
    const producer = new EmailQueueProducer(queue);
    await expect(producer.onModuleDestroy()).resolves.toBeUndefined();
    expect(queue.closeAttempts).toBe(1);
  });

  it("Nest moduleRef.close() invokes the producer's onModuleDestroy which calls queue.close()", async () => {
    const queue = new FakeQueueWithClose();
    const moduleRef = await Test.createTestingModule({
      providers: [
        { provide: "EMAIL_QUEUE", useValue: queue },
        {
          provide: EmailQueueProducer,
          useFactory: (q: QueueLike) => new EmailQueueProducer(q),
          inject: ["EMAIL_QUEUE"],
        },
      ],
    }).compile();

    const producer = moduleRef.get(EmailQueueProducer);
    expect(producer).toBeInstanceOf(EmailQueueProducer);

    await moduleRef.close();

    expect(queue.closeCalls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Lazy-init mode -- the override-orphan leak fix (symmetric to audit producer)
// ---------------------------------------------------------------------------
//
// See `audit-queue.producer.lifecycle.spec.ts` for the full rationale.
// The production `emailJobEnqueuerFactory` now returns a producer in
// LAZY mode -- it accepts a `() => Queue` thunk instead of an eager
// Queue. The test cases below pin the same lazy semantics:
//
//   L-1: lazy producer does NOT call the provider thunk at construction.
//   L-2: first enqueue* invokes the thunk exactly once.
//   L-3: subsequent enqueue* calls reuse the materialised queue.
//   L-4: onModuleDestroy on a never-enqueued producer is a clean no-op.
//   L-5: onModuleDestroy AFTER enqueue closes the materialised queue.
//
describe("EmailQueueProducer.lazy mode (override-orphan leak fix)", () => {
  const PROBE_JOB = {
    email: "noop@example.test",
    rawToken: "lazy-probe-only",
    userId: "00000000-0000-7000-8000-000000000001",
  };

  it("L-1: lazy producer does NOT call the provider thunk at construction", () => {
    let calls = 0;
    new EmailQueueProducer(() => {
      calls += 1;
      return new FakeQueueWithClose();
    });
    expect(calls).toBe(0);
  });

  it("L-2: first enqueuePasswordReset() invokes the thunk exactly once", async () => {
    let calls = 0;
    const queue = new FakeQueueWithClose();
    const producer = new EmailQueueProducer(() => {
      calls += 1;
      return queue;
    });
    await producer.enqueuePasswordReset(PROBE_JOB);
    expect(calls).toBe(1);
    expect(queue.addCalls).toBe(1);
  });

  it("L-3: subsequent enqueue* calls reuse the materialised queue", async () => {
    let calls = 0;
    const queue = new FakeQueueWithClose();
    const producer = new EmailQueueProducer(() => {
      calls += 1;
      return queue;
    });
    await producer.enqueuePasswordReset(PROBE_JOB);
    await producer.enqueueEmailVerification(PROBE_JOB);
    await producer.enqueueInvitation(
      PROBE_JOB as unknown as Parameters<EmailQueueProducer["enqueueInvitation"]>[0],
    );
    expect(calls).toBe(1);
    expect(queue.addCalls).toBe(3);
  });

  it("L-4: onModuleDestroy on a never-enqueued lazy producer is a clean no-op", async () => {
    let calls = 0;
    const queue = new FakeQueueWithClose();
    const producer = new EmailQueueProducer(() => {
      calls += 1;
      return queue;
    });
    await expect(producer.onModuleDestroy()).resolves.toBeUndefined();
    expect(calls).toBe(0);
    expect(queue.closeCalls).toBe(0);
  });

  it("L-5: onModuleDestroy AFTER enqueue closes the materialised queue", async () => {
    const queue = new FakeQueueWithClose();
    const producer = new EmailQueueProducer(() => queue);
    await producer.enqueuePasswordReset(PROBE_JOB);
    await producer.onModuleDestroy();
    expect(queue.closeCalls).toBe(1);
  });

  it("L-6: enqueuePasswordReset AFTER onModuleDestroy rejects and never materialises the queue", async () => {
    // CodeRabbit review on PR #242: with the old `this.queue ??
    // (this.queue = this.queueProvider!())`, a late enqueue on an
    // already-destroyed producer would happily invoke the thunk and
    // build a fresh BullMQ Queue + ioredis client -- a brand-new
    // leak that the destroy hook had already short-circuited past.
    //
    // L-6 is the explicit regression for that post-destroy materialisation
    // path. The producer is constructed lazy, destroyed BEFORE any
    // enqueue, then the test asserts:
    //   - the late enqueue rejects with the "is closed" sentinel
    //   - the provider thunk was NEVER invoked (calls === 0)
    //   - no FakeQueueWithClose was built, so closeCalls is also 0
    let calls = 0;
    const queue = new FakeQueueWithClose();
    const producer = new EmailQueueProducer(() => {
      calls += 1;
      return queue;
    });

    await producer.onModuleDestroy();

    await expect(producer.enqueuePasswordReset(PROBE_JOB)).rejects.toThrow(
      /EmailQueueProducer is closed/,
    );
    expect(calls).toBe(0);
    expect(queue.closeCalls).toBe(0);
  });
});
