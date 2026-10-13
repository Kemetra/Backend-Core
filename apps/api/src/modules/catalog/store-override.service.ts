/**
 * StoreOverrideService — slice T372 (003 Catalog Foundation, Phase 5.3).
 *
 * Implements `create` for `store_product_overrides` per
 * `specs/003-catalog-foundation/data-model.md §5` and the RLS policies in
 * migration `0007_catalog.sql` (`store_product_overrides_tenant_write` +
 * `store_product_overrides_store_read`).
 *
 * Q8 contract — non-overrideable fields
 * -------------------------------------
 * Per spec §5.3 Q8, the store-level override CANNOT change a product's
 * `name` or `categoryId` (`category_id`). Those are tenant-product-level
 * attributes; permitting them at the store level would break the catalog
 * inheritance model. This service rejects any DTO carrying those fields
 * with `BadRequestException` (HTTP 400) BEFORE touching the database —
 * the test harness asserts zero `pool.query` / `pool.connect` calls in
 * the rejection path.
 *
 * Tenant + store GUC management
 * -----------------------------
 * `create` opens its own `runWithTenantContext` transaction using the
 * DTO's `tenantId` and additionally sets `app.current_store` to the
 * DTO's `storeId` via `set_config(..., true)` (transaction-local). Both
 * GUCs are required for the table's RLS write policy:
 *
 *   USING / WITH CHECK (
 *     tenant_id = current_setting('app.current_tenant', true)::uuid
 *     AND store_id = current_setting('app.current_store',  true)::uuid
 *   )
 *
 * Trust boundary: this service treats `dto.tenantId` and `dto.storeId`
 * as authoritative. A controller layer must populate them from the
 * resolved request context (active tenant + active store), never from
 * the request body. The current RED+GREEN slice exercises the service
 * directly; controller wiring is out of scope here.
 *
 * Error contract
 * --------------
 *   - 400 — DTO contains `name` or `categoryId` (Q8 violation).
 *   - DB errors (FK violation, RLS policy denial, CHECK constraint)
 *     propagate as-is. Mapping to nicer HTTP codes is a controller
 *     concern handled in later slices.
 */
import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";

import { newId } from "@data-pulse-2/shared";
import { runWithTenantContext } from "@data-pulse-2/db";

/**
 * DTO accepted by `StoreOverrideService.create`. Mirrors the shape used
 * by the RED suite at
 * `apps/api/test/catalog/store-override.service.create.spec.ts`.
 *
 * Per §5 data-model, at least one of `price` / `isActive` / `taxCategory`
 * must be present (table CHECK
 * `store_product_overrides_at_least_one_override`). This service does
 * NOT pre-validate that constraint; Postgres surfaces it as a 23514
 * which propagates to the caller. The current RED spec does not exercise
 * that branch.
 */
export interface CreateStoreOverrideDto {
  tenantId: string;
  storeId: string;
  productId: string;
  actorId: string;
  isActive?: boolean;
  price?: string;
  taxCategory?: string;
  /** Q8 forbidden — service rejects with 400 before any DB call. */
  name?: string;
  /** Q8 forbidden — service rejects with 400 before any DB call. */
  categoryId?: string;
}

export interface StoreOverrideRecord {
  id: string;
  tenantId: string;
  storeId: string;
  productId: string;
  isActive: boolean | null;
  price: string | null;
  currencyCode: string | null;
  taxCategory: string | null;
  createdAt: Date;
  updatedAt: Date;
  createdBy: string;
}

/**
 * Test seam: production callers pass nothing and the service uses the
 * real `runWithTenantContext`. Tests can pass an alternative runner if
 * they need to short-circuit the DB; the current RED+GREEN slice does
 * not exercise this seam.
 */
type TenantTxRunner = <T>(
  pool: Pool,
  ctx: { tenantId: string | null; isPlatformAdmin: boolean },
  work: (client: PoolClient) => Promise<T>,
) => Promise<T>;

@Injectable()
export class StoreOverrideService {
  private readonly tx: TenantTxRunner;

  constructor(
    private readonly pool: Pool,
    tx?: TenantTxRunner,
  ) {
    this.tx = tx ?? runWithTenantContext;
  }

