/**
 * RT-383 — pure helpers of the admin shift-close reads
 * (`shift-closes.openapi.yaml`): the keyset cursor and the wire projections.
 * No DB, no clock.
 *
 * Cursor. Repo convention (`negative-on-hand.projection.ts`, the 010
 * read-down cursor): unsigned base64url JSON, bound to the operation and the
 * tenant it was issued under; any other token is a 400. It carries only the
 * keyset position, the last row's `closed_at` and `shift_id`. `closed_at` is
 * carried as Postgres renders it at full (microsecond) precision, never through
 * a JS Date, so two closes in the same millisecond keep their order and the
 * walk never skips or repeats one. A hand-built token can only reposition the
 * keyset inside rows the caller may already read: scope and RLS are applied to
 * the query, never taken from the cursor.
 *
 * Projections. Explicit wire shapes, never DB rows (§IV): no tenant id, device
 * id or payload hash. Every key is present; an unrecorded value is `null`.
 * Amounts are the stored `numeric(19,4)` text formatted to the close
 * currency's minor-unit digits (`formatMoney`, as the POS shift projections
 * do): only zero digits are dropped, never a significant one.
 */
import { z } from "zod";

import type { PolicyTriState } from "../cash-variance-policy/policy-value";
import { approverCheckOf, type ApproverCheck } from "../pos-shifts/shift-close-approver";
import {
  toRecordedFrozenPolicy,
  type FrozenPolicyDbColumns,
  type RecordedFrozenPolicy,
} from "../pos-shifts/shift-frozen-policy";
import { formatMoney } from "../pos-shifts/shift-money";

// ---------------------------------------------------------------------------
// Cursor
// ---------------------------------------------------------------------------

