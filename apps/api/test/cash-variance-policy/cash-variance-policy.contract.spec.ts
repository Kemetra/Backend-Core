/**
 * apps/api/test/cash-variance-policy/cash-variance-policy.contract.spec.ts
 *
 * RT-384 (AD-CASH-001 follow-up 1): the shift variance policy contract,
 * `cash-variance-policy.openapi.yaml` 1.0.0-draft. `[GATED]` contract; the
 * runtime is RT-387 on the RT-385 migration; since RT-387 no operation is
 * `x-runtime-status: contract-only` (the runtime ships them unchanged).
 *
 * Structural / load-only, plus AJV fixtures against the contract schemas. No
 * app boot and no HTTP. What this pins:
 *
 *   1. The seven operations at their paths, all implemented, with no
 *      operationId collision in any other contract.
 *   2. Auth: the POS read is `device` only; the Console operations are the
 *      human `cookieAuth` only. Scope never comes from a query or body field.
 *   3. Writes: `Idempotency-Key`, `expectedRevisionId`, the documented
 *      refusal codes and the AD-CASH-001 / coordinator decisions in prose.
 *   4. The D-1 policy value (explicit mode; exact-decimal limit + currency).
 *   5. Projections are strict and carry no tenant id, device id or PII.
 *   6. AJV fixtures: valid payloads pass, each invalid one fails, including
 *      every structural rule expressed with `if` / `then`.
 */
import "reflect-metadata";

import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";

import { loadOpenApiContracts } from "../../src/openapi/loader";

const CONTRACT_ID = "cash-variance-policy.openapi";

type Method = "get" | "post";
interface Route {
  readonly path: string;
  readonly method: Method;
}

const DEVICE_READ: Route = { path: "/api/pos/v1/store/cash-variance-policy", method: "get" };
const TENANT_READ: Route = { path: "/api/v1/tenants/{tenant_id}/cash-variance-policy", method: "get" };
const TENANT_REVISIONS: Route = { path: "/api/v1/tenants/{tenant_id}/cash-variance-policy/revisions", method: "get" };
const TENANT_PUBLISH: Route = { path: "/api/v1/tenants/{tenant_id}/cash-variance-policy/revisions", method: "post" };
const STORE_READ: Route = { path: "/api/v1/stores/{store_id}/cash-variance-policy", method: "get" };
const STORE_REVISIONS: Route = { path: "/api/v1/stores/{store_id}/cash-variance-policy/revisions", method: "get" };
const STORE_PUBLISH: Route = { path: "/api/v1/stores/{store_id}/cash-variance-policy/revisions", method: "post" };

const OPERATIONS = [
  ["posGetCashVariancePolicy", DEVICE_READ],
  ["consoleGetTenantCashVariancePolicy", TENANT_READ],
  ["consoleListTenantCashVariancePolicyRevisions", TENANT_REVISIONS],
  ["consolePublishTenantCashVariancePolicy", TENANT_PUBLISH],
  ["consoleGetStoreCashVariancePolicy", STORE_READ],
  ["consoleListStoreCashVariancePolicyRevisions", STORE_REVISIONS],
  ["consolePublishStoreCashVariancePolicyOverride", STORE_PUBLISH],
] as const;
const CONSOLE_OPERATIONS = OPERATIONS.filter(([id]) => id.startsWith("console"));
const WRITES = [
  ["consolePublishTenantCashVariancePolicy", TENANT_PUBLISH],
  ["consolePublishStoreCashVariancePolicyOverride", STORE_PUBLISH],
] as const;

interface ParameterObject {
  $ref?: string;
  in?: string;
  name?: string;
  required?: boolean;
  schema?: Record<string, unknown>;
  description?: string;
}

interface ResponseObject {
  $ref?: string;
  description?: string;
  headers?: Record<string, { $ref?: string }>;
  content?: Record<string, { schema?: Record<string, unknown> }>;
}

interface OperationObject {
  operationId?: string;
  description?: string;
  security?: Array<Record<string, unknown>>;
  parameters?: ParameterObject[];
  requestBody?: { required?: boolean; content?: Record<string, { schema?: { $ref?: string } }> };
  responses?: Record<string, ResponseObject>;
  "x-runtime-status"?: string;
  "x-runtime-note"?: string;
  "x-idempotency"?: string;
}

type SchemaObject = Record<string, unknown> & {
  required?: string[];
  properties?: Record<string, Record<string, unknown>>;
  additionalProperties?: unknown;
  enum?: unknown[];
};

interface PathItem {
  parameters?: ParameterObject[];
  get?: OperationObject;
  post?: OperationObject;
}

