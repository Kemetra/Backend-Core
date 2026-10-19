/**
 * ConsoleCatalogReadService — RT-730 (CAT-R2): the console read of the
 * Tenant Catalog (`catalog/console-catalog.yaml`, RT-729) for Admin-Console
 * RF-3 and the RT-724 link product picker. Read only: nothing here writes.
 *
 * DATA ACCESS — raw parameterized SQL under `runWithTenantContext` (tenant
 * RLS, `isPlatformAdmin: false`) plus an explicit `tenant_id` predicate on
 * every statement; the tenant is the session's, never the request's (§II).
 *
 * Invariants:
 *   - Products and categories are tenant data: every allowed role reads all of
 *     the tenant's (RT-281 decision O-7).
 *   - Store data follows the operator-surface store scope
 *     (`operator-store-scope.ts`, RT-51 D6 / RT-131 / RT-193), as an explicit
 *     store predicate:
 *       - `store_id` on the list must be inside the scope and of the tenant,
 *         else `StoreNotInScopeError` (404); its `storeView` is resolved by the
 *         shared read-down resolver (`store-product-resolution.ts`) with
 *         `app.current_store` pinned to that one store;
 *       - store-scoped identifiers count in the `q` match, and are listed on
 *         the detail, only for stores in the scope (only the `store_id` store
 *         when given);
 *       - the detail's overrides are read under the tenant-wide store GUC
 *         (`'*'`, the 0011 carve-out) with `store_id = ANY(scope)`, the
 *         unknown-items list precedent. An empty scope matches no store row.
 *   - Paging: keyset over `(matchRank, name, id)`, over-fetching one row to
 *     detect the next page. No trigram index (O-8): the name match scans the
 *     tenant's products that pass the status and category filters.
 *   - No audit write (O-6).
 */
import { Inject, Injectable } from "@nestjs/common";
import { runWithTenantContext } from "@data-pulse-2/db";
import type { Pool, PoolClient } from "pg";

import { PG_POOL } from "../../auth/auth.module";
import { MembershipRepository } from "../../context/membership.repository";
import { callerStoreScope, inStoreScope, scopeStoreIds } from "../../context/operator-store-scope";
import type { StoreScope } from "../../context/store-scope";
import type { ResolvedContext } from "../../context/types";
import {
  pinOverrideStore,
  RESOLVED_STORE_COLUMNS_SQL,
  storeOverrideJoinSql,
  type ResolvedStoreColumns,
} from "../store-resolution/store-product-resolution";
import {
  toCategory,
  toDetail,
  toStoreView,
  toSummary,
  type CategoryRow,
  type ConsoleCatalogCategory,
  type ConsoleCatalogProductDetail,
  type ConsoleCatalogProductPage,
  type IdentifierRow,
  type OverrideRow,
  type ProductDetailRow,
  type ProductSummaryRow,
} from "./console-catalog.projections";
import {
  decodeCatalogCursor,
  encodeCatalogCursor,
  substringPattern,
  type CatalogCursorBinding,
  type CatalogProductFilters,
  type CatalogProductKeyset,
  type ProductStatusFilter,
} from "./console-catalog.query";

/** A product that is absent or of another tenant → 404. */
export class CatalogProductNotFoundError extends Error {
  constructor() {
    super("product not found");
    this.name = "CatalogProductNotFoundError";
  }
}

/** A `store_id` outside the caller's scope, of another tenant or absent → 404. */
export class CatalogStoreNotInScopeError extends Error {
  constructor() {
    super("store not found");
    this.name = "CatalogStoreNotInScopeError";
  }
}

/** The session context of a read; its store scope bounds the store data. */
export interface ScopedCatalogReadInput {
  readonly tenantId: string;
  readonly context: ResolvedContext;
}

export interface ListCatalogProductsInput extends ScopedCatalogReadInput {
  readonly filters: CatalogProductFilters;
  readonly cursor: string | null;
  readonly limit: number;
}

/** The tenant status predicate per filter value (static SQL, never user text). */
const STATUS_SQL: Readonly<Record<ProductStatusFilter, string>> = {
  active: "tp.retired_at IS NULL AND tp.is_active",
  inactive: "tp.retired_at IS NULL AND NOT tp.is_active",
  retired: "tp.retired_at IS NOT NULL",
  any: "TRUE",
};

/** The oldest active tenant-wide identifier of one type, as the product's primary one. */
function primaryIdentifierSql(type: "sku" | "barcode"): string {
  return `(
          SELECT pa.value FROM product_aliases pa
           WHERE pa.tenant_id = tp.tenant_id AND pa.product_id = tp.id
             AND pa.identifier_type = '${type}' AND pa.store_id IS NULL AND pa.retired_at IS NULL
           ORDER BY pa.created_at, pa.value
           LIMIT 1
        )`;
}

