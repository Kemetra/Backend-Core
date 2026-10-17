/**
 * credit-sale-reversal.checks.ts — the refusals of `recordCreditSaleReversal`
 * (Jira RT-577; `pos-sales/sales.yaml` 1.11.0-draft; owner-approved V1 decision
 * and rulings D6 / D7 / D8, 2026-10-17).
 *
 * Every check runs on the reversal transaction's tenant-scoped client (RLS),
 * under the sale row lock, after a provenance replay has resolved. A throw
 * rolls the transaction back, so a refusal writes nothing.
 *
 * Money is computed in Postgres `numeric`, never as a float. The allocation
 * (D7) works in integer minor units: with k = 10^m, P, C and X scaled by k,
 * `floor_m(C × X / P) = div(Ck × Xk, Pk) / k`, which is exact (no division
 * rounding can lift a repeating fraction over a unit).
 */
import type { PoolClient } from "pg";

import { standingFinding } from "../../pos-shifts/shift-close-approver";
import { ShiftStoreUserReader } from "../../pos-shifts/shift-store-user";
import type { CreditReversalRefundTenderDto } from "./dto/credit-sale-reversal-request.dto";
import type { VoidApprovalDto } from "./dto/record-void-request.dto";
import { minorUnitExponent } from "./iso4217-minor-units";
import { VOID_APPROVAL_SKEW_MS } from "./void-approval";

/** The envelope operator is not a live owner / tenant_admin / store_manager of the store → 403. */
export class CreditReversalRoleRefusedError extends Error {
  constructor() {
    super("a credit reversal needs an owner, tenant admin or store manager of this store");
    this.name = "CreditReversalRoleRefusedError";
  }
}

/** The sale has no payer responsibilities: use the ordinary routes → 422. */
export class CreditReversalNotApplicableError extends Error {
  constructor() {
    super("the sale has no payer responsibilities");
    this.name = "CreditReversalNotApplicableError";
  }
}

/** The refundable share cannot be established → 422 (held for administrative investigation). */
export class CreditReversalAllocationUnavailableError extends Error {
  constructor() {
    super("the refundable share of this reversal cannot be established");
    this.name = "CreditReversalAllocationUnavailableError";
  }
}

/** The payer settlement cannot be established → 422, one body for every cause. */
export class CreditReversalSettlementUnavailableError extends Error {
  constructor() {
    super("the payer settlement of this reversal cannot be established");
    this.name = "CreditReversalSettlementUnavailableError";
  }
}

/** The refund tenders are not the server-computed refund → 422. */
export class CreditReversalRefundMismatchError extends Error {
  constructor() {
    super("refund tenders do not match the refundable amount");
    this.name = "CreditReversalRefundMismatchError";
  }
}

/** D6: a cash-paying credit return came without a second approval → 403. */
export class CreditReturnApprovalRequiredError extends Error {
  constructor() {
    super("a credit return that pays out cash needs a second approval");
    this.name = "CreditReturnApprovalRequiredError";
  }
}

/** D6: the second approval fails a check → 403, one body for every cause. */
export class CreditReturnApprovalRefusedError extends Error {
  constructor() {
    super("the second approval does not authorize this credit return");
    this.name = "CreditReturnApprovalRefusedError";
  }
}

/** The action a credit return's second approval is bound to. */
export const CREDIT_RETURN_APPROVAL_ACTION = "sale.credit_return";

interface SaleScope {
  readonly tenantId: string;
  readonly storeId: string;
}

const storeUsers = new ShiftStoreUserReader();

/**
 * The actor's CURRENT standing must be an active owner / tenant_admin /
 * store_manager with access to the sale's store (the RT-530 set). Returns the
 * role code for the audit trail. A lookup that fails refuses (never a 5xx).
 */
export async function assertCreditReversalActor(client: PoolClient, scope: SaleScope, actorUserId: string): Promise<string> {
  let standing;
  try {
    standing = await storeUsers.approverStanding(client, { scope, userId: actorUserId });
  } catch {
    throw new CreditReversalRoleRefusedError();
  }
  if (standing === null || standingFinding(standing) !== null) throw new CreditReversalRoleRefusedError();
  return standing.roleCode;
}

/** What the allocation and the approval checks read about the (locked) sale. */
export interface CreditSaleFacts {
  readonly posTotal: string;
  readonly collected: string;
  readonly currencyCode: string;
  readonly businessDate: string;
  readonly sellerUserId: string;
  readonly payerId: string;
  /** sum of `reversal_total` over the sale's earlier credit reversals (X0). */
  readonly creditReversedBefore: string;
  /** true when the allocation cannot be established (see `assertAllocationAvailable`). */
  readonly allocationBlocked: boolean;
}

/**
 * Read the facts under the sale lock. `allocationBlocked` folds every
 * fail-closed allocation cause the contract lists: an ordinary return or a
 * refund on the sale (its payout was never allocated), lines that do not sum
 * to `posTotal` (`mismatch_flag` true or NULL), or a non-positive total.
 */
