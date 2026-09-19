/**
 * 035 T034 — settlement_receivable_total signal emission.
 *
 * Every successful settlement lifecycle event (a receivable opened from a POS
 * intent, a cash application, a claim submission, a remittance reconciliation)
 * increments the SHARED unlabeled `settlement_receivable_total` counter (035 §7;
 * registered in api.metrics.ts + ALLOWED_METRIC_LABELS + the cardinality drift
 * list). Proves EMISSION by mocking the helper (the OTel instrument is a no-op
 * without a registered reader — the 015/017/018/020/021 idiom). Emission is
 * POST-COMMIT and MUST NOT alter the settlement outcome; a rejected op (conflict)
 * does NOT increment. Docker-gated (WSL Testcontainers).
 */
import "reflect-metadata";

jest.mock("../../../src/observability/metrics/api.metrics", () => {
  const actual = jest.requireActual("../../../src/observability/metrics/api.metrics");
  return { ...actual, recordSettlementReceivable: jest.fn() };
});

import type { Pool } from "pg";

import { recordSettlementReceivable } from "../../../src/observability/metrics/api.metrics";
import { ReceivableService } from "../../../src/settlement/receivable.service";
import { ClaimService } from "../../../src/settlement/claim.service";
import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../_helpers/postgres-container";
import {
  SETTLEMENT_FIXTURE_IDS,
  SALE_A,
  PAYER_A_STORE,
  PAYER_ABSENT,
  seedSettlementFixture,
} from "../__support__/seed-settlement";

const record = recordSettlementReceivable as jest.MockedFunction<
  typeof recordSettlementReceivable
>;
const TENANT_A = SETTLEMENT_FIXTURE_IDS.tenantA;
const STORE_A_X = SETTLEMENT_FIXTURE_IDS.storeAX;

let env: PgTestEnv | null = null;
let receivables: ReceivableService;
let claims: ClaimService;
let dockerSkipped = false;

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    await seedSettlementFixture(env);
    receivables = new ReceivableService(env.app as unknown as Pool);
    claims = new ClaimService(env.app as unknown as Pool);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      dockerSkipped = true;
      // eslint-disable-next-line no-console
      console.warn(`\n[settlement signals.spec] Docker NOT AVAILABLE: ${msg}\n`);
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }
}, 180_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

beforeEach(async () => {
  if (dockerSkipped || !env) return;
  record.mockClear();
  await env.admin.query(
    `DELETE FROM payment_application WHERE receivable_id IN
       (SELECT id FROM receivable WHERE sale_id = $1)`,
    [SALE_A],
  );
  await env.admin.query(`DELETE FROM reconciliation_result WHERE claim_id IN (SELECT id FROM claim WHERE store_id = $1)`, [STORE_A_X]);
  await env.admin.query(`DELETE FROM remittance WHERE claim_id IN (SELECT id FROM claim WHERE store_id = $1)`, [STORE_A_X]);
  await env.admin.query(`DELETE FROM claim_receivables WHERE store_id = $1`, [STORE_A_X]);
  await env.admin.query(`DELETE FROM claim WHERE store_id = $1`, [STORE_A_X]);
  await env.admin.query(`DELETE FROM receivable WHERE sale_id = $1`, [SALE_A]);
});

function maybeSkip(): boolean {
  if (dockerSkipped) {
    // eslint-disable-next-line no-console
    console.warn("[settlement signals.spec] skipping — Docker unavailable");
    return true;
  }
  return false;
}

async function openOne(owed: string): Promise<string> {
  const r = await receivables.openFromIntent({
    tenantId: TENANT_A,
    storeId: STORE_A_X,
    operation: {
      idempotencyKey: `signals-open-${owed}-${Date.now()}`,
      actorUserId: SETTLEMENT_FIXTURE_IDS.actorA,
      requestId: "b2000000-0000-4000-8000-000000000001",
    },
    saleRef: SALE_A,
    payers: [{ payerRef: PAYER_A_STORE, owedAmount: owed }],
  });
  if (r.kind !== "ok") throw new Error(`openFromIntent: ${r.kind}`);
  return r.rows[0]!.id;
}

describe("035 T034 — settlement_receivable_total signal", () => {
  it("a successful settlement intent increments the counter once", async () => {
    if (maybeSkip()) return;
    await openOne("120.00");
    expect(record).toHaveBeenCalledTimes(1);
  });

  it("a REJECTED intent (unknown payer) does NOT increment", async () => {
    if (maybeSkip()) return;
    const r = await receivables.openFromIntent({
      tenantId: TENANT_A,
      storeId: STORE_A_X,
      operation: {
        idempotencyKey: "signals-rejected-intent",
        actorUserId: SETTLEMENT_FIXTURE_IDS.actorA,
        requestId: "b2000000-0000-4000-8000-000000000002",
      },
      saleRef: SALE_A,
      payers: [{ payerRef: PAYER_ABSENT, owedAmount: "10.00" }],
    });
    expect(r.kind).toBe("conflict");
    expect(record).toHaveBeenCalledTimes(0);
  });

  it("a successful cash application increments the counter once", async () => {
    if (maybeSkip() || !env) return;
    const ref = await openOne("120.00");
    record.mockClear();
    const r = await receivables.applyPayment({
      tenantId: TENANT_A,
      actorUserId: SETTLEMENT_FIXTURE_IDS.actorA,
      requestId: "b2000000-0000-4000-8000-000000000003",
      receivableRef: ref,
      amount: "50.00",
      version: 0,
    });
    expect(r.kind).toBe("ok");
    expect(record).toHaveBeenCalledTimes(1);
  });

  it("a successful claim submission increments the counter once", async () => {
    if (maybeSkip()) return;
    const ref = await openOne("120.00");
    record.mockClear();
    const r = await claims.submitClaim({
      tenantId: TENANT_A,
      actorUserId: SETTLEMENT_FIXTURE_IDS.actorA,
      requestId: "b2000000-0000-4000-8000-000000000004",
      payerRef: PAYER_A_STORE,
      receivableRefs: [ref],
    });
    expect(r.kind).toBe("ok");
    expect(record).toHaveBeenCalledTimes(1);
  });

  it("a successful remittance reconciliation increments the counter once", async () => {
    if (maybeSkip()) return;
    const ref = await openOne("120.00");
    const claim = await claims.submitClaim({
      tenantId: TENANT_A,
      actorUserId: SETTLEMENT_FIXTURE_IDS.actorA,
      requestId: "b2000000-0000-4000-8000-000000000005",
      payerRef: PAYER_A_STORE,
      receivableRefs: [ref],
    });
    if (claim.kind !== "ok") throw new Error("submitClaim failed");
    record.mockClear();
    const r = await claims.reconcileRemittance({
      tenantId: TENANT_A,
      actorUserId: SETTLEMENT_FIXTURE_IDS.actorA,
      requestId: "b2000000-0000-4000-8000-000000000006",
      claimRef: claim.claim.claimRef,
      remittedAmount: "120.00",
    });
    expect(r.kind).toBe("ok");
    expect(record).toHaveBeenCalledTimes(1);
  });
});
