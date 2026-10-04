/**
 * RT-175 — ReportBackedBinView + ReconciliationRunProcessor over a multi-window
 * (stock-view 1.2) bin_view_report. Testcontainers spec.
 *
 * Proves, against real Postgres + RLS:
 *   AC1  a COMPLETE 3-window report (500/500/37 = 1,037 entries, the RT-21 §4
 *        storage shape) is compared in full: the run completes ONCE with a
 *        result for every reported item;
 *   AC8  a reported Bin entry with no confirmed 013 map → `erpnext_only` with
 *        `source_ref_id` NULL and detail {erpnext_item_ref, erpnext_bin,
 *        stock_uom}; mapped classification (match / quantity_divergence /
 *        mapped erpnext_only) is unchanged;
 *   - an INCOMPLETE report (`complete: false`) is never returned as the
 *     warehouse (empty view);
 *   - a historical report without `complete` is read as complete.
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

const TENANT = "01900000-0000-7000-8000-0000000c1751";
const STORE = "01900000-0000-7000-8000-0000000c1752";
const ACTOR = "01900000-0000-7000-8000-0000000c1753";
const PROD_MATCH = "01900000-0000-7000-8000-0000000c1754";
const PROD_DIVERGE = "01900000-0000-7000-8000-0000000c1755";
const PROD_BIN_ONLY = "01900000-0000-7000-8000-0000000c1756";

const MAPS: ReadonlyArray<readonly [string, string]> = [
  [PROD_MATCH, "ERP-175-MATCH"],
  [PROD_DIVERGE, "ERP-175-DIV"],
  [PROD_BIN_ONLY, "ERP-175-BINONLY"],
];

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

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllMigrations(env);
    const a = env.admin;
    await a.query(
      `INSERT INTO tenants (id, slug, name, default_currency_code) VALUES ($1, 'rt175', 'RT175', 'USD') ON CONFLICT (id) DO NOTHING`,
      [TENANT],
    );
    await a.query(
      `INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $2, 'R175', 'RT175 Store') ON CONFLICT (id) DO NOTHING`,
      [STORE, TENANT],
    );
    await a.query(
      `INSERT INTO users (id, email, password_hash) VALUES ($1, 'rt175@fixture.invalid', NULL) ON CONFLICT (id) DO NOTHING`,
      [ACTOR],
    );
    await a.query(
      `INSERT INTO erpnext_warehouse_map (id, tenant_id, store_id, purpose, erpnext_warehouse_ref, set_by, version)
       VALUES (gen_random_uuid(), $1, $2, 'stock', 'ERP-WH-175', $3, 1) ON CONFLICT DO NOTHING`,
      [TENANT, STORE, ACTOR],
    );
    for (const [id, ref] of MAPS) {
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
    // DP2 on-hand 10 for MATCH + DIVERGE; none for BIN_ONLY.
    for (const id of [PROD_MATCH, PROD_DIVERGE]) {
      await a.query(
        `INSERT INTO stock_movements (id, tenant_id, store_id, tenant_product_ref, movement_type, quantity, stocking_unit, occurred_at, created_by)
         VALUES (gen_random_uuid(), $1, $2, $3, 'inbound', 10.0000, 'ea', now(), $4)`,
        [TENANT, STORE, id, ACTOR],
      );
    }
  } catch (err) {
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      skip = true;
      // eslint-disable-next-line no-console
      console.warn(`[report-backed-bin-view-windows.spec] Docker unavailable: ${String(err)}`);
      return;
    }
    throw err;
  }
}, 180_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

type StoredEntry = {
  erpnextItemRef: string;
  tenant_product_ref: string | null;
  quantity: string;
  stockUom: string;
};

const mappedEntry = (ref: string, product: string, quantity: string): StoredEntry => ({
  erpnextItemRef: ref,
  tenant_product_ref: product,
  quantity,
  stockUom: "Nos",
});

const unmappedEntries = (prefix: string, n: number): StoredEntry[] =>
  Array.from({ length: n }, (_, i) => ({
    erpnextItemRef: `${prefix}-${String(i).padStart(5, "0")}`,
    tenant_product_ref: null,
    quantity: `${i}.250000`,
    stockUom: "Box",
  }));

/** Seed a running run whose summary holds `report` as bin_view_report. */
async function runWithReport(e: PgTestEnv, report: Record<string, unknown>): Promise<string> {
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

/** The RT-21 §4 storage shape for an accumulated attempt. */
function windowedReport(windows: StoredEntry[][], complete: boolean): Record<string, unknown> {
  const entries = windows.flat();
  return {
    requestRef: "00000000-0000-0000-0000-000000000000",
    runRef: "00000000-0000-0000-0000-000000000000",
    erpnextWarehouseRef: "ERP-WH-175",
    attemptRef: "0a000000-0000-4000-8000-0000000c175a",
    readAt: "2026-10-04T08:00:00.000Z",
    recordedAt: "2026-10-04T08:00:03.000Z",
    complete,
    windowsRecorded: windows.length,
    acceptedEntryCount: entries.length,
    windows: windows.map((w, i) => ({
      windowSeq: i,
      entryCount: w.length,
      isFinal: complete && i === windows.length - 1,
      recordedAt: "2026-10-04T08:00:03.000Z",
    })),
    entries,
  };
}

async function results(e: PgTestEnv, runId: string) {
  const r = await e.admin.query<{
    mismatch_class: string;
    source_ref_id: string | null;
    detail: Record<string, unknown> | null;
  }>(
    `SELECT mismatch_class, source_ref_id, detail FROM erpnext_reconciliation_result WHERE run_id = $1`,
    [runId],
  );
  return r.rows;
}

function countBy(rows: Array<{ mismatch_class: string }>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) out[row.mismatch_class] = (out[row.mismatch_class] ?? 0) + 1;
  return out;
}

