/**
 * T562 — Drainer-level retry-budget test.
 *
 * Drives the DrainerProcessor through the full state machine for a poison
 * event and proves:
 *   - Attempts are incremented at claim time (1, 2, ..., 8).
 *   - After the 8th failure, the row transitions to `dead_lettered` (not `failed`).
 *   - No 9th claim is possible — the dead_lettered row is invisible to claimBatch.
 *
 * The repository-level R-12 case proves the SQL transitions are correct in
 * isolation. This spec proves the drainer's branch logic (attempts ≥ MAX_ATTEMPTS
 * → markDeadLettered) is wired correctly end-to-end.
 *
 * Set MIGRATION_TEST_ALLOW_SKIP=1 to soft-skip if Docker is unavailable.
 */
import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../../../packages/db/__tests__/_helpers/postgres-container";
import type { OutboxConsumer, OutboxEventEnvelope } from "@data-pulse-2/shared";
import type { ClaimedOutboxEvent } from "@data-pulse-2/db";
import { DrainerProcessor } from "../../src/outbox/drainer.processor";
import { OutboxConsumerRegistry } from "../../src/outbox/registry";
import * as workerMetrics from "../../src/observability/metrics/worker.metrics";

const TENANT_A = "0bb00000-0000-7000-8000-000000000001";
const EV_POISON = "0bd00000-0000-4000-8000-000000000001";

let env: PgTestEnv | null = null;
let dockerSkipped = false;

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    await env.admin.query(
      `INSERT INTO tenants (id, slug, name) VALUES ($1, 'budget-test-tenant', 'Budget Test')`,
      [TENANT_A],
    );
    await env.admin.query(
      `INSERT INTO outbox_events
         (event_id, tenant_id, event_type, payload, delivery_state, attempts)
       VALUES ($1, $2, 'test.event.poison', '{"poison":true}'::jsonb, 'pending', 0)`,
      [EV_POISON, TENANT_A],
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      console.warn(`\n[outbox/retry-budget.spec] Docker NOT AVAILABLE: ${msg}\n`);
      dockerSkipped = true;
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }
}, 180_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

function maybeSkip(): boolean {
  if (dockerSkipped) {
    console.warn("[outbox/retry-budget.spec] skipping (Docker unavailable)");
    return true;
  }
  return false;
}

/**
 * Per-tick claim helper for the test — claims only EV_POISON, ignoring any
 * other pending rows. We bypass the backoff window check (next_attempt_at)
 * by allowing the test to drive ticks in tight succession; this is the
 * scenario the test specifically wants to prove (8 transitions, then dead).
 *
 * The helper also clears next_attempt_at on the row before each claim so the
 * row remains eligible across all 8 ticks without waiting wall-clock time.
 */
function makeBudgetClaimFn() {
  return async (_pool: unknown, _batchSize: number): Promise<ClaimedOutboxEvent[]> => {
    // Reset next_attempt_at so the row is immediately eligible.
    await env!.admin.query(
      `UPDATE outbox_events SET next_attempt_at=NULL WHERE event_id=$1 AND delivery_state IN ('pending','failed')`,
      [EV_POISON],
    );
    const res = await env!.admin.query<ClaimedOutboxEvent>(
      `WITH claimed AS (
         UPDATE outbox_events
            SET delivery_state='claimed', attempts=attempts+1, updated_at=now()
          WHERE event_id=$1 AND delivery_state IN ('pending','failed')
          RETURNING event_id, event_type, tenant_id, store_id, payload, correlation_id, occurred_at, attempts
       ) SELECT * FROM claimed`,
      [EV_POISON],
    );
    return res.rows;
  };
}