interface OpenApiDocument {
  openapi?: string;
  info?: { version?: string; description?: string };
  security?: Array<Record<string, unknown>>;
  paths?: Record<string, PathItem>;
  components?: {
    schemas?: Record<string, SchemaObject>;
    parameters?: Record<string, ParameterObject>;
    responses?: Record<string, ResponseObject>;
    securitySchemes?: Record<string, Record<string, unknown>>;
  };
}

let doc: OpenApiDocument;
let otherOperationIds: Set<string>;
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);

beforeAll(() => {
  const contracts = loadOpenApiContracts();
  const found = contracts.find((c) => c.id === CONTRACT_ID);
  if (!found) throw new Error(`${CONTRACT_ID} not found in packages/contracts/openapi/`);
  doc = found.document as OpenApiDocument;
  otherOperationIds = new Set<string>();
  for (const c of contracts) {
    if (c.id === CONTRACT_ID) continue;
    for (const item of Object.values((c.document as OpenApiDocument).paths ?? {})) {
      for (const o of Object.values(item) as OperationObject[]) {
        if (typeof o?.operationId === "string") otherOperationIds.add(o.operationId);
      }
    }
  }
  ajv.addSchema(doc as object, CONTRACT_ID);
});

function op(route: Route): OperationObject {
  const found = doc.paths?.[route.path]?.[route.method];
  if (!found) throw new Error(`${route.method.toUpperCase()} ${route.path} not declared`);
  return found;
}

function schema(name: string): SchemaObject {
  const s = doc.components?.schemas?.[name];
  if (!s) throw new Error(`schema ${name} not declared`);
  return s;
}

function validator(name: string): ValidateFunction {
  const v = ajv.getSchema(`${CONTRACT_ID}#/components/schemas/${name}`);
  if (!v) throw new Error(`ajv cannot resolve ${name}`);
  return v;
}

function resolveParameter(p: ParameterObject): ParameterObject {
  if (!p.$ref) return p;
  return doc.components?.parameters?.[p.$ref.replace("#/components/parameters/", "")] ?? {};
}

/** Path-level and operation-level parameters, refs resolved. */
function params(route: Route): ParameterObject[] {
  const pathLevel = doc.paths?.[route.path]?.parameters ?? [];
  return [...pathLevel, ...(op(route).parameters ?? [])].map(resolveParameter);
}

/** Follows a `#/components/responses/<Name>` reference; throws when it is not declared. */
function resolveResponse(ref: string): ResponseObject {
  const found = doc.components?.responses?.[ref.replace("#/components/responses/", "")];
  if (!found) throw new Error(`response ${ref} not declared`);
  return found;
}

function response(route: Route, status: string): ResponseObject {
  const r = op(route).responses?.[status];
  if (!r) throw new Error(`${route.path} declares no ${status}`);
  return r.$ref ? resolveResponse(r.$ref) : r;
}

function statusesOf(route: Route): string[] {
  return Object.keys(op(route).responses ?? {}).sort();
}

function flat(text: string | undefined): string {
  return (text ?? "").replace(/\s+/g, " ");
}

const REV_TENANT = "0190f5a2-3b4c-7d8e-9f01-0000000000a1";
const REV_STORE = "0190f5a2-3b4c-7d8e-9f01-0000000000a2";
const STORE_ID = "0190f5a2-3b4c-7d8e-9f01-000000000002";
const OWNER_ID = "0190f5a2-3b4c-7d8e-9f01-000000000003";
const ADMIN_ID = "0190f5a2-3b4c-7d8e-9f01-000000000004";

const NONE = { mode: "none" } as const;
const LIMIT = { mode: "limit", limitAmount: "50.00", currencyCode: "EGP" } as const;
const LIMIT_ZERO = { mode: "limit", limitAmount: "0", currencyCode: "EGP" } as const;

const SYSTEM_DEFAULT = { policySource: "system", policyRevisionId: null, policyValue: NONE } as const;
const TENANT_DEFAULT = { policySource: "tenant", policyRevisionId: REV_TENANT, policyValue: LIMIT } as const;

const TENANT_REVISION = {
  revisionId: REV_TENANT,
  scope: "tenant",
  storeId: null,
  kind: "set",
  policyValue: LIMIT,
  reason: "Chain-wide cash control",
  effectiveFrom: "2026-10-16T09:00:00.000Z",
  effectiveUntil: null,
  permanent: false,
  approvedByUserId: null,
  supersedesRevisionId: null,
  state: "current",
  createdByUserId: ADMIN_ID,
  createdAt: "2026-10-16T09:00:00.000Z",
} as const;

