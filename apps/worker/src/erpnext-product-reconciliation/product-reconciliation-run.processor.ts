/**
 * 021-US3 — `ProductReconciliationRunProcessor` (the product-master two-sided run).
 *
 * Compares the DP2 confirmed 013 mapping set against the connector's ERPNext-item
 * view and persists one `erpnext_product_reconciliation_result` per compared line,
 * classified in **021's product-master vocabulary**. The 013 `erpnext_item_map`,
 * the 003 `tenant_products`, and the 008 sale facts are NEVER mutated (read +
 * report only, §IX / FR-014).
 *
 * STUB-TOLERANT (FR-007 / R3): the ERPNext side is read through the connector
 * item-view seam; the connector (separate repo, ADR 0008) owns the real fetch
 * behind the 012 boundary — DP2 makes NO outbound ERPNext HTTP. An
 * UNAVAILABLE/empty view is NOT a failure — the run completes reporting only the
 * DP2-side-determinable classes and records `erpnext_view_status='unavailable'`,
 * and NEVER fabricates an `unmapped_erpnext_item` from an absent view.
 *
 * DIRECTLY-INVOKABLE class (the 017 precedent): takes a `Pool` + the item-view
 * seam and exposes `process(runId)`. Idempotency: the terminal write is guarded
 * (`UPDATE … WHERE id=$1 AND status='running'`); a 0-row result means another
 * invocation already finished the run → skip result inserts. No money column.
 */
import { runWithTenantContext } from "@data-pulse-2/db";
import { newId } from "@data-pulse-2/shared";
import type { Pool, PoolClient } from "pg";

import {
  EMPTY_ERPNEXT_ITEM_VIEW,
  type ErpnextItemView,
  type ErpnextItemViewSource,
} from "./erpnext-item-view.port";

export { EMPTY_ERPNEXT_ITEM_VIEW } from "./erpnext-item-view.port";
export type {
  ErpnextItemView,
  ErpnextItemViewEntry,
  ErpnextItemViewSource,
} from "./erpnext-item-view.port";

/** 021's product-master mismatch-class vocabulary (data-model §2.2). */
type ProductMismatchClass =
  | "match"
  | "unmapped_dp2_product"
  | "suggestion_unconfirmed"
  | "unmapped_erpnext_item"
  | "attribute_drift"
  | "sellable_state_divergence";

export interface ProductRunResult {
  readonly runId: string;
  readonly status: "completed" | "skipped";
  readonly erpnextViewStatus: "available" | "unavailable" | "partial";
  readonly counts: Readonly<Record<string, number>>;
}

interface ConfirmedMappingRow {
  tenant_product_id: string;
  erpnext_item_ref: string;
}

interface UnmappedProductRow {
  tenant_product_id: string;
  has_inert_mapping: boolean;
}

export class ProductReconciliationRunProcessor {
  constructor(
    private readonly pool: Pool,
    private readonly view: ErpnextItemViewSource = EMPTY_ERPNEXT_ITEM_VIEW,
  ) {}

