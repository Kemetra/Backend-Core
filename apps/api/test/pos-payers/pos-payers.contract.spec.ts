/**
 * apps/api/test/pos-payers/pos-payers.contract.spec.ts
 *
 * RT-570 (RT-417 follow-up F2; owner authorization Jira RT-570 comment 13213,
 * 2026-10-21). The POS-facing payer lookup for the till. `[GATED]` contract.
 *
 * Structural / load-only, plus AJV fixtures against the contract schemas. No
 * app boot and no HTTP: the RT-802 runtime has its own unit and db-integration
 * specs (`test/catalog/sales/payers/`). What this pins:
 *
 *   1. One GET at `/api/pos/v1/payer-accounts`, served since RT-802 (no
 *      contract-only marker), no operationId
 *      collision, no idempotency key and no audit action (a read).
 *   2. Security is the existing `operatorAuthorization` envelope scheme only,
 *      identical to `sale-history.yaml`; no client-supplied scope anywhere.
 *   3. Responses are 200 / 400 / 401 / 403 / 429 / 500; the 200 is `no-store`;
 *      the 403 is the capture role-refusal code.
 *   4. The query surface is `category`, `cursor`, `page_size` only: no free-text
 *      search and no store / tenant parameter.
 *   5. The minimum-disclosure item and the chargeable / linked schema guard.
 *   6. The normative text: role, scope, credit decision, advisory read,
 *      offline, ordering.
 *   7. AJV fixtures: valid payloads pass, each invalid one fails.
 */
import "reflect-metadata";

import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";

import {
  allContracts,
  contractDocument,
  contractReader,
  operationIdsExcept,
  type OpenApiDocument,
  type OperationObject,
} from "../_helpers/openapi-contract";

const CONTRACT_ID = "pos-payers.openapi";
const HISTORY_ID = "sale-history";
const SETTLEMENT_ID = "settlement";
const PATH = "/api/pos/v1/payer-accounts";
const OPERATION_ID = "posListChargeablePayers";

type SchemaName = "PosPayerPage" | "PosPayer" | "PayerCategory" | "Error";

let doc: OpenApiDocument;
let historyDoc: OpenApiDocument;
let settlementDoc: OpenApiDocument;
let otherOperationIds: Set<string>;
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);

beforeAll(() => {
  const contracts = allContracts();
  [doc, historyDoc, settlementDoc] = [CONTRACT_ID, HISTORY_ID, SETTLEMENT_ID].map((id) =>
    contractDocument(contracts, id),
  ) as [OpenApiDocument, OpenApiDocument, OpenApiDocument];
  otherOperationIds = operationIdsExcept(contracts, CONTRACT_ID);
  ajv.addSchema(doc as object, CONTRACT_ID);
});

const operation = (): OperationObject & { "x-idempotency"?: string } => contractReader(doc).get(PATH);

function validator(name: SchemaName): ValidateFunction {
  const compiled = ajv.getSchema(`${CONTRACT_ID}#/components/schemas/${name}`);
  if (compiled === undefined) throw new Error(`ajv cannot resolve ${name}`);
  return compiled;
}

const PAYER_A = "0190f5a2-3b4c-7d8e-9f01-00000000000a";
const PAYER_B = "0190f5a2-3b4c-7d8e-9f01-00000000000b";
const AS_OF = "2026-10-21T12:00:00.000Z";

const linkedPayer = {
  payerRef: PAYER_A,
  displayName: "Delta Insurance",
  category: "insurer",
  erpCustomerLinked: true,
  chargeable: true,
};
const unlinkedPayer = {
  payerRef: PAYER_B,
  displayName: "Nile Corporate",
  category: "corporate",
  erpCustomerLinked: false,
  chargeable: false,
};

