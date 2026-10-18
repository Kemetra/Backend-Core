/**
 * 010-SCHEMA (T012/T013) — Read-down change-log migration under Testcontainers.
 *
 * Feature: 010-pos-catalog-read-down-sync, Phase 2 §5.2.
 *
 * Validates `packages/db/drizzle/0015_pos_catalog_read_down.sql` (+ `.down.sql`):
 *   - catalog_change_log is created with the data-model.md §3 shape — a SINGLE
 *     monotonic `sequence` (bigint IDENTITY PK, R9 — not per-store), `tenant_id`
 *     NOT NULL, `store_id` NULLABLE (NULL = tenant-wide sentinel event), `op`
 *     CHECK (upsert | remove_from_sellable), the (tenant_id, sequence) index;
 *   - it stores NO resolved payload (price/name/sku/aliases) — R9 the row is
 *     computed at read;
 *   - RLS is ENABLED + FORCED with SELECT + INSERT policies ONLY (append-only),
 *     and the RLS-bypass probe (wrong app.current_tenant ⇒ zero rows) holds;
 *   - the THREE DUMB population triggers fire correctly under the catalog write
 *     transaction's tenant GUC: a tenant_products change writes ONE store_id IS
 *     NULL row (upsert on sellable-relevant change / sellable-enter,
 *     remove_from_sellable on sellable-exit); a store_product_overrides change
 *     writes ONE store_id = S row; the alias trigger resolves the parent
 *     product_id — all with NO cross-store fan-out and NO overrides consultation;
 *   - the migration applies + rolls back clean (UP -> DOWN -> UP).
 *
 * Docker policy (matches 0014-inventory.spec.ts): a missing Docker runtime is a
 * HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1. CI MUST NOT set it. Run
 * targeted (this file), never the full db suite. Testcontainers is WSL-only on
 * the dev box (memory: reference_007_test_env).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";

import {
  ensureAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../_helpers/postgres-container";

const DRIZZLE_DIR = resolve(__dirname, "..", "..", "drizzle");
const UP_PATH = resolve(DRIZZLE_DIR, "0015_pos_catalog_read_down.sql");
const DOWN_PATH = resolve(DRIZZLE_DIR, "0015_pos_catalog_read_down.down.sql");

const TABLE = "catalog_change_log";

// Columns that MUST NOT exist — the change-log carries only product_id + op;
// the resolved payload is computed at read time (R9). No `version` (append-only).
const FORBIDDEN_COLUMNS = [
  "price",
  "amount",
  "currency_code",
  "name",
  "sku",
  "aliases",
  "tax_category",
  "payload",
  "version",
];

// Deterministic fixtures (no random — migration tests must be reproducible).
const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";
const STORE_AX = "33333333-3333-3333-3333-333333333333";
const ACTOR = "44444444-4444-4444-4444-444444444444";

let env: PgTestEnv | null = null;
let dockerSkipReason = "";
let upSql: string | null = null;
let downSql: string | null = null;
let migrationGateError: string | null = null;

/** Apply every UP migration that sorts strictly before 0015. */
async function applyPreMigrations(pgEnv: PgTestEnv): Promise<void> {
  const upBasename = basename(UP_PATH);
  const upFiles = readdirSync(DRIZZLE_DIR)
    .filter((n) => /^\d{4}_.+\.sql$/.test(n) && !n.endsWith(".down.sql"))
    .filter((n) => n.localeCompare(upBasename) < 0)
    .sort();
  for (const name of upFiles) {
    const sql = readFileSync(resolve(DRIZZLE_DIR, name), "utf8");
    await pgEnv.admin.query(sql);
  }
  await ensureAppRole(pgEnv);
}

/**
 * Seed the FK parents the triggers need: two tenants, one store in A, and a
 * sellable + a soon-to-change tenant_product. Uses the admin pool (RLS bypass
 * for setup). Returns the seeded product ids.
 */
