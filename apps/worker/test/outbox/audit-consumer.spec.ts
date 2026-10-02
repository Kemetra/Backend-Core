/**
 * T584 — AuditEventCreatedConsumer unit test.
 *
 * No Docker, no Postgres, no Redis — pure unit test. The consumer's
 * responsibility is: validate the outbox event payload, then enqueue a
 * BullMQ "audit-fanout" job. Both responsibilities are exercised here.
 *
 * Coverage:
 *   AC-1  Happy path: valid payload → exactly one queue.add call with the
 *         expected job name and data shape.
 *   AC-2  Validation: malformed payload → throw an Error whose name is a
 *         redacted error class (NOT containing PII / payload content).
 *   AC-3  Job-name contract: AUDIT_QUEUE_NAME = "audit", AUDIT_JOB_NAME =
 *         "audit-fanout" — locked literals matching the existing producer.
 *   AC-4  Correlation propagation: when payload.request_id is null but
 *         the envelope carries a correlation_id, the queue job receives
 *         the correlation_id as request_id.
 *   AC-5  Per-emission identity (RT-124): jobId and data.event_id are the
 *         outbox envelope's event_id — distinct emissions (distinct outbox
 *         rows) stay distinct audit rows (FR-AUDIT-1); a redelivery of the
 *         same outbox event maps onto the same job and row id.
 *   AC-6  Consumer surface: consumerId + eventType constants match the
 *         contract used by the drainer registry.
 */
import {
  AuditEventCreatedConsumer,
  AUDIT_EVENT_CREATED_CONSUMER_ID,
  OUTBOX_AUDIT_QUEUE_NAME,
  OUTBOX_AUDIT_JOB_NAME,
  type AuditQueueLike,
  type AuditEventCreatedPayload,
} from "../../src/outbox/consumers/audit-event-created.consumer";
import type { OutboxEventEnvelope } from "@data-pulse-2/shared";

// ---------------------------------------------------------------------------
// Fake queue
// ---------------------------------------------------------------------------

class FakeQueue implements AuditQueueLike {
  calls: Array<{ name: string; data: unknown; opts: Record<string, unknown> | undefined }> = [];
  async add(name: string, data: unknown, opts?: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ name, data, opts });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const validPayload: AuditEventCreatedPayload = {
  actor_user_id: "00000000-0000-7000-8000-000000000001",
  actor_label:   null,
  tenant_id:     "00000000-0000-7000-8000-000000000002",
  store_id:      null,
  action:        "context.switch.tenant",
  target_type:   null,
  target_id:     null,
  request_id:    "00000000-0000-7000-8000-000000000003",
  metadata:      null,
};