// ===========================================================================
// 1. Document + operation
// ===========================================================================
describe("pos-payers — document and operation", () => {
  it("is an OpenAPI 3.1 draft document with exactly one GET operation", () => {
    expect([doc.openapi, doc.info?.version]).toEqual(["3.1.0", "1.0.0-draft"]);
    expect(Object.keys(doc.paths ?? {})).toEqual([PATH]);
    expect(Object.keys(doc.paths![PATH]!)).toEqual(["get"]);
    expect(operation().operationId).toBe(OPERATION_ID);
  });

  it("is served by the RT-802 runtime: no contract-only marker or runtime note", () => {
    expect(operation()["x-runtime-status"]).toBeUndefined();
    expect(operation()["x-runtime-note"]).toBeUndefined();
    expect(doc.info?.description).toMatch(/RT-802 runtime serves it/);
  });

  it("is a read and collides with no operationId in any other contract", () => {
    expect(operation()["x-idempotency"]).toBeUndefined();
    expect(operation()["x-audit-action"]).toBeUndefined();
    expect(doc.info?.description).toMatch(/No state change, no audit event, no idempotency key/);
    expect(otherOperationIds.has(OPERATION_ID)).toBe(false);
  });
});

// ===========================================================================
// 2. Authentication and scope
// ===========================================================================
describe("pos-payers — envelope authentication only", () => {
  it("accepts only the operatorAuthorization envelope bearer", () => {
    expect(operation().security).toEqual([{ operatorAuthorization: [] }]);
    expect(doc.security).toBeUndefined();
    expect(Object.keys(doc.components?.securitySchemes ?? {})).toEqual(["operatorAuthorization"]);
  });

  it("uses the same bearer scheme shape as sale-history (opaque, never a JWT)", () => {
    const scheme = doc.components!.securitySchemes!["operatorAuthorization"]!;
    const history = historyDoc.components!.securitySchemes!["operatorAuthorization"]!;
    expect(scheme["type"]).toBe(history["type"]);
    expect(scheme["scheme"]).toBe(history["scheme"]);
    expect(scheme["bearerFormat"]).toBeUndefined();
  });

  it("offers no device scheme: option A forbids offline / cashier credit", () => {
    expect(Object.keys(doc.components!.securitySchemes!)).not.toContain("device");
    expect(doc.info?.description).toMatch(/There is no device scheme on this surface/);
  });

  it("takes no scope parameter: tenant and store come from the envelope", () => {
    const names = (operation().parameters ?? []).map((p) => p.$ref);
    expect(names).toEqual([
      "#/components/parameters/PayerCategoryQuery",
      "#/components/parameters/Cursor",
      "#/components/parameters/PageSize",
    ]);
    const queryNames = Object.values(doc.components!.parameters!).map((p) => p.name);
    expect(queryNames).toEqual(["category", "cursor", "page_size"]);
    expect(doc.info?.description).toMatch(/no request carries a tenant, store, branch, terminal or device\s+identifier/);
  });

  it("has no free-text search parameter in v1 (a payer name never travels in a URL)", () => {
    expect(JSON.stringify(doc.components!.parameters)).not.toMatch(/"name":"(q|search|name)"/);
    expect(doc.info?.description).toMatch(/NO free-text search\s+parameter in v1/);
  });
});

// ===========================================================================
// 3. Responses
// ===========================================================================
describe("pos-payers — responses", () => {
  it("answers 200 / 400 / 401 / 403 / 429 / 500 and no 404", () => {
    expect(Object.keys(operation().responses ?? {}).sort()).toEqual(["200", "400", "401", "403", "429", "500"]);
    expect(operation().responses!["403"]).toEqual({ $ref: "#/components/responses/RoleRefused" });
    expect(operation().responses!["429"]).toEqual({ $ref: "#/components/responses/TooManyRequests" });
  });

  it("marks the 200 no-store", () => {
    const ok = operation().responses!["200"]!;
    expect(ok.headers?.["Cache-Control"]).toMatchObject({ required: true, schema: { type: "string", enum: ["no-store"] } });
  });

  it("uses the capture role-refusal code for the 403", () => {
    const refused = JSON.stringify(doc.components!.responses!["RoleRefused"]);
    expect(refused).toContain("sale_responsibility_role_refused");
    expect(refused).toMatch(/the code and body `captureSale`\s+uses/);
  });

  it("sends Retry-After on the 429", () => {
    expect(JSON.stringify(doc.components!.responses!["TooManyRequests"])).toContain("Retry-After");
  });
});