const STORE_REVISION = {
  ...TENANT_REVISION,
  revisionId: REV_STORE,
  scope: "store",
  storeId: STORE_ID,
  policyValue: { mode: "limit", limitAmount: "20.00", currencyCode: "EGP" },
  reason: "New staff during the season",
  effectiveUntil: "2026-12-31T00:00:00.000Z",
} as const;

const ACTIVE_OVERRIDE = {
  revisionId: REV_STORE,
  policyValue: STORE_REVISION.policyValue,
  reason: STORE_REVISION.reason,
  effectiveUntil: STORE_REVISION.effectiveUntil,
  permanent: false,
  approvedByUserId: null,
  createdByUserId: ADMIN_ID,
  createdAt: STORE_REVISION.createdAt,
} as const;

const STORE_POLICY = {
  storeId: STORE_ID,
  effective: { policySource: "store", policyRevisionId: REV_STORE, policyValue: STORE_REVISION.policyValue },
  tenantDefault: TENANT_DEFAULT,
  activeOverride: ACTIVE_OVERRIDE,
  latestRevisionId: REV_STORE,
  permanentOverrideHorizonDays: 90,
} as const;

const TENANT_POLICY = {
  tenantDefault: TENANT_DEFAULT,
  latestRevision: TENANT_REVISION,
  latestRevisionId: REV_TENANT,
} as const;

const DEVICE_POLICY = { ...TENANT_DEFAULT, serverTime: "2026-10-16T09:05:00.000Z" } as const;

const PUBLISH_TENANT = { expectedRevisionId: null, policyValue: LIMIT, reason: "Chain-wide cash control" } as const;
const PUBLISH_STORE_SET = {
  expectedRevisionId: REV_TENANT,
  kind: "set",
  policyValue: STORE_REVISION.policyValue,
  reason: "New staff during the season",
  effectiveUntil: "2026-12-31T00:00:00.000Z",
} as const;
const PUBLISH_STORE_CLEAR = { expectedRevisionId: REV_STORE, kind: "clear", reason: "Season over" } as const;

function without<T extends object>(value: T, key: keyof T): Omit<T, typeof key> {
  const copy = { ...value };
  delete copy[key];
  return copy;
}

// ===========================================================================
// 1. Document and operations
// ===========================================================================
describe("cash-variance-policy — document and operations", () => {
  it("is an OpenAPI 3.1 document at version 1.1.0-draft (RT-620)", () => {
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info?.version).toBe("1.1.0-draft");
  });

  it("declares exactly the seven operations", () => {
    const declared = Object.entries(doc.paths ?? {}).flatMap(([path, item]) =>
      (["get", "post"] as const).filter((m) => item[m]).map((m) => `${m.toUpperCase()} ${path} ${item[m]!.operationId}`),
    );
    expect(declared.sort()).toEqual(
      OPERATIONS.map(([id, r]) => `${r.method.toUpperCase()} ${r.path} ${id}`).sort(),
    );
  });

  it.each(OPERATIONS)("%s is implemented since RT-387 (no contract-only marker)", (_id, route) => {
    expect(op(route)["x-runtime-status"]).toBeUndefined();
    expect(op(route)["x-runtime-note"]).toBeUndefined();
  });

  it("collides with no operationId in any other contract", () => {
    expect(OPERATIONS.map(([id]) => id).filter((id) => otherOperationIds.has(id))).toEqual([]);
  });

  it("cites AD-CASH-001, the [GATED] posture and the coordinator decisions in the info", () => {
    const info = flat(doc.info?.description);
    expect(info).toContain("AD-CASH-001");
    expect(info).toContain("[GATED]");
    expect(info).toContain("RT-284 comment 11887");
    expect(info).toContain("90 days");
  });
});

