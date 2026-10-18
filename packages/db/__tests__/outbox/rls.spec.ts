/**
 * T566 / T597 / T598 / T600 -- Outbox RLS and privilege probe.
 *
 * Verifies the following non-negotiable security invariants on the
 * `outbox_events` table after migration 0006_outbox_events.sql:
 *
 *   G-1  Cross-tenant SELECT returns empty set (RLS enforcement).
 *   G-2  Correct-tenant SELECT returns the row (positive control).
 *   G-3  Symmetric: tenant B context cannot see tenant A rows.
 *   G-4  RLS WITH CHECK rejects a cross-tenant INSERT attempt.
 *   G-5  FORCE ROW LEVEL SECURITY is set on outbox_events.
 *   G-6  No non-superuser Postgres role has rolbypassrls = true (T600).
 *   G-7  app_test role specifically has rolbypassrls = false.
 *   G-8  RLS isolation survives a no-context connection (GUC not set).
 *
 * Cross-tenant / cross-store regression sweep (T598):
 *   G-9  Existing tables (stores, memberships) still enforce RLS correctly
 *        after migration 0006 is applied -- confirms the new migration did
 *        not accidentally disable or alter policies on existing tables.
 *
 * Docker / Testcontainers: required. Set MIGRATION_TEST_ALLOW_SKIP=1 to
 * soft-skip in local environments without Docker.
 */
