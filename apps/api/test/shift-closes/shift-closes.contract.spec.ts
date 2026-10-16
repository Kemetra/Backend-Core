/**
 * apps/api/test/shift-closes/shift-closes.contract.spec.ts
 *
 * RT-383 (AD-CASH-001 follow-up 4): the admin-facing shift-close read
 * contract that Admin-Console RT-18 consumes. `[GATED]` contract, approved by
 * the owner on RT-383 (PR #737); the runtime is RT-383's implementation
 * (`shift-closes.http.integration.spec.ts` covers it over HTTP).
 *
 * Structural / load-only, plus AJV fixtures against the contract schemas. No
 * app boot and no HTTP. What this pins:
 *
 *   1. Two GET operations at their paths, both implemented (no contract-only
 *      marker); no write, and no collision with another contract's operationIds.
 *   2. Security is the human `cookieAuth` only; 404 (not 403) is the
 *      role / scope refusal; no tenant id is accepted from the request.
 *   3. The list filters, cursor and page bounds.
 *   4. Projections are strict, carry no tenant / device id or payload hash,
 *      use exact-decimal string money, and do not fabricate the AD-CASH-001
 *      D-7 policy values, `approverCheck`, review state or recompute flag.
 *   5. AJV fixtures: valid payloads pass, each invalid one fails.
 *   6. The POS-facing shift contract keeps its operations (no change to its
 *      paths).
 *
 * RT-384 (1.1.0-draft, `[GATED]`, AD-CASH-001 D-7): strictly additive. Both
 * projections gain the policy fields, the derived approval values and the
 * persisted `approverCheck` as OPTIONAL properties (the RT-383 runtime does
 * not emit them until RT-387, and its HTTP harness AJV-checks every response),
 * and the list gains three optional filters accepted from RT-387. Every RT-383
 * field, filter and required list is unchanged, so Admin-Console RT-18 is
 * unaffected.
 */
import "reflect-metadata";

import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";

import { loadOpenApiContracts } from "../../src/openapi/loader";

const CONTRACT_ID = "shift-closes.openapi";
const POS_SHIFTS_ID = "pos-shifts.openapi";

const LIST_PATH = "/api/v1/shift-closes";
const DETAIL_PATH = "/api/v1/shift-closes/{shiftId}";

const OPERATION_IDS = ["consoleGetShiftClose", "consoleListShiftCloses"] as const;

/** RT-384: optional on the wire until the RT-387 runtime emits them on every close. */
const CONTRACT_AHEAD_OF_RUNTIME = ["frozenPolicy", "approvalRequiredByPolicy", "approvalMissing", "approverCheck"] as const;

/** The RT-383 required lists, pinned so the RT-384 bump stays strictly additive. */
const RT383_SUMMARY_REQUIRED = [
  "shiftId",
  "storeId",
  "currencyCode",
  "closedAt",
  "closeKind",
  "forcedReason",
  "closingUserId",
  "varianceApprovedByUserId",
  "openingFloat",
  "cashSalesTotal",
  "cashRefundsTotal",
  "payInTotal",
  "payOutTotal",
  "expectedCash",
  "countedCash",
  "variance",
  "saleCount",
  "receivedAt",
];
const RT383_DETAIL_EXTRA_REQUIRED = ["openedAt", "openingUserId", "recordedByUserId", "cashRefundReturnRefs", "cashMovements"];

type SchemaName =
  | "ApproverCheck"
  | "ShiftCloseSummary"
  | "ShiftClosePage"
  | "ShiftCloseDetail"
  | "ShiftCashMovement"
  | "Error";

interface ParameterObject {
  $ref?: string;
  in?: string;
  name?: string;
  required?: boolean;
  schema?: Record<string, unknown>;
  description?: string;
}

