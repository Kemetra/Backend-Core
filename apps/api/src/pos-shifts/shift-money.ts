/**
 * Shift cash-up money and time helpers (RT-17 slice 2b; contract
 * `pos-shifts.openapi.yaml` 1.1.0-draft, "Money").
 *
 * Amounts stay exact-decimal STRINGS end to end (gate A.6): nothing here
 * parses an amount into a JS number.
 *
 *   - Wire precision is strict (#711 review note 4): an amount may carry at
 *     most the currency's ISO-4217 minor-unit fractional digits, counted as
 *     written ("500.000" is refused for EGP even though it is numerically
 *     500.00). A currency with no ISO-4217 minor unit is refused outright.
 *   - Projections format each stored `numeric(19,4)` value to the currency's
 *     minor-unit digits ("500.0000" → "500.00"), so a replay echoes what the
 *     POS sent (#712 review note 4). The POS formats from integer minor
 *     units, so it always sends exactly that many digits.
 *   - Payload hashes use the same formatting, so "500" and "500.00" are the
 *     same fact.
 */
import { minorUnitExponent } from "../catalog/sales/iso4217-minor-units";

/** An exact-decimal amount (optionally signed) in an ISO-4217 currency. */
export interface Money {
  readonly amount: string;
  readonly currencyCode: string;
}

/** The fractional digits of the amount, as written. */
function fractionDigits(money: Money): number {
  const dot = money.amount.indexOf(".");
  return dot === -1 ? 0 : money.amount.length - dot - 1;
}

/**
 * The currency's minor-unit exponent; the stored scale (4) for a code with
 * none. Every recorded shift currency was validated to have one at open, so
 * 4 (lossless `numeric(19,4)`) only guards the type, never an assumed 2.
 */
function exponentOf(money: Money): number {
  return minorUnitExponent(money.currencyCode) ?? 4;
}

/**
 * True iff the currency has an ISO-4217 minor unit and the amount carries no
 * more fractional digits than it.
 */
export function fitsCurrencyPrecision(money: Money): boolean {
  return minorUnitExponent(money.currencyCode) !== null && fractionDigits(money) <= exponentOf(money);
}

/**
 * The amount with exactly the currency's minor-unit fractional digits and no
 * leading zeros ("500.0000" EGP → "500.00", "-5" EGP → "-5.00", "500.0000"
 * JPY → "500"). Only pads or drops ZERO digits: a non-zero digit beyond the
 * minor unit is a RangeError, never a silent truncation of money.
 */
export function formatMoney(money: Money): string {
  const exponent = exponentOf(money);
  const negative = money.amount.startsWith("-");
  const [intPart = "0", fraction = ""] = (negative ? money.amount.slice(1) : money.amount).split(".");
  if (/[1-9]/.test(fraction.slice(exponent))) {
    throw new RangeError("amount has more significant digits than the currency's minor unit");
  }
  const whole = BigInt(intPart).toString();
  const text = exponent === 0 ? whole : `${whole}.${fraction.padEnd(exponent, "0").slice(0, exponent)}`;
  return negative && /[1-9]/.test(text) ? `-${text}` : text;
}

/**
 * A canonical form of an RFC 3339 UTC instant (`...THH:MM:SS[.f+]Z`, as
 * `z.string().datetime()` admits) for payload hashing: epoch seconds plus the
 * fraction without trailing zeros, so "08:00:00Z" and "08:00:00.000Z" are the
 * same instant. Full precision, unlike Date.parse (milliseconds only).
 */
export function canonicalInstant(value: string): string {
  const match = /^(.*T\d{2}:\d{2}:\d{2})(?:\.(\d+))?Z$/.exec(value);
  const seconds = Date.parse(`${match?.[1] ?? value}Z`) / 1000;
  const fraction = (match?.[2] ?? "").replace(/0+$/, "");
  return fraction === "" ? `${seconds}` : `${seconds}.${fraction}`;
}
