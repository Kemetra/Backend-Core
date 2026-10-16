/**
 * 0049 — sale payer responsibilities (RT-418; contract RT-417; owner decision
 * R-1, RT-413 comment 11669).
 *
 * Applies every migration before 0049 against a real Postgres, seeds a
 * pre-0049 sale and payer (the UPGRADE path), applies 0049, then proves:
 *   - existing sales read `responsibility_count = 0` (no backfill);
 *   - `payer_account.credit_terms` is gone (ERPNext owns terms);
 *   - `sale_responsibilities`: amount > 0, sequence >= 1, one row per payer and
 *     per sequence within a sale, the composite sale FK (a row cannot name
 *     another tenant's or store's sale) and the composite payer FK (a row
 *     cannot name another tenant's payer);
 *   - `sales.responsibility_count` is 0..1 (one payer per sale in this version);
 *   - RLS: ENABLE + FORCE, fail-closed on an empty or unset GUC, tenant-scoped
 *     read and insert, and immutable (no UPDATE / DELETE policy);
 *   - `erpnext_posting_resolution.payer_external_ref` exists, nullable;
 *   - down round-trips with up.
 *
 * Fresh install (the whole chain from empty) is covered by the migrate CLI
 * spec's EXPECTED_MIGRATIONS ledger.
 */
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { PoolClient } from "pg";

import { ensureAppRole, startPgEnv, stopPgEnv, type PgTestEnv } from "../_helpers/postgres-container";

const DRIZZLE_DIR = resolve(__dirname, "..", "..", "drizzle");
const UP_NAME = "0049_sale_responsibilities.sql";
const UP_PATH = resolve(DRIZZLE_DIR, UP_NAME);
const DOWN_PATH = resolve(DRIZZLE_DIR, "0049_sale_responsibilities.down.sql");

const TENANT = "0a000000-0000-7000-8000-000000049001";
const TENANT_B = "0b000000-0000-7000-8000-000000049001";
const STORE = "0a000000-0000-7000-8000-000000049002";
const STORE_2 = "0a000000-0000-7000-8000-000000049003";
const STORE_B = "0b000000-0000-7000-8000-000000049002";
const ACTOR = "0a000000-0000-7000-8000-000000049004";
const LEGACY_SALE = "0a000000-0000-7000-8000-000000049005";
const SALE = "0a000000-0000-7000-8000-000000049006";
const SALE_B = "0b000000-0000-7000-8000-000000049006";
const PAYER = "0a000000-0000-7000-8000-0000000490a1";
const PAYER_2 = "0a000000-0000-7000-8000-0000000490a2";
const PAYER_B = "0b000000-0000-7000-8000-0000000490b1";

let env: PgTestEnv | null = null;

function pg(): PgTestEnv {
  if (!env) throw new Error("env not initialized");
  return env;
}

async function applyBefore0049(pgEnv: PgTestEnv): Promise<void> {
  const files = readdirSync(DRIZZLE_DIR)
    .filter((n) => /^\d{4}_.+\.sql$/.test(n) && !n.endsWith(".down.sql"))
    .filter((n) => n.localeCompare(UP_NAME) < 0)
    .sort();
  for (const name of files) {
    await pgEnv.admin.query(readFileSync(resolve(DRIZZLE_DIR, name), "utf8"));
  }
  await ensureAppRole(pgEnv);
}

interface SaleSeed {
  readonly id: string;
  readonly tenantId: string;
  readonly storeId: string;
  readonly externalId: string;
}

async function insertSale({ id, tenantId, storeId, externalId }: SaleSeed): Promise<void> {
  await pg().admin.query(
    `INSERT INTO sales
       (id, tenant_id, store_id, currency_code, pos_total, occurred_at,
        business_date, source_system, external_id, payload_hash, created_by)
     VALUES ($1, $2, $3, 'EGP', 10, '2026-10-16T10:00:00Z', '2026-10-16',
             'pos-1', $4, $5, $6)`,
    [id, tenantId, storeId, externalId, "c".repeat(64), ACTOR],
  );
}

