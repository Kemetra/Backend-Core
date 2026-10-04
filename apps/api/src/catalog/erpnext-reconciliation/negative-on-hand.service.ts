/**
 * NegativeOnHandService — RT-177 (RT-51 D1/D2/D4/D6).
 *
 * A READ-ONLY, compute-on-read projection of ERPNext negative on-hand per store
 * and item. The only source is the latest recorded Connector Bin snapshot of
 * each store: `summary.bin_view_report` of the newest `kind='stock'`
 * reconciliation run that carries a usable report, ordered by the report's
 * `recordedAt` (the run status is irrelevant — the snapshot is the evidence).
 * A report with `complete === false` (RT-175 multi-window, not yet built) is not
 * a usable snapshot; an absent `complete` means complete.
 *
 * Never reads the 009 `stock_movements` ledger, never writes, adds no mismatch
 * class and touches no run/result row (RT-51 D2/D3/D5). No outbound HTTP.
 *
 * Scope: tenant from the session principal via `runWithTenantContext` (RLS);
 * store scope from `resolveStoreScope` (RT-131), applied as a store filter —
 * `stores` and `erpnext_reconciliation_run` carry tenant-only RLS. An
 * out-of-scope store is indistinguishable from a nonexistent one (404).
 */
import { Inject, Injectable } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";

import { runWithTenantContext } from "@data-pulse-2/db";

import { PG_POOL } from "../../auth/auth.module";
import type { StoreScope } from "../../context/store-scope";
import {
  decodeItemCursor,
  decodeStoreCursor,
  encodeStoreCursor,
  negativeEntries,
  pageEntries,
  servesItems,
  snapshotStatus,
  toNegativeOnHandItem,
  type NegativeEntry,
  type PendingRequestFacts,
  type PositionedEntry,
  type StockSnapshotStatus,
  type StoreNegativeOnHandPage,
  type StoreNegativeOnHandSummaryPage,
  type StoreSnapshotFacts,
} from "./negative-on-hand.projection";

/** Hard ceiling on a page — the 009/012 500/req convention. */
export const NEGATIVE_ON_HAND_MAX_PAGE = 500;

/** The addressed store is not visible: foreign, out of scope, deleted or absent. 404. */
export class NegativeOnHandStoreNotFoundError extends Error {
  constructor() {
    super("not found");
    this.name = "NegativeOnHandStoreNotFoundError";
  }
}

export interface ListStoresInput {
  readonly tenantId: string;
  readonly storeScope: StoreScope;
  readonly cursor: string | null;
  readonly limit: number;
}

export interface ListItemsInput {
  readonly tenantId: string;
  readonly storeScope: StoreScope;
  readonly storeId: string;
  readonly cursor: string | null;
  readonly limit: number;
}

/**
 * A usable report on run alias `r`: a JSON object with a `recordedAt`, not
 * explicitly incomplete. Shared by the snapshot pick and the pending test so the
 * two can never disagree.
 */
const USABLE_REPORT = `(jsonb_typeof(r.summary->'bin_view_report') = 'object'
       AND jsonb_typeof(r.summary->'bin_view_report'->'recordedAt') = 'string'
       AND (r.summary->'bin_view_report'->'complete') IS DISTINCT FROM 'false'::jsonb)`;

/**
 * Per store: the active `stock` warehouse map, the latest usable snapshot (with
 * its entries pre-filtered to those whose quantity text starts with `-`; the
 * canonical exact-decimal test runs in TypeScript), and the newest `running`
 * run without a usable report that is newer than the snapshot's run.
 */
