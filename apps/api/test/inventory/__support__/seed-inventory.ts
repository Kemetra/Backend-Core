/**
 * seed-inventory.ts — 009 inventory-ledger isolation fixtures (T014).
 *
 * Purpose
 * -------
 * Sibling helper to the 003-owned `isolation-harness.ts`. Seeds a disjoint set
 * of inventory rows — stock_movements across the 4-cell tenant×store matrix
 * (A.X / A.Y / B.X / B.Y), plus a sale-linked movement (provenance ref to an
 * 008 captured sale) and an ad-hoc NULL-product movement — so the 009
 * cross-tenant/cross-store + RLS-bypass sweep (`inventory-sweep.spec.ts`) can
 * probe a populated row in every cell.
 *
 * MUST NOT modify `isolation-harness.ts` (003-owned per Standing Rules §3 and
 * the 009-ISOLATION-HARNESS slice stop condition). This file only **imports**
 * tenant/store/product/actor IDs from there.
 *
 * Schema (packages/db/drizzle/0014_inventory.sql)
 * -----------------------------------------------
 * Constraints honored:
 *   - quantity NUMERIC(19,4), SIGNED (outbound negative); occurred_at /
 *     received_at NOT NULL (received_at defaults now()).
 *   - movement_type ∈ {inbound,outbound,adjustment,transfer_out,transfer_in,
 *     count_correction}; write-off = reason-coded outbound.
 *   - stock_movements_count_correction_link: movement_type='count_correction'
 *     IFF stock_count_id IS NOT NULL — so the generic fixtures use NON-
 *     count_correction types with NULL stock_count_id, and the count_correction
 *     fixture sets stock_count_id (parented by a seeded stock_counts row).
 *   - stock_movements_provenance_pair: (source_system IS NULL)=(external_id
 *     IS NULL) — the sale-linked fixture sets BOTH; generic fixtures set neither.
 *   - reason CHECK: char_length(reason) <= 500.
 *   - tenant_product_ref -> tenant_products (nullable; the ad-hoc fixture sets
 *     it NULL, R5).
 *
 * Tenants + stores + products + actors
 * ------------------------------------
 * Re-uses the SAME TENANT_A/B, STORE_A_X/Y, STORE_B_X/Y, PRODUCT_A_ACTIVE /
 * PRODUCT_B_ACTIVE (tenant_products), ACTOR_A/B IDs from `isolation-harness.ts`;
 * consumers MUST run `seedCatalogIsolationFixture` FIRST so those parent rows
 * exist. For the sale-linked fixture, `seedSalesFixture` must also have run so
 * the referenced captured sale exists (008-owned helper).
 *
 * Position (RT-432, migration 0044): every new movement must carry a stock
 * location of its own store and an inventory status; these fixtures land at the
 * store's `primary` location (created with the store) and `sellable`, as the
 * write paths do.
 *
 * Discovery
 * ---------
 * `.ts` (not `.spec.ts`) so Jest's testMatch does not treat it as a test —
 * matches the 003/005/008 support-helper convention.
 */
import type { Pool } from "pg";

import {
  ACTOR_A,
  ACTOR_B,
  PRODUCT_A_ACTIVE,
  PRODUCT_B_ACTIVE,
  STORE_A_X,
  STORE_A_Y,
  STORE_B_X,
  STORE_B_Y,
  TENANT_A,
  TENANT_B,
} from "../../catalog/__support__/isolation-harness";

export type { SeedableEnv } from "../../catalog/__support__/isolation-harness";
import type { SeedableEnv } from "../../catalog/__support__/isolation-harness";

// ----------------------------------------------------------------------------
// Fixture IDs — `5704` ("stock", hex-safe) mnemonic, disjoint UUID space.
// One generic movement per cell + a sale-linked movement + an ad-hoc movement
// + a stock_count and its count_correction movement (all in cell A.X).
// (Mnemonic prefixes restricted to a-f hex per the UUID-hex-literals lesson.)
// ----------------------------------------------------------------------------

// One generic stock movement per tenant×store cell.
export const MOVE_A_X = "0a000000-0000-7000-8000-00005704a0a1";
export const MOVE_A_Y = "0a000000-0000-7000-8000-00005704a0a2";
export const MOVE_B_X = "0b000000-0000-7000-8000-00005704b0b1";
export const MOVE_B_Y = "0b000000-0000-7000-8000-00005704b0b2";

// A sale-linked outbound movement in A.X (provenance ref to an 008 sale).
export const MOVE_SALE_LINKED_A_X = "0a000000-0000-7000-8000-00005704a5a1";

