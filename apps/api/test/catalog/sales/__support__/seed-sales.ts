/**
 * seed-sales.ts — 008 sale-fact isolation fixtures (T014).
 *
 * Purpose
 * -------
 * Sibling helper to the 003-owned `isolation-harness.ts`. Seeds a disjoint set
 * of sale-fact rows — a captured sale + lines, a voided sale, and a refunded
 * sale — across the 4-cell tenant×store matrix (A.X / A.Y / B.X / B.Y), so the
 * 008 cross-tenant/cross-store + RLS-bypass sweep (`sales-sweep.spec.ts`) can
 * probe a populated row in every cell.
 *
 * MUST NOT modify `isolation-harness.ts` (003-owned per Standing Rules §3 and
 * the 008-ISOLATION-HARNESS slice stop condition). This file only **imports**
 * tenant/store/actor IDs + `SeedableEnv` from there.
 *
 * Schema (packages/db/drizzle/0012_sales.sql)
 * -------------------------------------------
 * Constraints honored:
 *   - sales/sale_refunds: currency_code ~ '^[A-Z]{3}$'; pos_total /
 *     pos_refund_amount >= 0.
 *   - gate-B NOT NULL: occurred_at, received_at (default now()), business_date.
 *   - payload_hash NOT NULL on every fact + terminal table.
 *   - composite FK (sale_id, tenant_id, store_id) -> sales(id, tenant_id,
 *     store_id): every child (line / void / refund) MUST point at a parent
 *     sale in the SAME tenant + store — so the parent sale per cell is inserted
 *     FIRST, then its children.
 *   - dedup UNIQUE (tenant_id, source_system, external_id) on sales / sale_voids
 *     / sale_refunds — fixtures use distinct external_ids.
 *
 * Tenants + stores + actors
 * -------------------------
 * Re-uses the SAME TENANT_A/B, STORE_A_X/Y, STORE_B_X/Y, ACTOR_A/B IDs from
 * `isolation-harness.ts`; consumers MUST run `seedCatalogIsolationFixture`
 * first so those parent rows exist.
 *
 * Discovery
 * ---------
 * `.ts` (not `.spec.ts`) so Jest's testMatch does not treat it as a test —
 * matches the 003/005 support-helper convention.
 */
import type { Pool } from "pg";

import {
  TENANT_A,
  TENANT_B,
  STORE_A_X,
  STORE_A_Y,
  STORE_B_X,
  STORE_B_Y,
  ACTOR_A,
  ACTOR_B,
} from "../../__support__/isolation-harness";

export type { SeedableEnv } from "../../__support__/isolation-harness";
import type { SeedableEnv } from "../../__support__/isolation-harness";

// ----------------------------------------------------------------------------
// Fixture IDs — `5a1e` ("sale") mnemonic, hex-safe, disjoint UUID space.
// One captured sale per cell; plus a voided sale and a refunded sale per cell.
// ----------------------------------------------------------------------------

// Captured sales (one per cell).
export const SALE_A_X = "0a000000-0000-7000-8000-00005a1e0a01";
export const SALE_A_Y = "0a000000-0000-7000-8000-00005a1e0a02";
export const SALE_B_X = "0b000000-0000-7000-8000-00005a1e0b01";
export const SALE_B_Y = "0b000000-0000-7000-8000-00005a1e0b02";

// Two sale_lines per captured sale (only A.X + B.X get lines — enough to probe
// the child table in each tenant without doubling the footprint).
export const LINE_A_X_1 = "0a000000-0000-7000-8000-00005a1e1a11";
export const LINE_A_X_2 = "0a000000-0000-7000-8000-00005a1e1a12";
export const LINE_B_X_1 = "0b000000-0000-7000-8000-00005a1e1b11";
export const LINE_B_X_2 = "0b000000-0000-7000-8000-00005a1e1b12";

// A separately-captured sale per cell that carries a terminal VOID event.
export const SALE_VOIDED_A_X = "0a000000-0000-7000-8000-00005a1e0a03";
export const SALE_VOIDED_B_X = "0b000000-0000-7000-8000-00005a1e0b03";
export const VOID_A_X = "0a000000-0000-7000-8000-00005a1ed0a1";
export const VOID_B_X = "0b000000-0000-7000-8000-00005a1ed0b1";

