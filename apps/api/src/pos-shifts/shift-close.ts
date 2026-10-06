/**
 * closeShift helpers (RT-17 slice 2b-2; contract `pos-shifts.openapi.yaml`
 * 1.1.0-draft): the close's payload hash, the record handed to the
 * repository, and which errors mean "another close of this shift committed
 * first".
 */
import { createHash } from "node:crypto";

import { canonicalJson } from "../idempotency/canonical-json";
import { CASH_UP_AMOUNT_FIELDS } from "./shift-cash-arithmetic";
import type { CloseShiftFact } from "./shift-cash-up.dto";
import {
  ShiftCloseNotAppliedError,
  type CashUpShiftRow,
  type ShiftCloseFact,
  type ShiftLifecycleState,
} from "./shift-cash-up.repository";
import { canonicalInstant, formatMoney } from "./shift-money";

/**
 * sha256 of the canonical close: amounts at the shift currency's minor unit
 * and the instant in canonical form, so a respelled re-delivery is the same
 * fact; the path shift is part of it. The `operatorUserId` claim is not.
 * The caller has checked the precision, so formatting never throws.
 */
export function closeHash(shift: CashUpShiftRow, fact: CloseShiftFact): Buffer {
  const amounts = Object.fromEntries(
    CASH_UP_AMOUNT_FIELDS.map((field) => [field, formatMoney({ amount: fact[field], currencyCode: shift.currencyCode })]),
  );
  const canonical = {
    shiftId: shift.shiftId,
    closedAt: canonicalInstant(fact.closedAt),
    closingUserId: fact.closingUserId,
    closeKind: fact.closeKind,
    forcedReason: fact.forcedReason ?? null,
    ...amounts,
    saleCount: fact.saleCount,
    cashRefundReturnRefs: fact.cashRefundReturnRefs,
    varianceApprovedByUserId: fact.varianceApprovedByUserId ?? null,
  };
  return createHash("sha256").update(canonicalJson(canonical)).digest();
}

/** Who recorded a close and its payload hash. */
export interface CloseProvenance {
  readonly recordedByUserId: string;
  readonly payloadHash: Buffer;
}

/** The fact as the repository records it: verbatim, absent optionals as null. */
export function toCloseRecord(fact: CloseShiftFact, provenance: CloseProvenance): ShiftCloseFact {
  return {
    ...fact,
    forcedReason: fact.forcedReason ?? null,
    varianceApprovedByUserId: fact.varianceApprovedByUserId ?? null,
    recordedByUserId: provenance.recordedByUserId,
    payloadHash: provenance.payloadHash,
  };
}

/** The shift's state once `fact` closed it. */
export function closedShift(shift: CashUpShiftRow, fact: CloseShiftFact): CashUpShiftRow {
  const lifecycleState: ShiftLifecycleState = fact.closeKind === "forced" ? "closed_forced" : "closed";
  return { ...shift, lifecycleState };
}

/** A Postgres error's SQLSTATE and constraint, as far as `err` has them. */
function pgFields(err: unknown): { code?: unknown; constraint?: unknown } {
  return typeof err === "object" && err !== null ? (err as { code?: unknown; constraint?: unknown }) : {};
}

/**
 * True when the close did not apply because another close of the shift got
 * there first: the shift UPDATE moved no row, the close-only-while-open
 * trigger refused (55000), or the close's primary key was taken (23505 on
 * `shift_closes_pkey`).
 * Every write path locks the shift row first, so this is a backstop; the
 * caller re-reads and answers a replay or a conflict, or rethrows.
 */
export function isRacedClose(err: unknown): boolean {
  const { code, constraint } = pgFields(err);
  const closeTaken = code === "23505" && constraint === "shift_closes_pkey";
  return err instanceof ShiftCloseNotAppliedError || code === "55000" || closeTaken;
}

/**
 * True for a deadlock (40P01) or a serialization failure (40001): the
 * database rolled the whole transaction back and a fresh attempt may succeed.
 */
export function isTransactionConflict(err: unknown): boolean {
  const { code } = pgFields(err);
  return code === "40P01" || code === "40001";
}