const STORE_FACTS_SQL = `
WITH snap AS (
  SELECT DISTINCT ON (r.store_id)
         r.store_id, r.id, r.started_at, r.summary->'bin_view_report' AS report
    FROM erpnext_reconciliation_run r
   WHERE r.kind = 'stock'
     AND r.store_id = ANY($1::uuid[])
     AND ${USABLE_REPORT}
   ORDER BY r.store_id,
            (r.summary->'bin_view_report'->>'recordedAt')::timestamptz DESC,
            r.id DESC
),
pend AS (
  SELECT DISTINCT ON (r.store_id)
         r.store_id, r.id, r.started_at
    FROM erpnext_reconciliation_run r
    LEFT JOIN snap ON snap.store_id = r.store_id
   WHERE r.kind = 'stock'
     AND r.status = 'running'
     AND r.store_id = ANY($1::uuid[])
     AND NOT COALESCE(${USABLE_REPORT}, false)
     AND (snap.id IS NULL OR r.started_at > snap.started_at)
   ORDER BY r.store_id, r.started_at DESC, r.id DESC
)
SELECT s.id AS store_id,
       whm.erpnext_warehouse_ref AS mapped_warehouse_ref,
       snap.id AS snap_run_id,
       snap.report->>'erpnextWarehouseRef' AS snap_warehouse_ref,
       snap.report->>'readAt' AS snap_read_at,
       snap.report->>'recordedAt' AS snap_recorded_at,
       CASE WHEN jsonb_typeof(snap.report->'entries') = 'array'
            THEN jsonb_array_length(snap.report->'entries') END AS snap_entry_count,
       COALESCE(
         (SELECT jsonb_agg(jsonb_build_object('entry', e.value, 'ordinal', e.ordinality))
            FROM jsonb_array_elements(
                   CASE WHEN jsonb_typeof(snap.report->'entries') = 'array'
                        THEN snap.report->'entries' ELSE '[]'::jsonb END
                 ) WITH ORDINALITY AS e(value, ordinality)
           WHERE e.value->>'quantity' LIKE '-%'),
         '[]'::jsonb) AS snap_minus_entries,
       pend.id AS pend_run_id,
       pend.started_at AS pend_started_at
  FROM unnest($1::uuid[]) AS s(id)
  LEFT JOIN erpnext_warehouse_map whm
         ON whm.store_id = s.id AND whm.purpose = 'stock' AND whm.retired_at IS NULL
  LEFT JOIN snap ON snap.store_id = s.id
  LEFT JOIN pend ON pend.store_id = s.id`;

interface StoreFactsRow {
  store_id: string;
  mapped_warehouse_ref: string | null;
  snap_run_id: string | null;
  snap_warehouse_ref: string | null;
  snap_read_at: string | null;
  snap_recorded_at: string | null;
  snap_entry_count: number | null;
  snap_minus_entries: PositionedEntry[];
  pend_run_id: string | null;
  pend_started_at: Date | null;
}

interface StoreFacts {
  readonly status: StockSnapshotStatus;
  /** Strictly negative entries in view order; empty unless items are served. */
  readonly negatives: readonly NegativeEntry[];
}

