/**
 * RT-457 — Postgres side of the sale re-drive sweep.
 *
 * RLS posture (the RT-123 lesson: a sweep without a GUC sees nothing under
 * FORCE RLS): `listTenantIds` is the only platform-admin read and reads tenant
 * ids only. Every other statement runs under ONE tenant's GUC
 * (`isPlatformAdmin: false`); the explicit `tenant_id = $1` predicates are
 * belt-and-braces.
 *
 * Only items inside the age window are touched: older than the minimum age
 * (the live pipeline always gets the first chance) and younger than the
 * maximum age (history is never posted to ERPNext by surprise).
 *
 * What counts as stranded:
 *   - (a) a sale with `processed_at IS NULL` — its sale-processing job ran out
 *     of retries or was lost with Redis. A sale quarantined for operator
 *     repair (`failed-needs-repair`) is left to the operator.
 *   - (b/c) a processed sale with no `sale_post` posting row, or a void /
 *     refund / return with no `reversal` row, whose `erpnext.posting.requested`
 *     event DEAD-LETTERED: the live path tried and gave up. An intent with an
 *     event still live in the outbox is the drainer's; one that never had an
 *     event is not evidence of a failure and is left alone; and one whose
 *     events have dead-lettered `SALE_REDRIVE_MAX_DEAD_LETTERS` times is not
 *     re-emitted again (the consumer will not accept it; repair is manual).
 * Re-emitting is idempotent downstream (the consumer's O-3 unique on
 * (tenant_id, source_ref_id)); a per-tenant try-lock keeps two overlapping
 * ticks from both emitting.
 */
import { emit, OUTBOX_EVENT_TYPES, runWithTenantContext } from "@data-pulse-2/db";
import type { Pool, PoolClient } from "pg";

import { SALE_REDRIVE_MAX_DEAD_LETTERS, type SaleRedriveWindow } from "./sale-redrive.config";

/** A sale the sweep re-processes. */
export interface StrandedSale {
  readonly saleId: string;
  readonly storeId: string;
}

/** Posting intents re-emitted for one tenant. */
export interface ReemittedIntents {
  readonly salePost: number;
  readonly reversal: number;
}

export interface SaleRedriveRepository {
  listTenantIds(): Promise<string[]>;
  findUnprocessedSales(tenantId: string, window: SaleRedriveWindow, limit: number): Promise<StrandedSale[]>;
  reemitMissingIntents(tenantId: string, window: SaleRedriveWindow, limit: number): Promise<ReemittedIntents>;
}

/** `col` falls in the age window ($2 = min age ms, $3 = max age ms). */
function inWindow(col: string): string {
  return `${col} < now() - ($2::bigint * interval '1 millisecond')
          AND ${col} >= now() - ($3::bigint * interval '1 millisecond')`;
}

/**
 * The source's posting events: none live (the drainer would own it), at least
 * one dead-lettered (the live path gave up), fewer than the cap ($5).
 */
const DEAD_LETTERED_ONLY = `NOT EXISTS (
         SELECT 1 FROM outbox_events o
          WHERE o.tenant_id = $1 AND o.event_type = $4
            AND o.delivery_state IN ('pending', 'claimed', 'failed')
            AND o.payload->>'source_ref_id' = src.id::text)
     AND (SELECT count(*) FROM outbox_events o
          WHERE o.tenant_id = $1 AND o.event_type = $4
            AND o.delivery_state = 'dead_lettered'
            AND o.payload->>'source_ref_id' = src.id::text) BETWEEN 1 AND $5::int - 1`;

/** No posting row exists for the source yet. */
const NO_POSTING_ROW = `NOT EXISTS (
         SELECT 1 FROM erpnext_posting_status p
          WHERE p.tenant_id = $1 AND p.source_ref_id = src.id)`;

/** Terminal-event tables that emit a `reversal` posting intent. */
const REVERSAL_SOURCES = ["sale_voids", "sale_refunds", "sale_returns"] as const;

interface SourceRow {
  id: string;
  sale_id: string;
  store_id: string;
}

export class PgSaleRedriveRepository implements SaleRedriveRepository {
  constructor(private readonly pool: Pool) {}