/** The `ProductSummaryRow` columns over `tp` and `cat`. */
const PRODUCT_SUMMARY_COLUMNS_SQL = `
        tp.id::text AS product_id,
        tp.name,
        tp.is_active,
        tp.retired_at,
        tp.category_id::text AS category_id,
        cat.name AS category_name,
        ${primaryIdentifierSql("sku")} AS primary_sku,
        ${primaryIdentifierSql("barcode")} AS primary_barcode,
        tp.default_price::text AS default_price,
        tp.default_currency_code,
        tp.tax_category,
        tp.tracking_mode,
        tp.updated_at`;

const CATEGORY_JOIN_SQL = `
      LEFT JOIN tenant_product_categories cat
        ON cat.id = tp.category_id AND cat.tenant_id = tp.tenant_id`;

/**
 * One list page. $1 tenant, $2 q (null = none), $3 identifier stores (null =
 * every store), $4 category, $5 name pattern, $6..$8 keyset (null = first
 * page), $9 limit, $10 the `storeView` store (only with `withStore`).
 */
function listSql(status: ProductStatusFilter, withStore: boolean): string {
  return `
    WITH exact AS (
      SELECT DISTINCT pa.product_id
        FROM product_aliases pa
       WHERE $2::text IS NOT NULL
         AND pa.tenant_id = $1::uuid
         AND pa.identifier_type IN ('barcode', 'sku', 'plu')
         AND pa.value = $2::text
         AND pa.retired_at IS NULL
         AND (pa.store_id IS NULL OR $3::uuid[] IS NULL OR pa.store_id = ANY($3::uuid[]))
    ),
    candidates AS (
      SELECT tp.id, tp.name,
             CASE WHEN $2::text IS NULL OR tp.id IN (SELECT product_id FROM exact) THEN 0 ELSE 1 END AS match_rank
        FROM tenant_products tp
       WHERE tp.tenant_id = $1::uuid
         AND ${STATUS_SQL[status]}
         AND ($4::uuid IS NULL OR tp.category_id = $4::uuid)
    ),
    page AS (
      SELECT c.id, c.name, c.match_rank
        FROM candidates c
       WHERE (c.match_rank = 0 OR c.name ILIKE $5::text ESCAPE '\\')
         AND ($6::int IS NULL OR (c.match_rank, c.name, c.id) > ($6::int, $7::text, $8::uuid))
       ORDER BY c.match_rank, c.name, c.id
       LIMIT $9
    )
    SELECT page.match_rank,
           ${PRODUCT_SUMMARY_COLUMNS_SQL}${withStore ? `,${RESOLVED_STORE_COLUMNS_SQL}` : ""}
      FROM page
      JOIN tenant_products tp ON tp.id = page.id AND tp.tenant_id = $1::uuid
      ${CATEGORY_JOIN_SQL}
      ${withStore ? storeOverrideJoinSql("$10::uuid") : ""}
     ORDER BY page.match_rank, page.name, page.id`;
}

const DETAIL_SQL = `
    SELECT ${PRODUCT_SUMMARY_COLUMNS_SQL},
           tp.description,
           tp.expiry_required,
           tp.source_global_product_id::text AS source_global_product_id,
           tp.created_at
      FROM tenant_products tp
      ${CATEGORY_JOIN_SQL}
     WHERE tp.tenant_id = $1::uuid AND tp.id = $2::uuid`;

/** $1 tenant, $2 product, $3 scoped store ids (null = tenant-wide). */
const IDENTIFIERS_SQL = `
    SELECT identifier_type, value, store_id::text AS store_id, source_system, created_at
      FROM product_aliases
     WHERE tenant_id = $1::uuid AND product_id = $2::uuid AND retired_at IS NULL
       AND (store_id IS NULL OR $3::uuid[] IS NULL OR store_id = ANY($3::uuid[]))
     ORDER BY identifier_type, store_id NULLS FIRST, value, source_system, created_at`;

/** $1 tenant, $2 product, $3 scoped store ids (null = tenant-wide). */
const OVERRIDES_SQL = `
    SELECT store_id::text AS store_id, price::text AS price, currency_code, is_active, tax_category, updated_at
      FROM store_product_overrides
     WHERE tenant_id = $1::uuid AND product_id = $2::uuid AND retired_at IS NULL
       AND ($3::uuid[] IS NULL OR store_id = ANY($3::uuid[]))
     ORDER BY store_id`;

