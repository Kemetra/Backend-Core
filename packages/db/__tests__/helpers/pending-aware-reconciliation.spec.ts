/**
 * RT-428 (RT-289 DC-7) — the pending-aware operational position per (store,
 * product) and the dual-read cutover equivalence report (977, 980), against a
 * real Postgres with every migration applied.
 *
 * Fixtures are seeded on the superuser pool; every read runs on the
 * non-superuser `app_test` pool inside `runWithTenantContext` (RLS + FORCE).
 * Each case uses its own tenant.
 *
 * Proves, per DC-7 term:
 *   - a pending sale effect and a rejected sale effect are pending-ERP terms;
 *   - a not-posted manual adjustment is a pending-Retail term;
 *   - a confirmed effect is neither, and its erp_confirmed_at is reported (the
 *     stale-snapshot input);
 *   - an erp_neutral effect is neither;
 *   - expected_erp_book = position − pending ERP − pending Retail, exactly;
 *   - a tenant that has not activated sale effects has no pending-aware
 *     position (the legacy 017 path applies);
 *   - the equivalence report: legacy vs pending-aware difference to the Bin.
 */
import type { PoolClient } from "pg";

import { activateSaleEffects } from "../../src/helpers/inventory-effects/activation";
import {
  buildCutoverEquivalenceReport,
  isStorePendingAware,
  readPendingAwarePositions,
} from "../../src/helpers/inventory-effects/pending-aware";
import { runWithTenantContext } from "../../src/middleware/tenant-context";
import { applyAllUpAndCreateAppRole, startPgEnv, stopPgEnv, type PgTestEnv } from "../_helpers/postgres-container";

const ACTOR = "0a000000-0000-7000-8000-000000428c00";

let env: PgTestEnv | null = null;
let seq = 0;

function pg(): PgTestEnv {
  if (!env) throw new Error("env not initialized");
  return env;
}
const skip = (): boolean => env === null;

function uuid(): string {
  seq += 1;
  return `0a000000-0000-7000-8000-${(0x428c00000000 + seq).toString(16)}`;
}

interface Fixture {
  readonly tenantId: string;
  readonly storeId: string;
  readonly productId: string;
  readonly warehouse: string;
  readonly locationId: string;
}

/** A tenant, one mapped store, product P (ITEM-1) and a Bin snapshot P = 10. */
async function seedTenant(): Promise<Fixture> {
  const a = pg().admin;
  const tenantId = uuid();
  const storeId = uuid();
  const productId = uuid();
  const warehouse = `WH-428-${seq}`;
  await a.query(`INSERT INTO tenants (id, slug, name) VALUES ($1, $2, 'T')`, [tenantId, `rt428-${seq}`]);
  await a.query(`INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $2, $3, 'S')`, [storeId, tenantId, `S${seq}`]);
  await a.query(
    `INSERT INTO tenant_products (id, tenant_id, name, tax_category, created_by, updated_by) VALUES ($1, $2, 'P', 'standard', $3, $3)`,
    [productId, tenantId, ACTOR],
  );
  await a.query(
    `INSERT INTO erpnext_item_map (id, tenant_id, tenant_product_id, erpnext_item_ref, state, suggestion_source, confirmed_by, confirmed_at)
     VALUES (gen_random_uuid(), $1, $2, 'ITEM-1', 'confirmed', 'manual', $3, now())`,
    [tenantId, productId, ACTOR],
  );
  await a.query(
    `INSERT INTO erpnext_warehouse_map (id, tenant_id, store_id, purpose, erpnext_warehouse_ref, set_by, version)
     VALUES (gen_random_uuid(), $1, $2, 'stock', $3, $4, 1)`,
    [tenantId, storeId, warehouse, ACTOR],
  );
  const locationId = (
    await a.query<{ id: string }>(`SELECT id FROM stock_locations WHERE store_id = $1 AND kind = 'primary'`, [storeId])
  ).rows[0]!.id;
  const f = { tenantId, storeId, productId, warehouse, locationId };
  await seedSnapshot(f, "10", new Date(Date.now() - 60_000).toISOString());
  return f;
}

async function seedSnapshot(f: Fixture, quantity: string, readAt: string): Promise<void> {
  const runId = uuid();
  const report = {
    runRef: runId,
    erpnextWarehouseRef: f.warehouse,
    readAt,
    recordedAt: readAt,
    complete: true,
    entries: [{ erpnextItemRef: "ITEM-1", tenant_product_ref: f.productId, quantity, stockUom: "Nos" }],
  };
  await pg().admin.query(
    `INSERT INTO erpnext_reconciliation_run (id, tenant_id, store_id, kind, trigger, status, finished_at, summary)
     VALUES ($1, $2, $3, 'stock', 'on_demand', 'completed', now(), $4::jsonb)`,
    [runId, f.tenantId, f.storeId, JSON.stringify({ bin_view_report: report })],
  );
}