// ===========================================================================
// 2. Auth and scope
// ===========================================================================
describe("cash-variance-policy — auth and scope", () => {
  it("the POS read accepts only the device bearer", () => {
    expect(op(DEVICE_READ).security).toEqual([{ device: [] }]);
    expect(doc.components!.securitySchemes!["device"]).toMatchObject({ type: "http", scheme: "bearer" });
    expect(doc.components!.securitySchemes!["device"]!["bearerFormat"]).toBeUndefined();
  });

  it.each(CONSOLE_OPERATIONS)("%s accepts only the human cookieAuth session", (_id, route) => {
    expect(op(route).security).toEqual([{ cookieAuth: [] }]);
  });

  it("defines exactly the device and cookieAuth schemes", () => {
    expect(Object.keys(doc.components?.securitySchemes ?? {}).sort()).toEqual(["cookieAuth", "device"]);
    expect(doc.components!.securitySchemes!["cookieAuth"]).toMatchObject({
      type: "apiKey",
      in: "cookie",
      name: "dp2_session",
    });
  });

  it("the POS read takes no scope parameter; store and tenant come from the device row", () => {
    expect(params(DEVICE_READ).map((p) => p.name)).toEqual(["If-None-Match"]);
    expect(flat(op(DEVICE_READ).description)).toContain("device row");
  });

  it.each([
    ["tenant_id", [TENANT_READ, TENANT_REVISIONS, TENANT_PUBLISH]],
    ["store_id", [STORE_READ, STORE_REVISIONS, STORE_PUBLISH]],
  ] as const)("the %s path parameter is a required uuid on its operations", (name, routes) => {
    for (const route of routes) {
      expect(params(route).find((p) => p.name === name)).toMatchObject({
        in: "path",
        required: true,
        schema: { type: "string", format: "uuid" },
      });
    }
  });

  it.each(CONSOLE_OPERATIONS)("%s refuses scope and role as the non-disclosing 404, never a 403 for scope", (_id, route) => {
    expect(statusesOf(route)).toContain("404");
    expect(flat(response(route, "404").description)).toMatch(/non-disclosing/i);
  });

  it("a request body never carries a tenant or store id", () => {
    for (const name of ["PublishTenantCashVariancePolicyRequest", "PublishStoreCashVariancePolicyOverrideRequest"]) {
      expect(Object.keys(schema(name).properties ?? {}).filter((k) => /tenant|store/i.test(k))).toEqual([]);
    }
  });

  it("states the role sets: configure = owner / tenant_admin, read effective = + store_manager", () => {
    expect(flat(op(STORE_READ).description)).toContain("`store_manager`");
    for (const route of [TENANT_READ, TENANT_REVISIONS, TENANT_PUBLISH, STORE_REVISIONS, STORE_PUBLISH]) {
      const text = flat(op(route).description);
      expect(text).toContain("`owner`");
      expect(text).toContain("`tenant_admin`");
      expect(text).not.toContain("`store_manager`");
    }
  });
});

