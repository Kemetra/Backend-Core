/**
 * 0037_erpnext_posting_resolution + 0038 backfill — migration spec (RT-330).
 *
 * Seeds two pending sale_post intents BEFORE 0037 runs: one whose line resolves
 * from the current maps and one whose line is unmapped. After 0037 + 0038:
 *   - the resolvable intent carries resolution v1 (resolved_by = 'backfill')
 *     with the map's ERP item and the store's stock warehouse;
 *   - the unresolvable intent keeps a NULL version and no resolution rows;
 *   - 0037 alone (before 0038) leaves every version NULL: the DDL migration
 *     does no bulk work while it holds its locks;
 *   - 0038 is idempotent, and 0037's down removes the table and the column;
 *     re-applying both backfills again.
 */
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { startPgEnv, stopPgEnv, type PgTestEnv } from "../_helpers/postgres-container";

const DRIZZLE_DIR = resolve(__dirname, "..", "..", "drizzle");
const UP_NAME = "0037_erpnext_posting_resolution.sql";
const UP_PATH = resolve(DRIZZLE_DIR, UP_NAME);
const DOWN_PATH = resolve(DRIZZLE_DIR, "0037_erpnext_posting_resolution.down.sql");
const BACKFILL_PATH = resolve(DRIZZLE_DIR, "0038_erpnext_posting_resolution_backfill.sql");
const BACKFILL_DOWN_PATH = resolve(
  DRIZZLE_DIR,
  "0038_erpnext_posting_resolution_backfill.down.sql",
);

const TENANT = "0a000000-0000-7000-8000-000000037a01";
const STORE = "0a000000-0000-7000-8000-000000037a02";
const USER = "0a000000-0000-7000-8000-000000037a03";
const PRODUCT_MAPPED = "0a000000-0000-7000-8000-000000037a04";
const PRODUCT_UNMAPPED = "0a000000-0000-7000-8000-000000037a05";
const SALE_OK = "0a000000-0000-7000-8000-000000037a06";
const SALE_UNMAPPED = "0a000000-0000-7000-8000-000000037a07";
const INTENT_OK = "0a000000-0000-7000-8000-000000037a08";
const INTENT_UNMAPPED = "0a000000-0000-7000-8000-000000037a09";
const HASH = "c".repeat(64);

let env: PgTestEnv | null = null;
let versionAfterDdlOnly: number | null | undefined;

function pg(): PgTestEnv {
  if (!env) throw new Error("env not initialized");
  return env;
}

async function applyBefore0037(pgEnv: PgTestEnv): Promise<void> {
  const files = readdirSync(DRIZZLE_DIR)
    .filter((n) => /^\d{4}_.+\.sql$/.test(n) && !n.endsWith(".down.sql"))
    .filter((n) => n.localeCompare(UP_NAME) < 0)
    .sort();
  for (const name of files) {
    await pgEnv.admin.query(readFileSync(resolve(DRIZZLE_DIR, name), "utf8"));
  }
}

async function seedSaleWithIntent(saleId: string, intentId: string, product: string): Promise<void> {
  const a = pg().admin;
  await a.query(
    `INSERT INTO sales
       (id, tenant_id, store_id, currency_code, pos_total, occurred_at,
        business_date, source_system, external_id, payload_hash, created_by)
     VALUES ($1, $2, $3, 'USD', 5.00, now(), '2026-06-01', 'pos-0037', $6, $4, $5)`,
    [saleId, TENANT, STORE, HASH, USER, `ext-${saleId}`],
  );
  await a.query(
    `INSERT INTO sale_lines
       (id, sale_id, tenant_id, store_id, line_name, unit_price, currency_code,
        quantity, line_amount, tax_amount, unit, tenant_product_ref)
     VALUES (gen_random_uuid(), $1, $2, $3, 'Widget', 5.0000, 'USD',
        1.000000, 5.0000, 0.0000, 'ea', $4)`,
    [saleId, TENANT, STORE, product],
  );
  await a.query(
    `INSERT INTO erpnext_posting_status
       (id, tenant_id, store_id, sale_id, kind, source_ref_id,
        source_system, external_id, payload_hash, status)
     VALUES ($1, $2, $3, $4, 'sale_post', $4, 'pos-0037', $6, $5, 'pending')`,
    [intentId, TENANT, STORE, saleId, HASH, `ext-${saleId}`],
  );
}

