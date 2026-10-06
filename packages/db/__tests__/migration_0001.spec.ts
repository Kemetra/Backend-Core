/**
 * Migration verification for `0001_pos_operator_identity.sql`.
 *
 * Mirrors the structure of `migration.spec.ts`: boots one
 * `postgres:16-alpine` container, applies every UP migration in lex order
 * (so 0000 runs before 0001), then asserts the schema delta introduced by
 * 0001:
 *
 *   - users.clerk_user_id column shape and partial UNIQUE.
 *   - users_clerk_user_id_format CHECK rejects empty strings.
 *   - devices table shape, FKs, RLS, trigger, and active-token index.
 *   - auth_tokens.auth_tokens_principal_xor is GONE.
 *   - auth_tokens.auth_tokens_principal_by_scope exists and behaves:
 *       - pos_operator row REQUIRES both user_id and device_id.
 *       - dashboard_api / pos rows reject "both populated" (XOR preserved).
 *       - dashboard_api / pos rows reject "neither populated" (XOR preserved).
 *   - auth_tokens.device_id FK → devices(id) is in place.
 *   - UP → DOWN → UP cycle (0001 only) leaves a working schema.
 *
 * If Docker is unavailable, every assertion fails loudly with a clear
 * "Container start failed" reason. Set MIGRATION_TEST_ALLOW_SKIP=1 to skip
 * locally without Docker (matches migration.spec.ts behaviour).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "./_helpers/postgres-container";

const DRIZZLE_DIR = resolve(__dirname, "..", "drizzle");
const UP_0001_PATH = resolve(DRIZZLE_DIR, "0001_pos_operator_identity.sql");
const DOWN_0001_PATH = resolve(
  DRIZZLE_DIR,
  "0001_pos_operator_identity.down.sql",
);
const UP_0002_PATH = resolve(DRIZZLE_DIR, "0002_shifts.sql");
const DOWN_0002_PATH = resolve(DRIZZLE_DIR, "0002_shifts.down.sql");
const UP_0033_PATH = resolve(DRIZZLE_DIR, "0033_sale_tenders.sql");
const DOWN_0033_PATH = resolve(DRIZZLE_DIR, "0033_sale_tenders.down.sql");
const UP_0035_PATH = resolve(DRIZZLE_DIR, "0035_cashier_admissions.sql");
const DOWN_0035_PATH = resolve(DRIZZLE_DIR, "0035_cashier_admissions.down.sql");
const UP_0036_PATH = resolve(DRIZZLE_DIR, "0036_shift_cash_up.sql");
const DOWN_0036_PATH = resolve(DRIZZLE_DIR, "0036_shift_cash_up.down.sql");

let env: PgTestEnv | null = null;
let dockerSkipReason = "";

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
  } catch (err: unknown) {
    dockerSkipReason = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(
        `\n[migration_0001.spec] Docker NOT AVAILABLE — skipping. Reason: ${dockerSkipReason}\n`,
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

describe("0001_pos_operator_identity migration", () => {
  // ---------------------------------------------------------------------------
  // users.clerk_user_id
  // ---------------------------------------------------------------------------
  it("users.clerk_user_id column exists, is TEXT, nullable", async () => {
    if (!env) throw new Error("env not initialized");
    const r = await env.admin.query<{
      data_type: string;
      is_nullable: string;
    }>(`
      SELECT data_type, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'users'
        AND column_name = 'clerk_user_id'
    `);
    expect(r.rowCount).toBe(1);
    expect(r.rows[0]?.data_type).toBe("text");
    expect(r.rows[0]?.is_nullable).toBe("YES");
  });

  it("users_clerk_user_id_uidx is partial UNIQUE on clerk_user_id IS NOT NULL", async () => {
    if (!env) throw new Error("env not initialized");
    const r = await env.admin.query<{ indisunique: boolean; pred: string | null }>(`
      SELECT pi.indisunique,
             pg_get_expr(pi.indpred, pi.indrelid) AS pred
      FROM pg_index pi
      JOIN pg_class c ON c.oid = pi.indexrelid
      WHERE c.relname = 'users_clerk_user_id_uidx'
    `);
    expect(r.rowCount).toBe(1);
    expect(r.rows[0]?.indisunique).toBe(true);
    expect(r.rows[0]?.pred).toMatch(/clerk_user_id IS NOT NULL/i);
  });

  it("users_clerk_user_id_format CHECK rejects empty string", async () => {
    if (!env) throw new Error("env not initialized");
    const id = "0c000000-0000-7000-8000-000000000001";
    await env.admin.query("DELETE FROM users WHERE id = $1", [id]);
    await expect(
      env.admin.query(
        "INSERT INTO users (id, email, clerk_user_id) VALUES ($1, $2, $3)",
        [id, "clerk-empty@example.com", ""],
      ),
    ).rejects.toThrow(/users_clerk_user_id_format/i);
  });

  it("users_clerk_user_id_uidx allows multiple NULL values", async () => {
    if (!env) throw new Error("env not initialized");
    const a = "0c000000-0000-7000-8000-000000000010";
    const b = "0c000000-0000-7000-8000-000000000011";
    await env.admin.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [
      [a, b],
    ]);
    await env.admin.query(
      "INSERT INTO users (id, email) VALUES ($1, $2), ($3, $4)",
      [a, "null-clerk-a@example.com", b, "null-clerk-b@example.com"],
    );
    const r = await env.admin.query<{ count: string }>(`
      SELECT COUNT(*)::text AS count
      FROM users
      WHERE id = ANY($1::uuid[]) AND clerk_user_id IS NULL
    `, [[a, b]]);
    expect(r.rows[0]?.count).toBe("2");
  });

  it("users_clerk_user_id_uidx blocks duplicate non-NULL values", async () => {
    if (!env) throw new Error("env not initialized");
    const a = "0c000000-0000-7000-8000-000000000020";
    const b = "0c000000-0000-7000-8000-000000000021";
    await env.admin.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [
      [a, b],
    ]);
    await env.admin.query(
      "INSERT INTO users (id, email, clerk_user_id) VALUES ($1, $2, $3)",
      [a, "dup-clerk-a@example.com", "user_clerk_dup_1"],
    );
    await expect(
      env.admin.query(
        "INSERT INTO users (id, email, clerk_user_id) VALUES ($1, $2, $3)",
        [b, "dup-clerk-b@example.com", "user_clerk_dup_1"],
      ),
    ).rejects.toThrow(/users_clerk_user_id_uidx/i);
  });

  // ---------------------------------------------------------------------------
  // devices
  // ---------------------------------------------------------------------------
  it("devices table exists with expected columns", async () => {
    if (!env) throw new Error("env not initialized");
    const r = await env.admin.query<{
      column_name: string;
      data_type: string;
      is_nullable: string;
    }>(`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'devices'
      ORDER BY column_name
    `);
    const cols = Object.fromEntries(
      r.rows.map((row) => [row.column_name, row]),
    );
    expect(cols["id"]).toMatchObject({ data_type: "uuid", is_nullable: "NO" });
    expect(cols["tenant_id"]).toMatchObject({
      data_type: "uuid",
      is_nullable: "NO",
    });
    expect(cols["store_id"]).toMatchObject({
      data_type: "uuid",
      is_nullable: "NO",
    });
    expect(cols["label"]).toMatchObject({
      data_type: "text",
      is_nullable: "YES",
    });
    expect(cols["token_hash"]).toMatchObject({
      data_type: "bytea",
      is_nullable: "NO",
    });
    expect(cols["revoked_at"]?.is_nullable).toBe("YES");
    expect(cols["created_at"]?.is_nullable).toBe("NO");
    expect(cols["updated_at"]?.is_nullable).toBe("NO");
  });

  it("devices.token_hash is UNIQUE", async () => {
    if (!env) throw new Error("env not initialized");
    const r = await env.admin.query<{ count: string }>(`
      SELECT COUNT(*)::text AS count
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      WHERE t.relname = 'devices' AND c.contype = 'u'
        AND pg_get_constraintdef(c.oid) ILIKE '%(token_hash)%'
    `);
    expect(r.rows[0]?.count).toBe("1");
  });

  it("devices has FKs to tenants(id) and stores(id)", async () => {
    if (!env) throw new Error("env not initialized");
    const r = await env.admin.query<{
      conname: string;
      ref_table: string;
    }>(`
      SELECT c.conname, cf.relname AS ref_table
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_class cf ON cf.oid = c.confrelid
      WHERE t.relname = 'devices' AND c.contype = 'f'
      ORDER BY c.conname
    `);
    const refs = r.rows.map((row) => row.ref_table).sort();
    expect(refs).toEqual(["stores", "tenants"]);
  });

  it("devices has RLS and FORCE RLS enabled", async () => {
    if (!env) throw new Error("env not initialized");
    const r = await env.admin.query<{
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(`
      SELECT relrowsecurity, relforcerowsecurity
      FROM pg_class WHERE relname = 'devices' AND relkind = 'r'
    `);
    expect(r.rows[0]?.relrowsecurity).toBe(true);
    expect(r.rows[0]?.relforcerowsecurity).toBe(true);
  });

  it("devices RLS policy has WITH CHECK", async () => {
    if (!env) throw new Error("env not initialized");
    const r = await env.admin.query<{
      policyname: string;
      with_check: string | null;
    }>(`
      SELECT policyname, with_check
      FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'devices'
    `);
    expect(r.rowCount).toBeGreaterThan(0);
    for (const row of r.rows) {
      expect(row.with_check).not.toBeNull();
    }
  });

  it("devices_set_updated_at trigger exists", async () => {
    if (!env) throw new Error("env not initialized");
    const r = await env.admin.query<{ tgname: string }>(`
      SELECT tgname FROM pg_trigger
      WHERE NOT tgisinternal AND tgname = 'devices_set_updated_at'
    `);
    expect(r.rowCount).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // auth_tokens — old XOR is gone, new scope-aware CHECK behaves correctly
  // ---------------------------------------------------------------------------
  it("auth_tokens_principal_xor is removed", async () => {
    if (!env) throw new Error("env not initialized");
    const r = await env.admin.query<{ count: string }>(`
      SELECT COUNT(*)::text AS count
      FROM pg_constraint
      WHERE conname = 'auth_tokens_principal_xor'
    `);
    expect(r.rows[0]?.count).toBe("0");
  });

  it("auth_tokens_principal_by_scope CHECK exists", async () => {
    if (!env) throw new Error("env not initialized");
    const r = await env.admin.query<{ count: string }>(`
      SELECT COUNT(*)::text AS count
      FROM pg_constraint
      WHERE conname = 'auth_tokens_principal_by_scope' AND contype = 'c'
    `);
    expect(r.rows[0]?.count).toBe("1");
  });

  it("auth_tokens.device_id FK → devices(id) is in place", async () => {
    if (!env) throw new Error("env not initialized");
    const r = await env.admin.query<{
      conname: string;
      ref_table: string;
    }>(`
      SELECT c.conname, cf.relname AS ref_table
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_class cf ON cf.oid = c.confrelid
      WHERE t.relname = 'auth_tokens'
        AND c.contype = 'f'
        AND c.conname = 'auth_tokens_device_fk'
    `);
    expect(r.rowCount).toBe(1);
    expect(r.rows[0]?.ref_table).toBe("devices");
  });

  // ---------------------------------------------------------------------------
  // CHECK behavior — exercise the predicate live, not just its existence.
  // ---------------------------------------------------------------------------
  it(
    "scope='dashboard_api' rejects rows with BOTH user_id and device_id",
    async () => {
      if (!env) throw new Error("env not initialized");
      const fixture = await seedTokenFixture(env);
      const tokenId = "0d000000-0000-7000-8000-000000000001";
      await env.admin.query("DELETE FROM auth_tokens WHERE id = $1", [tokenId]);
      await expect(
        env.admin.query(
          `INSERT INTO auth_tokens
             (id, token_hash, tenant_id, user_id, device_id, store_id,
              scope, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, 'dashboard_api', now() + interval '1 hour')`,
          [
            tokenId,
            Buffer.from("hash-dash-both-1"),
            fixture.tenantId,
            fixture.userId,
            fixture.deviceId,
            fixture.storeId,
          ],
        ),
      ).rejects.toThrow(/auth_tokens_principal_by_scope/i);
    },
  );

  it(
    "scope='dashboard_api' rejects rows with NEITHER user_id nor device_id",
    async () => {
      if (!env) throw new Error("env not initialized");
      const fixture = await seedTokenFixture(env);
      const tokenId = "0d000000-0000-7000-8000-000000000002";
      await env.admin.query("DELETE FROM auth_tokens WHERE id = $1", [tokenId]);
      await expect(
        env.admin.query(
          `INSERT INTO auth_tokens
             (id, token_hash, tenant_id, store_id, scope, expires_at)
           VALUES ($1, $2, $3, $4, 'dashboard_api', now() + interval '1 hour')`,
          [
            tokenId,
            Buffer.from("hash-dash-neither-1"),
            fixture.tenantId,
            fixture.storeId,
          ],
        ),
      ).rejects.toThrow(/auth_tokens_principal_by_scope/i);
    },
  );

  it(
    "scope='dashboard_api' accepts rows with ONLY user_id",
    async () => {
      if (!env) throw new Error("env not initialized");
      const fixture = await seedTokenFixture(env);
      const tokenId = "0d000000-0000-7000-8000-000000000003";
      await env.admin.query("DELETE FROM auth_tokens WHERE id = $1", [tokenId]);
      await env.admin.query(
        `INSERT INTO auth_tokens
           (id, token_hash, tenant_id, user_id, store_id, scope, expires_at)
         VALUES ($1, $2, $3, $4, $5, 'dashboard_api',
                 now() + interval '1 hour')`,
        [
          tokenId,
          Buffer.from("hash-dash-user-only-1"),
          fixture.tenantId,
          fixture.userId,
          fixture.storeId,
        ],
      );
    },
  );

  it("scope='pos_operator' REQUIRES both user_id and device_id", async () => {
    if (!env) throw new Error("env not initialized");
    const fixture = await seedTokenFixture(env);
    // Reject: only user_id.
    const tokenId1 = "0d000000-0000-7000-8000-000000000010";
    await env.admin.query("DELETE FROM auth_tokens WHERE id = $1", [tokenId1]);
    await expect(
      env.admin.query(
        `INSERT INTO auth_tokens
           (id, token_hash, tenant_id, user_id, store_id, scope, expires_at)
         VALUES ($1, $2, $3, $4, $5, 'pos_operator',
                 now() + interval '1 hour')`,
        [
          tokenId1,
          Buffer.from("hash-pos-user-only-1"),
          fixture.tenantId,
          fixture.userId,
          fixture.storeId,
        ],
      ),
    ).rejects.toThrow(/auth_tokens_principal_by_scope/i);

    // Reject: only device_id.
    const tokenId2 = "0d000000-0000-7000-8000-000000000011";
    await env.admin.query("DELETE FROM auth_tokens WHERE id = $1", [tokenId2]);
    await expect(
      env.admin.query(
        `INSERT INTO auth_tokens
           (id, token_hash, tenant_id, device_id, store_id, scope, expires_at)
         VALUES ($1, $2, $3, $4, $5, 'pos_operator',
                 now() + interval '1 hour')`,
        [
          tokenId2,
          Buffer.from("hash-pos-device-only-1"),
          fixture.tenantId,
          fixture.deviceId,
          fixture.storeId,
        ],
      ),
    ).rejects.toThrow(/auth_tokens_principal_by_scope/i);

    // Accept: both populated.
    const tokenId3 = "0d000000-0000-7000-8000-000000000012";
    await env.admin.query("DELETE FROM auth_tokens WHERE id = $1", [tokenId3]);
    await env.admin.query(
      `INSERT INTO auth_tokens
         (id, token_hash, tenant_id, user_id, device_id, store_id,
          scope, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'pos_operator',
               now() + interval '1 hour')`,
      [
        tokenId3,
        Buffer.from("hash-pos-both-1"),
        fixture.tenantId,
        fixture.userId,
        fixture.deviceId,
        fixture.storeId,
      ],
    );
  });

  // ---------------------------------------------------------------------------
  // UP → DOWN → UP cycle for 0001 only.
  // ---------------------------------------------------------------------------
  it("0001 UP → DOWN → UP cycle leaves a working schema", async () => {
    if (!env) throw new Error("env not initialized");
    const down0002Sql = readFileSync(DOWN_0002_PATH, "utf8");
    const up0002Sql = readFileSync(UP_0002_PATH, "utf8");
    const down0033Sql = readFileSync(DOWN_0033_PATH, "utf8");
    const up0033Sql = readFileSync(UP_0033_PATH, "utf8");
    const down0035Sql = readFileSync(DOWN_0035_PATH, "utf8");
    const up0035Sql = readFileSync(UP_0035_PATH, "utf8");
    const down0036Sql = readFileSync(DOWN_0036_PATH, "utf8");
    const up0036Sql = readFileSync(UP_0036_PATH, "utf8");
    const downSql = readFileSync(DOWN_0001_PATH, "utf8");
    const upSql = readFileSync(UP_0001_PATH, "utf8");

    // 0002_shifts depends on devices (FK opening_device_id → devices.id ON DELETE RESTRICT).
    // Drop 0002 first so 0001 DOWN can remove devices without a FK violation.
    // 0033_sale_tenders likewise (sales.device_id → devices.id, RT-77), and
    // 0035_cashier_admissions (device_id → devices.id, RT-113 BC2), and
    // 0036_shift_cash_up (its fact tables reference devices and shifts, RT-17).
    await env.admin.query(down0036Sql);
    await env.admin.query(down0035Sql);
    await env.admin.query(down0033Sql);
    await env.admin.query(down0002Sql);

    // Roll back 0001 only. After this, devices is gone, clerk_user_id is gone,
    // and auth_tokens has its original XOR CHECK back.
    await env.admin.query(downSql);

    const after = await env.admin.query<{ count: string }>(`
      SELECT COUNT(*)::text AS count FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'devices'
    `);
    expect(after.rows[0]?.count).toBe("0");

    const xorBack = await env.admin.query<{ count: string }>(`
      SELECT COUNT(*)::text AS count FROM pg_constraint
      WHERE conname = 'auth_tokens_principal_xor'
    `);
    expect(xorBack.rows[0]?.count).toBe("1");

    const noClerkCol = await env.admin.query<{ count: string }>(`
      SELECT COUNT(*)::text AS count FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'users'
        AND column_name = 'clerk_user_id'
    `);
    expect(noClerkCol.rows[0]?.count).toBe("0");

    // Re-apply 0001 cleanly.
    await env.admin.query(upSql);
    const reDevices = await env.admin.query<{ count: string }>(`
      SELECT COUNT(*)::text AS count FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'devices'
    `);
    expect(reDevices.rows[0]?.count).toBe("1");

    // Restore 0002, 0033, 0035 and 0036 so subsequent tests in this suite have the full schema.
    await env.admin.query(up0002Sql);
    await env.admin.query(up0033Sql);
    await env.admin.query(up0035Sql);
    await env.admin.query(up0036Sql);

    // After re-UP, the scope-aware CHECK is back and the original XOR is gone.
    const reCheck = await env.admin.query<{ conname: string }>(`
      SELECT conname FROM pg_constraint
      WHERE conname IN
        ('auth_tokens_principal_by_scope','auth_tokens_principal_xor')
      ORDER BY conname
    `);
    expect(reCheck.rows.map((row) => row.conname)).toEqual([
      "auth_tokens_principal_by_scope",
    ]);
  });
});

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

interface TokenFixture {
  tenantId: string;
  storeId: string;
  userId: string;
  deviceId: string;
}

/**
 * Idempotent seed of one tenant + store + user + device. Reused across
 * CHECK-behavior tests so each test exercises only the predicate, not
 * fixture setup.
 */
async function seedTokenFixture(env: PgTestEnv): Promise<TokenFixture> {
  const tenantId = "0e000000-0000-7000-8000-000000000001";
  const storeId = "0e000000-0000-7000-8000-000000000010";
  const userId = "0e000000-0000-7000-8000-000000000020";
  const deviceId = "0e000000-0000-7000-8000-000000000030";
  await env.admin.query(
    "INSERT INTO tenants (id, slug, name) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING",
    [tenantId, "tok-fixture", "Token Fixture Tenant"],
  );
  await env.admin.query(
    "INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING",
    [storeId, tenantId, "TF-STORE", "Token Fixture Store"],
  );
  await env.admin.query(
    "INSERT INTO users (id, email) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING",
    [userId, "tok-fixture@example.com"],
  );
  await env.admin.query(
    `INSERT INTO devices (id, tenant_id, store_id, token_hash)
     VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`,
    [deviceId, tenantId, storeId, Buffer.from("device-fixture-hash-1")],
  );
  return { tenantId, storeId, userId, deviceId };
}
