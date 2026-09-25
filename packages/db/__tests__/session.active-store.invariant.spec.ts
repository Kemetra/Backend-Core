/**
 * T176 — Invariant I-4: sessions.active_store_id belongs to sessions.active_tenant_id.
 *
 * Proves the BEFORE INSERT OR UPDATE trigger `sessions_active_store_tenant_check`
 * (installed in 0003_session_active_store_tenant_invariant.sql) enforces I-4:
 *
 *   If active_store_id IS NOT NULL AND active_tenant_id IS NOT NULL
 *   then the store's tenant_id MUST equal active_tenant_id.
 *
 * Scenarios:
 *   1. Happy path      — store belongs to tenant → INSERT succeeds.
 *   2. Cross-tenant    — store belongs to TENANT_B, active_tenant_id=TENANT_A
 *                        → trigger raises SQLSTATE 23514.
 *   3. NULL store      — active_tenant_id set, active_store_id NULL → succeeds.
 *   4. NULL both       — both NULL → succeeds.
 *   5. FK SET NULL (store delete)  — deleting the active store NULLs
 *                        active_store_id while preserving active_tenant_id.
 *   6. FK SET NULL (tenant delete) — after clearing the store, deleting the
 *                        tenant NULLs active_tenant_id; trigger does not fire.
 *
 * UUID prefix "6" — no collision with other __tests__ fixture prefixes.
 */

import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "./_helpers/postgres-container";

// ---------------------------------------------------------------------------
// Fixture IDs — prefix "6"
// ---------------------------------------------------------------------------

const TENANT_A = "61000000-1000-4000-8000-000000000001";
const TENANT_B = "62000000-2000-4000-8000-000000000002";
const USER_A   = "63000000-3000-4000-8000-000000000003";
const STORE_A  = "64000000-4000-4000-8000-000000000004"; // belongs to TENANT_A
const STORE_B  = "65000000-5000-4000-8000-000000000005"; // belongs to TENANT_B

// Scenario 5 — dedicated store + session; both are deleted during the test
const STORE_CASCADE         = "66000000-6000-4000-8000-000000000006"; // belongs to TENANT_A
const SESSION_CASCADE_STORE = "67000000-7000-4000-8000-000000000007";

// Scenario 6 — dedicated tenant + store + session
const TENANT_CASCADE          = "68000000-8000-4000-8000-000000000008";
const STORE_CASCADE_TENANT    = "69000000-9000-4000-8000-000000000009"; // belongs to TENANT_CASCADE
const SESSION_CASCADE_TENANT  = "6a000000-a000-4000-8000-00000000000a";

// Reused session ID for rollback-based tryInsert tests (scenarios 1–4)
const SESSION_TRY = "6b000000-b000-4000-8000-00000000000b";

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

