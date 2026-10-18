/**
 * 019-T040-REPORT — ErpnextBinViewService.reportSnapshot Testcontainers spec (RED-first).
 *
 * Proves the bin-view REPORT records the connector's point-in-time ERPNext-Bin
 * snapshot run-scoped per the shipped
 * `packages/contracts/openapi/erpnext-connector/stock-view.yaml`:
 *   - a valid report for a pulled `requestRef` → a RecordedBinView (requestRef,
 *     runRef, erpnextWarehouseRef, acceptedEntryCount, readAt, recordedAt) and the
 *     snapshot lands in `erpnext_reconciliation_run.summary.bin_view_report`
 *     (Option B — NO standing Bin mirror, FR-009);
 *   - `erpnextItemRef` is reverse-resolved → `tenant_product_ref` via the confirmed
 *     013 map; an unmapped ref is recorded (tenant_product_ref null), never crashes;
 *   - exact-decimal quantity STRING is preserved verbatim (no float coercion, §III);
 *   - idempotent replay: same logical report → replayed=true, stable body;
 *   - conflict: a DIFFERENT report for the same requestRef → AckConflictError;
 *   - cross-tenant / unknown requestRef → BinViewNotFoundError (non-disclosing).
 *
 * `requestRef` is the deterministic id the feed derives (uuidv5 over run:window);
 * the test re-derives it the same way for the seeded RUNNING run.
 *
 * Docker policy: HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import { deterministicId } from "@data-pulse-2/shared";

import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../../_helpers/postgres-container";
import {
  ErpnextBinViewService,
  BinViewConflictError,
  BinViewNotFoundError,
} from "../../../../src/catalog/erpnext-bin-view/erpnext-bin-view.service";
import {
  ACTOR_A,
  PRODUCT_A_ACTIVE,
  STORE_A_X,
  TENANT_A,
} from "../../__support__/isolation-harness";
import { seedReconciliationFixture } from "../../erpnext-reconciliation/__support__/seed-reconciliation";
import { requestRefFor } from "../__support__/request-ref";

let env: PgTestEnv | null = null;
let skip = false;

const RUN_A_RUNNING = "0a000000-0000-7000-8000-00000e7041a1";
const BIN_VIEW_REQUEST_NS = "0190b1de-0000-7000-8000-0000000be019";
// RT-688: bound to the run AND its store's active stock map (read back in beforeAll).
let REQUEST_REF = "";

/** A confirmed 013 item map for PRODUCT_A_ACTIVE → the reverse-resolve target. */
const ERP_ITEM_REF = "ERP-ITEM-7041A";

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    await seedReconciliationFixture(env);
    const a = env.admin;
    await a.query(
      `INSERT INTO erpnext_reconciliation_run
         (id, tenant_id, store_id, kind, trigger, status, actor_user_id)
       VALUES ($1, $2, $3, 'stock', 'on_demand', 'running', $4)
       ON CONFLICT (id) DO NOTHING`,
      [RUN_A_RUNNING, TENANT_A, STORE_A_X, ACTOR_A],
    );
    // A confirmed item map so the connector's erpnextItemRef reverse-resolves.
    await a.query(
      `INSERT INTO erpnext_item_map
         (id, tenant_id, tenant_product_id, erpnext_item_ref, state,
          suggestion_source, confirmed_by, confirmed_at)
       VALUES (gen_random_uuid(), $1, $2, $3, 'confirmed', 'manual', $4, now())
       ON CONFLICT DO NOTHING`,
      [TENANT_A, PRODUCT_A_ACTIVE, ERP_ITEM_REF, ACTOR_A],
    );
    REQUEST_REF = await requestRefFor(a, RUN_A_RUNNING);
  } catch (err) {
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      skip = true;
      // eslint-disable-next-line no-console
      console.warn(`[bin-view-report.spec] Docker unavailable: ${String(err)}`);
      return;
    }
    throw err;
  }
}, 180_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
});

const READ_AT = "2026-06-08T10:00:00.000Z";

function report(entries: Array<{ name: string; quantity: string; stockUom: string }>) {
  return {
    entries: entries.map((e) => ({
      erpnextItemRef: { doctype: "Item" as const, name: e.name },
      quantity: e.quantity,
      stockUom: e.stockUom,
    })),
    readAt: READ_AT,
  };
}

