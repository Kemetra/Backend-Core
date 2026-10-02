/**
 * audit-queue.producer.spec.ts
 *
 * Unit tests for `AuditQueueProducer` and `auditJobEnqueuerFactory`.
 * No Redis, no BullMQ runtime, no ioredis-mock.
 *
 * Coverage:
 *   AuditQueueProducer
 *     - AUDIT_QUEUE_NAME literal pin ("audit")
 *     - AUDIT_FANOUT_JOB_NAME_API literal pin ("audit-fanout")
 *     - queue.add receives AUDIT_FANOUT_JOB_NAME_API as the job name
 *     - payload fields pass through in data
 *     - data.traceContext is a plain object (injected from active OTel span)
 *     - data.traceContext.traceparent matches W3C shape inside an active span
 *     - data.traceContext does not contain payload PII/metadata values
 *     - opts must NOT contain a jobId (no dedup — every emission is distinct)
 *     - two identical enqueue() calls produce two queue.add() calls
 *     - queue.add() errors propagate (not swallowed)
 *
 *   auditJobEnqueuerFactory
 *     - no REDIS_URL + non-production → returns NoOpAuditJobEnqueuer
 *     - no REDIS_URL + production → throws
 *     - REDIS_URL set → returns AuditQueueProducer (via queueFactory seam)
 */
import {
  AUDIT_FANOUT_JOB_NAME_API,
  AUDIT_QUEUE_NAME,
  AuditQueueProducer,
  type AuditQueueLike,
} from "../../src/audit/audit-queue.producer";
import { auditJobEnqueuerFactory } from "../../src/audit/audit.module";
import { NoOpAuditJobEnqueuer } from "../../src/audit/audit-job.enqueuer";
import type { AuditJobPayload } from "../../src/audit/audit-job.types";
import {
  createTestTracerProvider,
  context,
  trace,
  type TestTracerHandle,
} from "@data-pulse-2/shared/observability/otel";

// ---------------------------------------------------------------------------
// Fake queue spy
// ---------------------------------------------------------------------------

class FakeQueue implements AuditQueueLike {
  calls: Array<{ name: string; data: unknown; opts: unknown }> = [];
  async add(name: string, data: unknown, opts?: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ name, data, opts });
    return {};
  }
}

class ThrowingQueue implements AuditQueueLike {
  async add(_name: string, _data: unknown, _opts?: Record<string, unknown>): Promise<unknown> {
    throw new Error("queue error");
  }
}

// ---------------------------------------------------------------------------
// Fixture payload
// ---------------------------------------------------------------------------

const examplePayload: AuditJobPayload = {
  actor_user_id: "00000000-0000-7000-8000-000000000001",
  actor_label: null,
  tenant_id: "00000000-0000-7000-8000-000000000002",
  store_id: null,
  action: "context.switch.tenant",
  target_type: null,
  target_id: null,
  request_id: "req-001",
  metadata: null,
};

// ---------------------------------------------------------------------------
// AuditQueueProducer
// ---------------------------------------------------------------------------

describe("AuditQueueProducer — contract constants", () => {
  it("AUDIT_QUEUE_NAME is the literal 'audit'", () => {
    expect(AUDIT_QUEUE_NAME).toBe("audit");
  });

  it("AUDIT_FANOUT_JOB_NAME_API is the literal 'audit-fanout'", () => {
    expect(AUDIT_FANOUT_JOB_NAME_API).toBe("audit-fanout");
  });
});

