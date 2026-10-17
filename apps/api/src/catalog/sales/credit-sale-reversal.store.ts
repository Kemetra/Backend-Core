/**
 * credit-sale-reversal.store.ts — the writes and the wire projection of a
 * credit-sale reversal (Jira RT-577; migration 0054).
 *
 * A credit reversal REUSES the ordinary reversal row (a `sale_voids` row for a
 * void, a `sale_returns` row with its lines and cash tenders for a return), so
 * `voided`, `returnedQuantity`, exclusivity and the posting feed's reversal
 * work item are unchanged, and adds its `sale_credit_reversals` row and
 * refund tenders. Everything runs in the caller's transaction, under the sale
 * lock; the projection is always re-read from the stored rows, so a replay is
 * byte-identical.
 */
import { emit, OUTBOX_EVENT_TYPES } from "@data-pulse-2/db";
import { newId } from "@data-pulse-2/shared";
import type { PoolClient } from "pg";

import { CreditReturnApprovalRefusedError, type Allocation } from "./credit-sale-reversal.checks";
import type { CreditSaleReversalRequestDto } from "./dto/credit-sale-reversal-request.dto";
import type { VoidApprovalDto } from "./dto/record-void-request.dto";
import { TerminalEventProvenanceConflictError } from "./sale-errors";
import { loadSaleReturn, type PricedLine, type ReturnLineProjection } from "./sale-returns.service";
import { mapOneVoidViolation } from "./sale-reversal";
import { mapApprovalReuseViolation } from "./sales.service";

/** The contract `CreditReversalRefundTender` wire shape. */
export interface CreditReversalRefundTenderProjection {
  readonly method: string;
  readonly amount: string;
  readonly tenderRef?: string;
  readonly reference?: string;
}

/** The contract `CreditSaleReversal` wire shape. */
export interface CreditSaleReversalProjection {
  readonly reversalRef: string;
  readonly saleRef: string;
  readonly kind: "void" | "return";
  readonly recordedAt: string;
  readonly businessDate: string;
  readonly sourceSystem: string;
  readonly externalId: string;
  readonly currencyCode: string;
  readonly reversalTotal: string;
  readonly refundableAmount: string;
  readonly receivableAdjustment: { readonly adjustmentRef: string; readonly payerRef: string; readonly amount: string } | null;
  readonly lines: ReadonlyArray<ReturnLineProjection>;
  readonly refundTenders: ReadonlyArray<CreditReversalRefundTenderProjection>;
  readonly reason: string;
}

/** The approval evidence a stored reversal carries (a void's on its sale_voids row). */
export interface CreditReversalApprovalEvidence {
  readonly approvalId: string;
  readonly approverUserId: string;
  readonly requesterUserId: string;
  readonly policyVersion: string;
}

export interface StoredCreditReversal {
  readonly projection: CreditSaleReversalProjection;
  readonly actorRole: string;
  readonly approval: CreditReversalApprovalEvidence | null;
}

export interface CreditReversalWrite {
  readonly tenantId: string;
  readonly storeId: string;
  readonly saleRef: string;
  readonly actorUserId: string;
  readonly actorRole: string;
  readonly timezone: string;
  readonly currencyCode: string;
  readonly payerId: string;
  readonly payloadHash: string;
  readonly body: CreditSaleReversalRequestDto;
  readonly allocation: Allocation;
  readonly priced: ReadonlyArray<PricedLine>;
}

/** Record the reversal and its posting work item; returns the reversal id. */
export async function writeCreditReversal(client: PoolClient, w: CreditReversalWrite): Promise<string> {
  const link = w.body.kind === "void" ? await insertVoid(client, w) : await insertReturn(client, w);
  const reversalId = newId();
  // D6: a return's second approval lives on the reversal (a void's on its sale_voids row).
  const approval = w.body.kind === "return" ? w.body.approval : undefined;
  await client.query(
    `INSERT INTO sale_credit_reversals
       (id, tenant_id, store_id, sale_id, kind, void_id, return_id, source_system, external_id,
        payload_hash, business_date, currency_code, reversal_total, refundable_amount,
        adjustment_amount, payer_id, adjustment_ref, actor_user_id, actor_role, reason,
        approval_id, approved_by_user_id, requested_by_user_id, approval_policy_version, approved_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, (now() AT TIME ZONE $11)::date, $12,
             $13::numeric, $14::numeric, $15::numeric, $16,
             CASE WHEN $15::numeric > 0 THEN $17::uuid END, $18, $19, $20,
             $21, $22, $23, $24, $25)`,
    [
      reversalId,
      w.tenantId,
      w.storeId,
      w.saleRef,
      w.body.kind,
      ...linkColumns(w.body.kind, link),
      w.body.sourceSystem,
      w.body.externalId,
      w.payloadHash,
      w.timezone,
      w.currencyCode,
      w.allocation.reversalTotal,
      w.allocation.refundable,
      w.allocation.adjustment,
      w.payerId,
      newId(),
      w.actorUserId,
      w.actorRole,
      w.body.reason,
      ...approvalColumns(approval),
    ],
  );
  await insertRefundTenders(client, w, reversalId);
  if (approval !== undefined) await consumeReturnApproval(client, w.tenantId, approval.approvalId);
  await emit(client, {
    eventType: OUTBOX_EVENT_TYPES.ERPNEXT_POSTING_REQUESTED,
    tenantId: w.tenantId,
    storeId: w.storeId,
    payload: { sale_id: w.saleRef, store_id: w.storeId, kind: "reversal", source_ref_id: link },
    correlationId: null,
  });
  return reversalId;
}

