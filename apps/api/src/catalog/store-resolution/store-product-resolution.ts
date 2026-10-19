/**
 * Tenant ⊕ Store Override resolution (003 §6.4), the one resolver behind the
 * POS read-down (`ReadDownService`) and the console catalog `storeView`
 * (RT-730, `console-catalog.yaml`). Both reads build their SQL from these
 * fragments so a product resolves to the same price, currency, tax category
 * and activity for a store on both surfaces (the parity test pins it).
 *
 * The fragments read the product as `tp` (`tenant_products`) and join the
 * store's ACTIVE override as `spo`. `store_product_overrides` is RLS'd by
 * tenant AND `app.current_store` (0008/0009/0011), so the caller pins the
 * store GUC first ({@link pinOverrideStore}); the join also carries the
 * explicit store predicate.
 */
import type { PoolClient } from "pg";

import { isRepresentable, normalizeAmount } from "../read-down/read-down.toBody";

/** A `$n` placeholder, optionally cast to uuid: the only store reference the fragments accept. */
const PLACEHOLDER = /^\$\d{1,2}(::uuid)?$/;

/** The columns the resolver adds to a row (all text / boolean, as Postgres returns them). */
export interface ResolvedStoreColumns {
  /** `numeric(19,4)::text`, or null when neither the override nor the product has a price. */
  readonly resolved_price: string | null;
  readonly resolved_currency: string | null;
  readonly resolved_tax_category: string;
  /** The override's `is_active` when set, else the product's. Retirement is separate. */
  readonly resolved_active: boolean;
  /** True when the store has an active override row for the product. */
  readonly has_override: boolean;
}

/** The resolved select-list over `tp` and `spo` (see {@link ResolvedStoreColumns}). */
export const RESOLVED_STORE_COLUMNS_SQL = `
        COALESCE(spo.price, tp.default_price)::text AS resolved_price,
        COALESCE(spo.currency_code, tp.default_currency_code) AS resolved_currency,
        COALESCE(spo.tax_category, tp.tax_category) AS resolved_tax_category,
        COALESCE(spo.is_active, tp.is_active) AS resolved_active,
        (spo.id IS NOT NULL) AS has_override`;

/** `LEFT JOIN` of `tp` to the active override of the store bound to `storeParam` (a `$n` placeholder). */
export function storeOverrideJoinSql(storeParam: string): string {
  if (!PLACEHOLDER.test(storeParam)) throw new Error(`store resolution: ${storeParam} is not a placeholder`);
  return `
      LEFT JOIN store_product_overrides spo
        ON spo.tenant_id = tp.tenant_id
       AND spo.store_id = ${storeParam}
       AND spo.product_id = tp.id
       AND spo.retired_at IS NULL`;
}

/**
 * Pin `app.current_store` to the one store being resolved, transaction-local,
 * so its override rows are visible to the join and no other store's are.
 */
export async function pinOverrideStore(client: PoolClient, storeId: string): Promise<void> {
  await client.query("SELECT set_config('app.current_store', $1, true)", [storeId]);
}

/** Drop trailing `0`s with a linear scan (a `/0+$/` regex backtracks quadratically, S8786). */
function stripTrailingZeros(digits: string): string {
  let end = digits.length;
  while (end > 0 && digits[end - 1] === "0") end--;
  return digits.slice(0, end);
}

/**
 * A stored `numeric(19,4)::text` amount on the wire, never rounded: at the
 * currency's natural minor precision when representable (exactly the
 * read-down's rendering), else with its significant fraction digits only
 * (`9.9990` EGP → `9.999`).
 */
export function storedAmount(amount: string, currencyCode: string): string {
  if (isRepresentable(amount, currencyCode)) return normalizeAmount(amount, currencyCode);
  const dot = amount.indexOf(".");
  return `${amount.slice(0, dot)}.${stripTrailingZeros(amount.slice(dot + 1))}`;
}