/** A posting row for a fresh sale (the intent a sale effect links to). */
async function seedPosting(f: Fixture, status: string): Promise<string> {
  const saleId = uuid();
  await pg().admin.query(
    `INSERT INTO sales (id, tenant_id, store_id, currency_code, pos_total, occurred_at, business_date,
                        source_system, external_id, payload_hash, created_by)
     VALUES ($1, $2, $3, 'EGP', 0, now(), current_date, 'pos', $4, $5, $6)`,
    [saleId, f.tenantId, f.storeId, `x-${saleId}`, "0".repeat(64), ACTOR],
  );
  const r = await pg().admin.query<{ id: string }>(
    `INSERT INTO erpnext_posting_status (tenant_id, store_id, sale_id, kind, source_ref_id, source_system, external_id,
                                         payload_hash, status, document_ref, posted_at)
     VALUES ($1, $2, $3, 'sale_post', $3, 'pos', $4, $5, $6,
             CASE WHEN $6 = 'posted' THEN '{"name":"SINV"}' END, CASE WHEN $6 = 'posted' THEN now() END)
     RETURNING id`,
    [f.tenantId, f.storeId, saleId, `x-${saleId}`, "0".repeat(64), status],
  );
  return r.rows[0]!.id;
}

type EffectState = "pending" | "rejected" | "reconciliation_required" | "confirmed" | "not_posted" | "erp_neutral";

/** One effect at the primary/sellable position, with its integration row. */
async function seedEffect(f: Fixture, quantity: string, state: EffectState, confirmedAt?: string): Promise<void> {
  const effectId = uuid();
  const sale = state !== "not_posted" && state !== "erp_neutral";
  await pg().admin.query(
    `INSERT INTO stock_movements (id, tenant_id, store_id, movement_type, quantity, stocking_unit, tenant_product_ref,
                                  occurred_at, created_by, origin, event_type, event_ref_id, stock_location_id, inventory_status)
     VALUES ($1, $2, $3, $4, $5::numeric, 'Nos', $6, now(), $7, 'retail', $8, $9, $10, 'sellable')`,
    [
      effectId,
      f.tenantId,
      f.storeId,
      Number(quantity) < 0 ? "outbound" : "adjustment",
      quantity,
      f.productId,
      ACTOR,
      sale ? "sale" : "adjustment",
      uuid(),
      f.locationId,
    ],
  );
  const postingId = sale ? await seedPosting(f, state === "confirmed" ? "posted" : "pending") : null;
  await pg().admin.query(
    `INSERT INTO inventory_effect_integration (effect_id, tenant_id, state, posting_status_id, erp_document_ref, erp_confirmed_at)
     VALUES ($1, $2, $3, $4, CASE WHEN $3 IN ('confirmed', 'reconciliation_required') THEN '{"name":"SINV"}' END, $5)`,
    [effectId, f.tenantId, state, postingId, state === "confirmed" ? (confirmedAt ?? new Date().toISOString()) : null],
  );
}

function asTenant<T>(f: Fixture, work: (c: PoolClient) => Promise<T>): Promise<T> {
  return runWithTenantContext(pg().app, { tenantId: f.tenantId, isPlatformAdmin: false }, work);
}

async function activated(): Promise<Fixture> {
  const f = await seedTenant();
  // A pre-activation manual movement: absorbed by the anchor (RT-289 Q3).
  await seedEffect(f, "4", "not_posted");
  const outcome = await asTenant(f, (c) => activateSaleEffects(c, { tenantId: f.tenantId, actorId: ACTOR }));
  if (outcome.kind !== "activated") throw new Error(`not activated: ${JSON.stringify(outcome)}`);
  return f;
}

