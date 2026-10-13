/**
 * RT-457 — Postgres side of the sale re-drive sweep.
 *
 * RLS posture (the RT-123 lesson: a sweep without a GUC sees nothing under
 * FORCE RLS): `listTenantIds` is the only platform-admin read and reads tenant
 * ids only. Every other statement runs under ONE tenant's GUC
 * (`isPlatformAdmin: false`); the explicit `tenant_id = $1` predicates are
 * belt-and-braces.
 *
 * What counts as stranded (all older than the minimum age, so the live
 * pipeline always gets the first chance):
 *   - a sale with `processed_at IS NULL` — its sale-processing job ran out of
 *     retries, its BullMQ job was lost with Redis, or its `sale.captured`
 *     outbox row dead-lettered;
 *   - a processed sale with no `sale_post` posting row, or a void / refund /
 *     return with no `reversal` posting row — its `erpnext.posting.requested`
 *     event dead-lettered (or the consumer insert saw nothing).
 * An intent whose `erpnext.posting.requested` event is still live in the
 * outbox (pending, claimed or failed-awaiting-retry) is NOT re-emitted: the
 * drainer still owns it. Re-emitting is idempotent downstream anyway (the
 * consumer's O-3 unique on (tenant_id, source_ref_id)).
 */
import { emit, OUTBOX_EVENT_TYPES, runWithTenantContext } from "@data-pulse-2/db";
import type { Pool, PoolClient } from "pg";

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
  findUnprocessedSales(tenantId: string, minAgeMs: number, limit: number): Promise<StrandedSale[]>;
  reemitMissingIntents(tenantId: string, minAgeMs: number, limit: number): Promise<ReemittedIntents>;
}

/** The posting event is still live in the outbox (the drainer owns it). */
const NO_LIVE_POSTING_EVENT = `NOT EXISTS (
         SELECT 1 FROM outbox_events o
          WHERE o.tenant_id = $1
            AND o.event_type = $4
            AND o.delivery_state IN ('pending', 'claimed', 'failed')
            AND o.payload->>'source_ref_id' = src.id::text)`;

/** No posting row exists for the source yet. */
const NO_POSTING_ROW = `NOT EXISTS (
         SELECT 1 FROM erpnext_posting_status p
          WHERE p.tenant_id = $1 AND p.source_ref_id = src.id)`;

const OLDER_THAN = `< now() - ($2::bigint * interval '1 millisecond')`;

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

  async findUnprocessedSales(tenantId: string, minAgeMs: number, limit: number): Promise<StrandedSale[]> {
    return runWithTenantContext(this.pool, { tenantId, isPlatformAdmin: false }, async (client) => {
      const r = await client.query<{ id: string; store_id: string }>(
        `SELECT id, store_id FROM sales
          WHERE tenant_id = $1 AND processed_at IS NULL AND created_at ${OLDER_THAN}
          ORDER BY created_at
          LIMIT $3`,
        [tenantId, minAgeMs, limit],
      );
      return r.rows.map((row) => ({ saleId: row.id, storeId: row.store_id }));
    });
  }

  async reemitMissingIntents(tenantId: string, minAgeMs: number, limit: number): Promise<ReemittedIntents> {
    return runWithTenantContext(this.pool, { tenantId, isPlatformAdmin: false }, async (client) => {
      const salePosts = await this.missing(
        client,
        `SELECT src.id, src.id AS sale_id, src.store_id FROM sales src
          WHERE src.tenant_id = $1 AND src.processed_at ${OLDER_THAN}`,
        [tenantId, minAgeMs, limit],
      );
      for (const row of salePosts) await this.emitIntent(client, tenantId, row, "sale_post");

      let reversal = 0;
      for (const table of REVERSAL_SOURCES) {
        const rows = await this.missing(
          client,
          `SELECT src.id, src.sale_id, src.store_id FROM ${table} src
            WHERE src.tenant_id = $1 AND src.created_at ${OLDER_THAN}`,
          [tenantId, minAgeMs, limit],
        );
        for (const row of rows) await this.emitIntent(client, tenantId, row, "reversal");
        reversal += rows.length;
      }
      return { salePost: salePosts.length, reversal };
    });
  }

  /** Sources selected by `base` that have no posting row and no live event. */
  private async missing(client: PoolClient, base: string, params: unknown[]): Promise<SourceRow[]> {
    const r = await client.query<SourceRow>(
      `${base}
          AND ${NO_POSTING_ROW}
          AND ${NO_LIVE_POSTING_EVENT}
        ORDER BY src.created_at
        LIMIT $3`,
      [...params, OUTBOX_EVENT_TYPES.ERPNEXT_POSTING_REQUESTED],
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