export async function readCreditSaleFacts(client: PoolClient, saleRef: string): Promise<CreditSaleFacts> {
  const r = await client.query<{
    pos_total: string;
    collected: string;
    currency_code: string;
    business_date: string;
    created_by: string;
    payer_id: string | null;
    before: string;
    blocked: boolean;
  }>(
    `SELECT s.pos_total::text AS pos_total,
            COALESCE((SELECT SUM(t.amount) FROM sale_tenders t WHERE t.sale_id = s.id), 0)::text AS collected,
            s.currency_code, s.business_date::text AS business_date, s.created_by::text AS created_by,
            (SELECT sr.payer_id::text FROM sale_responsibilities sr WHERE sr.sale_id = s.id
              ORDER BY sr.sequence LIMIT 1) AS payer_id,
            COALESCE((SELECT SUM(c.reversal_total) FROM sale_credit_reversals c WHERE c.sale_id = s.id), 0)::text AS before,
            (s.mismatch_flag IS NOT FALSE
              OR s.pos_total <= 0
              OR EXISTS (SELECT 1 FROM sale_refunds f WHERE f.sale_id = s.id)
              OR EXISTS (SELECT 1 FROM sale_returns r WHERE r.sale_id = s.id
                          AND NOT EXISTS (SELECT 1 FROM sale_credit_reversals c WHERE c.return_id = r.id))
            ) AS blocked
       FROM sales s WHERE s.id = $1`,
    [saleRef],
  );
  const row = r.rows[0];
  if (row === undefined) throw new Error("locked sale not readable");
  if (row.payer_id === null) throw new CreditReversalSettlementUnavailableError();
  return {
    posTotal: row.pos_total,
    collected: row.collected,
    currencyCode: row.currency_code,
    businessDate: row.business_date,
    sellerUserId: row.created_by,
    payerId: row.payer_id,
    creditReversedBefore: row.before,
    allocationBlocked: row.blocked,
  };
}

/** The server-computed allocation of one reversal (D7). */
export interface Allocation {
  readonly reversalTotal: string;
  readonly refundable: string;
  readonly adjustment: string;
}

/**
 * D7 allocation: `refundable = floor_m(C × X1 / P) − floor_m(C × X0 / P)` and
 * `adjustment = total − refundable`, in exact integer minor units. Refuses
 * (allocation unavailable) when the facts block it, the currency has no
 * ISO-4217 minor unit, or any amount (P, C, every tender and responsibility,
 * the reversal total) is not exact in it, or X1 would exceed P.
 */
export async function allocate(
  client: PoolClient,
  saleRef: string,
  facts: CreditSaleFacts,
  reversalTotal: string,
): Promise<Allocation> {
  const m = minorUnitExponent(facts.currencyCode);
  if (facts.allocationBlocked || m === null) throw new CreditReversalAllocationUnavailableError();
  const r = await client.query<{ exact: boolean; refundable: string | null; adjustment: string | null; total: string }>(
    `WITH f AS (
       SELECT $2::numeric AS p, $3::numeric AS c, $4::numeric AS x0,
              $4::numeric + $5::numeric AS x1, $5::numeric AS total, power(10::numeric, $6::int) AS k
     ), scaled AS (
       SELECT f.*, (f.p * f.k) AS pk, (f.c * f.k) AS ck, (f.x0 * f.k) AS x0k, (f.x1 * f.k) AS x1k FROM f
     ), checks AS (
       SELECT s.*,
              (s.pk = trunc(s.pk) AND s.ck = trunc(s.ck) AND s.x1k = trunc(s.x1k) AND s.x0k = trunc(s.x0k)
                AND s.x1 <= s.p
                AND NOT EXISTS (SELECT 1 FROM sale_tenders t WHERE t.sale_id = $1 AND t.amount * s.k <> trunc(t.amount * s.k))
                AND NOT EXISTS (SELECT 1 FROM sale_responsibilities r WHERE r.sale_id = $1 AND r.amount * s.k <> trunc(r.amount * s.k))
              ) AS exact
         FROM scaled s
     )
     SELECT exact, total::numeric(19,4)::text AS total,
            CASE WHEN exact THEN ((div(ck * x1k, pk) - div(ck * x0k, pk)) / k)::numeric(19,4)::text END AS refundable,
            CASE WHEN exact THEN (total - (div(ck * x1k, pk) - div(ck * x0k, pk)) / k)::numeric(19,4)::text END AS adjustment
       FROM checks`,
    [saleRef, facts.posTotal, facts.collected, facts.creditReversedBefore, reversalTotal, m],
  );
  const row = r.rows[0];
  if (row?.exact !== true || row.refundable === null || row.adjustment === null) {
    throw new CreditReversalAllocationUnavailableError();
  }
  return { reversalTotal: row.total, refundable: row.refundable, adjustment: row.adjustment };
}