/** `void_id`, `return_id`: the link column of the reversal's kind. */
function linkColumns(kind: "void" | "return", link: string): [string | null, string | null] {
  return kind === "void" ? [link, null] : [null, link];
}

/** The five approval columns, all NULL without a (return's) second approval. */
function approvalColumns(approval: VoidApprovalDto | undefined): Array<string | null> {
  if (approval === undefined) return [null, null, null, null, null];
  return [approval.approvalId, approval.approverUserId, approval.requesterUserId, approval.policyVersion, approval.approvedAt];
}

/** The refund paid out, in request order. */
async function insertRefundTenders(client: PoolClient, w: CreditReversalWrite, reversalId: string): Promise<void> {
  const tenders = w.body.refundTenders;
  if (tenders.length === 0) return;
  await client.query(
    `INSERT INTO sale_credit_reversal_tenders
       (id, reversal_id, tenant_id, store_id, ordinal, method, amount, tender_ref, reference)
     SELECT t.id, $1, $2, $3, t.ord - 1, t.method, t.amount, t.tender_ref, t.reference
       FROM unnest($4::uuid[], $5::text[], $6::numeric[], $7::uuid[], $8::text[])
            WITH ORDINALITY AS t(id, method, amount, tender_ref, reference, ord)`,
    [
      reversalId,
      w.tenantId,
      w.storeId,
      tenders.map(() => newId()),
      tenders.map((t) => t.method),
      tenders.map((t) => t.amount),
      tenders.map((t) => t.tenderRef ?? null),
      tenders.map((t) => t.reference ?? null),
    ],
  );
}

/** The void row; a provenance an ordinary void already holds is a 409. */
async function insertVoid(client: PoolClient, w: CreditReversalWrite): Promise<string> {
  const approval = w.body.approval!;
  let r;
  try {
    r = await client.query<{ id: string }>(
      `INSERT INTO sale_voids
         (id, sale_id, tenant_id, store_id, business_date, source_system, external_id, payload_hash,
          created_by, approval_id, approved_by_user_id, requested_by_user_id, approval_policy_version,
          approved_at, void_business_date)
       VALUES ($1, $2, $3, $4, (now() AT TIME ZONE $5)::date, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       ON CONFLICT (tenant_id, source_system, external_id) DO NOTHING
       RETURNING id`,
      [
        newId(),
        w.saleRef,
        w.tenantId,
        w.storeId,
        w.timezone,
        w.body.sourceSystem,
        w.body.externalId,
        w.payloadHash,
        w.actorUserId,
        approval.approvalId,
        approval.approverUserId,
        approval.requesterUserId,
        approval.policyVersion,
        approval.approvedAt,
        w.body.businessDate,
      ],
    );
  } catch (err) {
    throw mapApprovalReuseViolation(mapOneVoidViolation(err));
  }
  const id = r.rows[0]?.id;
  if (id === undefined) throw new TerminalEventProvenanceConflictError();
  return id;
}

