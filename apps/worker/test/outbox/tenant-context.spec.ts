/**
 * T561 - Tenant-context worker test.
 *
 * Proves that a consumer that skips runWithTenantContext before making
 * tenant-scoped DB writes fails RLS, while a consumer that establishes
 * correct tenant context succeeds.
 *
 * Set MIGRATION_TEST_ALLOW_SKIP=1 to soft-skip if Docker is unavailable.
 */
import {
  applyAllUpAndCreateAppRole,
  APP_ROLE_NAME,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../../../packages/db/__tests__/_helpers/postgres-container";
import { runWithTenantContext } from "@data-pulse-2/db";
import type { OutboxConsumer, OutboxEventEnvelope } from "@data-pulse-2/shared";
import { DrainerProcessor } from "../../src/outbox/drainer.processor";
import { OutboxConsumerRegistry } from "../../src/outbox/registry";
import type { ClaimedOutboxEvent } from "@data-pulse-2/db";

const TENANT_A = "0fa00000-0000-7000-8000-000000000001";
const EV_BAD   = "0fb10000-0000-4000-8000-000000000001";
const EV_GOOD  = "0fb20000-0000-4000-8000-000000000002";

let env: PgTestEnv | null = null;
let dockerSkipped = false;

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    await env.admin.query(
      `INSERT INTO tenants (id, slug, name) VALUES ($1, 'tenant-ctx-test', 'Tenant Ctx Test')`,
      [TENANT_A],
    );
    await env.admin.query(
      `INSERT INTO outbox_events
         (event_id, tenant_id, event_type, payload, delivery_state, attempts)
       VALUES
         ($1, $3, 'test.event.bad',  '{"test":true}'::jsonb, 'pending', 0),
         ($2, $3, 'test.event.good', '{"test":true}'::jsonb, 'pending', 0)`,
      [EV_BAD, EV_GOOD, TENANT_A],
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      console.warn(`\n[outbox/tenant-context.spec] Docker NOT AVAILABLE: ${msg}\n`);
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
    console.warn("[outbox/tenant-context.spec] skipping (Docker unavailable)");
    return true;
  }
  return false;
}

function makeClaimFn(eventId: string) {
  return async (_pool: unknown, _batchSize: number): Promise<ClaimedOutboxEvent[]> => {
    const res = await env!.admin.query<ClaimedOutboxEvent>(
      `WITH claimed AS (
         UPDATE outbox_events SET delivery_state='claimed', attempts=attempts+1, updated_at=now()
         WHERE event_id=$1 AND delivery_state='pending'
         RETURNING event_id, event_type, tenant_id, store_id, payload, correlation_id, occurred_at, attempts
       ) SELECT * FROM claimed`,
      [eventId],
    );
    return res.rows;
  };
}

describe("T561a: consumer without tenant context fails RLS on DB writes", () => {
  it("a consumer that skips runWithTenantContext fails RLS and event transitions to failed", async () => {
    if (maybeSkip()) return;

    let consumerError: Error | null = null;

    const badConsumer: OutboxConsumer<unknown> = {
      consumerId: "test.bad-consumer",
      eventType: "test.event.bad",
      async handle(event: OutboxEventEnvelope<unknown>): Promise<void> {
        const client = await env!.app.connect();
        try {
          await client.query("BEGIN");
          // No tenant context set -> RLS must reject.
          await client.query(`SET LOCAL app.is_platform_admin = 'false'`);
          // audit_events requires tenant context. Without it, INSERT fails RLS.
          await client.query(
            `INSERT INTO audit_events (id, action) VALUES ($1, $2)`,
            ["00000000-0000-4000-8000-000000000099", event.event_type],
          );
          await client.query("COMMIT");
        } catch (err) {
          consumerError = err instanceof Error ? err : new Error(String(err));
          try { await client.query("ROLLBACK"); } catch { /* ignore */ }
          throw consumerError;
        } finally {
          client.release();
        }
      },
    };

    const registry = new OutboxConsumerRegistry();
    registry.register(badConsumer);

    const drainer = new DrainerProcessor({
      pool: env!.admin,
      registry,
      claimFn: makeClaimFn(EV_BAD) as (pool: import("pg").Pool, batchSize: number) => Promise<ClaimedOutboxEvent[]>,
    });

    await drainer.tick();

    const r = await env!.admin.query<{ delivery_state: string }>(
      `SELECT delivery_state FROM outbox_events WHERE event_id=$1`,
      [EV_BAD],
    );
    expect(r.rows[0]!.delivery_state).toBe("failed");

    // The error MUST be a Postgres RLS / permission denial — not a generic
    // failure that happens to land us in `failed`. Without this guard the
    // test would also pass if e.g. a future schema change to `audit_events`
    // added a NOT NULL column (SQLSTATE 23502), or a missing column
    // produced a syntax error — neither would actually prove the
    // tenant-context invariant the spec is named after.
    //
    // SQLSTATE 42501 (`insufficient_privilege`) is the code Postgres uses
    // both for "permission denied for table" and for "new row violates
    // row-level security policy" — exactly the two outcomes a missing
    // tenant context can produce on this INSERT.
    expect(consumerError).not.toBeNull();
    const pgErr = consumerError as unknown as Error & { code?: string };
    expect(pgErr.code).toBe("42501");
    expect(pgErr.message).toMatch(/row.level security|policy|permission denied/i);
  });
});

describe("T561b: consumer WITH correct tenant context succeeds", () => {
  it("a consumer that calls runWithTenantContext correctly gets delivered state", async () => {
    if (maybeSkip()) return;

    let handleCalled = false;

    const goodConsumer: OutboxConsumer<unknown> = {
      consumerId: "test.good-consumer",
      eventType: "test.event.good",
      async handle(event: OutboxEventEnvelope<unknown>): Promise<void> {
        await runWithTenantContext(
          env!.app,
          { tenantId: event.tenant_id, isPlatformAdmin: false },
          async (client) => {
            const r = await client.query<{ event_id: string }>(
              `SELECT event_id FROM outbox_events WHERE event_id=$1`,
              [event.event_id],
            );
            expect(r.rows).toHaveLength(1);
            handleCalled = true;
          },
        );
      },
    };

    const registry = new OutboxConsumerRegistry();
    registry.register(goodConsumer);

    const drainer = new DrainerProcessor({
      pool: env!.admin,
      registry,
      claimFn: makeClaimFn(EV_GOOD) as (pool: import("pg").Pool, batchSize: number) => Promise<ClaimedOutboxEvent[]>,
    });

    await drainer.tick();

    expect(handleCalled).toBe(true);

    const r = await env!.admin.query<{ delivery_state: string }>(
      `SELECT delivery_state FROM outbox_events WHERE event_id=$1`,
      [EV_GOOD],
    );
    expect(r.rows[0]!.delivery_state).toBe("delivered");
  });
});

describe("APP_ROLE_NAME sanity: app_test role has rolbypassrls=false", () => {
  it("confirms RLS premise for T561", async () => {
    if (maybeSkip()) return;
    const r = await env!.admin.query<{ rolbypassrls: boolean }>(
      `SELECT rolbypassrls FROM pg_catalog.pg_roles WHERE rolname=$1`,
      [APP_ROLE_NAME],
    );
    expect(r.rows[0]!.rolbypassrls).toBe(false);
  });
});
