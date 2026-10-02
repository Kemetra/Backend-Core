/**
 * T662 — 005-WAVE2-POLISH — SC-007 transactional integrity verification.
 *
 * Spec anchors: FR-053 (link atomicity), FR-063 (create-new atomicity),
 *               SC-007 (0% partially-committed reconciliation state).
 *
 * SC-007 requires that a reconciliation operation either fully commits or
 * leaves NO trace — never a partial state (alias without lifecycle
 * transition, lifecycle transition without alias, or a product without its
 * alias on the create-new path). This spec drives faults at each write
 * boundary and asserts zero partial state via direct DB reads.
 *
 * Two harnesses, by necessity:
 *
 *   1. Real Testcontainers fault injection (the spec's primary intent) —
 *      cases (1) and (3). A genuine alias unique-index violation (23505)
 *      aborts the real PostgreSQL transaction. We then query the live DB to
 *      prove nothing partial persisted. This exercises the actual transaction
 *      semantics FR-053/FR-063 depend on. Distinct from conflict-audit.spec
 *      (which proves the 409 status): here the headline is the negative-DB
 *      state assertions.
 *
 *   2. Mock-Pool invariant guard — case (2). The link path's
 *      "UPDATE rowCount=0 after a FOR UPDATE-locked pending row" cannot be
 *      triggered from PostgreSQL (it is the very invariant being defended).
 *      The only way to exercise that defensive rollback is a mock client that
 *      lies about rowCount. Reuses the proven pattern from conflict-audit.spec.
 *
 * Harness: ReconciliationService against Testcontainers Postgres 16 (cases 1,
 * 3) and a hand-rolled mock Pool (case 2). PG_POOL bound to localEnv.app
 * (RLS-active) for the real cases. Honors MIGRATION_TEST_ALLOW_SKIP=1.
 */
import "reflect-metadata";

import type { Pool, PoolClient, QueryResult } from "pg";

import {
  AUDIT_JOB_ENQUEUER,
  type AuditJobEnqueuer,
} from "../../../../src/audit/audit-job.enqueuer";
import { ReconciliationService } from "../../../../src/catalog/reconciliation/reconciliation.service";

import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../../_helpers/postgres-container";
import {
  seedCatalogIsolationFixture,
  TENANT_A,
  STORE_A_X,
  PRODUCT_A_ACTIVE,
} from "../../__support__/isolation-harness";

// ---------------------------------------------------------------------------
// Fixtures (hex-only UUID literals)
// ---------------------------------------------------------------------------

const ADMIN_USER = "0a000000-0000-7000-8000-000006620001";

// Case 1 (link conflict): store-scoped alias + pending item sharing it.
const UNK_LINK_CONFLICT = "0a000000-0000-7000-8000-00000662a001";
const UNK_LINK_CONFLICT_CORR = "0a000000-0000-7000-8000-000006620c01";
const LINK_CONFLICT_BARCODE = "T662-LINK-CONFLICT-001";
const ALIAS_LINK_SCOPED = "0a000000-0000-7000-8000-000006620a01";

// Case 3 (create conflict): second pending item sharing the same barcode,
// so create-new's alias INSERT collides.
const UNK_CREATE_CONFLICT = "0a000000-0000-7000-8000-00000662a002";
const UNK_CREATE_CONFLICT_CORR = "0a000000-0000-7000-8000-000006620c02";
const CREATE_PRODUCT_NAME = "Widget T662 Create Conflict";

// ---------------------------------------------------------------------------
// SpyAuditEnqueuer (the service needs an enqueuer for the rejection emit)
// ---------------------------------------------------------------------------

class NoopAuditEnqueuer implements AuditJobEnqueuer {
  async enqueue(): Promise<void> {
    /* no-op — atomicity tests do not assert on audit */
  }
}