/** The return row, its priced lines and its cash tenders; a provenance an ordinary return holds is a 409. */
async function insertReturn(client: PoolClient, w: CreditReversalWrite): Promise<string> {
  const r = await client.query<{ id: string }>(
    `INSERT INTO sale_returns
       (id, sale_id, tenant_id, store_id, return_seq, business_date, currency_code, return_total,
        reason, source_system, external_id, payload_hash, created_by)
     VALUES ($1, $2, $3, $4,
             (SELECT COALESCE(MAX(return_seq), 0) + 1 FROM sale_returns WHERE sale_id = $2),
             (now() AT TIME ZONE $5)::date, $6, $7::numeric, $8, $9, $10, $11, $12)
     ON CONFLICT (tenant_id, source_system, external_id) DO NOTHING
     RETURNING id`,
    [
      newId(),
      w.saleRef,
      w.tenantId,
      w.storeId,
      w.timezone,
      w.currencyCode,
      w.allocation.reversalTotal,
      w.body.reason,
      w.body.sourceSystem,
      w.body.externalId,
      w.payloadHash,
      w.actorUserId,
    ],
  );
  const returnId = r.rows[0]?.id;
  if (returnId === undefined) throw new TerminalEventProvenanceConflictError();
  await insertReturnLines(client, w, returnId);
  await insertReturnTenders(client, w, returnId);
  return returnId;
}

/** The priced return lines (the `recordReturn` columns). */
async function insertReturnLines(client: PoolClient, w: CreditReversalWrite, returnId: string): Promise<void> {
  const lines = w.priced;
  await client.query(
    `INSERT INTO sale_return_lines
       (id, return_id, sale_line_id, tenant_id, store_id, quantity, line_amount, tax_amount, returned_quantity_after)
     SELECT l.id, $1, l.sale_line_id, $2, $3, l.quantity, l.line_amount, l.tax_amount, l.returned_after
       FROM unnest($4::uuid[], $5::uuid[], $6::numeric[], $7::numeric[], $8::numeric[], $9::numeric[])
            AS l(id, sale_line_id, quantity, line_amount, tax_amount, returned_after)`,
    [
      returnId,
      w.tenantId,
      w.storeId,
      lines.map(() => newId()),
      lines.map((l) => l.lineRef),
      lines.map((l) => l.quantity),
      lines.map((l) => l.lineAmount),
      lines.map((l) => l.taxAmount),
      lines.map((l) => l.returnedAfter),
    ],
  );
}

/**
 * The cash paid out, also on the return itself: the shift cash-up and the
 * posting projection read sale_return_tenders.
 */
async function insertReturnTenders(client: PoolClient, w: CreditReversalWrite, returnId: string): Promise<void> {
  const tenders = w.body.refundTenders;
  if (tenders.length === 0) return;
  await client.query(
    `INSERT INTO sale_return_tenders (id, return_id, tenant_id, store_id, ordinal, method, amount)
     SELECT t.id, $1, $2, $3, t.ord - 1, t.method, t.amount
       FROM unnest($4::uuid[], $5::text[], $6::numeric[]) WITH ORDINALITY AS t(id, method, amount, ord)`,
    [returnId, w.tenantId, w.storeId, tenders.map(() => newId()), tenders.map((t) => t.method), tenders.map((t) => t.amount)],
  );
}

/** D6: consume the second approval's id in the shared single-use ledger. */
async function consumeReturnApproval(client: PoolClient, tenantId: string, approvalId: string): Promise<void> {
  try {
    await client.query(
      `INSERT INTO sale_approval_uses (tenant_id, approval_id, source) VALUES ($1, $2, 'credit_return')`,
      [tenantId, approvalId],
    );
  } catch (err) {
    const pg = err as { code?: string; constraint?: string };
    if (pg.code === "23505" && pg.constraint === "sale_approval_uses_pkey") throw new CreditReturnApprovalRefusedError();
    throw err;
  }
}

interface ReversalRow {
  id: string;
  sale_id: string;
  kind: "void" | "return";
  return_id: string | null;
  void_id: string | null;
  created_at: Date;
  business_date: string;
  source_system: string;
  external_id: string;
  currency_code: string;
  reversal_total: string;
  refundable_amount: string;
  adjustment_amount: string;
  payer_id: string;
  adjustment_ref: string | null;
  actor_role: string;
  reason: string;
  approval_id: string | null;
  approved_by_user_id: string | null;
  requested_by_user_id: string | null;
  approval_policy_version: string | null;
}

