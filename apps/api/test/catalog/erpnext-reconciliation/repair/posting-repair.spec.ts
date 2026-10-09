/**
 * 017-US2-REPAIR (T040–T044) — service-level posting-repair spec.
 *
 * Drives `ErpnextReconciliationService.repairPosting` directly (the HTTP
 * idempotency-interceptor + DashboardAuthGuard are proven in the companion
 * http-edge spec). Proves the repair re-uses the 015 O-3 state machine and the
 * four-status branching:
 *   §1 permanently_rejected + resolve OK → pending + re-head sequence +
 *      retry_count RESET to 0 (the budget-exhausted bug) → eligible_again;
 *      writes a repair_attempt + a platform audit_events row IN ONE TRANSACTION;
 *      the 008 sale fact is byte-for-byte unchanged.
 *   §2 permanently_rejected + resolve still fails → no transition → still_failing
 *      (returns to the backlog, class intact, FR-011).
 *   §3 posted → no_op_echo echoing the stored document_ref (O-3; no re-transition).
 *   §4 pending (a concurrent repair already re-offered) → no_op_echo, NO re-head.
 *   §5 cross-tenant workItemRef → RepairNotFoundError (RLS 0 rows).
 *
 * Docker policy: HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../../_helpers/postgres-container";
import {
  ErpnextReconciliationService,
  RepairNotFoundError,
} from "../../../../src/catalog/erpnext-reconciliation/erpnext-reconciliation.service";
import { MembershipRepository } from "../../../../src/context/membership.repository";
import type { ResolvedContext } from "../../../../src/context/types";
import { SALE_A_X } from "../../sales/__support__/seed-sales";
import { ACTOR_A, PRODUCT_A_ACTIVE, STORE_A_X } from "../../__support__/isolation-harness";
import {
  RECONCILIATION_FIXTURE_IDS,
  POSTING_DEADLETTER_A,
  seedReconciliationFixture,
} from "../__support__/seed-reconciliation";

let env: PgTestEnv | null = null;
let skip = false;
const TENANT_A = RECONCILIATION_FIXTURE_IDS.tenantA;
const TENANT_B = RECONCILIATION_FIXTURE_IDS.tenantB;

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    await seedReconciliationFixture(env);
    // Make SALE_A_X's lines resolvable: point them at PRODUCT_A_ACTIVE + confirm an
    // item map. The seed already maps STORE_A_X to a warehouse. So a repair of
    // POSTING_DEADLETTER_A (on SALE_A_X, STORE_A_X) now RESOLVES.
    const a = env.admin;
    await a.query(`UPDATE sale_lines SET tenant_product_ref = $1 WHERE sale_id = $2`, [
      PRODUCT_A_ACTIVE,
      SALE_A_X,
    ]);
    await a.query(
      `INSERT INTO erpnext_item_map
         (id, tenant_id, tenant_product_id, erpnext_item_ref, state, suggestion_source, confirmed_by, confirmed_at)
       VALUES (gen_random_uuid(), $1, $2, 'ERP-ITEM-017A', 'confirmed', 'manual', $3, now())
       ON CONFLICT DO NOTHING`,
      [TENANT_A, PRODUCT_A_ACTIVE, ACTOR_A],
    );
  } catch (err) {
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      skip = true;
      // eslint-disable-next-line no-console
      console.warn(`[posting-repair.spec] Docker unavailable: ${String(err)}`);
      return;
    }
    throw err;
  }
}, 180_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

function svc(): ErpnextReconciliationService {
  if (!env) throw new Error("Docker unavailable");
  return new ErpnextReconciliationService(env.app, new MembershipRepository(env.app));
}

/**
 * RT-191: the session context the service's writes take. Tenant-wide store
 * access, as `TenantContextGuard` resolves it for an `'all'` membership (ACTOR_A
 * has no membership row here, so the scope comes from `storeAccess`).
 */
function sessionCtx(tenantId: string): ResolvedContext {
  return {
    userId: ACTOR_A,
    tenantId,
    storeId: null,
    isPlatformAdmin: false,
    source: "session",
    storeAccess: { kind: "all" },
  };
}

/** Reset the dead-letter to a pristine permanently_rejected, budget-exhausted state. */
async function resetDeadletter(retryCount = 5): Promise<void> {
  await env!.admin.query(
    `UPDATE erpnext_posting_status
        SET status='permanently_rejected', document_ref=NULL,
            rejection_category='unmapped_item', retry_count=$2
      WHERE id=$1`,
    [POSTING_DEADLETTER_A, retryCount],
  );
}