describe("T562: drainer-level retry-budget — 8 attempts then dead_lettered", () => {
  it("transitions through 8 failed claims and ends in dead_lettered with attempts=8", async () => {
    if (maybeSkip()) return;

    // Poison consumer — always throws a known, redacted error class.
    class PoisonError extends Error {
      override readonly name = "PoisonError";
    }

    const poisonConsumer: OutboxConsumer<unknown> = {
      consumerId: "test.poison-consumer",
      eventType: "test.event.poison",
      async handle(_event: OutboxEventEnvelope<unknown>): Promise<void> {
        throw new PoisonError("payload-redacted");
      },
    };

    const registry = new OutboxConsumerRegistry();
    registry.register(poisonConsumer);

    const drainer = new DrainerProcessor({
      pool: env!.admin,
      registry,
      claimFn: makeBudgetClaimFn() as (
        pool: import("pg").Pool,
        batchSize: number,
      ) => Promise<ClaimedOutboxEvent[]>,
    });

    // Drive 8 ticks. Each tick: claim → consumer throws → drainer marks failed
    // (attempts 1..7) or dead_lettered (attempts === 8).
    for (let i = 0; i < 8; i++) {
      await drainer.tick();
    }

    const r = await env!.admin.query<{
      delivery_state: string;
      attempts: number;
      last_error: string | null;
      processed_at: string | null;
    }>(
      `SELECT delivery_state, attempts, last_error, processed_at FROM outbox_events WHERE event_id=$1`,
      [EV_POISON],
    );

    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]!.delivery_state).toBe("dead_lettered");
    expect(r.rows[0]!.attempts).toBe(8);
    expect(r.rows[0]!.last_error).toBe("PoisonError");
    expect(r.rows[0]!.processed_at).not.toBeNull();
  });

  it("no 9th claim — dead_lettered row is invisible to the production claimBatch", async () => {
    if (maybeSkip()) return;

    // Use the REAL claimBatch (not the test helper) — confirms the
    // dead_lettered → invisible invariant at the SQL level.
    const { claimBatch } = await import("@data-pulse-2/db");
    const claimed = await claimBatch(env!.admin, 100);
    const dead = claimed.find((row) => row.event_id === EV_POISON);
    expect(dead).toBeUndefined();
  });
});