/** Re-read a stored reversal: the wire projection and the audit evidence. */
export async function loadCreditReversal(client: PoolClient, reversalId: string): Promise<StoredCreditReversal> {
  const r = await client.query<ReversalRow>(
    `SELECT c.id, c.sale_id, c.kind, c.return_id, c.void_id, c.created_at,
            c.business_date::text AS business_date, c.source_system, c.external_id, c.currency_code,
            c.reversal_total::text AS reversal_total, c.refundable_amount::text AS refundable_amount,
            c.adjustment_amount::text AS adjustment_amount, c.payer_id::text AS payer_id,
            c.adjustment_ref::text AS adjustment_ref, c.actor_role, c.reason,
            COALESCE(c.approval_id, v.approval_id)::text AS approval_id,
            COALESCE(c.approved_by_user_id, v.approved_by_user_id)::text AS approved_by_user_id,
            COALESCE(c.requested_by_user_id, v.requested_by_user_id)::text AS requested_by_user_id,
            COALESCE(c.approval_policy_version, v.approval_policy_version) AS approval_policy_version
       FROM sale_credit_reversals c LEFT JOIN sale_voids v ON v.id = c.void_id
      WHERE c.id = $1`,
    [reversalId],
  );
  const row = r.rows[0];
  if (row === undefined) throw new Error("credit reversal row not found");
  const tenders = await client.query<{ method: string; amount: string; tender_ref: string | null; reference: string | null }>(
    `SELECT method, amount::text AS amount, tender_ref::text AS tender_ref, reference
       FROM sale_credit_reversal_tenders WHERE reversal_id = $1 ORDER BY ordinal`,
    [reversalId],
  );
  const lines = row.return_id === null ? [] : (await loadSaleReturn(client, row.return_id)).lines;
  return { projection: toProjection(row, lines, tenders.rows.map(toTender)), actorRole: row.actor_role, approval: approvalOf(row) };
}

function toProjection(
  row: ReversalRow,
  lines: ReadonlyArray<ReturnLineProjection>,
  refundTenders: ReadonlyArray<CreditReversalRefundTenderProjection>,
): CreditSaleReversalProjection {
  return {
    reversalRef: row.id,
    saleRef: row.sale_id,
    kind: row.kind,
    recordedAt: row.created_at.toISOString(),
    businessDate: row.business_date,
    sourceSystem: row.source_system,
    externalId: row.external_id,
    currencyCode: row.currency_code,
    reversalTotal: row.reversal_total,
    refundableAmount: row.refundable_amount,
    receivableAdjustment: adjustmentOf(row),
    lines,
    refundTenders,
    reason: row.reason,
  };
}

function adjustmentOf(row: ReversalRow): CreditSaleReversalProjection["receivableAdjustment"] {
  if (row.adjustment_ref === null) return null;
  return { adjustmentRef: row.adjustment_ref, payerRef: row.payer_id, amount: row.adjustment_amount };
}

function toTender(t: { method: string; amount: string; tender_ref: string | null; reference: string | null }): CreditReversalRefundTenderProjection {
  return {
    method: t.method,
    amount: t.amount,
    ...(t.tender_ref === null ? {} : { tenderRef: t.tender_ref }),
    ...(t.reference === null ? {} : { reference: t.reference }),
  };
}

/** The approval evidence (all four columns, or none: the 0046 / 0054 all-or-none CHECKs). */
function approvalOf(row: ReversalRow): CreditReversalApprovalEvidence | null {
  if (row.approval_id === null) return null;
  return {
    approvalId: row.approval_id,
    approverUserId: row.approved_by_user_id ?? "",
    requesterUserId: row.requested_by_user_id ?? "",
    policyVersion: row.approval_policy_version ?? "",
  };
}

/** The stored reversal under this provenance, if any (with what a replay compares). */
export async function findCreditReversalByProvenance(
  client: PoolClient,
  tenantId: string,
  body: Pick<CreditSaleReversalRequestDto, "sourceSystem" | "externalId">,
): Promise<ProvenanceHolders> {
  const r = await client.query<{ id: string | null; sale_id: string; payload_hash: string; ordinary_holds: boolean }>(
    `SELECT c.id, c.sale_id, c.payload_hash,
            (EXISTS (SELECT 1 FROM sale_voids v WHERE v.tenant_id = $1 AND v.source_system = $2 AND v.external_id = $3)
             OR EXISTS (SELECT 1 FROM sale_returns x WHERE x.tenant_id = $1 AND x.source_system = $2 AND x.external_id = $3))
              AS ordinary_holds
       FROM (SELECT 1) one
       LEFT JOIN sale_credit_reversals c
         ON c.tenant_id = $1 AND c.source_system = $2 AND c.external_id = $3`,
    [tenantId, body.sourceSystem, body.externalId],
  );
  const row = r.rows[0]!;
  const credit = row.id === null ? null : { id: row.id, sale_id: row.sale_id, payload_hash: row.payload_hash };
  return { credit, ordinaryHolds: row.ordinary_holds };
}

/** Who holds a provenance: a credit reversal (with what a replay compares), and/or an ordinary reversal. */
export interface ProvenanceHolders {
  readonly credit: { readonly id: string; readonly sale_id: string; readonly payload_hash: string } | null;
  readonly ordinaryHolds: boolean;
}
