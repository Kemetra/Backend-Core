/**
 * 0032 — line-aware returns (RT-73) + the reversal business date (RT-63).
 *
 * Applies every migration before 0032 against a real Postgres, seeds a sale
 * with a void, then proves:
 *   - a pre-existing duplicate void (RT-14 F2) makes 0032 FAIL loudly and
 *     leaves the schema untouched — append-only facts are never deleted;
 *   - `sale_voids.business_date` is backfilled from `voided_at` in the
 *     STORE timezone (not UTC) and is NOT NULL afterwards;
 *   - at most one void per sale is enforced by `uq_sale_voids_one_per_sale`;
 *   - the three return tables are RLS-forced, SELECT + INSERT only
 *     (append-only), with their CHECK constraints;
 *   - down → up round-trips cleanly.
 *
 * The migration runs here as the container superuser, which bypasses RLS, so
 * this suite cannot reproduce a non-superuser owner's FORCE-RLS no-op. The
 * migration guards that case itself: `SET NOT NULL` fails if the backfill
 * silently skipped rows.
 */
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  ensureAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../_helpers/postgres-container";

const DRIZZLE_DIR = resolve(__dirname, "..", "..", "drizzle");
const UP_NAME = "0032_sale_returns.sql";
const UP_PATH = resolve(DRIZZLE_DIR, UP_NAME);
const DOWN_PATH = resolve(DRIZZLE_DIR, "0032_sale_returns.down.sql");

const RETURN_TABLES = ["sale_returns", "sale_return_lines", "sale_return_tenders"];

const TENANT = "0a000000-0000-7000-8000-000000032001";
const STORE = "0a000000-0000-7000-8000-000000032002";
const SALE = "0a000000-0000-7000-8000-000000032003";
const LINE = "0a000000-0000-7000-8000-000000032004";
const VOID_1 = "0a000000-0000-7000-8000-000000032005";
const VOID_2 = "0a000000-0000-7000-8000-000000032006";
const ACTOR = "0a000000-0000-7000-8000-000000032007";

let env: PgTestEnv | null = null;

function pg(): PgTestEnv {
  if (!env) throw new Error("env not initialized");
  return env;
}

async function applyBefore0032(pgEnv: PgTestEnv): Promise<void> {
  const files = readdirSync(DRIZZLE_DIR)
    .filter((n) => /^\d{4}_.+\.sql$/.test(n) && !n.endsWith(".down.sql"))
    .filter((n) => n.localeCompare(UP_NAME) < 0)
    .sort();
  for (const name of files) {
    await pgEnv.admin.query(readFileSync(resolve(DRIZZLE_DIR, name), "utf8"));
  }
  await ensureAppRole(pgEnv);
}

