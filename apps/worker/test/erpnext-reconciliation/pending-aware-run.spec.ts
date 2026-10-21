/**
 * RT-428 — the 017 stock run compares like with like (RT-289 DC-7) for a
 * tenant with activated sale effects, and stays byte-for-byte legacy for a
 * tenant without them. Testcontainers; drives `ReconciliationRunProcessor`
 * with the live `ReportBackedBinView` seam.
 *
 * One case per class: a pending sale and a rejected sale (expected pending
 * ERP), a not-posted manual adjustment (expected pending Retail), a Bin read
 * before a confirmation (ERP snapshot stale), a true divergence, in sync, and
 * the UOM finding. Each case uses its own tenant. The 009 ledger and the
 * integration rows are unchanged by a run (non-destructive).
 *
 * Docker policy mirrors the other worker DB specs: HARD failure unless
 * MIGRATION_TEST_ALLOW_SKIP=1. Run with WORKER_INCLUDE_DB_TESTS=1.
 */
import { activateSaleEffects, runWithTenantContext } from "@data-pulse-2/db";

import {
  ensureAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../../../packages/db/__tests__/_helpers/postgres-container";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ReconciliationRunProcessor } from "../../src/erpnext-reconciliation/reconciliation-run.processor";
import { ReportBackedBinView } from "../../src/erpnext-reconciliation/report-backed-bin-view";

const ACTOR = "01900000-0000-7000-8000-0000004280ad";
const DRIZZLE_DIR = resolve(__dirname, "..", "..", "..", "..", "packages", "db", "drizzle");

let env: PgTestEnv | null = null;
let skip = false;
let seq = 0;

function uuid(): string {
  seq += 1;
  return `01900000-0000-7000-8000-${(0x428000000000 + seq).toString(16)}`;
}

function guard(): PgTestEnv {
  if (!env) throw new Error("Docker unavailable");
  return env;
}

async function applyAllMigrations(e: PgTestEnv): Promise<void> {
  const files = readdirSync(DRIZZLE_DIR)
    .filter((n) => /^\d{4}_.+\.sql$/.test(n) && !n.endsWith(".down.sql"))
    .sort();
  for (const name of files) await e.admin.query(readFileSync(resolve(DRIZZLE_DIR, name), "utf8"));
  await ensureAppRole(e);
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
  const a = guard().admin;
  const tenantId = uuid();
  const storeId = uuid();
  const productId = uuid();
  const warehouse = `WH-428-${seq}`;
  await a.query(`INSERT INTO tenants (id, slug, name) VALUES ($1, $2, 'T')`, [tenantId, `rt428w-${seq}`]);
  await a.query(`INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $2, $3, 'S')`, [storeId, tenantId, `S${seq}`]);
  await a.query(
    `INSERT INTO users (id, email, password_hash) VALUES ($1, 'rt428@fixture.invalid', NULL) ON CONFLICT (id) DO NOTHING`,
    [ACTOR],
  );
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
  await seedRun(f, { status: "completed", quantity: "10", readAt: new Date(Date.now() - 120_000).toISOString() });
  return f;
}

/** A stock run carrying a recorded Bin report of P. */
async function seedRun(
  f: Fixture,
  opts: { status: "running" | "completed"; quantity: string; readAt: string; stockUom?: string },
): Promise<string> {
  const runId = uuid();
  const report = {
    runRef: runId,
    erpnextWarehouseRef: f.warehouse,
    readAt: opts.readAt,
    recordedAt: opts.readAt,
    complete: true,
    entries: [
      { erpnextItemRef: "ITEM-1", tenant_product_ref: f.productId, quantity: opts.quantity, stockUom: opts.stockUom ?? "Nos" },
    ],
  };
  await guard().admin.query(
    `INSERT INTO erpnext_reconciliation_run (id, tenant_id, store_id, kind, trigger, status, actor_user_id, finished_at, summary)
     VALUES ($1, $2, $3, 'stock', 'on_demand', $4, $5, CASE WHEN $4 = 'completed' THEN now() END, $6::jsonb)`,
    [runId, f.tenantId, f.storeId, opts.status, ACTOR, JSON.stringify({ bin_view_report: report })],
  );
  return runId;
}

type EffectState = "pending" | "rejected" | "confirmed" | "not_posted";

/** One effect at the primary/sellable position with its integration row (and posting row for a sale). */
async function seedEffect(f: Fixture, quantity: string, state: EffectState, unit = "Nos"): Promise<void> {
  const a = guard().admin;
  const effectId = uuid();
  const sale = state !== "not_posted";
  await a.query(
    `INSERT INTO stock_movements (id, tenant_id, store_id, movement_type, quantity, stocking_unit, tenant_product_ref,
                                  occurred_at, created_by, origin, event_type, event_ref_id, stock_location_id, inventory_status)
     VALUES ($1, $2, $3, $4, $5::numeric, $6, $7, now(), $8, 'retail', $9, $10, $11, 'sellable')`,
    [effectId, f.tenantId, f.storeId, Number(quantity) < 0 ? "outbound" : "adjustment", quantity, unit, f.productId, ACTOR,
      sale ? "sale" : "adjustment", uuid(), f.locationId],
  );
  let postingId: string | null = null;
  if (sale) {
    const saleId = uuid();
    await a.query(
      `INSERT INTO sales (id, tenant_id, store_id, currency_code, pos_total, occurred_at, business_date,
                          source_system, external_id, payload_hash, created_by)
       VALUES ($1, $2, $3, 'EGP', 0, now(), current_date, 'pos', $4, $5, $6)`,
      [saleId, f.tenantId, f.storeId, `x-${saleId}`, "0".repeat(64), ACTOR],
    );
    postingId = (
      await a.query<{ id: string }>(
        `INSERT INTO erpnext_posting_status (tenant_id, store_id, sale_id, kind, source_ref_id, source_system, external_id,
                                             payload_hash, status, document_ref, posted_at)
         VALUES ($1, $2, $3, 'sale_post', $3, 'pos', $4, $5, $6,
                 CASE WHEN $6 = 'posted' THEN '{"name":"SINV"}' END, CASE WHEN $6 = 'posted' THEN now() END)
         RETURNING id`,
        [f.tenantId, f.storeId, saleId, `x-${saleId}`, "0".repeat(64),
          state === "confirmed" ? "posted" : state === "rejected" ? "permanently_rejected" : "pending"],
      )
    ).rows[0]!.id;
  }
  await a.query(
    `INSERT INTO inventory_effect_integration (effect_id, tenant_id, state, posting_status_id, erp_document_ref, erp_confirmed_at)
     VALUES ($1, $2, $3, $4, CASE WHEN $3 = 'confirmed' THEN '{"name":"SINV"}' END, CASE WHEN $3 = 'confirmed' THEN now() END)`,
    [effectId, f.tenantId, state, postingId],
  );
}

async function activate(f: Fixture): Promise<void> {
  const outcome = await runWithTenantContext(guard().app, { tenantId: f.tenantId, isPlatformAdmin: false }, (c) =>
    activateSaleEffects(c, { tenantId: f.tenantId, actorId: ACTOR }),
  );
  if (outcome.kind !== "activated") throw new Error(`not activated: ${JSON.stringify(outcome)}`);
}

interface ResultRow {
  mismatch_class: string;
  detail: Record<string, unknown> | null;
}

/** Run a fresh reconciliation of the store against a Bin report; returns P's result row. */
async function reconcile(
  f: Fixture,
  bin: { quantity: string; readAt?: string; stockUom?: string },
): Promise<ResultRow> {
  const e = guard();
  const runId = await seedRun(f, { status: "running", readAt: new Date().toISOString(), ...bin });
  const res = await new ReconciliationRunProcessor(e.app, new ReportBackedBinView(e.app)).process({
    runId,
    tenantId: f.tenantId,
  });
  expect(res.status).toBe("completed");
  const rows = await e.admin.query<ResultRow>(
    `SELECT mismatch_class, detail FROM erpnext_reconciliation_result WHERE run_id = $1 AND source_ref_id = $2`,
    [runId, f.productId],
  );
  expect(rows.rows).toHaveLength(1);
  return rows.rows[0]!;
}

async function activated(): Promise<Fixture> {
  const f = await seedTenant();
  await seedEffect(f, "4", "not_posted"); // pre-activation, absorbed by the anchor (Q3)
  await activate(f);
  return f;
}

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllMigrations(env);
  } catch (err) {
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      skip = true;
      // eslint-disable-next-line no-console
      console.warn(`[pending-aware-run.spec] Docker unavailable: ${String(err)}`);
      return;
    }
    throw err;
  }
}, 240_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

