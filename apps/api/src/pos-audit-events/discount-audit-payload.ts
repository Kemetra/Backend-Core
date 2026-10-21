/**
 * RT-740 DEP-2 (RT-699 doc 28 §6/§7, RT-608): the payload rule for
 * `cart.discount.manager_authorized`, the POS audit event written on every
 * manual line discount. Contract: `pos-audit-events.openapi.yaml` 1.1.0-draft.
 *
 * The key set is closed so no free text (a reason note, a name) can ride along:
 * the reason is a code from the RT-740 closed list only, and ids keep to the
 * POS bridge id alphabet. The magnitude fields
 * (`kind`, `value`, `amount_minor`) and `approver_role` are optional, because
 * events written before POS I1 (RT-608) do not carry them; when present they
 * must be well formed. Money here is the till's integer minor units.
 */
import { DISCOUNT_REASON_CODES } from "../catalog/sales/dto/capture-sale-request.dto";

const REASON_CODES = new Set<string>(DISCOUNT_REASON_CODES);

type FieldRule = (value: unknown) => boolean;

/** The POS bridge id alphabet (`[A-Za-z0-9_-]`, plus `:` and `.`): no spaces, no letters outside ASCII. */
const ID_RE = /^[A-Za-z0-9_:.-]{1,128}$/;
const isNonEmptyId: FieldRule = (v) => typeof v === "string" && ID_RE.test(v);
const isMinorUnits: FieldRule = (v) => Number.isSafeInteger(v) && (v as number) >= 0;

/** Every key the payload may hold, with its rule (a Map: no prototype keys). */
const FIELD_RULES: ReadonlyMap<string, FieldRule> = new Map<string, FieldRule>([
  ["cart_id", isNonEmptyId],
  ["cart_line_id", isNonEmptyId],
  ["placeholder_id", isNonEmptyId],
  ["approval_id", isNonEmptyId],
  ["reason_code", (v) => typeof v === "string" && REASON_CODES.has(v)],
  ["kind", (v) => v === "percent" || v === "amount"],
  ["value", (v) => isMinorUnits(v) && (v as number) >= 1],
  ["amount_minor", isMinorUnits],
  ["approver_role", (v) => v === "manager" || v === "admin"],
]);

const REQUIRED_KEYS = ["cart_id", "cart_line_id", "placeholder_id"] as const;

/**
 * The magnitude fields agree: a `value` needs its `kind`; a percent is a whole
 * 1–100 (OD-28-2); an amount discount's `value` is its `amount_minor`.
 */
function magnitudeConsistent(payload: Record<string, unknown>): boolean {
  const { kind, value, amount_minor: amountMinor } = payload;
  if (value === undefined) return true;
  if (kind === "percent") return (value as number) <= 100;
  if (kind === "amount") return amountMinor === undefined || value === amountMinor;
  return false;
}

/** True when `payload` is a well-formed `cart.discount.manager_authorized` payload. */
export function isDiscountAuthorizedPayload(payload: Record<string, unknown>): boolean {
  if (REQUIRED_KEYS.some((key) => payload[key] === undefined)) return false;
  for (const [key, value] of Object.entries(payload)) {
    // An unknown key has no rule and fails.
    if (!FIELD_RULES.get(key)?.(value)) return false;
  }
  return magnitudeConsistent(payload);
}
