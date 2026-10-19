/**
 * apps/api/test/pos-approvers/pos-approvers.contract.spec.ts
 *
 * RT-492 (RT-114 MA-BC1, planning record RT-114 comment 10764 C4 / C9; owner
 * decision RT-114 comment 11888, reconciled with RT-284 comment 11887). The
 * device-authenticated approver-eligibility read. `[GATED]` contract.
 *
 * Structural / load-only, plus AJV fixtures against the contract schemas. No
 * app boot and no HTTP: the runtime ships in MA-BC2. What this pins:
 *
 *   1. One POST at `/api/pos/v1/approvers/eligibility`, contract-only, no
 *      operationId collision, no idempotency key (a read).
 *   2. Security is the existing role-named `device` scheme only, identical to
 *      the cashier-admissions one; no client-supplied scope anywhere.
 *   3. Responses are 200 / 400 / 401 only: an ineligible user is never a 403
 *      or 404, and the 200 is `no-store`.
 *   4. The request bound (1..50 distinct UUIDs) and the minimum-disclosure
 *      result (`user_id`, `eligible`, reserved `action_kinds` only).
 *   5. The normative text: V1 predicates, cross-tenant indistinguishability,
 *      and the `action_kinds` V1-omitted / client-honours rule.
 *   6. AJV fixtures: valid payloads pass, each invalid one fails.
 */
import "reflect-metadata";

import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";

import {
  allContracts,
  contractDocument,
  operationIdsExcept,
  type OpenApiDocument,
  type OperationObject,
} from "../_helpers/openapi-contract";

const CONTRACT_ID = "pos-approvers.openapi";
const ADMISSIONS_ID = "pos-cashier-admissions.openapi";
const PATH = "/api/pos/v1/approvers/eligibility";
const OPERATION_ID = "posCheckApproverEligibility";

type SchemaName =
  | "PosApproverEligibilityRequest"
  | "PosApproverEligibilityResponse"
  | "PosApproverEligibilityResult"
  | "Error";

let doc: OpenApiDocument;
let admissionsDoc: OpenApiDocument;
let otherOperationIds: Set<string>;
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);

beforeAll(() => {
  const contracts = allContracts();
  doc = contractDocument(contracts, CONTRACT_ID);
  admissionsDoc = contractDocument(contracts, ADMISSIONS_ID);
  otherOperationIds = operationIdsExcept(contracts, CONTRACT_ID);
  ajv.addSchema(doc as object, CONTRACT_ID);
});

function operation(): OperationObject & { "x-idempotency"?: string } {
  const found = doc.paths?.[PATH]?.["post"];
  if (!found) throw new Error(`POST ${PATH} not declared`);
  return found;
}

function validator(name: SchemaName): ValidateFunction {
  const v = ajv.getSchema(`${CONTRACT_ID}#/components/schemas/${name}`);
  if (!v) throw new Error(`ajv cannot resolve ${name}`);
  return v;
}

const USER_A = "0190f5a2-3b4c-7d8e-9f01-00000000000a";
const USER_B = "0190f5a2-3b4c-7d8e-9f01-00000000000b";

function userIds(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `0190f5a2-3b4c-7d8e-9f01-${String(i).padStart(12, "0")}`);
}

// ===========================================================================
// 1. Document + operation
// ===========================================================================
describe("pos-approvers — document and operation", () => {
  it("is an OpenAPI 3.1 document at version 1.0.0-draft", () => {
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info?.version).toBe("1.0.0-draft");
  });

  it("declares exactly one POST operation", () => {
    expect(Object.keys(doc.paths ?? {})).toEqual([PATH]);
    expect(Object.keys(doc.paths![PATH]!)).toEqual(["post"]);
    expect(operation().operationId).toBe(OPERATION_ID);
  });

  it("is contract-only until MA-BC2, with a runtime note", () => {
    expect(operation()["x-runtime-status"]).toBe("contract-only");
    expect(operation()["x-runtime-note"]).toMatch(/MA-BC2/);
  });

  it("is a read: no idempotency key and no audit action", () => {
    expect(operation()["x-idempotency"]).toBeUndefined();
    expect(operation()["x-audit-action"]).toBeUndefined();
    expect(doc.info?.description).toMatch(/changes no state, records no audit event/);
  });

  it("collides with no operationId in any other contract", () => {
    expect(otherOperationIds.has(OPERATION_ID)).toBe(false);
  });
});