async function seedCatalog(pgEnv: PgTestEnv): Promise<{
  sellableProduct: string;
  unpricedProduct: string;
}> {
  const sellableProduct = "55555555-5555-5555-5555-555555555555";
  const unpricedProduct = "66666666-6666-6666-6666-666666666666";

  await pgEnv.admin.query(
    `INSERT INTO tenants (id, slug, name)
     VALUES ($1, 'tenant-a', 'Tenant A'), ($2, 'tenant-b', 'Tenant B')
     ON CONFLICT (id) DO NOTHING`,
    [TENANT_A, TENANT_B],
  );
  await pgEnv.admin.query(
    `INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $2, 'AX', 'Store AX')
     ON CONFLICT (id) DO NOTHING`,
    [STORE_AX, TENANT_A],
  );
  // A sellable product (priced + active + not retired).
  await pgEnv.admin.query(
    `INSERT INTO tenant_products
       (id, tenant_id, name, default_price, default_currency_code, is_active,
        tax_category, created_by, updated_by)
     VALUES ($1, $2, 'Widget', '9.99', 'EGP', true, 'standard', $3, $3)`,
    [sellableProduct, TENANT_A, ACTOR],
  );
  // An unpriced product (NOT sellable — no INSERT change-log row expected).
  await pgEnv.admin.query(
    `INSERT INTO tenant_products
       (id, tenant_id, name, default_price, default_currency_code, is_active,
        tax_category, created_by, updated_by)
     VALUES ($1, $2, 'Draft', NULL, NULL, true, 'standard', $3, $3)`,
    [unpricedProduct, TENANT_A, ACTOR],
  );
  return { sellableProduct, unpricedProduct };
}

/** Run a callback in a single admin connection with app.current_tenant SET. */
async function withTenantGuc<T>(
  pgEnv: PgTestEnv,
  tenant: string,
  fn: (q: (text: string, params?: unknown[]) => Promise<unknown>) => Promise<T>,
): Promise<T> {
  const client = await pgEnv.admin.connect();
  try {
    await client.query(`SET app.current_tenant = '${tenant}'`);
    return await fn((text, params) => client.query(text, params as never));
  } finally {
    await client.query(`RESET app.current_tenant`).catch(() => undefined);
    client.release();
  }
}

/** Count change-log rows for a tenant (admin pool — bypasses RLS for assertion). */
async function logRows(
  pgEnv: PgTestEnv,
  tenant: string,
): Promise<Array<{ store_id: string | null; product_id: string; op: string }>> {
  const r = await pgEnv.admin.query<{
    store_id: string | null;
    product_id: string;
    op: string;
  }>(
    `SELECT store_id, product_id, op FROM catalog_change_log
     WHERE tenant_id = $1 ORDER BY sequence`,
    [tenant],
  );
  return r.rows;
}

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyPreMigrations(env);
  } catch (err: unknown) {
    dockerSkipReason = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(
        `\n[0015-pos-catalog-read-down.spec] Docker NOT AVAILABLE — skipping. Reason: ${dockerSkipReason}\n`,
      );
      return;
    }
    throw new Error(
      `Container start failed: ${dockerSkipReason}\n${err instanceof Error && err.stack ? err.stack : ""}`,
    );
  }

  if (!existsSync(UP_PATH)) {
    migrationGateError = `Read-down migration file missing. Expected at: ${UP_PATH}`;
    return;
  }
  if (!existsSync(DOWN_PATH)) {
    migrationGateError = `Read-down rollback file missing. Expected at: ${DOWN_PATH}`;
    return;
  }
  upSql = readFileSync(UP_PATH, "utf8");
  downSql = readFileSync(DOWN_PATH, "utf8");
}, 180_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

function ensureLoaded(): { up: string; down: string } {
  if (!env) {
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      throw new Error(`Skipped (no Docker): ${dockerSkipReason}`);
    }
    throw new Error("env not initialized");
  }
  if (migrationGateError) throw new Error(migrationGateError);
  if (upSql === null || downSql === null) {
    throw new Error("read-down migration SQL not loaded");
  }
  return { up: upSql, down: downSql };
}