async function insertVoid(id: string, voidedAt: string, externalId: string): Promise<void> {
  await pg().admin.query(
    `INSERT INTO sale_voids
       (id, sale_id, tenant_id, store_id, voided_at, source_system, external_id,
        payload_hash, created_by)
     VALUES ($1, $2, $3, $4, $5::timestamptz, 'pos-1', $6, $7, $8)`,
    [id, SALE, TENANT, STORE, voidedAt, externalId, "a".repeat(64), ACTOR],
  );
}

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[0032-sale-returns.spec] Docker NOT AVAILABLE — skipping: ${String(err)}\n`);
      return;
    }
    throw err;
  }
  await applyBefore0032(env);
  // Egypt observes summer time in May 2026 (UTC+3): 22:30Z is 01:30 the
  // NEXT local day, so a UTC-derived date would be wrong by one day.
  await env.admin.query(
    `INSERT INTO tenants (id, name, slug) VALUES ($1, 'RT-73 tenant', 'rt73-tenant')`,
    [TENANT],
  );
  await env.admin.query(
    `INSERT INTO stores (id, tenant_id, code, name, timezone)
     VALUES ($1, $2, 'rt73', 'RT-73 store', 'Africa/Cairo')`,
    [STORE, TENANT],
  );
  await env.admin.query(
    `INSERT INTO sales
       (id, tenant_id, store_id, currency_code, pos_total, occurred_at,
        business_date, source_system, external_id, payload_hash, created_by)
     VALUES ($1, $2, $3, 'EGP', 10, '2026-05-01T10:00:00Z', '2026-05-01',
             'pos-1', 'rt73-sale', $4, $5)`,
    [SALE, TENANT, STORE, "b".repeat(64), ACTOR],
  );
  await env.admin.query(
    `INSERT INTO sale_lines
       (id, sale_id, tenant_id, store_id, line_name, unit_price, currency_code,
        quantity, line_amount, unit)
     VALUES ($1, $2, $3, $4, 'Widget', 10, 'EGP', 3, 10, 'ea')`,
    [LINE, SALE, TENANT, STORE],
  );
}, 240_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

const skip = (): boolean => env === null;

describe("0032_sale_returns — refuses to run over duplicate voids (RT-14 F2)", () => {
  it("fails loudly and changes nothing when a sale already has two voids", async () => {
    if (skip()) return;
    await insertVoid(VOID_1, "2026-05-01T22:30:00Z", "void-a");
    await insertVoid(VOID_2, "2026-05-01T23:00:00Z", "void-b");

    // One dedicated connection: the script opens its own BEGIN, so after the
    // RAISE that connection sits in an aborted transaction until ROLLBACK.
    const client = await pg().admin.connect();
    try {
      await expect(client.query(readFileSync(UP_PATH, "utf8"))).rejects.toThrow(
        /more than one void/,
      );
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    // The failed transaction rolled back: no new column, no new table.
    const col = await pg().admin.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name = 'sale_voids' AND column_name = 'business_date'`,
    );
    expect(col.rowCount).toBe(0);
    const tables = await pg().admin.query(
      `SELECT 1 FROM information_schema.tables WHERE table_name = ANY($1::text[])`,
      [RETURN_TABLES],
    );
    expect(tables.rowCount).toBe(0);

    // Remediation is an operator decision; the test removes its own seed.
    await pg().admin.query("DELETE FROM sale_voids WHERE id = $1", [VOID_2]);
  });
});

describe("0032_sale_returns — applies and backfills", () => {
  it("applies cleanly once each sale has at most one void", async () => {
    if (skip()) return;
    await pg().admin.query(readFileSync(UP_PATH, "utf8"));
  });

  it("backfills sale_voids.business_date in the STORE timezone and makes it NOT NULL", async () => {
    if (skip()) return;
    const r = await pg().admin.query<{ business_date: string }>(
      `SELECT business_date::text AS business_date FROM sale_voids WHERE id = $1`,
      [VOID_1],
    );
    expect(r.rows[0]?.business_date).toBe("2026-05-02");
    const nn = await pg().admin.query<{ is_nullable: string }>(
      `SELECT is_nullable FROM information_schema.columns
        WHERE table_name = 'sale_voids' AND column_name = 'business_date'`,
    );
    expect(nn.rows[0]?.is_nullable).toBe("NO");
  });

  it("keeps sale_voids RLS forced after the backfill", async () => {
    if (skip()) return;
    const r = await pg().admin.query<{ relforcerowsecurity: boolean }>(
      `SELECT relforcerowsecurity FROM pg_class WHERE relname = 'sale_voids'`,
    );
    expect(r.rows[0]?.relforcerowsecurity).toBe(true);
  });

  it("enforces at most one void per sale (uq_sale_voids_one_per_sale)", async () => {
    if (skip()) return;
    await expect(
      pg().admin.query(
        `INSERT INTO sale_voids
           (id, sale_id, tenant_id, store_id, business_date, source_system,
            external_id, payload_hash, created_by)
         VALUES ($1, $2, $3, $4, '2026-05-03', 'pos-1', 'void-c', $5, $6)`,
        [VOID_2, SALE, TENANT, STORE, "a".repeat(64), ACTOR],
      ),
    ).rejects.toThrow(/uq_sale_voids_one_per_sale/);
  });
});