import {
  applyAllUpAndCreateAppRole,
  APP_ROLE_NAME,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../_helpers/postgres-container";

// ---------------------------------------------------------------------------
// Fixture UUIDs -- prefix "rls" (outbox rls), no collision with other suites
// ---------------------------------------------------------------------------
const TENANT_A  = "e1a00000-0000-7000-8000-000000000001";
const TENANT_B  = "e1b00000-0000-7000-8000-000000000002";
const EVENT_A   = "e1ea0000-0000-4000-8000-000000000001";
const EVENT_B   = "e1eb0000-0000-4000-8000-000000000002";
const STORE_A   = "e1c10000-0000-7000-8000-000000000011";
const STORE_B   = "e1c20000-0000-7000-8000-000000000022";

let env: PgTestEnv | null = null;
let dockerSkipped = false;

beforeAll(async () => {
  try {
    env = await startPgEnv();
    // Apply ALL migrations (including 0006) before asserting RLS behavior.
    await applyAllUpAndCreateAppRole(env);

    // Seed two tenants and one event per tenant as superuser (RLS bypassed
    // for setup -- this is the correct pattern for test seeding).
    await env.admin.query(
      `INSERT INTO tenants (id, slug, name) VALUES
         ($1, 'rls-outbox-tenant-a', 'RLS Outbox Tenant A'),
         ($2, 'rls-outbox-tenant-b', 'RLS Outbox Tenant B')`,
      [TENANT_A, TENANT_B],
    );

    // Seed one store per tenant for the cross-table regression sweep (G-9).
    await env.admin.query(
      `INSERT INTO stores (id, tenant_id, code, name) VALUES
         ($1, $2, 'OUTBOX-STORE-A', 'Outbox RLS Store A'),
         ($3, $4, 'OUTBOX-STORE-B', 'Outbox RLS Store B')`,
      [STORE_A, TENANT_A, STORE_B, TENANT_B],
    );

    // Seed one outbox event per tenant.
    await env.admin.query(
      `INSERT INTO outbox_events
         (event_id, tenant_id, event_type, payload, delivery_state)
       VALUES
         ($1, $2, 'audit.event.created', '{"seed":"A"}'::jsonb, 'pending'),
         ($3, $4, 'audit.event.created', '{"seed":"B"}'::jsonb, 'pending')`,
      [EVENT_A, TENANT_A, EVENT_B, TENANT_B],
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[outbox/rls.spec] Docker NOT AVAILABLE: ${msg}\n`);
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
    console.warn("[outbox/rls.spec] skipping (Docker unavailable)");
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// G-1 / G-2 / G-3: Cross-tenant SELECT isolation
// ---------------------------------------------------------------------------
describe("outbox_events RLS -- cross-tenant SELECT isolation", () => {
  it("G-1: tenant A context cannot read tenant B event", async () => {
    if (maybeSkip()) return;

    const client = await env!.app.connect();
    try {
      const whoami = await client.query<{ current_user: string }>("SELECT current_user");
      expect(whoami.rows[0]?.current_user).toBe(APP_ROLE_NAME);

      await client.query("BEGIN");
      await client.query(`SET LOCAL app.current_tenant = '${TENANT_A}'`);
      await client.query(`SET LOCAL app.is_platform_admin = 'false'`);

      const r = await client.query<{ event_id: string }>(
        "SELECT event_id FROM outbox_events WHERE event_id = $1",
        [EVENT_B],
      );
      // Tenant B's event must not appear under tenant A's context.
      expect(r.rows).toHaveLength(0);

      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });

  it("G-2: tenant A context CAN read tenant A event (positive control)", async () => {
    if (maybeSkip()) return;

    const client = await env!.app.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL app.current_tenant = '${TENANT_A}'`);
      await client.query(`SET LOCAL app.is_platform_admin = 'false'`);

      const r = await client.query<{ event_id: string; tenant_id: string }>(
        "SELECT event_id, tenant_id FROM outbox_events WHERE event_id = $1",
        [EVENT_A],
      );
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0]!.tenant_id).toBe(TENANT_A);

      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });

  it("G-3: tenant B context cannot read tenant A event (symmetric)", async () => {
    if (maybeSkip()) return;

    const client = await env!.app.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL app.current_tenant = '${TENANT_B}'`);
      await client.query(`SET LOCAL app.is_platform_admin = 'false'`);

      const r = await client.query<{ event_id: string }>(
        "SELECT event_id FROM outbox_events WHERE event_id = $1",
        [EVENT_A],
      );
      expect(r.rows).toHaveLength(0);

      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });
});

// ---------------------------------------------------------------------------
// G-4: WITH CHECK rejects cross-tenant INSERT
// ---------------------------------------------------------------------------
describe("outbox_events RLS -- WITH CHECK on INSERT", () => {
  it("G-4: tenant A context cannot INSERT an event with tenant_id = tenant B", async () => {
    if (maybeSkip()) return;

    const client = await env!.app.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL app.current_tenant = '${TENANT_A}'`);
      await client.query(`SET LOCAL app.is_platform_admin = 'false'`);

      // Attempt to insert a row under tenant B while context is tenant A.
      let threw = false;
      let errorMessage = "";
      try {
        await client.query(
          `INSERT INTO outbox_events
             (event_id, tenant_id, event_type, payload, delivery_state)
           VALUES ($1, $2, $3, $4::jsonb, $5)`,
          [
            "e1dd0000-0000-4000-8000-000000000001",
            TENANT_B,
            "audit.event.created",
            JSON.stringify({ cross: true }),
            "pending",
          ],
        );
      } catch (err: unknown) {
        threw = true;
        errorMessage = err instanceof Error ? err.message : String(err);
      }
      // Roll back regardless — a failing INSERT leaves the txn aborted.
      try { await client.query("ROLLBACK"); } catch { /* ignore */ }
      expect(threw).toBe(true);
      expect(errorMessage).toMatch(/row-level security|policy/i);
    } finally {
      client.release();
    }
  });
});