async function resolutionOf(intentId: string): Promise<{
  version: number | null;
  rows: Array<{ item: string; warehouse: string; by: string }>;
}> {
  const s = await pg().admin.query<{ v: number | null }>(
    `SELECT current_resolution_version AS v FROM erpnext_posting_status WHERE id = $1`,
    [intentId],
  );
  const r = await pg().admin.query<{ item: string; warehouse: string; by: string }>(
    `SELECT erpnext_item_ref AS item, warehouse_ref AS warehouse, resolved_by AS by
       FROM erpnext_posting_resolution WHERE intent_id = $1`,
    [intentId],
  );
  return { version: s.rows[0]?.v ?? null, rows: r.rows };
}

beforeAll(async () => {
  env = await startPgEnv();
  await applyBefore0037(env);
  const a = env.admin;
  await a.query(
    `INSERT INTO tenants (id, slug, name, default_currency_code)
     VALUES ($1, 't0037', 'T0037', 'USD')`,
    [TENANT],
  );
  await a.query(`INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $2, 'S37', 'S37')`, [
    STORE,
    TENANT,
  ]);
  await a.query(
    `INSERT INTO users (id, email, password_hash) VALUES ($1, 'u0037@fixture.invalid', NULL)`,
    [USER],
  );
  await a.query(
    `INSERT INTO tenant_products (id, tenant_id, name, tax_category, created_by, updated_by)
     VALUES ($1, $3, 'Mapped', 'standard', $4, $4), ($2, $3, 'Unmapped', 'standard', $4, $4)`,
    [PRODUCT_MAPPED, PRODUCT_UNMAPPED, TENANT, USER],
  );
  await a.query(
    `INSERT INTO erpnext_item_map
       (id, tenant_id, tenant_product_id, erpnext_item_ref, state,
        suggestion_source, confirmed_by, confirmed_at)
     VALUES (gen_random_uuid(), $1, $2, 'ERP-0037', 'confirmed', 'manual', $3, now())`,
    [TENANT, PRODUCT_MAPPED, USER],
  );
  await a.query(
    `INSERT INTO erpnext_warehouse_map
       (id, tenant_id, store_id, purpose, erpnext_warehouse_ref, set_by, version)
     VALUES (gen_random_uuid(), $1, $2, 'stock', 'WH-0037', $3, 1)`,
    [TENANT, STORE, USER],
  );
  await seedSaleWithIntent(SALE_OK, INTENT_OK, PRODUCT_MAPPED);
  await seedSaleWithIntent(SALE_UNMAPPED, INTENT_UNMAPPED, PRODUCT_UNMAPPED);
  await a.query(readFileSync(UP_PATH, "utf8"));
  versionAfterDdlOnly = (await resolutionOf(INTENT_OK)).version;
  await a.query(readFileSync(BACKFILL_PATH, "utf8"));
}, 240_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

describe("0037 + 0038 — the backfill is a separate migration", () => {
  it("0037 alone freezes nothing (no bulk work under its locks)", () => {
    expect(versionAfterDdlOnly).toBeNull();
  });

  it("0038 is idempotent: a second run leaves exactly one version", async () => {
    await pg().admin.query(readFileSync(BACKFILL_PATH, "utf8"));
    const rows = await resolutionOf(INTENT_OK);
    expect(rows.version).toBe(1);
    expect(rows.rows).toHaveLength(1);
  });
});

describe("0038 — backfill freezes resolvable intents only", () => {
  it("a resolvable pending intent gets resolution v1 from the current maps", async () => {
    expect(await resolutionOf(INTENT_OK)).toEqual({
      version: 1,
      rows: [{ item: "ERP-0037", warehouse: "WH-0037", by: "backfill" }],
    });
  });

  it("an intent with an unmapped line keeps a NULL version and no rows", async () => {
    expect(await resolutionOf(INTENT_UNMAPPED)).toEqual({ version: null, rows: [] });
  });
});

describe("0037 — reversible", () => {
  it("down removes the table and column; up re-applies and backfills again", async () => {
    await pg().admin.query(readFileSync(BACKFILL_DOWN_PATH, "utf8"));
    await pg().admin.query(readFileSync(DOWN_PATH, "utf8"));
    const gone = await pg().admin.query(
      `SELECT to_regclass('erpnext_posting_resolution') AS t,
              (SELECT count(*) FROM information_schema.columns
                WHERE table_name = 'erpnext_posting_status'
                  AND column_name = 'current_resolution_version')::int AS c`,
    );
    expect(gone.rows[0]).toEqual({ t: null, c: 0 });

    await pg().admin.query(readFileSync(UP_PATH, "utf8"));
    await pg().admin.query(readFileSync(BACKFILL_PATH, "utf8"));
    expect((await resolutionOf(INTENT_OK)).version).toBe(1);
  });
});