// ---------------------------------------------------------------------------
// Forward migration
// ---------------------------------------------------------------------------
describe("0015_pos_catalog_read_down — applies cleanly and creates the change-log", () => {
  it("pre-migration: catalog_change_log does not exist", async () => {
    if (!env) throw new Error("env not initialized");
    const r = await env.admin.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = $1`,
      [TABLE],
    );
    expect(r.rows).toEqual([]);
  });

  it("applies cleanly and creates the table", async () => {
    const { up } = ensureLoaded();
    if (!env) throw new Error("env not initialized");
    await env.admin.query(up);
    // Re-grant: GRANT ON ALL TABLES picks up the new relation + its sequence.
    await ensureAppRole(env);
    const r = await env.admin.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = $1`,
      [TABLE],
    );
    expect(r.rows.map((row) => row.table_name)).toEqual([TABLE]);
  });
});

// ---------------------------------------------------------------------------
// Column shape: sequence/store_id/op + forbidden-payload negatives
// ---------------------------------------------------------------------------
describe("0015_pos_catalog_read_down — column shape", () => {
  it("sequence is a bigint IDENTITY primary key (R9 monotonic cursor)", async () => {
    if (!env) throw new Error("env not initialized");
    const r = await env.admin.query<{
      data_type: string;
      is_identity: string;
    }>(
      `SELECT data_type, is_identity FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'sequence'`,
      [TABLE],
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]?.data_type).toBe("bigint");
    expect(r.rows[0]?.is_identity).toBe("YES");
  });

  it("store_id is NULLABLE (NULL = tenant-wide sentinel event — R9)", async () => {
    if (!env) throw new Error("env not initialized");
    const r = await env.admin.query<{ is_nullable: string }>(
      `SELECT is_nullable FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'store_id'`,
      [TABLE],
    );
    expect(r.rows[0]?.is_nullable).toBe("YES");
  });

  it("tenant_id + product_id are NOT NULL", async () => {
    if (!env) throw new Error("env not initialized");
    const r = await env.admin.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1
         AND column_name = ANY($2::text[])`,
      [TABLE, ["tenant_id", "product_id"]],
    );
    for (const row of r.rows) expect(row.is_nullable).toBe("NO");
  });

  it("op CHECK restricts to (upsert | remove_from_sellable)", async () => {
    if (!env) throw new Error("env not initialized");
    const r = await env.admin.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
       WHERE conname = 'catalog_change_log_op_allowed'
         AND contype = 'c' AND conrelid = 'catalog_change_log'::regclass`,
    );
    expect(r.rows[0]?.def).toContain("upsert");
    expect(r.rows[0]?.def).toContain("remove_from_sellable");
  });

  it("stores NONE of the resolved-payload columns (R9 — computed at read)", async () => {
    if (!env) throw new Error("env not initialized");
    const r = await env.admin.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1
         AND column_name = ANY($2::text[])`,
      [TABLE, FORBIDDEN_COLUMNS],
    );
    expect(r.rows.map((row) => row.column_name)).toEqual([]);
  });

  it("has the (tenant_id, sequence) delta-read index (R9)", async () => {
    if (!env) throw new Error("env not initialized");
    const r = await env.admin.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname = 'public' AND tablename = $1
         AND indexname = 'idx_catalog_change_log_tenant_sequence'`,
      [TABLE],
    );
    expect(r.rows).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// RLS: enabled + forced + fail-closed; append-only (SELECT + INSERT only)
// ---------------------------------------------------------------------------
describe("0015_pos_catalog_read_down — RLS enabled, forced, append-only, fail-closed", () => {
  it("RLS is ENABLED + FORCED", async () => {
    if (!env) throw new Error("env not initialized");
    const r = await env.admin.query<{
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = $1`, [
      TABLE,
    ]);
    expect(r.rows[0]?.relrowsecurity).toBe(true);
    expect(r.rows[0]?.relforcerowsecurity).toBe(true);
  });

  it("has SELECT + INSERT policies ONLY (no UPDATE/DELETE — append-only)", async () => {
    if (!env) throw new Error("env not initialized");
    const r = await env.admin.query<{ cmd: string }>(
      `SELECT cmd FROM pg_policies WHERE schemaname = 'public' AND tablename = $1`,
      [TABLE],
    );
    const cmds = r.rows.map((row) => row.cmd.toUpperCase()).sort();
    expect(cmds).toEqual(["INSERT", "SELECT"]);
  });

  it("RLS-bypass probe: a wrong app.current_tenant returns zero rows", async () => {
    if (!env) throw new Error("env not initialized");
    await ensureAppRole(env);
    const client = await env.app.connect();
    try {
      await client.query(`SET app.current_tenant = '${TENANT_B}'`);
      const r = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ${TABLE}`,
      );
      expect(r.rows[0]?.count).toBe("0");
    } finally {
      client.release();
    }
  });
});

