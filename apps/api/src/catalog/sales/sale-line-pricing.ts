/**
 * sale-line-pricing.ts — RT-105 (RT-87 decision D): the sale-line price
 * invariant `captureSale` enforces on a first capture.
 *
 * A line can be returned exactly only if `lineAmount = unitPrice × quantity`,
 * both money fields fit the currency's minor unit, and `quantity` is whole: the
 * Connector posts a return at the ORIGINAL rate × returned quantity, and ERPNext
 * keeps amounts at currency precision. Such a line prices to exactly
 * `unitPrice × q` under the RT-73 round4 return rule.
 *
 * RT-740 (sales.yaml 1.13.0-draft, RT-699 doc 28 option C-A): a line with a
 * manual `discount` carries its NET, so the condition becomes `lineAmount =
 * unitPrice × quantity − discount.amount`, and the discount's own arithmetic
 * must hold (percent: half up on the line gross, OD-28-3; amount: value =
 * amount). Without `discount` the rule is unchanged. Such a line no longer has
 * `lineAmount = unitPrice × quantity`, so the "returned exactly" guarantee above
 * holds only for undiscounted lines: the Connector cannot post a discounted line
 * until RT-699 DEP-3, and a partial return of a net that does not divide by the
 * quantity prices below the minor unit (an open owner decision).
 *
 * Exact decimal only (gate A.6): values are compared as scaled `bigint`, never
 * JS numbers. The DTO already bounds the inputs (money ≤ 4 fractional digits,
 * quantity ≤ 6), so the scales below are fixed. The minor unit is the line
 * currency's ISO-4217 exponent (0–4, never above MONEY_SCALE); a currency with
 * none cannot conform (Jira RT-105 comment 10537, gap 2).
 */
import { minorUnitExponent } from "./iso4217-minor-units";

export interface PricedLineDiscountInput {
  readonly kind: "percent" | "amount";
  readonly value: string;
  readonly amount: string;
}

export interface PricedLineInput {
  readonly unitPrice: string;
  readonly quantity: string;
  readonly lineAmount: string;
  readonly currencyCode: string;
  readonly discount?: PricedLineDiscountInput | undefined;
}

const MONEY_SCALE = 4;
const QUANTITY_SCALE = 6;
const WHOLE_PERCENT = /^(100|[1-9]\d?)$/;

/** A non-negative exact-decimal string as an integer scaled by 10^scale. */
function toScaled(value: string, scale: number): bigint {
  const [intPart, fracPart = ""] = value.split(".");
  return BigInt(intPart!) * 10n ** BigInt(scale) + BigInt(fracPart.padEnd(scale, "0"));
}

function isWhole(quantity: string): boolean {
  return toScaled(quantity, QUANTITY_SCALE) % 10n ** BigInt(QUANTITY_SCALE) === 0n;
}

/** True iff `amount` has no more significant fractional digits than `exponent`. */
function fitsMinorUnit(amount: string, exponent: number): boolean {
  return toScaled(amount, MONEY_SCALE) % 10n ** BigInt(MONEY_SCALE - exponent) === 0n;
}

/**
 * RT-740: the discount amount follows from its kind. `gross` is the line gross
 * at MONEY_SCALE (exact: the quantity is whole). Percent rounds half up to the
 * minor unit, once, on the line gross (OD-28-3).
 */
function discountAmountHolds(discount: PricedLineDiscountInput, gross: bigint, exponent: number): boolean {
  const amount = toScaled(discount.amount, MONEY_SCALE);
  if (discount.kind === "amount") return toScaled(discount.value, MONEY_SCALE) === amount;
  if (!WHOLE_PERCENT.test(discount.value)) return false;
  const minorUnit = 10n ** BigInt(MONEY_SCALE - exponent);
  const grossMinor = gross / minorUnit;
  return ((grossMinor * BigInt(discount.value) + 50n) / 100n) * minorUnit === amount;
}

function conforms(line: PricedLineInput): boolean {
  const exponent = minorUnitExponent(line.currencyCode);
  if (exponent === null) return false;
  if (!fitsMinorUnit(line.unitPrice, exponent)) return false;
  if (!fitsMinorUnit(line.lineAmount, exponent)) return false;
  if (!isWhole(line.quantity)) return false;
  const product = toScaled(line.unitPrice, MONEY_SCALE) * toScaled(line.quantity, QUANTITY_SCALE);
  const { discount } = line;
  if (discount === undefined) {
    return product === toScaled(line.lineAmount, MONEY_SCALE) * 10n ** BigInt(QUANTITY_SCALE);
  }
  if (!fitsMinorUnit(discount.amount, exponent)) return false;
  const gross = product / 10n ** BigInt(QUANTITY_SCALE);
  const net = toScaled(line.lineAmount, MONEY_SCALE) + toScaled(discount.amount, MONEY_SCALE);
  return net === gross && discountAmountHolds(discount, gross, exponent);
}

/** Index of the first line that breaks the invariant, or null when all conform. */
export function findLinePricingViolation(lines: ReadonlyArray<PricedLineInput>): number | null {
  const index = lines.findIndex((line) => !conforms(line));
  return index === -1 ? null : index;
}
