/**
 * RT-730 — fixture for the console catalog read spec.
 *
 * Builds on the RT-562 console-sales fixture (tenants A/B, STORE_A_X granted
 * to the `specific` owner and tenant_admin, STORE_A_Y never granted to them,
 * the store_manager granted X + Y, the store_staff, the platform admins and
 * the bearers) and adds tenant A catalog rows, every name prefixed `RT730`:
 *
 *   P_WATER      active, CAT_DRINKS, 8.5000 EGP, sku `W-1`, barcode `000123`,
 *                retired barcode `999000`, plu `4242` scoped to STORE_A_Y;
 *                overrides X (9.0000 EGP, tax `reduced`) and Y (7.0000 EGP)
 *   P_JUICE      active, barcode `123`; override X deactivates it
 *   P_LOOKALIKE  active, named after P_WATER's sku (`W-1`), sorts first by name
 *   P_PERCENT    active, `50%` in its name
 *   P_ODD        active, 9.9990 EGP (not representable: off the POS stream)
 *   P_UNPRICED   active, no price
 *   P_INACTIVE   is_active false
 *   P_RETIRED    retired
 *   CAT_OLD      a retired category
 * Tenant B: P_B with the same barcode `000123` and CAT_B.
 *
 * `.ts` (not `.spec.ts`) so Jest does not collect it. IDs use the `0730`
 * mnemonic (hex only).
 */
import type { Pool } from "pg";

import type { PgTestEnv } from "../../../_helpers/postgres-container";
import { seedConsoleSalesFixture } from "../../../console-sales/__support__/console-sales-fixture";
import { STORE_A_X, STORE_A_Y, TENANT_A, TENANT_B } from "../../__support__/isolation-harness";

const a = (tag: string): string => `0a000000-0000-7000-8000-${tag.padStart(12, "0")}`;
const b = (tag: string): string => `0b000000-0000-7000-8000-${tag.padStart(12, "0")}`;

export const P_WATER = a("730a01");
export const P_JUICE = a("730a02");
export const P_LOOKALIKE = a("730a03");
export const P_PERCENT = a("730a04");
export const P_ODD = a("730a05");
export const P_UNPRICED = a("730a06");
export const P_INACTIVE = a("730a07");
export const P_RETIRED = a("730a08");
export const P_B = b("730b01");

export const CAT_DRINKS = a("730c01");
export const CAT_OLD = a("730c02");
export const CAT_B = b("730c03");

const ACTOR = a("730e01");

/** Every tenant-A fixture product, in `name ASC` order. */
export const ACTIVE_BY_NAME = [P_LOOKALIKE, P_PERCENT, P_JUICE, P_ODD, P_UNPRICED, P_WATER];
export const ALL_BY_NAME = [P_LOOKALIKE, P_PERCENT, P_INACTIVE, P_JUICE, P_ODD, P_RETIRED, P_UNPRICED, P_WATER];

interface SeedProduct {
  readonly id: string;
  readonly tenantId?: string;
  readonly name: string;
  readonly categoryId?: string | null;
  readonly price?: string | null;
  readonly active?: boolean;
  readonly retired?: boolean;
}

const PRODUCTS: readonly SeedProduct[] = [
  { id: P_WATER, name: "RT730 Water", categoryId: CAT_DRINKS, price: "8.5000" },
  { id: P_JUICE, name: "RT730 Juice", categoryId: CAT_OLD, price: "5.0000" },
  { id: P_LOOKALIKE, name: "RT730 Aaa W-1 lookalike", price: "1.0000" },
  { id: P_PERCENT, name: "RT730 Bbb 50% off", price: "2.0000" },
  { id: P_ODD, name: "RT730 Odd price", price: "9.9990" },
  { id: P_UNPRICED, name: "RT730 Unpriced", price: null },
  { id: P_INACTIVE, name: "RT730 Inactive soda", price: "3.0000", active: false },
  { id: P_RETIRED, name: "RT730 Retired tea", price: "4.0000", retired: true },
  { id: P_B, tenantId: TENANT_B, name: "RT730 Water B", categoryId: CAT_B, price: "8.5000" },
];

async function seedProduct(admin: Pool, p: SeedProduct): Promise<void> {
  await admin.query(
    `INSERT INTO tenant_products
       (id, tenant_id, name, category_id, default_price, default_currency_code, is_active,
        tax_category, retired_at, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5::numeric, CASE WHEN $5::numeric IS NULL THEN NULL ELSE 'EGP' END, $6,
             'standard', CASE WHEN $7::boolean THEN now() END, $8, $8)`,
    [p.id, p.tenantId ?? TENANT_A, p.name, p.categoryId ?? null, p.price ?? null, p.active ?? true, p.retired ?? false, ACTOR],
  );
}

async function seedAlias(
  admin: Pool,
  productId: string,
  type: string,
  value: string,
  opts: { storeId?: string; retired?: boolean; tenantId?: string } = {},
): Promise<void> {
  await admin.query(
    `INSERT INTO product_aliases (tenant_id, product_id, identifier_type, value, store_id, retired_at, created_by)
     VALUES ($1, $2, $3, $4, $5, CASE WHEN $6::boolean THEN now() END, $7)`,
    [opts.tenantId ?? TENANT_A, productId, type, value, opts.storeId ?? null, opts.retired ?? false, ACTOR],
  );
}

async function seedOverride(
  admin: Pool,
  productId: string,
  storeId: string,
  o: { price?: string; active?: boolean; tax?: string },
): Promise<void> {
  await admin.query(
    `INSERT INTO store_product_overrides
       (tenant_id, store_id, product_id, price, currency_code, is_active, tax_category, created_by, updated_by)
     VALUES ($1, $2, $3, $4::numeric, CASE WHEN $4::numeric IS NULL THEN NULL ELSE 'EGP' END, $5, $6, $7, $7)`,
    [TENANT_A, storeId, productId, o.price ?? null, o.active ?? null, o.tax ?? null, ACTOR],
  );
}

export async function seedConsoleCatalogFixture(env: PgTestEnv): Promise<void> {
  await seedConsoleSalesFixture(env);
  const admin = env.admin;
  await admin.query(
    `INSERT INTO tenant_product_categories (id, tenant_id, name, retired_at, created_by) VALUES
       ($1, $4, 'RT730 Drinks', NULL, $5),
       ($2, $4, 'RT730 Old', now(), $5),
       ($3, $6, 'RT730 B drinks', NULL, $5)`,
    [CAT_DRINKS, CAT_OLD, CAT_B, TENANT_A, ACTOR, TENANT_B],
  );
  for (const p of PRODUCTS) await seedProduct(admin, p);
  await seedAlias(admin, P_WATER, "sku", "W-1");
  await seedAlias(admin, P_WATER, "barcode", "000123");
  await seedAlias(admin, P_WATER, "barcode", "999000", { retired: true });
  await seedAlias(admin, P_WATER, "plu", "4242", { storeId: STORE_A_Y });
  await seedAlias(admin, P_JUICE, "barcode", "123");
  await seedAlias(admin, P_B, "barcode", "000123", { tenantId: TENANT_B });
  await seedOverride(admin, P_WATER, STORE_A_X, { price: "9.0000", tax: "reduced" });
  await seedOverride(admin, P_WATER, STORE_A_Y, { price: "7.0000" });
  await seedOverride(admin, P_JUICE, STORE_A_X, { active: false });
}