describe("T596: drainer queue metric emission (retry / dead-letter / failed)", () => {
  // Fresh poison event id distinct from EV_POISON so this suite does not
  // collide with the budget-exhaust test above. The Postgres container is
  // shared (one beforeAll at file scope), so we INSERT here at suite start.
  const EV_METRICS = "0bd00000-0000-4000-8000-000000000002";

  let retrySpy: jest.SpyInstance;
  let deadLetterSpy: jest.SpyInstance;
  let failedSpy: jest.SpyInstance;

  beforeAll(async () => {
    if (dockerSkipped) return;
    await env!.admin.query(
      `INSERT INTO outbox_events
         (event_id, tenant_id, event_type, payload, delivery_state, attempts)
       VALUES ($1, $2, 'test.event.metrics', '{"poison":true}'::jsonb, 'pending', 0)`,
      [EV_METRICS, TENANT_A],
    );
  });

  beforeEach(() => {
    // jest.spyOn on the module's exported helpers — no global mock needed,
    // and the spies are isolated per test. The drainer code under test calls
    // these helpers directly via the imported binding; replacing the
    // implementation with a no-op jest.fn() lets us assert call shape
    // without exercising the real OTel SDK.
    retrySpy = jest.spyOn(workerMetrics, "recordQueueRetry").mockImplementation(() => undefined);
    deadLetterSpy = jest.spyOn(workerMetrics, "recordQueueDeadLetter").mockImplementation(() => undefined);
    failedSpy = jest.spyOn(workerMetrics, "recordQueueFailed").mockImplementation(() => undefined);
  });

  afterEach(() => {
    retrySpy.mockRestore();
    deadLetterSpy.mockRestore();
    failedSpy.mockRestore();
  });

  /**
   * Build a one-shot claim helper that only ever claims a specified
   * event_id. We RESET attempts to a chosen value before claim so the test
   * can deterministically drive both the "below budget" (retry) and "at
   * budget" (dead-letter) branches without running 8 ticks.
   */
  function makeMetricsClaimFn(eventId: string, startAttempts: number) {
    return async (_pool: unknown, _batchSize: number): Promise<ClaimedOutboxEvent[]> => {
      // Seed attempts and clear backoff so the row is immediately claimable.
      await env!.admin.query(
        `UPDATE outbox_events
            SET attempts = $2,
                delivery_state = 'pending',
                claimed_at = NULL,
                next_attempt_at = NULL,
                last_error = NULL,
                processed_at = NULL
          WHERE event_id = $1`,
        [eventId, startAttempts],
      );
      const res = await env!.admin.query<ClaimedOutboxEvent>(
        `WITH claimed AS (
           UPDATE outbox_events
              SET delivery_state='claimed', attempts=attempts+1, updated_at=now()
            WHERE event_id=$1 AND delivery_state IN ('pending','failed')
            RETURNING event_id, event_type, tenant_id, store_id, payload, correlation_id, occurred_at, attempts
         ) SELECT * FROM claimed`,
        [eventId],
      );
      return res.rows;
    };
  }

  it("retry branch (attempts < MAX_ATTEMPTS): records queue_retry_total + queue_failed_total with queue='audit-fanout'", async () => {
    if (maybeSkip()) return;

    class PoisonError extends Error {
      override readonly name = "PoisonError";
    }
    const consumer: OutboxConsumer<unknown> = {
      consumerId: "test.metrics-retry",
      eventType: "test.event.metrics",
      async handle(_event: OutboxEventEnvelope<unknown>): Promise<void> {
        throw new PoisonError("boom");
      },
    };
    const registry = new OutboxConsumerRegistry();
    registry.register(consumer);

    // Seed attempts=0 → after claim row.attempts=1, which is < MAX_ATTEMPTS (8).
    const drainer = new DrainerProcessor({
      pool: env!.admin,
      registry,
      claimFn: makeMetricsClaimFn(EV_METRICS, 0) as (
        pool: import("pg").Pool,
        batchSize: number,
      ) => Promise<ClaimedOutboxEvent[]>,
    });

    await drainer.tick();

    expect(retrySpy).toHaveBeenCalledTimes(1);
    expect(retrySpy).toHaveBeenCalledWith({ queue: "audit-fanout" });

    expect(failedSpy).toHaveBeenCalledTimes(1);
    expect(failedSpy).toHaveBeenCalledWith({
      queue: "audit-fanout",
      // PoisonError is not in WORKER_ERROR_CLASSES → sanitizes to "UnknownError".
      error_class: "UnknownError",
    });

    expect(deadLetterSpy).not.toHaveBeenCalled();
  });

  it("dead-letter branch (attempts >= MAX_ATTEMPTS): records queue_dead_letter_total + queue_failed_total with queue='audit-fanout'", async () => {
    if (maybeSkip()) return;

    class PoisonError extends Error {
      override readonly name = "PoisonError";
    }
    const consumer: OutboxConsumer<unknown> = {
      consumerId: "test.metrics-dlq",
      eventType: "test.event.metrics",
      async handle(_event: OutboxEventEnvelope<unknown>): Promise<void> {
        throw new PoisonError("boom");
      },
    };
    const registry = new OutboxConsumerRegistry();
    registry.register(consumer);

    // Seed attempts=8 → after claim row.attempts=9, which is >= MAX_ATTEMPTS (8).
    const drainer = new DrainerProcessor({
      pool: env!.admin,
      registry,
      claimFn: makeMetricsClaimFn(EV_METRICS, 8) as (
        pool: import("pg").Pool,
        batchSize: number,
      ) => Promise<ClaimedOutboxEvent[]>,
    });

    await drainer.tick();

    expect(deadLetterSpy).toHaveBeenCalledTimes(1);
    expect(deadLetterSpy).toHaveBeenCalledWith({ queue: "audit-fanout" });

    expect(failedSpy).toHaveBeenCalledTimes(1);
    expect(failedSpy).toHaveBeenCalledWith({
      queue: "audit-fanout",
      error_class: "UnknownError",
    });

    expect(retrySpy).not.toHaveBeenCalled();
  });

  it("success branch: records neither retry nor dead-letter nor failed", async () => {
    if (maybeSkip()) return;

    const consumer: OutboxConsumer<unknown> = {
      consumerId: "test.metrics-success",
      eventType: "test.event.metrics",
      async handle(_event: OutboxEventEnvelope<unknown>): Promise<void> {
        // success — no throw
      },
    };
    const registry = new OutboxConsumerRegistry();
    registry.register(consumer);

    const drainer = new DrainerProcessor({
      pool: env!.admin,
      registry,
      claimFn: makeMetricsClaimFn(EV_METRICS, 0) as (
        pool: import("pg").Pool,
        batchSize: number,
      ) => Promise<ClaimedOutboxEvent[]>,
    });

    await drainer.tick();

    expect(retrySpy).not.toHaveBeenCalled();
    expect(deadLetterSpy).not.toHaveBeenCalled();
    expect(failedSpy).not.toHaveBeenCalled();
  });

  it("no-consumer (UnroutableEventType) branch: records queue_retry_total + queue_failed_total (treated as retryable failure)", async () => {
    if (maybeSkip()) return;

    // Empty registry — no consumer for event_type "test.event.metrics".
    const registry = new OutboxConsumerRegistry();

    const drainer = new DrainerProcessor({
      pool: env!.admin,
      registry,
      claimFn: makeMetricsClaimFn(EV_METRICS, 0) as (
        pool: import("pg").Pool,
        batchSize: number,
      ) => Promise<ClaimedOutboxEvent[]>,
    });

    await drainer.tick();

    expect(retrySpy).toHaveBeenCalledTimes(1);
    expect(retrySpy).toHaveBeenCalledWith({ queue: "audit-fanout" });

    expect(failedSpy).toHaveBeenCalledTimes(1);
    expect(failedSpy).toHaveBeenCalledWith({
      queue: "audit-fanout",
      // "UnroutableEventType" is not in WORKER_ERROR_CLASSES → "UnknownError".
      error_class: "UnknownError",
    });

    expect(deadLetterSpy).not.toHaveBeenCalled();
  });

  it("preserves existing markFailed / markDeadLettered persistence semantics", async () => {
    if (maybeSkip()) return;

    class PoisonError extends Error {
      override readonly name = "PoisonError";
    }
    const consumer: OutboxConsumer<unknown> = {
      consumerId: "test.metrics-state",
      eventType: "test.event.metrics",
      async handle(_event: OutboxEventEnvelope<unknown>): Promise<void> {
        throw new PoisonError("boom");
      },
    };
    const registry = new OutboxConsumerRegistry();
    registry.register(consumer);

    // Below-budget tick must transition row to 'failed' (retry path).
    const retryDrainer = new DrainerProcessor({
      pool: env!.admin,
      registry,
      claimFn: makeMetricsClaimFn(EV_METRICS, 0) as (
        pool: import("pg").Pool,
        batchSize: number,
      ) => Promise<ClaimedOutboxEvent[]>,
    });
    await retryDrainer.tick();
    const r1 = await env!.admin.query<{ delivery_state: string }>(
      `SELECT delivery_state FROM outbox_events WHERE event_id=$1`,
      [EV_METRICS],
    );
    expect(r1.rows[0]!.delivery_state).toBe("failed");

    // At-budget tick must transition row to 'dead_lettered' (DLQ path).
    const dlqDrainer = new DrainerProcessor({
      pool: env!.admin,
      registry,
      claimFn: makeMetricsClaimFn(EV_METRICS, 8) as (
        pool: import("pg").Pool,
        batchSize: number,
      ) => Promise<ClaimedOutboxEvent[]>,
    });
    await dlqDrainer.tick();
    const r2 = await env!.admin.query<{ delivery_state: string }>(
      `SELECT delivery_state FROM outbox_events WHERE event_id=$1`,
      [EV_METRICS],
    );
    expect(r2.rows[0]!.delivery_state).toBe("dead_lettered");
  });
});

