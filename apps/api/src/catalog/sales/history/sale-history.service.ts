/**
 * SaleHistoryService — the POS sale history reads and the reprint record
 * (Jira RT-539, RT-534 S3; contract `pos-sales/sale-history.yaml`
 * 1.0.0-draft; storage RT-538 migrations 0047 / 0048).
 *
 * Every call runs inside `runWithTenantContext` (tenant RLS); the queries add
 * explicit tenant, store and visibility predicates (`sale-history.reads.ts`).
 *
 * List (OD-534-4). Keyset on `(business_date, occurred_at, id) DESC`, the
 * 0048 index order, with `LIMIT page_size + 1` to know whether a next page
 * exists. The row comparison continues strictly after the last row, so sales
 * that arrive between pages never shift the walk. `occurred_at` is carried in
 * the cursor at microsecond precision; the visibility filter never is.
 *
 * Reprint: `sale-reprint.ts`. A refusal is returned (not thrown) from the
 * transaction so its audit row commits; the controller maps it.
 */
import { Inject, Injectable } from "@nestjs/common";
import { runWithTenantContext } from "@data-pulse-2/db";
import type { Pool } from "pg";

import { PG_POOL } from "../../../auth/auth.module";
import { toSaleHistoryItem, type SaleHistoryDetail, type SaleHistoryRow } from "./sale-history.projections";
import { decodeSaleHistoryCursor, encodeSaleHistoryCursor } from "./sale-history.query";
import { listQuery, loadDetail, SALE_SELECT_SQL } from "./sale-history.reads";
import type {
  ListSaleHistoryInput,
  RecordReprintInput,
  ReprintOutcome,
  SaleHistoryPage,
  SaleHistoryScope,
} from "./sale-history.types";
import { recordReprintInTransaction } from "./sale-reprint";

export type {
  ListSaleHistoryInput,
  RecordReprintInput,
  ReprintOutcome,
  ReprintRefusalReason,
  SaleHistoryPage,
  SaleHistoryScope,
  SaleHistoryVisibility,
  SaleReprintProjection,
} from "./sale-history.types";

/** The sale is not visible to the caller (another tenant, store or cashier, or absent). */
export class SaleHistoryNotFoundError extends Error {
  constructor() {
    super("sale not found");
    this.name = "SaleHistoryNotFoundError";
  }
}

@Injectable()
export class SaleHistoryService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /** One page of the caller's visible sales (400 on a foreign cursor, before any read). */
  listSales(input: ListSaleHistoryInput): Promise<SaleHistoryPage> {
    const scope = { tenantId: input.tenantId, storeId: input.storeId, filters: input.filters };
    const keyset = input.cursor === null ? null : decodeSaleHistoryCursor({ ...scope, cursor: input.cursor });
    return runWithTenantContext(this.pool, { tenantId: input.tenantId, isPlatformAdmin: false }, async (client) => {
      const store = await client.query<{ timezone: string; as_of: Date }>(
        `SELECT timezone, now() AS as_of FROM stores WHERE id = $1 AND tenant_id = $2`,
        [input.storeId, input.tenantId],
      );
      const storeRow = store.rows[0];
      if (storeRow === undefined) throw new Error("sale history: the principal's store is not resolvable");

      const q = listQuery(input, keyset);
      const rows = await client.query<SaleHistoryRow>(
        `${SALE_SELECT_SQL}
          WHERE ${q.where.join(" AND ")}
          ORDER BY s.business_date DESC, s.occurred_at DESC, s.id DESC
          LIMIT $${q.params.length + 1}`,
        [...q.params, input.pageSize + 1],
      );
      const page = rows.rows.slice(0, input.pageSize);
      const last = page.at(-1);
      const more = rows.rows.length > input.pageSize && last !== undefined;
      return {
        items: page.map(toSaleHistoryItem),
        nextCursor: more
          ? encodeSaleHistoryCursor({
              ...scope,
              keyset: { businessDate: last.business_date, occurredAtKey: last.occurred_at_key, saleId: last.sale_id },
            })
          : null,
        asOf: storeRow.as_of.toISOString(),
        storeTimezone: storeRow.timezone,
        visibility: input.visibility.kind,
        from: input.filters.from,
        to: input.filters.to,
      };
    });
  }

  /** The full recorded detail of one visible sale; SaleHistoryNotFoundError otherwise. */
  readDetail(scope: SaleHistoryScope, saleRef: string): Promise<SaleHistoryDetail> {
    return runWithTenantContext(this.pool, { tenantId: scope.tenantId, isPlatformAdmin: false }, async (client) => {
      const detail = await loadDetail(client, scope, saleRef);
      if (detail === null) throw new SaleHistoryNotFoundError();
      return detail.projection;
    });
  }

  /** Authorize or record one reprint (`sale-reprint.ts`); a refusal is an outcome, audited. */
  recordReprint(input: RecordReprintInput): Promise<ReprintOutcome> {
    return runWithTenantContext(this.pool, { tenantId: input.tenantId, isPlatformAdmin: false }, (client) =>
      recordReprintInTransaction(client, input),
    );
  }
}