async function statusRow(): Promise<{ status: string; retry_count: number; sequence: string }> {
  const r = await env!.admin.query<{ status: string; retry_count: number; sequence: string }>(
    `SELECT status, retry_count, sequence::text AS sequence
       FROM erpnext_posting_status WHERE id = $1`,
    [POSTING_DEADLETTER_A],
  );
  return r.rows[0]!;
}

describe("017-US2 §1 — repair re-offers a resolvable dead-letter", () => {
  it("flips to pending, re-heads sequence, RESETS retry_count to 0 → eligible_again", async () => {
    if (skip) return;
    await resetDeadletter(5); // budget-exhausted
    const seqBefore = (await statusRow()).sequence;
    const beforeSale = await env!.admin.query(`SELECT * FROM sales WHERE id = $1`, [SALE_A_X]);

    const res = await svc().repairPosting({
      tenantId: TENANT_A,
      context: sessionCtx(TENANT_A),
      actorUserId: ACTOR_A,
      workItemRef: POSTING_DEADLETTER_A,
    });
    expect(res.repair.outcome).toBe("eligible_again");
    expect(res.replayed).toBe(false);

    const row = await statusRow();
    expect(row.status).toBe("pending");
    expect(row.retry_count).toBe(0); // the budget-exhausted reset (else instant re-DLQ)
    expect(BigInt(row.sequence)).toBeGreaterThan(BigInt(seqBefore)); // re-headed

    // §IX: the 008 sale fact is byte-for-byte unchanged.
    const afterSale = await env!.admin.query(`SELECT * FROM sales WHERE id = $1`, [SALE_A_X]);
    expect(afterSale.rows[0]).toEqual(beforeSale.rows[0]);

    // Audit + repair_attempt both written.
    const attempt = await env!.admin.query<{ outcome: string }>(
      `SELECT outcome FROM erpnext_reconciliation_repair_attempt
        WHERE tenant_id=$1 AND target_ref_id=$2 ORDER BY created_at DESC LIMIT 1`,
      [TENANT_A, POSTING_DEADLETTER_A],
    );
    expect(attempt.rows[0]?.outcome).toBe("eligible_again");
    const audit = await env!.admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_events
        WHERE tenant_id=$1 AND action='erpnext_reconciliation.posting.repaired' AND target_id=$2`,
      [TENANT_A, POSTING_DEADLETTER_A],
    );
    expect(Number(audit.rows[0]?.count)).toBeGreaterThanOrEqual(1);
  });
});

describe("017-US2 §2 — repair of a still-unresolvable dead-letter", () => {
  it("leaves it permanently_rejected → still_failing (returns to backlog)", async () => {
    if (skip) return;
    await resetDeadletter(0);
    // Break resolution: retire the warehouse mapping so the store is unmapped.
    await env!.admin.query(
      `UPDATE erpnext_warehouse_map SET retired_at = now() WHERE store_id = $1`,
      [STORE_A_X],
    );
    const res = await svc().repairPosting({
      tenantId: TENANT_A,
      context: sessionCtx(TENANT_A),
      actorUserId: ACTOR_A,
      workItemRef: POSTING_DEADLETTER_A,
    });
    expect(res.repair.outcome).toBe("still_failing");
    expect((await statusRow()).status).toBe("permanently_rejected");
    // Un-break for later tests.
    await env!.admin.query(`UPDATE erpnext_warehouse_map SET retired_at = NULL WHERE store_id = $1`, [
      STORE_A_X,
    ]);
  });
});

describe("017-US2 §2b — repair when the store IS mapped but a line is unmapped", () => {
  it("reaches the unmapped-lines resolve branch → still_failing", async () => {
    if (skip) return;
    await resetDeadletter(0);
    // Warehouse stays mapped (seed maps STORE_A_X). Break the ITEM side: point
    // SALE_A_X's lines at an UNMAPPED product (no confirmed erpnext_item_map).
    const UNMAPPED_PROD = "01900000-0000-7000-8000-0000000a7e09";
    await env!.admin.query(
      `INSERT INTO tenant_products (id, tenant_id, name, tax_category, created_by, updated_by)
       VALUES ($1, $2, 'Unmapped', 'standard', $3, $3) ON CONFLICT (id) DO NOTHING`,
      [UNMAPPED_PROD, TENANT_A, ACTOR_A],
    );
    await env!.admin.query(`UPDATE sale_lines SET tenant_product_ref = $1 WHERE sale_id = $2`, [
      UNMAPPED_PROD,
      SALE_A_X,
    ]);
    const res = await svc().repairPosting({
      tenantId: TENANT_A,
      context: sessionCtx(TENANT_A),
      actorUserId: ACTOR_A,
      workItemRef: POSTING_DEADLETTER_A,
    });
    expect(res.repair.outcome).toBe("still_failing");
    // Restore SALE_A_X resolvability for any later test.
    await env!.admin.query(`UPDATE sale_lines SET tenant_product_ref = $1 WHERE sale_id = $2`, [
      PRODUCT_A_ACTIVE,
      SALE_A_X,
    ]);
  });
});

describe("017-US2 §3 — repair of an already-posted row (O-3 echo)", () => {
  it("is a no_op_echo returning the stored document_ref (no re-transition)", async () => {
    if (skip) return;
    await env!.admin.query(
      `UPDATE erpnext_posting_status SET status='posted', document_ref='ACC-SINV-017', retry_count=0
        WHERE id=$1`,
      [POSTING_DEADLETTER_A],
    );
    const res = await svc().repairPosting({
      tenantId: TENANT_A,
      context: sessionCtx(TENANT_A),
      actorUserId: ACTOR_A,
      workItemRef: POSTING_DEADLETTER_A,
    });
    expect(res.repair.outcome).toBe("no_op_echo");
    expect(res.replayed).toBe(true);
    expect(res.repair.resolvedDocumentRef).toBe("ACC-SINV-017");
    expect((await statusRow()).status).toBe("posted"); // untouched
  });
});

describe("017-US2 §4 — repair of an in-flight pending row", () => {
  it("is a no_op_echo with NO second re-head", async () => {
    if (skip) return;
    await env!.admin.query(
      `UPDATE erpnext_posting_status SET status='pending', document_ref=NULL, retry_count=0
        WHERE id=$1`,
      [POSTING_DEADLETTER_A],
    );
    const seqBefore = (await statusRow()).sequence;
    const res = await svc().repairPosting({
      tenantId: TENANT_A,
      context: sessionCtx(TENANT_A),
      actorUserId: ACTOR_A,
      workItemRef: POSTING_DEADLETTER_A,
    });
    expect(res.repair.outcome).toBe("no_op_echo");
    expect((await statusRow()).sequence).toBe(seqBefore); // NOT re-headed
  });
});

describe("017-US2 §5 — cross-tenant non-disclosure", () => {
  it("a foreign-tenant context repairing a tenant-A ref → RepairNotFoundError", async () => {
    if (skip) return;
    await resetDeadletter(0);
    await expect(
      svc().repairPosting({
        tenantId: TENANT_B,
        context: sessionCtx(TENANT_B),
        actorUserId: ACTOR_A,
        workItemRef: POSTING_DEADLETTER_A,
      }),
    ).rejects.toBeInstanceOf(RepairNotFoundError);
  });
});

describe("RT-330 — a repair re-offer freezes a new resolution version", () => {
  it("eligible_again leaves the row on an operator-resolved version covering every line", async () => {
    if (skip) return;
    await resetDeadletter(0);
    const before = await env!.admin.query<{ v: number | null }>(
      `SELECT current_resolution_version AS v FROM erpnext_posting_status WHERE id = $1`,
      [POSTING_DEADLETTER_A],
    );

    const res = await svc().repairPosting({
      tenantId: TENANT_A,
      context: sessionCtx(TENANT_A),
      actorUserId: ACTOR_A,
      workItemRef: POSTING_DEADLETTER_A,
    });
    expect(res.repair.outcome).toBe("eligible_again");

    const after = await env!.admin.query<{ v: number | null }>(
      `SELECT current_resolution_version AS v FROM erpnext_posting_status WHERE id = $1`,
      [POSTING_DEADLETTER_A],
    );
    const version = after.rows[0]!.v;
    expect(version).toBe((before.rows[0]!.v ?? 0) + 1);

    const rows = await env!.admin.query<{ by: string }>(
      `SELECT resolved_by AS by FROM erpnext_posting_resolution
        WHERE intent_id = $1 AND resolution_version = $2`,
      [POSTING_DEADLETTER_A, version],
    );
    const lines = await env!.admin.query(`SELECT 1 FROM sale_lines WHERE sale_id = $1`, [SALE_A_X]);
    expect(rows.rowCount).toBe(lines.rowCount);
    expect(rows.rows.every((r) => r.by === "operator")).toBe(true);
  });
});