  async listTenantIds(): Promise<string[]> {
    return runWithTenantContext(this.pool, { tenantId: null, isPlatformAdmin: true }, async (client) => {
      const r = await client.query<{ id: string }>(
        `SELECT id FROM tenants WHERE deleted_at IS NULL ORDER BY id`,
      );
      return r.rows.map((row) => row.id);
    });
  }

  async findUnprocessedSales(tenantId: string, window: SaleRedriveWindow, limit: number): Promise<StrandedSale[]> {
    return runWithTenantContext(this.pool, { tenantId, isPlatformAdmin: false }, async (client) => {
      const r = await client.query<{ id: string; store_id: string }>(
        `SELECT id, store_id FROM sales
          WHERE tenant_id = $1 AND processed_at IS NULL
            AND sync_status <> 'failed-needs-repair'
            AND ${inWindow("created_at")}
          ORDER BY created_at
          LIMIT $4`,
        [tenantId, window.minAgeMs, window.maxAgeMs, limit],
      );
      return r.rows.map((row) => ({ saleId: row.id, storeId: row.store_id }));
    });
  }

  async reemitMissingIntents(tenantId: string, window: SaleRedriveWindow, limit: number): Promise<ReemittedIntents> {
    return runWithTenantContext(this.pool, { tenantId, isPlatformAdmin: false }, async (client) => {
      // Two overlapping ticks (a retry, or a tick slower than the interval)
      // would otherwise both pass the checks below and both emit.
      const locked = await client.query<{ locked: boolean }>(
        `SELECT pg_try_advisory_xact_lock(hashtextextended('sale-redrive:' || $1::text, 0)) AS locked`,
        [tenantId],
      );
      if (!locked.rows[0]?.locked) return { salePost: 0, reversal: 0 };

      const params = [tenantId, window.minAgeMs, window.maxAgeMs, limit];
      const salePosts = await this.missing(
        client,
        `SELECT src.id, src.id AS sale_id, src.store_id, src.created_at FROM sales src
          WHERE src.tenant_id = $1 AND ${inWindow("src.processed_at")}`,
        params,
      );
      for (const row of salePosts) await this.emitIntent(client, tenantId, row, "sale_post");

      let reversal = 0;
      for (const table of REVERSAL_SOURCES) {
        const rows = await this.missing(
          client,
          `SELECT src.id, src.sale_id, src.store_id, src.created_at FROM ${table} src
            WHERE src.tenant_id = $1 AND ${inWindow("src.created_at")}`,
          params,
        );
        for (const row of rows) await this.emitIntent(client, tenantId, row, "reversal");
        reversal += rows.length;
      }
      return { salePost: salePosts.length, reversal };
    });
  }

  /** Sources selected by `base` with no posting row whose events only dead-lettered. */
  private async missing(client: PoolClient, base: string, params: unknown[]): Promise<SourceRow[]> {
    const r = await client.query<SourceRow>(
      `SELECT id, sale_id, store_id FROM (${base}) src
        WHERE ${NO_POSTING_ROW}
          AND ${DEAD_LETTERED_ONLY}
        ORDER BY src.created_at
        LIMIT $6`,
      [params[0], params[1], params[2], OUTBOX_EVENT_TYPES.ERPNEXT_POSTING_REQUESTED, SALE_REDRIVE_MAX_DEAD_LETTERS, params[3]],
    );
    return r.rows;
  }

  /** The same event the capture / void / refund / return path emits. */
  private async emitIntent(
    client: PoolClient,
    tenantId: string,
    row: SourceRow,
    kind: "sale_post" | "reversal",
  ): Promise<void> {
    await emit(client, {
      eventType: OUTBOX_EVENT_TYPES.ERPNEXT_POSTING_REQUESTED,
      tenantId,
      storeId: row.store_id,
      payload: { sale_id: row.sale_id, store_id: row.store_id, kind, source_ref_id: row.id },
      correlationId: null,
    });
  }
}

/** No-DB path (non-production, no pool): the sweep is an empty pass. */
export class NoOpSaleRedriveRepository implements SaleRedriveRepository {
  async listTenantIds(): Promise<string[]> {
    return [];
  }

  async findUnprocessedSales(): Promise<StrandedSale[]> {
    return [];
  }

  async reemitMissingIntents(): Promise<ReemittedIntents> {
    return { salePost: 0, reversal: 0 };
  }
}