interface OperationObject {
  operationId?: string;
  security?: Array<Record<string, unknown>>;
  parameters?: ParameterObject[];
  requestBody?: unknown;
  responses?: Record<string, { $ref?: string }>;
  "x-runtime-status"?: string;
  "x-runtime-note"?: string;
}

type SchemaObject = Record<string, unknown> & {
  required?: string[];
  properties?: Record<string, Record<string, unknown>>;
  additionalProperties?: unknown;
};

interface OpenApiDocument {
  openapi?: string;
  info?: { version?: string; description?: string };
  security?: Array<Record<string, unknown>>;
  paths?: Record<string, Record<string, OperationObject>>;
  components?: {
    schemas?: Record<string, SchemaObject>;
    parameters?: Record<string, ParameterObject>;
    securitySchemes?: Record<string, Record<string, unknown>>;
  };
}

let doc: OpenApiDocument;
let posShiftsDoc: OpenApiDocument;
let otherOperationIds: Set<string>;
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);

beforeAll(() => {
  const contracts = loadOpenApiContracts();
  const found = contracts.find((c) => c.id === CONTRACT_ID);
  if (!found) throw new Error(`${CONTRACT_ID} not found in packages/contracts/openapi/`);
  doc = found.document as OpenApiDocument;
  const pos = contracts.find((c) => c.id === POS_SHIFTS_ID);
  if (!pos) throw new Error(`${POS_SHIFTS_ID} not found in packages/contracts/openapi/`);
  posShiftsDoc = pos.document as OpenApiDocument;
  otherOperationIds = new Set<string>();
  for (const c of contracts) {
    if (c.id === CONTRACT_ID) continue;
    for (const item of Object.values((c.document as OpenApiDocument).paths ?? {})) {
      for (const o of Object.values(item)) {
        if (typeof o?.operationId === "string") otherOperationIds.add(o.operationId);
      }
    }
  }
  ajv.addSchema(doc as object, CONTRACT_ID);
});

function op(path: string): OperationObject {
  const found = doc.paths?.[path]?.["get"];
  if (!found) throw new Error(`GET ${path} not declared`);
  return found;
}

function schema(name: SchemaName): SchemaObject {
  const s = doc.components?.schemas?.[name];
  if (!s) throw new Error(`schema ${name} not declared`);
  return s;
}

function validator(name: SchemaName): ValidateFunction {
  const v = ajv.getSchema(`${CONTRACT_ID}#/components/schemas/${name}`);
  if (!v) throw new Error(`ajv cannot resolve ${name}`);
  return v;
}

/** Resolves `#/components/parameters/<Name>` references. */
function params(path: string): ParameterObject[] {
  return (op(path).parameters ?? []).map((p) =>
    p.$ref ? doc.components!.parameters![p.$ref.replace("#/components/parameters/", "")]! : p,
  );
}

function param(path: string, name: string): ParameterObject {
  const found = params(path).find((p) => p.name === name);
  if (!found) throw new Error(`parameter ${name} not declared on ${path}`);
  return found;
}

const SHIFT_ID = "0190f5a2-3b4c-7d8e-9f01-23456789abcd";
const STORE_ID = "0190f5a2-3b4c-7d8e-9f01-000000000002";
const USER_ID = "0190f5a2-3b4c-7d8e-9f01-000000000003";
const APPROVER_ID = "0190f5a2-3b4c-7d8e-9f01-000000000004";
const MOVEMENT_ID = "0190f5a2-3b4c-7d8e-9f01-000000000005";
const RETURN_ID = "0190f5a2-3b4c-7d8e-9f01-000000000006";

const SUMMARY = {
  shiftId: SHIFT_ID,
  storeId: STORE_ID,
  currencyCode: "EGP",
  closedAt: "2026-10-11T18:00:00.000Z",
  closeKind: "normal",
  forcedReason: null,
  closingUserId: USER_ID,
  varianceApprovedByUserId: APPROVER_ID,
  openingFloat: "500.00",
  cashSalesTotal: "1200.50",
  cashRefundsTotal: "50.00",
  payInTotal: "100.00",
  payOutTotal: "200.00",
  expectedCash: "1550.50",
  countedCash: "1540.00",
  variance: "-10.50",
  saleCount: 42,
  receivedAt: "2026-10-11T18:00:02.000Z",
} as const;

