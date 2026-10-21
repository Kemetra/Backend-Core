/**
 * sale-responsibilities.ts — RT-418: payer responsibilities on the sale fact
 * (contract RT-417, `pos-sales/sales.yaml` 1.10.0-draft; owner decisions R-1
 * and option A, 2026-10-16).
 *
 * A responsibility records who owes how much of a sale: part of the immutable
 * sale and of its payload hash. It is NOT a receivable (no balance, no state;
 * ERPNext owns A/R). Every check here runs on the capture transaction's
 * tenant-scoped client (RLS), after a replay has resolved, so a stored result
 * is never turned into a 403 or a 422. Throwing rolls the capture back.
 *
 * Refusals, in the contract's order (the caller runs them in this order):
 *   1. an envelope operator who is not an active owner / tenant_admin /
 *      store_manager with access to the store → 403
 *      `sale_responsibility_role_refused` (the RT-530 set, one body);
 *   2. the RT-224 device path → 422 `sale_responsibility_offline_refused`
 *      (credit is accepted only on the operatorAuthorization path);
 *   3. `sum(tenders) + sum(responsibilities) ≠ posTotal` → 422
 *      `sale_responsibility_mismatch` (exact Postgres numeric);
 *   (the line price invariant sits here, in the service)
 *   4. a payer that is unknown, of another tenant, of another store,
 *      suspended, or has no ERPNext Customer link (`external_ref` null or
 *      blank) → 422 `sale_responsibility_payer_invalid`, one body for every
 *      cause. The payer rows are locked FOR SHARE until commit, so a payer
 *      cannot be suspended between the check and the sale.
 *
 * `sales.responsibility_count` is written with the rows; a read that sees a
 * different number of rows throws rather than present a credit sale as cash.
 */
import type { PoolClient } from "pg";
import { newId } from "@data-pulse-2/shared";

import { standingFinding } from "../../pos-shifts/shift-close-approver";
import { ShiftStoreUserReader } from "../../pos-shifts/shift-store-user";
import type { SaleResponsibilityDto, SaleTenderDto } from "./dto/capture-sale-request.dto";

/** The envelope operator may not take a credit sale → 403. */
export class SaleResponsibilityRoleRefusedError extends Error {
  constructor() {
    super("credit sales need an owner, tenant admin or store manager");
    this.name = "SaleResponsibilityRoleRefusedError";
  }
}

/** Responsibilities on the RT-224 device path → 422. */
export class SaleResponsibilityOfflineRefusedError extends Error {
  constructor() {
    super("responsibilities are accepted only on the operator envelope path");
    this.name = "SaleResponsibilityOfflineRefusedError";
  }
}

/** Tenders + responsibilities do not sum to posTotal exactly → 422. */
export class SaleResponsibilityMismatchError extends Error {
  constructor() {
    super("tenders and responsibilities do not sum to posTotal");
    this.name = "SaleResponsibilityMismatchError";
  }
}

/** A responsibility names a payer that cannot be billed for this sale → 422. */
export class SaleResponsibilityPayerInvalidError extends Error {
  constructor() {
    super("a responsibility names a payer that cannot be billed for this sale");
    this.name = "SaleResponsibilityPayerInvalidError";
  }
}

/** A replay whose responsibilities differ from the stored ones → 409. */
export class SaleResponsibilityReplayConflictError extends Error {
  constructor() {
    super("sale provenance already captured with different responsibilities");
    this.name = "SaleResponsibilityReplayConflictError";
  }
}

/**
 * The visible `sale_responsibilities` rows differ from `sales.responsibility_count`:
 * a visibility fault (RLS or grant), not data. Thrown rather than answering a
 * credit sale as a cash or tender-unknown one (the RT-77 / RT-86 lesson).
 */
export class SaleResponsibilitiesNotVisibleError extends Error {
  constructor(saleId: string, expected: number, visible: number) {
    super(
      `sale ${saleId} recorded ${expected} responsibility(ies) but ${visible} are visible; refusing to answer without them (RT-418)`,
    );
    this.name = "SaleResponsibilitiesNotVisibleError";
  }
}

