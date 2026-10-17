/**
 * RT-577 — the credit-reversal standing lookups fail closed (unit, no DB).
 * A lookup that throws (a dropped connection, a missing grant) is the
 * contract refusal, never a 5xx: 403 `credit_reversal_role_refused` for the
 * actor, 403 `credit_return_approval_refused` for a D6 second approver.
 */
import type { PoolClient } from "pg";

import {
  assertCreditReturnApproval,
  assertCreditReversalActor,
  CreditReturnApprovalRefusedError,
  CreditReversalRoleRefusedError,
} from "../../../../src/catalog/sales/credit-sale-reversal.checks";

const SCOPE = { tenantId: "0a000000-0000-7000-8000-000000057901", storeId: "0a000000-0000-7000-8000-000000057902" };
const SALE = "0a000000-0000-7000-8000-000000057903";
const ACTOR = "0a000000-0000-7000-8000-000000057904";
const APPROVER = "0a000000-0000-7000-8000-000000057905";
const SELLER = "0a000000-0000-7000-8000-000000057906";

/** A client whose standing lookup (the membership read) throws; every other query answers `ok`. */
function clientFailingStanding(): PoolClient {
  const query = jest.fn(async (sql: string) => {
    if (/memberships/.test(sql)) throw new Error("connection terminated");
    return { rows: [{ ok: true }] };
  });
  return { query } as unknown as PoolClient;
}

describe("RT-577 credit-reversal checks — a failed standing lookup is the refusal", () => {
  it("the actor lookup failing is credit_reversal_role_refused", async () => {
    await expect(assertCreditReversalActor(clientFailingStanding(), SCOPE, ACTOR)).rejects.toBeInstanceOf(
      CreditReversalRoleRefusedError,
    );
  });

  it("the D6 approver lookup failing is credit_return_approval_refused", async () => {
    const approval = {
      approvalId: "0a000000-0000-7000-8000-000000057907",
      action: "sale.credit_return",
      saleRef: SALE,
      amount: "1",
      requesterUserId: ACTOR,
      approverUserId: APPROVER,
      policyVersion: "v1",
      approvedAt: new Date().toISOString(),
    };
    await expect(
      assertCreditReturnApproval(clientFailingStanding(), {
        scope: SCOPE,
        saleRef: SALE,
        actorUserId: ACTOR,
        sellerUserId: SELLER,
        refundable: "1",
        approval,
        now: new Date(),
      }),
    ).rejects.toBeInstanceOf(CreditReturnApprovalRefusedError);
  });
});
