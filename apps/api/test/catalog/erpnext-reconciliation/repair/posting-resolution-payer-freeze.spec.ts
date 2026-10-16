/**
 * RT-418 — an operator re-resolution (`freezeOperatorResolution`, RT-333)
 * freezes the payer's ERPNext Customer link as it is NOW into the new
 * resolution version (`erpnext_posting_resolution.payer_external_ref`), and a
 * reversal copies its sale's current version (lineage). A sale without
 * responsibilities freezes NULL.
 *
 * Runs the writer directly on a tenant-scoped app-role client (RLS) against a
 * real Postgres. Docker policy: HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import { runWithTenantContext } from "@data-pulse-2/db";

import { freezeOperatorResolution } from "../../../../src/catalog/erpnext-reconciliation/posting-resolution.writer";
import { applyAllUpAndCreateAppRole, startPgEnv, stopPgEnv, type PgTestEnv } from "../../../_helpers/postgres-container";
import {
  ACTOR_A,
  PRODUCT_A_ACTIVE,
  seedCatalogIsolationFixture,
  STORE_A_X,
  TENANT_A,
} from "../../__support__/isolation-harness";

const PAYER = "0a000000-0000-7000-8000-000000418ca1";
const SALE_CREDIT = "0a000000-0000-7000-8000-000000418cb1";
const SALE_CASH = "0a000000-0000-7000-8000-000000418cb2";
const POST_CREDIT = "0a000000-0000-7000-8000-000000418cc1";
const POST_CASH = "0a000000-0000-7000-8000-000000418cc2";
const VOID_ID = "0a000000-0000-7000-8000-000000418cd1";
const REVERSAL = "0a000000-0000-7000-8000-000000418cc3";

let env: PgTestEnv | null = null;
let skip = false;

async function seedSale(id: string, externalId: string, responsibilityCount: number): Promise<void> {
  const a = env!.admin;
  await a.query(
    `INSERT INTO sales
       (id, tenant_id, store_id, currency_code, pos_total, occurred_at, business_date,
        source_system, external_id, payload_hash, created_by, responsibility_count)
     VALUES ($1, $2, $3, 'EGP', 10, now(), '2026-10-16', 'pos-418', $4, $5, $6, $7)`,
    [id, TENANT_A, STORE_A_X, externalId, "e".repeat(64), ACTOR_A, responsibilityCount],
  );
  await a.query(
    `INSERT INTO sale_lines
       (id, sale_id, tenant_id, store_id, line_name, unit_price, currency_code, quantity, line_amount, unit, tenant_product_ref)
     VALUES (gen_random_uuid(), $1, $2, $3, 'Widget', 10, 'EGP', 1, 10, 'ea', $4)`,
    [id, TENANT_A, STORE_A_X, PRODUCT_A_ACTIVE],
  );
}

async function seedPosting(id: string, saleId: string, kind: "sale_post" | "reversal", sourceRefId: string): Promise<void> {
  await env!.admin.query(
    `INSERT INTO erpnext_posting_status
       (id, tenant_id, store_id, sale_id, kind, source_ref_id, source_system, external_id, payload_hash, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'pos-418', $7, $8, 'pending')`,
    [id, TENANT_A, STORE_A_X, saleId, kind, sourceRefId, `rt418-${id}`, "e".repeat(64)],
  );
}

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    await seedCatalogIsolationFixture(env);
    const a = env.admin;
    await a.query(
      `INSERT INTO erpnext_item_map (id, tenant_id, tenant_product_id, erpnext_item_ref, state, suggestion_source, confirmed_by, confirmed_at)
       VALUES (gen_random_uuid(), $1, $2, 'ERP-ITEM-418', 'confirmed', 'manual', $3, now())`,
      [TENANT_A, PRODUCT_A_ACTIVE, ACTOR_A],
    );
    await a.query(
      `INSERT INTO erpnext_warehouse_map (id, tenant_id, store_id, purpose, erpnext_warehouse_ref, set_by, version)
       VALUES (gen_random_uuid(), $1, $2, 'stock', 'ERP-WH-418', $3, 1)`,
      [TENANT_A, STORE_A_X, ACTOR_A],
    );
    await a.query(
      `INSERT INTO payer_account (id, tenant_id, store_id, category, display_name, external_ref)
       VALUES ($1, $2, NULL, 'corporate', 'RT-418 corp', 'CUST-NOW')`,
      [PAYER, TENANT_A],
    );
    await seedSale(SALE_CREDIT, "rt418-rr-credit", 1);
    await a.query(
      `INSERT INTO sale_responsibilities (tenant_id, store_id, sale_id, payer_id, amount, sequence)
       VALUES ($1, $2, $3, $4, 10, 1)`,
      [TENANT_A, STORE_A_X, SALE_CREDIT, PAYER],
    );
    await seedSale(SALE_CASH, "rt418-rr-cash", 0);
    await seedPosting(POST_CREDIT, SALE_CREDIT, "sale_post", SALE_CREDIT);
    await seedPosting(POST_CASH, SALE_CASH, "sale_post", SALE_CASH);
  } catch (err) {
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      skip = true;
      return;
    }
    throw err;
  }
}, 240_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

/** Freeze a new operator version and point the row at it (as the repair services do). */
async function freeze(intentId: string, kind: "sale_post" | "reversal", saleId: string): Promise<number | null> {
  return runWithTenantContext(env!.app, { tenantId: TENANT_A, isPlatformAdmin: false }, async (client) => {
    const v = await freezeOperatorResolution(client, { tenantId: TENANT_A, intentId, kind, saleId, storeId: STORE_A_X });
    if (v !== null) {
      await client.query(`UPDATE erpnext_posting_status SET current_resolution_version = $2 WHERE id = $1`, [intentId, v]);
    }
    return v;
  });
}