// A separately-captured sale per cell that carries a terminal REFUND event.
export const SALE_REFUNDED_A_X = "0a000000-0000-7000-8000-00005a1e0a04";
export const SALE_REFUNDED_B_X = "0b000000-0000-7000-8000-00005a1e0b04";
export const REFUND_A_X = "0a000000-0000-7000-8000-00005a1ee0a1";
export const REFUND_B_X = "0b000000-0000-7000-8000-00005a1ee0b1";

// Shared source system for the fixture provenance/dedup keys.
/** RT-73: one return per tenant, against line 1 of the store-X sale. */
export const RETURN_A_X = "0a000000-0000-7000-8000-00005a1ef0a1";
export const RETURN_B_X = "0b000000-0000-7000-8000-00005a1ef0b1";

export const SALES_SOURCE_SYSTEM = "fixture-pos";

/** A deterministic 64-hex placeholder payload hash (shape only — not verified here). */
const PAYLOAD_HASH =
  "0000000000000000000000000000000000000000000000000000000000000000";

/** Strongly-typed bundle of every ID this helper creates. */
export interface SalesFixtureIds {
  readonly tenantA: string;
  readonly tenantB: string;
  readonly storeAX: string;
  readonly storeAY: string;
  readonly storeBX: string;
  readonly storeBY: string;
  readonly saleAX: string;
  readonly saleAY: string;
  readonly saleBX: string;
  readonly saleBY: string;
  readonly lineAX1: string;
  readonly lineAX2: string;
  readonly lineBX1: string;
  readonly lineBX2: string;
  readonly voidedSaleAX: string;
  readonly voidedSaleBX: string;
  readonly voidAX: string;
  readonly voidBX: string;
  readonly refundedSaleAX: string;
  readonly refundedSaleBX: string;
  readonly refundAX: string;
  readonly refundBX: string;
  readonly sourceSystem: string;
}

export const SALES_FIXTURE_IDS: SalesFixtureIds = Object.freeze({
  tenantA: TENANT_A,
  tenantB: TENANT_B,
  storeAX: STORE_A_X,
  storeAY: STORE_A_Y,
  storeBX: STORE_B_X,
  storeBY: STORE_B_Y,
  saleAX: SALE_A_X,
  saleAY: SALE_A_Y,
  saleBX: SALE_B_X,
  saleBY: SALE_B_Y,
  lineAX1: LINE_A_X_1,
  lineAX2: LINE_A_X_2,
  lineBX1: LINE_B_X_1,
  lineBX2: LINE_B_X_2,
  voidedSaleAX: SALE_VOIDED_A_X,
  voidedSaleBX: SALE_VOIDED_B_X,
  voidAX: VOID_A_X,
  voidBX: VOID_B_X,
  refundedSaleAX: SALE_REFUNDED_A_X,
  refundedSaleBX: SALE_REFUNDED_B_X,
  refundAX: REFUND_A_X,
  refundBX: REFUND_B_X,
  sourceSystem: SALES_SOURCE_SYSTEM,
});

/**
 * Row counts after `seedSalesFixture` succeeds (all in a disjoint UUID space,
 * so the 003/005/007 fixtures are unaffected):
 *   - sales:        8  (4 captured-with/without-lines + 2 voided + 2 refunded)
 *   - sale_lines:   4  (2 on SALE_A_X, 2 on SALE_B_X)
 *   - sale_voids:   2  (one per tenant, store X)
 *   - sale_refunds: 2  (one per tenant, store X)
 */
export const SALES_FIXTURE_COUNT = Object.freeze({
  sales: 8,
  saleLines: 4,
  saleVoids: 2,
  saleRefunds: 2,
} as const);

/**
 * Seed the 008 sale-fact fixture against `env.admin` (RLS-bypass — the seed
 * sets up every cell; the sweep then probes via `env.app` under RLS).
 * Idempotent via `ON CONFLICT DO NOTHING`.
 *
 * Preconditions (consumer responsibilities):
 *   - Postgres container running; migrations 0000–0012 applied via
 *     `applyAllUpAndCreateAppRole`.
 *   - `seedCatalogIsolationFixture` has run (parent tenants/stores/actors).
 */
