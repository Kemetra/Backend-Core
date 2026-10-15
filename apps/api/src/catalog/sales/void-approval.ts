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
 *   4. the requester IS the authenticated envelope actor (`users.id` the guard
 *      resolved; a body id is never trusted)       (403 void_requester_mismatch)
 *   5. four-eyes: the approver is neither the requester nor the sale's selling
 *      operator                                    (403 void_self_approval)
 *   6. the requester is a real user of the tenant with access to the sale's
 *      store                                       (403 void_requester_not_eligible)
 *   7. the approver holds `owner` / `tenant_admin` / `store_manager` in the
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

/** The stated requester is not the authenticated envelope actor → 403. */
export class VoidRequesterMismatchError extends Error {
  constructor() {
    super("the requester must be the authenticated operator");
    this.name = "VoidRequesterMismatchError";
  }
}

/** The requester is not a user of this tenant with access to the sale's store → 403. */
export class VoidRequesterNotEligibleError extends Error {
  constructor() {
    super("the requester is not a user of this store");
    this.name = "VoidRequesterNotEligibleError";
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

/** What every claim check reads: the approval (present), the actor, the void's day and the sale. */
interface ClaimContext {
  readonly approval: VoidApprovalDto;
  /** The authenticated envelope actor's `users.id` (never from the body). */
  readonly actorUserId: string;
  readonly businessDate: string | undefined;
  readonly sale: VoidSaleFacts;
  readonly now: Date;
}

/** A claim check: the refusal it raises, or null when the claim holds. */
type ClaimCheck = (ctx: ClaimContext) => Error | null;

const refuseUnless = (holds: boolean, refusal: () => Error): Error | null => (holds ? null : refusal());

/** The approval is bound to `sale.void`, to this sale and its exact total. */
const boundToThisVoid: ClaimCheck = ({ approval, sale }) =>
  refuseUnless(
    approval.action === VOID_APPROVAL_ACTION && same(approval.saleRef, sale.saleRef) && sale.amountMatches,
    () => new VoidApprovalInvalidError(),
  );

/** The approval is not dated beyond the clock-skew allowance (an old one is fine: offline). */
const notFutureDated: ClaimCheck = ({ approval, now }) =>
  refuseUnless(
    Date.parse(approval.approvedAt) <= now.getTime() + VOID_APPROVAL_SKEW_MS,
    () => new VoidApprovalInvalidError(),
  );

/** The void's claimed business day is the sale's own. */
const onTheSalesDay: ClaimCheck = ({ businessDate, sale }) =>
  refuseUnless(businessDate === sale.businessDate, () => new VoidOutsideBusinessDayError());

/** The requester is the authenticated actor: the void is attributed to who really asked. */
const requesterIsActor: ClaimCheck = ({ approval, actorUserId }) =>
  refuseUnless(same(approval.requesterUserId, actorUserId), () => new VoidRequesterMismatchError());

/** Four-eyes: the approver is not the requester. */
const approverIsNotRequester: ClaimCheck = ({ approval }) =>
  refuseUnless(!same(approval.approverUserId, approval.requesterUserId), () => new VoidSelfApprovalError());

/** Four-eyes: the approver is not the sale's selling operator. */
const approverIsNotSeller: ClaimCheck = ({ approval, sale }) =>
  refuseUnless(!same(approval.approverUserId, sale.sellingOperatorUserId), () => new VoidSelfApprovalError());

/** The claim checks, in the contract's order. */
const CLAIM_CHECKS: ReadonlyArray<ClaimCheck> = [
  boundToThisVoid,
  notFutureDated,
  onTheSalesDay,
  requesterIsActor,
  approverIsNotRequester,
  approverIsNotSeller,
];

/**
 * The claim checks (1-4 above), pure. Returns the validated approval so the
 * caller does not re-narrow it; throws the first refusal otherwise.
 */
export function checkVoidApprovalClaims(input: {
  readonly body: RecordVoidRequestDto;
  readonly actorUserId: string;
  readonly sale: VoidSaleFacts;
  readonly now: Date;
}): VoidApprovalDto {
  const { body, actorUserId, sale, now } = input;
  const approval = body.approval;
  if (approval === undefined) throw new VoidApprovalRequiredError();
  const ctx: ClaimContext = { approval, actorUserId, businessDate: body.businessDate, sale, now };
  for (const check of CLAIM_CHECKS) {
    const refusal = check(ctx);
    if (refusal !== null) throw refusal;
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
 * Check 6: the requester (already bound to the envelope actor) is a real user
 * of the tenant with access to the sale's store (an active membership, not
 * deleted), looked up live like the approver.
 */
export async function assertRequesterIsStoreUser(
  client: PoolClient,
  scope: { readonly tenantId: string; readonly storeId: string },
  requesterUserId: string,
): Promise<void> {
  if (!(await approvers.isStoreUser(client, { scope, userId: requesterUserId }))) {
    throw new VoidRequesterNotEligibleError();
  }
}

/**
 * Check 7: the approver's CURRENT standing in the tenant and the sale's
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