  /**
   * Execute one product-master reconciliation run. Reads the run's tenant, the
   * 013 confirmed mapping set + the unmapped products (003 ⟕ 013), and the
   * connector item-view seam; persists one classified result per line; flips the
   * run running→completed (guarded) and records `erpnext_view_status`.
   */
  process(input: { runId: string; tenantId: string }): Promise<ProductRunResult> {
    return runWithTenantContext(
      this.pool,
      { tenantId: input.tenantId, isPlatformAdmin: false },
      async (client): Promise<ProductRunResult> => {
        const run = await client.query<{ status: string }>(
          `SELECT status FROM erpnext_product_reconciliation_run
            WHERE id = $1 FOR UPDATE`,
          [input.runId],
        );
        const r = run.rows[0];
        if (r?.status !== "running") {
          return {
            runId: input.runId,
            status: "skipped",
            erpnextViewStatus: "unavailable",
            counts: {},
          };
        }

        // (1) The connector item-view (stub-tolerant; never throws on absence).
        const view: ErpnextItemView = await this.view.fetch({ tenantId: input.tenantId });
        const erpnextItems = new Map(view.items.map((i) => [i.erpnextItemRef, i]));

        // (2) DP2 confirmed mapping set (013) — the DP2 side of the compare.
        const confirmed = await client.query<ConfirmedMappingRow>(
          `SELECT tenant_product_id, erpnext_item_ref
             FROM erpnext_item_map
            WHERE state = 'confirmed' AND retired_at IS NULL`,
        );

        // (3) DP2 products with NO confirmed-and-active mapping (the US1 backlog
        // classes, DP2-side-determinable even when the view is unavailable).
        const unmapped = await client.query<UnmappedProductRow>(
          `SELECT tp.id AS tenant_product_id,
                  (s.id IS NOT NULL) AS has_inert_mapping
             FROM tenant_products tp
             LEFT JOIN erpnext_item_map cm
               ON cm.tenant_product_id = tp.id
              AND cm.state = 'confirmed'
              AND cm.retired_at IS NULL
             LEFT JOIN LATERAL (
               SELECT m.id FROM erpnext_item_map m
                WHERE m.tenant_product_id = tp.id ORDER BY m.id LIMIT 1
             ) s ON true
            WHERE tp.retired_at IS NULL AND cm.id IS NULL`,
        );

        const counts: Record<string, number> = {};
        const matchedErpnextRefs = new Set<string>();

        // Confirmed mappings → match / attribute_drift / sellable_state_divergence
        // (only when the view is available; an absent view leaves these unverified —
        // we do NOT fabricate any ERPNext-side class from an absent view, FR-007).
        if (view.status !== "unavailable") {
          for (const m of confirmed.rows) {
            const item = erpnextItems.get(m.erpnext_item_ref);
            if (!item) {
              // The DP2 mapping points at an item the connector did not report.
              // With an AVAILABLE complete view this is a real DP2-only mapping;
              // with a PARTIAL view it may simply be off-page — record as a
              // DP2-side line, not an ERPNext-side fabrication.
              await this.insert(client, input.runId, input.tenantId, {
                mismatchClass: "unmapped_dp2_product",
                tenantProductId: m.tenant_product_id,
                erpnextItemRef: m.erpnext_item_ref,
              });
              this.bump(counts, "unmapped_dp2_product");
              continue;
            }
            matchedErpnextRefs.add(m.erpnext_item_ref);
            // Sellable-state divergence (013 OQ-5) — reported, NEVER silently flipped.
            if (item.sellable === false) {
              await this.insert(client, input.runId, input.tenantId, {
                mismatchClass: "sellable_state_divergence",
                tenantProductId: m.tenant_product_id,
                erpnextItemRef: m.erpnext_item_ref,
                detail: { erpnext_sellable: false },
              });
              this.bump(counts, "sellable_state_divergence");
            } else {
              await this.insert(client, input.runId, input.tenantId, {
                mismatchClass: "match",
                tenantProductId: m.tenant_product_id,
                erpnextItemRef: m.erpnext_item_ref,
              });
              this.bump(counts, "match");
            }
          }

          // unmapped_erpnext_item: an item in the view that NO confirmed mapping
          // resolves to. Only ever derived from a PRESENT view (never fabricated).
          for (const [ref, item] of erpnextItems) {
            if (matchedErpnextRefs.has(ref)) continue;
            await this.insert(client, input.runId, input.tenantId, {
              mismatchClass: "unmapped_erpnext_item",
              tenantProductId: null,
              erpnextItemRef: ref,
              ...(item.attributes ? { detail: { attributes: item.attributes } } : {}),
            });
            this.bump(counts, "unmapped_erpnext_item");
          }
        }

        // DP2-side backlog classes (always determinable, view-independent).
        for (const u of unmapped.rows) {
          const cls: ProductMismatchClass = u.has_inert_mapping
            ? "suggestion_unconfirmed"
            : "unmapped_dp2_product";
          await this.insert(client, input.runId, input.tenantId, {
            mismatchClass: cls,
            tenantProductId: u.tenant_product_id,
            erpnextItemRef: null,
          });
          this.bump(counts, cls);
        }

        await this.complete(client, input.runId, view.status, counts);
        return {
          runId: input.runId,
          status: "completed",
          erpnextViewStatus: view.status,
          counts,
        };
      },
    );
  }

  private bump(counts: Record<string, number>, cls: string): void {
    counts[cls] = (counts[cls] ?? 0) + 1;
  }

  private async insert(
    client: PoolClient,
    runId: string,
    tenantId: string,
    opts: {
      mismatchClass: ProductMismatchClass;
      tenantProductId: string | null;
      erpnextItemRef: string | null;
      detail?: Record<string, unknown>;
    },
  ): Promise<void> {
    await client.query(
      `INSERT INTO erpnext_product_reconciliation_result
         (id, run_id, tenant_id, mismatch_class, tenant_product_id,
          erpnext_item_ref, result_state, detail)
       VALUES ($1, $2, $3, $4, $5, $6, 'open', $7::jsonb)`,
      [
        newId(),
        runId,
        tenantId,
        opts.mismatchClass,
        opts.tenantProductId,
        opts.erpnextItemRef,
        opts.detail ? JSON.stringify(opts.detail) : null,
      ],
    );
  }

  /** Guarded terminal write — 0 rows means another invocation already finished it. */
  private async complete(
    client: PoolClient,
    runId: string,
    viewStatus: "available" | "unavailable" | "partial",
    counts: Record<string, number>,
  ): Promise<void> {
    await client.query(
      `UPDATE erpnext_product_reconciliation_run
          SET status = 'completed', erpnext_view_status = $2,
              finished_at = now(), summary = $3::jsonb, updated_at = now()
        WHERE id = $1 AND status = 'running'`,
      [runId, viewStatus, JSON.stringify(counts)],
    );
  }
}
