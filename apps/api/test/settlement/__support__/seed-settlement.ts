/**
 * seed-settlement.ts — 035 T030 integration fixtures.
 *
 * Builds ON TOP of the 003-owned `seedCatalogIsolationFixture` (tenants A/B,
 * stores A-X/A-Y + B-X/B-Y, actors A/B) — which it calls first — and adds the
 * `sales` + `payer_account` rows the settlement specs exercise:
 *
 *   - tenant A: one `sales` row on STORE_A_X (the captured sale a settlement
 *     intent layers over) + an ACTIVE payer account on STORE_A_X and a
 *     tenant-wide payer account;
 *   - tenant B: one ACTIVE payer account — the cross-tenant target the isolation
 *     spec proves tenant A can never reference at intent (→ 409) nor read (→ 404).
 *
 * Seeds via the `admin` (RLS-bypassing superuser) pool. `.ts` (not `.spec.ts`)
 * so Jest does not collect it as a test. IDs use the `…d035…` mnemonic shape to
 * stay unique against the t340 catalog corpus.
 */
import {
  ACTOR_A,
  STORE_A_X,
  STORE_A_Y,
  STORE_B_X,
  TENANT_A,
  TENANT_B,
  seedCatalogIsolationFixture,
  type SeedableEnv,
} from "../../catalog/__support__/isolation-harness";

// ---------------------------------------------------------------------------
// 035-specific fixture IDs
// ---------------------------------------------------------------------------

/** Tenant A — the captured sale a settlement intent opens receivables over. */
export const SALE_A = "0a000000-0000-7000-8000-00000d035511";
/** Tenant A — an ACTIVE store-scoped payer account (resolvable at intent). */
export const PAYER_A_STORE = "0a000000-0000-7000-8000-00000d0355a1";
/** Tenant A — an ACTIVE tenant-wide payer account (store_id NULL). */
export const PAYER_A_TENANT = "0a000000-0000-7000-8000-00000d0355a2";
/** Tenant A — an ACTIVE payer scoped to a DIFFERENT store (STORE_A_Y). Used to
 *  prove a store-A-X intent may NOT name a store-A-Y-scoped payer (T033 §IX). */
export const PAYER_A_OTHER_STORE = "0a000000-0000-7000-8000-00000d0355a3";
/** Tenant B — an ACTIVE payer account (the cross-tenant target). */
export const PAYER_B = "0b000000-0000-7000-8000-00000d0355b1";
/** A syntactically-valid id that resolves to nothing in tenant A. */
export const PAYER_ABSENT = "0f000000-0000-7000-8000-00000000dead";

export interface SettlementFixtureIds {
  readonly tenantA: string;
  readonly tenantB: string;
  readonly storeAX: string;
  readonly storeBX: string;
  readonly actorA: string;
  readonly saleA: string;
  readonly payerAStore: string;
  readonly payerATenant: string;
  readonly payerAOtherStore: string;
  readonly payerB: string;
  readonly payerAbsent: string;
}

export const SETTLEMENT_FIXTURE_IDS: SettlementFixtureIds = Object.freeze({
  tenantA: TENANT_A,
  tenantB: TENANT_B,
  storeAX: STORE_A_X,
  storeBX: STORE_B_X,
  actorA: ACTOR_A,
  saleA: SALE_A,
  payerAStore: PAYER_A_STORE,
  payerATenant: PAYER_A_TENANT,
  payerAOtherStore: PAYER_A_OTHER_STORE,
  payerB: PAYER_B,
  payerAbsent: PAYER_ABSENT,
});

/**
 * Seed the 035 fixtures. Calls `seedCatalogIsolationFixture` first (tenants +
 * stores + actor identifiers), then adds the actor user, sale + payer rows. Idempotent
 * (`ON CONFLICT DO NOTHING`) so it is safe to call once per suite.
 */
export async function seedSettlementFixture(
  env: SeedableEnv,
): Promise<SettlementFixtureIds> {
  await seedCatalogIsolationFixture(env);
  const { admin } = env;

  // Transactional settlement audit has a real actor_user_id FK. The catalog
  // fixture uses actor identifiers as metadata but does not seed users.
  await admin.query(
    `INSERT INTO users (id, email) VALUES ($1, 'settlement-actor-a@example.test')
     ON CONFLICT DO NOTHING`,
    [ACTOR_A],
  );

  // ---- Tenant A: one captured sale on STORE_A_X (all NOT NULL cols) ---------
  await admin.query(
    `INSERT INTO sales
       (id, tenant_id, store_id, currency_code, pos_total,
        occurred_at, business_date, source_system, external_id,
        payload_hash, created_by)
     VALUES
       ($1, $2, $3, 'EGP', '120.0000',
        now(), CURRENT_DATE, 'pos-035', 'ext-035-001',
        'deadbeef035', $4)
     ON CONFLICT DO NOTHING`,
    [SALE_A, TENANT_A, STORE_A_X, ACTOR_A],
  );

  // ---- Tenant A: store-scoped (A_X) + tenant-wide + other-store (A_Y) payers -
  await admin.query(
    `INSERT INTO payer_account
       (id, tenant_id, store_id, category, display_name, status, version)
     VALUES
       ($1, $2, $3, 'insurer',         'Acme Insurer (A/store X)', 'active', 0),
       ($4, $2, NULL, 'credit_customer','House Account (A/tenant)', 'active', 0),
       ($5, $2, $6, 'insurer',         'Other Insurer (A/store Y)','active', 0)
     ON CONFLICT DO NOTHING`,
    [PAYER_A_STORE, TENANT_A, STORE_A_X, PAYER_A_TENANT, PAYER_A_OTHER_STORE, STORE_A_Y],
  );

  // ---- Tenant B: an ACTIVE payer account (cross-tenant target) --------------
  await admin.query(
    `INSERT INTO payer_account
       (id, tenant_id, store_id, category, display_name, status, version)
     VALUES
       ($1, $2, $3, 'insurer', 'Beta Insurer (B)', 'active', 0)
     ON CONFLICT DO NOTHING`,
    [PAYER_B, TENANT_B, STORE_B_X],
  );

  return SETTLEMENT_FIXTURE_IDS;
}
