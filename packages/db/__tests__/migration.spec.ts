/**
 * T063 — Migration verification.
 *
 * Boots one `postgres:16-alpine` container, applies UP, asserts schema
 * shape against information_schema / pg_catalog, then exercises one live
 * `updated_at` trigger and one minimal RLS smoke test using a non-superuser
 * role (the default Testcontainers user is the DB superuser, which bypasses
 * RLS).
 *
 * If Docker is unavailable, every assertion is skipped with a single clear
 * "Docker NOT AVAILABLE" report so CI without Docker stays honest.
 */
import {
  applyUpAndCreateAppRole,
  APP_ROLE_NAME,
  ensureAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "./_helpers/postgres-container";

const EXPECTED_TABLES = [
  "audit_events",
  "auth_tokens",
  "idempotency_keys",
  "invitations",
  "memberships",
  "permissions",
  "role_permissions",
  "roles",
  "sessions",
  "store_access",
  "stores",
  "tenants",
  "users",
];

const RLS_TABLES = [
  "tenants",
  "stores",
  "memberships",
  "store_access",
  "roles",
  "auth_tokens",
  "invitations",
  "audit_events",
  "idempotency_keys",
];

const NO_RLS_TABLES = ["users", "permissions", "role_permissions", "sessions"];

const EXPECTED_CHECKS = [
  "users_email_not_empty",
  "tenants_slug_format",
  "tenants_status_valid",
  "roles_code_format",
  "memberships_store_access_kind_valid",
  "auth_tokens_principal_xor",
  "sessions_active_store_implies_tenant",
  "invitations_status_valid",
  "invitations_kind_valid",
];

const EXPECTED_TRIGGERS = [
  "users_set_updated_at",
  "tenants_set_updated_at",
  "stores_set_updated_at",
  "roles_set_updated_at",
  "memberships_set_updated_at",
  "invitations_set_updated_at",
];

let env: PgTestEnv | null = null;
let dockerAvailable = false;
let dockerSkipReason = "";

beforeAll(async () => {
  // First-time runs print the reason loudly. We treat container-start
  // failure as a test failure (not a silent skip) so CI surfaces it.
  // Set MIGRATION_TEST_ALLOW_SKIP=1 to fall back to skip behaviour for
  // local dev without Docker.
  try {
    env = await startPgEnv();
    await applyUpAndCreateAppRole(env);
    dockerAvailable = true;
  } catch (err: unknown) {
    dockerSkipReason = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(
        `\n[migration.spec] Docker NOT AVAILABLE — skipping. Reason: ${dockerSkipReason}\n`,
      );
      return;
    }
    throw new Error(
      `Container start failed: ${dockerSkipReason}\n${err instanceof Error && err.stack ? err.stack : ""}`,
    );
  }
}, 180_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

// Tests below run unconditionally. If Docker is unavailable, beforeAll
// throws and all tests in the suite fail with a clear reason — that is the
// honest signal to surface "Docker validation NOT RUN" rather than silently
// passing skipped suites.

describe("0000_initial migration", () => {
  // ---------------------------------------------------------------------------
  // Tables
  // ---------------------------------------------------------------------------
  it("creates all 13 expected tables", async () => {
    if (!env) throw new Error("env not initialized");
    const r = await env.admin.query<{ table_name: string }>(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `);
    const names = r.rows.map((row) => row.table_name);
    for (const expected of EXPECTED_TABLES) {
      expect(names).toContain(expected);
    }
  });

  // ---------------------------------------------------------------------------
  // Foreign keys (composite-FK enforcement of I-3)
  // ---------------------------------------------------------------------------
  it(
    "store_access has composite FKs to memberships(tenant_id, id) and stores(tenant_id, id)",
    async () => {
      if (!env) throw new Error("env not initialized");
      // Use pg_constraint + pg_attribute directly — information_schema views
      // can't preserve composite-FK column order across the necessary joins
      // without complex window functions. pg_constraint stores conkey/confkey
      // as int2[] aligned to conrelid/confrelid attnums.
      const r = await env.admin.query<{
        conname: string;
        ref_table: string;
        cols: string;
        ref_cols: string;
      }>(`
      SELECT
        c.conname,
        cf.relname AS ref_table,
        (
          SELECT string_agg(a.attname, ',' ORDER BY ord)
          FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
          JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
        ) AS cols,
        (
          SELECT string_agg(a.attname, ',' ORDER BY ord)
          FROM unnest(c.confkey) WITH ORDINALITY AS k(attnum, ord)
          JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum
        ) AS ref_cols
      FROM pg_constraint c
      JOIN pg_class cf ON cf.oid = c.confrelid
      WHERE c.conname LIKE 'store_access_%_fk'
      ORDER BY c.conname
    `);
      const byName = Object.fromEntries(
        r.rows.map((row) => [row.conname, row]),
      );
      expect(byName["store_access_membership_fk"]).toMatchObject({
        ref_table: "memberships",
        cols: "tenant_id,membership_id",
        ref_cols: "tenant_id,id",
      });
      expect(byName["store_access_store_fk"]).toMatchObject({
        ref_table: "stores",
        cols: "tenant_id,store_id",
        ref_cols: "tenant_id,id",
      });
    },
  );

  it(
    "memberships has composite FK to roles(tenant_id, id)",
    async () => {
      if (!env) throw new Error("env not initialized");
      const r = await env.admin.query<{ count: string }>(`
      SELECT COUNT(*)::text AS count FROM information_schema.referential_constraints
      WHERE constraint_name = 'memberships_role_tenant_fk'
    `);
      expect(r.rows[0]?.count).toBe("1");
    },
  );

  // ---------------------------------------------------------------------------
  // CHECK constraints
  // ---------------------------------------------------------------------------
  it("creates expected CHECK constraints", async () => {
    if (!env) throw new Error("env not initialized");
    const r = await env.admin.query<{ conname: string }>(`
      SELECT conname FROM pg_constraint WHERE contype = 'c' ORDER BY conname
    `);
    const names = r.rows.map((row) => row.conname);
    for (const expected of EXPECTED_CHECKS) {
      expect(names).toContain(expected);
    }
  });

  // ---------------------------------------------------------------------------
  // RLS state
  // ---------------------------------------------------------------------------
  it(
    "RLS and FORCE RLS are enabled on every tenant-scoped table",
    async () => {
      if (!env) throw new Error("env not initialized");
      const r = await env.admin.query<{
        relname: string;
        relrowsecurity: boolean;
        relforcerowsecurity: boolean;
      }>(`
      SELECT relname, relrowsecurity, relforcerowsecurity
      FROM pg_class
      WHERE relname = ANY($1) AND relkind = 'r'
      ORDER BY relname
    `, [RLS_TABLES]);
      expect(r.rows).toHaveLength(RLS_TABLES.length);
      for (const row of r.rows) {
        expect(row.relrowsecurity).toBe(true);
        expect(row.relforcerowsecurity).toBe(true);
      }
    },
  );

  it(
    "tables that should NOT have RLS in fact have it disabled",
    async () => {
      if (!env) throw new Error("env not initialized");
      const r = await env.admin.query<{
        relname: string;
        relrowsecurity: boolean;
      }>(`
      SELECT relname, relrowsecurity
      FROM pg_class
      WHERE relname = ANY($1) AND relkind = 'r'
      ORDER BY relname
    `, [NO_RLS_TABLES]);
      for (const row of r.rows) {
        expect(row.relrowsecurity).toBe(false);
      }
    },
  );

  it("every RLS policy has WITH CHECK", async () => {
    if (!env) throw new Error("env not initialized");
    const r = await env.admin.query<{
      tablename: string;
      policyname: string;
      with_check: string | null;
    }>(`
      SELECT tablename, policyname, with_check
      FROM pg_policies
      WHERE schemaname = 'public'
      ORDER BY tablename, policyname
    `);
    expect(r.rows.length).toBeGreaterThan(0);
    for (const row of r.rows) {
      expect(row.with_check).not.toBeNull();
    }
  });

  // ---------------------------------------------------------------------------
  // NULLS NOT DISTINCT unique indexes
  // ---------------------------------------------------------------------------
  it(
    "roles_tenant_code_uidx is NULLS NOT DISTINCT",
    async () => {
      if (!env) throw new Error("env not initialized");
      const r = await env.admin.query<{ indnullsnotdistinct: boolean }>(`
      SELECT pi.indnullsnotdistinct
      FROM pg_index pi
      JOIN pg_class c ON c.oid = pi.indexrelid
      WHERE c.relname = 'roles_tenant_code_uidx'
    `);
      expect(r.rows[0]?.indnullsnotdistinct).toBe(true);
    },
  );

  it(
    "idempotency_keys_scope_uidx is NULLS NOT DISTINCT",
    async () => {
      if (!env) throw new Error("env not initialized");
      const r = await env.admin.query<{ indnullsnotdistinct: boolean }>(`
      SELECT pi.indnullsnotdistinct
      FROM pg_index pi
      JOIN pg_class c ON c.oid = pi.indexrelid
      WHERE c.relname = 'idempotency_keys_scope_uidx'
    `);
      expect(r.rows[0]?.indnullsnotdistinct).toBe(true);
    },
  );

  // ---------------------------------------------------------------------------
  // updated_at trigger metadata
  // ---------------------------------------------------------------------------
  it("expected updated_at triggers exist", async () => {
    if (!env) throw new Error("env not initialized");
    const r = await env.admin.query<{ tgname: string }>(`
      SELECT tgname FROM pg_trigger
      WHERE NOT tgisinternal AND tgname LIKE '%_set_updated_at'
      ORDER BY tgname
    `);
    const names = r.rows.map((row) => row.tgname);
    for (const expected of EXPECTED_TRIGGERS) {
      expect(names).toContain(expected);
    }
  });

  // ---------------------------------------------------------------------------
  // updated_at trigger functional firing (live)
  // ---------------------------------------------------------------------------
  it("tenants.updated_at trigger actually fires on UPDATE", async () => {
    if (!env) throw new Error("env not initialized");
    const tenantId = "01000000-0000-7000-8000-000000000001";
    await env.admin.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
    await env.admin.query(
      "INSERT INTO tenants (id, slug, name) VALUES ($1, $2, $3)",
      [tenantId, "trigger-fire-test", "Trigger Fire Test"],
    );
    const before = await env.admin.query<{
      created_at: string;
      updated_at: string;
    }>(
      "SELECT created_at, updated_at FROM tenants WHERE id = $1",
      [tenantId],
    );
    expect(before.rowCount).toBe(1);

    // Postgres `now()` is wall-clock; sleep so the trigger's now() advances.
    await env.admin.query("SELECT pg_sleep(0.05)");
    await env.admin.query(
      "UPDATE tenants SET name = $1 WHERE id = $2",
      ["Trigger Fire Test (renamed)", tenantId],
    );
    const after = await env.admin.query<{
      created_at: string;
      updated_at: string;
    }>(
      "SELECT created_at, updated_at FROM tenants WHERE id = $1",
      [tenantId],
    );
    expect(new Date(after.rows[0]!.updated_at).getTime()).toBeGreaterThan(
      new Date(before.rows[0]!.updated_at).getTime(),
    );
    // created_at should NOT change. pg returns Dates, so compare timestamps.
    expect(new Date(after.rows[0]!.created_at).getTime()).toBe(
      new Date(before.rows[0]!.created_at).getTime(),
    );
  });

  // ---------------------------------------------------------------------------
  // RLS functional smoke (non-superuser app role)
  // ---------------------------------------------------------------------------
  it(
    "RLS WITH CHECK rejects cross-tenant INSERT from app role",
    async () => {
      if (!env) throw new Error("env not initialized");
      // Two tenant rows pre-seeded as superuser (RLS bypassed for setup).
      const tenantA = "0a000000-0000-7000-8000-000000000001";
      const tenantB = "0b000000-0000-7000-8000-000000000001";
      await env.admin.query(
        "INSERT INTO tenants (id, slug, name) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
        [tenantA, "rls-tenant-a", "RLS Tenant A"],
      );
      await env.admin.query(
        "INSERT INTO tenants (id, slug, name) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
        [tenantB, "rls-tenant-b", "RLS Tenant B"],
      );

      // SET LOCAL only persists within a single transaction, and a Pool may
      // hand each query a different connection. Acquire one dedicated client
      // and run the whole RLS scenario inside one BEGIN/COMMIT block.
      const client = await env.app.connect();
      try {
        const appCheck = await client.query<{ current_user: string }>(
          "SELECT current_user",
        );
        expect(appCheck.rows[0]?.current_user).toBe(APP_ROLE_NAME);

        await client.query("BEGIN");
        await client.query(`SET LOCAL app.current_tenant = '${tenantA}'`);

        // Positive path: insert a store under tenantA — should succeed.
        const storeIdA = "0a000000-0000-7000-8000-000000000010";
        await client.query(
          "INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $2, $3, $4)",
          [storeIdA, tenantA, "STORE-A", "Store A"],
        );
        const visible = await client.query<{ id: string }>(
          "SELECT id FROM stores WHERE tenant_id = $1",
          [tenantA],
        );
        expect(visible.rows.map((r) => r.id)).toContain(storeIdA);

        // Negative path: WITH CHECK rejects INSERT under tenantB while GUC is A.
        await expect(
          client.query(
            "INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $2, $3, $4)",
            [
              "0b000000-0000-7000-8000-000000000010",
              tenantB,
              "STORE-B",
              "Store B",
            ],
          ),
        ).rejects.toThrow(/row-level security|policy/i);

        // The aborted INSERT puts the transaction into "current transaction
        // is aborted" state — we just roll back since we don't need the row.
        await client.query("ROLLBACK");
      } finally {
        client.release();
      }
    },
  );

  // ---------------------------------------------------------------------------
  // Cycle: UP → DOWN → UP
  // ---------------------------------------------------------------------------
  it("UP → DOWN → UP cycle leaves a working schema", async () => {
    if (!env) throw new Error("env not initialized");
    await env.admin.query(env.downSql);

    // After DOWN, the public schema should have no foundation tables.
    const after = await env.admin.query<{ count: string }>(`
      SELECT COUNT(*)::text AS count FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ANY($1)
    `, [EXPECTED_TABLES]);
    expect(after.rows[0]?.count).toBe("0");

    // Re-apply UP cleanly.
    await env.admin.query(env.upSql);
    const re = await env.admin.query<{ count: string }>(`
      SELECT COUNT(*)::text AS count FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ANY($1)
    `, [EXPECTED_TABLES]);
    expect(re.rows[0]?.count).toBe(String(EXPECTED_TABLES.length));

    // Re-apply ensureAppRole because we'll need privileges for any subsequent
    // tests in this file (none today, but keeps the suite hermetic).
    await ensureAppRole(env);
  });
});
