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
 * Exact decimal only (gate A.6): values are compared as scaled `bigint`, never
 * JS numbers. The DTO already bounds the inputs (money ≤ 4 fractional digits,
 * quantity ≤ 6), so the scales below are fixed.
 */
import { isRepresentable } from "../read-down/read-down.toBody";

export interface PricedLineInput {
  readonly unitPrice: string;
  readonly quantity: string;
  readonly lineAmount: string;
  readonly currencyCode: string;
}

const MONEY_SCALE = 4;
const QUANTITY_SCALE = 6;

/** A non-negative exact-decimal string as an integer scaled by 10^scale. */
function toScaled(value: string, scale: number): bigint {
  const [intPart, fracPart = ""] = value.split(".");
  return BigInt(intPart!) * 10n ** BigInt(scale) + BigInt(fracPart.padEnd(scale, "0"));
}

function isWhole(quantity: string): boolean {
  return toScaled(quantity, QUANTITY_SCALE) % 10n ** BigInt(QUANTITY_SCALE) === 0n;
}

function conforms(line: PricedLineInput): boolean {
  if (!isRepresentable(line.unitPrice, line.currencyCode)) return false;
  if (!isRepresentable(line.lineAmount, line.currencyCode)) return false;
  if (!isWhole(line.quantity)) return false;
  const product = toScaled(line.unitPrice, MONEY_SCALE) * toScaled(line.quantity, QUANTITY_SCALE);
  return product === toScaled(line.lineAmount, MONEY_SCALE) * 10n ** BigInt(QUANTITY_SCALE);
}

/** Index of the first line that breaks the invariant, or null when all conform. */
export function findLinePricingViolation(lines: ReadonlyArray<PricedLineInput>): number | null {
  const index = lines.findIndex((line) => !conforms(line));
  return index === -1 ? null : index;
}