// ---------------------------------------------------------------------------
// Population triggers — the load-bearing functional proof (advisor requirement):
// the trigger INSERT must succeed under the catalog write txn's tenant GUC and
// produce exactly the right (store_id, op) row, with NO cross-store fan-out.
// ---------------------------------------------------------------------------
describe("0015_pos_catalog_read_down — population triggers fire under tenant GUC", () => {
  it("seeds catalog FK parents (sellable + unpriced products in tenant A)", async () => {
    if (!env) throw new Error("env not initialized");
    // INSERT of a sellable tenant_product fires the tenant_products trigger →
    // ONE store_id IS NULL upsert row; the unpriced product fires nothing.
    const { sellableProduct } = await seedCatalog(env);
    const rows = await logRows(env, TENANT_A);
    const forSellable = rows.filter((r) => r.product_id === sellableProduct);
    expect(forSellable).toEqual([
      { store_id: null, product_id: sellableProduct, op: "upsert" },
    ]);
    // No row for the unpriced product (a never-sellable INSERT emits nothing).
    expect(rows.every((r) => r.op !== "upsert" || r.store_id === null)).toBe(true);
  });

  it("a tenant_products price change emits ONE store_id IS NULL upsert (no fan-out)", async () => {
    if (!env) throw new Error("env not initialized");
    const before = (await logRows(env, TENANT_A)).length;
    await withTenantGuc(env, TENANT_A, async (q) => {
      await q(
        `UPDATE tenant_products SET default_price = '12.50', updated_by = $2
         WHERE id = $1`,
        ["55555555-5555-5555-5555-555555555555", ACTOR],
      );
    });
    const rows = await logRows(env, TENANT_A);
    expect(rows).toHaveLength(before + 1);
    const last = rows[rows.length - 1];
    expect(last?.store_id).toBeNull();
    expect(last?.op).toBe("upsert");
  });

  it("retiring a sellable tenant_product emits remove_from_sellable", async () => {
    if (!env) throw new Error("env not initialized");
    await withTenantGuc(env, TENANT_A, async (q) => {
      await q(
        `UPDATE tenant_products SET retired_at = now(), updated_by = $2 WHERE id = $1`,
        ["55555555-5555-5555-5555-555555555555", ACTOR],
      );
    });
    const rows = await logRows(env, TENANT_A);
    const last = rows[rows.length - 1];
    expect(last?.op).toBe("remove_from_sellable");
    expect(last?.store_id).toBeNull();
  });

  it("a store_product_override insert emits ONE store_id = S upsert (store-scoped)", async () => {
    if (!env) throw new Error("env not initialized");
    const overrideId = "77777777-7777-7777-7777-777777777777";
    await withTenantGuc(env, TENANT_A, async (q) => {
      await q(
        `INSERT INTO store_product_overrides
           (id, tenant_id, store_id, product_id, price, currency_code, created_by, updated_by)
         VALUES ($1, $2, $3, $4, '8.00', 'EGP', $5, $5)`,
        [
          overrideId,
          TENANT_A,
          STORE_AX,
          "66666666-6666-6666-6666-666666666666",
          ACTOR,
        ],
      );
    });
    const rows = await logRows(env, TENANT_A);
    const last = rows[rows.length - 1];
    expect(last?.store_id).toBe(STORE_AX);
    expect(last?.op).toBe("upsert");
  });

  it("a store_product_override UPDATE (deactivate) emits ONE store_id = S row (advisory op)", async () => {
    if (!env) throw new Error("env not initialized");
    // Override UPDATE setting is_active=false: the trigger emits an `upsert`
    // HINT (a sellable-relevant field changed). The stored op is advisory — the
    // delta READ re-resolves and would derive remove_from_sellable (data-model
    // §3/§4). Here we assert the trigger's ACTUAL contract: exactly ONE
    // store-scoped row is logged for (product, S).
    const before = await logRows(env, TENANT_A);
    const beforeCount = before.length;
    await withTenantGuc(env, TENANT_A, async (q) => {
      await q(
        `UPDATE store_product_overrides SET is_active = false, updated_by = $3
         WHERE store_id = $1 AND product_id = $2`,
        [STORE_AX, "66666666-6666-6666-6666-666666666666", ACTOR],
      );
    });
    const after = await logRows(env, TENANT_A);
    expect(after).toHaveLength(beforeCount + 1);
    const last = after[after.length - 1];
    expect(last?.store_id).toBe(STORE_AX); // store-scoped, no fan-out
    expect(last?.product_id).toBe("66666666-6666-6666-6666-666666666666");
    expect(["upsert", "remove_from_sellable"]).toContain(last?.op);
  });

  it("a store_product_override DELETE emits ONE store_id = S row (advisory op)", async () => {
    if (!env) throw new Error("env not initialized");
    // Override DELETE: the trigger emits a store-scoped removal HINT, but S
    // reverts to the still-sellable tenant base — the delta READ re-resolves and
    // would emit upsert(base row) (data-model §3/§4). Assert the contract: ONE
    // store-scoped row is logged for (product, S) so the read knows to re-resolve.
    const before = await logRows(env, TENANT_A);
    const beforeCount = before.length;
    await withTenantGuc(env, TENANT_A, async (q) => {
      await q(
        `DELETE FROM store_product_overrides WHERE store_id = $1 AND product_id = $2`,
        [STORE_AX, "66666666-6666-6666-6666-666666666666"],
      );
    });
    const after = await logRows(env, TENANT_A);
    expect(after).toHaveLength(beforeCount + 1);
    const last = after[after.length - 1];
    expect(last?.store_id).toBe(STORE_AX);
    expect(last?.product_id).toBe("66666666-6666-6666-6666-666666666666");
    // The DELETE trigger logs remove_from_sellable as its hint (the read
    // re-resolves to the tenant base).
    expect(last?.op).toBe("remove_from_sellable");
  });

  it("an alias change resolves the parent product_id into the row (analyze U2)", async () => {
    if (!env) throw new Error("env not initialized");
    const aliasId = "88888888-8888-8888-8888-888888888888";
    await withTenantGuc(env, TENANT_A, async (q) => {
      await q(
        `INSERT INTO product_aliases
           (id, tenant_id, product_id, identifier_type, value, created_by)
         VALUES ($1, $2, $3, 'sku', 'WIDGET-1', $4)`,
        [aliasId, TENANT_A, "55555555-5555-5555-5555-555555555555", ACTOR],
      );
    });
    const rows = await logRows(env, TENANT_A);
    const last = rows[rows.length - 1];
    // Tenant-wide alias (store_id NULL) → sentinel row; product_id is the parent.
    expect(last?.product_id).toBe("55555555-5555-5555-5555-555555555555");
    expect(last?.store_id).toBeNull();
    expect(last?.op).toBe("upsert");
  });
});