async function positionOf(f: Fixture) {
  const rows = await asTenant(f, (c) => readPendingAwarePositions(c, f.storeId));
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[pending-aware-reconciliation.spec] Docker NOT AVAILABLE — skipping: ${String(err)}\n`);
      return;
    }
    throw err;
  }
  await applyAllUpAndCreateAppRole(env);
}, 240_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

describe("readPendingAwarePositions — DC-7 terms", () => {
  it("a pending sale effect is a pending-ERP term", async () => {
    if (skip()) return;
    const f = await activated();
    await seedEffect(f, "-2", "pending");
    expect(await positionOf(f)).toMatchObject({
      anchorQuantity: "10.000000",
      operationalPosition: "8.000000",
      pendingErp: "-2.0000",
      pendingRetail: "0",
      expectedErpBook: "10.000000",
      latestErpConfirmedAt: null,
      operationalUnit: "Nos",
      erpStockUom: "Nos",
    });
  });

  it("a rejected and a reconciliation_required sale effect are pending-ERP terms", async () => {
    if (skip()) return;
    const f = await activated();
    await seedEffect(f, "-3", "rejected");
    await seedEffect(f, "-1", "reconciliation_required");
    expect(await positionOf(f)).toMatchObject({
      operationalPosition: "6.000000",
      pendingErp: "-4.0000",
      expectedErpBook: "10.000000",
    });
  });

  it("a not-posted manual adjustment after activation is a pending-Retail term", async () => {
    if (skip()) return;
    const f = await activated();
    await seedEffect(f, "5", "not_posted");
    expect(await positionOf(f)).toMatchObject({
      operationalPosition: "15.000000",
      pendingErp: "0",
      pendingRetail: "5.0000",
      expectedErpBook: "10.000000",
    });
  });

  it("a confirmed effect is no term and reports its confirmation time; erp_neutral is no term", async () => {
    if (skip()) return;
    const f = await activated();
    const confirmedAt = new Date().toISOString();
    await seedEffect(f, "-2", "confirmed", confirmedAt);
    await seedEffect(f, "0", "erp_neutral");
    const p = await positionOf(f);
    expect(p).toMatchObject({ operationalPosition: "8.000000", pendingErp: "0", pendingRetail: "0", expectedErpBook: "8.000000" });
    expect(new Date(p.latestErpConfirmedAt!).toISOString()).toBe(confirmedAt);
  });

  it("a tenant without activated sale effects has no pending-aware position (legacy path)", async () => {
    if (skip()) return;
    const f = await seedTenant();
    await seedEffect(f, "4", "not_posted");
    expect(await asTenant(f, (c) => readPendingAwarePositions(c, f.storeId))).toEqual([]);
    expect(await asTenant(f, (c) => isStorePendingAware(c, f.storeId))).toBe(false);
  });

  it("an activated store is pending-aware even with no anchored line and no effect", async () => {
    if (skip()) return;
    const f = await seedTenant();
    await pg().admin.query(`DELETE FROM erpnext_item_map WHERE tenant_id = $1`, [f.tenantId]);
    const outcome = await asTenant(f, (c) => activateSaleEffects(c, { tenantId: f.tenantId, actorId: ACTOR }));
    expect(outcome.kind).toBe("activated");
    expect(await asTenant(f, (c) => readPendingAwarePositions(c, f.storeId))).toEqual([]);
    expect(await asTenant(f, (c) => isStorePendingAware(c, f.storeId))).toBe(true);
  });

  it("another tenant's context sees no position", async () => {
    if (skip()) return;
    const f = await activated();
    const other = await seedTenant();
    expect(await asTenant(other, (c) => readPendingAwarePositions(c, f.storeId))).toEqual([]);
    expect(await asTenant(other, (c) => isStorePendingAware(c, f.storeId))).toBe(false);
  });
});

describe("buildCutoverEquivalenceReport — dual read (977, 980)", () => {
  it("shows the legacy raw SUM diverging while the pending-aware expected book matches the Bin", async () => {
    if (skip()) return;
    const f = await activated();
    await seedEffect(f, "-2", "pending");
    const rows = await asTenant(f, (c) => buildCutoverEquivalenceReport(c));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      storeId: f.storeId,
      tenantProductRef: f.productId,
      legacyOnHand: "2.0000",
      expectedErpBook: "10.000000",
      latestBinQuantity: "10",
      legacyDifference: "8.0000",
      pendingAwareDifference: "0.000000",
      equivalent: true,
      snapshotStale: false,
    });
  });

  it("flags a Bin read before a confirmation as stale, and a true divergence as not equivalent", async () => {
    if (skip()) return;
    const f = await activated();
    await seedEffect(f, "-2", "confirmed");
    const rows = await asTenant(f, (c) => buildCutoverEquivalenceReport(c));
    expect(rows[0]).toMatchObject({ pendingAwareDifference: "2.000000", equivalent: false, snapshotStale: true });
    // A newer snapshot that still disagrees is a divergence, not stale.
    await seedSnapshot(f, "9", new Date(Date.now() + 60_000).toISOString());
    const later = await asTenant(f, (c) => buildCutoverEquivalenceReport(c));
    expect(later[0]).toMatchObject({ pendingAwareDifference: "1.000000", equivalent: false, snapshotStale: false });
  });
});