function envelope(
  payload: unknown,
  overrides: Partial<OutboxEventEnvelope<unknown>> = {},
): OutboxEventEnvelope<unknown> {
  return {
    event_id:       "0e000000-0000-4000-8000-000000000001",
    event_type:     "audit.event.created",
    tenant_id:      "00000000-0000-7000-8000-000000000002",
    store_id:       null,
    payload,
    correlation_id: "corr-0001",
    attempts:       1,
    occurred_at:    new Date(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// AC-1 / AC-3 / AC-5: happy path and contract literals
// ---------------------------------------------------------------------------

describe("AuditEventCreatedConsumer — happy path (AC-1, AC-3, AC-5)", () => {
  it("AC-3: queue name literals are pinned", () => {
    expect(OUTBOX_AUDIT_QUEUE_NAME).toBe("audit");
    expect(OUTBOX_AUDIT_JOB_NAME).toBe("audit-fanout");
  });

  it("AC-1: valid payload triggers exactly one queue.add with the expected job name", async () => {
    const queue = new FakeQueue();
    const consumer = new AuditEventCreatedConsumer(queue);

    await consumer.handle(envelope(validPayload) as OutboxEventEnvelope<AuditEventCreatedPayload>);

    expect(queue.calls).toHaveLength(1);
    expect(queue.calls[0]!.name).toBe(OUTBOX_AUDIT_JOB_NAME);

    const data = queue.calls[0]!.data as Record<string, unknown>;
    expect(data).toMatchObject({
      action: "context.switch.tenant",
      tenant_id: validPayload.tenant_id,
      actor_user_id: validPayload.actor_user_id,
    });
  });

  it("AC-5: jobId and data.event_id are the outbox event_id", async () => {
    const queue = new FakeQueue();
    const consumer = new AuditEventCreatedConsumer(queue);
    const event = envelope(validPayload);
    await consumer.handle(event as OutboxEventEnvelope<AuditEventCreatedPayload>);

    expect(queue.calls[0]!.opts).toEqual({ jobId: event.event_id });
    expect((queue.calls[0]!.data as Record<string, unknown>)["event_id"]).toBe(event.event_id);
  });

  it("AC-5: a redelivered event reuses its id; a distinct event gets its own", async () => {
    const queue = new FakeQueue();
    const consumer = new AuditEventCreatedConsumer(queue);
    const first = envelope(validPayload);
    const second = envelope(validPayload, { event_id: "0e000000-0000-4000-8000-000000000002" });

    await consumer.handle(first as OutboxEventEnvelope<AuditEventCreatedPayload>);
    await consumer.handle({ ...first, attempts: 2 } as OutboxEventEnvelope<AuditEventCreatedPayload>);
    await consumer.handle(second as OutboxEventEnvelope<AuditEventCreatedPayload>);

    const jobIds = queue.calls.map((c) => c.opts?.["jobId"]);
    expect(jobIds).toEqual([first.event_id, first.event_id, second.event_id]);
  });
});

// ---------------------------------------------------------------------------
// AC-2: validation failure → redacted error
// ---------------------------------------------------------------------------

describe("AuditEventCreatedConsumer — payload validation (AC-2)", () => {
  it("rejects payload missing required `action` with an Error whose message does NOT leak field values", async () => {
    const queue = new FakeQueue();
    const consumer = new AuditEventCreatedConsumer(queue);

    const malformed = {
      ...validPayload,
      action: undefined as unknown as string,
    };

    let caught: Error | null = null;
    try {
      await consumer.handle(envelope(malformed) as OutboxEventEnvelope<AuditEventCreatedPayload>);
    } catch (err) {
      caught = err instanceof Error ? err : new Error(String(err));
    }

    expect(caught).not.toBeNull();
    expect(caught!.message).toMatch(/malformed payload/);
    // The error must NOT include any UUID from the payload — only the
    // field name + Zod's structural diagnosis.
    expect(caught!.message).not.toContain(validPayload.actor_user_id!);
    expect(caught!.message).not.toContain(validPayload.tenant_id!);

    // No queue.add call happened.
    expect(queue.calls).toHaveLength(0);
  });

  it("rejects payload with wrong type on `actor_user_id` (number instead of uuid string)", async () => {
    const queue = new FakeQueue();
    const consumer = new AuditEventCreatedConsumer(queue);

    const malformed = {
      ...validPayload,
      actor_user_id: 12345 as unknown as string,
    };

    await expect(
      consumer.handle(envelope(malformed) as OutboxEventEnvelope<AuditEventCreatedPayload>),
    ).rejects.toThrow(/malformed payload/);

    expect(queue.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// AC-4: correlation propagation
// ---------------------------------------------------------------------------

describe("AuditEventCreatedConsumer — correlation propagation (AC-4)", () => {
  it("uses envelope.correlation_id as request_id when payload.request_id is null", async () => {
    const queue = new FakeQueue();
    const consumer = new AuditEventCreatedConsumer(queue);

    const payloadNoRequestId: AuditEventCreatedPayload = {
      ...validPayload,
      request_id: null,
    };

    await consumer.handle(
      envelope(payloadNoRequestId, { correlation_id: "fallback-corr-001" }) as OutboxEventEnvelope<AuditEventCreatedPayload>,
    );

    const data = queue.calls[0]!.data as Record<string, unknown>;
    expect(data["request_id"]).toBe("fallback-corr-001");
  });

  it("keeps payload.request_id when it is present (does not overwrite with correlation_id)", async () => {
    const queue = new FakeQueue();
    const consumer = new AuditEventCreatedConsumer(queue);

    await consumer.handle(
      envelope(validPayload, { correlation_id: "should-not-be-used" }) as OutboxEventEnvelope<AuditEventCreatedPayload>,
    );

    const data = queue.calls[0]!.data as Record<string, unknown>;
    expect(data["request_id"]).toBe(validPayload.request_id);
  });
});

// ---------------------------------------------------------------------------
// AC-6: consumer surface
// ---------------------------------------------------------------------------

describe("AuditEventCreatedConsumer — registry surface (AC-6)", () => {
  it("exposes stable consumerId and eventType for the drainer registry", () => {
    const queue = new FakeQueue();
    const consumer = new AuditEventCreatedConsumer(queue);
    expect(consumer.consumerId).toBe(AUDIT_EVENT_CREATED_CONSUMER_ID);
    expect(consumer.consumerId).toBe("worker.audit.event.created");
    expect(consumer.eventType).toBe("audit.event.created");
  });
});

// ---------------------------------------------------------------------------
// AC-7: envelope tenant_id / store_id are authoritative
// ---------------------------------------------------------------------------
//
// Constitution §III (Backend Authority & Data Integrity) + §XII
// (Authorization & Object Safety) require that the server, not the caller,
// decides which tenant/store an event belongs to. The outbox envelope is
// the source of truth — the JSONB payload could be tampered with by any
// past producer bug, so its tenant_id / store_id fields are NOT trusted.
//
// These tests prove a tampered payload cannot redirect an audit event:
// when payload tenant_id != envelope tenant_id, the envelope wins.

describe("AuditEventCreatedConsumer — envelope identifiers are authoritative (AC-7)", () => {
  const ENVELOPE_TENANT = "00000000-0000-7000-8000-000000000aaa";
  const PAYLOAD_TENANT  = "00000000-0000-7000-8000-000000000bbb"; // attacker's value
  const ENVELOPE_STORE  = "00000000-0000-7000-8000-000000000ccc";
  const PAYLOAD_STORE   = "00000000-0000-7000-8000-000000000ddd"; // attacker's value
  const NIL_UUID        = "00000000-0000-0000-0000-000000000000";

  it("AC-7a: payload tenant_id different from envelope.tenant_id → envelope wins", async () => {
    const queue = new FakeQueue();
    const consumer = new AuditEventCreatedConsumer(queue);

    const taintedPayload: AuditEventCreatedPayload = {
      ...validPayload,
      tenant_id: PAYLOAD_TENANT, // attacker tries to redirect
    };

    await consumer.handle(
      envelope(taintedPayload, { tenant_id: ENVELOPE_TENANT }) as OutboxEventEnvelope<AuditEventCreatedPayload>,
    );

    const data = queue.calls[0]!.data as Record<string, unknown>;
    expect(data["tenant_id"]).toBe(ENVELOPE_TENANT);
    expect(data["tenant_id"]).not.toBe(PAYLOAD_TENANT);
  });

  it("AC-7b: payload store_id different from envelope.store_id → envelope wins", async () => {
    const queue = new FakeQueue();
    const consumer = new AuditEventCreatedConsumer(queue);

    const taintedPayload: AuditEventCreatedPayload = {
      ...validPayload,
      store_id: PAYLOAD_STORE, // attacker tries to redirect to another branch
    };

    await consumer.handle(
      envelope(taintedPayload, {
        tenant_id: ENVELOPE_TENANT,
        store_id: ENVELOPE_STORE,
      }) as OutboxEventEnvelope<AuditEventCreatedPayload>,
    );

    const data = queue.calls[0]!.data as Record<string, unknown>;
    expect(data["store_id"]).toBe(ENVELOPE_STORE);
    expect(data["store_id"]).not.toBe(PAYLOAD_STORE);
  });

  it("AC-7c: payload store_id present but envelope.store_id is null → envelope (null) wins", async () => {
    const queue = new FakeQueue();
    const consumer = new AuditEventCreatedConsumer(queue);

    const taintedPayload: AuditEventCreatedPayload = {
      ...validPayload,
      store_id: PAYLOAD_STORE, // attacker tries to scope to a store the row is NOT for
    };

    await consumer.handle(
      envelope(taintedPayload, {
        tenant_id: ENVELOPE_TENANT,
        store_id: null,
      }) as OutboxEventEnvelope<AuditEventCreatedPayload>,
    );

    const data = queue.calls[0]!.data as Record<string, unknown>;
    expect(data["store_id"]).toBeNull();
  });

  it("AC-7d: envelope tenant_id is NIL_UUID (platform-scoped) → BullMQ tenant_id is null", async () => {
    // Platform-scoped audit events use NIL_UUID at the outbox row level
    // (because outbox_events.tenant_id is NOT NULL) but the existing
    // AuditFanoutProcessor convention is `null` for "platform-scoped".
    // The consumer must map NIL_UUID back to null when enqueuing.
    const queue = new FakeQueue();
    const consumer = new AuditEventCreatedConsumer(queue);

    const platformScopedPayload: AuditEventCreatedPayload = {
      ...validPayload,
      tenant_id: null, // already null in this payload — confirms the conversion
    };

    await consumer.handle(
      envelope(platformScopedPayload, { tenant_id: NIL_UUID }) as OutboxEventEnvelope<AuditEventCreatedPayload>,
    );

    const data = queue.calls[0]!.data as Record<string, unknown>;
    expect(data["tenant_id"]).toBeNull();
  });

  it("AC-7e: malicious payload tenant_id WITH envelope NIL_UUID → BullMQ tenant_id is still null", async () => {
    // Defence in depth: even if a malicious producer stuffed a real tenant
    // UUID into a platform-scoped row's payload, the envelope's NIL_UUID
    // must still win and the BullMQ job's tenant_id must end up null.
    const queue = new FakeQueue();
    const consumer = new AuditEventCreatedConsumer(queue);

    const taintedPlatformPayload: AuditEventCreatedPayload = {
      ...validPayload,
      tenant_id: PAYLOAD_TENANT, // attacker tries to make a platform event tenant-scoped
    };

    await consumer.handle(
      envelope(taintedPlatformPayload, { tenant_id: NIL_UUID }) as OutboxEventEnvelope<AuditEventCreatedPayload>,
    );

    const data = queue.calls[0]!.data as Record<string, unknown>;
    expect(data["tenant_id"]).toBeNull();
    expect(data["tenant_id"]).not.toBe(PAYLOAD_TENANT);
  });
});