const MOVEMENT = {
  movementId: MOVEMENT_ID,
  kind: "pay_out",
  amount: "200.00",
  reasonCode: "bank_drop",
  note: null,
  occurredAt: "2026-10-11T14:00:00.000Z",
  recordedByUserId: USER_ID,
  receivedAt: "2026-10-11T14:00:01.000Z",
} as const;

const DETAIL = {
  ...SUMMARY,
  openedAt: "2026-10-11T09:00:00.000Z",
  openingUserId: USER_ID,
  recordedByUserId: USER_ID,
  cashRefundReturnRefs: [RETURN_ID],
  cashMovements: [MOVEMENT],
} as const;

function without<T extends object>(value: T, key: keyof T): Omit<T, typeof key> {
  const copy = { ...value };
  delete copy[key];
  return copy;
}

// ===========================================================================
// 1. Document + operations
// ===========================================================================
describe("shift-closes — document and operations", () => {
  it("is an OpenAPI 3.1 document at version 1.1.0-draft (RT-384)", () => {
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info?.version).toBe("1.1.0-draft");
  });

  it("carries an RT-384 note: additive, [GATED], non-breaking for Admin-Console RT-18", () => {
    const info = (doc.info?.description ?? "").replace(/\s+/g, " ");
    expect(info).toContain("RT-384 (1.1.0-draft");
    expect(info).toContain("[GATED]");
    expect(info).toContain("strictly additive");
    expect(info).toContain("RT-18");
  });

  it("declares exactly the list and detail reads, and nothing else", () => {
    expect(Object.keys(doc.paths ?? {}).sort()).toEqual([LIST_PATH, DETAIL_PATH].sort());
    expect(Object.keys(doc.paths![LIST_PATH]!)).toEqual(["get"]);
    expect(Object.keys(doc.paths![DETAIL_PATH]!)).toEqual(["get"]);
    expect(op(LIST_PATH).operationId).toBe("consoleListShiftCloses");
    expect(op(DETAIL_PATH).operationId).toBe("consoleGetShiftClose");
  });

  it("has no request body on either read", () => {
    expect(op(LIST_PATH).requestBody).toBeUndefined();
    expect(op(DETAIL_PATH).requestBody).toBeUndefined();
  });

  it("marks neither operation contract-only (the RT-383 runtime ships both)", () => {
    for (const path of [LIST_PATH, DETAIL_PATH]) {
      expect(op(path)["x-runtime-status"]).toBeUndefined();
      expect(op(path)["x-runtime-note"]).toBeUndefined();
    }
  });

  it("collides with no operationId in any other contract", () => {
    expect(OPERATION_IDS.filter((id) => otherOperationIds.has(id))).toEqual([]);
  });
});

// ===========================================================================
// 2. Auth and non-disclosure
// ===========================================================================
describe("shift-closes — auth and scope", () => {
  it("accepts only the human cookieAuth session", () => {
    expect(doc.security).toEqual([{ cookieAuth: [] }]);
    for (const path of [LIST_PATH, DETAIL_PATH]) expect(op(path).security).toBeUndefined();
    expect(Object.keys(doc.components?.securitySchemes ?? {})).toEqual(["cookieAuth"]);
    expect(doc.components!.securitySchemes!["cookieAuth"]).toMatchObject({
      type: "apiKey",
      in: "cookie",
      name: "dp2_session",
    });
  });

  it("answers 200 / 400 / 401 / 404 / 500 and refuses role or scope as 404, never 403", () => {
    for (const path of [LIST_PATH, DETAIL_PATH]) {
      expect(Object.keys(op(path).responses ?? {}).sort()).toEqual(["200", "400", "401", "404", "500"]);
    }
  });

  it("takes no tenant id from the request", () => {
    for (const path of [LIST_PATH, DETAIL_PATH]) {
      expect(params(path).map((p) => p.name)).not.toEqual(
        expect.arrayContaining([expect.stringMatching(/tenant/i)]),
      );
    }
  });
});