describe("AuditQueueProducer — enqueue", () => {
  it("calls queue.add with job name AUDIT_FANOUT_JOB_NAME_API", async () => {
    const q = new FakeQueue();
    const producer = new AuditQueueProducer(q);
    await producer.enqueue(examplePayload);
    expect(q.calls).toHaveLength(1);
    expect(q.calls[0]!.name).toBe(AUDIT_FANOUT_JOB_NAME_API);
  });

  it("passes original audit payload fields in data to queue.add", async () => {
    const q = new FakeQueue();
    const producer = new AuditQueueProducer(q);
    await producer.enqueue(examplePayload);
    expect(q.calls[0]!.data).toEqual(
      expect.objectContaining({
        actor_user_id: examplePayload.actor_user_id,
        tenant_id:     examplePayload.tenant_id,
        action:        examplePayload.action,
        request_id:    examplePayload.request_id,
      }),
    );
  });

  it("injects traceContext into job data as a plain object", async () => {
    const q = new FakeQueue();
    const producer = new AuditQueueProducer(q);
    await producer.enqueue(examplePayload);
    const data = q.calls[0]!.data as Record<string, unknown>;
    expect(typeof data["traceContext"]).toBe("object");
    expect(data["traceContext"]).not.toBeNull();
  });

  it("traceContext.traceparent matches W3C shape when called inside an active span", async () => {
    const handle: TestTracerHandle = createTestTracerProvider();
    try {
      const tracer = trace.getTracer("test-audit-producer");
      const span = tracer.startSpan("audit.enqueue");
      const ctx = trace.setSpan(context.active(), span);

      const q = new FakeQueue();
      const producer = new AuditQueueProducer(q);
      await context.with(ctx, () => producer.enqueue(examplePayload));
      span.end();

      const data = q.calls[0]!.data as Record<string, unknown>;
      const carrier = data["traceContext"] as Record<string, unknown>;
      expect(typeof carrier["traceparent"]).toBe("string");
      expect(carrier["traceparent"]).toMatch(
        /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/,
      );
    } finally {
      await handle.teardown();
    }
  });

  it("traceContext does not contain payload PII or metadata values", async () => {
    const q = new FakeQueue();
    const producer = new AuditQueueProducer(q);
    await producer.enqueue(examplePayload);
    const data = q.calls[0]!.data as Record<string, unknown>;
    const carrier = data["traceContext"] as Record<string, unknown>;
    const carrierValues = Object.values(carrier);
    expect(carrierValues).not.toContain(examplePayload.actor_user_id);
    expect(carrierValues).not.toContain(examplePayload.tenant_id);
    expect(carrierValues).not.toContain(examplePayload.request_id);
    expect(carrierValues).not.toContain(examplePayload.action);
  });

  it("stamps one event_id per emission, used as jobId and in the job data (RT-124)", async () => {
    const q = new FakeQueue();
    const producer = new AuditQueueProducer(q);
    await producer.enqueue(examplePayload);
    const opts = q.calls[0]!.opts as Record<string, unknown> | undefined;
    const data = q.calls[0]!.data as Record<string, unknown>;
    expect(data["event_id"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(opts?.["jobId"]).toBe(data["event_id"]);
  });

  it("two identical enqueue() calls produce two distinct jobs (FR-AUDIT-1: retries are not collapsed)", async () => {
    const q = new FakeQueue();
    const producer = new AuditQueueProducer(q);
    await producer.enqueue(examplePayload);
    await producer.enqueue(examplePayload);
    expect(q.calls).toHaveLength(2);
    const ids = q.calls.map((c) => (c.opts as Record<string, unknown>)["jobId"]);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it("keeps a caller-supplied event_id instead of minting a new one", async () => {
    const q = new FakeQueue();
    const producer = new AuditQueueProducer(q);
    const eventId = "0e000000-0000-7000-8000-0000000000bb";
    await producer.enqueue({ ...examplePayload, event_id: eventId });
    expect((q.calls[0]!.opts as Record<string, unknown>)["jobId"]).toBe(eventId);
    expect((q.calls[0]!.data as Record<string, unknown>)["event_id"]).toBe(eventId);
  });

  it("propagates errors from queue.add without swallowing them", async () => {
    const producer = new AuditQueueProducer(new ThrowingQueue());
    await expect(producer.enqueue(examplePayload)).rejects.toThrow("queue error");
  });
});

// ---------------------------------------------------------------------------
// auditJobEnqueuerFactory
// ---------------------------------------------------------------------------

describe("auditJobEnqueuerFactory", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns NoOpAuditJobEnqueuer when REDIS_URL is absent in non-production", async () => {
    delete process.env["REDIS_URL"];
    process.env["NODE_ENV"] = "development";
    const enqueuer = auditJobEnqueuerFactory();
    expect(enqueuer).toBeInstanceOf(NoOpAuditJobEnqueuer);
    await expect(enqueuer.enqueue(examplePayload)).resolves.toBeUndefined();
  });

  it("returns NoOpAuditJobEnqueuer when REDIS_URL is absent in test environment", async () => {
    delete process.env["REDIS_URL"];
    process.env["NODE_ENV"] = "test";
    const enqueuer = auditJobEnqueuerFactory();
    expect(enqueuer).toBeInstanceOf(NoOpAuditJobEnqueuer);
  });

  it("throws when REDIS_URL is absent in production", () => {
    delete process.env["REDIS_URL"];
    process.env["NODE_ENV"] = "production";
    expect(() => auditJobEnqueuerFactory()).toThrow(
      "AuditModule: REDIS_URL is required in production",
    );
  });

  it("returns AuditQueueProducer when REDIS_URL is set (via queueFactory seam)", () => {
    process.env["REDIS_URL"] = "redis://localhost:6379";
    const fakeQueue = new FakeQueue();
    const enqueuer = auditJobEnqueuerFactory(() => fakeQueue);
    expect(enqueuer).toBeInstanceOf(AuditQueueProducer);
  });

  it("passes REDIS_URL to the queueFactory when REDIS_URL is set (on first enqueue, lazy)", async () => {
    const capturedUrls: string[] = [];
    process.env["REDIS_URL"] = "redis://localhost:6379";
    const enqueuer = auditJobEnqueuerFactory((url) => {
      capturedUrls.push(url);
      return new FakeQueue();
    });
    // Lazy-init: the producer is now returned WITHOUT having invoked
    // the queueFactory thunk -- materialisation is deferred to first
    // enqueue(). This is the same change that fixes the override-orphan
    // leak documented in the cleanup PR (fix/api-queue-factories-defer-
    // queue-construction). Before the refactor `capturedUrls.length`
    // was 1 here; now it's 0 until enqueue runs.
    expect(capturedUrls).toEqual([]);
    await enqueuer.enqueue(examplePayload);
    expect(capturedUrls).toEqual(["redis://localhost:6379"]);
  });
});