// An ad-hoc (NULL tenant_product_ref) movement in A.X.
export const MOVE_ADHOC_A_X = "0a000000-0000-7000-8000-00005704adac";

// A stock_count + its count_correction movement in A.X.
export const COUNT_A_X = "0a000000-0000-7000-8000-00005704c0a1";
export const MOVE_CORRECTION_A_X = "0a000000-0000-7000-8000-00005704cca1";

// Provenance source for the sale-linked / backfill dedup pair.
export const INVENTORY_SOURCE_SYSTEM = "fixture-backfill";

export interface InventoryFixtureIds {
  readonly tenantA: string;
  readonly tenantB: string;
  readonly storeAX: string;
  readonly storeAY: string;
  readonly storeBX: string;
  readonly storeBY: string;
  readonly moveAX: string;
  readonly moveAY: string;
  readonly moveBX: string;
  readonly moveBY: string;
  readonly moveSaleLinkedAX: string;
  readonly moveAdhocAX: string;
  readonly countAX: string;
  readonly moveCorrectionAX: string;
  readonly sourceSystem: string;
}

export const INVENTORY_FIXTURE_IDS: InventoryFixtureIds = Object.freeze({
  tenantA: TENANT_A,
  tenantB: TENANT_B,
  storeAX: STORE_A_X,
  storeAY: STORE_A_Y,
  storeBX: STORE_B_X,
  storeBY: STORE_B_Y,
  moveAX: MOVE_A_X,
  moveAY: MOVE_A_Y,
  moveBX: MOVE_B_X,
  moveBY: MOVE_B_Y,
  moveSaleLinkedAX: MOVE_SALE_LINKED_A_X,
  moveAdhocAX: MOVE_ADHOC_A_X,
  countAX: COUNT_A_X,
  moveCorrectionAX: MOVE_CORRECTION_A_X,
  sourceSystem: INVENTORY_SOURCE_SYSTEM,
});

/**
 * Seed the 009 inventory isolation fixtures.
 *
 * Pre-conditions:
 *   - Postgres container running; migrations 0000–0014 applied via
 *     `applyAllUpAndCreateAppRole`.
 *   - `seedCatalogIsolationFixture` has run (parent tenants/stores/products/
 *     actors). For `moveSaleLinkedAX`, `seedSalesFixture` must also have run if
 *     the test asserts on the referenced sale; the movement's sale_id/
 *     sale_line_id are PROVENANCE ONLY (NOT foreign keys, FR-032), so the
 *     movement seeds regardless — the reference need not resolve.
 */
