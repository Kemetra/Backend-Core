/**
 * RT-428 — the pending-aware result lines of one 017 stock run, for a store
 * whose tenant has activated sale effects (RT-289 DC-7, 923–930).
 *
 * The operational side is the RT-427 anchor plus the effects it does not
 * cover, minus the pending ERP / pending Retail terms (`readPendingAwarePositions`);
 * the ERP side is the run's own Bin view (the same seam as the legacy path).
 * The run's recorded `bin_view_report` supplies `readAt` and each product's
 * stock UOM for the stale-snapshot and UOM checks. Read-only: nothing here
 * writes an effect, an integration row or ERP stock.
 */
import { readPendingAwarePositions, type PendingAwarePosition } from "@data-pulse-2/db";
import type { PoolClient } from "pg";

import { classifyPendingAware, type PendingAwareClass } from "./pending-aware-classify";

/** One classified line, ready for `erpnext_reconciliation_result`. */
export interface PendingAwareResultLine {
  readonly mismatchClass: PendingAwareClass;
  readonly sourceRefId: string;
  readonly detail: Record<string, unknown>;
}

interface RecordedReport {
  readAt: string | null;
  uomByProduct: ReadonlyMap<string, string>;
}

/** `readAt` and per-product stock UOM from the run's recorded Bin report (none for a stub seam). */
async function readRecordedReport(client: PoolClient, runId: string): Promise<RecordedReport> {
  const r = await client.query<{ read_at: string | null; uoms: Array<{ ref: string; uom: string }> | null }>(
    `SELECT r.summary->'bin_view_report'->>'readAt' AS read_at,
            (SELECT jsonb_agg(jsonb_build_object('ref', e->>'tenant_product_ref', 'uom', e->>'stockUom'))
               FROM jsonb_array_elements(COALESCE(r.summary->'bin_view_report'->'entries', '[]'::jsonb)) AS e
              WHERE e->>'tenant_product_ref' IS NOT NULL AND e->>'stockUom' IS NOT NULL) AS uoms
       FROM erpnext_reconciliation_run r WHERE r.id = $1`,
    [runId],
  );
  const row = r.rows[0];
  return {
    readAt: row?.read_at ?? null,
    uomByProduct: new Map((row?.uoms ?? []).map((u) => [u.ref, u.uom])),
  };
}

/** Products with a confirmed, active 013 item map. */
async function confirmedProducts(client: PoolClient, products: readonly string[]): Promise<ReadonlySet<string>> {
  if (products.length === 0) return new Set();
  const r = await client.query<{ product: string }>(
    `SELECT DISTINCT tenant_product_id::text AS product FROM erpnext_item_map
      WHERE tenant_product_id = ANY($1::uuid[]) AND state = 'confirmed' AND retired_at IS NULL`,
    [products],
  );
  return new Set(r.rows.map((row) => row.product));
}

function isStale(readAt: string | null, latestConfirmedAt: string | null): boolean {
  return readAt !== null && latestConfirmedAt !== null && new Date(readAt) < new Date(latestConfirmedAt);
}

function hasUomMismatch(unit: string | null, binUom: string | null): boolean {
  return unit !== null && binUom !== null && unit !== binUom;
}

function toLine(
  p: PendingAwarePosition,
  binQty: string | undefined,
  ctx: { report: RecordedReport; mapped: ReadonlySet<string> },
): PendingAwareResultLine {
  const binUom = ctx.report.uomByProduct.get(p.tenantProductRef) ?? p.erpStockUom;
  const mismatchClass = classifyPendingAware({
    operationalPosition: p.operationalPosition,
    pendingErp: p.pendingErp,
    pendingRetail: p.pendingRetail,
    expectedErpBook: p.expectedErpBook,
    binQty,
    hasConfirmedMap: ctx.mapped.has(p.tenantProductRef),
    uomMismatch: hasUomMismatch(p.operationalUnit, binUom),
    snapshotStale: isStale(ctx.report.readAt, p.latestErpConfirmedAt),
  });
  return {
    mismatchClass,
    sourceRefId: p.tenantProductRef,
    // Quantities, units and times only — no PII, no money.
    detail: {
      dp2_on_hand: p.operationalPosition,
      erpnext_bin: binQty ?? null,
      expected_erp_book: p.expectedErpBook,
      pending_erp: p.pendingErp,
      pending_retail: p.pendingRetail,
      legacy_on_hand: p.legacyOnHand,
      anchor_generation: p.anchorGeneration,
      snapshot_read_at: ctx.report.readAt,
      latest_erp_confirmed_at: p.latestErpConfirmedAt,
      operational_unit: p.operationalUnit,
      erpnext_stock_uom: binUom,
    },
  };
}

/**
 * The pending-aware lines of the store, one per product with a position.
 * Bin entries with no position are the caller's `erpnext_only` lines, as on
 * the legacy path.
 */
export async function pendingAwareLines(
  client: PoolClient,
  input: { runId: string; storeId: string; binView: ReadonlyMap<string, string> },
): Promise<PendingAwareResultLine[]> {
  const positions = await readPendingAwarePositions(client, input.storeId);
  const report = await readRecordedReport(client, input.runId);
  const mapped = await confirmedProducts(
    client,
    positions.map((p) => p.tenantProductRef),
  );
  return positions.map((p) => toLine(p, input.binView.get(p.tenantProductRef), { report, mapped }));
}
