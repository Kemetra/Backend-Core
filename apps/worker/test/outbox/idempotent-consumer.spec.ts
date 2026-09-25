/**
 * T563 — Idempotent consumer test.
 *
 * Slice 1B idempotency strategy
 * -----------------------------
 * The full per-consumer `(consumer_id, event_id)` dedup projection
 * (`processed_events` table) is deferred to Slice 1C — it requires a new
 * migration which is FORBIDDEN in this slice's scope.
 *
 * Slice 1B's idempotency contract is enforced at the OUTBOX ROW LEVEL:
 *   1. `claimBatch` only sees rows in `pending` or `failed` state.
 *   2. A `delivered` row is invisible to the claim query.
 *   3. Therefore the consumer's `handle()` is invoked at most once per row
 *      in steady-state operation.
 *   4. A stale claim can also be recovered and redelivered after worker loss;
 *      consumers must tolerate that at-least-once delivery path.
 *
 * What this test proves:
 *   I-1  After one successful tick, the consumer is NOT invoked a second time
 *        by an immediate second tick on the same row.
 *   I-2  If an operator manually reverts a delivered row to pending (simulating
 *        a Slice 1C replay action), the consumer IS invoked again.
 *   I-3  The consumer's idempotency obligation includes crash recovery;
 *        this spec covers steady-state and operator replay separately.
 *
 * Future Slice 1C will introduce `processed_events` as defense-in-depth,
 * tightening the contract to: "tolerate being called more than once with
 * the same event_id". This test will then evolve to assert the dedup table
 * blocks the second side-effect.
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

const TENANT_A = "0be00000-0000-7000-8000-000000000001";
const EV_IDEM = "0bf00000-0000-4000-8000-000000000001";

let env: PgTestEnv | null = null;
let dockerSkipped = false;

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    await env.admin.query(
      `INSERT INTO tenants (id, slug, name) VALUES ($1, 'idem-test-tenant', 'Idempotency Test')`,
      [TENANT_A],
    );
    await env.admin.query(
      `INSERT INTO outbox_events
         (event_id, tenant_id, event_type, payload, delivery_state, attempts)
       VALUES ($1, $2, 'test.event.idem', '{"once":true}'::jsonb, 'pending', 0)`,
      [EV_IDEM, TENANT_A],
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      console.warn(`\n[outbox/idempotent-consumer.spec] Docker NOT AVAILABLE: ${msg}\n`);
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
    console.warn("[outbox/idempotent-consumer.spec] skipping (Docker unavailable)");
    return true;
  }
  return false;
}

/**
 * Test claim helper — claims any pending/failed row whose event_id matches.
 * Mirrors the production claim query but scoped to a single event for
 * test predictability. Uses FOR UPDATE SKIP LOCKED to keep the contract
 * realistic.
 */
function makeIdemClaimFn() {
  return async (_pool: unknown, _batchSize: number): Promise<ClaimedOutboxEvent[]> => {
    const res = await env!.admin.query<ClaimedOutboxEvent>(
      `WITH claimed AS (
         UPDATE outbox_events
            SET delivery_state='claimed', attempts=attempts+1, updated_at=now()
          WHERE event_id IN (
            SELECT event_id FROM outbox_events
             WHERE event_id=$1 AND delivery_state IN ('pending','failed')
               AND (next_attempt_at IS NULL OR next_attempt_at <= now())
             FOR UPDATE SKIP LOCKED LIMIT 1
          )
          RETURNING event_id, event_type, tenant_id, store_id, payload, correlation_id, occurred_at, attempts
       ) SELECT * FROM claimed`,
      [EV_IDEM],
    );
    return res.rows;
  };
}

describe("T563: idempotent consumer — outbox-row-level dedup", () => {
  it("I-1: delivered row is not re-claimed; consumer fires exactly once across two ticks", async () => {
    if (maybeSkip()) return;

    const calls: Array<string> = [];

    const oneShotConsumer: OutboxConsumer<unknown> = {
      consumerId: "test.idem-consumer",
      eventType: "test.event.idem",
      async handle(event: OutboxEventEnvelope<unknown>): Promise<void> {
        calls.push(event.event_id);
      },
    };

    const registry = new OutboxConsumerRegistry();
    registry.register(oneShotConsumer);

    const drainer = new DrainerProcessor({
      pool: env!.admin,
      registry,
      claimFn: makeIdemClaimFn() as (
        pool: import("pg").Pool,
        batchSize: number,
      ) => Promise<ClaimedOutboxEvent[]>,
    });

    // First tick: claims the row, consumer succeeds, row → delivered.
    await drainer.tick();
    expect(calls).toEqual([EV_IDEM]);

    // Second tick (immediate): row is `delivered`, claim helper finds nothing.
    await drainer.tick();
    expect(calls).toEqual([EV_IDEM]); // unchanged — only one invocation total

    // Confirm DB state.
    const r = await env!.admin.query<{ delivery_state: string }>(
      `SELECT delivery_state FROM outbox_events WHERE event_id=$1`,
      [EV_IDEM],
    );
    expect(r.rows[0]!.delivery_state).toBe("delivered");
  });

  it("I-2: explicit operator revert (delivered → pending) causes a second invocation", async () => {
    if (maybeSkip()) return;

    // Simulate a Slice 1C dead-letter admin replay action: an operator manually
    // reverts the row to pending. After this, the drainer MUST re-invoke the
    // consumer. Claim recovery is the other re-delivery path.
    await env!.admin.query(
      `UPDATE outbox_events
          SET delivery_state='pending',
              claimed_at=NULL,
              processed_at=NULL,
              attempts=0,
              next_attempt_at=NULL,
              updated_at=now()
        WHERE event_id=$1`,
      [EV_IDEM],
    );

    const calls: Array<string> = [];
    const consumer: OutboxConsumer<unknown> = {
      consumerId: "test.idem-consumer-2",
      eventType: "test.event.idem",
      async handle(event: OutboxEventEnvelope<unknown>): Promise<void> {
        calls.push(event.event_id);
      },
    };
    const registry = new OutboxConsumerRegistry();
    registry.register(consumer);

    const drainer = new DrainerProcessor({
      pool: env!.admin,
      registry,
      claimFn: makeIdemClaimFn() as (
        pool: import("pg").Pool,
        batchSize: number,
      ) => Promise<ClaimedOutboxEvent[]>,
    });

    await drainer.tick();
    expect(calls).toEqual([EV_IDEM]);

    const r = await env!.admin.query<{ delivery_state: string }>(
      `SELECT delivery_state FROM outbox_events WHERE event_id=$1`,
      [EV_IDEM],
    );
    expect(r.rows[0]!.delivery_state).toBe("delivered");
  });
});