// ===========================================================================
// 4. Query bounds
// ===========================================================================
describe("pos-payers — query bounds", () => {
  it("bounds page_size to 1..200 (default 50) and filters by the settlement category vocabulary", () => {
    expect(doc.components!.parameters!["PageSize"]!.schema).toMatchObject({ minimum: 1, maximum: 200, default: 50 });
    expect(doc.components!.schemas!["PayerCategory"]!["enum"]).toEqual(
      settlementDoc.components!.schemas!["PayerCategory"]!["enum"],
    );
  });

  it("keeps the cursor opaque and bounded", () => {
    expect(doc.components!.parameters!["Cursor"]!.schema).toMatchObject({ type: "string", minLength: 1, maxLength: 512 });
  });
});

// ===========================================================================
// 5. Minimum-disclosure item and the chargeable / linked guard
// ===========================================================================
describe("pos-payers — item shape", () => {
  it("returns only payerRef, displayName, category, erpCustomerLinked and chargeable", () => {
    const item = doc.components!.schemas!["PosPayer"]!;
    expect(item.additionalProperties).toBe(false);
    expect(item.required).toEqual(["payerRef", "displayName", "category", "erpCustomerLinked", "chargeable"]);
    expect(Object.keys(item.properties ?? {})).toEqual(["payerRef", "displayName", "category", "erpCustomerLinked", "chargeable"]);
  });

  it("carries no ERPNext identifier, store, status, version, credit or tenant field anywhere", () => {
    const properties = JSON.stringify(Object.values(doc.components!.schemas!).map((s) => Object.keys(s.properties ?? {})));
    for (const field of ["externalRef", "storeId", "status", "version", "creditLimit", "balance", "terms", "tenant_id", "email", "phone"]) {
      expect(properties).not.toContain(`"${field}"`);
    }
  });

  it("ties chargeable to erpCustomerLinked in the schema, not only in prose", () => {
    const item = doc.components!.schemas!["PosPayer"]!;
    expect(item["if"]).toEqual({ properties: { erpCustomerLinked: { const: false } }, required: ["erpCustomerLinked"] });
    expect(item["then"]).toEqual({ properties: { chargeable: { const: false } } });
  });

  it("closes the page object and requires asOf", () => {
    const page = doc.components!.schemas!["PosPayerPage"]!;
    expect(page.additionalProperties).toBe(false);
    expect(page.required).toEqual(["items", "nextCursor", "asOf"]);
    expect(page.properties!["items"]).toMatchObject({ type: "array", maxItems: 200 });
  });
});

