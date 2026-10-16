/**
 * ConsoleSalesReadService — RT-562 (RT-556 F2): the console read of received
 * sales (`console-sales.openapi.yaml` 1.0.0-draft, RT-561) that Admin-Console
 * spec 012 consumes. Read only: nothing here writes a sale.
 *
 * DATA ACCESS — raw parameterized SQL under `runWithTenantContext` (tenant
 * RLS), reusing the sale-history query and projection code (RT-539) so both
 * reads describe a sale identically.
 *
 * Invariants:
 *   - Tenant: RLS plus an explicit `tenant_id` predicate on every read; the
 *     tenant is the session's, never the request's (§II, §XII).
 *   - Store: the sales RLS policies are tenant-only, so the operator-surface
 *     store scope (`operator-store-scope.ts`, RT-51 D6 / RT-131 / RT-193) is
 *     enforced here. The list's `store_id` must be inside the scope and of the
 *     session tenant, else `StoreNotInScopeError`; every list query then
 *     carries `s.store_id = $store`. The detail resolves the sale with ONE
 *     query predicated on the tenant, the ref and the scope; the child reads
 *     run only for a sale that matched. An empty scope matches nothing.
 *   - Platform admins (the RT-383 shift-closes precedent): `RolesGuard` lets
 *     a platform admin's session through, and the scope is
 *     `callerStoreScope` of the session context. With no membership in the
 *     tenant: tenant-wide (`TenantContextGuard` publishes `storeAccess: all`),
 *     narrowed to the active store when one is set. With a membership, the
 *     role's operator-surface rule applies, so an owner / tenant_admin
 *     membership is not narrowed by the active store, exactly as for any
 *     owner. Never another tenant: the reads run with `isPlatformAdmin: false`.
 *   - Paging: the 0048 index order `(business_date, occurred_at, id) DESC`,
 *     the keyset in the index condition. The SQL carries only the tenant, the
 *     store, the range and the keyset, so every list read is the same range
 *     scan of the 0048 index. Every other filter is matched on the projected
 *     row (`assemblePage`), and a filtered request reads at most `scanLimit`
 *     rows: the page may be short or empty with a non-null cursor. An
 *     unfiltered request reads `page_size + 1`.
 */
import { Inject, Injectable } from "@nestjs/common";
import { runWithTenantContext } from "@data-pulse-2/db";
import type { Pool, PoolClient } from "pg";

import { PG_POOL } from "../auth/auth.module";
import type { SaleHistoryRow } from "../catalog/sales/history/sale-history.projections";
import type { SaleHistoryKeyset } from "../catalog/sales/history/sale-history.query";
import { listQuery, loadDetail, SALE_SELECT_SQL, type SaleQuery } from "../catalog/sales/history/sale-history.reads";
import { MembershipRepository } from "../context/membership.repository";
import { callerStoreScope, inStoreScope, scopeStoreIds } from "../context/operator-store-scope";
import type { StoreScope } from "../context/store-scope";
import type { ResolvedContext } from "../context/types";
import {
  assemblePage,
  toConsoleSaleDetail,
  type ConsoleSaleDetail,
  type ConsoleSalePage,
} from "./console-sales.projections";
import {
  decodeConsoleSaleCursor,
  encodeConsoleSaleCursor,
  hasAnyFilter,
  SCAN_LIMIT_DEFAULT,
  type ConsoleCursorBinding,
  type ConsoleSaleFilters,
} from "./console-sales.query";

/** DI token: the most rows one list request reads when a derived filter is set. */
export const CONSOLE_SALES_SCAN_LIMIT = Symbol("CONSOLE_SALES_SCAN_LIMIT");

/** A sale that is absent, of another tenant or outside the caller's store scope → 404. */
export class ConsoleSaleNotFoundError extends Error {
  constructor() {
    super("sale not found");
    this.name = "ConsoleSaleNotFoundError";
  }
}

/** A `store_id` outside the caller's scope, of another tenant or absent → 404. */
export class StoreNotInScopeError extends Error {
  constructor() {
    super("store not found");
    this.name = "StoreNotInScopeError";
  }
}

/** The session context of a read; its store scope bounds the sales. */
export interface ScopedReadInput {
  readonly tenantId: string;
  readonly context: ResolvedContext;
}

export interface ListConsoleSalesInput extends ScopedReadInput {
  /** Lower case. */
  readonly storeId: string;
  readonly filters: ConsoleSaleFilters;
  readonly cursor: string | null;
  readonly pageSize: number;
}

/** A store's timezone: the listed store (in scope), or the store of a sale that matched the scoped query. */
const STORE_TIMEZONE_SQL = `SELECT timezone FROM stores WHERE id = $1::uuid AND tenant_id = $2::uuid`;

/** $1 tenant, $2 sale ref, $3 scoped store ids (null = tenant-wide). */
const SCOPED_SALE_STORE_SQL = `
  SELECT s.store_id::text AS store_id
    FROM sales s
   WHERE s.tenant_id = $1::uuid AND s.id = $2::uuid
     AND ($3::uuid[] IS NULL OR s.store_id = ANY($3::uuid[]))`;

