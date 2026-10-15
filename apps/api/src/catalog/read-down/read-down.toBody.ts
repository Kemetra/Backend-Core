/**
 * read-down.toBody — explicit wire-shape projection for 010 (§IV).
 *
 * Maps a resolved catalogue row (the Tenant ⊕ Store Override merge computed in
 * the service) to the contract `SellableCatalogRow` shape — NEVER a raw DB
 * entity. Real-schema-backed fields only (R-1/Option B): product_id, sku, name,
 * aliases[], price{amount,currency_code}, tax_category, active, row_cursor.
 *
 * Money is the exact-decimal `DecimalAmount` STRING at the currency's natural
 * minor precision (gate A.6 — never a float). The representability filter (R5)
 * runs in the service BEFORE projection, so a projected row is always
 * representable; `isRepresentable` is exported here as the single source of the
 * minor-unit rule the service applies.
 */

/** The resolved row the service hands to the projection (already sellable). */
export interface ResolvedCatalogRow {
  readonly product_id: string;
  readonly sku: string;
  readonly name: string;
  readonly aliases: ReadonlyArray<string>;
  readonly amount: string; // resolved DecimalAmount string
  readonly currency_code: string; // ISO-4217
  readonly tax_category: string;
  /** Per-row change-log sequence (≤ the response cursor), or null if none. */
  readonly row_sequence: string | null;
}

/** The contract wire shape (catalog/read-down.yaml → SellableCatalogRow). */
export interface SellableCatalogRow {
  readonly product_id: string;
  readonly sku: string;
  readonly name: string;
  readonly aliases: ReadonlyArray<string>;
  readonly price: { readonly amount: string; readonly currency_code: string };
  readonly tax_category: string;
  readonly active: boolean;
  readonly row_cursor: string;
}

/**
 * ISO-4217 minor-unit exponents for the currencies the platform serves. A
 * resolved price is representable iff its fractional-digit count does not exceed
 * the currency's minor unit. Default = 2 for any currency not listed (the
 * common case); 0-minor (JPY-class) currencies tighten the rule.
 *
 * This is the single greenfield minor-unit map US1 introduces (no prior map
 * existed). `9.999` in EGP (2dp) is non-representable under any sane rule.
 */
const MINOR_UNIT_EXPONENT: Readonly<Record<string, number>> = Object.freeze({
  EGP: 2,
  USD: 2,
  EUR: 2,
  GBP: 2,
  SAR: 2,
  AED: 2,
  JPY: 0,
  KWD: 3,
  BHD: 3,
});

/** Default minor-unit exponent when a currency is not in the map. */
const DEFAULT_MINOR_UNIT = 2;

/** Drop trailing `0`s with a linear scan (a `/0+$/` regex backtracks quadratically, S8786). */
function stripTrailingZeros(digits: string): string {
  let end = digits.length;
  while (end > 0 && digits[end - 1] === "0") end--;
  return digits.slice(0, end);
}

/** Count of SIGNIFICANT fractional digits (trailing zeros stripped). */
function significantFractionDigits(amount: string): number {
  const dot = amount.indexOf(".");
  if (dot === -1) return 0;
  // Strip trailing zeros from the fractional part — `numeric(19,4)::text`
  // renders `8.50` as `8.5000`, which is 2 SIGNIFICANT fractional digits, not 4.
  const frac = stripTrailingZeros(amount.slice(dot + 1));
  return frac.length;
}

/**
 * True iff `amount` (a DecimalAmount string) is representable in `currencyCode`'s
 * minor unit — i.e. it has no more SIGNIFICANT fractional digits than the
 * currency allows. `numeric(19,4)` trailing zeros do NOT count (8.5000 in EGP =
 * representable; 9.999 in EGP = not).
 */
export function isRepresentable(amount: string, currencyCode: string): boolean {
  const allowed = MINOR_UNIT_EXPONENT[currencyCode] ?? DEFAULT_MINOR_UNIT;
  return significantFractionDigits(amount) <= allowed;
}

/**
 * Normalize a resolved `numeric(19,4)::text` amount to the currency's NATURAL
 * minor precision (R4 / data-model §1) — pure string work, NEVER a float
 * (gate A.6). EGP (2 minor): `8.5000`→`8.50`, `9.9900`→`9.99`, `9.0000`→`9.00`;
 * JPY (0 minor): `100.0000`→`100`. Representability is guaranteed by the
 * caller's filter, so no significant digit is ever dropped.
 */
function normalizeAmount(amount: string, currencyCode: string): string {
  const exp = MINOR_UNIT_EXPONENT[currencyCode] ?? DEFAULT_MINOR_UNIT;
  const neg = amount.startsWith("-");
  const unsigned = neg ? amount.slice(1) : amount;
  const dot = unsigned.indexOf(".");
  const intPart = dot === -1 ? unsigned : unsigned.slice(0, dot);
  const fracRaw = dot === -1 ? "" : unsigned.slice(dot + 1);
  let result: string;
  if (exp === 0) {
    result = intPart; // no minor unit (JPY-class)
  } else {
    const frac = (fracRaw + "0".repeat(exp)).slice(0, exp); // pad/truncate to exp
    result = `${intPart}.${frac}`;
  }
  return neg && result !== "0" && !/^0(\.0+)?$/.test(result) ? `-${result}` : result;
}

/**
 * Project a resolved sellable row + the snapshot cursor into the wire shape.
 * `row_cursor` is the per-row change cursor when known, else the response
 * cursor (a row with no change-log entry yet is ≤ the head by definition).
 */
export function toSellableRow(
  row: ResolvedCatalogRow,
  responseCursor: string,
): SellableCatalogRow {
  return {
    product_id: row.product_id,
    sku: row.sku,
    name: row.name,
    aliases: [...row.aliases],
    // Emit at the currency's natural minor precision (R4 / data-model §1) so the
    // consumer never rejects a representable amount over trailing-zero noise.
    price: {
      amount: normalizeAmount(row.amount, row.currency_code),
      currency_code: row.currency_code,
    },
    tax_category: row.tax_category,
    active: true, // a sellable row is always active (explicit for consumer clarity)
    row_cursor: row.row_sequence
      ? encodeRowCursor(row.row_sequence)
      : responseCursor,
  };
}

/** Opaque per-row token — base64url of the row's change-log sequence string. */
function encodeRowCursor(sequence: string): string {
  return Buffer.from(`r:${sequence}`, "utf8").toString("base64url");
}