@Injectable()
export class NegativeOnHandService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /** Per-store summaries for every store the caller may read, by store id. */
  async listStores(input: ListStoresInput): Promise<StoreNegativeOnHandSummaryPage> {
    const limit = clampLimit(input.limit);
    const after = input.cursor !== null ? decodeStoreCursor(input.cursor) : null;
    const scopedIds = input.storeScope.kind === "stores" ? input.storeScope.storeIds : null;
    if (scopedIds !== null && scopedIds.length === 0) {
      return { items: [], nextCursor: null };
    }

    return runWithTenantContext(
      this.pool,
      { tenantId: input.tenantId, isPlatformAdmin: false },
      async (client): Promise<StoreNegativeOnHandSummaryPage> => {
        const stores = await client.query<{ id: string; name: string }>(
          `SELECT id, name
             FROM stores
            WHERE deleted_at IS NULL
              AND ($1::uuid[] IS NULL OR id = ANY($1::uuid[]))
              AND ($2::uuid IS NULL OR id > $2::uuid)
            ORDER BY id
            LIMIT $3`,
          [scopedIds, after, limit + 1],
        );
        const page = stores.rows.slice(0, limit);
        const facts = await this.storeFacts(client, page.map((s) => s.id));
        return {
          items: page.map((s) => {
            const f = facts.get(s.id)!;
            return {
              storeId: s.id,
              storeName: s.name,
              snapshot: f.status,
              negativeItemCount: f.negatives.length,
            };
          }),
          nextCursor:
            stores.rows.length > limit ? encodeStoreCursor(page[page.length - 1]!.id) : null,
        };
      },
    );
  }

  /** One store's negative items, most negative first. Invisible store → 404. */
  async listItems(input: ListItemsInput): Promise<StoreNegativeOnHandPage> {
    const limit = clampLimit(input.limit);
    const cursor = input.cursor !== null ? decodeItemCursor(input.cursor) : null;
    const storeId = input.storeId.toLowerCase();
    if (input.storeScope.kind === "stores" && !input.storeScope.storeIds.includes(storeId)) {
      throw new NegativeOnHandStoreNotFoundError();
    }

    return runWithTenantContext(
      this.pool,
      { tenantId: input.tenantId, isPlatformAdmin: false },
      async (client): Promise<StoreNegativeOnHandPage> => {
        const store = await client.query<{ id: string }>(
          `SELECT id FROM stores WHERE id = $1 AND deleted_at IS NULL`,
          [storeId],
        );
        if (!store.rows[0]) throw new NegativeOnHandStoreNotFoundError();

        const facts = (await this.storeFacts(client, [storeId])).get(storeId)!;
        const { page, nextCursor } = pageEntries(facts.negatives, cursor, limit);
        const names = await this.productNames(client, page);
        const warehouseRef = facts.status.erpnextWarehouseRef!;
        return {
          storeId,
          snapshot: facts.status,
          items: page.map((e) => toNegativeOnHandItem(e, warehouseRef, names)),
          nextCursor,
        };
      },
    );
  }

  private async storeFacts(
    client: PoolClient,
    storeIds: readonly string[],
  ): Promise<Map<string, StoreFacts>> {
    const out = new Map<string, StoreFacts>();
    if (storeIds.length === 0) return out;
    const now = new Date();
    const rows = await client.query<StoreFactsRow>(STORE_FACTS_SQL, [storeIds]);
    for (const row of rows.rows) {
      const snapshot: StoreSnapshotFacts | null =
        row.snap_run_id !== null
          ? {
              runId: row.snap_run_id,
              erpnextWarehouseRef: row.snap_warehouse_ref,
              readAt: validTimestamp(row.snap_read_at),
              recordedAt: row.snap_recorded_at!,
              reportedEntryCount: row.snap_entry_count,
            }
          : null;
      const pending: PendingRequestFacts | null =
        row.pend_run_id !== null
          ? { runId: row.pend_run_id, requestedAt: row.pend_started_at!.toISOString() }
          : null;
      const status = snapshotStatus({
        mappedWarehouseRef: row.mapped_warehouse_ref,
        snapshot,
        pending,
        now,
      });
      out.set(row.store_id, {
        status,
        negatives: servesItems(status) ? negativeEntries(row.snap_minus_entries) : [],
      });
    }
    return out;
  }

  /** Names of the page's mapped products (tenant RLS). */
  private async productNames(
    client: PoolClient,
    page: readonly NegativeEntry[],
  ): Promise<Map<string, string>> {
    const ids = Array.from(
      new Set(page.map((e) => e.tenantProductRef).filter((id): id is string => id !== null)),
    );
    const names = new Map<string, string>();
    if (ids.length === 0) return names;
    const rows = await client.query<{ id: string; name: string }>(
      `SELECT id, name FROM tenant_products WHERE id = ANY($1::uuid[])`,
      [ids],
    );
    for (const r of rows.rows) names.set(r.id, r.name);
    return names;
  }
}

function clampLimit(limit: number): number {
  return Math.min(Math.max(1, limit), NEGATIVE_ON_HAND_MAX_PAGE);
}

/** The Connector's `readAt` is shown only when it is a real timestamp. */
function validTimestamp(value: string | null): string | null {
  return value !== null && !Number.isNaN(Date.parse(value)) ? value : null;
}