describe("RT-175 — multi-window report feeds the reconciliation processor", () => {
  it("AC1/AC8: a complete 500/500/37 report → one result per reported item; unmapped → erpnext_only with NULL source_ref_id", async () => {
    if (skip) return;
    const e = env!;
    const unmapped = unmappedEntries("ERP-175-UNM", 1034);
    const w0 = [mappedEntry("ERP-175-MATCH", PROD_MATCH, "10.000000"), ...unmapped.slice(0, 499)];
    const w1 = [mappedEntry("ERP-175-DIV", PROD_DIVERGE, "7.000000"), ...unmapped.slice(499, 998)];
    const w2 = [mappedEntry("ERP-175-BINONLY", PROD_BIN_ONLY, "4.000000"), ...unmapped.slice(998)];
    expect([w0.length, w1.length, w2.length]).toEqual([500, 500, 37]);
    const runId = await runWithReport(e, windowedReport([w0, w1, w2], true));

    const processor = new ReconciliationRunProcessor(e.app, new ReportBackedBinView(e.app));
    const out = await processor.process({ runId, tenantId: TENANT });
    expect(out.status).toBe("completed");
    expect(out.counts).toEqual({ match: 1, quantity_divergence: 1, erpnext_only: 1035 });

    const rows = await results(e, runId);
    expect(rows).toHaveLength(1037);
    expect(countBy(rows)).toEqual({ match: 1, quantity_divergence: 1, erpnext_only: 1035 });

    // Mapped classification unchanged (incl. the mapped erpnext_only path).
    const mappedOnly = rows.filter((r) => r.mismatch_class === "erpnext_only" && r.source_ref_id !== null);
    expect(mappedOnly).toHaveLength(1);
    expect(mappedOnly[0]!.source_ref_id).toBe(PROD_BIN_ONLY);
    expect(mappedOnly[0]!.detail).toEqual({ dp2_on_hand: null, erpnext_bin: "4.000000" });
    expect(rows.find((r) => r.mismatch_class === "match")!.source_ref_id).toBe(PROD_MATCH);
    expect(rows.find((r) => r.mismatch_class === "quantity_divergence")!.source_ref_id).toBe(PROD_DIVERGE);

    // Unmapped: NULL source_ref_id + ERPNext ref / qty / UOM detail, all 1,034.
    const unm = rows.filter((r) => r.mismatch_class === "erpnext_only" && r.source_ref_id === null);
    expect(unm).toHaveLength(1034);
    const byRef = new Map(unm.map((r) => [r.detail!["erpnext_item_ref"] as string, r.detail]));
    expect(byRef.size).toBe(1034);
    expect(byRef.get("ERP-175-UNM-00007")).toEqual({
      erpnext_item_ref: "ERP-175-UNM-00007",
      erpnext_bin: "7.250000",
      stock_uom: "Box",
    });

    // The run completes ONCE: a second invocation is a no-op.
    const again = await processor.process({ runId, tenantId: TENANT });
    expect(again.status).toBe("skipped");
    expect(await results(e, runId)).toHaveLength(1037);
    const st = await e.admin.query<{ status: string }>(
      `SELECT status FROM erpnext_reconciliation_run WHERE id = $1`,
      [runId],
    );
    expect(st.rows[0]!.status).toBe("completed");
  });

  it("an INCOMPLETE report (complete: false) is never returned as the warehouse", async () => {
    if (skip) return;
    const e = env!;
    const runId = await runWithReport(
      e,
      windowedReport([[mappedEntry("ERP-175-MATCH", PROD_MATCH, "10.000000"), ...unmappedEntries("ERP-175-PART", 3)]], false),
    );
    const view = await new ReportBackedBinView(e.app).fetchBinReport({ tenantId: TENANT, storeId: STORE, runId });
    expect(view.mapped.size).toBe(0);
    expect(view.unmapped).toHaveLength(0);
    expect(
      (await new ReportBackedBinView(e.app).fetchBinView({ tenantId: TENANT, storeId: STORE, runId })).size,
    ).toBe(0);
  });

  it("a historical report without `complete` is read as complete (mapped + unmapped exposed)", async () => {
    if (skip) return;
    const e = env!;
    const runId = await runWithReport(e, {
      requestRef: "00000000-0000-0000-0000-000000000000",
      runRef: "00000000-0000-0000-0000-000000000000",
      erpnextWarehouseRef: "ERP-WH-175",
      readAt: "2026-06-08T10:00:00.000Z",
      recordedAt: "2026-06-08T10:00:01.000Z",
      acceptedEntryCount: 2,
      entries: [mappedEntry("ERP-175-MATCH", PROD_MATCH, "10.000000"), ...unmappedEntries("ERP-175-HIST", 1)],
    });
    const view = await new ReportBackedBinView(e.app).fetchBinReport({ tenantId: TENANT, storeId: STORE, runId });
    expect(Array.from(view.mapped.entries())).toEqual([[PROD_MATCH, "10.000000"]]);
    expect(view.unmapped).toEqual([
      { erpnextItemRef: "ERP-175-HIST-00000", quantity: "0.250000", stockUom: "Box" },
    ]);
  });

  it("RLS: another tenant's run reads as no report", async () => {
    if (skip) return;
    const e = env!;
    const runId = await runWithReport(e, windowedReport([unmappedEntries("ERP-175-RLS", 2)], true));
    const view = await new ReportBackedBinView(e.app).fetchBinReport({
      tenantId: "01900000-0000-7000-8000-0000000c17ff",
      storeId: STORE,
      runId,
    });
    expect(view.mapped.size).toBe(0);
    expect(view.unmapped).toHaveLength(0);
  });
});