describe("RT-428 — pending-aware classes for an activated tenant", () => {
  it("927 a pending sale the ERP has not booked: expected_pending_erp, with the DC-7 terms in the detail", async () => {
    if (skip) return;
    const f = await activated();
    await seedEffect(f, "-2", "pending");
    const r = await reconcile(f, { quantity: "10" });
    expect(r.mismatch_class).toBe("expected_pending_erp");
    expect(r.detail).toMatchObject({
      dp2_on_hand: "8.000000",
      erpnext_bin: "10",
      expected_erp_book: "10.000000",
      pending_erp: "-2.0000",
      pending_retail: "0",
      legacy_on_hand: "2.0000",
      anchor_generation: 1,
    });
  });

  it("927 a rejected sale: expected_pending_erp", async () => {
    if (skip) return;
    const f = await activated();
    await seedEffect(f, "-3", "rejected");
    expect((await reconcile(f, { quantity: "10" })).mismatch_class).toBe("expected_pending_erp");
  });

  it("928 a not-posted manual adjustment: expected_pending_retail", async () => {
    if (skip) return;
    const f = await activated();
    await seedEffect(f, "5", "not_posted");
    expect((await reconcile(f, { quantity: "10" })).mismatch_class).toBe("expected_pending_retail");
  });

  it("929 a Bin read before the latest confirmation: erp_snapshot_stale", async () => {
    if (skip) return;
    const f = await activated();
    await seedEffect(f, "-2", "confirmed");
    const r = await reconcile(f, { quantity: "10", readAt: new Date(Date.now() - 60_000).toISOString() });
    expect(r.mismatch_class).toBe("erp_snapshot_stale");
  });

  it("926 a confirmed sale the Bin reflects: match", async () => {
    if (skip) return;
    const f = await activated();
    await seedEffect(f, "-2", "confirmed");
    expect((await reconcile(f, { quantity: "8", readAt: new Date(Date.now() + 60_000).toISOString() })).mismatch_class).toBe(
      "match",
    );
  });

  it("930 a residual no term explains: quantity_divergence", async () => {
    if (skip) return;
    const f = await activated();
    await seedEffect(f, "-2", "pending");
    expect((await reconcile(f, { quantity: "9" })).mismatch_class).toBe("quantity_divergence");
  });

  it("a stock UOM that differs from the operational unit: uom_mismatch, never a divergence", async () => {
    if (skip) return;
    const f = await activated();
    await seedEffect(f, "-2", "pending");
    expect((await reconcile(f, { quantity: "3", stockUom: "Box" })).mismatch_class).toBe("uom_mismatch");
  });

  it("is non-destructive: the 009 ledger and the integration rows are unchanged by a run", async () => {
    if (skip) return;
    const f = await activated();
    await seedEffect(f, "-2", "pending");
    const snapshot = (): Promise<unknown[]> =>
      guard()
        .admin.query(
          `SELECT m.id, m.quantity::text, i.state, i.updated_at FROM stock_movements m
             LEFT JOIN inventory_effect_integration i ON i.effect_id = m.id
            WHERE m.tenant_id = $1 ORDER BY m.id`,
          [f.tenantId],
        )
        .then((r) => r.rows);
    const before = await snapshot();
    await reconcile(f, { quantity: "10" });
    expect(await snapshot()).toEqual(before);
  });
});

describe("RT-428 — backward compatibility for a tenant without activated sale effects", () => {
  it("keeps the legacy raw-SUM comparison and classes, with the legacy detail shape", async () => {
    if (skip) return;
    const f = await seedTenant();
    await seedEffect(f, "4", "not_posted");
    await seedEffect(f, "-2", "pending");
    const r = await reconcile(f, { quantity: "10" });
    // Legacy: SUM = 2 vs Bin 10 → quantity_divergence, exactly as before RT-428.
    expect(r).toEqual({ mismatch_class: "quantity_divergence", detail: { dp2_on_hand: "2.0000", erpnext_bin: "10" } });
  });
});
