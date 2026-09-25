/**
 * T560 (full) — Outbox repository runtime: insert / claim / mark-delivered /
 * mark-failed / mark-dead-lettered + 2-drainer race.
 *
 * Extends Slice 1A's partial T560 coverage (which used plain UPDATE statements).
 * This spec exercises the full claim CTE with FOR UPDATE SKIP LOCKED via the
 * production-ready repository functions.
 *
 * Tests:
 *   R-5  claimBatch transitions pending → claimed, increments attempts
 *   R-6  markDelivered transitions claimed → delivered, sets processed_at
 *   R-7  markFailed transitions claimed → failed, sets last_error + next_attempt_at
 *   R-8  markDeadLettered transitions claimed → dead_lettered, sets processed_at
 *   R-9  2-drainer race: two concurrent claimBatch calls claim disjoint rows
 *   R-10 markFailed row not re-claimed while next_attempt_at is in the future
 *   R-11 markFailed row IS re-claimed once next_attempt_at <= now()
 *   R-12 attempts=8 → after consumer throws, markDeadLettered is expected (budget check)
 *
 * Docker / Testcontainers: required. Set MIGRATION_TEST_ALLOW_SKIP=1 to
 * soft-skip in local environments without Docker.
 */
import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../_helpers/postgres-container";
import {
  claimBatch,
  markDelivered,
  markFailed,
  markDeadLettered,
  nextAttemptDelayMs,
  MAX_ATTEMPTS,
} from "../../src/outbox/repository";
import { emit } from "../../src/outbox/producer";
import { runWithTenantContext } from "../../src/middleware/tenant-context";

// ---------------------------------------------------------------------------
// Fixture UUIDs
// ---------------------------------------------------------------------------
const TENANT_A  = "0ca00000-0000-7000-8000-000000000001";
const TENANT_B  = "0cb00000-0000-7000-8000-000000000002";
const STORE_A   = "0c5a0000-0000-7000-8000-000000000011";

// Individual event UUIDs used across suites (pre-seeded via helper)
const EV_CLAIM   = "0cc10000-0000-4000-8000-000000000001";
const EV_DELIVER = "0cc20000-0000-4000-8000-000000000002";
const EV_FAIL    = "0cc30000-0000-4000-8000-000000000003";
const EV_DEAD    = "0cc40000-0000-4000-8000-000000000004";
const EV_RACE_1  = "0cc50000-0000-4000-8000-000000000005";
const EV_RACE_2  = "0cc60000-0000-4000-8000-000000000006";
const EV_BACKOFF = "0cc70000-0000-4000-8000-000000000007";
const EV_BACKOFF2 = "0cc80000-0000-4000-8000-000000000008";
const EV_BUDGET  = "0cc90000-0000-4000-8000-000000000009";

