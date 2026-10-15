/**
 * void-approval.ts — RT-530: a finalized sale is voided only with a bound
 * manager approval.
 *
 * Owner decision (Jira RT-530 comment 11988, 2026-10-15): the approval is the
 * RT-114 Manager Approval PIN. The PIN is checked on the terminal, so what
 * reaches Backend-Core is EVIDENCE of that approval, and what Backend-Core
 * can check is every CLAIM the evidence makes:
 *
 *   1. an approval is present                      (403 void_approval_required)
 *   2. it is bound to action `sale.void`, to THIS sale and to the sale's exact
 *      total, and its time is not in the future   (422 void_approval_invalid)
 *   3. the void's business day is the sale's own  (422 void_outside_business_day)
 *   4. four-eyes: the approver is neither the requester nor the sale's selling
 *      operator                                    (403 void_self_approval)
 *   5. the approver holds `owner` / `tenant_admin` / `store_manager` in the
 *      tenant, with an active membership and access to the sale's store
 *                                                  (403 void_approver_not_eligible)
 *
 * It cannot prove that a PIN was typed: that proof never leaves the terminal
 * (the same posture as the RT-17 shift-variance approver, which is likewise a
 * stated `users.id`). That residual risk is recorded in the contract.
 *
 * Offline timing. A void may be captured offline and sent later, so the
 * approval's age is NOT compared with the server clock (no TTL here: RT-114's
 * 120 s is the terminal's window to consume it), only its future-dating is
 * bounded. And the void's business day is the DEVICE-claimed day, compared
 * with `sales.business_date`; `sale_voids.business_date` keeps meaning "the
 * store day the server recorded it" (the posting feed reads it).
 */
import type { PoolClient } from "pg";

import { standingFinding } from "../../pos-shifts/shift-close-approver";
import { ShiftStoreUserReader } from "../../pos-shifts/shift-store-user";
import type { RecordVoidRequestDto, VoidApprovalDto } from "./dto/record-void-request.dto";

/** The only action a void approval may be bound to. */
export const VOID_APPROVAL_ACTION = "sale.void";

/** How far into the future an approval's time may be (clock skew), ms. */
export const VOID_APPROVAL_SKEW_MS = 120_000;

/** No approval accompanied the void → 403 `void_approval_required`. */
export class VoidApprovalRequiredError extends Error {
  constructor() {
    super("a void needs a manager approval");
    this.name = "VoidApprovalRequiredError";
  }
}

/** The approval is not bound to this action / sale / amount, or is future-dated → 422. */
export class VoidApprovalInvalidError extends Error {
  constructor() {
    super("the approval does not match this void");
    this.name = "VoidApprovalInvalidError";
  }
}

/** The void's business day is missing or is not the sale's → 422. */
export class VoidOutsideBusinessDayError extends Error {
  constructor() {
    super("a sale can be voided only on its own business day; use a return");
    this.name = "VoidOutsideBusinessDayError";
  }
}

/** The approver is the requester or the sale's selling operator → 403. */
export class VoidSelfApprovalError extends Error {
  constructor() {
    super("the approver must differ from the requester and the selling operator");
    this.name = "VoidSelfApprovalError";
  }
}

/** The approver is not a store_manager-or-above of this tenant with access to the store → 403. */
export class VoidApproverNotEligibleError extends Error {
  constructor() {
    super("the approver is not eligible to approve a void");
    this.name = "VoidApproverNotEligibleError";
  }
}

/** What the checks need to know about the (locked) sale. */
export interface VoidSaleFacts {
  readonly saleRef: string;
  /** `sales.pos_total` equals the approval's `amount`, compared as exact decimals. */
  readonly amountMatches: boolean;
  /** `sales.business_date` as `YYYY-MM-DD`. */
  readonly businessDate: string;
  /** `sales.created_by`: the selling operator. */
  readonly sellingOperatorUserId: string;
}

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/**
 * The claim checks (1–4 above), pure. Returns the validated approval so the
 * caller does not re-narrow it; throws the matching error otherwise.
 */
export function checkVoidApprovalClaims(input: {
  readonly body: RecordVoidRequestDto;
  readonly sale: VoidSaleFacts;
  readonly now: Date;
}): VoidApprovalDto {
  const { body, sale, now } = input;
  const approval = body.approval;
  if (approval === undefined) throw new VoidApprovalRequiredError();

  const approvedAt = Date.parse(approval.approvedAt);
  const bound =
    approval.action === VOID_APPROVAL_ACTION &&
    same(approval.saleRef, sale.saleRef) &&
    sale.amountMatches &&
    approvedAt <= now.getTime() + VOID_APPROVAL_SKEW_MS;
  if (!bound) throw new VoidApprovalInvalidError();

  if (body.businessDate !== sale.businessDate) throw new VoidOutsideBusinessDayError();

  if (
    same(approval.approverUserId, approval.requesterUserId) ||
    same(approval.approverUserId, sale.sellingOperatorUserId)
  ) {
    throw new VoidSelfApprovalError();
  }
  return approval;
}

/**
 * The sale facts a void is checked against, read under the sale lock (the
 * caller's tenant-scoped client). `amount` is compared by Postgres `numeric`
 * equality, so "12.5" equals a stored 12.5000 and no float is involved.
 */
export async function readVoidSaleFacts(
  client: PoolClient,
  saleRef: string,
  amount: string | undefined,
): Promise<VoidSaleFacts> {
  const r = await client.query<{ amount_matches: boolean; business_date: string; created_by: string }>(
    `SELECT ($2::text IS NOT NULL AND s.pos_total = $2::numeric) AS amount_matches,
            s.business_date::text AS business_date,
            s.created_by::text AS created_by
       FROM sales s WHERE s.id = $1`,
    [saleRef, amount ?? null],
  );
  const row = r.rows[0];
  if (row === undefined) throw new Error("locked sale not readable");
  return {
    saleRef,
    amountMatches: row.amount_matches === true,
    businessDate: row.business_date,
    sellingOperatorUserId: row.created_by,
  };
}

const approvers = new ShiftStoreUserReader();

/**
 * Check 5: the approver's CURRENT standing in the tenant and the sale's
 * store, on the caller's tenant-scoped client (RLS). Reuses the shift-close
 * approver lookup and its role set (`owner`, `tenant_admin`,
 * `store_manager`); here a failed finding refuses the void.
 */
export async function assertApproverEligible(
  client: PoolClient,
  scope: { readonly tenantId: string; readonly storeId: string },
  approverUserId: string,
): Promise<void> {
  const standing = await approvers.approverStanding(client, { scope, userId: approverUserId });
  if (standingFinding(standing) !== null) throw new VoidApproverNotEligibleError();
}