describe("T595 PR-B-1: drainer outbox metric emission (dead-letter / drain-duration)", () => {
  // Reuses the EV_METRICS row already inserted by the T596 beforeAll (same
  // file scope). Each test resets attempts/state via makeMetricsClaimFn.
  const EV_METRICS_T595 = "0bd00000-0000-4000-8000-000000000002";
  const EVENT_TYPE_METRICS = "test.event.metrics" as const;

  let outboxDeadLetterSpy: jest.SpyInstance;
  let outboxDrainDurationSpy: jest.SpyInstance;

  beforeEach(() => {
    outboxDeadLetterSpy = jest
      .spyOn(workerMetrics, "recordOutboxDeadLetter")
      .mockImplementation(() => undefined);
    outboxDrainDurationSpy = jest
      .spyOn(workerMetrics, "recordOutboxDrainDuration")
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    outboxDeadLetterSpy.mockRestore();
    outboxDrainDurationSpy.mockRestore();
  });

  /**
   * Local claim helper mirroring makeMetricsClaimFn in the T596 suite —
   * inlined here so this describe is independent of the T596 closure.
   */
  function makeT595ClaimFn(eventId: string, startAttempts: number) {
    return async (_pool: unknown, _batchSize: number): Promise<ClaimedOutboxEvent[]> => {
      await env!.admin.query(
        `UPDATE outbox_events
            SET attempts = $2,
                delivery_state = 'pending',
                claimed_at = NULL,
                next_attempt_at = NULL,
                last_error = NULL,
                processed_at = NULL
          WHERE event_id = $1`,
        [eventId, startAttempts],
      );
      const res = await env!.admin.query<ClaimedOutboxEvent>(
        `WITH claimed AS (
           UPDATE outbox_events
              SET delivery_state='claimed', attempts=attempts+1, updated_at=now()
            WHERE event_id=$1 AND delivery_state IN ('pending','failed')
            RETURNING event_id, event_type, tenant_id, store_id, payload, correlation_id, occurred_at, attempts
         ) SELECT * FROM claimed`,
        [eventId],
      );
      return res.rows;
    };
  }

  it("success branch: records drain duration with event_type, does NOT record dead-letter", async () => {
    if (maybeSkip()) return;

    const consumer: OutboxConsumer<unknown> = {
      consumerId: "test.outbox-success",
      eventType: EVENT_TYPE_METRICS,
      async handle(_event: OutboxEventEnvelope<unknown>): Promise<void> {
        // success — no throw
      },
    };
    const registry = new OutboxConsumerRegistry();
    registry.register(consumer);

    const drainer = new DrainerProcessor({
      pool: env!.admin,
      registry,
      claimFn: makeT595ClaimFn(EV_METRICS_T595, 0) as (
        pool: import("pg").Pool,
        batchSize: number,
      ) => Promise<ClaimedOutboxEvent[]>,
    });

    await drainer.tick();

    expect(outboxDrainDurationSpy).toHaveBeenCalledTimes(1);
    const [attrs, durationSeconds] = outboxDrainDurationSpy.mock.calls[0]!;
    expect(attrs).toEqual({ event_type: EVENT_TYPE_METRICS });
    expect(typeof durationSeconds).toBe("number");
    expect(durationSeconds).toBeGreaterThanOrEqual(0);

    expect(outboxDeadLetterSpy).not.toHaveBeenCalled();
  });

  it("retry branch (attempts < MAX_ATTEMPTS): records drain duration, does NOT record dead-letter", async () => {
    if (maybeSkip()) return;

    class PoisonError extends Error {
      override readonly name = "PoisonError";
    }
    const consumer: OutboxConsumer<unknown> = {
      consumerId: "test.outbox-retry",
      eventType: EVENT_TYPE_METRICS,
      async handle(_event: OutboxEventEnvelope<unknown>): Promise<void> {
        throw new PoisonError("boom");
      },
    };
    const registry = new OutboxConsumerRegistry();
    registry.register(consumer);

    const drainer = new DrainerProcessor({
      pool: env!.admin,
      registry,
      claimFn: makeT595ClaimFn(EV_METRICS_T595, 0) as (
        pool: import("pg").Pool,
        batchSize: number,
      ) => Promise<ClaimedOutboxEvent[]>,
    });

    await drainer.tick();

    expect(outboxDrainDurationSpy).toHaveBeenCalledTimes(1);
    const [attrs] = outboxDrainDurationSpy.mock.calls[0]!;
    expect(attrs).toEqual({ event_type: EVENT_TYPE_METRICS });

    expect(outboxDeadLetterSpy).not.toHaveBeenCalled();
  });

  it("dead-letter branch (attempts >= MAX_ATTEMPTS): records dead-letter + drain duration with event_type", async () => {
    if (maybeSkip()) return;

    class PoisonError extends Error {
      override readonly name = "PoisonError";
    }
    const consumer: OutboxConsumer<unknown> = {
      consumerId: "test.outbox-dlq",
      eventType: EVENT_TYPE_METRICS,
      async handle(_event: OutboxEventEnvelope<unknown>): Promise<void> {
        throw new PoisonError("boom");
      },
    };
    const registry = new OutboxConsumerRegistry();
    registry.register(consumer);

    const drainer = new DrainerProcessor({
      pool: env!.admin,
      registry,
      claimFn: makeT595ClaimFn(EV_METRICS_T595, 8) as (
        pool: import("pg").Pool,
        batchSize: number,
      ) => Promise<ClaimedOutboxEvent[]>,
    });

    await drainer.tick();

    expect(outboxDeadLetterSpy).toHaveBeenCalledTimes(1);
    expect(outboxDeadLetterSpy).toHaveBeenCalledWith({ event_type: EVENT_TYPE_METRICS });

    expect(outboxDrainDurationSpy).toHaveBeenCalledTimes(1);
    const [durationAttrs] = outboxDrainDurationSpy.mock.calls[0]!;
    expect(durationAttrs).toEqual({ event_type: EVENT_TYPE_METRICS });
  });

  it("no-consumer branch (UnroutableEventType): records drain duration, NOT dead-letter (treated as retryable)", async () => {
    if (maybeSkip()) return;

    // Empty registry — no consumer for event_type EVENT_TYPE_METRICS.
    const registry = new OutboxConsumerRegistry();

    const drainer = new DrainerProcessor({
      pool: env!.admin,
      registry,
      claimFn: makeT595ClaimFn(EV_METRICS_T595, 0) as (
        pool: import("pg").Pool,
        batchSize: number,
      ) => Promise<ClaimedOutboxEvent[]>,
    });

    await drainer.tick();

    expect(outboxDrainDurationSpy).toHaveBeenCalledTimes(1);
    const [attrs] = outboxDrainDurationSpy.mock.calls[0]!;
    // The drainer passes row.event_type verbatim; an unroutable event_type
    // still labels the duration so operators see the unrouted traffic.
    expect(attrs).toEqual({ event_type: EVENT_TYPE_METRICS });

    expect(outboxDeadLetterSpy).not.toHaveBeenCalled();
  });

  it("dead-letter branch preserves existing markDeadLettered persistence semantics", async () => {
    if (maybeSkip()) return;

    class PoisonError extends Error {
      override readonly name = "PoisonError";
    }
    const consumer: OutboxConsumer<unknown> = {
      consumerId: "test.outbox-state",
      eventType: EVENT_TYPE_METRICS,
      async handle(_event: OutboxEventEnvelope<unknown>): Promise<void> {
        throw new PoisonError("boom");
      },
    };
    const registry = new OutboxConsumerRegistry();
    registry.register(consumer);

    const drainer = new DrainerProcessor({
      pool: env!.admin,
      registry,
      claimFn: makeT595ClaimFn(EV_METRICS_T595, 8) as (
        pool: import("pg").Pool,
        batchSize: number,
      ) => Promise<ClaimedOutboxEvent[]>,
    });

    await drainer.tick();

    const r = await env!.admin.query<{ delivery_state: string }>(
      `SELECT delivery_state FROM outbox_events WHERE event_id=$1`,
      [EV_METRICS_T595],
    );
    expect(r.rows[0]!.delivery_state).toBe("dead_lettered");
  });
});