// ===========================================================================
// 2. Authentication and scope
// ===========================================================================
describe("pos-approvers — device authentication only", () => {
  it("accepts only the role-named device bearer", () => {
    expect(operation().security).toEqual([{ device: [] }]);
    expect(doc.security).toBeUndefined();
    expect(Object.keys(doc.components?.securitySchemes ?? {})).toEqual(["device"]);
  });

  it("reuses the cashier-admissions device scheme verbatim (opaque, never a JWT)", () => {
    const device = doc.components!.securitySchemes!["device"]!;
    expect(device).toEqual(admissionsDoc.components!.securitySchemes!["device"]);
    expect(device).toMatchObject({ type: "http", scheme: "bearer" });
    expect(device["bearerFormat"]).toBeUndefined();
  });

  it("takes no parameters and no scope field: tenant and store come from the device row", () => {
    expect(operation().parameters).toBeUndefined();
    const request = doc.components!.schemas!["PosApproverEligibilityRequest"]!;
    expect(Object.keys(request.properties ?? {})).toEqual(["user_ids"]);
    expect(doc.info?.description).toMatch(/come ONLY\s+from the authenticated, non-revoked `devices` row/);
  });
});

// ===========================================================================
// 3. Responses
// ===========================================================================
describe("pos-approvers — responses", () => {
  it("answers 200 / 400 / 401 only: an ineligible user is never a 403 or 404", () => {
    expect(Object.keys(operation().responses ?? {}).sort()).toEqual(["200", "400", "401"]);
    expect(operation().responses!["400"]).toEqual({ $ref: "#/components/responses/ValidationFailure" });
    expect(operation().responses!["401"]).toEqual({ $ref: "#/components/responses/Unauthorized" });
  });

  it("marks the 200 no-store", () => {
    const ok = operation().responses!["200"]!;
    expect(ok.headers?.["Cache-Control"]).toMatchObject({ required: true, schema: { type: "string", enum: ["no-store"] } });
  });
});

// ===========================================================================
// 4. Request bound and minimum-disclosure result
// ===========================================================================
describe("pos-approvers — request bound and result shape", () => {
  it("bounds user_ids to 1..50 distinct UUIDs and closes the request object", () => {
    const request = doc.components!.schemas!["PosApproverEligibilityRequest"]!;
    expect(request.required).toEqual(["user_ids"]);
    expect(request.additionalProperties).toBe(false);
    expect(request.properties!["user_ids"]).toMatchObject({ type: "array", minItems: 1, maxItems: 50, uniqueItems: true });
    expect(doc.components!.schemas!["ApproverUserId"]).toMatchObject({ type: "string", format: "uuid" });
  });

  it("returns only user_id, eligible and the reserved optional action_kinds", () => {
    const result = doc.components!.schemas!["PosApproverEligibilityResult"]!;
    expect(result.required).toEqual(["user_id", "eligible"]);
    expect(result.additionalProperties).toBe(false);
    expect(Object.keys(result.properties ?? {})).toEqual(["user_id", "eligible", "action_kinds"]);
    expect(doc.components!.schemas!["PosApproverEligibilityResponse"]!.additionalProperties).toBe(false);
  });

  it("keeps action_kinds an open, patterned string list (not an enum), so the catalogue can grow", () => {
    const kinds = doc.components!.schemas!["PosApproverEligibilityResult"]!.properties!["action_kinds"]!;
    expect(kinds).toMatchObject({ type: "array", minItems: 1, uniqueItems: true });
    const items = kinds["items"] as Record<string, unknown>;
    expect(items["enum"]).toBeUndefined();
    expect(items["type"]).toBe("string");
    expect(typeof items["pattern"]).toBe("string");
  });

  it("excludes the non-grantable session.self_unlock from action_kinds but keeps the namespace open", () => {
    const items = doc.components!.schemas!["PosApproverEligibilityResult"]!.properties!["action_kinds"]!["items"] as Record<string, unknown>;
    expect(items["not"]).toEqual({ const: "session.self_unlock" });
    const accepts = validator("PosApproverEligibilityResult");
    expect(accepts({ user_id: USER_A, eligible: true, action_kinds: ["session.self_unlock_other", "shift.pay_in"] })).toBe(true);
  });

  it("ties action_kinds to eligible: true in the schema, not only in prose", () => {
    const result = doc.components!.schemas!["PosApproverEligibilityResult"]!;
    expect(result["if"]).toEqual({ required: ["action_kinds"] });
    expect(result["then"]).toEqual({ properties: { eligible: { const: true } } });
  });

  it("carries no role, name, contact, membership, store or secret field anywhere", () => {
    const schemas = JSON.stringify(doc.components!.schemas);
    for (const field of ["role", "display_name", "email", "phone", "membership", "store_id", "tenant_id", "pin", "token"]) {
      expect(schemas).not.toContain(`"${field}"`);
    }
  });
});