  /**
   * Creates one `store_product_overrides` row.
   *
   * Order of operations (load-bearing):
   *   1. Synchronously reject Q8-forbidden DTO fields. ZERO DB calls
   *      have been made at this point — the RED spec asserts this via
   *      a Proxy that counts `.query()` and `.connect()` on the Pool.
   *   2. Generate the new id (UUIDv7 with v4 fallback per project
   *      convention).
   *   3. Open `runWithTenantContext` with the DTO's tenant — sets
   *      `app.current_tenant` and `app.is_platform_admin` GUCs on the
   *      transaction-scoped client.
   *   4. Set the `app.current_store` GUC on the same client — required
   *      by the store_product_overrides_tenant_write RLS policy.
   *   5. INSERT … RETURNING the persisted row.
   */
  async create(dto: CreateStoreOverrideDto): Promise<StoreOverrideRecord> {
    // (1) Q8 validation FIRST — no DB access permitted in this branch.
    // Use own-property presence (not `!== undefined`) so payloads like
    // `{ name: null }` or `{ categoryId: undefined }` are still rejected.
    // The Q8 contract is "DTO contains the key", not "DTO contains a
    // truthy value for the key".
    if (Object.hasOwn(dto, "name")) {
      throw new BadRequestException(
        "'name' is not overrideable at the store level (Q8).",
      );
    }
    if (Object.hasOwn(dto, "categoryId")) {
      throw new BadRequestException(
        "'categoryId' is not overrideable at the store level (Q8).",
      );
    }

    // (2) Generate id outside the transaction — cheap, deterministic shape.
    const id = newId();

    // (3) Open a tenant-scoped transaction.
    return this.tx(
      this.pool,
      { tenantId: dto.tenantId, isPlatformAdmin: false },
      async (client) => {
        // (4) Set the store GUC on the same client. transaction-local
        // (`is_local = true`) so it does not leak across pool reuse.
        await client.query(
          "SELECT set_config('app.current_store', $1, true)",
          [dto.storeId],
        );

        // (4b) Cross-tenant product reference guard. The S4 contract
        // requires that an override pointing to another tenant's product
        // is rejected. The original design assumed PG would enforce this
        // via the FK to `tenant_products(id)` under RLS, but PG's
        // referential-integrity triggers explicitly bypass RLS (see
        // PostgreSQL docs: "Referential integrity checks ... will always
        // bypass row level security"). So we SELECT under the current
        // tenant GUC first — the RLS policy on `tenant_products` hides
        // cross-tenant rows, returning zero rows when `dto.productId`
        // belongs to a different tenant, and we throw before INSERT.
        const productProbe = await client.query<{ exists: 1 }>(
          "SELECT 1 AS exists FROM tenant_products WHERE id = $1 LIMIT 1",
          [dto.productId],
        );
        if (productProbe.rowCount === 0) {
          throw new NotFoundException(
            `tenant_products row not visible under current tenant (id=${dto.productId})`,
          );
        }

        // (5) INSERT … RETURNING — Postgres enforces RLS WITH CHECK and
        // table CHECK constraints. The cross-tenant product case has
        // already been rejected above (step 4b).
        const res = await client.query<{
          id: string;
          tenant_id: string;
          store_id: string;
          product_id: string;
          is_active: boolean | null;
          price: string | null;
          currency_code: string | null;
          tax_category: string | null;
          created_at: Date;
          updated_at: Date;
          created_by: string;
        }>(
          `INSERT INTO store_product_overrides
             (id, tenant_id, store_id, product_id,
              is_active, price, tax_category,
              created_by, updated_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
           RETURNING id, tenant_id, store_id, product_id,
                     is_active, price, currency_code, tax_category,
                     created_at, updated_at, created_by`,
          [
            id,
            dto.tenantId,
            dto.storeId,
            dto.productId,
            dto.isActive ?? null,
            dto.price ?? null,
            dto.taxCategory ?? null,
            dto.actorId,
          ],
        );

        const row = res.rows[0];
        if (!row) {
          // Defensive: an INSERT … RETURNING with no row implies the
          // RLS WITH CHECK silently filtered it. Surface as an error
          // rather than a malformed return.
          throw new Error(
            "store_product_overrides INSERT returned no row (RLS filter?)",
          );
        }

        return {
          id: row.id,
          tenantId: row.tenant_id,
          storeId: row.store_id,
          productId: row.product_id,
          isActive: row.is_active,
          price: row.price,
          currencyCode: row.currency_code,
          taxCategory: row.tax_category,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          createdBy: row.created_by,
        };
      },
    );
  }
}
