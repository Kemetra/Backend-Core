/**
 * 0033 — sale tenders + sale device attribution (RT-77; RT-10 D1/D2/D7).
 *
 * Applies every migration before 0033 against a real Postgres, seeds a
 * pre-0033 sale (the UPGRADE path), then proves:
 *   - existing sales keep working: `device_id` is NULL and `tender_count` is 0
 *     (no backfill, no posTotal derivation — RT-10 D8);
 *   - `sales.device_id` references `devices(id)`; `tender_count` is bounded;
 *   - `sale_tenders` is RLS-forced and append-only (SELECT + INSERT only), with
 *     the D2 method CHECK, `amount >= 0` (the contract's
 *     NonNegativeDecimalAmount, owner decision RT-77 10509), a card_external-only
 *     `reference`, one entry per method, and a composite FK to its sale;
 *   - a writer that predates RT-77 (no device_id / tender_count columns in its
 *     INSERT) still inserts a sale — rolling-deploy compatibility;
 *   - down → up round-trips cleanly.
 *
 * Fresh install (the whole chain from empty) is covered by the migrate CLI
 * spec's EXPECTED_MIGRATIONS ledger.
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
const UP_NAME = "0033_sale_tenders.sql";
const UP_PATH = resolve(DRIZZLE_DIR, UP_NAME);
const DOWN_PATH = resolve(DRIZZLE_DIR, "0033_sale_tenders.down.sql");

const TENANT = "0a000000-0000-7000-8000-000000033001";
const STORE = "0a000000-0000-7000-8000-000000033002";
const SALE = "0a000000-0000-7000-8000-000000033003";
const ACTOR = "0a000000-0000-7000-8000-000000033004";
const DEVICE = "0a000000-0000-7000-8000-000000033005";
const SALE_2 = "0a000000-0000-7000-8000-000000033006";

let env: PgTestEnv | null = null;

function pg(): PgTestEnv {
  if (!env) throw new Error("env not initialized");
  return env;
}

async function applyBefore0033(pgEnv: PgTestEnv): Promise<void> {
  const files = readdirSync(DRIZZLE_DIR)
    .filter((n) => /^\d{4}_.+\.sql$/.test(n) && !n.endsWith(".down.sql"))
    .filter((n) => n.localeCompare(UP_NAME) < 0)
    .sort();
  for (const name of files) {
    await pgEnv.admin.query(readFileSync(resolve(DRIZZLE_DIR, name), "utf8"));
  }
  await ensureAppRole(pgEnv);
}

/** A sale in the pre-RT-77 writer shape: no device_id, no tender_count. */
async function insertLegacySale(id: string, externalId: string): Promise<void> {
  await pg().admin.query(
    `INSERT INTO sales
       (id, tenant_id, store_id, currency_code, pos_total, occurred_at,
        business_date, source_system, external_id, payload_hash, created_by)
     VALUES ($1, $2, $3, 'EGP', 10, '2026-05-01T10:00:00Z', '2026-05-01',
             'pos-1', $4, $5, $6)`,
    [id, TENANT, STORE, externalId, "b".repeat(64), ACTOR],
  );
}