let env: PgTestEnv | null = null;
let dockerSkipped = false;

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    await seedBase();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[session.active-store.invariant.spec] Docker NOT AVAILABLE: ${msg}\n`);
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
    console.warn("[session.active-store.invariant.spec] skipping (Docker unavailable)");
    return true;
  }
  return false;
}

async function seedBase(): Promise<void> {
  const pg = env!.admin;

  await pg.query(
    `INSERT INTO tenants (id, slug, name) VALUES
       ($1, 'inv-ses-ten-a', 'Session Inv Tenant A'),
       ($2, 'inv-ses-ten-b', 'Session Inv Tenant B'),
       ($3, 'inv-ses-ten-c', 'Session Inv Tenant C')`,
    [TENANT_A, TENANT_B, TENANT_CASCADE],
  );

  await pg.query(
    `INSERT INTO users (id, email, password_hash) VALUES
       ($1, 'user-a@ses-inv.test', 'x')`,
    [USER_A],
  );

  await pg.query(
    `INSERT INTO stores (id, tenant_id, code, name) VALUES
       ($1, $2, 'inv-sto-a',  'Session Inv Store A'),
       ($3, $4, 'inv-sto-b',  'Session Inv Store B'),
       ($5, $6, 'inv-sto-c',  'Session Inv Store Cascade'),
       ($7, $8, 'inv-sto-ct', 'Session Inv Store Cascade Tenant')`,
    [STORE_A, TENANT_A, STORE_B, TENANT_B, STORE_CASCADE, TENANT_A, STORE_CASCADE_TENANT, TENANT_CASCADE],
  );

  // Sessions used by scenarios 5 and 6 (committed, not rolled back)
  await pg.query(
    `INSERT INTO sessions (id, user_id, active_tenant_id, active_store_id, absolute_expires_at, credential_hash)
     VALUES
       ($1, $2, $3, $4, NOW() + INTERVAL '1 hour', decode(md5($1::text), 'hex') || decode(md5($1::text || ':h'), 'hex')),
       ($5, $6, $7, $8, NOW() + INTERVAL '1 hour', decode(md5($5::text), 'hex') || decode(md5($5::text || ':h'), 'hex'))`,
    [
      SESSION_CASCADE_STORE,  USER_A, TENANT_A,         STORE_CASCADE,
      SESSION_CASCADE_TENANT, USER_A, TENANT_CASCADE,   STORE_CASCADE_TENANT,
    ],
  );
}

// ---------------------------------------------------------------------------
// Helper: attempt a sessions INSERT with the given pair and return the
// Postgres error code on failure, or null on success.
// Each call uses BEGIN/ROLLBACK so shared fixture state is never polluted.
// ---------------------------------------------------------------------------
async function tryInsertSession(
  activeTenantId: string | null,
  activeStoreId:  string | null,
): Promise<string | null> {
  const client = await env!.admin.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO sessions (id, user_id, active_tenant_id, active_store_id, absolute_expires_at, credential_hash)
       VALUES ($1, $2, $3, $4, NOW() + INTERVAL '1 hour', decode(md5($1::text), 'hex') || decode(md5($1::text || ':h'), 'hex'))`,
      [SESSION_TRY, USER_A, activeTenantId, activeStoreId],
    );
    await client.query("ROLLBACK");
    return null;
  } catch (err: unknown) {
    await client.query("ROLLBACK").catch(() => undefined);
    const e = err as { code?: string };
    return e.code ?? "UNKNOWN";
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Scenario 1 — Happy path
// ---------------------------------------------------------------------------

describe("sessions I-4 invariant — happy path", () => {
  it("inserts a session when active_store_id and active_tenant_id are consistent", async () => {
    if (maybeSkip()) return;
    const code = await tryInsertSession(TENANT_A, STORE_A);
    expect(code).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Scenario 2 — Cross-tenant store
// active_tenant_id=TENANT_A, active_store_id belongs to TENANT_B
// → trigger raises SQLSTATE 23514
// ---------------------------------------------------------------------------

describe("sessions I-4 invariant — cross-tenant store", () => {
  it("rejects INSERT when active_store_id belongs to a different tenant (23514)", async () => {
    if (maybeSkip()) return;
    const code = await tryInsertSession(TENANT_A, STORE_B);
    expect(code).toBe("23514");
  });
});

// ---------------------------------------------------------------------------
// Scenario 3 — NULL active_store_id
// Trigger short-circuits: active_store_id IS NULL → RETURN NEW
// ---------------------------------------------------------------------------

describe("sessions I-4 invariant — null active_store_id", () => {
  it("inserts successfully when active_store_id is NULL (trigger short-circuits)", async () => {
    if (maybeSkip()) return;
    const code = await tryInsertSession(TENANT_A, null);
    expect(code).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Scenario 4 — Both NULL
// ---------------------------------------------------------------------------

describe("sessions I-4 invariant — both null", () => {
  it("inserts successfully when both active_tenant_id and active_store_id are NULL", async () => {
    if (maybeSkip()) return;
    const code = await tryInsertSession(null, null);
    expect(code).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Scenario 5 — FK SET NULL on store delete
// Deleting the active store must null active_store_id while preserving
// active_tenant_id. The trigger must not fire on the SET-NULL UPDATE
// (active_store_id becomes NULL → trigger short-circuits).
// ---------------------------------------------------------------------------

describe("sessions I-4 invariant — FK SET NULL on store delete", () => {
  it("nulls active_store_id and preserves active_tenant_id when the active store is deleted", async () => {
    if (maybeSkip()) return;
    const pg = env!.admin;

    type Row = { active_store_id: string | null; active_tenant_id: string | null };

    const before = await pg.query<Row>(
      `SELECT active_store_id, active_tenant_id FROM sessions WHERE id = $1`,
      [SESSION_CASCADE_STORE],
    );
    expect(before.rows[0]?.active_store_id).toBe(STORE_CASCADE);
    expect(before.rows[0]?.active_tenant_id).toBe(TENANT_A);

    await pg.query(`DELETE FROM stores WHERE id = $1`, [STORE_CASCADE]);

    const after = await pg.query<Row>(
      `SELECT active_store_id, active_tenant_id FROM sessions WHERE id = $1`,
      [SESSION_CASCADE_STORE],
    );
    expect(after.rows[0]?.active_store_id).toBeNull();
    expect(after.rows[0]?.active_tenant_id).toBe(TENANT_A);
  });
});

// ---------------------------------------------------------------------------
// Scenario 6 — FK SET NULL on tenant delete
// First delete the store (removes the RESTRICT FK from stores → tenants),
// which triggers SET NULL on active_store_id. Then delete the tenant,
// which triggers SET NULL on active_tenant_id.
// The trigger must not fire on either SET-NULL UPDATE: after the store
// delete active_store_id IS NULL (trigger short-circuits); after that,
// active_store_id IS NULL again (same short-circuit).
// ---------------------------------------------------------------------------

describe("sessions I-4 invariant — FK SET NULL on tenant delete", () => {
  it("nulls both active fields when store then tenant are deleted; trigger does not fire", async () => {
    if (maybeSkip()) return;
    const pg = env!.admin;

    type Row = { active_store_id: string | null; active_tenant_id: string | null };

    // Delete the store first: removes the RESTRICT constraint (stores → tenants)
    // and triggers SET NULL on active_store_id.
    await pg.query(`DELETE FROM stores WHERE id = $1`, [STORE_CASCADE_TENANT]);

    const mid = await pg.query<Row>(
      `SELECT active_store_id, active_tenant_id FROM sessions WHERE id = $1`,
      [SESSION_CASCADE_TENANT],
    );
    expect(mid.rows[0]?.active_store_id).toBeNull();
    expect(mid.rows[0]?.active_tenant_id).toBe(TENANT_CASCADE);

    // Delete the tenant: triggers SET NULL on active_tenant_id.
    // Trigger short-circuits because active_store_id IS NULL.
    await pg.query(`DELETE FROM tenants WHERE id = $1`, [TENANT_CASCADE]);

    const after = await pg.query<Row>(
      `SELECT active_store_id, active_tenant_id FROM sessions WHERE id = $1`,
      [SESSION_CASCADE_TENANT],
    );
    expect(after.rows[0]?.active_store_id).toBeNull();
    expect(after.rows[0]?.active_tenant_id).toBeNull();
  });
});
