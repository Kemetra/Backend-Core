/**
 * Wire projections of the RT-17 cash-up facts (`Shift`, `ShiftClose`,
 * `CashMovement` in `pos-shifts.openapi.yaml` 1.1.0-draft). Explicit shapes,
 * never DB rows (Constitution §IV): tenant, store and device ids, the
 * payload hash and the recording actor of a shift or close are never
 * returned.
 *
 * Amounts are formatted to the shift currency's minor-unit digits, so a
 * replay echoes what the POS sent ("500.0000" at rest → "500.00").
 */
import type {
  CashMovementKind,
  CashMovementReason,
  CashMovementRow,
  CashUpShiftRow,
  ShiftCloseKind,
  ShiftCloseRow,
} from "./shift-cash-up.repository";
import type { PolicyTriState } from "../cash-variance-policy/policy-value";
import { approverCheckOf, type ApproverCheck } from "./shift-close-approver";
import type { RecordedFrozenPolicy } from "./shift-frozen-policy";
import { formatMoney } from "./shift-money";

export interface ShiftCloseProjection {
  readonly closedAt: string;
  readonly closingUserId: string;
  readonly closeKind: ShiftCloseKind;
  readonly forcedReason?: string;
  readonly openingFloat: string;
  readonly cashSalesTotal: string;
  readonly cashRefundsTotal: string;
  readonly payInTotal: string;
  readonly payOutTotal: string;
  readonly expectedCash: string;
  readonly countedCash: string;
  readonly variance: string;
  readonly saleCount: number;
  readonly cashRefundReturnRefs: ReadonlyArray<string>;
  readonly varianceApprovedByUserId?: string;
  readonly receivedAt: string;
  /** RT-387: derived from the frozen policy (`unknown` without one) and the persisted verdict. */
  readonly approvalRequiredByPolicy: PolicyTriState;
  readonly approvalMissing: PolicyTriState;
  readonly approverCheck: ApproverCheck;
}

export interface ShiftProjection {
  readonly shiftId: string;
  readonly status: "open" | "closed";
  readonly currencyCode: string;
  readonly openingFloat: string;
  readonly openedAt: string;
  readonly openingUserId: string;
  readonly receivedAt: string;
  readonly close?: ShiftCloseProjection;
  /** RT-387: present exactly when the open carried a frozen policy. */
  readonly frozenPolicy?: RecordedFrozenPolicy;
}

export interface CashMovementProjection {
  readonly movementId: string;
  readonly shiftId: string;
  readonly kind: CashMovementKind;
  readonly amount: string;
  readonly currencyCode: string;
  readonly reasonCode: CashMovementReason;
  readonly note?: string;
  readonly occurredAt: string;
  readonly recordedByUserId: string;
  readonly receivedAt: string;
}

const CLOSE_AMOUNTS = [
  "openingFloat",
  "cashSalesTotal",
  "cashRefundsTotal",
  "payInTotal",
  "payOutTotal",
  "expectedCash",
  "countedCash",
  "variance",
] as const;

function closeProjection(close: ShiftCloseRow, currencyCode: string): ShiftCloseProjection {
  const amounts = Object.fromEntries(
    CLOSE_AMOUNTS.map((field) => [field, formatMoney({ amount: close[field], currencyCode })]),
  ) as Record<(typeof CLOSE_AMOUNTS)[number], string>;
  return {
    closedAt: close.closedAt.toISOString(),
    closingUserId: close.closingUserId,
    closeKind: close.closeKind,
    ...(close.forcedReason !== null ? { forcedReason: close.forcedReason } : {}),
    ...amounts,
    saleCount: close.saleCount,
    cashRefundReturnRefs: [...close.cashRefundReturnRefs],
    ...(close.varianceApprovedByUserId !== null
      ? { varianceApprovedByUserId: close.varianceApprovedByUserId }
      : {}),
    receivedAt: close.receivedAt.toISOString(),
    approvalRequiredByPolicy: close.approvalRequiredByPolicy ?? "unknown",
    approvalMissing: close.approvalMissing ?? "unknown",
    approverCheck: approverCheckOf(close.varianceApprovedByUserId, close.approverVerdict ?? null),
  };
}

/** The `Shift` projection; `close` is present exactly when the shift is closed. */
export function toShiftProjection(shift: CashUpShiftRow, close: ShiftCloseRow | null): ShiftProjection {
  return {
    ...(shift.frozenPolicy ? { frozenPolicy: shift.frozenPolicy } : {}),
    shiftId: shift.shiftId,
    status: shift.lifecycleState === "open" ? "open" : "closed",
    currencyCode: shift.currencyCode,
    openingFloat: formatMoney({ amount: shift.openingFloat, currencyCode: shift.currencyCode }),
    openedAt: shift.openedAt.toISOString(),
    openingUserId: shift.openingUserId,
    receivedAt: shift.receivedAt.toISOString(),
    ...(close !== null ? { close: closeProjection(close, shift.currencyCode) } : {}),
  };
}

/** The `CashMovement` projection; `note` only when one was recorded. */
export function toCashMovementProjection(movement: CashMovementRow): CashMovementProjection {
  return {
    movementId: movement.movementId,
    shiftId: movement.shiftId,
    kind: movement.kind,
    amount: formatMoney(movement),
    currencyCode: movement.currencyCode,
    reasonCode: movement.reasonCode,
    ...(movement.note !== null ? { note: movement.note } : {}),
    occurredAt: movement.occurredAt.toISOString(),
    recordedByUserId: movement.recordedByUserId,
    receivedAt: movement.receivedAt.toISOString(),
  };
}