// ===========================================================================
// 3. List filters and paging
// ===========================================================================
describe("shift-closes — list filters and paging", () => {
  it("declares the RT-383 filters plus the RT-384 ones, all optional query parameters", () => {
    const names = params(LIST_PATH).map((p) => p.name);
    expect(names.sort()).toEqual(
      [
        "approval",
        "approval_missing",
        "approval_required",
        "approver_check",
        "close_kind",
        "closed_from",
        "closed_to",
        "currency_code",
        "cursor",
        "min_abs_variance",
        "page_size",
        "store_id",
      ].sort(),
    );
    for (const p of params(LIST_PATH)) {
      expect(p.in).toBe("query");
      expect(p.required).toBe(false);
    }
  });

  it("bounds page_size to 1..200, default 50", () => {
    expect(param(LIST_PATH, "page_size").schema).toMatchObject({
      type: "integer",
      minimum: 1,
      maximum: 200,
      default: 50,
    });
  });

  it("keeps the cursor opaque and bounded", () => {
    expect(param(LIST_PATH, "cursor").schema).toMatchObject({
      type: "string",
      minLength: 1,
      maxLength: 512,
      pattern: "^[A-Za-z0-9_-]+$",
    });
  });

  it("uses date-time bounds, a close-kind enum and an approval enum", () => {
    expect(param(LIST_PATH, "closed_from").schema).toMatchObject({ format: "date-time" });
    expect(param(LIST_PATH, "closed_to").schema).toMatchObject({ format: "date-time" });
    expect(param(LIST_PATH, "close_kind").schema).toEqual({ $ref: "#/components/schemas/CloseKind" });
    expect(doc.components!.schemas!["CloseKind"]!["enum"]).toEqual(["normal", "forced"]);
    expect(param(LIST_PATH, "approval").schema).toMatchObject({ enum: ["approved", "not_approved"] });
  });

  it.each([
    ["approval_required", ["yes", "no", "unknown"]],
    ["approval_missing", ["yes", "no", "unknown"]],
    ["approver_check", ["not_applicable", "verified", "unverified"]],
  ])("RT-384 filter %s is the enum %j, accepted from RT-387", (name, values) => {
    const p = param(LIST_PATH, name);
    expect(p.schema).toMatchObject({ type: "string", enum: values });
    expect(p.description ?? "").toContain("RT-387");
  });

  it("keeps the RT-383 approval filter enum unchanged", () => {
    expect(param(LIST_PATH, "approval").schema).toEqual({ type: "string", enum: ["approved", "not_approved"] });
  });

  it("takes the variance threshold as a non-negative exact-decimal string", () => {
    expect(param(LIST_PATH, "min_abs_variance").schema).toEqual({
      $ref: "#/components/schemas/NonNegativeDecimalAmount",
    });
  });

  it("takes the shift id as a UUID path parameter on the detail read", () => {
    expect(params(DETAIL_PATH)).toHaveLength(1);
    expect(param(DETAIL_PATH, "shiftId")).toMatchObject({
      in: "path",
      required: true,
      schema: { type: "string", format: "uuid" },
    });
  });

  it("caps a page at the page_size maximum", () => {
    expect(schema("ShiftClosePage").properties?.["items"]).toMatchObject({ maxItems: 200 });
  });
});