/**
 * Payer settlement: the sale's payer still exists in this tenant, is scoped to
 * this store or tenant-wide, is active, and has a non-blank ERPNext Customer
 * link. Locked FOR SHARE until commit (the capture precedent).
 */
export async function assertPayerSettlement(client: PoolClient, scope: SaleScope, payerId: string): Promise<void> {
  const r = await client.query<{ id: string }>(
    `SELECT id::text AS id FROM payer_account
      WHERE id = $1 AND tenant_id = $2 AND (store_id IS NULL OR store_id = $3)
        AND status = 'active' AND external_ref ~ '[^[:space:]]'
      FOR SHARE`,
    [payerId, scope.tenantId, scope.storeId],
  );
  if (r.rows.length !== 1) throw new CreditReversalSettlementUnavailableError();
}

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/**
 * D6: a cash-paying credit return needs a second approval; an approval that is
 * sent is always checked. Every failure is one refusal (no cause disclosed).
 */
export async function assertCreditReturnApproval(
  client: PoolClient,
  input: {
    readonly scope: SaleScope;
    readonly saleRef: string;
    readonly actorUserId: string;
    readonly sellerUserId: string;
    readonly refundable: string;
    readonly approval: VoidApprovalDto | undefined;
    readonly now: Date;
  },
): Promise<void> {
  const { approval } = input;
  if (approval === undefined) {
    if (await isPositive(client, input.refundable)) throw new CreditReturnApprovalRequiredError();
    return;
  }
  const claimsHold =
    approval.action === CREDIT_RETURN_APPROVAL_ACTION &&
    same(approval.saleRef, input.saleRef) &&
    Date.parse(approval.approvedAt) <= input.now.getTime() + VOID_APPROVAL_SKEW_MS &&
    same(approval.requesterUserId, input.actorUserId) &&
    !same(approval.approverUserId, approval.requesterUserId) &&
    !same(approval.approverUserId, input.sellerUserId);
  if (!claimsHold) throw new CreditReturnApprovalRefusedError();
  const r = await client.query<{ amount_ok: boolean; used: boolean }>(
    `SELECT $1::numeric = $2::numeric AS amount_ok,
            (EXISTS (SELECT 1 FROM sale_approval_uses u WHERE u.tenant_id = $3 AND u.approval_id = $4)
             OR EXISTS (SELECT 1 FROM sale_voids v WHERE v.tenant_id = $3 AND v.approval_id = $4)) AS used`,
    [approval.amount, input.refundable, input.scope.tenantId, approval.approvalId],
  );
  if (r.rows[0]?.amount_ok !== true || r.rows[0].used) throw new CreditReturnApprovalRefusedError();
  const standing = await storeUsers.approverStanding(client, { scope: input.scope, userId: approval.approverUserId });
  if (standingFinding(standing) !== null) throw new CreditReturnApprovalRefusedError();
}

async function isPositive(client: PoolClient, amount: string): Promise<boolean> {
  const r = await client.query<{ positive: boolean }>(`SELECT $1::numeric > 0 AS positive`, [amount]);
  return r.rows[0]?.positive === true;
}

/**
 * The refund tenders (D8). A return: cash amounts summing to `refundable`
 * exactly. A void: the multiset of (method, amount, tenderRef) equals the
 * sale's tenders, a legacy tender (no tender_ref) matched by method and amount.
 */
export async function assertRefundTenders(
  client: PoolClient,
  input: {
    readonly kind: "void" | "return";
    readonly saleRef: string;
    readonly refundable: string;
    readonly tenders: ReadonlyArray<CreditReversalRefundTenderDto>;
  },
): Promise<void> {
  const methods = input.tenders.map((t) => t.method);
  const amounts = input.tenders.map((t) => t.amount);
  const refs = input.tenders.map((t) => (t.tenderRef === undefined ? null : t.tenderRef.toLowerCase()));
  const r = await client.query<{ ok: boolean }>(
    input.kind === "return"
      ? `SELECT COALESCE((SELECT SUM(a) FROM unnest($1::numeric[]) a), 0) = $2::numeric AS ok`
      : `WITH req AS (
           SELECT m, a::numeric AS a, r FROM unnest($3::text[], $2::numeric[], $4::uuid[]) AS x(m, a, r)
         ), stored AS (
           SELECT method AS m, amount::numeric AS a, tender_ref AS r FROM sale_tenders WHERE sale_id = $1
         )
         SELECT NOT EXISTS (
           (SELECT m, a, r FROM req EXCEPT ALL SELECT m, a, r FROM stored)
           UNION ALL
           (SELECT m, a, r FROM stored EXCEPT ALL SELECT m, a, r FROM req)
         ) AS ok`,
    input.kind === "return" ? [amounts, input.refundable] : [input.saleRef, amounts, methods, refs],
  );
  if (r.rows[0]?.ok !== true) throw new CreditReversalRefundMismatchError();
}
