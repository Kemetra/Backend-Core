/**
 * apps/api/test/catalog/erpnext-reconciliation/__support__/seed-reconciliation.ts
 *
 * Slice 017-ISOLATION-HARNESS (T020) — erpnext_reconciliation_* test fixtures.
 *
 * Companion seed for the 017 reconciliation/repair surface. It builds ON TOP of
 * the 015 `seedPostingStatusFixture` (which itself layers catalog ⊕ sales ⊕ 015
 * posting rows) and adds:
 *
 *   - a 015 `permanently_rejected` posting dead-letter (the US1 backlog + US2
 *     repair target) — the 015 seed only creates pending/posted rows, so this
 *     flips a fresh row to permanently_rejected via the admin pool;
 *   - a 014 `erpnext_warehouse_map` (`stock`) for STORE_A_X (the US3 stock-run
 *     mapping) + a 009 on-hand movement (the DP2 side of the compare);
 *   - 017's OWN rows: a tenant-A reconciliation run + an open result (US3 review),
 *     and a tenant-B run (the cross-tenant target the sweep proves A can't read).
 *
 * All three 017 tables are TENANT-only — `store_id` is a tenant-local FK, not a
 * second RLS axis (0020) — so this seed sets only `app.current_tenant` and the
 * sweep's cross-store assertion is vacuous (mirrors the 015 seed note).
 *
 * IMPORTANT (execution-map stop): this file MUST NOT modify the 003-owned
 * `isolation-harness.ts`, the 008-owned `seed-sales.ts`, or the 015-owned
 * `seed-posting-status.ts`. It imports their IDs + the 015 seed and seeds only
 * NEW rows via the `admin` (RLS-bypassing) pool. `.ts` (not `.spec.ts`) so Jest
 * does not collect it as a test.
 *
 * IDs use the `…0e0517…` mnemonic shape (hex a-f only) to stay unique against the
 * catalog / 008 / 013 / 014 / 015 corpora.
 */
import {
  POSTING_STATUS_FIXTURE_IDS,
  seedPostingStatusFixture,
} from "../../erpnext-posting/__support__/seed-posting-status";
import {
  SALE_A_X,
  SALE_B_X,
  SALES_SOURCE_SYSTEM,
  type SeedableEnv,
} from "../../sales/__support__/seed-sales";
import {
  ACTOR_A,
  ACTOR_B,
  PRODUCT_A_ACTIVE,
  STORE_A_X,
  STORE_B_X,
  TENANT_A,
  TENANT_B,
} from "../../__support__/isolation-harness";

const PAYLOAD_HASH = "a".repeat(64);

// ----------------------------------------------------------------------------
// 017-specific fixture IDs
// ----------------------------------------------------------------------------

/** Tenant A — a 015 posting dead-letter (permanently_rejected; the US1/US2 target). */
export const POSTING_DEADLETTER_A = "0a000000-0000-7000-8000-00000e0517a1";
/** Tenant A — a reconciliation run (the US3 review target). */
export const RUN_A = "0a000000-0000-7000-8000-00000e0517a2";
/** Tenant A — an open result of RUN_A. */
export const RESULT_A = "0a000000-0000-7000-8000-00000e0517a3";
/** Tenant B — a reconciliation run (the cross-tenant target the sweep can't read). */
export const RUN_B = "0b000000-0000-7000-8000-00000e0517b1";

export interface ReconciliationFixtureIds {
  readonly tenantA: string;
  readonly tenantB: string;
  readonly storeAMapped: string;
  readonly storeBMapped: string;
  readonly actorA: string;
  readonly postingDeadletterA: string;
  readonly runA: string;
  readonly resultA: string;
  readonly runB: string;
}

export const RECONCILIATION_FIXTURE_IDS: ReconciliationFixtureIds = Object.freeze({
  tenantA: TENANT_A,
  tenantB: TENANT_B,
  storeAMapped: STORE_A_X,
  storeBMapped: STORE_B_X,
  actorA: ACTOR_A,
  postingDeadletterA: POSTING_DEADLETTER_A,
  runA: RUN_A,
  resultA: RESULT_A,
  runB: RUN_B,
});

/**
 * Seed the 017 fixtures. Calls `seedPostingStatusFixture` first (catalog ⊕ sales
 * ⊕ 015 posting rows), then adds the 015 dead-letter + 014 mapping + 009 movement
 * + 017 run/result rows. Idempotent (`ON CONFLICT DO NOTHING`).
 */
