/**
 * signals.spec.ts — 017-POLISH (T090) observability signal verification.
 *
 * Every operator repair (posting re-offer OR stock re-map/re-sync) increments the
 * SHARED `erpnext_reconciliation_repair_total` counter (017's §VII repair signal,
 * registered in api.metrics.ts + ALLOWED_METRIC_LABELS + the cardinality drift
 * list). UNLABELED (the affected target/outcome lives on the repair_attempt row +
 * audit_events). This spec proves the EMISSION by mocking the helper (the OTel
 * instrument is a no-op without a registered reader — the read-down/015 idiom).
 * Docker-gated (WSL).
 */
import "reflect-metadata";

jest.mock("../../../../src/observability/metrics/api.metrics", () => {
  const actual = jest.requireActual("../../../../src/observability/metrics/api.metrics");
  return { ...actual, recordErpnextReconciliationRepair: jest.fn() };
});

import { recordErpnextReconciliationRepair } from "../../../../src/observability/metrics/api.metrics";
import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../../_helpers/postgres-container";
import { ErpnextReconciliationService } from "../../../../src/catalog/erpnext-reconciliation/erpnext-reconciliation.service";
import { SALE_A_X } from "../../sales/__support__/seed-sales";
import { ACTOR_A, PRODUCT_A_ACTIVE } from "../../__support__/isolation-harness";
import {
  RECONCILIATION_FIXTURE_IDS,
  POSTING_DEADLETTER_A,
  seedReconciliationFixture,
} from "../__support__/seed-reconciliation";

const recordRepair = recordErpnextReconciliationRepair as jest.MockedFunction<
  typeof recordErpnextReconciliationRepair
>;

let env: PgTestEnv | null = null;
let skip = false;
const TENANT_A = RECONCILIATION_FIXTURE_IDS.tenantA;

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
    await a.query(
      `INSERT INTO erpnext_item_map
         (id, tenant_id, tenant_product_id, erpnext_item_ref, state, suggestion_source, confirmed_by, confirmed_at)
       VALUES (gen_random_uuid(), $1, $2, 'ERP-ITEM-017S', 'confirmed', 'manual', $3, now()) ON CONFLICT DO NOTHING`,
      [TENANT_A, PRODUCT_A_ACTIVE, ACTOR_A],
    );
  } catch (err) {
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      skip = true;
      // eslint-disable-next-line no-console
      console.warn(`[reconciliation signals.spec] Docker unavailable: ${String(err)}`);
      return;
    }
    throw err;
  }
}, 180_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

beforeEach(() => recordRepair.mockClear());

function svc(): ErpnextReconciliationService {
  if (!env) throw new Error("Docker unavailable");
  return new ErpnextReconciliationService(env.app);
}

async function resetDeadletter(): Promise<void> {
  await env!.admin.query(
    `UPDATE erpnext_posting_status
        SET status='permanently_rejected', document_ref=NULL, rejection_category='unmapped_item', retry_count=0
      WHERE id=$1`,
    [POSTING_DEADLETTER_A],
  );
}

describe("reconciliation observability — erpnext_reconciliation_repair_total (T090)", () => {
  it("a posting repair increments the counter (unlabeled)", async () => {
    if (skip) return;
    await resetDeadletter();
    await svc().repairPosting({
      tenantId: TENANT_A,
      actorUserId: ACTOR_A,
      workItemRef: POSTING_DEADLETTER_A,
    });
    expect(recordRepair).toHaveBeenCalledTimes(1);
    for (const call of recordRepair.mock.calls) expect(call).toHaveLength(0); // unlabeled
  });

  it("a list (read-only, no repair) does NOT increment the counter", async () => {
    if (skip) return;
    await svc().listPostingBacklog({ tenantId: TENANT_A, cursor: null, limit: 100 });
    expect(recordRepair).not.toHaveBeenCalled();
  });

  it("a list with a non-null cursor + filters is a no-op read (exercises the cursor branch)", async () => {
    if (skip) return;
    // Pass a non-null cursor + store + class filter — covers the cursor.toString()
    // + filter branches of listPostingBacklog. A high cursor returns an empty tail.
    const page = await svc().listPostingBacklog({
      tenantId: TENANT_A,
      cursor: 1n,
      limit: 50,
      storeId: undefined,
      rejectionCategory: "unmapped_item",
    } as unknown as Parameters<ErpnextReconciliationService["listPostingBacklog"]>[0]);
    expect(Array.isArray(page.items)).toBe(true);
    expect(recordRepair).not.toHaveBeenCalled();
  });
});