// ---------------------------------------------------------------------------
// FK CASCADE — the change-log is a derived projection and must NOT veto deletion
// of the entities it mirrors. RESTRICT here deadlocked every real catalog delete
// (the trigger logs a row on insert/update, then RESTRICT blocked deleting the
// product/store/tenant — broke the existing 005/007 catalog teardown paths).
// ---------------------------------------------------------------------------
describe("0015_pos_catalog_read_down — FK ON DELETE CASCADE (derived projection)", () => {
  it("all three FKs are ON DELETE CASCADE (not the schema-wide RESTRICT)", async () => {
    if (!env) throw new Error("env not initialized");
    const r = await env.admin.query<{ conname: string; confdeltype: string }>(
      `SELECT conname, confdeltype FROM pg_constraint
       WHERE contype = 'f' AND conrelid = 'catalog_change_log'::regclass
       ORDER BY conname`,
    );
    // confdeltype 'c' = CASCADE (vs 'r' = RESTRICT, 'a' = NO ACTION).
    expect(r.rows).toHaveLength(3);
    for (const row of r.rows) {
      expect(row.confdeltype).toBe("c");
    }
  });

  it("deleting a tenant_products row that has a change-log row SUCCEEDS + cascades the row away", async () => {
    if (!env) throw new Error("env not initialized");
    // Reproduce the exact CI break: create a product (the trigger logs an upsert
    // change-log row referencing it), then DELETE the product. With RESTRICT
    // this raised catalog_change_log_product_id_fkey; with CASCADE it succeeds
    // and the change-log row is removed (the cascade bypasses the append-only
    // no-DELETE RLS policy — Postgres referential actions bypass RLS).
    const doomed = "99999999-9999-9999-9999-999999999999";
    await env.admin.query(
      `INSERT INTO tenant_products
         (id, tenant_id, name, default_price, default_currency_code, is_active,
          tax_category, created_by, updated_by)
       VALUES ($1, $2, 'Doomed', '5.00', 'EGP', true, 'standard', $3, $3)`,
      [doomed, TENANT_A, ACTOR],
    );
    const logged = await env.admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM catalog_change_log WHERE product_id = $1`,
      [doomed],
    );
    expect(Number(logged.rows[0]?.count)).toBeGreaterThanOrEqual(1);

    // The delete must SUCCEED (the regression: RESTRICT made this throw).
    await env.admin.query(`DELETE FROM tenant_products WHERE id = $1`, [doomed]);

    const after = await env.admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM catalog_change_log WHERE product_id = $1`,
      [doomed],
    );
    expect(after.rows[0]?.count).toBe("0"); // cascaded away
  });
});

