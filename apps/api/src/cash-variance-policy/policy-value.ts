/**
 * The shift variance policy value (AD-CASH-001 D-1; RT-387 on the RT-385
 * schema, contract `cash-variance-policy.openapi.yaml` 1.0.0-draft).
 *
 * `none`: the cashier always closes alone. `limit`: approval is required
 * exactly when `|variance| > limitAmount`. Amounts stay exact-decimal strings
 * and are compared as BigInt units at the stored `numeric(19,4)` scale, never
 * as JS numbers, so this agrees with the 0050 close guard (`abs(variance) >
 * frozen_policy_limit_amount`) on every input the API accepts. The currency
 * of a limit is NOT compared here, as the contract and the guard state it: a
 * limit frozen in another currency was flagged `policy_value_mismatch` at
 * open and is evaluated as frozen.
 */
import { minorUnitExponent } from "../catalog/sales/iso4217-minor-units";
import { scaled } from "../pos-shifts/shift-cash-arithmetic";
import { formatMoney } from "../pos-shifts/shift-money";

export type PolicyValue =
  | { readonly mode: "none" }
  | { readonly mode: "limit"; readonly limitAmount: string; readonly currencyCode: string };

/** The never-set System default (DR-2): a Backend-Core constant, not a revision. */
export const SYSTEM_DEFAULT: PolicyValue = Object.freeze({ mode: "none" });

/** The DR-4 maximum horizon (coordinator decision 1), in days and in elapsed hours. */
export const PERMANENT_HORIZON_DAYS = 90;
export const PERMANENT_HORIZON_HOURS = PERMANENT_HORIZON_DAYS * 24;

/** V1 accepts only EGP for a published limit (K-5, coordinator decision 5). */
export const SUPPORTED_POLICY_CURRENCIES: ReadonlySet<string> = new Set(["EGP"]);

export type PolicyTriState = "yes" | "no" | "unknown";

/** True exactly when `value` is a limit and `|variance| > limitAmount` (D-1). */
export function approvalRequiredBy(value: PolicyValue, variance: string): boolean {
  if (value.mode !== "limit") return false;
  const units = scaled(variance);
  const magnitude = units < 0n ? -units : units;
  return magnitude > scaled(value.limitAmount);
}

/** The close's derived pair (D-7), the rule the 0050 close guard enforces. */
export interface CloseApproval {
  readonly approvalRequiredByPolicy: PolicyTriState;
  readonly approvalMissing: PolicyTriState;
}

export function deriveCloseApproval(input: {
  readonly frozen: PolicyValue | null;
  readonly variance: string;
  readonly approverUserId: string | null;
}): CloseApproval {
  if (input.frozen === null) return { approvalRequiredByPolicy: "unknown", approvalMissing: "unknown" };
  if (!approvalRequiredBy(input.frozen, input.variance)) {
    return { approvalRequiredByPolicy: "no", approvalMissing: "no" };
  }
  return { approvalRequiredByPolicy: "yes", approvalMissing: input.approverUserId === null ? "yes" : "no" };
}

/**
 * Positive when `a` is stricter than `b`, negative when looser, 0 when
 * equally strict (D-2): `none` is the loosest, any `limit` is stricter than
 * `none`, a lower `limitAmount` is stricter than a higher one.
 */
export function compareStrictness(a: PolicyValue, b: PolicyValue): number {
  if (a.mode === "none" || b.mode === "none") return (a.mode === "limit" ? 1 : 0) - (b.mode === "limit" ? 1 : 0);
  const diff = scaled(b.limitAmount) - scaled(a.limitAmount);
  return diff === 0n ? 0 : diff > 0n ? 1 : -1;
}

/** True when two values are the same policy (numerically equal limit, same currency). */
export function samePolicyValue(a: PolicyValue, b: PolicyValue): boolean {
  if (a.mode === "none" || b.mode === "none") return a.mode === b.mode;
  return a.currencyCode === b.currencyCode && scaled(a.limitAmount) === scaled(b.limitAmount);
}

/** A value as the database stores it (all null for `none`). */
export interface StoredPolicyValue {
  readonly mode: string;
  readonly limitAmount: string | null;
  readonly currencyCode: string | null;
}

/**
 * The wire value of a stored one: a limit at the currency's minor-unit digits
 * (`formatMoney`), or, for a currency with no minor unit or an amount finer
 * than it (an accepted frozen value), the stored text without trailing zeros.
 */
export function renderPolicyValue(stored: StoredPolicyValue): PolicyValue {
  if (stored.mode !== "limit" || stored.limitAmount === null || stored.currencyCode === null) return { mode: "none" };
  return { mode: "limit", limitAmount: renderAmount(stored.limitAmount, stored.currencyCode), currencyCode: stored.currencyCode };
}

/** An exact-decimal amount in its canonical form for `currencyCode` (see `renderPolicyValue`). */
export function renderAmount(amount: string, currencyCode: string): string {
  if (minorUnitExponent(currencyCode) !== null) {
    try {
      return formatMoney({ amount, currencyCode });
    } catch {
      // Finer than the minor unit: rendered verbatim below.
    }
  }
  return trimDecimal(amount);
}

/** "007.5000" → "7.5", "10.0000" → "10": no leading zeros, no trailing fractional zeros. */
function trimDecimal(amount: string): string {
  const [whole = "0", fraction = ""] = amount.split(".");
  let end = fraction.length;
  while (end > 0 && fraction[end - 1] === "0") end--;
  const trimmed = fraction.slice(0, end);
  const integer = BigInt(whole).toString();
  return trimmed === "" ? integer : `${integer}.${trimmed}`;
}
