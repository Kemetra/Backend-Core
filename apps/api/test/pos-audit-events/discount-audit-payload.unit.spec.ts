/**
 * RT-740 DEP-2 — the `cart.discount.manager_authorized` payload rule
 * (`pos-audit-events.openapi.yaml` 1.1.0-draft): a closed key set, a reason
 * code from the closed list (never free text), and optional magnitude fields
 * in the till's integer minor units, so RT-608 events written before POS I1
 * stay acceptable.
 */
import { DISCOUNT_REASON_CODES } from "../../src/catalog/sales/dto/capture-sale-request.dto";
import { isDiscountAuthorizedPayload } from "../../src/pos-audit-events/discount-audit-payload";
import { POS_AUDIT_ACTION_CATEGORIES } from "../../src/pos-audit-events/dto";
import { loadOpenApiContracts } from "../../src/openapi/loader";

/** The `pos-audit-events` contract's `AuditEventItem` schema. */
function auditEventItem(): { properties?: Record<string, { enum?: string[]; description?: string }> } | undefined {
  const doc = loadOpenApiContracts().find((c) => c.id === "pos-audit-events.openapi")?.document as
    | { components?: { schemas?: Record<string, { properties?: Record<string, { enum?: string[]; description?: string }> }> } }
    | undefined;
  return doc?.components?.schemas?.["AuditEventItem"];
}

/** The payload POS RT-608 emits today (cart-bridge `discountPlaceholdersAdd`). */
function rt608(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    cart_id: "cart-1",
    cart_line_id: "line-1",
    placeholder_id: "pos-pulse:0195b200-0000-7000-8000-000000000740",
    ...overrides,
  };
}

/** The payload after POS I1 (doc 28 §7): reason, kind, value, amount, role. */
function i1(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return rt608({
    approval_id: "0195b200-0000-7000-8000-000000000741",
    reason_code: "loyal_or_contract_customer",
    kind: "percent",
    value: 10,
    amount_minor: 900,
    approver_role: "manager",
    ...overrides,
  });
}

describe("RT-740 DEP-2 — catalogue", () => {
  it("appends cart.discount.manager_authorized to the closed catalogue", () => {
    expect(POS_AUDIT_ACTION_CATEGORIES).toContain("cart.discount.manager_authorized");
  });

  it("the contract enum and the runtime catalogue are the same list, in order", () => {
    expect(auditEventItem()?.properties?.["action_category"]?.enum).toEqual([...POS_AUDIT_ACTION_CATEGORIES]);
  });

  it("the contract names every reason code of the sales.yaml closed list", () => {
    const text = (auditEventItem()?.properties?.["payload"]?.description ?? "").replace(/\s+/g, " ");
    for (const code of DISCOUNT_REASON_CODES) expect(text).toContain(`\`${code}\``);
    expect(text).toContain("the key set is CLOSED");
  });
});

describe("RT-740 DEP-2 — accepted payloads", () => {
  it.each([
    ["an RT-608 manager-direct payload (ids only)", rt608()],
    ["an RT-608 cashier payload with its approval", rt608({ approval_id: "a-1", reason_code: "promotion" })],
    ["an I1 percent payload", i1()],
    ["an I1 amount payload", i1({ kind: "amount", value: 500, amount_minor: 500 })],
    ["a 100% payload", i1({ value: 100, amount_minor: 9000 })],
    ["a percent that rounds to nothing", i1({ value: 1, amount_minor: 0 })],
    ["an admin approver", i1({ approver_role: "admin" })],
  ])("%s", (_name, payload) => {
    expect(isDiscountAuthorizedPayload(payload)).toBe(true);
  });
});

describe("RT-740 DEP-2 — refused payloads (schema_violation)", () => {
  it.each(["cart_id", "cart_line_id", "placeholder_id"])("a missing %s", (key) => {
    const payload = rt608();
    delete payload[key];
    expect(isDiscountAuthorizedPayload(payload)).toBe(false);
  });

  it.each([
    ["a free-text reason", i1({ reason_code: "customer is a friend of Ahmed" })],
    ["a reason outside the closed list", i1({ reason_code: "loyal_customer" })],
    ["a reason note (free text)", i1({ reason_note: "regular since 2019" })],
    ["an approver name", i1({ approver_name: "Mona" })],
    ["an unknown key", i1({ customer_phone: "0100" })],
    ["a prototype key", { ...i1(), constructor: "x" }],
    ["an unknown kind", i1({ kind: "fixed" })],
    ["a percent above 100", i1({ value: 101 })],
    ["a zero value", i1({ value: 0 })],
    ["a fractional value", i1({ value: 10.5 })],
    ["a string value", i1({ value: "10" })],
    ["a negative amount", i1({ amount_minor: -1 })],
    ["a fractional amount", i1({ amount_minor: 9.5 })],
    ["an unsafe integer amount", i1({ amount_minor: Number.MAX_SAFE_INTEGER + 1 })],
    ["a cashier approver role", i1({ approver_role: "cashier" })],
    ["an empty id", rt608({ cart_id: "" })],
    ["an over-long id", rt608({ placeholder_id: "x".repeat(129) })],
    ["a non-string id", rt608({ cart_line_id: 7 })],
  ])("%s", (_name, payload) => {
    expect(isDiscountAuthorizedPayload(payload as Record<string, unknown>)).toBe(false);
  });
});