let env: PgTestEnv | null = null;
let service: ReconciliationService | null = null;
let dockerSkipped = false;

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      dockerSkipped = true;
      // eslint-disable-next-line no-console
      console.warn(
        `\n[T662 atomicity.spec] Docker NOT AVAILABLE: ${msg}\n` +
          `MIGRATION_TEST_ALLOW_SKIP=1 set -- real-DB cases soft-skipped.\n`,
      );
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }

  await applyAllUpAndCreateAppRole(env);
  await seedCatalogIsolationFixture(env);

  // Store-scoped alias on STORE_A_X bound to PRODUCT_A_ACTIVE.
  await env.admin.query(
    `INSERT INTO product_aliases
       (id, tenant_id, product_id, identifier_type, value,
        source_system, store_id, created_by)
     VALUES ($1, $2, $3, 'barcode', $4, NULL, $5, $6)
     ON CONFLICT DO NOTHING`,
    [
      ALIAS_LINK_SCOPED, TENANT_A, PRODUCT_A_ACTIVE, LINK_CONFLICT_BARCODE,
      STORE_A_X, ADMIN_USER,
    ],
  );

  // Two pending items sharing that barcode: one for the link-conflict case,
  // one for the create-conflict case.
  await env.admin.query(
    `INSERT INTO unknown_items
       (id, tenant_id, store_id, identifier_type, value,
        source_system, resolution_status, correlation_id)
     VALUES
       ($1, $2, $3, 'barcode', $4, NULL, 'pending', $5),
       ($6, $2, $3, 'barcode', $4, NULL, 'pending', $7)
     ON CONFLICT DO NOTHING`,
    [
      UNK_LINK_CONFLICT, TENANT_A, STORE_A_X, LINK_CONFLICT_BARCODE,
      UNK_LINK_CONFLICT_CORR,
      UNK_CREATE_CONFLICT, UNK_CREATE_CONFLICT_CORR,
    ],
  );

  service = new ReconciliationService(env.app, new NoopAuditEnqueuer());
}, 180_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

// ---------------------------------------------------------------------------
// DB read helpers (admin pool — RLS-bypassed, so these observe true state)
// ---------------------------------------------------------------------------

async function aliasCount(value: string): Promise<number> {
  const r = await env!.admin.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM product_aliases
      WHERE tenant_id = $1 AND value = $2`,
    [TENANT_A, value],
  );
  return Number(r.rows[0]?.count ?? "0");
}

async function itemStatus(id: string): Promise<string> {
  const r = await env!.admin.query<{ resolution_status: string }>(
    `SELECT resolution_status FROM unknown_items WHERE id = $1`,
    [id],
  );
  return r.rows[0]?.resolution_status ?? "missing";
}

async function productCount(name: string): Promise<number> {
  const r = await env!.admin.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM tenant_products
      WHERE tenant_id = $1 AND name = $2`,
    [TENANT_A, name],
  );
  return Number(r.rows[0]?.count ?? "0");
}

// ===========================================================================
// 1. Real Testcontainers fault injection — SC-007 zero-partial-state
// ===========================================================================

describe("T662 / SC-007 — real-DB atomicity [FR-053, FR-063]", () => {
  it("(1) link alias-conflict leaves NO partial state (FR-053)", async () => {
    if (dockerSkipped || !service) return;

    const result = await service.linkUnknownItem({
      tenantId: TENANT_A,
      storeId: STORE_A_X,
      storeScope: { kind: "stores", storeIds: [STORE_A_X] },
      unknownItemId: UNK_LINK_CONFLICT,
      productId: PRODUCT_A_ACTIVE,
      actorUserId: ADMIN_USER,
    });

    expect(result.kind).toBe("alias_conflict");

    // SC-007: the alias write rolled back (only the pre-existing alias
    // remains — count stays 1, not 2) AND the lifecycle transition did NOT
    // happen (item still pending). Neither half of FR-053 committed.
    expect(await aliasCount(LINK_CONFLICT_BARCODE)).toBe(1);
    expect(await itemStatus(UNK_LINK_CONFLICT)).toBe("pending");
  });

  it("(3) create-new alias-conflict leaves NO partial state (FR-063)", async () => {
    if (dockerSkipped || !service) return;

    const result = await service.createProductFromUnknownItem({
      tenantId: TENANT_A,
      storeId: STORE_A_X,
      storeScope: { kind: "stores", storeIds: [STORE_A_X] },
      unknownItemId: UNK_CREATE_CONFLICT,
      actorUserId: ADMIN_USER,
      name: CREATE_PRODUCT_NAME,
      taxCategory: "standard",
      categoryId: null,
    });

    expect(result.kind).toBe("alias_conflict");

    // SC-007: all three create-path writes rolled back together —
    // no new product, no new alias (count still 1 = pre-existing only),
    // item still pending. FR-063: product + alias + transition or none.
    expect(await productCount(CREATE_PRODUCT_NAME)).toBe(0);
    expect(await aliasCount(LINK_CONFLICT_BARCODE)).toBe(1);
    expect(await itemStatus(UNK_CREATE_CONFLICT)).toBe("pending");
  });
});