async function insertTender(
  method: string,
  amount: string,
  reference: string | null = null,
  saleId: string = SALE,
): Promise<void> {
  await pg().admin.query(
    `INSERT INTO sale_tenders
       (sale_id, tenant_id, store_id, method, amount, currency_code, reference)
     VALUES ($1, $2, $3, $4, $5::numeric, 'EGP', $6)`,
    [saleId, TENANT, STORE, method, amount, reference],
  );
}

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[0033-sale-tenders.spec] Docker NOT AVAILABLE — skipping: ${String(err)}\n`);
      return;
    }
    throw err;
  }
  await applyBefore0033(env);
  await env.admin.query(
    `INSERT INTO tenants (id, name, slug) VALUES ($1, 'RT-77 tenant', 'rt77-tenant')`,
    [TENANT],
  );
  await env.admin.query(
    `INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $2, 'rt77', 'RT-77 store')`,
    [STORE, TENANT],
  );
  await env.admin.query(
    `INSERT INTO devices (id, tenant_id, store_id, token_hash)
     VALUES ($1, $2, $3, decode(repeat('ab', 32), 'hex'))`,
    [DEVICE, TENANT, STORE],
  );
  await insertLegacySale(SALE, "rt77-sale");
}, 240_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

const skip = (): boolean => env === null;

describe("0033_sale_tenders — upgrade over existing sales", () => {
  it("applies cleanly over a pre-RT-77 sale", async () => {
    if (skip()) return;
    await pg().admin.query(readFileSync(UP_PATH, "utf8"));
  });

  it("leaves existing sales device-unknown and tender-unknown (no backfill, D8)", async () => {
    if (skip()) return;
    const r = await pg().admin.query<{ device_id: string | null; tender_count: number }>(
      `SELECT device_id, tender_count FROM sales WHERE id = $1`,
      [SALE],
    );
    expect(r.rows[0]).toEqual({ device_id: null, tender_count: 0 });
    const t = await pg().admin.query(`SELECT 1 FROM sale_tenders`);
    expect(t.rowCount).toBe(0);
  });

  it("still accepts a sale from a writer that predates RT-77 (rolling deploy)", async () => {
    if (skip()) return;
    await insertLegacySale(SALE_2, "rt77-sale-2");
    const r = await pg().admin.query<{ tender_count: number }>(
      `SELECT tender_count FROM sales WHERE id = $1`,
      [SALE_2],
    );
    expect(r.rows[0]?.tender_count).toBe(0);
  });
});

describe("0033_sale_tenders — sales.device_id and sales.tender_count", () => {
  it("references devices(id): an unknown device is rejected, a real one accepted", async () => {
    if (skip()) return;
    await expect(
      pg().admin.query(`UPDATE sales SET device_id = $1 WHERE id = $2`, [
        "0a000000-0000-7000-8000-0000000330ff",
        SALE_2,
      ]),
    ).rejects.toThrow(/fk_sales_device/);
    await pg().admin.query(`UPDATE sales SET device_id = $1 WHERE id = $2`, [DEVICE, SALE_2]);
  });

  it("bounds tender_count to the number of D2 methods", async () => {
    if (skip()) return;
    await expect(
      pg().admin.query(`UPDATE sales SET tender_count = 3 WHERE id = $1`, [SALE_2]),
    ).rejects.toThrow(/sales_tender_count_range/);
    await expect(
      pg().admin.query(`UPDATE sales SET tender_count = -1 WHERE id = $1`, [SALE_2]),
    ).rejects.toThrow(/sales_tender_count_range/);
  });
});

describe("0033_sale_tenders — sale_tenders table", () => {
  it("is RLS enabled and forced", async () => {
    if (skip()) return;
    const r = await pg().admin.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'sale_tenders'`,
    );
    expect(r.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  });

  it("is append-only: SELECT + INSERT policies only, no UPDATE / DELETE", async () => {
    if (skip()) return;
    const r = await pg().admin.query<{ cmd: string }>(
      `SELECT cmd FROM pg_policies WHERE tablename = 'sale_tenders' ORDER BY cmd`,
    );
    expect(r.rows.map((x) => x.cmd)).toEqual(["INSERT", "SELECT"]);
  });

  it("accepts a split cash + card_external tender, a zero amount and a card reference", async () => {
    if (skip()) return;
    await insertTender("cash", "0");
    await insertTender("card_external", "10.0000", "A1B2C3");
    const r = await pg().admin.query<{ method: string; amount: string; reference: string | null }>(
      `SELECT method, amount::text AS amount, reference FROM sale_tenders
        WHERE sale_id = $1 ORDER BY method`,
      [SALE],
    );
    expect(r.rows).toEqual([
      { method: "card_external", amount: "10.0000", reference: "A1B2C3" },
      { method: "cash", amount: "0.0000", reference: null },
    ]);
  });

  it("rejects a second entry for the same method on one sale", async () => {
    if (skip()) return;
    await expect(insertTender("cash", "1")).rejects.toThrow(/uq_sale_tenders_sale_method/);
  });

  it("rejects a method outside D2 (vouchers are excluded)", async () => {
    if (skip()) return;
    await expect(insertTender("voucher", "1", null, SALE_2)).rejects.toThrow(
      /sale_tenders_method_valid/,
    );
  });

  it("rejects a negative amount", async () => {
    if (skip()) return;
    await expect(insertTender("cash", "-1", null, SALE_2)).rejects.toThrow(
      /sale_tenders_amount_non_negative/,
    );
  });

  it("allows a reference only on card_external, and only in the contract shape", async () => {
    if (skip()) return;
    await expect(insertTender("cash", "1", "A1B2C3", SALE_2)).rejects.toThrow(
      /sale_tenders_reference_card_only/,
    );
    await expect(insertTender("card_external", "1", "not-a-ref", SALE_2)).rejects.toThrow(
      /sale_tenders_reference_card_only/,
    );
  });

  it("rejects a tender whose (sale, tenant, store) does not match its sale", async () => {
    if (skip()) return;
    const OTHER_STORE = "0a000000-0000-7000-8000-000000033007";
    await pg().admin.query(
      `INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $2, 'rt77b', 'RT-77 store B')`,
      [OTHER_STORE, TENANT],
    );
    await expect(
      pg().admin.query(
        `INSERT INTO sale_tenders (sale_id, tenant_id, store_id, method, amount, currency_code)
         VALUES ($1, $2, $3, 'cash', 1, 'EGP')`,
        [SALE_2, TENANT, OTHER_STORE],
      ),
    ).rejects.toThrow(/fk_sale_tenders_sale_tenant_store/);
  });
});

describe("0033_sale_tenders — down → up round-trip", () => {
  it("down removes the table and both sales columns; up re-applies", async () => {
    if (skip()) return;
    await pg().admin.query(readFileSync(DOWN_PATH, "utf8"));
    const table = await pg().admin.query(
      `SELECT 1 FROM information_schema.tables WHERE table_name = 'sale_tenders'`,
    );
    expect(table.rowCount).toBe(0);
    const cols = await pg().admin.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name = 'sales' AND column_name IN ('device_id', 'tender_count')`,
    );
    expect(cols.rowCount).toBe(0);

    await pg().admin.query(readFileSync(UP_PATH, "utf8"));
    const again = await pg().admin.query<{ tender_count: number }>(
      `SELECT tender_count FROM sales WHERE id = $1`,
      [SALE],
    );
    expect(again.rows[0]?.tender_count).toBe(0);
  });
});
