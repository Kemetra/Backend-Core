/**
 * sale-reversal.ts — what voids and returns share (Jira RT-73; RT-14 D2).
 *
 * Both reversal kinds serialize on the `sales` row lock taken by
 * `lockSaleForReversal`: a concurrent void / return on the same sale waits
 * there and then sees the winner's row, so exclusivity (at most one void, no
 * void after a return, no return after a void) and the per-line cumulative
 * limit hold without a race. `uq_sale_voids_one_per_sale` is the DB backstop.
 */
import type { PoolClient } from "pg";

import { SaleNotFoundError } from "./sale-errors";

/** A void / return conflicts with an existing reversal of the sale (D2) → 409 already_reversed. */
export class SaleAlreadyReversedError extends Error {
  constructor() {
    super("sale already reversed");
    this.name = "SaleAlreadyReversedError";
  }
}

/** Cumulative returned quantity would exceed the quantity sold → 409 over_return. */
export class ReturnOverReturnError extends Error {
  constructor() {
    super("return exceeds the returnable quantity");
    this.name = "ReturnOverReturnError";
  }
}

/** Refund tenders do not sum to the server-computed total (D3) → 422. */
export class ReturnTenderMismatchError extends Error {
  constructor() {
    super("refund tenders do not match the return total");
    this.name = "ReturnTenderMismatchError";
  }
}

/**
 * RT-105 (comment 10537 gap 1): a fractional return quantity on a line sold in
 * a whole quantity → 400. round4 prices such a return at other than
 * `unitPrice × q`, which ERPNext would reject after the refund was paid out.
 */
export class ReturnQuantityNotWholeError extends Error {
  constructor() {
    super("return quantity must be whole for a line sold in a whole quantity");
    this.name = "ReturnQuantityNotWholeError";
  }
}

/** A return names a line that is not a line of the sale → 400. */
export class ReturnLineInvalidError extends Error {
  constructor() {
    super("lineRef is not a line of this sale");
    this.name = "ReturnLineInvalidError";
  }
}

export interface LockedSale {
  readonly currencyCode: string;
  readonly timezone: string;
}

/**
 * Lock the sale row (FOR UPDATE OF s) within the caller's (tenant via RLS,
 * store via predicate) scope and return what a reversal needs. A sale outside
 * scope is a non-disclosing `SaleNotFoundError`.
 */
export async function lockSaleForReversal(
  client: PoolClient,
  saleRef: string,
  storeId: string,
): Promise<LockedSale> {
  const r = await client.query<{ currency_code: string; timezone: string }>(
    `SELECT s.currency_code, st.timezone
       FROM sales s JOIN stores st ON st.id = s.store_id
      WHERE s.id = $1 AND s.store_id = $2
        FOR UPDATE OF s`,
    [saleRef, storeId],
  );
  const row = r.rows[0];
  if (!row) throw new SaleNotFoundError();
  return { currencyCode: row.currency_code, timezone: row.timezone };
}

/** Whether the (locked) sale already has a void and/or any return. */
export async function readReversalState(
  client: PoolClient,
  saleRef: string,
): Promise<{ voided: boolean; returned: boolean }> {
  const r = await client.query<{ voided: boolean; returned: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM sale_voids WHERE sale_id = $1) AS voided,
            EXISTS (SELECT 1 FROM sale_returns WHERE sale_id = $1) AS returned`,
    [saleRef],
  );
  return r.rows[0] ?? { voided: false, returned: false };
}

/** Map the one-void-per-sale unique violation (the DB backstop) to a 409. */
export function mapOneVoidViolation(err: unknown): unknown {
  const pg = err as { code?: string; constraint?: string };
  if (pg.code === "23505" && pg.constraint === "uq_sale_voids_one_per_sale") {
    return new SaleAlreadyReversedError();
  }
  return err;
}