/** A stored responsibility as the sale projections read it. */
export interface SaleResponsibilityRow {
  readonly payer_ref: string;
  readonly amount: string;
  readonly sequence: number;
}

/** The contract `SaleResponsibility` wire shape (`pos-sales/sales.yaml`). */
export interface SaleResponsibilityProjection {
  readonly payerRef: string;
  readonly amount: string;
  readonly sequence: number;
}

interface SaleScope {
  readonly tenantId: string;
  readonly storeId: string;
}

const storeUsers = new ShiftStoreUserReader();

/**
 * Refusal 1: the envelope operator's CURRENT standing must be an active owner,
 * tenant_admin or store_manager with access to the sale's store (the RT-530
 * approver rule, reused).
 */
export async function assertCreditOperatorEligible(
  client: PoolClient,
  scope: SaleScope,
  operatorUserId: string,
): Promise<void> {
  const standing = await storeUsers.approverStanding(client, { scope, userId: operatorUserId });
  if (standingFinding(standing) !== null) throw new SaleResponsibilityRoleRefusedError();
}

/** Refusal 3: Σ tenders (absent = 0) + Σ responsibilities = posTotal, exactly. */
export async function assertResponsibilityCoverage(
  client: PoolClient,
  sale: {
    readonly tenders: ReadonlyArray<SaleTenderDto>;
    readonly responsibilities: ReadonlyArray<SaleResponsibilityDto>;
    readonly posTotal: string;
  },
): Promise<void> {
  const r = await client.query<{ covers: boolean }>(
    `SELECT (COALESCE((SELECT SUM(a) FROM unnest($1::numeric[]) a), 0)
             + (SELECT SUM(b) FROM unnest($2::numeric[]) b)) = $3::numeric AS covers`,
    [sale.tenders.map((t) => t.amount), sale.responsibilities.map((r) => r.amount), sale.posTotal],
  );
  if (r.rows[0]?.covers !== true) throw new SaleResponsibilityMismatchError();
}

/** The SQL placeholders (`$n`) a payer predicate binds the tenant and the store to. */
export interface PayerPredicateParams {
  readonly tenant: string;
  readonly store: string;
}

/** A `payer_account` row with a non-blank ERPNext Customer link (`external_ref`). */
export const PAYER_LINKED_SQL = "external_ref ~ '[^[:space:]]'";

/**
 * An active payer of this tenant (RLS, and matched explicitly) scoped to this
 * store or tenant-wide. Store scope is not in RLS, so it is a predicate here.
 */
export function payerInScopeSql(p: PayerPredicateParams): string {
  return `tenant_id = ${p.tenant} AND (store_id IS NULL OR store_id = ${p.store}) AND status = 'active'`;
}

/**
 * RT-802: THE payer predicate, the one implementation `captureSale`'s
 * refusal 4 and `posListChargeablePayers`' `chargeable` both evaluate, so the
 * till's advisory read and the capture check cannot drift apart: in scope
 * and linked.
 */
export function chargeablePayerSql(p: PayerPredicateParams): string {
  return `${payerInScopeSql(p)} AND ${PAYER_LINKED_SQL}`;
}

/**
 * Refusal 4: every payer passes `chargeablePayerSql` for the sale's tenant and
 * store. The rows are locked FOR SHARE until the capture commits.
 */
export async function assertResponsibilityPayersEligible(
  client: PoolClient,
  scope: SaleScope,
  responsibilities: ReadonlyArray<SaleResponsibilityDto>,
): Promise<void> {
  const payerIds = [...new Set(responsibilities.map((r) => r.payerRef.toLowerCase()))];
  const r = await client.query<{ id: string }>(
    `SELECT id::text AS id FROM payer_account
      WHERE id = ANY($1::uuid[])
        AND ${chargeablePayerSql({ tenant: "$2", store: "$3" })}
      FOR SHARE`,
    [payerIds, scope.tenantId, scope.storeId],
  );
  if (r.rows.length !== payerIds.length) throw new SaleResponsibilityPayerInvalidError();
}