describe("0032_sale_returns — return tables", () => {
  it("creates the three return tables with RLS enabled and forced", async () => {
    if (skip()) return;
    const r = await pg().admin.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity
         FROM pg_class WHERE relname = ANY($1::text[]) ORDER BY relname`,
      [RETURN_TABLES],
    );
    expect(r.rows.map((x) => x.relname)).toEqual([...RETURN_TABLES].sort());
    for (const row of r.rows) {
      expect(row.relrowsecurity).toBe(true);
      expect(row.relforcerowsecurity).toBe(true);
    }
  });

  it("is append-only: SELECT + INSERT policies only, no UPDATE / DELETE", async () => {
    if (skip()) return;
    const r = await pg().admin.query<{ tablename: string; cmd: string }>(
      `SELECT tablename, cmd FROM pg_policies
        WHERE tablename = ANY($1::text[]) ORDER BY tablename, cmd`,
      [RETURN_TABLES],
    );
    for (const table of RETURN_TABLES) {
      const cmds = r.rows.filter((x) => x.tablename === table).map((x) => x.cmd).sort();
      expect(cmds).toEqual(["INSERT", "SELECT"]);
    }
  });

  it("rejects a non-positive return quantity and a non-cash refund tender", async () => {
    if (skip()) return;
    const RET = "0a000000-0000-7000-8000-000000032010";
    await pg().admin.query(
      `INSERT INTO sale_returns
         (id, sale_id, tenant_id, store_id, return_seq, business_date,
          currency_code, return_total, source_system, external_id,
          payload_hash, created_by)
       VALUES ($1, $2, $3, $4, 1, '2026-05-02', 'EGP', 3.3333, 'pos-1',
               'ret-1', $5, $6)`,
      [RET, SALE, TENANT, STORE, "c".repeat(64), ACTOR],
    );
    await expect(
      pg().admin.query(
        `INSERT INTO sale_return_lines
           (return_id, sale_line_id, tenant_id, store_id, quantity,
            line_amount, returned_quantity_after)
         VALUES ($1, $2, $3, $4, 0, 0, 0)`,
        [RET, LINE, TENANT, STORE],
      ),
    ).rejects.toThrow(/sale_return_lines_quantity_positive/);
    await expect(
      pg().admin.query(
        `INSERT INTO sale_return_tenders
           (return_id, tenant_id, store_id, ordinal, method, amount)
         VALUES ($1, $2, $3, 0, 'card', 1)`,
        [RET, TENANT, STORE],
      ),
    ).rejects.toThrow(/sale_return_tenders_method_valid/);
    await pg().admin.query("DELETE FROM sale_returns WHERE id = $1", [RET]);
  });
});

describe("0032_sale_returns — down → up round-trip", () => {
  it("down removes the tables, the index and the column; up re-applies", async () => {
    if (skip()) return;
    await pg().admin.query(readFileSync(DOWN_PATH, "utf8"));
    const tables = await pg().admin.query(
      `SELECT 1 FROM information_schema.tables WHERE table_name = ANY($1::text[])`,
      [RETURN_TABLES],
    );
    expect(tables.rowCount).toBe(0);
    const col = await pg().admin.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name = 'sale_voids' AND column_name = 'business_date'`,
    );
    expect(col.rowCount).toBe(0);
    const idx = await pg().admin.query(
      `SELECT 1 FROM pg_indexes WHERE indexname = 'uq_sale_voids_one_per_sale'`,
    );
    expect(idx.rowCount).toBe(0);

    await pg().admin.query(readFileSync(UP_PATH, "utf8"));
    const again = await pg().admin.query<{ business_date: string }>(
      `SELECT business_date::text AS business_date FROM sale_voids WHERE id = $1`,
      [VOID_1],
    );
    expect(again.rows[0]?.business_date).toBe("2026-05-02");
  });
});
