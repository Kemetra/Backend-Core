/**
 * T560 (partial) / T597 -- Outbox repository basic operations.
 *
 * Proves that the `outbox_events` table, created by migration
 * 0006_outbox_events.sql, supports the basic insert/select lifecycle:
 *
 *   - A producer can insert a pending row for a given tenant.
 *   - The drainer can claim the row (transition to 'claimed').
 *   - The consumer can mark it delivered ('delivered' + processed_at).
 *   - A dead-lettered row (after exhausting attempts) is visible via the
 *     triage index.
 *   - Tenant context is enforced: rows inserted for tenant A are not
 *     visible under tenant B's context (cross-tenant isolation).
 *
 * Docker / Testcontainers: required. Set MIGRATION_TEST_ALLOW_SKIP=1 to
 * soft-skip in local environments without Docker.
 *
 * Scope note: This spec covers persistence happy-paths only (T560 insert /
 * claim / deliver basics). Cross-tenant RLS enforcement and BYPASSRLS probe
 * live in rls.spec.ts (T566). Concurrent drainer race (T560 advanced) is
 * deferred to a future slice (T580/T581 drainer implementation).
 */
import {
  applyAllUpAndCreateAppRole,
  APP_ROLE_NAME,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../_helpers/postgres-container";

// ---------------------------------------------------------------------------
// Fixture UUIDs -- prefix "ob" (outbox), no collision with other suites
// ---------------------------------------------------------------------------
const TENANT_A = "0ba00000-0000-7000-8000-000000000001";
const TENANT_B = "0bb00000-0000-7000-8000-000000000002";

// Event IDs are v4 UUIDs here (UUIDv7 is the production preference but v4
// is structurally identical for test purposes).
const EVENT_1 = "0be10000-0000-4000-8000-000000000001";
const EVENT_2 = "0be20000-0000-4000-8000-000000000002";
const EVENT_DEAD = "0bed0000-0000-4000-8000-000000000099";

let env: PgTestEnv | null = null;
let dockerSkipped = false;

beforeAll(async () => {
  try {
    env = await startPgEnv();
    // Apply ALL migrations so outbox_events (0006) is present.
    await applyAllUpAndCreateAppRole(env);

    // Seed two tenants as superuser (RLS bypassed at setup time by design).
    await env.admin.query(
      `INSERT INTO tenants (id, slug, name) VALUES
         ($1, 'outbox-repo-tenant-a', 'Outbox Repo Tenant A'),
         ($2, 'outbox-repo-tenant-b', 'Outbox Repo Tenant B')`,
      [TENANT_A, TENANT_B],
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[outbox/repository.spec] Docker NOT AVAILABLE: ${msg}\n`);
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
    // eslint-disable-next-line no-console
    console.warn("[outbox/repository.spec] skipping (Docker unavailable)");
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Helper: insert an event as superuser (bypasses RLS for seeding).
// ---------------------------------------------------------------------------
async function insertEvent(
  eventId: string,
  tenantId: string,
  eventType = "audit.event.created",
  deliveryState = "pending",
  attempts = 0,
  processedAt: string | null = null,
): Promise<void> {
  await env!.admin.query(
    `INSERT INTO outbox_events
       (event_id, tenant_id, event_type, payload, delivery_state, attempts, processed_at)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)
     ON CONFLICT (event_id) DO NOTHING`,
    [
      eventId,
      tenantId,
      eventType,
      JSON.stringify({ ref: eventId }),
      deliveryState,
      attempts,
      processedAt,
    ],
  );
}

// ---------------------------------------------------------------------------
// Suite 1: Basic insert / select under correct tenant context
// ---------------------------------------------------------------------------
describe("outbox_events — basic insert and tenant-scoped select (R-1)", () => {
  beforeAll(async () => {
    if (dockerSkipped) return;
    await insertEvent(EVENT_1, TENANT_A);
  });

  it("the table exists after applying all migrations (R-1a)", async () => {
    if (maybeSkip()) return;
    const r = await env!.admin.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'outbox_events'`,
    );
    expect(r.rows[0]?.count).toBe("1");
  });

  it("a pending event inserted for tenant A is readable as superuser (R-1b)", async () => {
    if (maybeSkip()) return;
    const r = await env!.admin.query<{
      event_id: string;
      delivery_state: string;
      attempts: number;
    }>(
      "SELECT event_id, delivery_state, attempts FROM outbox_events WHERE event_id = $1",
      [EVENT_1],
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]!.delivery_state).toBe("pending");
    expect(r.rows[0]!.attempts).toBe(0);
  });

  it("the pending event is visible under the correct tenant context (R-1c)", async () => {
    if (maybeSkip()) return;

    const client = await env!.app.connect();
    try {
      // Confirm we are the non-superuser role so RLS actually fires.
      const whoami = await client.query<{ current_user: string }>("SELECT current_user");
      expect(whoami.rows[0]?.current_user).toBe(APP_ROLE_NAME);

      await client.query("BEGIN");
      await client.query(`SET LOCAL app.current_tenant = '${TENANT_A}'`);
      await client.query(`SET LOCAL app.is_platform_admin = 'false'`);

      const r = await client.query<{ event_id: string }>(
        "SELECT event_id FROM outbox_events WHERE event_id = $1",
        [EVENT_1],
      );
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0]!.event_id).toBe(EVENT_1);

      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });

  it("the pending event is NOT visible under the wrong tenant context (R-1d cross-tenant read)", async () => {
    if (maybeSkip()) return;

    const client = await env!.app.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL app.current_tenant = '${TENANT_B}'`);
      await client.query(`SET LOCAL app.is_platform_admin = 'false'`);

      // Tenant B context must not see tenant A's event row.
      const r = await client.query<{ event_id: string }>(
        "SELECT event_id FROM outbox_events WHERE event_id = $1",
        [EVENT_1],
      );
      expect(r.rows).toHaveLength(0);

      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });
});

// ---------------------------------------------------------------------------
// Suite 2: Claim transition (pending -> claimed)
// ---------------------------------------------------------------------------
describe("outbox_events — claim transition (R-2)", () => {
  beforeAll(async () => {
    if (dockerSkipped) return;
    await insertEvent(EVENT_2, TENANT_A);
  });

  it("drainer can claim a pending event (UPDATE delivery_state + attempts) as superuser (R-2a)", async () => {
    if (maybeSkip()) return;

    // Simulate the drainer claim CTE using a plain UPDATE (the full
    // FOR UPDATE SKIP LOCKED claim path is a drainer concern tested by
    // T580/T581; here we validate that the column constraints and state
    // machine accept the transition).
    await env!.admin.query(
      `UPDATE outbox_events
          SET delivery_state = 'claimed',
              attempts        = attempts + 1,
              updated_at      = now()
        WHERE event_id = $1`,
      [EVENT_2],
    );

    const r = await env!.admin.query<{
      delivery_state: string;
      attempts: number;
    }>(
      "SELECT delivery_state, attempts FROM outbox_events WHERE event_id = $1",
      [EVENT_2],
    );
    expect(r.rows[0]!.delivery_state).toBe("claimed");
    expect(r.rows[0]!.attempts).toBe(1);
  });

  it("consumer can mark the event delivered (R-2b)", async () => {
    if (maybeSkip()) return;

    await env!.admin.query(
      `UPDATE outbox_events
          SET delivery_state = 'delivered',
              claimed_at     = NULL,
              processed_at   = now(),
              updated_at     = now()
        WHERE event_id = $1`,
      [EVENT_2],
    );

    const r = await env!.admin.query<{
      delivery_state: string;
      processed_at: string | null;
    }>(
      "SELECT delivery_state, processed_at FROM outbox_events WHERE event_id = $1",
      [EVENT_2],
    );
    expect(r.rows[0]!.delivery_state).toBe("delivered");
    expect(r.rows[0]!.processed_at).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Suite 3: Dead-letter row lifecycle
// ---------------------------------------------------------------------------
describe("outbox_events — dead-letter row (R-3)", () => {
  beforeAll(async () => {
    if (dockerSkipped) return;
    // Insert a row that has already exhausted its retry budget.
    await insertEvent(EVENT_DEAD, TENANT_A, "audit.event.created", "dead_lettered", 8, new Date().toISOString());
  });

  it("a dead_lettered row is readable by the drainer claim index (R-3a)", async () => {
    if (maybeSkip()) return;
    // The dead-letter partial index (outbox_events_dead_letter_idx) covers
    // delivery_state = 'dead_lettered'.  Confirm the row is there and the
    // CHECK constraint accepted the state.
    const r = await env!.admin.query<{
      delivery_state: string;
      attempts: number;
      processed_at: string | null;
    }>(
      "SELECT delivery_state, attempts, processed_at FROM outbox_events WHERE event_id = $1",
      [EVENT_DEAD],
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]!.delivery_state).toBe("dead_lettered");
    expect(r.rows[0]!.attempts).toBe(8);
    expect(r.rows[0]!.processed_at).not.toBeNull();
  });

  it("CHECK constraint rejects an invalid delivery_state value (R-3b)", async () => {
    if (maybeSkip()) return;
    await expect(
      env!.admin.query(
        `INSERT INTO outbox_events
           (event_id, tenant_id, event_type, payload, delivery_state)
         VALUES ($1, $2, $3, $4::jsonb, $5)`,
        [
          "0bff0000-0000-4000-8000-000000000001",
          TENANT_A,
          "audit.event.created",
          JSON.stringify({}),
          "bogus_state",
        ],
      ),
    ).rejects.toThrow(/check|constraint/i);
  });
});

// ---------------------------------------------------------------------------
// Suite 4: last_error and next_attempt_at columns
// ---------------------------------------------------------------------------
describe("outbox_events — retry metadata columns (R-4)", () => {
  const EVENT_RETRY = "0b4e0000-0000-4000-8000-000000000001";

  beforeAll(async () => {
    if (dockerSkipped) return;
    await insertEvent(EVENT_RETRY, TENANT_A);
  });

  it("drainer can set last_error and next_attempt_at on a failed transition (R-4a)", async () => {
    if (maybeSkip()) return;

    const nextAttempt = new Date(Date.now() + 30_000).toISOString();
    await env!.admin.query(
      `UPDATE outbox_events
          SET delivery_state  = 'failed',
              claimed_at      = NULL,
              attempts        = 1,
              last_error      = $2,
              next_attempt_at = $3,
              updated_at      = now()
        WHERE event_id = $1`,
      [EVENT_RETRY, "TransientError", nextAttempt],
    );

    const r = await env!.admin.query<{
      delivery_state: string;
      last_error: string;
      next_attempt_at: string;
    }>(
      "SELECT delivery_state, last_error, next_attempt_at FROM outbox_events WHERE event_id = $1",
      [EVENT_RETRY],
    );
    expect(r.rows[0]!.delivery_state).toBe("failed");
    expect(r.rows[0]!.last_error).toBe("TransientError");
    expect(new Date(r.rows[0]!.next_attempt_at).getTime()).toBeGreaterThan(Date.now());
  });
});