// ===========================================================================
// 3. Writes
// ===========================================================================
describe("cash-variance-policy — writes", () => {
  it.each(WRITES)("%s requires the Idempotency-Key header", (_id, route) => {
    expect(op(route)["x-idempotency"]).toBe("required");
    expect(params(route).find((p) => p.name === "Idempotency-Key")).toMatchObject({
      in: "header",
      required: true,
      schema: { type: "string", minLength: 16, maxLength: 128, pattern: "^[\\x21-\\x7E]{16,128}$" },
    });
  });

  it.each([
    ["consolePublishTenantCashVariancePolicy", TENANT_PUBLISH, "PublishTenantCashVariancePolicyRequest", "TenantCashVariancePolicy"],
    ["consolePublishStoreCashVariancePolicyOverride", STORE_PUBLISH, "PublishStoreCashVariancePolicyOverrideRequest", "StoreCashVariancePolicy"],
  ] as const)("%s takes its strict body and answers 201 with the updated read", (_id, route, body, projection) => {
    expect(op(route).requestBody?.required).toBe(true);
    expect(op(route).requestBody?.content?.["application/json"]?.schema).toEqual({
      $ref: `#/components/schemas/${body}`,
    });
    expect(response(route, "201").content?.["application/json"]?.schema).toEqual({
      $ref: `#/components/schemas/${projection}`,
    });
    expect(response(route, "201").headers?.["Idempotent-Replayed"]).toEqual({
      $ref: "#/components/headers/IdempotentReplayed",
    });
  });

  const EXPECTED_STATUSES: Record<string, string[]> = {
    posGetCashVariancePolicy: ["200", "304", "400", "401", "500"],
    consoleGetTenantCashVariancePolicy: ["200", "400", "401", "404", "429", "500"],
    consoleListTenantCashVariancePolicyRevisions: ["200", "400", "401", "404", "429", "500"],
    consolePublishTenantCashVariancePolicy: ["201", "400", "401", "403", "404", "409", "422", "425", "429", "500"],
    consoleGetStoreCashVariancePolicy: ["200", "400", "401", "404", "429", "500"],
    consoleListStoreCashVariancePolicyRevisions: ["200", "400", "401", "404", "429", "500"],
    consolePublishStoreCashVariancePolicyOverride: ["201", "400", "401", "403", "404", "409", "422", "425", "429", "500"],
  };

  it.each(OPERATIONS)("%s declares exactly its documented statuses", (id, route) => {
    expect(statusesOf(route)).toEqual(EXPECTED_STATUSES[id]!.sort());
  });

  const CODES: Array<[string, Route, string, string[]]> = [
    ["tenant publish", TENANT_PUBLISH, "400", ["validation_error", "idempotency_key_required", "idempotency_key_malformed"]],
    ["tenant publish", TENANT_PUBLISH, "403", ["origin_rejected"]],
    ["tenant publish", TENANT_PUBLISH, "409", ["cash_variance_policy_changed_concurrently", "idempotency_key_conflict"]],
    ["tenant publish", TENANT_PUBLISH, "422", ["policy_currency_unsupported"]],
    ["tenant publish", TENANT_PUBLISH, "425", ["idempotency_in_progress"]],
    ["store publish", STORE_PUBLISH, "400", ["validation_error", "idempotency_key_required", "idempotency_key_malformed"]],
    ["store publish", STORE_PUBLISH, "403", ["origin_rejected", "owner_approval_required"]],
    ["store publish", STORE_PUBLISH, "409", ["cash_variance_policy_changed_concurrently", "idempotency_key_conflict"]],
    [
      "store publish",
      STORE_PUBLISH,
      "422",
      ["policy_currency_unsupported", "override_looser_than_tenant", "override_expiry_invalid", "override_not_active"],
    ],
  ];

  it.each(CODES)("%s %s documents error codes %j", (_label, route, status, codes) => {
    const text = response(route, status).description ?? "";
    expect(codes.filter((code) => !text.includes(`\`${code}\``))).toEqual([]);
  });

  it("the stale-write 409 names expectedRevisionId", () => {
    expect(flat(response(TENANT_PUBLISH, "409").description)).toContain("expectedRevisionId");
  });

  it("the store publish documents the permanent-override rule and the 90-day horizon (DR-4)", () => {
    const text = flat(op(STORE_PUBLISH).description);
    expect(text).toContain("90 days");
    expect(text).toContain("owner_approval_required");
    expect(text).toMatch(/only an `owner`/i);
  });

  it("states the L3 points for owner ratification: elapsed-time horizon, chaining, clearing a permanent override", () => {
    const text = flat(op(STORE_PUBLISH).description);
    expect(text).toContain("Pending owner ratification");
    expect(text).toContain("90 × 24 h");
    expect(text).toMatch(/chained/);
    expect(text).toMatch(/may `clear` an override, including an owner-approved permanent one/);
  });

  it("the store publish documents stricter-only (RT-284 Q5) and the order of checks", () => {
    const text = flat(op(STORE_PUBLISH).description);
    expect(text).toContain("stricter");
    expect(text).toContain("Order of checks");
  });

  it("every write documents its audit action", () => {
    expect(flat(op(TENANT_PUBLISH).description)).toContain("cash_variance_policy.changed");
    expect(flat(op(STORE_PUBLISH).description)).toContain("cash_variance_policy.changed");
    expect(flat(doc.info?.description)).toContain("cash_variance_policy.override_expired");
  });

  it("documents resolution: the stricter of the active override and the tenant default wins, a tie to the store", () => {
    const info = flat(doc.info?.description);
    expect(info).toMatch(/stricter of the two wins/i);
    expect(info).toMatch(/tie goes to the store/i);
  });

  it("documents that a change applies from each terminal's next cash-session open (K-2)", () => {
    expect(flat(doc.info?.description)).toMatch(/next cash-session open/i);
  });
});

// ===========================================================================
// 4. The POS read
// ===========================================================================
describe("cash-variance-policy — POS read", () => {
  it("is conditional: ETag on 200 and 304, If-None-Match in", () => {
    expect(response(DEVICE_READ, "200").headers?.["ETag"]).toEqual({ $ref: "#/components/headers/ETag" });
    expect(response(DEVICE_READ, "304").headers?.["ETag"]).toEqual({ $ref: "#/components/headers/ETag" });
    expect(response(DEVICE_READ, "304").content).toBeUndefined();
    expect(params(DEVICE_READ)[0]).toMatchObject({ in: "header", required: false });
  });

  it("computes the ETag over the resolved policy, not the server time", () => {
    const etag = flat((doc.components as Record<string, Record<string, { description?: string }>>)["headers"]!["ETag"]!.description);
    expect(etag).toContain("resolved");
    expect(etag).toContain("serverTime");
  });

  it("returns the device projection; its source is never fallback", () => {
    expect(response(DEVICE_READ, "200").content?.["application/json"]?.schema).toEqual({
      $ref: "#/components/schemas/DeviceCashVariancePolicy",
    });
    expect(schema("PolicySource").enum).toEqual(["system", "tenant", "store"]);
  });
});