async function payerRefs(intentId: string, version: number): Promise<Array<string | null>> {
  const r = await env!.admin.query<{ ref: string | null }>(
    `SELECT payer_external_ref AS ref FROM erpnext_posting_resolution
      WHERE intent_id = $1 AND resolution_version = $2`,
    [intentId, version],
  );
  return r.rows.map((x) => x.ref);
}

describe("RT-418 — freezeOperatorResolution freezes the payer link", () => {
  it("freezes the payer's current link per version, so a corrected link applies only to a new version", async () => {
    if (skip) return;
    const v1 = await freeze(POST_CREDIT, "sale_post", SALE_CREDIT);
    expect(v1).toBe(1);
    expect(await payerRefs(POST_CREDIT, 1)).toEqual(["CUST-NOW"]);

    await env!.admin.query(`UPDATE payer_account SET external_ref = 'CUST-CORRECTED' WHERE id = $1`, [PAYER]);
    expect(await payerRefs(POST_CREDIT, 1)).toEqual(["CUST-NOW"]);
    const v2 = await freeze(POST_CREDIT, "sale_post", SALE_CREDIT);
    expect(v2).toBe(2);
    expect(await payerRefs(POST_CREDIT, 2)).toEqual(["CUST-CORRECTED"]);
  });

  it("a reversal copies its sale's current version, payer link included", async () => {
    if (skip) return;
    await env!.admin.query(
      `INSERT INTO sale_voids (id, sale_id, tenant_id, store_id, business_date, source_system, external_id, payload_hash, created_by)
       VALUES ($1, $2, $3, $4, '2026-10-16', 'pos-418', 'rt418-rr-void', $5, $6)`,
      [VOID_ID, SALE_CREDIT, TENANT_A, STORE_A_X, "e".repeat(64), ACTOR_A],
    );
    await seedPosting(REVERSAL, SALE_CREDIT, "reversal", VOID_ID);
    await env!.admin.query(`UPDATE payer_account SET external_ref = 'CUST-LATER' WHERE id = $1`, [PAYER]);
    const v = await freeze(REVERSAL, "reversal", SALE_CREDIT);
    expect(v).toBe(1);
    expect(await payerRefs(REVERSAL, 1)).toEqual(["CUST-CORRECTED"]);
  });

  it("a sale without responsibilities freezes NULL", async () => {
    if (skip) return;
    expect(await freeze(POST_CASH, "sale_post", SALE_CASH)).toBe(1);
    expect(await payerRefs(POST_CASH, 1)).toEqual([null]);
  });
});
