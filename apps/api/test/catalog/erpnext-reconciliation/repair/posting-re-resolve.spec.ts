/**
 * RT-333 — operator re-resolution of a pending posting intent (RT-326 decision 3).
 *
 * ERP Integration baseline: "If an incorrect mapping is discovered before any ERP
 * side effect, an explicit audited re-resolution may create a new resolution
 * version and controlled retry." The route writes resolution v(n+1)
 * (`resolved_by = 'operator'`) from the CURRENT maps, points the row at it and
 * re-heads its sequence, with an audit row in the same transaction. Only a
 * `pending` intent can be re-resolved: a posted row has an ERP side effect, a
 * dead-letter goes through repair. A connector post that raced the re-resolution
 * echoes the old version and is recorded for reconciliation (RT-332).
 *
 * Docker policy mirrors posting-repair.spec: HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../../_helpers/postgres-container";
import { MembershipRepository } from "../../../../src/context/membership.repository";
import type { ResolvedContext } from "../../../../src/context/types";
import { RepairNotFoundError } from "../../../../src/catalog/erpnext-reconciliation/erpnext-reconciliation.service";
import {
  ErpnextPostingReResolutionService,
  ReResolveConflictError,
} from "../../../../src/catalog/erpnext-reconciliation/posting-re-resolution.service";
import {
  SALES_SOURCE_SYSTEM,
  SALE_A_X,
  SALE_VOIDED_A_X,
} from "../../sales/__support__/seed-sales";
import { ACTOR_A, PRODUCT_A_ACTIVE, STORE_A_X } from "../../__support__/isolation-harness";
import {
  POST_A_PENDING,
  POST_A_REVERSAL,
} from "../../erpnext-posting/__support__/seed-posting-status";
import {
  RECONCILIATION_FIXTURE_IDS,
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
    const a = env.admin;
    await a.query(`UPDATE sale_lines SET tenant_product_ref = $1 WHERE sale_id = $2`, [
      PRODUCT_A_ACTIVE,
      SALE_A_X,
    ]);
    // The intent was frozen at version 1 with ERP-ITEM-OLD ...
    await a.query(
      `INSERT INTO erpnext_posting_resolution
         (tenant_id, intent_id, resolution_version, sale_line_id, erpnext_item_ref,
          item_map_id, warehouse_ref, warehouse_map_id, resolved_by)
       SELECT $1, $2, 1, sl.id, 'ERP-ITEM-OLD', gen_random_uuid(), 'WH-OLD', gen_random_uuid(), 'system'
         FROM sale_lines sl WHERE sl.sale_id = $3`,
      [TENANT_A, POST_A_PENDING, SALE_A_X],
    );
    // ... and the operator has since mapped the product to ERP-ITEM-NEW.
    await a.query(
      `INSERT INTO erpnext_item_map
         (id, tenant_id, tenant_product_id, erpnext_item_ref, state, suggestion_source, confirmed_by, confirmed_at)
       VALUES (gen_random_uuid(), $1, $2, 'ERP-ITEM-NEW', 'confirmed', 'manual', $3, now())`,
      [TENANT_A, PRODUCT_A_ACTIVE, ACTOR_A],
    );
  } catch (err) {
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      skip = true;
      // eslint-disable-next-line no-console
      console.warn(`[posting-re-resolve.spec] Docker unavailable: ${String(err)}`);
      return;
    }
    throw err;
  }
}, 180_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

function svc(): ErpnextPostingReResolutionService {
  if (!env) throw new Error("Docker unavailable");
  return new ErpnextPostingReResolutionService(env.app, new MembershipRepository(env.app));
}

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

function reResolve(tenantId = TENANT_A, workItemRef = POST_A_PENDING) {
  return svc().reResolvePosting({
    tenantId,
    context: sessionCtx(tenantId),
    actorUserId: ACTOR_A,
    workItemRef,
  });
}

async function setRow(status: string, version: number): Promise<void> {
  await env!.admin.query(
    `UPDATE erpnext_posting_status
        SET status = $2, current_resolution_version = $3, rejection_category = NULL,
            reconciliation_document_ref = NULL,
            document_ref = CASE WHEN $2 = 'posted'
              THEN '{"doctype":"Sales Invoice","name":"ACC-SINV-RR-1"}' ELSE NULL END
      WHERE id = $1`,
    [POST_A_PENDING, status, version],
  );
}

async function row(): Promise<{ v: number | null; seq: string }> {
  const r = await env!.admin.query<{ v: number | null; seq: string }>(
    `SELECT current_resolution_version AS v, sequence::text AS seq
       FROM erpnext_posting_status WHERE id = $1`,
    [POST_A_PENDING],
  );
  return r.rows[0]!;
}

describe("RT-333 — re-resolving a pending intent", () => {
  it("writes an operator version from the current maps, re-heads the row and audits it", async () => {
    if (skip) return;
    await setRow("pending", 1);
    const before = await row();

    const rec = await reResolve();
    expect(rec).toMatchObject({ workItemRef: POST_A_PENDING, resolutionVersion: 2, previousResolutionVersion: 1 });

    const after = await row();
    expect(after.v).toBe(2);
    expect(BigInt(after.seq)).toBeGreaterThan(BigInt(before.seq));
    const frozen = await env!.admin.query<{ item: string; by: string }>(
      `SELECT DISTINCT erpnext_item_ref AS item, resolved_by AS by
         FROM erpnext_posting_resolution WHERE intent_id = $1 AND resolution_version = 2`,
      [POST_A_PENDING],
    );
    expect(frozen.rows).toEqual([{ item: "ERP-ITEM-NEW", by: "operator" }]);
    const audit = await env!.admin.query(
      `SELECT 1 FROM audit_events
        WHERE action = 'erpnext_reconciliation.posting.re_resolved' AND target_id = $1`,
      [POST_A_PENDING],
    );
    expect(audit.rowCount).toBe(1);
  });
});

describe("RT-333 — only a pending intent can be re-resolved", () => {
  it.each([["posted"], ["permanently_rejected"]])("a %s row is a conflict and stays unchanged", async (status) => {
    if (skip) return;
    await setRow(status, 1);
    await expect(reResolve()).rejects.toBeInstanceOf(ReResolveConflictError);
    expect((await row()).v).toBe(1);
  });

  it("a pending row the current maps no longer resolve is a conflict and stays unchanged", async () => {
    if (skip) return;
    await setRow("pending", 1);
    await env!.admin.query(
      `UPDATE erpnext_item_map SET retired_at = now()
        WHERE tenant_id = $1 AND tenant_product_id = $2 AND retired_at IS NULL`,
      [TENANT_A, PRODUCT_A_ACTIVE],
    );
    await expect(reResolve()).rejects.toBeInstanceOf(ReResolveConflictError);
    expect((await row()).v).toBe(1);
  });

  it("another tenant's ref is not found (non-disclosing)", async () => {
    if (skip) return;
    await expect(reResolve(TENANT_B)).rejects.toBeInstanceOf(RepairNotFoundError);
  });
});

// A reversal must credit exactly what its sale posted: its frozen refs are the
// sale's lineage, never re-read from the current maps. So a reversal is not
// re-resolvable, and neither is a sale that already has a reversal intent (the
// reversal's copy is pinned to the sale's current version).
const SALE_POST_VOIDED = "0a000000-0000-7000-8000-00000e0533a1";

describe("RT-333 — a reversal's lineage is never re-resolved", () => {
  it("a pending reversal is a conflict", async () => {
    if (skip) return;
    const err = await reResolve(TENANT_A, POST_A_REVERSAL).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReResolveConflictError);
    expect((err as Error).message).toMatch(/reversal/);
  });

  it("a pending sale_post whose sale already has a reversal intent is a conflict", async () => {
    if (skip) return;
    await env!.admin.query(
      `INSERT INTO erpnext_posting_status
         (id, tenant_id, store_id, sale_id, kind, source_ref_id,
          source_system, external_id, payload_hash, status)
       VALUES ($1, $2, $3, $4, 'sale_post', $4, $5, 'sale-A-voided', $6, 'pending')
       ON CONFLICT DO NOTHING`,
      [SALE_POST_VOIDED, TENANT_A, STORE_A_X, SALE_VOIDED_A_X, SALES_SOURCE_SYSTEM, "a".repeat(64)],
    );
    const err = await reResolve(TENANT_A, SALE_POST_VOIDED).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReResolveConflictError);
    expect((err as Error).message).toMatch(/reversal/);
  });
});