const CATEGORIES_SQL = `
    SELECT id::text AS category_id, name, description, updated_at
      FROM tenant_product_categories
     WHERE tenant_id = $1::uuid AND retired_at IS NULL
     ORDER BY name, id`;

const STORE_IN_TENANT_SQL = `SELECT 1 FROM stores WHERE id = $1::uuid AND tenant_id = $2::uuid`;

type ListRow = ProductSummaryRow & Partial<ResolvedStoreColumns> & { match_rank: 0 | 1 };

@Injectable()
export class ConsoleCatalogReadService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(MembershipRepository) private readonly memberships: MembershipRepository,
  ) {}

  /**
   * One page of the tenant's matching products. The cursor is decoded (400 on
   * a foreign token) before any read; the store is checked against the
   * caller's scope on every page.
   */
  async list(input: ListCatalogProductsInput): Promise<ConsoleCatalogProductPage> {
    const binding: CatalogCursorBinding = { tenantId: input.tenantId, filters: input.filters };
    const keyset = input.cursor === null ? null : decodeCatalogCursor(binding, input.cursor);
    const { q, status, categoryId, storeId } = input.filters;
    return this.inTenant(input, async (client) => {
      const scope = await callerStoreScope(client, this.memberships, input);
      if (storeId !== null) await this.requireStoreInScope(client, input.tenantId, scope, storeId);
      const identifierStores = storeId !== null ? [storeId] : scopeStoreIds(scope);
      const params: unknown[] = [
        input.tenantId,
        q,
        identifierStores === null ? null : [...identifierStores],
        categoryId,
        q === null ? null : substringPattern(q),
        keyset?.matchRank ?? null,
        keyset?.name ?? null,
        keyset?.productId ?? null,
        input.limit + 1,
      ];
      if (storeId !== null) {
        await pinOverrideStore(client, storeId);
        params.push(storeId);
      }
      const r = await client.query<ListRow>(listSql(status, storeId !== null), params);
      const rows = r.rows.slice(0, input.limit);
      const last = rows.at(-1);
      const next: CatalogProductKeyset | null =
        r.rows.length > input.limit && last !== undefined
          ? { matchRank: last.match_rank, name: last.name, productId: last.product_id }
          : null;
      return {
        items: rows.map((row) =>
          storeId === null
            ? toSummary(row)
            : { ...toSummary(row), storeView: toStoreView(storeId, row as ListRow & ResolvedStoreColumns) },
        ),
        nextCursor: next === null ? null : encodeCatalogCursor(binding, next),
      };
    });
  }

  /** One product of the tenant with its in-scope identifiers and overrides; CatalogProductNotFoundError otherwise. */
  async get(input: ScopedCatalogReadInput, productId: string): Promise<ConsoleCatalogProductDetail> {
    return this.inTenant(input, async (client) => {
      const product = await client.query<ProductDetailRow>(DETAIL_SQL, [input.tenantId, productId]);
      const row = product.rows[0];
      if (row === undefined) throw new CatalogProductNotFoundError();
      const scope = await callerStoreScope(client, this.memberships, input);
      const stores = scopeStoreIds(scope);
      const storeParam = stores === null ? null : [...stores];
      const identifiers = await client.query<IdentifierRow>(IDENTIFIERS_SQL, [input.tenantId, productId, storeParam]);
      // Tenant-wide store GUC; the explicit `store_id = ANY(scope)` predicate bounds the rows.
      await client.query("SELECT set_config('app.current_store', '*', true)");
      const overrides = await client.query<OverrideRow>(OVERRIDES_SQL, [input.tenantId, productId, storeParam]);
      return toDetail(row, identifiers.rows, overrides.rows);
    });
  }

  /** The tenant's active categories, flat, by name. */
  async listCategories(input: ScopedCatalogReadInput): Promise<ConsoleCatalogCategory[]> {
    return this.inTenant(input, async (client) => {
      const r = await client.query<CategoryRow>(CATEGORIES_SQL, [input.tenantId]);
      return r.rows.map(toCategory);
    });
  }

  private async requireStoreInScope(
    client: PoolClient,
    tenantId: string,
    scope: StoreScope,
    storeId: string,
  ): Promise<void> {
    if (!inStoreScope(scope, storeId)) throw new CatalogStoreNotInScopeError();
    const store = await client.query(STORE_IN_TENANT_SQL, [storeId, tenantId]);
    if (store.rowCount === 0) throw new CatalogStoreNotInScopeError();
  }

  private inTenant<T>(input: ScopedCatalogReadInput, work: (client: PoolClient) => Promise<T>): Promise<T> {
    return runWithTenantContext(this.pool, { tenantId: input.tenantId, isPlatformAdmin: false }, work);
  }
}
