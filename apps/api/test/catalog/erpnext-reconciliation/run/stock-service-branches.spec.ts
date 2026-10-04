/**
 * 017-US3 — service-direct branch coverage for triggerRun / getRun / listResults
 * / repairStock (the error + idempotent-echo arms the api HTTP spec drives but
 * attributes to the controller). Drives ErpnextReconciliationService directly.
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
  RunNotFoundError,
  StoreNotFoundError,
} from "../../../../src/catalog/erpnext-reconciliation/erpnext-reconciliation.service";
import { MembershipRepository } from "../../../../src/context/membership.repository";
import type { ResolvedContext } from "../../../../src/context/types";
import { ACTOR_A, PRODUCT_A_ACTIVE, STORE_A_X } from "../../__support__/isolation-harness";
import {
  RECONCILIATION_FIXTURE_IDS,
  RUN_A,
  RESULT_A,
  RUN_B,
  seedReconciliationFixture,
} from "../__support__/seed-reconciliation";

let env: PgTestEnv | null = null;
let skip = false;
const TENANT_A = RECONCILIATION_FIXTURE_IDS.tenantA;
const NON_EXISTENT = "0f000000-0000-7000-8000-00000000dead";

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    await seedReconciliationFixture(env);
  } catch (err) {
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      skip = true;
      // eslint-disable-next-line no-console
      console.warn(`[stock-service-branches.spec] Docker unavailable: ${String(err)}`);
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

describe("017-US3 service — triggerRun", () => {
  it("creates a running run for a real store", async () => {
    if (skip) return;
    const run = await svc().triggerRun({ tenantId: TENANT_A, context: sessionCtx(TENANT_A), actorUserId: ACTOR_A, storeId: STORE_A_X });
    expect(run.status).toBe("running");
    expect(run.kind).toBe("stock");
    expect(run.finishedAt).toBeNull();
  });

  it("an unknown store → StoreNotFoundError", async () => {
    if (skip) return;
    await expect(
      svc().triggerRun({ tenantId: TENANT_A, context: sessionCtx(TENANT_A), actorUserId: ACTOR_A, storeId: NON_EXISTENT }),
    ).rejects.toBeInstanceOf(StoreNotFoundError);
  });
});

describe("017-US3 service — getRun / listResults", () => {
  it("getRun returns the seeded run", async () => {
    if (skip) return;
    const run = await svc().getRun({ tenantId: TENANT_A, context: sessionCtx(TENANT_A), runId: RUN_A });
    expect(run.id).toBe(RUN_A);
    expect(run.status).toBe("completed");
    expect(run.finishedAt).not.toBeNull();
  });

  it("getRun for a foreign-tenant run → RunNotFoundError", async () => {
    if (skip) return;
    await expect(svc().getRun({ tenantId: TENANT_A, context: sessionCtx(TENANT_A), runId: RUN_B })).rejects.toBeInstanceOf(
      RunNotFoundError,
    );
  });

  it("listResults returns the run's classified results; class filter narrows", async () => {
    if (skip) return;
    const all = await svc().listResults({ tenantId: TENANT_A, context: sessionCtx(TENANT_A), runId: RUN_A, cursor: null, limit: 100 });
    expect(all.items.some((i) => i.id === RESULT_A)).toBe(true);
    const filtered = await svc().listResults({
      tenantId: TENANT_A,
      context: sessionCtx(TENANT_A),
      runId: RUN_A,
      cursor: null,
      limit: 100,
      mismatchClass: "quantity_divergence",
    });
    for (const i of filtered.items) expect(i.mismatchClass).toBe("quantity_divergence");
  });

  it("listResults for a foreign run → RunNotFoundError", async () => {
    if (skip) return;
    await expect(
      svc().listResults({ tenantId: TENANT_A, context: sessionCtx(TENANT_A), runId: RUN_B, cursor: null, limit: 100 }),
    ).rejects.toBeInstanceOf(RunNotFoundError);
  });
});

describe("017-US3 service — repairStock", () => {
  it("an OPEN result → repaired (eligible_again); a 2nd repair → no_op_echo (replayed)", async () => {
    if (skip) return;
    // RESULT_A is seeded 'open'. First repair transitions it.
    await env!.admin.query(`UPDATE erpnext_reconciliation_result SET result_state='open' WHERE id=$1`, [
      RESULT_A,
    ]);
    const first = await svc().repairStock({
      tenantId: TENANT_A,
      context: sessionCtx(TENANT_A),
      actorUserId: ACTOR_A,
      runId: RUN_A,
      resultId: RESULT_A,
      repairKind: "re_sync",
    });
    expect(first.repair.outcome).toBe("eligible_again");
    expect(first.replayed).toBe(false);

    const state = await env!.admin.query<{ result_state: string }>(
      `SELECT result_state FROM erpnext_reconciliation_result WHERE id=$1`,
      [RESULT_A],
    );
    expect(state.rows[0]?.result_state).toBe("repaired");

    const second = await svc().repairStock({
      tenantId: TENANT_A,
      context: sessionCtx(TENANT_A),
      actorUserId: ACTOR_A,
      runId: RUN_A,
      resultId: RESULT_A,
      repairKind: "re_sync",
    });
    expect(second.repair.outcome).toBe("no_op_echo");
    expect(second.replayed).toBe(true);
  });

  it("a foreign run/result → RunNotFoundError", async () => {
    if (skip) return;
    await expect(
      svc().repairStock({
        tenantId: TENANT_A,
        context: sessionCtx(TENANT_A),
        actorUserId: ACTOR_A,
        runId: RUN_A,
        resultId: NON_EXISTENT,
        repairKind: "re_map",
      }),
    ).rejects.toBeInstanceOf(RunNotFoundError);
  });
});