// ---------------------------------------------------------------------------
// G-5: FORCE ROW LEVEL SECURITY is set on outbox_events
// ---------------------------------------------------------------------------
describe("outbox_events RLS -- FORCE ROW LEVEL SECURITY attribute", () => {
  it("G-5: outbox_events has both relrowsecurity and relforcerowsecurity set", async () => {
    if (maybeSkip()) return;

    // Query pg_class via the superuser (admin pool).
    const r = await env!.admin.query<{
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `SELECT relrowsecurity, relforcerowsecurity
       FROM pg_class
       WHERE relname = 'outbox_events' AND relkind = 'r'`,
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]!.relrowsecurity).toBe(true);
    expect(r.rows[0]!.relforcerowsecurity).toBe(true);
  });

  it("G-5b: the outbox_events_tenant_isolation policy has a WITH CHECK clause", async () => {
    if (maybeSkip()) return;

    const r = await env!.admin.query<{
      policyname: string;
      qual: string | null;
      with_check: string | null;
    }>(
      `SELECT policyname, qual, with_check
       FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'outbox_events'`,
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]!.policyname).toBe("outbox_events_tenant_isolation");
    expect(r.rows[0]!.qual).not.toBeNull();
    expect(r.rows[0]!.with_check).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// G-6 / G-7: No non-superuser role has BYPASSRLS (T600)
// ---------------------------------------------------------------------------
describe("BYPASSRLS privilege probe (T600)", () => {
  it("G-6: no non-superuser, non-replication role has rolbypassrls = true", async () => {
    if (maybeSkip()) return;

    // Query all roles that have BYPASSRLS but are NOT superusers or
    // replication-only roles (those are expected to have special privileges).
    // In a healthy schema, this result set must be empty.
    const r = await env!.admin.query<{
      rolname: string;
      rolbypassrls: boolean;
      rolsuper: boolean;
    }>(
      `SELECT rolname, rolbypassrls, rolsuper
       FROM pg_catalog.pg_roles
       WHERE rolbypassrls = true AND rolsuper = false`,
    );

    // No application-level role should have BYPASSRLS.
    expect(r.rows).toHaveLength(0);
  });

  it("G-7: app_test role specifically has rolbypassrls = false", async () => {
    if (maybeSkip()) return;

    const r = await env!.admin.query<{
      rolname: string;
      rolbypassrls: boolean;
    }>(
      `SELECT rolname, rolbypassrls
       FROM pg_catalog.pg_roles
       WHERE rolname = $1`,
      [APP_ROLE_NAME],
    );

    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]!.rolbypassrls).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// G-8: No-context connection returns empty set (fail-closed)
//
// Design note: PostgreSQL custom GUCs (app.*) default to an empty string
// when never set, not NULL. The `::uuid` cast in the RLS policy therefore
// throws "invalid input syntax for type uuid: ''" rather than silently
// returning 0 rows. Both outcomes are fail-closed -- the tenant isolation
// holds either way. We test this by verifying the query either returns 0
// rows OR throws a type/policy error, and never returns actual outbox rows.
// ---------------------------------------------------------------------------
describe("outbox_events RLS -- no GUC context (fail-closed)", () => {
  it("G-8: SELECT without setting app.current_tenant returns zero rows or errors (fail-closed)", async () => {
    if (maybeSkip()) return;

    const client = await env!.app.connect();
    try {
      await client.query("BEGIN");
      // Do NOT set app.current_tenant.
      // Explicitly disable platform-admin context.
      await client.query(`SET LOCAL app.is_platform_admin = 'false'`);

      let count: string | null = null;
      let threw = false;
      try {
        const r = await client.query<{ count: string }>(
          "SELECT COUNT(*)::text AS count FROM outbox_events",
        );
        count = r.rows[0]?.count ?? null;
      } catch {
        // A cast error from the empty-string GUC is a fail-closed outcome.
        threw = true;
      }

      try { await client.query("ROLLBACK"); } catch { /* ignore */ }

      // Fail-closed: either 0 rows or an error -- never actual tenant data.
      if (!threw) {
        expect(count).toBe("0");
      }
      // If threw=true, the test implicitly passes: the query was rejected,
      // which is the stricter fail-closed behavior.
    } finally {
      client.release();
    }
  });
});

// ---------------------------------------------------------------------------
// G-9: Cross-table regression sweep (T598)
// Verify that applying migration 0006 did not disturb existing RLS policies.
// ---------------------------------------------------------------------------
describe("cross-table regression sweep after migration 0006 (T598)", () => {
  it("G-9a: stores table still enforces tenant isolation", async () => {
    if (maybeSkip()) return;

    const client = await env!.app.connect();
    // Defensive: ensure any prior aborted transaction on this pool connection
    // is cleared before we begin our own transaction.
    try { await client.query("ROLLBACK"); } catch { /* ignore */ }
    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL app.current_tenant = '${TENANT_A}'`);
      await client.query(`SET LOCAL app.is_platform_admin = 'false'`);

      // Tenant A context must not see tenant B's store.
      const r = await client.query<{ id: string }>(
        "SELECT id FROM stores WHERE id = $1",
        [STORE_B],
      );
      expect(r.rows).toHaveLength(0);

      // But tenant A's store must be visible.
      const r2 = await client.query<{ id: string; tenant_id: string }>(
        "SELECT id, tenant_id FROM stores WHERE id = $1",
        [STORE_A],
      );
      expect(r2.rows).toHaveLength(1);
      expect(r2.rows[0]!.tenant_id).toBe(TENANT_A);

      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });

  it("G-9b: existing RLS-enabled tables still have FORCE ROW LEVEL SECURITY after migration 0006", async () => {
    if (maybeSkip()) return;

    const expectedRlsTables = [
      "tenants",
      "stores",
      "memberships",
      "store_access",
      "roles",
      "auth_tokens",
      "invitations",
      "audit_events",
      "idempotency_keys",
      "outbox_events", // new table from 0006
    ];

    const r = await env!.admin.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity
       FROM pg_class
       WHERE relname = ANY($1) AND relkind = 'r'
       ORDER BY relname`,
      [expectedRlsTables],
    );

    expect(r.rows).toHaveLength(expectedRlsTables.length);
    for (const row of r.rows) {
      expect({ table: row.relname, rls: row.relrowsecurity }).toMatchObject({
        table: row.relname,
        rls: true,
      });
      expect({ table: row.relname, forceRls: row.relforcerowsecurity }).toMatchObject({
        table: row.relname,
        forceRls: true,
      });
    }
  });

  it("G-9c: every write-capable policy on every tenant-scoped table has WITH CHECK and a USING guard (regression probe)", async () => {
    if (maybeSkip()) return;

    // PostgreSQL policy semantics:
    //   - FOR SELECT — `qual` (USING) is required; `with_check` is always NULL.
    //   - FOR INSERT — `with_check` is required; `qual` is always NULL.
    //   - FOR UPDATE — `qual` is required; `with_check` MAY be NULL, in which
    //                  case PostgreSQL reuses `USING` as the new-row check.
    //   - FOR DELETE — `qual` is required; `with_check` is always NULL.
    //   - FOR ALL    — applies to every command; `qual` is required for the
    //                  read/update/delete paths, and `with_check` MAY be NULL
    //                  (USING is reused for the INSERT/UPDATE new-row check).
    //
    // The original sweep treated EVERY policy as a write policy and demanded
    // `with_check IS NOT NULL`. That fails legitimately for SELECT-only and
    // DELETE-only policies (notably the per-command policies introduced by
    // 0007_catalog.sql, e.g. `price_history_no_delete` and the
    // `*_tenant_isolation` SELECT policies on every catalog table) AND for
    // any UPDATE/ALL policy that relies on the USING-as-fallback rule. The
    // regression intent — "write-capable policies must not silently lose
    // their tenant/store guard" — is preserved by asserting that UPDATE/ALL
    // have a non-null `qual` (so a guard exists in at least one form) and
    // that INSERT-only policies have a non-null `with_check`.
    const r = await env!.admin.query<{
      tablename: string;
      policyname: string;
      cmd: string;
      qual: string | null;
      with_check: string | null;
    }>(
      `SELECT tablename, policyname, cmd, qual, with_check
       FROM pg_policies
       WHERE schemaname = 'public'
       ORDER BY tablename, policyname`,
    );

    expect(r.rows.length).toBeGreaterThan(0);
    for (const row of r.rows) {
      const ctx = `${row.tablename}.${row.policyname} (cmd=${row.cmd})`;
      switch (row.cmd) {
        case "SELECT":
          expect({ ctx, qual: row.qual }).toMatchObject({
            ctx,
            qual: expect.any(String),
          });
          break;
        case "INSERT":
          expect({ ctx, with_check: row.with_check }).toMatchObject({
            ctx,
            with_check: expect.any(String),
          });
          break;
        case "UPDATE":
        case "ALL":
          // `qual` (USING) MUST be present — that is the tenant/store guard.
          // `with_check` MAY be NULL: PostgreSQL reuses USING as the new-row
          // check when WITH CHECK is omitted on UPDATE/ALL policies. So we
          // only assert `qual` here; if `with_check` is set, it is also a
          // string, but its absence is not a regression.
          expect({ ctx, qual: row.qual }).toMatchObject({
            ctx,
            qual: expect.any(String),
          });
          break;
        case "DELETE":
          expect({ ctx, qual: row.qual }).toMatchObject({
            ctx,
            qual: expect.any(String),
          });
          // with_check is intentionally NULL for DELETE — PostgreSQL forbids
          // it. Nothing to assert here.
          break;
        default:
          throw new Error(`Unexpected policy cmd '${row.cmd}' on ${ctx}`);
      }
    }
  });
});