// ===========================================================================
// 5. Normative text
// ===========================================================================
describe("pos-approvers — normative rules", () => {
  const text = (): string => doc.info?.description ?? "";

  it("states the four V1 eligibility predicates and the RT-132 role set", () => {
    expect(text()).toMatch(/not deleted/);
    expect(text()).toMatch(/ACTIVE membership in the device's tenant/);
    expect(text()).toContain("`{owner, tenant_admin, store_manager}`");
    expect(text()).toMatch(/store scope `all`,\s+or store scope `specific` with a `store_access` row/);
  });

  it("makes unknown and cross-tenant ids indistinguishable from any other ineligible user", () => {
    expect(text()).toMatch(/unknown, belongs to\s+another tenant, is deleted, or fails any predicate/);
    expect(text()).toMatch(/indistinguishable on the wire/);
    expect(text()).toMatch(/MUST NOT\s+answer a per-user `403` or `404`/);
  });

  it("omits action_kinds in V1 and obliges clients to honour it when present", () => {
    expect(text()).toMatch(/In `1.0.0-draft` the server MUST omit it from every result/);
    expect(text()).toMatch(/A\s+client MUST nevertheless honour it whenever it is present/);
    expect(text()).toMatch(/`eligible: false` never carries `action_kinds`/);
    expect(text()).toMatch(/never lists\s+`session.self_unlock`/);
  });

  it("answers in request order, one result per requested id", () => {
    expect(operation().description).toMatch(/exactly one result per requested id, in request\s+order/);
  });
});

// ===========================================================================
// 6. AJV fixtures
// ===========================================================================
describe("pos-approvers — AJV fixtures", () => {
  it.each([
    ["one id", { user_ids: [USER_A] }],
    ["two ids", { user_ids: [USER_A, USER_B] }],
    ["the 50-id maximum", { user_ids: userIds(50) }],
    ["a mixed-case UUID", { user_ids: [USER_A.toUpperCase()] }],
  ])("schema-validates a request with %s", (_label, body) => {
    expect(validator("PosApproverEligibilityRequest")(body)).toBe(true);
  });

  it("does not catch two spellings of one UUID with raw uniqueItems: the server must (ApproverUserId)", () => {
    const request = validator("PosApproverEligibilityRequest");
    // Schema-valid only: the runtime validator (zod uuid) rejects a `urn:uuid:` prefix, so the
    // contract does not promise that spelling is accepted, only that no two spellings are distinct.
    expect(request({ user_ids: [USER_A, USER_A.toUpperCase()] })).toBe(true);
    expect(request({ user_ids: [USER_A, `urn:uuid:${USER_A}`] })).toBe(true);
    const text = JSON.stringify(doc.components!.schemas!["ApproverUserId"]);
    expect(text).toMatch(/compared case-insensitively/);
    expect(text).toMatch(/MAY reject a non-canonical spelling/);
    expect(text).toMatch(/MUST treat\s+two spellings of one UUID as a duplicate/);
  });

  it.each([
    ["an empty list", { user_ids: [] }],
    ["51 ids", { user_ids: userIds(51) }],
    ["a duplicate id", { user_ids: [USER_A, USER_A] }],
    ["a non-UUID id", { user_ids: ["not-a-uuid"] }],
    ["a missing user_ids", {}],
    ["a client-supplied store_id", { user_ids: [USER_A], store_id: USER_B }],
    ["a client-supplied tenant_id", { user_ids: [USER_A], tenant_id: USER_B }],
  ])("rejects a request with %s", (_label, body) => {
    expect(validator("PosApproverEligibilityRequest")(body)).toBe(false);
  });

  it("accepts the V1 response: eligible and ineligible results, no action_kinds", () => {
    const body = { results: [{ user_id: USER_A, eligible: true }, { user_id: USER_B, eligible: false }] };
    expect(validator("PosApproverEligibilityResponse")(body)).toBe(true);
  });

  it("accepts a later-version result that lists action kinds", () => {
    const result = { user_id: USER_A, eligible: true, action_kinds: ["cart.cancel_post_handoff", "cashier.pin.unlock_lockout", "sale.void"] };
    expect(validator("PosApproverEligibilityResult")(result)).toBe(true);
  });

  it.each([
    ["a role", { user_id: USER_A, eligible: true, role: "store_manager" }],
    ["a cause", { user_id: USER_A, eligible: false, reason: "cross_tenant" }],
    ["a display name", { user_id: USER_A, eligible: true, display_name: "Mona" }],
    ["no eligible flag", { user_id: USER_A }],
    ["action_kinds on an ineligible user", { user_id: USER_A, eligible: false, action_kinds: ["sale.void"] }],
    ["session.self_unlock in action_kinds", { user_id: USER_A, eligible: true, action_kinds: ["sale.void", "session.self_unlock"] }],
    ["an empty action_kinds", { user_id: USER_A, eligible: true, action_kinds: [] }],
    ["a malformed action kind", { user_id: USER_A, eligible: true, action_kinds: ["Cart Cancel"] }],
  ])("rejects a result with %s", (_label, result) => {
    expect(validator("PosApproverEligibilityResult")(result)).toBe(false);
  });

  it("validates the error envelope and rejects extra fields on it", () => {
    const error = { error: { code: "validation_error", message: "invalid request", request_id: "req-1" } };
    expect(validator("Error")(error)).toBe(true);
    expect(validator("Error")({ error: { ...error.error, user_id: USER_A } })).toBe(false);
  });
});