export async function seedReconciliationFixture(
  env: SeedableEnv,
): Promise<ReconciliationFixtureIds> {
  await seedPostingStatusFixture(env);
  const { admin } = env;

  // The catalog fixture uses ACTOR_A/ACTOR_B as `created_by` on catalog tables
  // (plain uuid columns, no FK), so they are NOT `users` rows. The 017 run table's
  // `actor_user_id` DOES FK to users(id) — seed both actors as users first.
  await admin.query(
    `INSERT INTO users (id, email, password_hash) VALUES
       ($1, 'recon-a@fixture.invalid', NULL),
       ($2, 'recon-b@fixture.invalid', NULL)
     ON CONFLICT (id) DO NOTHING`,
    [ACTOR_A, ACTOR_B],
  );

  // ---- A 015 posting dead-letter for tenant A (the US1 backlog / US2 target) --
  // The 015 seed creates pending/posted rows; the reconciliation backlog needs a
  // permanently_rejected one. Seed a fresh sale_post row on SALE_A_X directly.
  await admin.query(
    `INSERT INTO erpnext_posting_status
       (id, tenant_id, store_id, sale_id, kind, source_ref_id,
        source_system, external_id, payload_hash, status, rejection_category)
     VALUES ($1, $2, $3, $4, 'sale_post', $5, $6, 'dl-A-X', $7,
        'permanently_rejected', 'unmapped_item')
     ON CONFLICT DO NOTHING`,
    [
      POSTING_DEADLETTER_A,
      TENANT_A,
      STORE_A_X,
      SALE_A_X,
      // A distinct source_ref_id so it doesn't collide with the 015 seed's
      // POST_A_PENDING (which is keyed source_ref_id = SALE_A_X).
      POSTING_DEADLETTER_A,
      SALES_SOURCE_SYSTEM,
      PAYLOAD_HASH,
    ],
  );

  // ---- 014 warehouse mapping (stock) for STORE_A_X + a 009 on-hand movement ---
  await admin.query(
    `INSERT INTO erpnext_warehouse_map
       (id, tenant_id, store_id, purpose, erpnext_warehouse_ref, set_by, version)
     VALUES (gen_random_uuid(), $1, $2, 'stock', 'ERP-WH-017A', $3, 1)
     ON CONFLICT DO NOTHING`,
    [TENANT_A, STORE_A_X, ACTOR_A],
  );
  // A 009 inbound movement (the DP2 on-hand side of the stock compare).
  // occurred_at is NOT NULL with no default (§X — may be backfilled).
  await admin.query(
    `INSERT INTO stock_movements
       (id, tenant_id, store_id, tenant_product_ref, movement_type, quantity,
        stocking_unit, reason, occurred_at, created_by, stock_location_id, inventory_status)
     VALUES (gen_random_uuid(), $1, $2, $3, 'inbound', 7.0000, 'ea', '017 seed', now(), $4,
             (SELECT id FROM stock_locations WHERE store_id = $2::uuid AND kind = 'primary'), 'sellable')
     ON CONFLICT DO NOTHING`,
    [TENANT_A, STORE_A_X, PRODUCT_A_ACTIVE, ACTOR_A],
  );

  // ---- 017's OWN rows: a tenant-A run + open result, and a tenant-B run --------
  await admin.query(
    `INSERT INTO erpnext_reconciliation_run
       (id, tenant_id, store_id, kind, trigger, status, finished_at, actor_user_id)
     VALUES ($1, $2, $3, 'stock', 'on_demand', 'completed', now(), $4)
     ON CONFLICT DO NOTHING`,
    [RUN_A, TENANT_A, STORE_A_X, ACTOR_A],
  );
  await admin.query(
    `INSERT INTO erpnext_reconciliation_result
       (id, run_id, tenant_id, mismatch_class, source_ref_id, result_state)
     VALUES ($1, $2, $3, 'quantity_divergence', $4, 'open')
     ON CONFLICT DO NOTHING`,
    [RESULT_A, RUN_A, TENANT_A, PRODUCT_A_ACTIVE],
  );
  await admin.query(
    `INSERT INTO erpnext_reconciliation_run
       (id, tenant_id, store_id, kind, trigger, status, finished_at, actor_user_id)
     VALUES ($1, $2, $3, 'stock', 'on_demand', 'completed', now(), $4)
     ON CONFLICT DO NOTHING`,
    [RUN_B, TENANT_B, STORE_B_X, ACTOR_B],
  );

  return RECONCILIATION_FIXTURE_IDS;
}