export async function seedSalesFixture(
  env: SeedableEnv,
): Promise<SalesFixtureIds> {
  const { admin }: { admin: Pool } = env;

  // ---- captured sales (parents) — one per cell --------------------------
  // business_date is a DATE (store-tz derived in prod; a literal date here).
  await admin.query(
    `INSERT INTO sales
       (id, tenant_id, store_id, currency_code, pos_total, occurred_at,
        business_date, source_system, external_id, payload_hash, created_by)
     VALUES
       ($1,  $2,  $3,  'USD', 12.5000, now(), '2026-05-01', $4, 'sale-A-X', $5, $6),
       ($7,  $2,  $8,  'USD', 12.5000, now(), '2026-05-01', $4, 'sale-A-Y', $5, $6),
       ($9,  $10, $11, 'USD', 12.5000, now(), '2026-05-01', $4, 'sale-B-X', $5, $12),
       ($13, $10, $14, 'USD', 12.5000, now(), '2026-05-01', $4, 'sale-B-Y', $5, $12)
     ON CONFLICT DO NOTHING`,
    [
      SALE_A_X, TENANT_A, STORE_A_X, SALES_SOURCE_SYSTEM, PAYLOAD_HASH, ACTOR_A,
      SALE_A_Y, STORE_A_Y,
      SALE_B_X, TENANT_B, STORE_B_X, ACTOR_B,
      SALE_B_Y, STORE_B_Y,
    ],
  );

  // ---- sale_lines (children of SALE_A_X / SALE_B_X) ----------------------
  // Composite FK requires (sale_id, tenant_id, store_id) to match the parent.
  await admin.query(
    `INSERT INTO sale_lines
       (id, sale_id, tenant_id, store_id, line_name, unit_price, currency_code,
        quantity, line_amount, tax_amount, unit)
     VALUES
       ($1, $2, $3, $4, 'Widget',  5.0000, 'USD', 1.000000, 5.0000, 0.0000, 'ea'),
       ($5, $2, $3, $4, 'Gadget',  7.5000, 'USD', 1.000000, 7.5000, 0.0000, 'ea'),
       ($6, $7, $8, $9, 'Widget',  5.0000, 'USD', 1.000000, 5.0000, 0.0000, 'ea'),
       ($10,$7, $8, $9, 'Gadget',  7.5000, 'USD', 1.000000, 7.5000, 0.0000, 'ea')
     ON CONFLICT DO NOTHING`,
    [
      LINE_A_X_1, SALE_A_X, TENANT_A, STORE_A_X,
      LINE_A_X_2,
      LINE_B_X_1, SALE_B_X, TENANT_B, STORE_B_X,
      LINE_B_X_2,
    ],
  );

  // ---- sales that carry terminal events (separate parents) ---------------
  await admin.query(
    `INSERT INTO sales
       (id, tenant_id, store_id, currency_code, pos_total, occurred_at,
        business_date, source_system, external_id, payload_hash, created_by)
     VALUES
       ($1, $2,  $3, 'USD', 9.0000, now(), '2026-05-01', $4, 'sale-void-A-X',   $5, $6),
       ($7, $8,  $9, 'USD', 9.0000, now(), '2026-05-01', $4, 'sale-void-B-X',   $5, $10),
       ($11,$2,  $3, 'USD', 9.0000, now(), '2026-05-01', $4, 'sale-refund-A-X', $5, $6),
       ($12,$8,  $9, 'USD', 9.0000, now(), '2026-05-01', $4, 'sale-refund-B-X', $5, $10)
     ON CONFLICT DO NOTHING`,
    [
      SALE_VOIDED_A_X, TENANT_A, STORE_A_X, SALES_SOURCE_SYSTEM, PAYLOAD_HASH, ACTOR_A,
      SALE_VOIDED_B_X, TENANT_B, STORE_B_X, ACTOR_B,
      SALE_REFUNDED_A_X,
      SALE_REFUNDED_B_X,
    ],
  );

  // ---- sale_voids (one per tenant, store X) ------------------------------
  await admin.query(
    // business_date (0032, RT-63 P2) is a fixed seed date; production
    // computes it from voided_at in the store timezone at insert.
    `INSERT INTO sale_voids
       (id, sale_id, tenant_id, store_id, business_date, source_system,
        external_id, payload_hash, created_by)
     VALUES
       ($1, $2, $3, $4, '2026-05-01', $5, 'void-A-X', $6, $7),
       ($8, $9, $10, $11, '2026-05-01', $5, 'void-B-X', $6, $12)
     ON CONFLICT DO NOTHING`,
    [
      VOID_A_X, SALE_VOIDED_A_X, TENANT_A, STORE_A_X, SALES_SOURCE_SYSTEM, PAYLOAD_HASH, ACTOR_A,
      VOID_B_X, SALE_VOIDED_B_X, TENANT_B, STORE_B_X, ACTOR_B,
    ],
  );

  // ---- sale_refunds (one per tenant, store X) ----------------------------
  await admin.query(
    `INSERT INTO sale_refunds
       (id, sale_id, tenant_id, store_id, pos_refund_amount, currency_code,
        source_system, external_id, payload_hash, created_by)
     VALUES
       ($1, $2, $3, $4, 9.0000, 'USD', $5, 'refund-A-X', $6, $7),
       ($8, $9, $10, $11, 9.0000, 'USD', $5, 'refund-B-X', $6, $12)
     ON CONFLICT DO NOTHING`,
    [
      REFUND_A_X, SALE_REFUNDED_A_X, TENANT_A, STORE_A_X, SALES_SOURCE_SYSTEM, PAYLOAD_HASH, ACTOR_A,
      REFUND_B_X, SALE_REFUNDED_B_X, TENANT_B, STORE_B_X, ACTOR_B,
    ],
  );

  // ---- sale_returns + lines + tenders (RT-73; one per tenant, store X) ----
  await admin.query(
    `INSERT INTO sale_returns
       (id, sale_id, tenant_id, store_id, return_seq, business_date,
        currency_code, return_total, source_system, external_id,
        payload_hash, created_by)
     VALUES
       ($1, $2, $3, $4, 1, '2026-05-01', 'USD', 1.0000, $5, 'return-A-X', $6, $7),
       ($8, $9, $10, $11, 1, '2026-05-01', 'USD', 1.0000, $5, 'return-B-X', $6, $12)
     ON CONFLICT DO NOTHING`,
    [
      RETURN_A_X, SALE_A_X, TENANT_A, STORE_A_X, SALES_SOURCE_SYSTEM, PAYLOAD_HASH, ACTOR_A,
      RETURN_B_X, SALE_B_X, TENANT_B, STORE_B_X, ACTOR_B,
    ],
  );
  await admin.query(
    `INSERT INTO sale_return_lines
       (return_id, sale_line_id, tenant_id, store_id, quantity, line_amount,
        returned_quantity_after)
     VALUES
       ($1, $2, $3, $4, 1, 1.0000, 1),
       ($5, $6, $7, $8, 1, 1.0000, 1)
     ON CONFLICT DO NOTHING`,
    [RETURN_A_X, LINE_A_X_1, TENANT_A, STORE_A_X, RETURN_B_X, LINE_B_X_1, TENANT_B, STORE_B_X],
  );
  await admin.query(
    `INSERT INTO sale_return_tenders
       (return_id, tenant_id, store_id, ordinal, method, amount)
     VALUES ($1, $2, $3, 0, 'cash', 1.0000), ($4, $5, $6, 0, 'cash', 1.0000)
     ON CONFLICT DO NOTHING`,
    [RETURN_A_X, TENANT_A, STORE_A_X, RETURN_B_X, TENANT_B, STORE_B_X],
  );

  // ---- sale_tenders (RT-77; one per tenant, the store-X captured sale) ----
  await admin.query(
    `INSERT INTO sale_tenders
       (sale_id, tenant_id, store_id, method, amount, currency_code)
     VALUES ($1, $2, $3, 'cash', 1.0000, 'USD'), ($4, $5, $6, 'cash', 1.0000, 'USD')
     ON CONFLICT DO NOTHING`,
    [SALE_A_X, TENANT_A, STORE_A_X, SALE_B_X, TENANT_B, STORE_B_X],
  );
  // Capture writes tender_count with the rows in one transaction; the posting
  // feed refuses a sale whose visible tenders differ from it (RT-77).
  await admin.query(`UPDATE sales SET tender_count = 1 WHERE id IN ($1, $2)`, [
    SALE_A_X,
    SALE_B_X,
  ]);

  return SALES_FIXTURE_IDS;
}