// ===========================================================================
// 5. Value and projections
// ===========================================================================
describe("cash-variance-policy — value and projections", () => {
  const PROJECTIONS = [
    "CashVariancePolicyValue",
    "ResolvedCashVariancePolicy",
    "TenantResolvedCashVariancePolicy",
    "DeviceCashVariancePolicy",
    "CashVariancePolicyRevision",
    "TenantCashVariancePolicyRevisionPage",
    "StoreCashVariancePolicyRevisionPage",
    "ActiveStoreOverride",
    "TenantCashVariancePolicy",
    "StoreCashVariancePolicy",
    "PublishTenantCashVariancePolicyRequest",
    "PublishStoreCashVariancePolicyOverrideRequest",
  ];

  it.each(PROJECTIONS)("%s is strict", (name) => {
    expect(schema(name).additionalProperties).toBe(false);
  });

  it("projections carry no tenant id, device id or credential", () => {
    const forbidden = /tenantId|device|token|pin|secret|email|phone|name$/i;
    for (const name of PROJECTIONS) {
      expect(Object.keys(schema(name).properties ?? {}).filter((k) => forbidden.test(k))).toEqual([]);
    }
  });

  it("the mode is an explicit enum and the limit is an exact-decimal string plus a currency (DR-11)", () => {
    const value = schema("CashVariancePolicyValue");
    expect(value.properties!["mode"]).toMatchObject({ enum: ["none", "limit"] });
    expect(value.properties!["limitAmount"]).toEqual({ $ref: "#/components/schemas/NonNegativeDecimalAmount" });
    expect(value.properties!["currencyCode"]).toEqual({ $ref: "#/components/schemas/CurrencyCode" });
    expect(flat(value["description"] as string | undefined)).toContain("|variance| > limitAmount");
  });

  it("the store read exposes the 90-day horizon so the Console never invents it", () => {
    expect(schema("StoreCashVariancePolicy").properties!["permanentOverrideHorizonDays"]).toMatchObject({
      type: "integer",
      const: 90,
    });
  });

  it("revision pages are bounded and newest first", () => {
    for (const page of ["TenantCashVariancePolicyRevisionPage", "StoreCashVariancePolicyRevisionPage"]) {
      expect(schema(page).properties!["items"]).toMatchObject({ maxItems: 100 });
    }
    expect(params(TENANT_REVISIONS).find((p) => p.name === "page_size")?.schema).toMatchObject({
      minimum: 1,
      maximum: 100,
      default: 50,
    });
    expect(flat(op(STORE_REVISIONS).description)).toMatch(/newest first/i);
  });
});

