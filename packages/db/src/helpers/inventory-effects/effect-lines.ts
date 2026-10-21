/**
 * Sale / void / return Inventory Effect lines — pure rules (Jira RT-427).
 *
 * No I/O. Decides, for one Retail business line, whether it gets an effect
 * and under which provenance key (RT-289 DC-1). The writer
 * (`sale-effects.ts`) reads the facts and applies the decision.
 *
 * Owner decision 2 (RT-427, 2026-10-21): an effect write never stalls the
 * sale or its ERP posting (731). A line that is not stock (no product, zero
 * quantity) writes no effect and no signal. A line whose effect cannot be
 * written exactly writes no effect and is reported as SKIPPED, with a bounded
 * reason, so the gap is observable (signal + structured log) and reconcilable:
 *   - unit_mismatch: the line's unit is not the product's established stocking
 *     unit at the store (the 0016 one-unit-per-product guard would refuse it);
 *   - quantity_precision: the quantity needs more than the 4 decimals of
 *     `stock_movements.quantity` (sale lines keep 6), so it cannot be stored
 *     without rounding (756);
 *   - tracked_product: a batch / serial product needs a tracking identity,
 *     which only tracked selling writes (RT-451, RT-50 G7-4).
 */

export const SKIPPED_EFFECT_REASONS = ["unit_mismatch", "quantity_precision", "tracked_product"] as const;
export type SkippedEffectReason = (typeof SKIPPED_EFFECT_REASONS)[number];

/** The Retail business events whose lines carry effects in RT-427. */
export type SaleEffectEvent = "sale" | "sale_void" | "sale_return";

/** What the writer knows about one line before writing its effect. */
export interface EffectLineFacts {
  readonly tenantProductRef: string | null;
  /** Exact decimal text as Postgres returns it (e.g. `"2.500000"`). */
  readonly quantity: string;
  readonly unit: string;
  /** `tenant_products.tracking_mode`; null for a line with no product. */
  readonly trackingMode: string | null;
  /** The unit the product's movements at this store already use, if any. */
  readonly establishedUnit: string | null;
}

export type EffectLineDecision =
  | { readonly kind: "write" }
  | { readonly kind: "ignore" }
  | { readonly kind: "skip"; readonly reason: SkippedEffectReason };

const ZERO_QUANTITY = /^-?0+(\.0+)?$/;
/** At most 4 significant decimals (trailing zeros beyond them are fine). */
const FITS_FOUR_DECIMALS = /^-?\d+(\.\d{0,4}0*)?$/;

/** Whether, and why not, one line gets an Inventory Effect. */
export function decideEffectLine(facts: EffectLineFacts): EffectLineDecision {
  if (facts.tenantProductRef === null || ZERO_QUANTITY.test(facts.quantity)) {
    return { kind: "ignore" };
  }
  if (facts.trackingMode !== null && facts.trackingMode !== "none") {
    return { kind: "skip", reason: "tracked_product" };
  }
  if (!FITS_FOUR_DECIMALS.test(facts.quantity)) {
    return { kind: "skip", reason: "quantity_precision" };
  }
  if (facts.establishedUnit !== null && facts.establishedUnit !== facts.unit) {
    return { kind: "skip", reason: "unit_mismatch" };
  }
  return { kind: "write" };
}

/** DC-1 provenance key of a sale line's effect. */
export function saleLineEffectKey(saleLineId: string): string {
  return `sale_line:${saleLineId}`;
}

/** DC-1 provenance key of a void's compensating effect for one sale line. */
export function voidEffectKey(voidId: string, saleLineId: string): string {
  return `void:${voidId}:${saleLineId}`;
}

/** DC-1 provenance key of a return line's effect. */
export function returnLineEffectKey(returnLineId: string): string {
  return `return_line:${returnLineId}`;
}