// ===========================================================================
// 4. Projections
// ===========================================================================
describe("shift-closes — projections", () => {
  const PROJECTIONS: SchemaName[] = ["ShiftCloseSummary", "ShiftClosePage", "ShiftCloseDetail", "ShiftCashMovement"];

  it("is strict, and every key is required except the RT-384 fields ahead of the runtime", () => {
    const ahead: readonly string[] = CONTRACT_AHEAD_OF_RUNTIME;
    for (const name of PROJECTIONS) {
      const s = schema(name);
      expect(s.additionalProperties).toBe(false);
      const expected = Object.keys(s.properties ?? {}).filter((k) => !ahead.includes(k));
      expect([...(s.required ?? [])].sort()).toEqual(expected.sort());
    }
  });

  it("keeps the RT-383 required lists exactly (strictly additive for RT-18)", () => {
    expect([...(schema("ShiftCloseSummary").required ?? [])].sort()).toEqual([...RT383_SUMMARY_REQUIRED].sort());
    expect([...(schema("ShiftCloseDetail").required ?? [])].sort()).toEqual(
      [...RT383_SUMMARY_REQUIRED, ...RT383_DETAIL_EXTRA_REQUIRED].sort(),
    );
  });

  it("adds the RT-384 fields to both projections, optional, with the documented shapes", () => {
    for (const name of ["ShiftCloseSummary", "ShiftCloseDetail"] as const) {
      const props = schema(name).properties!;
      for (const key of CONTRACT_AHEAD_OF_RUNTIME) expect(props[key]).toBeDefined();
      expect(props["frozenPolicy"]).toMatchObject({
        oneOf: [{ $ref: "#/components/schemas/RecordedFrozenPolicy" }, { type: "null" }],
      });
      expect(props["approvalRequiredByPolicy"]).toEqual({ $ref: "#/components/schemas/PolicyTriState" });
      expect(props["approvalMissing"]).toEqual({ $ref: "#/components/schemas/PolicyTriState" });
      expect(props["approverCheck"]).toEqual({ $ref: "#/components/schemas/ApproverCheck" });
    }
    expect(doc.components!.schemas!["PolicyTriState"]!["enum"]).toEqual(["yes", "no", "unknown"]);
  });

  it("carries no tenant id, device id, payload hash or credential", () => {
    const forbidden = /tenant|device|payload|hash|token|pin|secret|email|phone|name$/i;
    for (const name of PROJECTIONS) {
      expect(Object.keys(schema(name).properties ?? {}).filter((k) => forbidden.test(k))).toEqual([]);
    }
  });

  it("does not fabricate review, acknowledgement, recompute or attempt fields", () => {
    const fabricated = /review|acknowledg|recompute|attempt/i;
    for (const name of PROJECTIONS) {
      expect(Object.keys(schema(name).properties ?? {}).filter((k) => fabricated.test(k))).toEqual([]);
    }
  });

  it("returns every money field as an exact-decimal string reference", () => {
    const money = [
      "openingFloat",
      "cashSalesTotal",
      "cashRefundsTotal",
      "payInTotal",
      "payOutTotal",
      "expectedCash",
      "countedCash",
    ];
    for (const name of ["ShiftCloseSummary", "ShiftCloseDetail"] as const) {
      const props = schema(name).properties!;
      for (const field of money) {
        expect(props[field]).toEqual({ $ref: "#/components/schemas/NonNegativeDecimalAmount" });
      }
      expect(props["variance"]).toEqual({ $ref: "#/components/schemas/SignedDecimalAmount" });
    }
    expect(schema("ShiftCashMovement").properties!["amount"]).toEqual({
      $ref: "#/components/schemas/PositiveDecimalAmount",
    });
  });

  it("matches the close fields of the summary on the detail", () => {
    const summary = schema("ShiftCloseSummary").properties!;
    const detail = schema("ShiftCloseDetail").properties!;
    const shape = (s: Record<string, unknown> | undefined): Record<string, unknown> | undefined => {
      if (!s) return s;
      const { description: _description, ...rest } = s;
      return rest;
    };
    for (const [key, value] of Object.entries(summary)) {
      expect({ key, schema: shape(detail[key]) }).toEqual({ key, schema: shape(value) });
    }
  });
});