export async function seedInventoryFixture(
  env: SeedableEnv,
): Promise<InventoryFixtureIds> {
  const { admin }: { admin: Pool } = env;

  // ---- actor users (audit FK) -------------------------------------------
  // `createStockMovement` writes an audit_events row IN-TRANSACTION whose
  // `actor_user_id` carries a real FK -> users(id) (0000_initial.sql).
  // ACTOR_A/ACTOR_B are 003-owned isolation IDs used across catalog tables as
  // bare `created_by` UUIDs (those columns are NOT FK'd to users), so the
  // catalog fixture never inserts them into `users`. Catalog audit is written
  // via HTTP-authed paths (real users); inventory tests drive the service
  // DIRECTLY with a synthetic ACTOR_A principal, so the audit FK has no target
  // on a clean DB and the INSERT fails. Seed the actor users here — the single
  // chokepoint every inventory spec imports — mirroring the working pattern in
  // audit/audit.repository.spec.ts. Idempotent; safe if a future catalog
  // change starts seeding them.
  await admin.query(
    `INSERT INTO users (id, email, password_hash) VALUES
       ($1, 'actor-a@fixture.invalid', NULL),
       ($2, 'actor-b@fixture.invalid', NULL)
     ON CONFLICT DO NOTHING`,
    [ACTOR_A, ACTOR_B],
  );

  // ---- one generic stock movement per cell ------------------------------
  // inbound (+) at A.X / B.X, outbound (−) at A.Y / B.Y — enough signed
  // variety to probe each cell. Generic: NULL provenance + NULL stock_count_id.
  await admin.query(
    `INSERT INTO stock_movements
       (id, tenant_id, store_id, movement_type, quantity, stocking_unit,
        tenant_product_ref, reason, occurred_at, created_by,
        stock_location_id, inventory_status)
     VALUES
       ($1, $2,  $3, 'inbound',   10.0000, 'ea', $4,  'seed inbound',  now(), $5,
        (SELECT id FROM stock_locations WHERE store_id = $3::uuid AND kind = 'primary'), 'sellable'),
       ($6, $2,  $7, 'outbound',  -3.0000, 'ea', $4,  'seed outbound', now(), $5,
        (SELECT id FROM stock_locations WHERE store_id = $7::uuid AND kind = 'primary'), 'sellable'),
       ($8, $9,  $10,'inbound',   10.0000, 'ea', $11, 'seed inbound',  now(), $12,
        (SELECT id FROM stock_locations WHERE store_id = $10::uuid AND kind = 'primary'), 'sellable'),
       ($13,$9,  $14,'outbound',  -3.0000, 'ea', $11, 'seed outbound', now(), $12,
        (SELECT id FROM stock_locations WHERE store_id = $14::uuid AND kind = 'primary'), 'sellable')
     ON CONFLICT DO NOTHING`,
    [
      MOVE_A_X, TENANT_A, STORE_A_X, PRODUCT_A_ACTIVE, ACTOR_A,
      MOVE_A_Y, STORE_A_Y,
      MOVE_B_X, TENANT_B, STORE_B_X, PRODUCT_B_ACTIVE, ACTOR_B,
      MOVE_B_Y, STORE_B_Y,
    ],
  );

  // ---- sale-linked outbound (A.X) — provenance pair set (FR-031/032) -----
  // sale_id is provenance only (NOT an FK); a placeholder ref is fine here.
  await admin.query(
    `INSERT INTO stock_movements
       (id, tenant_id, store_id, movement_type, quantity, stocking_unit,
        tenant_product_ref, source_system, external_id, sale_id, occurred_at,
        created_by, stock_location_id, inventory_status)
     VALUES
       ($1, $2, $3, 'outbound', -1.0000, 'ea', $4, $5, 'backfill-A-X-1',
        '0a000000-0000-7000-8000-00005a1e0a01', now(), $6,
        (SELECT id FROM stock_locations WHERE store_id = $3::uuid AND kind = 'primary'), 'sellable')
     ON CONFLICT DO NOTHING`,
    [
      MOVE_SALE_LINKED_A_X, TENANT_A, STORE_A_X, PRODUCT_A_ACTIVE,
      INVENTORY_SOURCE_SYSTEM, ACTOR_A,
    ],
  );

  // ---- ad-hoc movement (A.X) — NULL tenant_product_ref (R5) --------------
  await admin.query(
    `INSERT INTO stock_movements
       (id, tenant_id, store_id, movement_type, quantity, stocking_unit,
        tenant_product_ref, reason, occurred_at, created_by,
        stock_location_id, inventory_status)
     VALUES
       ($1, $2, $3, 'adjustment', 2.0000, 'ea', NULL, 'ad-hoc no product', now(), $4,
        (SELECT id FROM stock_locations WHERE store_id = $3::uuid AND kind = 'primary'), 'sellable')
     ON CONFLICT DO NOTHING`,
    [MOVE_ADHOC_A_X, TENANT_A, STORE_A_X, ACTOR_A],
  );

  // ---- stock_count (A.X) + its count_correction movement -----------------
  // The count_correction movement MUST set stock_count_id (biconditional CHECK)
  // and that composite (stock_count_id, tenant_id, store_id) must match a
  // stock_counts row in the SAME tenant+store.
  await admin.query(
    `INSERT INTO stock_counts
       (id, tenant_id, store_id, tenant_product_ref, counted_quantity,
        derived_on_hand_at_count, stocking_unit, created_by)
     VALUES
       ($1, $2, $3, $4, 5.0000, 7.0000, 'ea', $5)
     ON CONFLICT DO NOTHING`,
    [COUNT_A_X, TENANT_A, STORE_A_X, PRODUCT_A_ACTIVE, ACTOR_A],
  );
  await admin.query(
    `INSERT INTO stock_movements
       (id, tenant_id, store_id, movement_type, quantity, stocking_unit,
        tenant_product_ref, stock_count_id, reason, occurred_at, created_by,
        stock_location_id, inventory_status)
     VALUES
       ($1, $2, $3, 'count_correction', -2.0000, 'ea', $4, $5,
        'count variance', now(), $6, (SELECT id FROM stock_locations WHERE store_id = $3::uuid AND kind = 'primary'), 'sellable')
     ON CONFLICT DO NOTHING`,
    [
      MOVE_CORRECTION_A_X, TENANT_A, STORE_A_X, PRODUCT_A_ACTIVE, COUNT_A_X,
      ACTOR_A,
    ],
  );

  return INVENTORY_FIXTURE_IDS;
}