// ===========================================================================
// 6. AJV fixtures
// ===========================================================================
describe("cash-variance-policy — AJV fixtures", () => {
  it("accepts the valid fixtures", () => {
    const cases: Array<[string, unknown]> = [
      ["CashVariancePolicyValue", NONE],
      ["CashVariancePolicyValue", LIMIT],
      ["CashVariancePolicyValue", LIMIT_ZERO],
      ["ResolvedCashVariancePolicy", SYSTEM_DEFAULT],
      ["ResolvedCashVariancePolicy", TENANT_DEFAULT],
      ["TenantResolvedCashVariancePolicy", SYSTEM_DEFAULT],
      ["DeviceCashVariancePolicy", DEVICE_POLICY],
      ["CashVariancePolicyRevision", TENANT_REVISION],
      ["CashVariancePolicyRevision", STORE_REVISION],
      [
        "CashVariancePolicyRevision",
        { ...STORE_REVISION, kind: "clear", policyValue: null, effectiveUntil: null, state: "superseded" },
      ],
      [
        "CashVariancePolicyRevision",
        { ...STORE_REVISION, effectiveUntil: null, permanent: true, approvedByUserId: OWNER_ID },
      ],
      ["ActiveStoreOverride", { ...ACTIVE_OVERRIDE, effectiveUntil: null, permanent: true, approvedByUserId: OWNER_ID }],
      ["ActiveStoreOverride", { ...ACTIVE_OVERRIDE, permanent: true, approvedByUserId: OWNER_ID }],
      ["TenantCashVariancePolicyRevisionPage", { items: [TENANT_REVISION], nextCursor: "eyJjIjoxfQ" }],
      ["StoreCashVariancePolicyRevisionPage", { items: [STORE_REVISION], nextCursor: null }],
      ["StoreCashVariancePolicyRevisionPage", { items: [], nextCursor: null }],
      ["CashVariancePolicyRevision", { ...STORE_REVISION, state: "expired" }],
      ["TenantCashVariancePolicy", TENANT_POLICY],
      ["TenantCashVariancePolicy", { tenantDefault: SYSTEM_DEFAULT, latestRevision: null, latestRevisionId: null }],
      ["StoreCashVariancePolicy", STORE_POLICY],
      [
        "StoreCashVariancePolicy",
        { ...STORE_POLICY, effective: SYSTEM_DEFAULT, tenantDefault: SYSTEM_DEFAULT, activeOverride: null, latestRevisionId: null },
      ],
      ["PublishTenantCashVariancePolicyRequest", PUBLISH_TENANT],
      ["PublishTenantCashVariancePolicyRequest", { ...PUBLISH_TENANT, policyValue: NONE, expectedRevisionId: REV_TENANT }],
      ["PublishStoreCashVariancePolicyOverrideRequest", PUBLISH_STORE_SET],
      ["PublishStoreCashVariancePolicyOverrideRequest", without(PUBLISH_STORE_SET, "effectiveUntil")],
      ["PublishStoreCashVariancePolicyOverrideRequest", PUBLISH_STORE_CLEAR],
    ];
    const failures = cases
      .map(([name, value]) => ({ name, value, ok: validator(name)(value) }))
      .filter((r) => !r.ok);
    expect(failures).toEqual([]);
  });

  it.each([
    ["CashVariancePolicyValue", "a limit without an amount", { mode: "limit", currencyCode: "EGP" }],
    ["CashVariancePolicyValue", "a limit without a currency", { mode: "limit", limitAmount: "1.00" }],
    ["CashVariancePolicyValue", "none with an amount", { mode: "none", limitAmount: "1.00" }],
    ["CashVariancePolicyValue", "none with a currency", { mode: "none", currencyCode: "EGP" }],
    ["CashVariancePolicyValue", "a numeric amount", { ...LIMIT, limitAmount: 50 }],
    ["CashVariancePolicyValue", "a negative amount", { ...LIMIT, limitAmount: "-1.00" }],
    ["CashVariancePolicyValue", "a lower-case currency", { ...LIMIT, currencyCode: "egp" }],
    ["CashVariancePolicyValue", "an unknown mode", { mode: "always" }],
    ["CashVariancePolicyValue", "an unknown key", { ...NONE, threshold: 0 }],
    ["ResolvedCashVariancePolicy", "a system source with a revision id", { ...SYSTEM_DEFAULT, policyRevisionId: REV_TENANT }],
    ["ResolvedCashVariancePolicy", "a tenant source without a revision id", { ...TENANT_DEFAULT, policyRevisionId: null }],
    ["ResolvedCashVariancePolicy", "a fallback source", { ...SYSTEM_DEFAULT, policySource: "fallback" }],
    ["ResolvedCashVariancePolicy", "a system source with a limit", { ...SYSTEM_DEFAULT, policyValue: LIMIT }],
    ["TenantResolvedCashVariancePolicy", "a system source with a limit", { ...SYSTEM_DEFAULT, policyValue: LIMIT_ZERO }],
    ["DeviceCashVariancePolicy", "a system source with a limit", { ...SYSTEM_DEFAULT, policyValue: LIMIT, serverTime: DEVICE_POLICY.serverTime }],
    ["TenantResolvedCashVariancePolicy", "a store source", { ...TENANT_DEFAULT, policySource: "store" }],
    ["DeviceCashVariancePolicy", "no server time", without(DEVICE_POLICY, "serverTime")],
    ["CashVariancePolicyRevision", "a set without a value", { ...TENANT_REVISION, policyValue: null }],
    ["CashVariancePolicyRevision", "a clear with a value", { ...STORE_REVISION, kind: "clear" }],
    ["CashVariancePolicyRevision", "a tenant revision with a store id", { ...TENANT_REVISION, storeId: STORE_ID }],
    ["CashVariancePolicyRevision", "a store revision without a store id", { ...STORE_REVISION, storeId: null }],
    ["CashVariancePolicyRevision", "a permanent override without an approver", { ...STORE_REVISION, permanent: true }],
    ["CashVariancePolicyRevision", "a no-expiry store set not marked permanent", { ...STORE_REVISION, effectiveUntil: null }],
    ["ActiveStoreOverride", "a no-expiry override not marked permanent", { ...ACTIVE_OVERRIDE, effectiveUntil: null }],
    ["ActiveStoreOverride", "a permanent override without an approver", { ...ACTIVE_OVERRIDE, effectiveUntil: null, permanent: true }],
    ["CashVariancePolicyRevision", "an unknown state", { ...TENANT_REVISION, state: "pending" }],
    ["CashVariancePolicyRevision", "an expired tenant revision", { ...TENANT_REVISION, state: "expired" }],
    ["CashVariancePolicyRevision", "an expired store clear", { ...STORE_REVISION, kind: "clear", policyValue: null, effectiveUntil: null, state: "expired" }],
    ["CashVariancePolicyRevision", "an expired store set with no expiry", { ...STORE_REVISION, effectiveUntil: null, permanent: true, approvedByUserId: OWNER_ID, state: "expired" }],
    ["TenantCashVariancePolicyRevisionPage", "a store revision on the tenant list", { items: [STORE_REVISION], nextCursor: null }],
    ["StoreCashVariancePolicyRevisionPage", "a tenant revision on the store list", { items: [TENANT_REVISION], nextCursor: null }],
    ["StoreCashVariancePolicyRevisionPage", "a mixed page", { items: [STORE_REVISION, TENANT_REVISION], nextCursor: null }],
    ["TenantCashVariancePolicy", "a store revision as the tenant's latest", { ...TENANT_POLICY, latestRevision: STORE_REVISION }],
    ["TenantCashVariancePolicy", "a system default with a latest revision", { ...TENANT_POLICY, tenantDefault: SYSTEM_DEFAULT }],
    ["TenantCashVariancePolicy", "a system default with only a latest revision id", { tenantDefault: SYSTEM_DEFAULT, latestRevision: null, latestRevisionId: REV_TENANT }],
    ["TenantCashVariancePolicy", "a tenant default with no latest revision", { tenantDefault: TENANT_DEFAULT, latestRevision: null, latestRevisionId: null }],
    ["TenantCashVariancePolicy", "a tenant default with no latest revision id", { ...TENANT_POLICY, latestRevisionId: null }],
    ["CashVariancePolicyRevision", "a missing reason", without(TENANT_REVISION, "reason")],
    ["StoreCashVariancePolicy", "another horizon", { ...STORE_POLICY, permanentOverrideHorizonDays: 30 }],
    ["StoreCashVariancePolicy", "a tenant default from a store", { ...STORE_POLICY, tenantDefault: STORE_POLICY.effective }],
    ["PublishTenantCashVariancePolicyRequest", "no expectedRevisionId key", without(PUBLISH_TENANT, "expectedRevisionId")],
    ["PublishTenantCashVariancePolicyRequest", "no reason", without(PUBLISH_TENANT, "reason")],
    ["PublishTenantCashVariancePolicyRequest", "an empty reason", { ...PUBLISH_TENANT, reason: "" }],
    ["PublishTenantCashVariancePolicyRequest", "a reason over 200", { ...PUBLISH_TENANT, reason: "x".repeat(201) }],
    ["PublishTenantCashVariancePolicyRequest", "an expiry on the tenant default", { ...PUBLISH_TENANT, effectiveUntil: "2027-01-01T00:00:00Z" }],
    ["PublishTenantCashVariancePolicyRequest", "a store id in the body", { ...PUBLISH_TENANT, storeId: STORE_ID }],
    ["PublishStoreCashVariancePolicyOverrideRequest", "a set without a value", without(PUBLISH_STORE_SET, "policyValue")],
    ["PublishStoreCashVariancePolicyOverrideRequest", "a clear with a value", { ...PUBLISH_STORE_CLEAR, policyValue: LIMIT }],
    ["PublishStoreCashVariancePolicyOverrideRequest", "a clear with an expiry", { ...PUBLISH_STORE_CLEAR, effectiveUntil: "2027-01-01T00:00:00Z" }],
    ["PublishStoreCashVariancePolicyOverrideRequest", "an unknown kind", { ...PUBLISH_STORE_SET, kind: "replace" }],
    ["PublishStoreCashVariancePolicyOverrideRequest", "a bad expiry", { ...PUBLISH_STORE_SET, effectiveUntil: "next month" }],
    ["PublishStoreCashVariancePolicyOverrideRequest", "no reason", without(PUBLISH_STORE_SET, "reason")],
  ] as const)("%s rejects %s", (name, _label, value) => {
    expect(validator(name)(value)).toBe(false);
  });

  it("accepts the canonical error envelope", () => {
    expect(validator("Error")({ error: { code: "not_found", message: "Not Found", request_id: REV_STORE } })).toBe(true);
    expect(validator("Error")({ code: "not_found" })).toBe(false);
  });
});
