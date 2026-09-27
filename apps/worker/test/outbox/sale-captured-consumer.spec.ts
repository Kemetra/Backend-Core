/**
 * DP-008-LIVELOOP — SaleCapturedConsumer unit test.
 *
 * No Docker, no Postgres, no Redis — pure unit test. The consumer's
 * responsibility is: validate the outbox event payload, then enqueue a BullMQ
 * "sale-processing" job mapping the envelope → SaleProcessingJob. Both
 * responsibilities are exercised here. Mirrors `audit-consumer.spec.ts`.
 *
 * Coverage:
 *   AC-1  Happy path: valid payload → exactly one queue.add call with the
 *         expected job name and the correct SaleProcessingJob shape.
 *   AC-2  Validation: malformed payload → throw an Error whose message is a
 *         redacted diagnosis (field name only, NOT the payload id values).
 *   AC-3  Job-name contract: SALE_PROCESSING_QUEUE_NAME / JOB_NAME literals.
 *   AC-4  Correlation propagation: envelope.correlation_id → job.correlationId.
 *   AC-5  Consumer surface: consumerId + eventType constants match the
 *         contract used by the drainer registry.
 *   AC-6  Envelope tenant_id is authoritative — a tampered payload cannot
 *         redirect the job to another tenant.
 *   AC-7  No DB access — the queue is the only side-effect (the fake queue is
 *         the sole collaborator; there is no pool/client to call).
 */
import {
  SaleCapturedConsumer,
  SALE_CAPTURED_CONSUMER_ID,
  OUTBOX_SALE_PROCESSING_QUEUE_NAME,
  OUTBOX_SALE_PROCESSING_JOB_NAME,
  type SaleProcessingQueueLike,
  type SaleCapturedPayload,
} from "../../src/outbox/consumers/sale-captured.consumer";
import type { OutboxEventEnvelope } from "@data-pulse-2/shared";
import { Job, type JobsOptions } from "bullmq";

// ---------------------------------------------------------------------------
// Fake queue — the consumer's ONLY collaborator. No DB pool is injected, so a
// passing test that asserts the queue is the sole side-effect also proves the
// consumer does no DB work.
// ---------------------------------------------------------------------------

class FakeQueue implements SaleProcessingQueueLike {
  calls: Array<{ name: string; data: unknown; opts: Record<string, unknown> | undefined }> = [];
  async add(name: string, data: unknown, opts?: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ name, data, opts });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const SALE_ID = "00000000-0000-7000-8000-000000000010";
const STORE_ID = "00000000-0000-7000-8000-000000000020";
const TENANT_ID = "00000000-0000-7000-8000-000000000030";
// Real correlation ids are UUIDs (not the prior "corr-sale-0001" placeholder).
const CORRELATION_ID = "00000000-0000-7000-8000-000000000040";
const EVENT_ID = "0e000000-0000-4000-8000-000000000002";

const validPayload: SaleCapturedPayload = {
  sale_id:  SALE_ID,
  store_id: STORE_ID,
};

