/**
 * RT-428 — shared fixture for the pending-aware reconciliation specs
 * (packages/db helpers and the apps/worker 017 run): one tenant with one
 * mapped store and one product, and a sale with its posting row.
 *
 * Seeds on the superuser pool (no RLS). Every id is supplied by the caller.
 */
import type { Pool } from "pg";

import { applyAllUpAndCreateAppRole, startPgEnv, type PgTestEnv } from "./postgres-container";

export interface PendingAwareTenant {
  readonly tenantId: string;
  readonly storeId: string;
  readonly productId: string;
  readonly warehouse: string;
  /** The store's primary stock location (created by the stores trigger). */
  readonly locationId: string;
}

export interface PendingAwareTenantIds {
  readonly tenantId: string;
  readonly storeId: string;
  readonly productId: string;
  readonly slug: string;
  readonly actorId: string;
}

/** Tenant, store, actor user, product P with a confirmed map to ITEM-1, and the store's stock warehouse. */
export async function seedPendingAwareTenant(admin: Pool, ids: PendingAwareTenantIds): Promise<PendingAwareTenant> {
  const { tenantId, storeId, productId, actorId } = ids;
  const warehouse = `WH-${ids.slug}`;
  await admin.query(`INSERT INTO tenants (id, slug, name) VALUES ($1, $2, 'T')`, [tenantId, ids.slug]);
  await admin.query(`INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $2, $3, 'S')`, [storeId, tenantId, ids.slug]);
  await admin.query(
    `INSERT INTO users (id, email, password_hash) VALUES ($1, 'rt428@fixture.invalid', NULL) ON CONFLICT (id) DO NOTHING`,
    [actorId],
  );
  await admin.query(
    `INSERT INTO tenant_products (id, tenant_id, name, tax_category, created_by, updated_by) VALUES ($1, $2, 'P', 'standard', $3, $3)`,
    [productId, tenantId, actorId],
  );
  await admin.query(
    `INSERT INTO erpnext_item_map (id, tenant_id, tenant_product_id, erpnext_item_ref, state, suggestion_source, confirmed_by, confirmed_at)
     VALUES (gen_random_uuid(), $1, $2, 'ITEM-1', 'confirmed', 'manual', $3, now())`,
    [tenantId, productId, actorId],
  );
  await admin.query(
    `INSERT INTO erpnext_warehouse_map (id, tenant_id, store_id, purpose, erpnext_warehouse_ref, set_by, version)
     VALUES (gen_random_uuid(), $1, $2, 'stock', $3, $4, 1)`,
    [tenantId, storeId, warehouse, actorId],
  );
  const locationId = (
    await admin.query<{ id: string }>(`SELECT id FROM stock_locations WHERE store_id = $1 AND kind = 'primary'`, [storeId])
  ).rows[0]!.id;
  return { tenantId, storeId, productId, warehouse, locationId };
}

/** A sale at the store and its `sale_post` posting row in `status`; returns the posting row id. */
export async function seedSalePosting(
  admin: Pool,
  f: PendingAwareTenant,
  opts: { readonly saleId: string; readonly actorId: string; readonly status: string },
): Promise<string> {
  await admin.query(
    `INSERT INTO sales (id, tenant_id, store_id, currency_code, pos_total, occurred_at, business_date,
                        source_system, external_id, payload_hash, created_by)
     VALUES ($1, $2, $3, 'EGP', 0, now(), current_date, 'pos', $4, $5, $6)`,
    [opts.saleId, f.tenantId, f.storeId, `x-${opts.saleId}`, "0".repeat(64), opts.actorId],
  );
  const r = await admin.query<{ id: string }>(
    `INSERT INTO erpnext_posting_status (tenant_id, store_id, sale_id, kind, source_ref_id, source_system, external_id,
                                         payload_hash, status, document_ref, posted_at)
     VALUES ($1, $2, $3, 'sale_post', $3, 'pos', $4, $5, $6,
             CASE WHEN $6 = 'posted' THEN '{"name":"SINV"}' END, CASE WHEN $6 = 'posted' THEN now() END)
     RETURNING id`,
    [f.tenantId, f.storeId, opts.saleId, `x-${opts.saleId}`, "0".repeat(64), opts.status],
  );
  return r.rows[0]!.id;
}

/**
 * A Postgres with every migration and the app role, or null when Docker is
 * unavailable and MIGRATION_TEST_ALLOW_SKIP=1 (otherwise the error is thrown).
 */
export async function startMigratedEnvOrSkip(label: string): Promise<PgTestEnv | null> {
  let env: PgTestEnv;
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[${label}] Docker NOT AVAILABLE — skipping: ${String(err)}\n`);
      return null;
    }
    throw err;
  }
  await applyAllUpAndCreateAppRole(env);
  return env;
}
