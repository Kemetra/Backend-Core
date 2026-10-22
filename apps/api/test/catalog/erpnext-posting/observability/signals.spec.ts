/**
 * signals.spec.ts — 015-POLISH (T090) observability signal verification (api).
 *
 * The connectorAckOutcome ack increments `erpnext_posting_reconciliation_total`
 * exactly when a posting row becomes `permanently_rejected` (a connector
 * permanently_rejected outcome OR a retry-budget-exhausted failed_transient) —
 * the §VII reconciliation / DLQ flag the 017 surface drains. UNLABELED (no
 * tenant/store/sale/category in labels; those live on the row + audit). The
 * counter was registered in the shared api.metrics.ts + ALLOWED_METRIC_LABELS +
 * the cardinality drift list. This spec proves the EMISSION.
 *
 * Observed by mocking the emission helper (the OTel instrument is a no-op without
 * a registered MetricReader — the established api.metrics test idiom; mirrors
 * read-down/observability/signals.spec.ts). Docker-gated (WSL).
 */
import "reflect-metadata";

jest.mock("../../../../src/observability/metrics/api.metrics", () => {
  const actual = jest.requireActual(
    "../../../../src/observability/metrics/api.metrics",
  );
  return { ...actual, recordErpnextPostingReconciliation: jest.fn() };
});

import { recordErpnextPostingReconciliation } from "../../../../src/observability/metrics/api.metrics";
import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../../_helpers/postgres-container";
import {
  ErpnextPostingService,
  POSTING_RETRY_BUDGET,
} from "../../../../src/catalog/erpnext-posting/erpnext-posting.service";
import {
  POSTING_STATUS_FIXTURE_IDS,
  POST_A_PENDING,
  seedPostingStatusFixture,
} from "../__support__/seed-posting-status";

const recordRecon = recordErpnextPostingReconciliation as jest.MockedFunction<
  typeof recordErpnextPostingReconciliation
>;

let env: PgTestEnv | null = null;
let skip = false;
const TENANT_A = POSTING_STATUS_FIXTURE_IDS.tenantA;

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    await seedPostingStatusFixture(env);
  } catch (err) {
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      skip = true;
      // eslint-disable-next-line no-console
      console.warn(`[posting signals.spec] Docker unavailable: ${String(err)}`);
      return;
    }
    throw err;
  }
}, 180_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

beforeEach(() => recordRecon.mockClear());

async function resetPending(): Promise<void> {
  await env!.admin.query(
    `UPDATE erpnext_posting_status
        SET rejection_message = NULL, status='pending', document_ref=NULL, posted_at=NULL, rejection_category=NULL, retry_count=0
      WHERE id=$1`,
    [POST_A_PENDING],
  );
}

function svc(): ErpnextPostingService {
  if (!env) throw new Error("Docker unavailable");
  return new ErpnextPostingService(env.app);
}

describe("posting observability — erpnext_posting_reconciliation_total (T090)", () => {
  it("a permanently_rejected ack increments the counter", async () => {
    if (skip) return;
    await resetPending();
    await svc().ackOutcome({
      tenantId: TENANT_A,
      workItemRef: POST_A_PENDING,
      outcome: "permanently_rejected",
      reason: { category: "unmapped_account", message: "no GL account" },
    });
    expect(recordRecon).toHaveBeenCalledTimes(1);
    for (const call of recordRecon.mock.calls) expect(call).toHaveLength(0); // unlabeled
  });

  it("a retry-budget-exhausted failed_transient (which dead-letters) increments the counter", async () => {
    if (skip) return;
    await resetPending();
    await env!.admin.query(
      `UPDATE erpnext_posting_status SET retry_count = $2 WHERE id = $1`,
      [POST_A_PENDING, POSTING_RETRY_BUDGET],
    );
    await svc().ackOutcome({
      tenantId: TENANT_A,
      workItemRef: POST_A_PENDING,
      outcome: "failed_transient",
    });
    expect(recordRecon).toHaveBeenCalledTimes(1);
  });

  it("a posted ack does NOT increment the counter", async () => {
    if (skip) return;
    await resetPending();
    await svc().ackOutcome({
      tenantId: TENANT_A,
      workItemRef: POST_A_PENDING,
      outcome: "posted",
      documentRef: { doctype: "Sales Invoice", name: "ACC-SINV-S-1" },
    });
    expect(recordRecon).not.toHaveBeenCalled();
  });

  it("an under-budget failed_transient (re-offer, NOT dead-letter) does NOT increment", async () => {
    if (skip) return;
    await resetPending();
    await svc().ackOutcome({
      tenantId: TENANT_A,
      workItemRef: POST_A_PENDING,
      outcome: "failed_transient",
    });
    expect(recordRecon).not.toHaveBeenCalled();
  });
});