// ===========================================================================
// 2. Mock-Pool invariant guard — the UPDATE-rowCount=0 rollback (case 2)
//
// The link path's `if (!updated) throw` invariant cannot be reached against
// real PostgreSQL: a FOR UPDATE-locked row with resolution_status='pending'
// always matches the subsequent UPDATE ... WHERE resolution_status='pending'.
// The only way to exercise the defensive rollback is a mock client that lies
// about rowCount. This asserts ROLLBACK is issued so the prior alias INSERT
// does not commit (the link half of FR-053's all-or-nothing guarantee).
// ===========================================================================

const emptyResult = (): QueryResult => ({
  command: "",
  rowCount: 0,
  oid: 0,
  rows: [],
  fields: [],
});

const pendingLockRow = (): Record<string, unknown> => ({
  id: UNK_LINK_CONFLICT,
  tenant_id: TENANT_A,
  store_id: STORE_A_X,
  identifier_type: "barcode",
  value: "T662-MOCK-001",
  source_system: null,
  resolution_status: "pending",
  resolution_action: null,
  resolved_at: null,
  resolved_by: null,
  resolved_product_id: null,
  encountered_at: new Date(),
  sale_context: null,
});

const activeProductRow = (): Record<string, unknown> => ({
  id: PRODUCT_A_ACTIVE,
  retired_at: null,
});

function buildMockClient(): { client: PoolClient; rolledBack: () => boolean } {
  let rolledBack = false;
  let lockServed = false;

  // ReconciliationService calls client.query(sqlString, params) exclusively —
  // never the pg QueryConfig-object overload. This mock matches that contract;
  // if the service ever switched to QueryConfig, the string branches below
  // would stop matching and this test would (correctly) fail loudly.
  const query = async (sql: string): Promise<QueryResult> => {
    if (sql === "ROLLBACK") rolledBack = true;
    if (!lockServed && /FROM unknown_items/i.test(sql) && /FOR UPDATE/i.test(sql)) {
      lockServed = true;
      return { ...emptyResult(), rowCount: 1, rows: [pendingLockRow()] };
    }
    if (/FROM tenant_products/i.test(sql)) {
      return { ...emptyResult(), rowCount: 1, rows: [activeProductRow()] };
    }
    // The terminal UPDATE ... RETURNING matches 0 rows -> invariant throw.
    if (/UPDATE unknown_items/i.test(sql) && /RETURNING/i.test(sql)) {
      return { ...emptyResult(), rowCount: 0, rows: [] };
    }
    return emptyResult();
  };

  const client = {
    query: query as PoolClient["query"],
    release: (() => undefined) as PoolClient["release"],
  } as unknown as PoolClient;

  return { client, rolledBack: () => rolledBack };
}

function buildMockPool(client: PoolClient): Pool {
  return { connect: async () => client } as unknown as Pool;
}

describe("T662 / SC-007 — defensive invariant rollback (mock harness)", () => {
  it("(2) link UPDATE matching 0 rows aborts the transaction (alias INSERT not committed)", async () => {
    const { client, rolledBack } = buildMockClient();
    const svc = new ReconciliationService(
      buildMockPool(client),
      new NoopAuditEnqueuer(),
    );

    await expect(
      svc.linkUnknownItem({
        tenantId: TENANT_A,
        storeId: STORE_A_X,
        storeScope: { kind: "stores", storeIds: [STORE_A_X] },
        unknownItemId: UNK_LINK_CONFLICT,
        productId: PRODUCT_A_ACTIVE,
        actorUserId: ADMIN_USER,
      }),
    ).rejects.toThrow(/invariant/i);

    // The whole transaction rolled back — the prior alias INSERT is aborted,
    // satisfying FR-053's all-or-nothing guarantee even on the invariant path.
    expect(rolledBack()).toBe(true);
  });
});