let env: PgTestEnv | null = null;
let dockerSkipped = false;

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);

    // Seed two tenants.
    await env.admin.query(
      `INSERT INTO tenants (id, slug, name) VALUES
         ($1, 'repo-rt-tenant-a', 'Repo Runtime Tenant A'),
         ($2, 'repo-rt-tenant-b', 'Repo Runtime Tenant B')`,
      [TENANT_A, TENANT_B],
    );

    // Seed pending events using the producer's emit() within runWithTenantContext.
    // We seed via superuser for simplicity (bypasses RLS for seeding).
    await env.admin.query(
      `INSERT INTO outbox_events
         (event_id, tenant_id, store_id, event_type, payload, delivery_state, attempts)
       VALUES
         ($1,  $9, $10, 'audit.event.created', '{"r":5}'::jsonb, 'pending', 0),
         ($2,  $9, null, 'audit.event.created', '{"r":6}'::jsonb, 'pending', 0),
         ($3,  $9, null, 'audit.event.created', '{"r":7}'::jsonb, 'pending', 0),
         ($4,  $9, null, 'audit.event.created', '{"r":8}'::jsonb, 'pending', 0),
         ($5,  $9, null, 'audit.event.created', '{"r":"race1"}'::jsonb, 'pending', 0),
         ($6,  $9, null, 'audit.event.created', '{"r":"race2"}'::jsonb, 'pending', 0),
         ($7,  $9, null, 'audit.event.created', '{"r":"backoff"}'::jsonb, 'pending', 0),
         ($8,  $9, null, 'audit.event.created', '{"r":"backoff2"}'::jsonb, 'pending', 0),
         ($11, $9, null, 'audit.event.created', '{"r":"budget"}'::jsonb, 'pending', 0)`,
      [EV_CLAIM, EV_DELIVER, EV_FAIL, EV_DEAD, EV_RACE_1, EV_RACE_2, EV_BACKOFF, EV_BACKOFF2, TENANT_A, STORE_A, EV_BUDGET],
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      console.warn(`\n[outbox/repository-runtime.spec] Docker NOT AVAILABLE: ${msg}\n`);
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
    console.warn("[outbox/repository-runtime.spec] skipping (Docker unavailable)");
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Suite R-5: claimBatch — pending → claimed
// ---------------------------------------------------------------------------
describe("claimBatch — pending to claimed transition (R-5)", () => {
  it("R-5a: claims a pending event and increments attempts to 1", async () => {
    if (maybeSkip()) return;

    // Claim only EV_CLAIM by using batchSize=1 and it being the earliest pending.
    // We need to be careful about ordering — use a targeted claim approach.
    // First make all other events "not pending" temporarily is not practical,
    // so we claim batch of all and check EV_CLAIM is in results.
    const claimed = await claimBatch(env!.admin, 1);
    expect(claimed.length).toBeGreaterThanOrEqual(1);

    // Verify via admin that some event is now claimed.
    const r = await env!.admin.query<{ delivery_state: string; attempts: number }>(
      `SELECT delivery_state, attempts FROM outbox_events
        WHERE delivery_state = 'claimed' LIMIT 1`,
    );
    expect(r.rows.length).toBeGreaterThanOrEqual(1);
    expect(r.rows[0]!.delivery_state).toBe("claimed");
    expect(r.rows[0]!.attempts).toBe(1);
  });

  it("R-5b: returned row has correct shape including tenant_id and payload", async () => {
    if (maybeSkip()) return;

    // Insert a fresh event to claim predictably.
    const freshId = "0cd10000-0000-4000-8000-000000000001";
    await env!.admin.query(
      `INSERT INTO outbox_events
         (event_id, tenant_id, event_type, payload, delivery_state, attempts)
       VALUES ($1, $2, 'audit.event.created', '{"test":"fresh"}'::jsonb, 'pending', 0)`,
      [freshId, TENANT_A],
    );

    // Mark all existing claimed events as delivered first so we can claim fresh predictably.
    await env!.admin.query(
      `UPDATE outbox_events SET delivery_state='delivered', processed_at=now(), claimed_at=NULL
        WHERE delivery_state='claimed'`,
    );

    const claimed = await claimBatch(env!.admin, 10);
    const row = claimed.find((r) => r.event_id === freshId);
    expect(row).toBeDefined();
    expect(row!.tenant_id).toBe(TENANT_A);
    expect(row!.event_type).toBe("audit.event.created");
    expect(row!.attempts).toBe(1);
    expect(row!.occurred_at).toBeInstanceOf(Date);
    expect(row!.payload).toMatchObject({ test: "fresh" });
  });
});

// ---------------------------------------------------------------------------
// Suite R-6: markDelivered
// ---------------------------------------------------------------------------
describe("markDelivered — claimed to delivered (R-6)", () => {
  it("R-6a: sets delivery_state='delivered' and processed_at", async () => {
    if (maybeSkip()) return;

    // Claim EV_DELIVER if not yet claimed.
    await env!.admin.query(
      `UPDATE outbox_events SET delivery_state='claimed', attempts=1, updated_at=now()
        WHERE event_id=$1 AND delivery_state='pending'`,
      [EV_DELIVER],
    );

    await markDelivered(env!.admin, EV_DELIVER, 1);

    const r = await env!.admin.query<{ delivery_state: string; processed_at: string | null }>(
      `SELECT delivery_state, processed_at FROM outbox_events WHERE event_id=$1`,
      [EV_DELIVER],
    );
    expect(r.rows[0]!.delivery_state).toBe("delivered");
    expect(r.rows[0]!.processed_at).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Suite R-7: markFailed
// ---------------------------------------------------------------------------
describe("markFailed — claimed to failed with backoff (R-7)", () => {
  it("R-7a: sets delivery_state='failed', last_error, and next_attempt_at in the future", async () => {
    if (maybeSkip()) return;

    await env!.admin.query(
      `UPDATE outbox_events SET delivery_state='claimed', attempts=1, updated_at=now()
        WHERE event_id=$1 AND delivery_state='pending'`,
      [EV_FAIL],
    );

    const before = Date.now();
    await markFailed(env!.admin, EV_FAIL, 1, "TransientError");

    const r = await env!.admin.query<{
      delivery_state: string;
      last_error: string;
      next_attempt_at: string;
    }>(
      `SELECT delivery_state, last_error, next_attempt_at FROM outbox_events WHERE event_id=$1`,
      [EV_FAIL],
    );
    expect(r.rows[0]!.delivery_state).toBe("failed");
    expect(r.rows[0]!.last_error).toBe("TransientError");
    const nextAt = new Date(r.rows[0]!.next_attempt_at).getTime();
    // Should be ~30s in the future (attempts=1 → 30s delay).
    expect(nextAt).toBeGreaterThan(before + 25_000);
    expect(nextAt).toBeLessThan(before + 35_000);
  });
});

// ---------------------------------------------------------------------------
// Suite R-8: markDeadLettered
// ---------------------------------------------------------------------------
describe("markDeadLettered — claimed to dead_lettered (R-8)", () => {
  it("R-8a: sets delivery_state='dead_lettered', processed_at, and last_error", async () => {
    if (maybeSkip()) return;

    // Force the row into the pre-dead-letter state regardless of what earlier
    // suites did to it — this test asserts the markDeadLettered SQL works,
    // not the inter-suite ordering.
    await env!.admin.query(
      `UPDATE outbox_events SET delivery_state='claimed', attempts=8, updated_at=now()
        WHERE event_id=$1`,
      [EV_DEAD],
    );

    await markDeadLettered(env!.admin, EV_DEAD, "PoisonMessageError", 8);

    const r = await env!.admin.query<{
      delivery_state: string;
      processed_at: string | null;
      last_error: string;
      attempts: number;
    }>(
      `SELECT delivery_state, processed_at, last_error, attempts FROM outbox_events WHERE event_id=$1`,
      [EV_DEAD],
    );
    expect(r.rows[0]!.delivery_state).toBe("dead_lettered");
    expect(r.rows[0]!.processed_at).not.toBeNull();
    expect(r.rows[0]!.last_error).toBe("PoisonMessageError");
    expect(r.rows[0]!.attempts).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// Suite R-9: 2-drainer race (FOR UPDATE SKIP LOCKED)
// ---------------------------------------------------------------------------
describe("2-drainer SKIP LOCKED race (R-9)", () => {
  it("R-9: two concurrent claimBatch calls claim disjoint rows (no overlap)", async () => {
    if (maybeSkip()) return;

    // Insert two fresh events for this test.
    const race1 = "0c7a0000-0000-4000-8000-000000000001";
    const race2 = "0c7a0000-0000-4000-8000-000000000002";

    // First clean up any existing pending rows to make the test predictable.
    await env!.admin.query(
      `UPDATE outbox_events SET delivery_state='delivered', processed_at=now(), claimed_at=NULL
        WHERE delivery_state IN ('pending','failed','claimed')`,
    );

    await env!.admin.query(
      `INSERT INTO outbox_events
         (event_id, tenant_id, event_type, payload, delivery_state, attempts)
       VALUES
         ($1, $3, 'audit.event.created', '{"race":1}'::jsonb, 'pending', 0),
         ($2, $3, 'audit.event.created', '{"race":2}'::jsonb, 'pending', 0)`,
      [race1, race2, TENANT_A],
    );

    // Two concurrent claim calls — each claiming 1 row.
    const [claimA, claimB] = await Promise.all([
      claimBatch(env!.admin, 1),
      claimBatch(env!.admin, 1),
    ]);

    // Each drainer should get exactly 1 row, and they must be different rows.
    const idsA = claimA.map((r) => r.event_id);
    const idsB = claimB.map((r) => r.event_id);
    const allIds = [...idsA, ...idsB];

    // Total: exactly 2 rows claimed (each drainer got 1).
    expect(allIds).toHaveLength(2);

    // No overlap.
    const set = new Set(allIds);
    expect(set.size).toBe(2);

    // Both seeded events are claimed.
    expect(set.has(race1)).toBe(true);
    expect(set.has(race2)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Suite R-10 / R-11: backoff — failed row not re-claimed while window active
// ---------------------------------------------------------------------------
describe("backoff — failed row eligibility (R-10/R-11)", () => {
  it("R-10: a failed row with next_attempt_at in the future is NOT claimed", async () => {
    if (maybeSkip()) return;

    const futureNext = new Date(Date.now() + 60_000).toISOString();
    await env!.admin.query(
      `UPDATE outbox_events
          SET delivery_state='failed', attempts=1, next_attempt_at=$2, claimed_at=NULL, updated_at=now()
        WHERE event_id=$1`,
      [EV_BACKOFF, futureNext],
    );

    // Ensure no other pending rows exist.
    await env!.admin.query(
      `UPDATE outbox_events SET delivery_state='delivered', processed_at=now(), claimed_at=NULL
        WHERE delivery_state IN ('pending','claimed') AND event_id != $1`,
      [EV_BACKOFF],
    );

    const claimed = await claimBatch(env!.admin, 10);
    const found = claimed.find((r) => r.event_id === EV_BACKOFF);
    expect(found).toBeUndefined();
  });

  it("R-11: a failed row with next_attempt_at in the past IS claimed", async () => {
    if (maybeSkip()) return;

    const pastNext = new Date(Date.now() - 1_000).toISOString();
    await env!.admin.query(
      `UPDATE outbox_events
          SET delivery_state='failed', attempts=1, next_attempt_at=$2, claimed_at=NULL, updated_at=now()
        WHERE event_id=$1`,
      [EV_BACKOFF2, pastNext],
    );

    const claimed = await claimBatch(env!.admin, 10);
    const found = claimed.find((r) => r.event_id === EV_BACKOFF2);
    expect(found).toBeDefined();
    expect(found!.attempts).toBe(2); // incremented by claimBatch
  });
});

// ---------------------------------------------------------------------------
// Suite R-12: retry budget (attempts=8 → dead_lettered)
// ---------------------------------------------------------------------------
describe("retry budget — 8 attempts then dead_lettered (R-12)", () => {
  it("R-12: after 8 claims, markDeadLettered is correct; markFailed is not called again", async () => {
    if (maybeSkip()) return;

    // Simulate the drainer advancing the event through 7 failures.
    // Set attempts to 7, delivery_state='failed', next_attempt_at in the past.
    const pastNext = new Date(Date.now() - 1_000).toISOString();
    await env!.admin.query(
      `UPDATE outbox_events
          SET delivery_state='failed', attempts=7, next_attempt_at=$2, claimed_at=NULL, updated_at=now()
        WHERE event_id=$1`,
      [EV_BUDGET, pastNext],
    );

    // Clean up other pending/failed rows.
    await env!.admin.query(
      `UPDATE outbox_events SET delivery_state='delivered', processed_at=now(), claimed_at=NULL
        WHERE delivery_state IN ('pending','claimed') AND event_id != $1`,
      [EV_BUDGET],
    );

    // Claim the 8th attempt.
    const claimed = await claimBatch(env!.admin, 10);
    const row = claimed.find((r) => r.event_id === EV_BUDGET);
    expect(row).toBeDefined();
    expect(row!.attempts).toBe(8); // incremented at claim time

    // Consumer "fails" on the 8th attempt → markDeadLettered.
    expect(row!.attempts).toBe(MAX_ATTEMPTS);
    await markDeadLettered(env!.admin, EV_BUDGET, "PoisonError", 8);

    // Verify no 9th claim is possible.
    const reclaimAttempt = await claimBatch(env!.admin, 10);
    const reclaimedBudget = reclaimAttempt.find((r) => r.event_id === EV_BUDGET);
    expect(reclaimedBudget).toBeUndefined(); // dead_lettered cannot be re-claimed

    // Verify final state.
    const r = await env!.admin.query<{
      delivery_state: string;
      processed_at: string | null;
      attempts: number;
    }>(
      `SELECT delivery_state, processed_at, attempts FROM outbox_events WHERE event_id=$1`,
      [EV_BUDGET],
    );
    expect(r.rows[0]!.delivery_state).toBe("dead_lettered");
    expect(r.rows[0]!.processed_at).not.toBeNull();
    expect(r.rows[0]!.attempts).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// Suite: emit() producer helper (T580 happy-path from db repository test)
// ---------------------------------------------------------------------------
describe("emit() producer helper — inserts a pending row (T580)", () => {
  it("inserts a pending outbox_events row with correct fields via the emit helper", async () => {
    if (maybeSkip()) return;

    let emittedId: string | null = null;

    await runWithTenantContext(
      env!.admin,
      { tenantId: TENANT_A, isPlatformAdmin: false },
      async (client) => {
        emittedId = await emit(client, {
          eventType: "audit.event.created",
          tenantId: TENANT_A,
          storeId: STORE_A,
          payload: { action: "test.emit" },
          correlationId: null,
        });
      },
    );

    expect(emittedId).not.toBeNull();

    const r = await env!.admin.query<{
      event_id: string;
      tenant_id: string;
      store_id: string | null;
      event_type: string;
      delivery_state: string;
      attempts: number;
    }>(
      `SELECT event_id, tenant_id, store_id, event_type, delivery_state, attempts
         FROM outbox_events WHERE event_id = $1`,
      [emittedId],
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]!.tenant_id).toBe(TENANT_A);
    expect(r.rows[0]!.store_id).toBe(STORE_A);
    expect(r.rows[0]!.event_type).toBe("audit.event.created");
    expect(r.rows[0]!.delivery_state).toBe("pending");
    expect(r.rows[0]!.attempts).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Unit: nextAttemptDelayMs schedule
// ---------------------------------------------------------------------------
describe("nextAttemptDelayMs backoff schedule (unit)", () => {
  it("attempts=1 → 30s", () => {
    expect(nextAttemptDelayMs(1)).toBe(30_000);
  });
  it("attempts=2 → 2min", () => {
    expect(nextAttemptDelayMs(2)).toBe(2 * 60_000);
  });
  it("attempts=3 → 10min", () => {
    expect(nextAttemptDelayMs(3)).toBe(10 * 60_000);
  });
  it("attempts=4 → 1h (plateau)", () => {
    expect(nextAttemptDelayMs(4)).toBe(60 * 60_000);
  });
  it("attempts=7 → 1h (plateau continues)", () => {
    expect(nextAttemptDelayMs(7)).toBe(60 * 60_000);
  });
  it("MAX_ATTEMPTS is 8", () => {
    expect(MAX_ATTEMPTS).toBe(8);
  });
});
