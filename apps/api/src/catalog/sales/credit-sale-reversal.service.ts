/**
 * CreditSaleReversalService — `recordCreditSaleReversal` (Jira RT-577;
 * `pos-sales/sales.yaml` 1.11.0-draft; owner-approved V1 decision and rulings
 * D6 / D7 / D8, 2026-10-17).
 *
 * The only way to void or return a sale with payer responsibilities. One
 * transaction under the sale row lock; checks in the contract's order:
 *   the sale (404) → a provenance replay (200, or 409 `conflict`) → the actor
 *   (403 `credit_reversal_role_refused`) → the credit status (422
 *   `credit_reversal_not_applicable`) → exclusivity (409 `already_reversed`) →
 *   a void's RT-530 checks / a return's line checks (400, 409 `over_return`) →
 *   allocation (422 `credit_reversal_allocation_unavailable`) → payer
 *   settlement (422 `credit_reversal_settlement_unavailable`) → a return's
 *   second approval (403 `credit_return_approval_required` / `_refused`) →
 *   the refund tenders (422 `credit_reversal_refund_mismatch`).
 * (The returns gate, 404, is the controller's; schema 400s and the 401 come
 * before the handler.) Any refusal rolls back: nothing is recorded or paid.
 */
import { Inject, Injectable } from "@nestjs/common";
import { runWithTenantContext } from "@data-pulse-2/db";
import type { Pool, PoolClient } from "pg";

import { PG_POOL } from "../../auth/auth.module";
import {
  allocate,
  assertCreditReturnApproval,
  assertCreditReversalActor,
  assertPayerSettlement,
  assertRefundTenders,
  CreditReversalNotApplicableError,
  readCreditSaleFacts,
} from "./credit-sale-reversal.checks";
import {
  findCreditReversalByProvenance,
  loadCreditReversal,
  writeCreditReversal,
  type CreditSaleReversalProjection,
  type StoredCreditReversal,
} from "./credit-sale-reversal.store";
import type { CreditSaleReversalRequestDto } from "./dto/credit-sale-reversal-request.dto";
import { sha256CanonicalHex } from "./payload-hash";
import { TerminalEventProvenanceConflictError } from "./sale-errors";
import { priceReturnLines, type PricedLine } from "./sale-returns.service";
import { lockSaleForReversal, readReversalState, SaleAlreadyReversedError, type LockedSale } from "./sale-reversal";
import {
  assertApproverEligible,
  assertRequesterIsStoreUser,
  checkVoidApprovalClaims,
  readVoidSaleFacts,
  VoidApprovalInvalidError,
} from "./void-approval";

export interface CreditSaleReversalInput {
  readonly tenantId: string;
  readonly storeId: string;
  readonly actorUserId: string;
  readonly saleRef: string;
  readonly body: CreditSaleReversalRequestDto;
}

export interface CreditSaleReversalResult {
  readonly projection: CreditSaleReversalProjection;
  /** false when a re-delivery resolved to the stored reversal. */
  readonly created: boolean;
  /** The `sale.credit_reversed` audit evidence. */
  readonly audit: Record<string, unknown>;
}

interface Scope {
  readonly tenantId: string;
  readonly storeId: string;
}

@Injectable()
export class CreditSaleReversalService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  record(input: CreditSaleReversalInput): Promise<CreditSaleReversalResult> {
    const payloadHash = sha256CanonicalHex(input.body);
    return runWithTenantContext(
      this.pool,
      { tenantId: input.tenantId, isPlatformAdmin: false },
      async (client): Promise<CreditSaleReversalResult> => {
        const sale = await lockSaleForReversal(client, input.saleRef, input.storeId);
        const replayed = await replay(client, input, payloadHash);
        if (replayed !== null) return replayed;
        return recordNew(client, input, sale, payloadHash);
      },
    );
  }
}

/** A provenance already used: the stored reversal (same sale and payload) or a 409. */
async function replay(
  client: PoolClient,
  input: CreditSaleReversalInput,
  payloadHash: string,
): Promise<CreditSaleReversalResult | null> {
  const { credit, ordinaryHolds } = await findCreditReversalByProvenance(client, input.tenantId, input.body);
  if (credit === null) {
    // An ordinary void or return already holds this provenance: never a replay.
    if (ordinaryHolds) throw new TerminalEventProvenanceConflictError();
    return null;
  }
  if (!isSameReversal(credit, input.saleRef, payloadHash)) throw new TerminalEventProvenanceConflictError();
  const stored = await loadCreditReversal(client, credit.id);
  return { projection: stored.projection, created: false, audit: auditOf(stored) };
}

/** A replay only for the SAME sale and the same payload (FR-013). */
function isSameReversal(credit: { readonly sale_id: string; readonly payload_hash: string }, saleRef: string, payloadHash: string): boolean {
  return credit.sale_id === saleRef && credit.payload_hash === payloadHash;
}

/** The credit status and exclusivity checks, in the contract's order. */
function assertReversible(sale: LockedSale, state: { voided: boolean; returned: boolean }, kind: "void" | "return"): void {
  if (sale.responsibilityCount <= 0) throw new CreditReversalNotApplicableError();
  if (state.voided) throw new SaleAlreadyReversedError();
  if (kind === "void" && state.returned) throw new SaleAlreadyReversedError();
}