// ===========================================================================
// 6. Normative text
// ===========================================================================
describe("pos-payers — normative rules", () => {
  const text = (): string => doc.info?.description ?? "";

  it("restricts the read to owner / tenant_admin / store_manager with live standing", () => {
    expect(text()).toMatch(/active `owner`,\s+`tenant_admin` or `store_manager`/);
    expect(text()).toMatch(/re-evaluates it\s+live on every request/);
    expect(text()).toMatch(/One body for every cause/);
  });

  it("scopes to the envelope's tenant and store, with non-disclosing absence", () => {
    expect(text()).toMatch(/scoped to the\s+envelope's store or tenant-wide/);
    expect(text()).toMatch(/ABSENT: there is no 404/);
    expect(text()).toMatch(/cannot be used to probe other stores, other tenants/);
  });

  it("defines chargeable as exactly the capture predicate, with one shared implementation", () => {
    expect(text()).toMatch(/EXACTLY the payer predicate `captureSale` applies/);
    expect(text()).toMatch(/ONE shared implementation so they cannot drift apart/);
    expect(text()).toMatch(/NOT a credit\s+limit, balance, terms or collections decision/);
  });

  it("states the read is advisory: capture re-checks and stays the authority", () => {
    expect(text()).toMatch(/Advisory, not a reservation/);
    expect(text()).toMatch(/`captureSale` re-checks every payer under lock\s+and stays the only authority/);
    expect(text()).toMatch(/MUST NOT treat `chargeable: true` as a guarantee/);
  });

  it("states that v1 needs no offline freshness rule", () => {
    expect(text()).toMatch(/Option A forbids offline credit/);
    expect(text()).toMatch(/defines\s+NO offline freshness, expiry, cache-validity or staleness rule/);
    expect(text()).toMatch(/MUST NOT persist the result for use while offline/);
  });

  it("orders by payerRef so the cursor never carries a name", () => {
    expect(text()).toMatch(/`payerRef` descending/);
    expect(text()).toMatch(/encodes only the last `payerRef`/);
  });

  it("orders the outcomes 401, 403, 400, 200", () => {
    expect(text()).toMatch(/401 \(envelope\s+authentication\), then 403 `sale_responsibility_role_refused`, then 400/);
  });
});

// ===========================================================================
// 7. AJV fixtures
// ===========================================================================
describe("pos-payers — AJV fixtures", () => {
  it("accepts a linked chargeable payer and an unlinked non-chargeable one", () => {
    expect(validator("PosPayer")(linkedPayer)).toBe(true);
    expect(validator("PosPayer")(unlinkedPayer)).toBe(true);
  });

  it("accepts a page, and an empty last page", () => {
    const page = validator("PosPayerPage");
    expect(page({ items: [linkedPayer, unlinkedPayer], nextCursor: "abc_DEF-123", asOf: AS_OF })).toBe(true);
    expect(page({ items: [], nextCursor: null, asOf: AS_OF })).toBe(true);
  });

  it.each([
    ["a linked payer that is not chargeable (a future credit hold)", { ...linkedPayer, chargeable: false }, true],
    ["an unlinked payer marked chargeable", { ...unlinkedPayer, chargeable: true }, false],
    ["the ERPNext identifier", { ...linkedPayer, externalRef: "CUST-0001" }, false],
    ["a storeId", { ...linkedPayer, storeId: PAYER_B }, false],
    ["a status", { ...linkedPayer, status: "active" }, false],
    ["a credit limit", { ...linkedPayer, creditLimit: "1000.0000" }, false],
    ["a missing chargeable", { payerRef: PAYER_A, displayName: "X", category: "insurer", erpCustomerLinked: true }, false],
    ["an unknown category", { ...linkedPayer, category: "individual" }, false],
    ["a non-UUID payerRef", { ...linkedPayer, payerRef: "not-a-uuid" }, false],
    ["an empty displayName", { ...linkedPayer, displayName: "" }, false],
  ])("item with %s -> valid: %s", (_label, item, valid) => {
    expect(validator("PosPayer")(item)).toBe(valid);
  });

  it.each([
    ["no asOf", { items: [], nextCursor: null }],
    ["no nextCursor", { items: [], asOf: AS_OF }],
    ["more than 200 items", { items: Array.from({ length: 201 }, () => linkedPayer), nextCursor: null, asOf: AS_OF }],
    ["an extra field", { items: [], nextCursor: null, asOf: AS_OF, total: 0 }],
  ])("rejects a page with %s", (_label, page) => {
    expect(validator("PosPayerPage")(page)).toBe(false);
  });

  it("validates the error envelope, with the optional 400 validation details, and rejects any other field", () => {
    const error = { error: { code: "sale_responsibility_role_refused", message: "forbidden", request_id: "req-1" } };
    expect(validator("Error")(error)).toBe(true);
    const details = [{ path: ["page_size"], message: "Too big", code: "too_big" }];
    expect(validator("Error")({ error: { ...error.error, code: "validation_error", details } })).toBe(true);
    expect(validator("Error")({ error: { ...error.error, details: "not-an-array" } })).toBe(false);
    expect(validator("Error")({ error: { code: "x", message: "y" } })).toBe(false);
    expect(validator("Error")({ error: { ...error.error, payerRef: PAYER_A } })).toBe(false);
    expect(validator("Error")({ ...error, payerRef: PAYER_A })).toBe(false);
  });
});
