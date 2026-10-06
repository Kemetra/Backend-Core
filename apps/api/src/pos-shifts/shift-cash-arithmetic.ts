/**
 * The closeShift arithmetic invariant (RT-17 slice 2b-2; contract
 * `pos-shifts.openapi.yaml` 1.1.0-draft, `CloseShiftRequest`), checked on
 * ingest in exact decimal:
 *
 *   expectedCash = openingFloat + cashSalesTotal − cashRefundsTotal + payInTotal − payOutTotal
 *   variance     = countedCash − expectedCash
 *
 * with `openingFloat` equal to the float recorded at open. A close that
 * breaks it is 422 `shift_cashup_inconsistent`; the totals are never
 * rewritten (Constitution §III). The database re-checks the same CHECKs.
 *
 * Amounts stay exact-decimal STRINGS on the wire (gate A.6); here each is
 * scaled to a BigInt of 10⁻⁴ units (the stored `numeric(19,4)` scale), never
 * a JS number.
 */
import { fitsCurrencyPrecision } from "./shift-money";

/** The eight amounts of a close, as exact-decimal strings. */
export interface CashUpTotals {
  readonly openingFloat: string;
  readonly cashSalesTotal: string;
  readonly cashRefundsTotal: string;
  readonly payInTotal: string;
  readonly payOutTotal: string;
  readonly expectedCash: string;
  readonly countedCash: string;
  readonly variance: string;
}

export const CASH_UP_AMOUNT_FIELDS: ReadonlyArray<keyof CashUpTotals> = [
  "openingFloat",
  "cashSalesTotal",
  "cashRefundsTotal",
  "payInTotal",
  "payOutTotal",
  "expectedCash",
  "countedCash",
  "variance",
];

/** The stored scale: every amount has at most 4 fractional digits. */
const SCALE = 4;

/** An exact-decimal string (optionally signed, ≤ 4 fractional digits) in 10⁻⁴ units. */
function scaled(amount: string): bigint {
  const negative = amount.startsWith("-");
  const [whole = "0", fraction = ""] = (negative ? amount.slice(1) : amount).split(".");
  const units = BigInt(whole + fraction.padEnd(SCALE, "0"));
  return negative ? -units : units;
}

/**
 * True iff the close's arithmetic holds and its `openingFloat` equals
 * `recordedFloat` (the shift's float, as stored).
 */
export function isCashUpConsistent(totals: CashUpTotals, recordedFloat: string): boolean {
  const t = Object.fromEntries(CASH_UP_AMOUNT_FIELDS.map((field) => [field, scaled(totals[field])])) as Record<
    keyof CashUpTotals,
    bigint
  >;
  const expected = t.openingFloat + t.cashSalesTotal - t.cashRefundsTotal + t.payInTotal - t.payOutTotal;
  return [
    t.openingFloat === scaled(recordedFloat),
    t.expectedCash === expected,
    t.variance === t.countedCash - t.expectedCash,
  ].every(Boolean);
}

/** A close's totals and the currency of the shift it closes. */
export interface CloseInCurrency {
  readonly totals: CashUpTotals;
  readonly currencyCode: string;
}

/** True iff every amount of the close fits the shift currency's minor unit (else 400). */
export function closeFitsCurrency(close: CloseInCurrency): boolean {
  return CASH_UP_AMOUNT_FIELDS.every((field) =>
    fitsCurrencyPrecision({ amount: close.totals[field].replace(/^-/, ""), currencyCode: close.currencyCode }),
  );
}