/** A void's RT-530 checks and total (the sale's posTotal), or a return's priced lines and total. */
async function priceReversal(
  client: PoolClient,
  scope: Scope,
  input: CreditSaleReversalInput,
  posTotal: string,
): Promise<{ priced: PricedLine[]; reversalTotal: string }> {
  if (input.body.kind === "void") {
    await checkCreditVoidApproval(client, scope, input);
    return { priced: [], reversalTotal: posTotal };
  }
  const priced = await priceReturnLines(client, input.saleRef, input.body.lines ?? []);
  return { priced, reversalTotal: await sumOf(client, priced.map((l) => l.lineAmount)) };
}

async function recordNew(
  client: PoolClient,
  input: CreditSaleReversalInput,
  sale: LockedSale,
  payloadHash: string,
): Promise<CreditSaleReversalResult> {
  const { body, saleRef, actorUserId } = input;
  const scope: Scope = { tenantId: input.tenantId, storeId: input.storeId };
  const actorRole = await assertCreditReversalActor(client, scope, actorUserId);
  assertReversible(sale, await readReversalState(client, saleRef), body.kind);

  const facts = await readCreditSaleFacts(client, saleRef);
  const { priced, reversalTotal } = await priceReversal(client, scope, input, facts.posTotal);
  const allocation = await allocate(client, saleRef, facts, reversalTotal);
  const payerId = await assertPayerSettlement(client, scope, facts.payerId);
  // D6: only a return carries the second approval (a void's is its RT-530 approval).
  if (body.kind === "return") {
    await assertCreditReturnApproval(client, {
      scope,
      saleRef,
      actorUserId,
      sellerUserId: facts.sellerUserId,
      refundable: allocation.refundable,
      approval: body.approval,
      now: new Date(),
    });
  }
  await assertRefundTenders(client, { kind: body.kind, saleRef, refundable: allocation.refundable, tenders: body.refundTenders });

  const reversalId = await writeCreditReversal(client, {
    ...scope,
    saleRef,
    actorUserId,
    actorRole,
    timezone: sale.timezone,
    currencyCode: sale.currencyCode,
    payerId,
    payloadHash,
    body,
    allocation,
    priced,
  });
  const stored = await loadCreditReversal(client, reversalId);
  return { projection: stored.projection, created: true, audit: auditOf(stored) };
}

/**
 * A credit void keeps RT-530 checks 1 to 7 in their order and with their
 * codes; the approval id must also be unused (single use across recordVoid
 * and credit reversals), checked here so the refusal keeps its position.
 */
async function checkCreditVoidApproval(client: PoolClient, scope: Scope, input: CreditSaleReversalInput): Promise<void> {
  const { body } = input;
  const facts = await readVoidSaleFacts(client, input.saleRef, body.approval?.amount);
  const approval = checkVoidApprovalClaims({
    body: {
      sourceSystem: body.sourceSystem,
      externalId: body.externalId,
      ...(body.businessDate === undefined ? {} : { businessDate: body.businessDate }),
      ...(body.approval === undefined ? {} : { approval: body.approval }),
    },
    actorUserId: input.actorUserId,
    sale: facts,
    now: new Date(),
  });
  await assertRequesterIsStoreUser(client, scope, approval.requesterUserId);
  await assertApproverEligible(client, scope, approval.approverUserId);
  const used = await client.query<{ used: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM sale_approval_uses WHERE tenant_id = $1 AND approval_id = $2)
         OR EXISTS (SELECT 1 FROM sale_voids WHERE tenant_id = $1 AND approval_id = $2) AS used`,
    [scope.tenantId, approval.approvalId],
  );
  if (used.rows[0]?.used === true) throw new VoidApprovalInvalidError();
}

/** Σ amounts in exact numeric(19,4). */
async function sumOf(client: PoolClient, amounts: ReadonlyArray<string>): Promise<string> {
  const r = await client.query<{ total: string }>(
    `SELECT COALESCE((SELECT SUM(a) FROM unnest($1::numeric[]) a), 0)::numeric(19,4)::text AS total`,
    [amounts],
  );
  return r.rows[0]!.total;
}

/** The `sale.credit_reversed` audit metadata (the decision's evidence). */
function auditOf(stored: StoredCreditReversal): Record<string, unknown> {
  const p = stored.projection;
  return {
    sale_ref: p.saleRef,
    reversal_ref: p.reversalRef,
    kind: p.kind,
    actor_role: stored.actorRole,
    reason: p.reason,
    recorded_at: p.recordedAt,
    reversal_total: p.reversalTotal,
    refundable_amount: p.refundableAmount,
    refund_tenders: p.refundTenders,
    receivable_adjustment:
      p.receivableAdjustment === null
        ? null
        : {
            payer_ref: p.receivableAdjustment.payerRef,
            amount: p.receivableAdjustment.amount,
            adjustment_ref: p.receivableAdjustment.adjustmentRef,
          },
    ...(stored.approval === null
      ? {}
      : {
          approval_id: stored.approval.approvalId,
          approver_user_id: stored.approval.approverUserId,
          requester_user_id: stored.approval.requesterUserId,
          policy_version: stored.approval.policyVersion,
        }),
  };
}
