/**
 * 0041 — sale tender-line identity (RT-360; contract RT-359; decisions RT-264 D1–D4).
 *
 * Applies every migration before 0041 against a real Postgres, seeds a
 * pre-0041 tendered sale (the UPGRADE path), then proves:
 *   - existing tenders keep working: `tender_ref` and `sequence` are NULL
 *     (no backfill, RT-264 D2);
 *   - a legacy (ref-less) tender is still one per method per sale;
 *   - tenders carrying a `tender_ref` may share a method (a same-method split
 *     tender), with the ref unique within the sale;
 *   - `sequence` is >= 1 and unique within the sale;
 *   - `sales.tender_count` is no longer capped at 2;
 *   - down refuses loudly while same-method rows exist, and otherwise
 *     round-trips with up.
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
const UP_NAME = "0041_sale_tender_ref.sql";
const UP_PATH = resolve(DRIZZLE_DIR, UP_NAME);
const DOWN_PATH = resolve(DRIZZLE_DIR, "0041_sale_tender_ref.down.sql");

const TENANT = "0a000000-0000-7000-8000-000000041001";
const STORE = "0a000000-0000-7000-8000-000000041002";
const ACTOR = "0a000000-0000-7000-8000-000000041004";
const LEGACY_SALE = "0a000000-0000-7000-8000-000000041003";
const REF_SALE = "0a000000-0000-7000-8000-000000041006";
const REF_1 = "0a000000-0000-7000-8000-0000000410a1";
const REF_2 = "0a000000-0000-7000-8000-0000000410a2";
const REF_3 = "0a000000-0000-7000-8000-0000000410a3";

let env: PgTestEnv | null = null;

function pg(): PgTestEnv {
  if (!env) throw new Error("env not initialized");
  return env;
}

async function applyBefore0041(pgEnv: PgTestEnv): Promise<void> {
  const files = readdirSync(DRIZZLE_DIR)
    .filter((n) => /^\d{4}_.+\.sql$/.test(n) && !n.endsWith(".down.sql"))
    .filter((n) => n.localeCompare(UP_NAME) < 0)
    .sort();
  for (const name of files) {
    await pgEnv.admin.query(readFileSync(resolve(DRIZZLE_DIR, name), "utf8"));
  }
  await ensureAppRole(pgEnv);
}

async function insertSale(id: string, externalId: string, tenderCount = 0): Promise<void> {
  await pg().admin.query(
    `INSERT INTO sales
       (id, tenant_id, store_id, currency_code, pos_total, occurred_at,
        business_date, source_system, external_id, payload_hash, created_by,
        tender_count)
     VALUES ($1, $2, $3, 'EGP', 10, '2026-10-01T10:00:00Z', '2026-10-01',
             'pos-1', $4, $5, $6, $7)`,
    [id, TENANT, STORE, externalId, "c".repeat(64), ACTOR, tenderCount],
  );
}

/** A ref-bearing tender's line identity; omitted for a legacy (unref'd) tender. */
interface TenderIdentity {
  tenderRef: string;
  sequence: number;
}