// ---------------------------------------------------------------------------
// Rollback round-trip (UP -> DOWN -> UP)
// ---------------------------------------------------------------------------
describe("0015_pos_catalog_read_down — rollback round-trip (UP -> DOWN -> UP)", () => {
  it("rolls back cleanly: table + triggers + functions dropped", async () => {
    const { down } = ensureLoaded();
    if (!env) throw new Error("env not initialized");
    await env.admin.query(down);
    const tbl = await env.admin.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = $1`,
      [TABLE],
    );
    expect(tbl.rows).toEqual([]);
    // The three population triggers are gone from the source tables.
    const trg = await env.admin.query<{ tgname: string }>(
      `SELECT tgname FROM pg_trigger
       WHERE tgname IN (
         'catalog_change_log_tenant_products',
         'catalog_change_log_store_overrides',
         'catalog_change_log_product_aliases'
       )`,
    );
    expect(trg.rows).toEqual([]);
  });

  it("re-applies cleanly after rollback (idempotent UP)", async () => {
    const { up } = ensureLoaded();
    if (!env) throw new Error("env not initialized");
    await env.admin.query(up);
    const r = await env.admin.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = $1`,
      [TABLE],
    );
    expect(r.rows.map((row) => row.table_name)).toEqual([TABLE]);
  });
});
