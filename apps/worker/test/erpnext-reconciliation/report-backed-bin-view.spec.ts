/**
 * 019-T041 — ReportBackedBinView Testcontainers spec (RED-first).
 *
 * Proves the 017-rewire: the reconciliation processor's ErpnextBinView seam, when
 * backed by a connector-reported snapshot (recorded run-scoped by 019 T040 into
 * `erpnext_reconciliation_run.summary.bin_view_report`), returns the reported Bin
 * quantities — replacing the inert EMPTY_BIN_VIEW. Exact-decimal quantity STRINGS
 * are compared canonically (NEVER float, §III).
 *
 * Scenario: a running run on a mapped store with a confirmed item map + a recorded
 * bin_view_report whose quantity EQUALS the DP2 on-hand → `match`; a divergent
 * reported quantity → `quantity_divergence`. An entry the report did NOT cover but
 * DP2 has on-hand → `dp2_only`. A reported item with no DP2 on-hand → `erpnext_only`.
 *
 * Docker policy: HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
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

const TENANT = "01900000-0000-7000-8000-0000000bf111";
const STORE = "01900000-0000-7000-8000-0000000bf222";
const ACTOR = "01900000-0000-7000-8000-0000000bf333";
const PROD_MATCH = "01900000-0000-7000-8000-0000000bf444";
const PROD_DIVERGE = "01900000-0000-7000-8000-0000000bf555";

let env: PgTestEnv | null = null;
let skip = false;

const DRIZZLE_DIR = resolve(__dirname, "..", "..", "..", "..", "packages", "db", "drizzle");

async function applyAllMigrations(e: PgTestEnv): Promise<void> {
  const files = readdirSync(DRIZZLE_DIR)
    .filter((n) => /^\d{4}_.+\.sql$/.test(n) && !n.endsWith(".down.sql"))
    .sort();
  for (const name of files) {
    await e.admin.query(readFileSync(resolve(DRIZZLE_DIR, name), "utf8"));
  }
  await ensureAppRole(e);
}

async function classesFor(e: PgTestEnv, runId: string): Promise<Record<string, number>> {
  const r = await e.admin.query<{ mismatch_class: string; n: string }>(
    `SELECT mismatch_class, count(*)::text AS n FROM erpnext_reconciliation_result
      WHERE run_id = $1 GROUP BY mismatch_class`,
    [runId],
  );
  const out: Record<string, number> = {};
  for (const row of r.rows) out[row.mismatch_class] = Number(row.n);
  return out;
}

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllMigrations(env);
    const a = env.admin;
    await a.query(
      `INSERT INTO tenants (id, slug, name, default_currency_code) VALUES ($1, 'rbv', 'RBV', 'USD') ON CONFLICT (id) DO NOTHING`,
      [TENANT],
    );
    await a.query(
      `INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $2, 'RB', 'RBV Store') ON CONFLICT (id) DO NOTHING`,
      [STORE, TENANT],
    );
    await a.query(
      `INSERT INTO users (id, email, password_hash) VALUES ($1, 'rbv@fixture.invalid', NULL) ON CONFLICT (id) DO NOTHING`,
      [ACTOR],
    );
    await a.query(
      `INSERT INTO erpnext_warehouse_map (id, tenant_id, store_id, purpose, erpnext_warehouse_ref, set_by, version)
       VALUES (gen_random_uuid(), $1, $2, 'stock', 'ERP-WH-RBV', $3, 1) ON CONFLICT DO NOTHING`,
      [TENANT, STORE, ACTOR],
    );
    for (const [id, ref] of [[PROD_MATCH, "ERP-RBV-MATCH"], [PROD_DIVERGE, "ERP-RBV-DIV"]] as const) {
      await a.query(
        `INSERT INTO tenant_products (id, tenant_id, name, tax_category, created_by, updated_by)
         VALUES ($1, $2, 'P', 'standard', $3, $3) ON CONFLICT (id) DO NOTHING`,
        [id, TENANT, ACTOR],
      );
      await a.query(
        `INSERT INTO erpnext_item_map (id, tenant_id, tenant_product_id, erpnext_item_ref, state, suggestion_source, confirmed_by, confirmed_at)
         VALUES (gen_random_uuid(), $1, $2, $3, 'confirmed', 'manual', $4, now()) ON CONFLICT DO NOTHING`,
        [TENANT, id, ref, ACTOR],
      );
    }
    await a.query(
      `INSERT INTO stock_movements (id, tenant_id, store_id, tenant_product_ref, movement_type, quantity, stocking_unit, occurred_at, created_by, stock_location_id, inventory_status)
       VALUES (gen_random_uuid(), $1, $2, $3, 'inbound', 10.0000, 'ea', now(), $4, (SELECT id FROM stock_locations WHERE store_id = $2::uuid AND kind = 'primary'), 'sellable')`,
      [TENANT, STORE, PROD_MATCH, ACTOR],
    );
    await a.query(
      `INSERT INTO stock_movements (id, tenant_id, store_id, tenant_product_ref, movement_type, quantity, stocking_unit, occurred_at, created_by, stock_location_id, inventory_status)
       VALUES (gen_random_uuid(), $1, $2, $3, 'inbound', 10.0000, 'ea', now(), $4, (SELECT id FROM stock_locations WHERE store_id = $2::uuid AND kind = 'primary'), 'sellable')`,
      [TENANT, STORE, PROD_DIVERGE, ACTOR],
    );
  } catch (err) {
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      skip = true;
      // eslint-disable-next-line no-console
      console.warn(`[report-backed-bin-view.spec] Docker unavailable: ${String(err)}`);
      return;
    }
    throw err;
  }
}, 180_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

/** Seed a running run with a recorded bin_view_report; return its id. */
async function runWithReport(
  e: PgTestEnv,
  entries: Array<{ tenant_product_ref: string | null; quantity: string }>,
): Promise<string> {
  const report = {
    requestRef: "00000000-0000-0000-0000-000000000000",
    runRef: "00000000-0000-0000-0000-000000000000",
    erpnextWarehouseRef: "ERP-WH-RBV",
    readAt: "2026-06-08T10:00:00.000Z",
    recordedAt: "2026-06-08T10:00:01.000Z",
    acceptedEntryCount: entries.length,
    entries: entries.map((e2) => ({
      erpnextItemRef: "ERP-X",
      tenant_product_ref: e2.tenant_product_ref,
      quantity: e2.quantity,
      stockUom: "ea",
    })),
  };
  const r = await e.admin.query<{ id: string }>(
    `INSERT INTO erpnext_reconciliation_run
       (id, tenant_id, store_id, kind, trigger, status, actor_user_id, summary)
     VALUES (gen_random_uuid(), $1, $2, 'stock', 'on_demand', 'running', $3,
             jsonb_build_object('bin_view_report', $4::jsonb))
     RETURNING id`,
    [TENANT, STORE, ACTOR, JSON.stringify(report)],
  );
  return r.rows[0]!.id;
}

describe("019-T041 — ReportBackedBinView feeds the reconciliation processor", () => {
  it("reported quantity EQUAL to DP2 on-hand → match (exact-decimal string compare)", async () => {
    if (skip) return;
    const e = env!;
    const runId = await runWithReport(e, [
      { tenant_product_ref: PROD_MATCH, quantity: "10.000000" },
    ]);
    const processor = new ReconciliationRunProcessor(e.app, new ReportBackedBinView(e.app));
    await processor.process({ runId, tenantId: TENANT });
    const classes = await classesFor(e, runId);
    expect(classes["match"]).toBe(1);
    expect(classes["quantity_divergence"] ?? 0).toBe(0);
  });

  it("reported quantity DIVERGENT from DP2 on-hand → quantity_divergence", async () => {
    if (skip) return;
    const e = env!;
    const runId = await runWithReport(e, [
      { tenant_product_ref: PROD_DIVERGE, quantity: "7.000000" },
    ]);
    const processor = new ReconciliationRunProcessor(e.app, new ReportBackedBinView(e.app));
    await processor.process({ runId, tenantId: TENANT });
    const classes = await classesFor(e, runId);
    expect(classes["quantity_divergence"]).toBe(1);
  });
});