interface ResponsibilityRow {
  readonly saleId?: string;
  readonly tenantId?: string;
  readonly storeId?: string;
  readonly payerId?: string;
  readonly amount?: string;
  readonly sequence?: number;
}

const insertSql = `INSERT INTO sale_responsibilities
       (sale_id, tenant_id, store_id, payer_id, amount, sequence)
     VALUES ($1, $2, $3, $4, $5::numeric, $6)`;

function params(row: ResponsibilityRow): unknown[] {
  return [
    row.saleId ?? SALE,
    row.tenantId ?? TENANT,
    row.storeId ?? STORE,
    row.payerId ?? PAYER,
    row.amount ?? "10",
    row.sequence ?? 1,
  ];
}

/** Insert as the superuser; returns the Postgres error code, or null on success (then rolled back). */
async function tryInsert(row: ResponsibilityRow): Promise<string | null> {
  const client = await pg().admin.connect();
  try {
    await client.query("BEGIN");
    await client.query(insertSql, params(row));
    return null;
  } catch (err) {
    return (err as { code?: string }).code ?? "unknown";
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

/** Runs `fn` as the non-superuser app role with `app.current_tenant` set to `guc`, then rolls back. */
async function asApp<T>(guc: string | null, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pg().app.connect();
  try {
    await client.query("BEGIN");
    if (guc !== null) await client.query("SELECT set_config('app.current_tenant', $1, true)", [guc]);
    return await fn(client);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

async function errorCode(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (err) {
    return (err as { code?: string }).code ?? "unknown";
  }
}

/** Which 0049 objects exist (and whether the dropped credit_terms column is back). */
interface SchemaState {
  readonly table: boolean;
  readonly responsibilityCount: boolean;
  readonly payerExternalRef: boolean;
  readonly creditTerms: boolean;
}

async function schemaState(): Promise<SchemaState> {
  const r = await pg().admin.query<SchemaState>(
    `SELECT
       EXISTS (SELECT 1 FROM information_schema.tables
                WHERE table_schema = 'public' AND table_name = 'sale_responsibilities') AS "table",
       EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'sales'
                  AND column_name = 'responsibility_count') AS "responsibilityCount",
       EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'erpnext_posting_resolution'
                  AND column_name = 'payer_external_ref') AS "payerExternalRef",
       EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'payer_account'
                  AND column_name = 'credit_terms') AS "creditTerms"`,
  );
  return r.rows[0]!;
}

const UP_STATE: SchemaState = { table: true, responsibilityCount: true, payerExternalRef: true, creditTerms: false };
const DOWN_STATE: SchemaState = { table: false, responsibilityCount: false, payerExternalRef: false, creditTerms: true };

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[0049-sale-responsibilities.spec] Docker NOT AVAILABLE — skipping: ${String(err)}\n`);
      return;
    }
    throw err;
  }
  await applyBefore0049(env);
  await env.admin.query(
    `INSERT INTO tenants (id, name, slug) VALUES ($1, 'RT-418 tenant', 'rt418-a'), ($2, 'RT-418 tenant B', 'rt418-b')`,
    [TENANT, TENANT_B],
  );
  await env.admin.query(
    `INSERT INTO stores (id, tenant_id, code, name) VALUES
       ($1, $4, 'rt418-x', 'X'), ($2, $4, 'rt418-y', 'Y'), ($3, $5, 'rt418-b', 'B')`,
    [STORE, STORE_2, STORE_B, TENANT, TENANT_B],
  );
  await insertSale({ id: LEGACY_SALE, tenantId: TENANT, storeId: STORE, externalId: "rt418-legacy" });
  await env.admin.query(
    `INSERT INTO payer_account (id, tenant_id, store_id, category, display_name, external_ref, credit_terms)
     VALUES ($1, $4, NULL, 'credit_customer', 'House', 'CUST-1', '{"days":30}'::jsonb),
            ($2, $4, $5,   'corporate',       'Corp',  'CUST-2', NULL),
            ($3, $6, $7,   'insurer',         'B',     'CUST-B', NULL)`,
    [PAYER, PAYER_2, PAYER_B, TENANT, STORE, TENANT_B, STORE_B],
  );
  await env.admin.query(readFileSync(UP_PATH, "utf8"));
  // The app role's grants cover the tables that existed when they ran.
  await ensureAppRole(env);
  await insertSale({ id: SALE, tenantId: TENANT, storeId: STORE, externalId: "rt418-sale" });
  await insertSale({ id: SALE_B, tenantId: TENANT_B, storeId: STORE_B, externalId: "rt418-sale-b" });
}, 240_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

const skip = (): boolean => env === null;

describe("0049 up — upgrade path", () => {
  it("existing sales read responsibility_count 0 (no backfill)", async () => {
    if (skip()) return;
    const r = await pg().admin.query(`SELECT responsibility_count FROM sales WHERE id = $1`, [LEGACY_SALE]);
    expect(r.rows[0]).toEqual({ responsibility_count: 0 });
  });

  it("drops payer_account.credit_terms and keeps every payer", async () => {
    if (skip()) return;
    expect((await schemaState()).creditTerms).toBe(false);
    const r = await pg().admin.query(`SELECT count(*)::int AS n FROM payer_account`);
    expect(r.rows[0]).toEqual({ n: 3 });
  });

  it("adds a nullable erpnext_posting_resolution.payer_external_ref", async () => {
    if (skip()) return;
    const r = await pg().admin.query(
      `SELECT is_nullable, data_type FROM information_schema.columns
        WHERE table_name = 'erpnext_posting_resolution' AND column_name = 'payer_external_ref'`,
    );
    expect(r.rows[0]).toEqual({ is_nullable: "YES", data_type: "text" });
  });
});

describe("0049 sale_responsibilities constraints", () => {
  it("accepts a valid row: tenant-wide payer, positive amount, sequence 1", async () => {
    if (skip()) return;
    expect(await tryInsert({})).toBeNull();
  });

  it.each([
    ["a zero amount", { amount: "0" }, "23514"],
    ["a negative amount", { amount: "-1" }, "23514"],
    ["sequence 0", { sequence: 0 }, "23514"],
    ["another tenant's payer", { payerId: PAYER_B }, "23503"],
    ["a sale of another store", { storeId: STORE_2 }, "23503"],
    ["another tenant's sale", { saleId: SALE_B }, "23503"],
  ])("refuses %s", async (_name, row, code) => {
    if (skip()) return;
    expect(await tryInsert(row)).toBe(code);
  });

  it("refuses a second row for the same payer or the same sequence within a sale (23505)", async () => {
    if (skip()) return;
    const client = await pg().admin.connect();
    try {
      await client.query("BEGIN");
      await client.query(insertSql, params({}));
      await client.query("SAVEPOINT s");
      const samePayer = await errorCode(() => client.query(insertSql, params({ sequence: 2 })));
      await client.query("ROLLBACK TO SAVEPOINT s");
      const sameSequence = await errorCode(() => client.query(insertSql, params({ payerId: PAYER_2 })));
      expect({ samePayer, sameSequence }).toEqual({ samePayer: "23505", sameSequence: "23505" });
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("validates the responsibility_count CHECK in the same migration (not left NOT VALID)", async () => {
    if (skip()) return;
    const r = await pg().admin.query(
      `SELECT convalidated FROM pg_constraint WHERE conname = 'sales_responsibility_count_range'`,
    );
    expect(r.rows).toEqual([{ convalidated: true }]);
  });

  it("caps sales.responsibility_count at 0..1 (23514)", async () => {
    if (skip()) return;
    const set = (n: number) => () => pg().admin.query(`UPDATE sales SET responsibility_count = $2 WHERE id = $1`, [SALE, n]);
    const client = pg().admin;
    expect(await errorCode(set(2))).toBe("23514");
    expect(await errorCode(set(-1))).toBe("23514");
    expect(await errorCode(set(1))).toBeNull();
    await client.query(`UPDATE sales SET responsibility_count = 0 WHERE id = $1`, [SALE]);
  });
});

describe("0049 sale_responsibilities RLS", () => {
  beforeAll(async () => {
    if (skip()) return;
    await pg().admin.query(insertSql, params({}));
  });
  afterAll(async () => {
    if (skip()) return;
    await pg().admin.query(`DELETE FROM sale_responsibilities WHERE sale_id = $1`, [SALE]);
  });

  it("is ENABLE + FORCE row level security, with SELECT and INSERT policies only", async () => {
    if (skip()) return;
    const t = await pg().admin.query(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'sale_responsibilities'`,
    );
    expect(t.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    const p = await pg().admin.query<{ cmd: string }>(
      `SELECT cmd FROM pg_policies WHERE tablename = 'sale_responsibilities' ORDER BY cmd`,
    );
    expect(p.rows.map((r) => r.cmd)).toEqual(["INSERT", "SELECT"]);
  });

  it("fails closed on an unset or empty tenant GUC", async () => {
    if (skip()) return;
    const read = (c: PoolClient) => c.query(`SELECT count(*)::int AS n FROM sale_responsibilities`);
    expect((await asApp(null, read)).rows[0]).toEqual({ n: 0 });
    expect((await asApp("", read)).rows[0]).toEqual({ n: 0 });
  });

  it("is tenant-scoped: the owner reads its row, another tenant reads none", async () => {
    if (skip()) return;
    const read = (c: PoolClient) => c.query(`SELECT count(*)::int AS n FROM sale_responsibilities`);
    expect((await asApp(TENANT, read)).rows[0]).toEqual({ n: 1 });
    expect((await asApp(TENANT_B, read)).rows[0]).toEqual({ n: 0 });
  });

  it("refuses an insert for another tenant's row (WITH CHECK, 42501)", async () => {
    if (skip()) return;
    const code = await asApp(TENANT_B, (c) =>
      errorCode(() => c.query(insertSql, params({ payerId: PAYER_2, sequence: 2 }))),
    );
    expect(code).toBe("42501");
  });

  it("is immutable for the app role: UPDATE and DELETE touch nothing", async () => {
    if (skip()) return;
    const changed = await asApp(TENANT, async (c) => {
      const u = await c.query(`UPDATE sale_responsibilities SET amount = 1`);
      const d = await c.query(`DELETE FROM sale_responsibilities`);
      return { updated: u.rowCount, deleted: d.rowCount };
    });
    expect(changed).toEqual({ updated: 0, deleted: 0 });
  });
});

describe("0049 down", () => {
  it("refuses loudly while responsibility rows exist, and changes nothing", async () => {
    if (skip()) return;
    await pg().admin.query(insertSql, params({}));
    try {
      expect(await errorCode(() => pg().admin.query(readFileSync(DOWN_PATH, "utf8")))).toBe("P0001");
      expect(await schemaState()).toEqual(UP_STATE);
    } finally {
      await pg().admin.query("ROLLBACK").catch(() => undefined);
      await pg().admin.query(`DELETE FROM sale_responsibilities WHERE sale_id = $1`, [SALE]);
    }
  });

  it("round-trips: down removes every 0049 object, up restores them", async () => {
    if (skip()) return;
    await pg().admin.query(readFileSync(DOWN_PATH, "utf8"));
    expect(await schemaState()).toEqual(DOWN_STATE);
    await pg().admin.query(readFileSync(UP_PATH, "utf8"));
    expect(await schemaState()).toEqual(UP_STATE);
  });
});
