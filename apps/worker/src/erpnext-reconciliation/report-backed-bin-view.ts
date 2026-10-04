/**
 * 019-T041 — ReportBackedBinView.
 *
 * The live (report-backed) ErpnextBinView seam: replaces the inert EMPTY_BIN_VIEW
 * by reading the connector-reported snapshot that 019 T040 recorded run-scoped in
 * `erpnext_reconciliation_run.summary.bin_view_report`. Returns, for the run:
 *   - `mapped`: Map<tenant_product_ref, quantityString> — the connector's ERPNext
 *     Bin on-hand per item, keyed by the DP2-side-resolved `tenant_product_ref`;
 *   - `unmapped` (RT-175): the reported entries whose `erpnextItemRef` had no
 *     confirmed 013 map when recorded (`tenant_product_ref: null`). The processor
 *     classes each `erpnext_only` with a NULL `source_ref_id` — before RT-175
 *     these were silently dropped, so an ERPNext item DP2 never mapped was never
 *     surfaced.
 *
 * §III: the quantity is the EXACT-DECIMAL STRING the connector reported and DP2
 * recorded verbatim — it is returned as-is (never coerced through a JS number).
 *
 * Completeness (RT-175, stock-view 1.2): a multi-window report is accumulated
 * window by window; until its final window is recorded it carries
 * `complete: false`. Such a PARTIAL report is never returned as the warehouse —
 * the view is empty instead. A stored report without `complete` (pre-RT-175 /
 * v1) is complete (stock-view 1.2 v1 compatibility (iv)).
 *
 * Tenant scope: the read runs under the processor's tenant GUC (the processor
 * calls this inside its own `runWithTenantContext`), so RLS scopes the run row.
 * The seam takes a plain `Pool` and a NO-GUC client is NOT used — the processor
 * already holds the tenant context when it calls `fetchBinView`. To stay
 * self-contained, this impl opens its own tenant-scoped read.
 */
import { runWithTenantContext } from "@data-pulse-2/db";
import type { Pool } from "pg";

import type {
  BinReportView,
  ErpnextBinView,
  UnmappedBinEntry,
} from "./reconciliation-run.processor";

interface StoredEntry {
  erpnextItemRef: string;
  tenant_product_ref: string | null;
  quantity: string;
  stockUom: string;
}

interface StoredReport {
  complete?: boolean;
  entries?: StoredEntry[];
}

export class ReportBackedBinView implements ErpnextBinView {
  constructor(private readonly pool: Pool) {}

  async fetchBinView(input: {
    tenantId: string;
    storeId: string;
    runId: string;
  }): Promise<ReadonlyMap<string, string>> {
    return (await this.fetchBinReport(input)).mapped;
  }

  async fetchBinReport(input: {
    tenantId: string;
    storeId: string;
    runId: string;
  }): Promise<BinReportView> {
    return runWithTenantContext(
      this.pool,
      { tenantId: input.tenantId, isPlatformAdmin: false },
      async (client): Promise<BinReportView> => {
        const r = await client.query<{
          summary: { bin_view_report?: StoredReport } | null;
        }>(
          `SELECT summary FROM erpnext_reconciliation_run WHERE id = $1`,
          [input.runId],
        );
        const report = r.rows[0]?.summary?.bin_view_report;
        const mapped = new Map<string, string>();
        const unmapped = new Map<string, UnmappedBinEntry>();
        // An incomplete (partial multi-window) report is never the warehouse.
        if (!report || report.complete === false) {
          return { mapped, unmapped: [] };
        }
        for (const e of report.entries ?? []) {
          // Last-write-wins on a duplicate ref (both maps).
          if (e.tenant_product_ref !== null) {
            mapped.set(e.tenant_product_ref, e.quantity);
          } else {
            unmapped.set(e.erpnextItemRef, {
              erpnextItemRef: e.erpnextItemRef,
              quantity: e.quantity,
              stockUom: e.stockUom,
            });
          }
        }
        return { mapped, unmapped: Array.from(unmapped.values()) };
      },
    );
  }
}