async function insertTender(
  saleId: string,
  method: string,
  amount: string,
  identity?: TenderIdentity,
): Promise<void> {
  await pg().admin.query(
    `INSERT INTO sale_tenders
       (sale_id, tenant_id, store_id, method, amount, currency_code, tender_ref, sequence)
     VALUES ($1, $2, $3, $4, $5::numeric, 'EGP', $6, $7)`,
    [saleId, TENANT, STORE, method, amount, identity?.tenderRef ?? null, identity?.sequence ?? null],
  );
}

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[0041-sale-tender-ref.spec] Docker NOT AVAILABLE — skipping: ${String(err)}\n`);
      return;
    }
    throw err;
  }
  await applyBefore0041(env);
  await env.admin.query(
    `INSERT INTO tenants (id, name, slug) VALUES ($1, 'RT-360 tenant', 'rt360-tenant')`,
    [TENANT],
  );
  await env.admin.query(
    `INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $2, 'rt360', 'RT-360 store')`,
    [STORE, TENANT],
  );
  // A pre-0041 tendered sale, written by the RT-77 writer (no ref, no sequence).
  await insertSale(LEGACY_SALE, "rt360-legacy", 1);
  await pg().admin.query(
    `INSERT INTO sale_tenders (sale_id, tenant_id, store_id, method, amount, currency_code)
     VALUES ($1, $2, $3, 'cash', 10, 'EGP')`,
    [LEGACY_SALE, TENANT, STORE],
  );
  await env.admin.query(readFileSync(UP_PATH, "utf8"));
  await insertSale(REF_SALE, "rt360-ref", 3);
}, 240_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

const skip = (): boolean => env === null;

describe("0041_sale_tender_ref — upgrade over existing tenders", () => {
  it("leaves every existing tender ref-less and unsequenced (no backfill, D2)", async () => {
    if (skip()) return;
    const r = await pg().admin.query<{ tender_ref: string | null; sequence: number | null }>(
      `SELECT tender_ref, sequence FROM sale_tenders WHERE sale_id = $1`,
      [LEGACY_SALE],
    );
    expect(r.rows).toEqual([{ tender_ref: null, sequence: null }]);
  });

  it("still rejects a second ref-less tender of the same method on one sale", async () => {
    if (skip()) return;
    await expect(insertTender(LEGACY_SALE, "cash", "1")).rejects.toThrow(
      /uq_sale_tenders_sale_method_legacy/,
    );
  });
});

describe("0041_sale_tender_ref — tender-line identity", () => {
  it("accepts same-method tenders that each carry a distinct tender_ref and sequence", async () => {
    if (skip()) return;
    await insertTender(REF_SALE, "cash", "6", { tenderRef: REF_1, sequence: 1 });
    await insertTender(REF_SALE, "cash", "4", { tenderRef: REF_2, sequence: 2 });
    const r = await pg().admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM sale_tenders WHERE sale_id = $1 AND method = 'cash'`,
      [REF_SALE],
    );
    expect(r.rows[0]?.n).toBe("2");
  });

  it("rejects a tender_ref repeated within one sale", async () => {
    if (skip()) return;
    await expect(
      insertTender(REF_SALE, "card_external", "1", { tenderRef: REF_1, sequence: 3 }),
    ).rejects.toThrow(/uq_sale_tenders_sale_tender_ref/);
  });

  it("rejects a sequence repeated within one sale", async () => {
    if (skip()) return;
    await expect(
      insertTender(REF_SALE, "card_external", "1", { tenderRef: REF_3, sequence: 2 }),
    ).rejects.toThrow(/uq_sale_tenders_sale_sequence/);
  });

  it("rejects a sequence below 1", async () => {
    if (skip()) return;
    await expect(
      insertTender(REF_SALE, "card_external", "1", { tenderRef: REF_3, sequence: 0 }),
    ).rejects.toThrow(/sale_tenders_sequence_positive/);
  });

  it("no longer caps sales.tender_count at 2, but still rejects a negative count", async () => {
    if (skip()) return;
    const r = await pg().admin.query<{ tender_count: number }>(
      `SELECT tender_count FROM sales WHERE id = $1`,
      [REF_SALE],
    );
    expect(r.rows[0]?.tender_count).toBe(3);
    await expect(insertSale("0a000000-0000-7000-8000-000000041007", "rt360-neg", -1)).rejects.toThrow(
      /sales_tender_count_range/,
    );
  });
});

describe("0041_sale_tender_ref — down → up round-trip", () => {
  it("down refuses while a sale holds same-method tenders (nothing is silently dropped)", async () => {
    if (skip()) return;
    await expect(pg().admin.query(readFileSync(DOWN_PATH, "utf8"))).rejects.toThrow();
    const cols = await pg().admin.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name = 'sale_tenders' AND column_name IN ('tender_ref', 'sequence')`,
    );
    expect(cols.rowCount).toBe(2);
  });

  it("down removes both columns and restores one-per-method; up re-applies", async () => {
    if (skip()) return;
    await pg().admin.query(`DELETE FROM sale_tenders WHERE sale_id = $1`, [REF_SALE]);
    await pg().admin.query(`DELETE FROM sales WHERE id = $1`, [REF_SALE]);
    await pg().admin.query(readFileSync(DOWN_PATH, "utf8"));
    const cols = await pg().admin.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name = 'sale_tenders' AND column_name IN ('tender_ref', 'sequence')`,
    );
    expect(cols.rowCount).toBe(0);
    await expect(
      pg().admin.query(
        `INSERT INTO sale_tenders (sale_id, tenant_id, store_id, method, amount, currency_code)
         VALUES ($1, $2, $3, 'cash', 1, 'EGP')`,
        [LEGACY_SALE, TENANT, STORE],
      ),
    ).rejects.toThrow(/uq_sale_tenders_sale_method/);

    await pg().admin.query(readFileSync(UP_PATH, "utf8"));
    const again = await pg().admin.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name = 'sale_tenders' AND column_name IN ('tender_ref', 'sequence')`,
    );
    expect(again.rowCount).toBe(2);
  });
});