/** Raised for a cursor this operation did not issue → 400 validation_error. */
export class InvalidShiftCloseCursorError extends Error {
  constructor() {
    super("cursor is not a valid continuation token for this operation");
    this.name = "InvalidShiftCloseCursorError";
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** `closed_at` as rendered by `CLOSED_AT_KEY_SQL`: UTC, exactly six fractional digits. */
const CLOSED_AT_KEY_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

/**
 * Renders `closed_at` as the cursor key: UTC with microseconds, so the cast
 * back (`$n::timestamptz`) is the exact stored instant.
 */
export const CLOSED_AT_KEY_SQL = `to_char(c.closed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const CursorSchema = z
  .object({
    k: z.literal("shift_closes"),
    t: z.string().regex(UUID_RE),
    c: z.string().regex(CLOSED_AT_KEY_RE),
    s: z.string().regex(UUID_RE),
  })
  .strict();

/** The keyset position after which the next page starts. */
export interface ShiftCloseKeyset {
  /** `closed_at` at microsecond precision (`CLOSED_AT_KEY_RE`). */
  readonly closedAtKey: string;
  readonly shiftId: string;
}

export function encodeShiftCloseCursor(input: { readonly tenantId: string } & ShiftCloseKeyset): string {
  const payload = { k: "shift_closes", t: input.tenantId.toLowerCase(), c: input.closedAtKey, s: input.shiftId };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

/** The keyset position, if `cursor` was issued by this operation for `tenantId`. */
export function decodeShiftCloseCursor(input: { readonly tenantId: string; readonly cursor: string }): ShiftCloseKeyset {
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8"));
  } catch {
    throw new InvalidShiftCloseCursorError();
  }
  const parsed = CursorSchema.safeParse(raw);
  if (!parsed.success || parsed.data.t !== input.tenantId.toLowerCase()) {
    throw new InvalidShiftCloseCursorError();
  }
  if (!isCalendarInstant(parsed.data.c)) throw new InvalidShiftCloseCursorError();
  return { closedAtKey: parsed.data.c, shiftId: parsed.data.s };
}

/**
 * True when the key names a real UTC instant. `Date.parse` rolls an
 * out-of-range day over ("02-31" → "03-03") where Postgres refuses the cast,
 * so the date and time are checked to survive the round trip unchanged.
 */
function isCalendarInstant(key: string): boolean {
  const ms = Date.parse(key);
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 19) === key.slice(0, 19);
}

// ---------------------------------------------------------------------------
// Rows read by the service (amounts as `numeric::text`)
// ---------------------------------------------------------------------------

export type ShiftCloseKind = "normal" | "forced";

/**
 * One `shift_closes` row as the list and the detail read it, with the shift's
 * frozen policy (RT-387, through the 1:1 shift join) and the persisted
 * approver verdict (null when none was recorded).
 */
export interface ShiftCloseReadRow extends FrozenPolicyDbColumns {
  readonly shift_id: string;
  readonly store_id: string;
  readonly currency_code: string;
  readonly closed_at: Date;
  readonly closed_at_key: string;
  readonly close_kind: ShiftCloseKind;
  readonly forced_reason: string | null;
  readonly closing_user_id: string;
  readonly variance_approved_by_user_id: string | null;
  readonly opening_float: string;
  readonly cash_sales_total: string;
  readonly cash_refunds_total: string;
  readonly pay_in_total: string;
  readonly pay_out_total: string;
  readonly expected_cash: string;
  readonly counted_cash: string;
  readonly variance: string;
  readonly sale_count: number;
  readonly received_at: Date;
  readonly approval_required_by_policy: PolicyTriState;
  readonly approval_missing: PolicyTriState;
  readonly verdict_status: string | null;
  readonly verdict_reason: string | null;
}

/** The detail adds the shift's opening and the recording actor. */
export interface ShiftCloseDetailRow extends ShiftCloseReadRow {
  readonly opened_at: Date;
  readonly opening_user_id: string;
  readonly recorded_by_user_id: string;
}

export interface ShiftCashMovementReadRow {
  readonly id: string;
  readonly kind: "pay_in" | "pay_out";
  readonly amount: string;
  readonly reason_code: "bank_drop" | "float_top_up" | "petty_expense" | "other";
  readonly note: string | null;
  readonly occurred_at: Date;
  readonly recorded_by_user_id: string;
  readonly received_at: Date;
}

// ---------------------------------------------------------------------------
// Wire shapes (contract: ShiftCloseSummary / ShiftClosePage / ShiftCloseDetail)
// ---------------------------------------------------------------------------

export interface ShiftCloseSummary {
  readonly shiftId: string;
  readonly storeId: string;
  readonly currencyCode: string;
  readonly closedAt: string;
  readonly closeKind: ShiftCloseKind;
  readonly forcedReason: string | null;
  readonly closingUserId: string;
  readonly varianceApprovedByUserId: string | null;
  readonly openingFloat: string;
  readonly cashSalesTotal: string;
  readonly cashRefundsTotal: string;
  readonly payInTotal: string;
  readonly payOutTotal: string;
  readonly expectedCash: string;
  readonly countedCash: string;
  readonly variance: string;
  readonly saleCount: number;
  readonly receivedAt: string;
  /** RT-384 / RT-387: null when the open carried no frozen policy. */
  readonly frozenPolicy: RecordedFrozenPolicy | null;
  readonly approvalRequiredByPolicy: PolicyTriState;
  readonly approvalMissing: PolicyTriState;
  readonly approverCheck: ApproverCheck;
}

export interface ShiftClosePage {
  readonly items: readonly ShiftCloseSummary[];
  readonly nextCursor: string | null;
}

export interface ShiftCashMovement {
  readonly movementId: string;
  readonly kind: "pay_in" | "pay_out";
  readonly amount: string;
  readonly reasonCode: "bank_drop" | "float_top_up" | "petty_expense" | "other";
  readonly note: string | null;
  readonly occurredAt: string;
  readonly recordedByUserId: string;
  readonly receivedAt: string;
}

export interface ShiftCloseDetail extends ShiftCloseSummary {
  readonly openedAt: string;
  readonly openingUserId: string;
  readonly recordedByUserId: string;
  readonly cashRefundReturnRefs: readonly string[];
  readonly cashMovements: readonly ShiftCashMovement[];
}

function money(amount: string, currencyCode: string): string {
  return formatMoney({ amount, currencyCode });
}

/** The `ShiftCloseSummary` of a recorded close. */
export function toShiftCloseSummary(row: ShiftCloseReadRow): ShiftCloseSummary {
  const currency = row.currency_code;
  return {
    shiftId: row.shift_id,
    storeId: row.store_id,
    currencyCode: currency,
    closedAt: row.closed_at.toISOString(),
    closeKind: row.close_kind,
    forcedReason: row.forced_reason,
    closingUserId: row.closing_user_id,
    varianceApprovedByUserId: row.variance_approved_by_user_id,
    openingFloat: money(row.opening_float, currency),
    cashSalesTotal: money(row.cash_sales_total, currency),
    cashRefundsTotal: money(row.cash_refunds_total, currency),
    payInTotal: money(row.pay_in_total, currency),
    payOutTotal: money(row.pay_out_total, currency),
    expectedCash: money(row.expected_cash, currency),
    countedCash: money(row.counted_cash, currency),
    variance: money(row.variance, currency),
    saleCount: row.sale_count,
    receivedAt: row.received_at.toISOString(),
    frozenPolicy: toRecordedFrozenPolicy(row),
    approvalRequiredByPolicy: row.approval_required_by_policy,
    approvalMissing: row.approval_missing,
    approverCheck: approverCheckOf(
      row.variance_approved_by_user_id,
      row.verdict_status === null ? null : { status: row.verdict_status, reason: row.verdict_reason },
    ),
  };
}

/** A movement in the close's currency (the shift's; the composite FK pins it). */
export function toShiftCashMovement(row: ShiftCashMovementReadRow, currencyCode: string): ShiftCashMovement {
  return {
    movementId: row.id,
    kind: row.kind,
    amount: money(row.amount, currencyCode),
    reasonCode: row.reason_code,
    note: row.note,
    occurredAt: row.occurred_at.toISOString(),
    recordedByUserId: row.recorded_by_user_id,
    receivedAt: row.received_at.toISOString(),
  };
}

/** The `ShiftCloseDetail`: the summary, the opening, the movements and the claimed returns. */
export function toShiftCloseDetail(input: {
  readonly row: ShiftCloseDetailRow;
  readonly movements: readonly ShiftCashMovementReadRow[];
  readonly refundReturnRefs: readonly string[];
}): ShiftCloseDetail {
  const { row } = input;
  return {
    ...toShiftCloseSummary(row),
    openedAt: row.opened_at.toISOString(),
    openingUserId: row.opening_user_id,
    recordedByUserId: row.recorded_by_user_id,
    cashRefundReturnRefs: [...input.refundReturnRefs],
    cashMovements: input.movements.map((m) => toShiftCashMovement(m, row.currency_code)),
  };
}