@Injectable()
export class ConsoleSalesReadService {
  private readonly scanLimit: number;

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(MembershipRepository) private readonly memberships: MembershipRepository,
    @Inject(CONSOLE_SALES_SCAN_LIMIT) scanLimit: number = SCAN_LIMIT_DEFAULT,
  ) {
    if (!Number.isInteger(scanLimit) || scanLimit < 1) throw new Error("console sales: the scan limit must be >= 1");
    this.scanLimit = scanLimit;
  }

  /**
   * One page of one store's received sales, newest first. The cursor is
   * decoded (400 on a foreign token) before any read; the store is checked
   * against the caller's scope on every page.
   */
  async list(input: ListConsoleSalesInput): Promise<ConsoleSalePage> {
    const binding: ConsoleCursorBinding = { tenantId: input.tenantId, storeId: input.storeId, filters: input.filters };
    const keyset = input.cursor === null ? null : decodeConsoleSaleCursor(binding, input.cursor);
    return this.inTenant(input, async (client) => {
      const scope = await callerStoreScope(client, this.memberships, input);
      if (!inStoreScope(scope, input.storeId)) throw new StoreNotInScopeError();
      const store = await client.query<{ timezone: string }>(STORE_TIMEZONE_SQL, [input.storeId, input.tenantId]);
      const storeRow = store.rows[0];
      if (storeRow === undefined) throw new StoreNotInScopeError();

      const readLimit = hasAnyFilter(input.filters) ? this.scanLimit : input.pageSize + 1;
      const rows = await this.readRange(client, input, keyset, readLimit);
      const asOf = await this.readClock(client);
      const page = assemblePage({
        rows,
        readLimit,
        pageSize: input.pageSize,
        storeRef: input.storeId,
        filters: input.filters,
      });
      return {
        items: page.items,
        nextCursor: page.resumeAfter === null ? null : encodeConsoleSaleCursor(binding, page.resumeAfter),
        asOf: asOf.toISOString(),
        storeRef: input.storeId,
        storeTimezone: storeRow.timezone,
        from: input.filters.from,
        to: input.filters.to,
      };
    });
  }

  /** The full recorded detail of one sale in the caller's scope; ConsoleSaleNotFoundError otherwise. */
  async get(input: ScopedReadInput, saleRef: string): Promise<ConsoleSaleDetail> {
    return this.inTenant(input, async (client) => {
      const storeId = await this.scopedSaleStore(client, input, saleRef);
      const detail = await loadDetail(client, { tenantId: input.tenantId, storeId, visibility: { kind: "store" } }, saleRef);
      if (detail === null) throw new ConsoleSaleNotFoundError();
      return toConsoleSaleDetail(detail.projection, storeId, await this.storeTimezone(client, input.tenantId, storeId));
    });
  }

  /**
   * The store of a sale inside the caller's scope, else ConsoleSaleNotFoundError. The
   * scope is a predicate of this one query: the sale is never fetched first and checked after.
   */
  private async scopedSaleStore(client: PoolClient, input: ScopedReadInput, saleRef: string): Promise<string> {
    const scope: StoreScope = await callerStoreScope(client, this.memberships, input);
    const matched = await client.query<{ store_id: string }>(SCOPED_SALE_STORE_SQL, [
      input.tenantId,
      saleRef,
      scopeStoreIds(scope),
    ]);
    const row = matched.rows[0];
    if (row === undefined) throw new ConsoleSaleNotFoundError();
    return row.store_id;
  }

  /**
   * `asOf`: the server clock AFTER the range read. Under READ COMMITTED the
   * read can see sales committed after this transaction began, so the
   * transaction's `now()` could precede an item's `receivedAt`; every sale the
   * read saw committed before this later `clock_timestamp()`.
   */
  private async readClock(client: PoolClient): Promise<Date> {
    const r = await client.query<{ as_of: Date }>(`SELECT clock_timestamp() AS as_of`);
    return r.rows[0]!.as_of;
  }

  /** The timezone of a store a matched sale belongs to. */
  private async storeTimezone(client: PoolClient, tenantId: string, storeId: string): Promise<string> {
    const store = await client.query<{ timezone: string }>(STORE_TIMEZONE_SQL, [storeId, tenantId]);
    const row = store.rows[0];
    if (row === undefined) throw new Error("console sales: the sale's store is not resolvable");
    return row.timezone;
  }

  /** The store's sales in the range after `keyset`, in list order, at most `limit` rows. */
  private async readRange(
    client: PoolClient,
    input: ListConsoleSalesInput,
    keyset: SaleHistoryKeyset | null,
    limit: number,
  ): Promise<SaleHistoryRow[]> {
    const { from, to } = input.filters;
    // Only tenant, store, range and keyset: the filters are matched on the projected rows.
    const q: SaleQuery = listQuery(
      {
        tenantId: input.tenantId,
        storeId: input.storeId,
        visibility: { kind: "store" },
        filters: { from, to, deviceRef: null, operatorUserId: null, saleNumber: null },
        cursor: null,
        pageSize: input.pageSize,
      },
      keyset,
    );
    const r = await client.query<SaleHistoryRow>(
      `${SALE_SELECT_SQL}
        WHERE ${q.where.join(" AND ")}
        ORDER BY s.business_date DESC, s.occurred_at DESC, s.id DESC
        LIMIT $${q.params.length + 1}`,
      [...q.params, limit],
    );
    return r.rows;
  }

  private inTenant<T>(input: ScopedReadInput, work: (client: PoolClient) => Promise<T>): Promise<T> {
    return runWithTenantContext(this.pool, { tenantId: input.tenantId, isPlatformAdmin: false }, work);
  }
}