function envelope(
  payload: unknown,
  overrides: Partial<OutboxEventEnvelope<unknown>> = {},
): OutboxEventEnvelope<unknown> {
  return {
    event_id:       EVENT_ID,
    event_type:     "sale.captured",
    tenant_id:      TENANT_ID,
    store_id:       STORE_ID,
    payload,
    correlation_id: CORRELATION_ID,
    attempts:       1,
    occurred_at:    new Date(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// AC-1 / AC-3: happy path and contract literals
// ---------------------------------------------------------------------------

describe("SaleCapturedConsumer — happy path (AC-1, AC-3)", () => {
  it("AC-3: queue name + job name literals are pinned", () => {
    expect(OUTBOX_SALE_PROCESSING_QUEUE_NAME).toBe("sale-processing");
    expect(OUTBOX_SALE_PROCESSING_JOB_NAME).toBe("sale-processing");
  });

  it("AC-1: valid payload → exactly one queue.add with the SaleProcessingJob shape", async () => {
    const queue = new FakeQueue();
    const consumer = new SaleCapturedConsumer(queue);

    await consumer.handle(envelope(validPayload) as OutboxEventEnvelope<SaleCapturedPayload>);

    expect(queue.calls).toHaveLength(1);
    expect(queue.calls[0]!.name).toBe(OUTBOX_SALE_PROCESSING_JOB_NAME);

    const data = queue.calls[0]!.data as Record<string, unknown>;
    expect(data).toEqual({
      saleId:        SALE_ID,
      tenantId:      TENANT_ID,
      storeId:       STORE_ID,
      correlationId: CORRELATION_ID,
    });
  });
});

// ---------------------------------------------------------------------------
// FIX 1: deterministic jobId for at-least-once dedup
// ---------------------------------------------------------------------------
//
// Outbox delivery is at-least-once: re-delivering the SAME row (same event_id)
// re-runs handle(). The consumer passes a deterministic BullMQ jobId derived
// from the outbox event identity so BullMQ collapses the re-delivery onto the
// SAME job. NOTE: FakeQueue is a spy — it does NOT collapse duplicate jobIds
// (it records every add). So two handle() calls produce TWO recorded calls;
// what we assert is that both carry the SAME, expected jobId. Collapsing is
// BullMQ's job (via the jobId); the consumer's only obligation is to emit a
// stable jobId. This deliberately DEVIATES from AuditEventCreatedConsumer,
// which omits jobId by design.

describe("SaleCapturedConsumer — deterministic jobId dedup (FIX 1)", () => {
  it("uses jobId `<consumerId>-<event_id>` in the add() opts", async () => {
    const queue = new FakeQueue();
    const consumer = new SaleCapturedConsumer(queue);

    await consumer.handle(envelope(validPayload) as OutboxEventEnvelope<SaleCapturedPayload>);

    const expectedJobId = `${SALE_CAPTURED_CONSUMER_ID}-${EVENT_ID}`;
    expect(queue.calls[0]!.opts?.["jobId"]).toBe(expectedJobId);
  });

  it("re-delivering the SAME envelope yields the SAME jobId on both calls", async () => {
    const queue = new FakeQueue();
    const consumer = new SaleCapturedConsumer(queue);

    const env = envelope(validPayload) as OutboxEventEnvelope<SaleCapturedPayload>;
    await consumer.handle(env);
    await consumer.handle(env);

    // FakeQueue does NOT dedup — both calls are recorded — but the jobId is
    // identical, which is what lets BullMQ collapse the re-delivery.
    expect(queue.calls).toHaveLength(2);
    expect(queue.calls[0]!.opts?.["jobId"]).toBe(queue.calls[1]!.opts?.["jobId"]);
    expect(queue.calls[0]!.opts?.["jobId"]).toBe(`${SALE_CAPTURED_CONSUMER_ID}-${EVENT_ID}`);
  });

  it("two DIFFERENT event_ids produce DIFFERENT jobIds", async () => {
    const queue = new FakeQueue();
    const consumer = new SaleCapturedConsumer(queue);

    const otherEventId = "0e000000-0000-4000-8000-000000000003";
    await consumer.handle(envelope(validPayload) as OutboxEventEnvelope<SaleCapturedPayload>);
    await consumer.handle(
      envelope(validPayload, { event_id: otherEventId }) as OutboxEventEnvelope<SaleCapturedPayload>,
    );

    expect(queue.calls[0]!.opts?.["jobId"]).toBe(`${SALE_CAPTURED_CONSUMER_ID}-${EVENT_ID}`);
    expect(queue.calls[1]!.opts?.["jobId"]).toBe(`${SALE_CAPTURED_CONSUMER_ID}-${otherEventId}`);
    expect(queue.calls[0]!.opts?.["jobId"]).not.toBe(queue.calls[1]!.opts?.["jobId"]);
  });
});

// ---------------------------------------------------------------------------
// RT-44: the jobId must pass BullMQ's REAL custom-id validation
// ---------------------------------------------------------------------------
//
// The FakeQueue above is a spy: it accepted `worker.sale.captured:<event_id>`,
// but BullMQ 5.76.5 rejects any custom jobId containing ':' (unless it has
// exactly 3 ':'-segments) with `Error('Custom Id cannot contain :')`. In the
// RT-9 lab every sale.captured event failed that way and no sale was ever
// processed or posted. These tests route the consumer through BullMQ's own
// `Job#validateOptions` — the exact check `Queue.add` runs before any Redis
// I/O — so reintroducing a ':' jobId fails here, Docker-free, in the fast job.

type BullmqMinimalQueue = ConstructorParameters<typeof Job>[0];

/** Enough of a queue for BullMQ's `Job` constructor; never touches Redis. */
const OFFLINE_QUEUE = {
  name: OUTBOX_SALE_PROCESSING_QUEUE_NAME,
  qualifiedName: `bull:${OUTBOX_SALE_PROCESSING_QUEUE_NAME}`,
  keys: {},
  opts: {},
  toKey: (type: string) => `bull:${OUTBOX_SALE_PROCESSING_QUEUE_NAME}:${type}`,
} as unknown as BullmqMinimalQueue;

/** Exposes BullMQ's protected `validateOptions` — the real pre-enqueue check. */
class OfflineValidatedJob extends Job {
  runBullmqValidation(): void {
    this.validateOptions(this.asJSON());
  }
}

/** Queue double that applies BullMQ's real job-option validation on add(). */
class BullmqValidatingQueue implements SaleProcessingQueueLike {
  accepted: Array<{ name: string; opts: Record<string, unknown> | undefined }> = [];
  async add(name: string, data: unknown, opts?: Record<string, unknown>): Promise<unknown> {
    new OfflineValidatedJob(OFFLINE_QUEUE, name, data, opts as JobsOptions).runBullmqValidation();
    this.accepted.push({ name, opts });
    return null;
  }
}

describe("SaleCapturedConsumer — jobId passes real BullMQ validation (RT-44)", () => {
  it("guard: the validating queue really rejects a ':' custom jobId", async () => {
    const queue = new BullmqValidatingQueue();
    await expect(
      queue.add(OUTBOX_SALE_PROCESSING_JOB_NAME, {}, { jobId: `worker.sale.captured:${EVENT_ID}` }),
    ).rejects.toThrow("Custom Id cannot contain :");
  });

  it("a valid sale.captured event is accepted by BullMQ's jobId validation", async () => {
    const queue = new BullmqValidatingQueue();
    const consumer = new SaleCapturedConsumer(queue);

    await expect(
      consumer.handle(envelope(validPayload) as OutboxEventEnvelope<SaleCapturedPayload>),
    ).resolves.toBeUndefined();
    expect(queue.accepted).toHaveLength(1);
    expect(queue.accepted[0]!.opts?.["jobId"]).not.toContain(":");
  });

  it("re-delivery passes validation with the SAME jobId; a different event gets a different one", async () => {
    const queue = new BullmqValidatingQueue();
    const consumer = new SaleCapturedConsumer(queue);
    const env = envelope(validPayload) as OutboxEventEnvelope<SaleCapturedPayload>;

    await consumer.handle(env);
    await consumer.handle(env);
    await consumer.handle(
      envelope(validPayload, {
        event_id: "0e000000-0000-4000-8000-000000000003",
      }) as OutboxEventEnvelope<SaleCapturedPayload>,
    );

    const [first, redelivered, other] = queue.accepted.map((c) => c.opts?.["jobId"]);
    expect(redelivered).toBe(first);
    expect(other).not.toBe(first);
  });
});

// ---------------------------------------------------------------------------
// AC-2: validation failure → redacted error
// ---------------------------------------------------------------------------

describe("SaleCapturedConsumer — payload validation (AC-2)", () => {
  it("rejects payload missing required `sale_id` with an Error that does NOT leak id values", async () => {
    const queue = new FakeQueue();
    const consumer = new SaleCapturedConsumer(queue);

    const malformed = {
      ...validPayload,
      sale_id: undefined as unknown as string,
    };

    let caught: Error | null = null;
    try {
      await consumer.handle(envelope(malformed) as OutboxEventEnvelope<SaleCapturedPayload>);
    } catch (err) {
      caught = err instanceof Error ? err : new Error(String(err));
    }

    expect(caught).not.toBeNull();
    expect(caught!.message).toMatch(/malformed payload/);
    // The error must NOT include the store_id that survived — only the field
    // name + Zod's structural diagnosis.
    expect(caught!.message).not.toContain(STORE_ID);

    // No queue.add call happened.
    expect(queue.calls).toHaveLength(0);
  });

  it("rejects payload with a non-UUID `store_id`", async () => {
    const queue = new FakeQueue();
    const consumer = new SaleCapturedConsumer(queue);

    const malformed = {
      ...validPayload,
      store_id: "not-a-uuid",
    };

    await expect(
      consumer.handle(envelope(malformed) as OutboxEventEnvelope<SaleCapturedPayload>),
    ).rejects.toThrow(/malformed payload/);

    expect(queue.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// AC-4: correlation propagation
// ---------------------------------------------------------------------------

describe("SaleCapturedConsumer — correlation propagation (AC-4)", () => {
  it("forwards envelope.correlation_id as job.correlationId", async () => {
    const queue = new FakeQueue();
    const consumer = new SaleCapturedConsumer(queue);

    await consumer.handle(
      envelope(validPayload, { correlation_id: "fallback-corr-sale" }) as OutboxEventEnvelope<SaleCapturedPayload>,
    );

    const data = queue.calls[0]!.data as Record<string, unknown>;
    expect(data["correlationId"]).toBe("fallback-corr-sale");
  });

  it("forwards a null correlation_id unchanged", async () => {
    const queue = new FakeQueue();
    const consumer = new SaleCapturedConsumer(queue);

    await consumer.handle(
      envelope(validPayload, { correlation_id: null }) as OutboxEventEnvelope<SaleCapturedPayload>,
    );

    const data = queue.calls[0]!.data as Record<string, unknown>;
    expect(data["correlationId"]).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AC-5: consumer surface
// ---------------------------------------------------------------------------

describe("SaleCapturedConsumer — registry surface (AC-5)", () => {
  it("exposes stable consumerId and eventType for the drainer registry", () => {
    const queue = new FakeQueue();
    const consumer = new SaleCapturedConsumer(queue);
    expect(consumer.consumerId).toBe(SALE_CAPTURED_CONSUMER_ID);
    expect(consumer.consumerId).toBe("worker.sale.captured");
    expect(consumer.eventType).toBe("sale.captured");
  });
});

// ---------------------------------------------------------------------------
// AC-6: envelope tenant_id is authoritative
// ---------------------------------------------------------------------------
//
// Constitution §III (Backend Authority & Data Integrity) + §XII (Object Safety)
// require that the server, not the caller, decides which tenant an event
// belongs to. The outbox envelope is the source of truth — the JSONB payload
// could be tampered with by a past producer bug. The sale.captured payload
// carries no tenant_id field at all, so the only tenant source is the envelope;
// this test pins that the job is always scoped to the envelope's tenant.

describe("SaleCapturedConsumer — envelope tenant_id is authoritative (AC-6)", () => {
  const ENVELOPE_TENANT = "00000000-0000-7000-8000-000000000aaa";

  it("AC-6: the enqueued job's tenantId is the envelope tenant_id", async () => {
    const queue = new FakeQueue();
    const consumer = new SaleCapturedConsumer(queue);

    await consumer.handle(
      envelope(validPayload, { tenant_id: ENVELOPE_TENANT }) as OutboxEventEnvelope<SaleCapturedPayload>,
    );

    const data = queue.calls[0]!.data as Record<string, unknown>;
    expect(data["tenantId"]).toBe(ENVELOPE_TENANT);
  });
});

// ---------------------------------------------------------------------------
// AC-7: no DB access
// ---------------------------------------------------------------------------

describe("SaleCapturedConsumer — no DB access (AC-7)", () => {
  it("performs its side-effect solely through the queue seam (no DB collaborator)", async () => {
    // The consumer is constructed with ONLY a queue — no pool/client. A
    // successful handle() proves the side-effect path needs no DB connection:
    // the drainer holds tenant context and the downstream processor does the
    // DB write. We assert the queue is the single collaborator that was called.
    const queue = new FakeQueue();
    const consumer = new SaleCapturedConsumer(queue);

    await consumer.handle(envelope(validPayload) as OutboxEventEnvelope<SaleCapturedPayload>);

    expect(queue.calls).toHaveLength(1);
  });
});