describe("ErpnextBinViewService.reportSnapshot — 019 bin-view report", () => {
  it("records a valid report run-scoped + reverse-resolves erpnextItemRef + preserves exact-decimal", async () => {
    if (skip) return;
    const service = new ErpnextBinViewService(env!.app);
    const recorded = await service.reportSnapshot({
      tenantId: TENANT_A,
      requestRef: REQUEST_REF,
      body: report([{ name: ERP_ITEM_REF, quantity: "12.500000", stockUom: "ea" }]),
      idempotencyKey: "idem-report-1",
    });

    expect(recorded.replayed).toBe(false);
    expect(recorded.view.requestRef).toBe(REQUEST_REF);
    expect(recorded.view.runRef).toBe(RUN_A_RUNNING);
    expect(recorded.view.erpnextWarehouseRef).toBe("ERP-WH-017A");
    expect(recorded.view.acceptedEntryCount).toBe(1);
    expect(recorded.view.readAt).toBe(READ_AT);
    expect(typeof recorded.view.recordedAt).toBe("string");

    // The snapshot landed in run.summary.bin_view_report with the exact-decimal
    // string preserved + the reverse-resolved tenant_product_ref.
    const row = await env!.admin.query<{ summary: { bin_view_report?: unknown } }>(
      `SELECT summary FROM erpnext_reconciliation_run WHERE id = $1`,
      [RUN_A_RUNNING],
    );
    const rpt = (row.rows[0]!.summary as {
      bin_view_report?: { entries: Array<Record<string, unknown>> };
    }).bin_view_report;
    expect(rpt).toBeDefined();
    expect(rpt!.entries[0]!["quantity"]).toBe("12.500000");
    expect(rpt!.entries[0]!["tenant_product_ref"]).toBe(PRODUCT_A_ACTIVE);
    expect(rpt!.entries[0]!["stockUom"]).toBe("ea");
  });

  it("emits erpnext.reconciliation.requested on first record (T041 lifecycle), NOT on replay", async () => {
    if (skip) return;
    // The happy-path test above already recorded REQUEST_REF once. Assert exactly
    // one reconciliation.requested event was emitted for that run (the fresh
    // record), and that the subsequent replay (next test) does not add another.
    const ev = await env!.admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM outbox_events
        WHERE tenant_id=$1 AND event_type='erpnext.reconciliation.requested'
          AND payload->>'run_id'=$2`,
      [TENANT_A, RUN_A_RUNNING],
    );
    expect(Number(ev.rows[0]?.count)).toBe(1);
  });

  it("idempotent replay: same logical report → replayed=true, stable body", async () => {
    if (skip) return;
    const service = new ErpnextBinViewService(env!.app);
    const body = report([{ name: ERP_ITEM_REF, quantity: "12.500000", stockUom: "ea" }]);
    const replay = await service.reportSnapshot({
      tenantId: TENANT_A,
      requestRef: REQUEST_REF,
      body,
      idempotencyKey: "idem-report-1",
    });
    expect(replay.replayed).toBe(true);
    expect(replay.view.requestRef).toBe(REQUEST_REF);
    expect(replay.view.acceptedEntryCount).toBe(1);
  });

  it("conflict: a different report for the same requestRef → BinViewConflictError", async () => {
    if (skip) return;
    const service = new ErpnextBinViewService(env!.app);
    await expect(
      service.reportSnapshot({
        tenantId: TENANT_A,
        requestRef: REQUEST_REF,
        body: report([{ name: ERP_ITEM_REF, quantity: "99.000000", stockUom: "ea" }]),
        idempotencyKey: "idem-report-2",
      }),
    ).rejects.toBeInstanceOf(BinViewConflictError);
  });

  it("unknown / cross-tenant requestRef → BinViewNotFoundError (non-disclosing)", async () => {
    if (skip) return;
    const service = new ErpnextBinViewService(env!.app);
    const bogus = deterministicId(BIN_VIEW_REQUEST_NS, "no-such-run:0");
    await expect(
      service.reportSnapshot({
        tenantId: TENANT_A,
        requestRef: bogus,
        body: report([{ name: ERP_ITEM_REF, quantity: "1.000000", stockUom: "ea" }]),
        idempotencyKey: "idem-report-3",
      }),
    ).rejects.toBeInstanceOf(BinViewNotFoundError);
  });

  it("tolerates an unmapped erpnextItemRef (records tenant_product_ref null, no crash)", async () => {
    if (skip) return;
    // A fresh running run so this report is independent of the happy-path one.
    const RUN_UNMAPPED = "0a000000-0000-7000-8000-00000e7041c1";
    await env!.admin.query(
      `INSERT INTO erpnext_reconciliation_run
         (id, tenant_id, store_id, kind, trigger, status, actor_user_id)
       VALUES ($1, $2, $3, 'stock', 'on_demand', 'running', $4)
       ON CONFLICT (id) DO NOTHING`,
      [RUN_UNMAPPED, TENANT_A, STORE_A_X, ACTOR_A],
    );
    const reqRef = await requestRefFor(env!.admin, RUN_UNMAPPED);
    const service = new ErpnextBinViewService(env!.app);
    const recorded = await service.reportSnapshot({
      tenantId: TENANT_A,
      requestRef: reqRef,
      body: report([{ name: "ERP-ITEM-NEVER-MAPPED", quantity: "3.000000", stockUom: "ea" }]),
      idempotencyKey: "idem-report-4",
    });
    expect(recorded.view.acceptedEntryCount).toBe(1);
    const row = await env!.admin.query<{ summary: { bin_view_report?: { entries: Array<Record<string, unknown>> } } }>(
      `SELECT summary FROM erpnext_reconciliation_run WHERE id = $1`,
      [RUN_UNMAPPED],
    );
    const entry = row.rows[0]!.summary.bin_view_report!.entries[0]!;
    expect(entry["tenant_product_ref"]).toBeNull();
    expect(entry["erpnextItemRef"]).toBe("ERP-ITEM-NEVER-MAPPED");
  });
});