// ===========================================================================
// 5. AJV fixtures
// ===========================================================================
describe("shift-closes — AJV fixtures", () => {
  it("accepts a normal close summary, a forced one and a page", () => {
    expect(validator("ShiftCloseSummary")(SUMMARY)).toBe(true);
    expect(
      validator("ShiftCloseSummary")({
        ...SUMMARY,
        closeKind: "forced",
        forcedReason: "Cashier left the store",
        varianceApprovedByUserId: null,
      }),
    ).toBe(true);
    expect(validator("ShiftClosePage")({ items: [SUMMARY], nextCursor: "eyJjIjoxfQ" })).toBe(true);
    expect(validator("ShiftClosePage")({ items: [], nextCursor: null })).toBe(true);
  });

  it("accepts a detail with movements and refund refs, and one with neither", () => {
    expect(validator("ShiftCloseDetail")(DETAIL)).toBe(true);
    expect(validator("ShiftCloseDetail")({ ...DETAIL, cashRefundReturnRefs: [], cashMovements: [] })).toBe(true);
    expect(validator("ShiftCashMovement")({ ...MOVEMENT, kind: "pay_in", reasonCode: "float_top_up", note: "Top-up" })).toBe(
      true,
    );
  });

  it.each([
    ["a forced close without a reason", { ...SUMMARY, closeKind: "forced", forcedReason: null }],
    ["a normal close with a reason", { ...SUMMARY, forcedReason: "x" }],
    ["a float amount", { ...SUMMARY, countedCash: 1540 }],
    ["more than 4 fractional digits", { ...SUMMARY, countedCash: "1540.00001" }],
    ["a negative non-negative amount", { ...SUMMARY, expectedCash: "-1.00" }],
    ["a lower-case currency", { ...SUMMARY, currencyCode: "egp" }],
    ["an unknown key", { ...SUMMARY, tenantId: SHIFT_ID }],
    ["a missing approver key", without(SUMMARY, "varianceApprovedByUserId")],
    ["an unknown close kind", { ...SUMMARY, closeKind: "auto" }],
  ])("rejects a summary with %s", (_label, payload) => {
    expect(validator("ShiftCloseSummary")(payload)).toBe(false);
  });

  it.each([
    ["a zero amount", { ...MOVEMENT, amount: "0.00" }],
    ["an unknown reason code", { ...MOVEMENT, reasonCode: "theft" }],
    ["an empty note", { ...MOVEMENT, note: "" }],
    ["a missing note key", without(MOVEMENT, "note")],
  ])("rejects a movement with %s", (_label, payload) => {
    expect(validator("ShiftCashMovement")(payload)).toBe(false);
  });

  it("rejects a detail without movements or the recording actor", () => {
    expect(validator("ShiftCloseDetail")(without(DETAIL, "cashMovements"))).toBe(false);
    expect(validator("ShiftCloseDetail")(without(DETAIL, "recordedByUserId"))).toBe(false);
  });

  it("rejects a page over 200 items or without nextCursor", () => {
    expect(validator("ShiftClosePage")({ items: Array(201).fill(SUMMARY), nextCursor: null })).toBe(false);
    expect(validator("ShiftClosePage")({ items: [] })).toBe(false);
  });

  const FROZEN = {
    policySource: "tenant",
    policyRevisionId: "0190f5a2-3b4c-7d8e-9f01-0000000000a1",
    policyValue: { mode: "limit", limitAmount: "5.00", currencyCode: "EGP" },
    policyFlags: [],
  } as const;

  const POLICY_FIELDS = {
    frozenPolicy: FROZEN,
    approvalRequiredByPolicy: "yes",
    approvalMissing: "no",
    approverCheck: { status: "verified", reason: null },
  } as const;

  const LEGACY_POLICY_FIELDS = {
    frozenPolicy: null,
    approvalRequiredByPolicy: "unknown",
    approvalMissing: "unknown",
    approverCheck: { status: "unverified", reason: "check_unavailable" },
  } as const;

  it("RT-384: accepts a close with the policy fields, a legacy close and an RT-383 close without them", () => {
    expect(validator("ShiftCloseSummary")({ ...SUMMARY, ...POLICY_FIELDS })).toBe(true);
    expect(validator("ShiftCloseSummary")({ ...SUMMARY, ...LEGACY_POLICY_FIELDS })).toBe(true);
    expect(validator("ShiftCloseSummary")(SUMMARY)).toBe(true);
    expect(validator("ShiftCloseDetail")({ ...DETAIL, ...POLICY_FIELDS })).toBe(true);
    expect(
      validator("ShiftCloseSummary")({
        ...SUMMARY,
        ...POLICY_FIELDS,
        frozenPolicy: {
          policySource: "fallback",
          policyRevisionId: null,
          policyValue: { mode: "limit", limitAmount: "0", currencyCode: "EGP" },
          policyFlags: ["policy_value_mismatch"],
        },
      }),
    ).toBe(true);
  });

  const frozen = (patch: Record<string, unknown>): Record<string, unknown> => ({ ...POLICY_FIELDS, frozenPolicy: patch });

  it.each([
    ["a boolean tri-state", { ...POLICY_FIELDS, approvalMissing: true }],
    ["an unknown policy flag", frozen({ ...FROZEN, policyFlags: ["stale"] })],
    ["a tenant source without a revision id", frozen({ ...FROZEN, policyRevisionId: null })],
    ["a system source with a revision id", frozen({ ...FROZEN, policySource: "system" })],
    ["a frozen policy without its flags", frozen({ ...without(FROZEN, "policyFlags") })],
    ["a frozen policy without its revision id", frozen({ ...without(FROZEN, "policyRevisionId") })],
    ["a frozen policy without its value", frozen({ ...without(FROZEN, "policyValue") })],
    ["a frozen policy without its source", frozen({ ...without(FROZEN, "policySource") })],
    ["a limit without an amount", frozen({ ...FROZEN, policyValue: { mode: "limit", currencyCode: "EGP" } })],
    ["a stray top-level policy field", { ...POLICY_FIELDS, policySource: "tenant" }],
    // M1: a close whose open carried no frozen policy never reads as "no exception".
    ["no frozen policy but approval not required", { ...LEGACY_POLICY_FIELDS, approvalRequiredByPolicy: "no", approvalMissing: "no" }],
    ["no frozen policy but approval required", { ...LEGACY_POLICY_FIELDS, approvalRequiredByPolicy: "yes", approvalMissing: "no" }],
    ["a frozen policy but an unknown requirement", { ...POLICY_FIELDS, approvalRequiredByPolicy: "unknown", approvalMissing: "unknown" }],
    // L2: the four RT-384 fields are all-or-none.
    ["only the frozen policy", { frozenPolicy: FROZEN }],
    ["only the approver check", { approverCheck: { status: "verified", reason: null } }],
    ["three of the four fields", without(POLICY_FIELDS, "approverCheck")],
  ])("RT-384: rejects a summary with %s", (_label, fields) => {
    expect(validator("ShiftCloseSummary")({ ...SUMMARY, ...fields })).toBe(false);
  });

  it("RT-384: approverCheck is not_applicable exactly when no approver was recorded", () => {
    const v = validator("ShiftCloseSummary");
    const check = (status: string, reason: string | null = null) => ({ ...POLICY_FIELDS, approverCheck: { status, reason } });
    // Approval was required (POLICY_FIELDS) and none was recorded, so approvalMissing is "yes".
    const noApprover = { ...SUMMARY, varianceApprovedByUserId: null, approvalMissing: "yes" };
    expect(v({ ...check("not_applicable"), ...noApprover })).toBe(true);
    expect(v({ ...SUMMARY, ...check("unverified", "not_manager") })).toBe(true);
    expect(v({ ...check("verified"), ...noApprover })).toBe(false);
    expect(v({ ...check("unverified", "check_unavailable"), ...noApprover })).toBe(false);
    expect(v({ ...SUMMARY, ...check("not_applicable") })).toBe(false);
    expect(validator("ShiftCloseDetail")({ ...DETAIL, ...check("verified"), varianceApprovedByUserId: null, approvalMissing: "yes" })).toBe(false);
  });

  it.each([
    ["yes", true, "no", true],
    ["yes", false, "yes", true],
    ["no", true, "no", true],
    ["no", false, "no", true],
    ["unknown", true, "unknown", true],
    ["unknown", false, "unknown", true],
    ["no", true, "yes", false],
    ["yes", true, "yes", false],
    ["yes", false, "no", false],
    ["unknown", false, "no", false],
    ["no", false, "unknown", false],
    ["yes", true, "unknown", false],
  ])("RT-384: approvalRequired %s, approver recorded %s, approvalMissing %s -> %s", (required, hasApprover, missing, ok) => {
    const body = {
      ...SUMMARY,
      varianceApprovedByUserId: hasApprover ? APPROVER_ID : null,
      frozenPolicy: required === "unknown" ? null : FROZEN,
      approvalRequiredByPolicy: required,
      approvalMissing: missing,
      approverCheck: hasApprover ? { status: "verified", reason: null } : { status: "not_applicable", reason: null },
    };
    expect(validator("ShiftCloseSummary")(body)).toBe(ok);
    expect(validator("ShiftCloseDetail")({ ...DETAIL, ...body })).toBe(ok);
  });

  it.each([
    [{ status: "not_applicable", reason: null }, true],
    [{ status: "verified", reason: null }, true],
    ...["approver_is_closer", "inactive_membership", "not_manager", "no_store_access", "check_unavailable"].map(
      (reason) => [{ status: "unverified", reason }, true] as const,
    ),
    [{ status: "unverified", reason: null }, false],
    [{ status: "verified", reason: "not_manager" }, false],
    [{ status: "pending", reason: null }, false],
    [{ status: "unverified", reason: "revoked" }, false],
    [{ status: "verified" }, false],
  ] as const)("ApproverCheck %j -> %s", (value, ok) => {
    expect(validator("ApproverCheck")(value)).toBe(ok);
  });

  it("documents the legacy approverCheck rule (coordinator decision 4)", () => {
    const text = (doc.components!.schemas!["ApproverCheck"]!["description"] as string).replace(/\s+/g, " ");
    expect(text).toContain("`not_applicable`");
    expect(text).toContain("`check_unavailable`");
    expect(text).toContain("RT-385");
  });

  it("accepts the canonical error envelope", () => {
    expect(validator("Error")({ error: { code: "not_found", message: "Not Found", request_id: SHIFT_ID } })).toBe(true);
    expect(validator("Error")({ code: "not_found" })).toBe(false);
  });
});

// ===========================================================================
// 6. POS-facing shift contract untouched
// ===========================================================================
describe("shift-closes — POS shift contract unchanged", () => {
  it("adds no path under /api/pos/v1/shifts and keeps the POS paths", () => {
    expect(Object.keys(doc.paths ?? {}).filter((p) => p.startsWith("/api/pos/"))).toEqual([]);
    expect(Object.keys(posShiftsDoc.paths ?? {}).sort()).toEqual(
      [
        "/api/pos/v1/shifts",
        "/api/pos/v1/shifts/stuck",
        "/api/pos/v1/shifts/{shift_id}/cash-movements",
        "/api/pos/v1/shifts/{shift_id}/close",
      ].sort(),
    );
  });
});