/** Write the sale's responsibilities in its capture transaction. */
export async function insertResponsibilities(
  client: PoolClient,
  sale: SaleScope & { readonly saleId: string; readonly responsibilities: ReadonlyArray<SaleResponsibilityDto> },
): Promise<void> {
  const { responsibilities } = sale;
  await client.query(
    `INSERT INTO sale_responsibilities (id, tenant_id, store_id, sale_id, payer_id, amount, sequence)
     SELECT r.id, $1, $2, $3, r.payer_id, r.amount, r.sequence
       FROM unnest($4::uuid[], $5::uuid[], $6::numeric[], $7::smallint[]) AS r(id, payer_id, amount, sequence)`,
    [
      sale.tenantId,
      sale.storeId,
      sale.saleId,
      responsibilities.map(() => newId()),
      responsibilities.map((r) => r.payerRef),
      responsibilities.map((r) => r.amount),
      responsibilities.map((r) => r.sequence),
    ],
  );
}

/**
 * A provenance replay must carry the responsibilities that were recorded,
 * compared as a multiset of (payer, numeric amount, sequence), so "10" and
 * "10.0000" are the same. A different count settles it without a read.
 */
export async function assertSameResponsibilities(
  client: PoolClient,
  winner: { readonly id: string; readonly responsibility_count: number },
  responsibilities: ReadonlyArray<SaleResponsibilityDto>,
): Promise<void> {
  if (winner.responsibility_count !== responsibilities.length) throw new SaleResponsibilityReplayConflictError();
  if (responsibilities.length === 0) return;
  const r = await client.query<{ same: boolean }>(
    `WITH req AS (
       SELECT * FROM unnest($2::uuid[], $3::numeric[], $4::smallint[]) AS r(payer_id, amount, sequence)
     ), stored AS (
       SELECT payer_id, amount::numeric AS amount, sequence FROM sale_responsibilities WHERE sale_id = $1
     )
     SELECT NOT EXISTS (
       (SELECT payer_id, amount, sequence FROM req EXCEPT ALL SELECT payer_id, amount, sequence FROM stored)
       UNION ALL
       (SELECT payer_id, amount, sequence FROM stored EXCEPT ALL SELECT payer_id, amount, sequence FROM req)
     ) AS same`,
    [
      winner.id,
      responsibilities.map((x) => x.payerRef),
      responsibilities.map((x) => x.amount),
      responsibilities.map((x) => x.sequence),
    ],
  );
  if (r.rows[0]?.same !== true) throw new SaleResponsibilityReplayConflictError();
}

/**
 * The sale's responsibilities in `sequence` order. A sale without any never
 * touches the table; a visible count other than `expected` throws.
 */
export async function loadSaleResponsibilities(
  client: PoolClient,
  saleId: string,
  expected: number,
): Promise<SaleResponsibilityRow[]> {
  if (expected === 0) return [];
  const r = await client.query<SaleResponsibilityRow>(
    `SELECT payer_id::text AS payer_ref, amount::text AS amount, sequence
       FROM sale_responsibilities WHERE sale_id = $1 ORDER BY sequence`,
    [saleId],
  );
  if (r.rows.length !== expected) throw new SaleResponsibilitiesNotVisibleError(saleId, expected, r.rows.length);
  return r.rows;
}

/** `responsibilities` for the `Sale` projection, omitted when there are none. */
export function responsibilitiesField(
  rows: ReadonlyArray<SaleResponsibilityRow>,
): { responsibilities?: SaleResponsibilityProjection[] } {
  if (rows.length === 0) return {};
  return { responsibilities: rows.map((r) => ({ payerRef: r.payer_ref, amount: r.amount, sequence: r.sequence })) };
}
