/**
 * apps/api/test/pos-cashier-admissions/pos-cashier-admissions.contract.spec.ts
 *
 * RT-113 BC1: the device-authenticated `cashier-admissions` contract
 * (Jira RT-113 comment 10763, decisions D2 / D11; `[GATED]` approval in
 * comment 10823). Triggered by RT-182 (comment 10822): the POS cashier path
 * called the operator-identity-gated roster / active-session routes with no
 * credential and got 401.
 *
 * Structural / load-only, plus AJV fixtures against the contract schemas.
 * No app boot and no HTTP: the runtime (RT-113 BC2) is exercised by the
 * cashier-admissions integration specs beside this file. What this pins:
 *
 *   1. The three operations and their paths; since RT-113 BC2 they are
 *      implemented, so no operation carries `x-runtime-status: contract-only`.
 *   2. Security is the existing role-named `device` scheme (opaque bearer, no
 *      JWT); no operator credential; no client-supplied scope anywhere.
 *   3. The admission request is a union on `mode` with the 10763 §3 fields;
 *      `idempotency_key` follows the platform 16-128 printable-ASCII rule.
 *   4. Response variants: `admitted` (the 10763 fields), minimum-disclosure
 *      `active_elsewhere`, generic 403 `refused`, 401, 409, `ended`, roster.
 *   5. No PIN / hash / secret / contact field in any schema.
 *   6. AJV fixtures: valid payloads pass, each invalid one fails.
 *   7. pos-operators 1.1.1-draft: the prose no longer claims a device-token
 *      header or device-token branch scope (RT-182), and nothing in its
 *      security or schemas changed.
 *   8. pos-operators 1.2.0-draft (RT-208, `[GATED]` approval in RT-208
 *      comment 10855): the roster `branch_id` query parameter is declared
 *      `required: true`, matching the runtime's `branch_id_required` refusal.
 *      The refusal stays the generic 401; no other parameter changed.
 *   9. pos-cashier-admissions 1.1.0-draft (RT-219, `[GATED]` approval in
 *      RT-219 comment 10877): `admitted` carries the opaque
 *      `admission_generation`, and `end` takes an OPTIONAL body echoing it; a
 *      stale echo is a no-op `ended`, an absent one ends as before.
 */
import "reflect-metadata";

import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";

import { loadOpenApiContracts } from "../../src/openapi/loader";

const CONTRACT_ID = "pos-cashier-admissions.openapi";
const OPERATORS_ID = "pos-operators.openapi";

interface Route {
  readonly path: string;
  readonly method: "get" | "post";
}

const ADMIT: Route = { path: "/api/pos/v1/cashier-admissions", method: "post" };
const END: Route = { path: "/api/pos/v1/cashier-admissions/{admission_id}/end", method: "post" };
const ROSTER: Route = { path: "/api/pos/v1/cashier-admissions/roster", method: "get" };

const SCHEMA_NAMES = [
  "PosCashierAdmissionRequest",
  "PosCashierAdmissionOnlineRequest",
  "PosCashierAdmissionReconcileRequest",
  "AdmissionIdempotencyKey",
  "PosCashierAdmissionResponse",
  "PosCashierAdmissionAdmitted",
  "PosCashierAdmissionActiveElsewhere",
  "PosCashierAdmissionEnded",
  "PosCashierAdmissionEndRequest",
  "AdmissionGeneration",
  "PosCashierRosterResponse",
  "PosCashierRosterEntry",
  "RefusedError",
] as const;
type SchemaName = (typeof SCHEMA_NAMES)[number];

type Status = "200" | "400" | "401" | "403" | "409" | "429";

const OPERATOR_OPERATION_IDS = [
  "posOperatorSignIn",
  "posOperatorSignOut",
  "posOperatorRoster",
  "posOperatorTakeoverConfirm",
  "posOperatorActiveSession",
] as const;
type OperatorOperationId = (typeof OPERATOR_OPERATION_IDS)[number];

const OPERATION_IDS = [
  "posCreateCashierAdmission",
  "posEndCashierAdmission",
  "posListCashierAdmissionRoster",
] as const;

interface ParameterObject {
  in?: string;
  name?: string;
  required?: boolean;
  schema?: Record<string, unknown>;
  description?: string;
}

interface OperationObject {
  operationId?: string;
  description?: string;
  security?: Array<Record<string, unknown>>;
  parameters?: ParameterObject[];
  requestBody?: unknown;
  responses?: Record<string, unknown>;
  "x-runtime-status"?: string;
  "x-runtime-note"?: string;
  "x-idempotency"?: string;
}

type SchemaObject = Record<string, unknown> & {
  required?: string[];
  properties?: Record<string, Record<string, unknown>>;
  additionalProperties?: unknown;
  oneOf?: Array<{ $ref?: string }>;
  discriminator?: { propertyName?: string; mapping?: Record<string, string> };
};

interface OpenApiDocument {
  openapi?: string;
  info?: { title?: string; version?: string; description?: string };
  paths?: Record<string, Record<string, OperationObject>>;
  components?: {
    schemas?: Record<string, SchemaObject>;
    responses?: Record<string, { content?: Record<string, { schema?: { $ref?: string } }> }>;
    securitySchemes?: Record<string, Record<string, unknown>>;
  };
}

let doc: OpenApiDocument;
let operatorsDoc: OpenApiDocument;
let otherOperationIds: Set<string>;
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);

beforeAll(() => {
  const contracts = loadOpenApiContracts();
  const found = contracts.find((c) => c.id === CONTRACT_ID);
  if (!found) throw new Error(`${CONTRACT_ID} not found in packages/contracts/openapi/`);
  doc = found.document as OpenApiDocument;
  operatorsDoc = contracts.find((c) => c.id === OPERATORS_ID)!.document as OpenApiDocument;

  otherOperationIds = new Set<string>();
  for (const c of contracts) {
    if (c.id === CONTRACT_ID) continue;
    for (const item of Object.values((c.document as OpenApiDocument).paths ?? {})) {
      for (const op of Object.values(item)) {
        if (typeof op?.operationId === "string") otherOperationIds.add(op.operationId);
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

function allOperations(): OperationObject[] {
  return Object.values(doc.paths ?? {}).flatMap((item) => Object.values(item));
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

interface ResponseObject {
  $ref?: string;
  content?: Record<string, { schema?: { $ref?: string } }>;
}

/** Follows a `#/components/responses/<Name>` reference; inline responses pass through. */
function resolveResponse(response: ResponseObject): ResponseObject {
  if (!response.$ref) return response;
  const name = response.$ref.replace("#/components/responses/", "");
  return doc.components?.responses?.[name] ?? {};
}

function contentSchemaRef(response: ResponseObject): string | undefined {
  return response.content?.["application/json"]?.schema?.$ref;
}

/** The JSON body schema `$ref` an operation declares for `status`, if any. */
function responseRef(route: Route, status: Status): string | undefined {
  const response = op(route).responses?.[status] as ResponseObject | undefined;
  return response ? contentSchemaRef(resolveResponse(response)) : undefined;
}

const USER_ID = "0190f5a2-3b4c-7d8e-9f01-23456789abcd";
const ADMISSION_ID = "0190f5a2-3b4c-7d8e-9f01-000000000001";
const KEY = "pos-pulse:4f6f1c1e-8a52-4c1b-9a0e-6d1f2b3c4d5e";

// ===========================================================================
// 1. Document + operations
// ===========================================================================
describe("pos-cashier-admissions — document and operations", () => {
  it("is an OpenAPI 3.1 document at version 1.1.0-draft", () => {
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info?.version).toBe("1.1.0-draft");
  });

  it("declares exactly the three 10763 §3 operations at their paths", () => {
    expect(op(ADMIT).operationId).toBe("posCreateCashierAdmission");
    expect(op(END).operationId).toBe("posEndCashierAdmission");
    expect(op(ROSTER).operationId).toBe("posListCashierAdmissionRoster");
    expect(allOperations().map((o) => o.operationId).sort()).toEqual([...OPERATION_IDS].sort());
  });

  it("collides with no operationId in any other contract", () => {
    expect(OPERATION_IDS.filter((id) => otherOperationIds.has(id))).toEqual([]);
  });

  it.each(OPERATION_IDS)("%s is implemented (RT-113 BC2): no contract-only marker or note", (id) => {
    const o = allOperations().find((x) => x.operationId === id)!;
    expect(o["x-runtime-status"]).toBeUndefined();
    expect(o["x-runtime-note"]).toBeUndefined();
  });

  it("the info prose no longer calls the surface contract-only", () => {
    expect(doc.info?.description ?? "").not.toMatch(/Contract-only \(BC1\)/);
    expect(doc.info?.description ?? "").toMatch(/Implemented \(RT-113 BC2;/);
  });
});

// ===========================================================================
// 2. Security: the existing `device` scheme, scope from the device only
// ===========================================================================
describe("pos-cashier-admissions — device security and scope", () => {
  it("defines only the `device` scheme: http bearer, opaque (no bearerFormat JWT)", () => {
    const schemes = doc.components?.securitySchemes ?? {};
    expect(Object.keys(schemes)).toEqual(["device"]);
    expect(schemes["device"]?.["type"]).toBe("http");
    expect(schemes["device"]?.["scheme"]).toBe("bearer");
    expect(schemes["device"]?.["bearerFormat"]).toBeUndefined();
  });

  it("reuses the read-down `device` scheme definition (same type, scheme and format)", () => {
    const readDown = loadOpenApiContracts({
      dir: `${__dirname}/../../../../packages/contracts/openapi/catalog`,
    }).find((c) => c.id === "read-down")!.document as OpenApiDocument;
    const theirs = readDown.components?.securitySchemes?.["device"] ?? {};
    const ours = doc.components?.securitySchemes?.["device"] ?? {};
    expect({ type: ours["type"], scheme: ours["scheme"], bearerFormat: ours["bearerFormat"] }).toEqual({
      type: theirs["type"],
      scheme: theirs["scheme"],
      bearerFormat: theirs["bearerFormat"],
    });
  });

  it.each(OPERATION_IDS)("%s requires `device` and nothing else", (id) => {
    const o = allOperations().find((x) => x.operationId === id)!;
    expect(o.security).toEqual([{ device: [] }]);
  });

  it("no operation takes a tenant / branch / store / terminal / device parameter", () => {
    const scopeNames = ["tenant_id", "branch_id", "store_id", "terminal_id", "device_id"];
    for (const o of allOperations()) {
      for (const p of o.parameters ?? []) {
        expect(scopeNames).not.toContain(p.name);
      }
    }
    expect(op(ROSTER).parameters ?? []).toEqual([]);
  });

  it("no request schema carries a scope field", () => {
    const scopeNames = ["tenant_id", "branch_id", "store_id", "terminal_id", "device_id"];
    for (const name of ["PosCashierAdmissionOnlineRequest", "PosCashierAdmissionReconcileRequest"] as const) {
      const keys = Object.keys(schema(name).properties ?? {});
      for (const forbidden of scopeNames) expect(keys).not.toContain(forbidden);
    }
  });
});

// ===========================================================================
// 3. Admission request: union on `mode`, idempotency
// ===========================================================================
describe("pos-cashier-admissions — admission request", () => {
  it("is a oneOf discriminated on `mode` with the online and reconcile variants", () => {
    const s = schema("PosCashierAdmissionRequest");
    expect(s.discriminator?.propertyName).toBe("mode");
    expect(Object.keys(s.discriminator?.mapping ?? {}).sort()).toEqual(["online", "reconcile_offline"]);
    expect(s.oneOf).toHaveLength(2);
  });

  it("online variant: user_id, mode, takeover?, idempotency_key — closed", () => {
    const s = schema("PosCashierAdmissionOnlineRequest");
    expect(Object.keys(s.properties ?? {}).sort()).toEqual(["idempotency_key", "mode", "takeover", "user_id"]);
    expect([...(s.required ?? [])].sort()).toEqual(["idempotency_key", "mode", "user_id"]);
    expect(s.additionalProperties).toBe(false);
  });

  it("reconcile variant: user_id, mode, offline_admitted_at (required), idempotency_key — closed, no takeover", () => {
    const s = schema("PosCashierAdmissionReconcileRequest");
    expect(Object.keys(s.properties ?? {}).sort()).toEqual([
      "idempotency_key",
      "mode",
      "offline_admitted_at",
      "user_id",
    ]);
    expect([...(s.required ?? [])].sort()).toEqual(["idempotency_key", "mode", "offline_admitted_at", "user_id"]);
    expect(s.additionalProperties).toBe(false);
  });

  it("idempotency_key uses the platform 16-128 printable-ASCII rule", () => {
    const s = schema("AdmissionIdempotencyKey");
    expect(s["type"]).toBe("string");
    expect(s["minLength"]).toBe(16);
    expect(s["maxLength"]).toBe(128);
    expect(s["pattern"]).toBe("^[\\x21-\\x7E]{16,128}$");
  });

  it("the create operation is x-idempotency: required and declares 409 for key reuse", () => {
    const o = op(ADMIT);
    expect(o["x-idempotency"]).toBe("required");
    expect(responseRef(ADMIT, "409")).toBe("#/components/schemas/Error");
  });
});

// ===========================================================================
// 4. Responses
// ===========================================================================
describe("pos-cashier-admissions — responses", () => {
  it("create declares 200 (union), 400, 401, 403 (refused), 409 and 429 (takeover rate limit)", () => {
    const o = op(ADMIT);
    expect(Object.keys(o.responses ?? {}).sort()).toEqual(["200", "400", "401", "403", "409", "429"]);
    expect(responseRef(ADMIT, "200")).toBe("#/components/schemas/PosCashierAdmissionResponse");
    expect(responseRef(ADMIT, "401")).toBe("#/components/schemas/Error");
    expect(responseRef(ADMIT, "403")).toBe("#/components/schemas/RefusedError");
  });

  it("the 200 union is discriminated on `kind`: admitted | active_elsewhere", () => {
    const s = schema("PosCashierAdmissionResponse");
    expect(s.discriminator?.propertyName).toBe("kind");
    expect(Object.keys(s.discriminator?.mapping ?? {}).sort()).toEqual(["active_elsewhere", "admitted"]);
  });

  it("admitted carries exactly the 10763 fields plus admission_ttl_seconds and admission_generation", () => {
    const s = schema("PosCashierAdmissionAdmitted");
    const fields = [
      "admission_generation",
      "admission_id",
      "admission_ttl_seconds",
      "display_name",
      "kind",
      "offline_grace_seconds",
      "server_time",
    ];
    expect(Object.keys(s.properties ?? {}).sort()).toEqual(fields);
    expect([...(s.required ?? [])].sort()).toEqual(fields);
    expect(s.additionalProperties).toBe(false);
    expect(s.properties?.["offline_grace_seconds"]?.["type"]).toBe("integer");
    expect(s.properties?.["admission_ttl_seconds"]?.["type"]).toBe("integer");
    expect(s.properties?.["admission_ttl_seconds"]?.["minimum"]).toBe(1);
  });

  it("active_elsewhere is minimum-disclosure: only `kind`", () => {
    const s = schema("PosCashierAdmissionActiveElsewhere");
    expect(Object.keys(s.properties ?? {})).toEqual(["kind"]);
    expect(s.additionalProperties).toBe(false);
  });

  it("403 is the canonical envelope with the single code `refused` and no details", () => {
    const err = schema("RefusedError").properties?.["error"] as SchemaObject;
    expect(Object.keys(err.properties ?? {}).sort()).toEqual(["code", "message", "request_id"]);
    expect((err.properties?.["code"] as { enum?: string[] }).enum).toEqual(["refused"]);
    expect(err.additionalProperties).toBe(false);
  });

  it("end declares 200 {kind: ended}, 400 and 401; its body is optional (RT-219)", () => {
    const o = op(END);
    expect(Object.keys(o.responses ?? {}).sort()).toEqual(["200", "400", "401"]);
    expect(responseRef(END, "200")).toBe("#/components/schemas/PosCashierAdmissionEnded");
    expect(o.requestBody).toEqual({
      required: false,
      content: { "application/json": { schema: { $ref: "#/components/schemas/PosCashierAdmissionEndRequest" } } },
    });
    const param = (o.parameters ?? []).find((p) => p.name === "admission_id");
    expect(param?.in).toBe("path");
    expect(param?.schema?.["format"]).toBe("uuid");
  });

  it("roster declares 200 and 401; entries are {user_id, operator_id, display_name}", () => {
    const o = op(ROSTER);
    expect(Object.keys(o.responses ?? {}).sort()).toEqual(["200", "401"]);
    const entry = schema("PosCashierRosterEntry");
    expect(Object.keys(entry.properties ?? {}).sort()).toEqual(["display_name", "operator_id", "user_id"]);
    expect(entry.additionalProperties).toBe(false);
  });
});

// ===========================================================================
// 5. No PIN, hash, secret or contact data anywhere
// ===========================================================================
describe("pos-cashier-admissions — secrets and PII", () => {
  const FORBIDDEN = /pin|hash|salt|password|secret|token|jwt|credential|email|phone|attestation/i;

  function ownPropertyKeys(obj: Record<string, unknown>): string[] {
    const props = obj["properties"];
    return props && typeof props === "object" ? Object.keys(props) : [];
  }

  /** Every `properties` key in a schema tree, depth-first (own keys first). */
  function propertyNames(node: unknown): string[] {
    if (Array.isArray(node)) return node.flatMap(propertyNames);
    if (!node || typeof node !== "object") return [];
    const obj = node as Record<string, unknown>;
    return [...ownPropertyKeys(obj), ...Object.values(obj).flatMap(propertyNames)];
  }

  it("no schema property is a PIN / hash / secret / token / contact field", () => {
    const names = propertyNames(doc.components?.schemas);
    expect(names.length).toBeGreaterThan(0);
    expect(names.filter((n) => FORBIDDEN.test(n))).toEqual([]);
  });

  it("no operation declares a header parameter (the credential is the security scheme only)", () => {
    for (const o of allOperations()) {
      expect((o.parameters ?? []).filter((p) => p.in === "header")).toEqual([]);
    }
  });
});

// ===========================================================================
// 6. AJV fixtures
// ===========================================================================
describe("pos-cashier-admissions — AJV fixtures", () => {
  const validRequests: Array<[string, unknown]> = [
    ["online", { mode: "online", user_id: USER_ID, idempotency_key: KEY }],
    ["online takeover", { mode: "online", user_id: USER_ID, takeover: true, idempotency_key: KEY }],
    [
      "reconcile",
      { mode: "reconcile_offline", user_id: USER_ID, offline_admitted_at: "2026-10-04T08:15:00Z", idempotency_key: KEY },
    ],
  ];
  const invalidRequests: Array<[string, unknown]> = [
    ["missing idempotency_key", { mode: "online", user_id: USER_ID }],
    ["short idempotency_key", { mode: "online", user_id: USER_ID, idempotency_key: "short" }],
    ["whitespace in idempotency_key", { mode: "online", user_id: USER_ID, idempotency_key: "has space 0123456789" }],
    ["unknown mode", { mode: "offline", user_id: USER_ID, idempotency_key: KEY }],
    ["user_id not a uuid", { mode: "online", user_id: "user_2abc", idempotency_key: KEY }],
    ["reconcile without offline_admitted_at", { mode: "reconcile_offline", user_id: USER_ID, idempotency_key: KEY }],
    [
      "takeover on reconcile",
      {
        mode: "reconcile_offline",
        user_id: USER_ID,
        offline_admitted_at: "2026-10-04T08:15:00Z",
        takeover: true,
        idempotency_key: KEY,
      },
    ],
    [
      "offline_admitted_at on online",
      { mode: "online", user_id: USER_ID, offline_admitted_at: "2026-10-04T08:15:00Z", idempotency_key: KEY },
    ],
    ["client-supplied branch_id", { mode: "online", user_id: USER_ID, idempotency_key: KEY, branch_id: USER_ID }],
    ["a PIN on the wire", { mode: "online", user_id: USER_ID, idempotency_key: KEY, pin: "1234" }],
  ];

  it.each(validRequests)("request %s validates", (_label, body) => {
    const v = validator("PosCashierAdmissionRequest");
    expect(v(body)).toBe(true);
  });

  it.each(invalidRequests)("request with %s is rejected", (_label, body) => {
    const v = validator("PosCashierAdmissionRequest");
    expect(v(body)).toBe(false);
  });

  const admitted = {
    kind: "admitted",
    admission_id: ADMISSION_ID,
    offline_grace_seconds: 86400,
    admission_ttl_seconds: 43200,
    server_time: "2026-10-04T08:15:01Z",
    display_name: "Mona A.",
    admission_generation: "1791123301000123",
  };

  it("admitted and active_elsewhere responses validate", () => {
    const v = validator("PosCashierAdmissionResponse");
    expect(v(admitted)).toBe(true);
    expect(v({ kind: "active_elsewhere" })).toBe(true);
  });

  it.each<[string, unknown]>([
    ["active_elsewhere disclosing a terminal", { kind: "active_elsewhere", terminal_id: ADMISSION_ID }],
    ["admitted without offline_grace_seconds", { ...admitted, offline_grace_seconds: undefined }],
    ["negative offline_grace_seconds", { ...admitted, offline_grace_seconds: -1 }],
    ["fractional offline_grace_seconds", { ...admitted, offline_grace_seconds: 1.5 }],
    ["admitted without admission_ttl_seconds", { ...admitted, admission_ttl_seconds: undefined }],
    ["zero admission_ttl_seconds", { ...admitted, admission_ttl_seconds: 0 }],
    ["fractional admission_ttl_seconds", { ...admitted, admission_ttl_seconds: 1.5 }],
    ["admitted with an extra field", { ...admitted, operator_id: "user_2abc" }],
    ["admitted without admission_generation", { ...admitted, admission_generation: undefined }],
    ["empty admission_generation", { ...admitted, admission_generation: "" }],
    ["non-string admission_generation", { ...admitted, admission_generation: 1791123301000123 }],
    ["unknown kind", { kind: "refused" }],
  ])("response %s is rejected", (_label, body) => {
    const v = validator("PosCashierAdmissionResponse");
    expect(v(JSON.parse(JSON.stringify(body)))).toBe(false);
  });

  it("the 403 envelope accepts only code `refused` and no details", () => {
    const v = validator("RefusedError");
    expect(v({ error: { code: "refused", message: "Forbidden", request_id: "r-1" } })).toBe(true);
    expect(v({ error: { code: "role_ineligible", message: "Forbidden", request_id: "r-1" } })).toBe(false);
    expect(v({ error: { code: "refused", message: "Forbidden", request_id: "r-1", details: {} } })).toBe(false);
    expect(v({ error: { code: "refused", message: "Forbidden" } })).toBe(false);
  });

  it("ended and roster bodies validate; a roster entry with extra data is rejected", () => {
    expect(validator("PosCashierAdmissionEnded")({ kind: "ended" })).toBe(true);
    const roster = validator("PosCashierRosterResponse");
    const entry = { user_id: USER_ID, operator_id: "user_2abc", display_name: "Mona A." };
    expect(roster({ cashiers: [] })).toBe(true);
    expect(roster({ cashiers: [entry] })).toBe(true);
    expect(roster({ cashiers: [{ ...entry, role: "cashier" }] })).toBe(false);
    expect(roster({ cashiers: [{ ...entry, email: "m@example.com" }] })).toBe(false);
  });
});

// ===========================================================================
// 7. Captain decisions on review of #696 (P1 liveness/TTL, P2 replay, order,
//    same-device re-admission, audit + takeover rate limit). Owner to confirm.
// ===========================================================================
describe("pos-cashier-admissions — liveness, replay, ordering and audit rules", () => {
  /** One folded-YAML paragraph of the create operation's description. */
  function createParagraph(marker: RegExp): string {
    const found = (op(ADMIT).description ?? "").split("\n").find((para) => marker.test(para));
    if (!found) throw new Error(`no create paragraph matches ${marker}`);
    return found;
  }

  it("P1: an online-confirmed session heartbeats with mode online, takeover false, inside the TTL", () => {
    const p = createParagraph(/\*\*Heartbeat/);
    expect(p).toMatch(/MUST re-call/);
    expect(p).toMatch(/`mode: online`/);
    expect(p).toMatch(/`takeover: false`/);
    expect(p).toMatch(/fresh `idempotency_key`/);
    expect(p).toMatch(/at most half of `admission_ttl_seconds`/);
  });

  it("P1: the TTL is on the wire: admitted returns the TTL actually applied, so a policy change reaches POS", () => {
    const ttl = String(schema("PosCashierAdmissionAdmitted").properties?.["admission_ttl_seconds"]?.["description"]);
    expect(ttl).toMatch(/MUST return the TTL it actually applied/);
    expect(ttl).toMatch(/next heartbeat/);
    expect(ttl).toMatch(/at most half/);
    expect(doc.info?.description ?? "").not.toMatch(/is not on the wire/);
  });

  it("P1: heartbeat `admitted` renews the TTL with the same admission_id; `active_elsewhere` ends the session", () => {
    const p = createParagraph(/\*\*Heartbeat/);
    expect(p).toMatch(/renews the TTL/);
    expect(p).toMatch(/SAME `admission_id`/);
    expect(p).toMatch(/MUST end the local session at its next safe point/);
  });

  it("P1: admissions are serialised per (tenant, store, user); concurrent takeovers have exactly one winner", () => {
    const p = createParagraph(/\*\*Serialisation/);
    expect(p).toMatch(/serialised per `\(tenant, store, user\)`/);
    expect(p).toMatch(/exactly one winner/);
    expect(p).toMatch(/next heartbeat \(online\) or reconcile \(offline grant\)/);
  });

  it("P1: the takeover loser learns on its next heartbeat or reconcile (not reconcile only)", () => {
    const d = op(ADMIT).description ?? "";
    expect(d).not.toMatch(/learns of it on its next reconcile/);
    expect(createParagraph(/\*\*`mode: online`\*\*/)).toMatch(
      /learns on its next heartbeat \(online\) or reconcile \(offline grant\)/,
    );
  });

  it("P2: a same-key replay returns the original only while the admission is live and the user eligible", () => {
    const p = createParagraph(/\*\*Idempotency/);
    expect(p).toMatch(/ONLY while that admission is still the live one/);
    expect(p).toMatch(/still eligible/);
    expect(p).toMatch(/evaluated as new/);
    expect(p).toMatch(/MUST NOT exceed the admission TTL/);
    expect(p).toMatch(/exactly one is processed/);
    expect(p).not.toMatch(/The replay window is server policy \(BC2\)\.$/);
  });

  it("P2: outcomes are evaluated 401, then 403, then active_elsewhere, then admitted", () => {
    const p = createParagraph(/\*\*Outcome order/);
    const order = ["401", "403", "`active_elsewhere`", "`admitted`"].map((t) => p.indexOf(t));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(p).toMatch(/A revoked user never sees `active_elsewhere`/);
  });

  it("P2: same device + same user + live admission returns the SAME admission_id and renews the TTL", () => {
    const d = op(ADMIT).description ?? "";
    expect(d).not.toMatch(/may differ/);
    const p = createParagraph(/already held by THIS device/);
    expect(p).toMatch(/SAME `admission_id`/);
    expect(p).toMatch(/renews the TTL/);
  });

  it("every takeover and every end is audited with device_id, user_id and the prior admission_id", () => {
    for (const d of [createParagraph(/\*\*Audit/), op(END).description ?? ""]) {
      expect(d).toMatch(/`device_id`/);
      expect(d).toMatch(/`user_id`/);
      expect(d).toMatch(/prior `admission_id`/);
    }
  });

  it("takeover is rate-limited per device and declares 429 with the canonical envelope", () => {
    expect(responseRef(ADMIT, "429")).toBe("#/components/schemas/Error");
    const takeover = schema("PosCashierAdmissionOnlineRequest").properties?.["takeover"];
    expect(String(takeover?.["description"])).toMatch(/rate-limited per device/);
  });
});

// ===========================================================================
// 7b. RT-219 (`[GATED]` approval: RT-219 comment 10877): a stale `end` can
//     never end a renewed admission. `admitted` carries an opaque
//     `admission_generation`; `end` optionally echoes it.
// ===========================================================================
describe("pos-cashier-admissions — RT-219 end generation guard", () => {
  const GENERATION_REF = { $ref: "#/components/schemas/AdmissionGeneration" };

  it("the version note names RT-219, its approval and the additive change", () => {
    const note = (doc.info?.description ?? "").split("\n").find((para) => para.startsWith("1.1.0-draft (RT-219"));
    expect(note).toBeDefined();
    expect(note).toMatch(/RT-219 comment 10877/);
    expect(note).toMatch(/`admission_generation`/);
    expect(note).toMatch(/optional/i);
    expect(note).toMatch(/no-op/);
    expect(note).toMatch(/as in 1\.0\.0-draft/);
  });

  it("AdmissionGeneration is an opaque, bounded, printable-ASCII string", () => {
    const g = schema("AdmissionGeneration");
    expect(g["type"]).toBe("string");
    expect(g["minLength"]).toBe(1);
    expect(g["maxLength"]).toBe(64);
    expect(g["pattern"]).toBe("^[\\x21-\\x7E]{1,64}$");
    const d = String(g["description"]);
    expect(d).toMatch(/opaque/i);
    expect(d).toMatch(/every `admitted` response/);
    expect(d).toMatch(/MUST NOT parse/);
  });

  it("admitted requires admission_generation, by reference to the one schema", () => {
    const s = schema("PosCashierAdmissionAdmitted");
    expect(s.required).toContain("admission_generation");
    expect(s.properties?.["admission_generation"]).toEqual(GENERATION_REF);
  });

  it("the end body is closed, with one OPTIONAL field echoing the same schema", () => {
    const s = schema("PosCashierAdmissionEndRequest");
    expect(s["type"]).toBe("object");
    expect(s.additionalProperties).toBe(false);
    expect(Object.keys(s.properties ?? {})).toEqual(["admission_generation"]);
    expect(s.properties?.["admission_generation"]).toEqual(GENERATION_REF);
    expect(s.required ?? []).toEqual([]);
  });

  it("the end prose states the three cases: stale → no-op ended, match → ended, absent → unconditional", () => {
    const d = op(END).description ?? "";
    const p = d.split("\n").find((para) => /\*\*Generation guard \(RT-219\)/.test(para));
    expect(p).toBeDefined();
    expect(p).toMatch(/not the admission's current generation/);
    expect(p).toMatch(/no-op/);
    expect(p).toMatch(/same `200 \{ kind: ended \}`/);
    expect(p).toMatch(/When it matches, the admission is ended/);
    expect(p).toMatch(/absent, the `end` is unconditional/);
    expect(p).toMatch(/serialisation/);
    expect(d).not.toMatch(/There is no request body/);
  });

  it("the end prose tells the terminal which value to echo and when to end again", () => {
    const d = op(END).description ?? "";
    expect(d).toMatch(/latest `admitted` response/);
    expect(d).toMatch(/end again/);
  });

  it("the replay rule says a replayed response keeps the generation it was issued with", () => {
    const p = (op(ADMIT).description ?? "").split("\n").find((para) => /^\*\*Idempotency/.test(para)) ?? "";
    expect(p).toMatch(/`admission_generation` it was issued with/);
  });

  it.each<[string, unknown]>([
    ["an empty object", {}],
    ["a generation", { admission_generation: "1791123301000123" }],
  ])("end request %s validates", (_label, body) => {
    expect(validator("PosCashierAdmissionEndRequest")(body)).toBe(true);
  });

  it.each<[string, unknown]>([
    ["an unknown field", { admission_generation: "1", reason: "sign_out" }],
    ["a scope field", { branch_id: USER_ID }],
    ["an empty generation", { admission_generation: "" }],
    ["a generation over 64 characters", { admission_generation: "1".repeat(65) }],
    ["a generation with whitespace", { admission_generation: "17911 23301" }],
    ["a numeric generation", { admission_generation: 1791123301000123 }],
    ["a null generation", { admission_generation: null }],
  ])("end request with %s is rejected", (_label, body) => {
    expect(validator("PosCashierAdmissionEndRequest")(body)).toBe(false);
  });
});

// ===========================================================================
// 8. pos-operators 1.1.1-draft prose fix (RT-182): docs match security + runtime
// ===========================================================================
describe("pos-operators — RT-113 BC1 prose fix", () => {
  function opById(id: OperatorOperationId): OperationObject {
    for (const item of Object.values(operatorsDoc.paths ?? {})) {
      for (const o of Object.values(item)) if (o.operationId === id) return o;
    }
    throw new Error(`${id} not found`);
  }

  it("no longer claims a device-token header", () => {
    expect(operatorsDoc.info?.description).not.toMatch(/device-token header \(per/);
    expect(operatorsDoc.info?.description).toMatch(/There is NO\s+device-token header/);
    expect(opById("posOperatorSignOut").description).not.toMatch(/device-token header/);
    expect(opById("posOperatorSignOut").description).toMatch(/No device credential is read/);
  });

  it("roster / active-session prose names the operator JWT, RT-150 and the cashier-admissions replacement", () => {
    for (const id of ["posOperatorRoster", "posOperatorActiveSession"] as const) {
      const d = opById(id).description ?? "";
      expect(d).not.toMatch(/resolved from the\s+device-token claim/);
      expect(d).toMatch(/no device token is read/);
      expect(d).toMatch(/RT-150/);
      expect(d).toMatch(/pos-cashier-admissions\.openapi\.yaml/);
    }
  });

  it("roster branch_id prose says the runtime requires it (no device-token fallback)", () => {
    const p = (opById("posOperatorRoster").parameters ?? []).find((x) => x.name === "branch_id");
    expect(p?.description).not.toMatch(/uses the device token's branch scope/);
    expect(p?.description).toMatch(/runtime REQUIRES it/);
  });

  it("keeps the security, the active-session parameters and RT-150-gated behaviour unchanged", () => {
    for (const id of OPERATOR_OPERATION_IDS) {
      expect(opById(id).security).toEqual([{ "operator-identity": [] }]);
    }
    // The roster parameter is pinned by the RT-208 block below.
    const active = (opById("posOperatorActiveSession").parameters ?? []).map((p) => [p.name, p.in, p.required]);
    expect(active).toEqual([
      ["branch_id", "query", true],
      ["operator_id", "query", true],
    ]);
  });
});

// ===========================================================================
// 9. pos-operators 1.2.0-draft (RT-208): roster branch_id is required
// ===========================================================================
describe("pos-operators — RT-208 roster branch_id required", () => {
  function opById(id: OperatorOperationId): OperationObject {
    for (const item of Object.values(operatorsDoc.paths ?? {})) {
      for (const o of Object.values(item)) if (o.operationId === id) return o;
    }
    throw new Error(`${id} not found`);
  }

  it("is bumped to 1.2.0-draft with an RT-208 version note", () => {
    expect(operatorsDoc.info?.version).toBe("1.2.0-draft");
    expect(operatorsDoc.info?.description).toMatch(/1\.2\.0-draft \(RT-208\)/);
  });

  it("declares the roster branch_id query parameter required (uuid), and nothing else", () => {
    const params = opById("posOperatorRoster").parameters ?? [];
    expect(params.map((p) => [p.name, p.in, p.required])).toEqual([["branch_id", "query", true]]);
    expect(params[0]?.schema).toEqual({ type: "string", format: "uuid" });
  });

  it("no longer says the parameter is declared optional", () => {
    const p = (opById("posOperatorRoster").parameters ?? []).find((x) => x.name === "branch_id");
    expect(p?.description).not.toMatch(/required: false/);
    expect(p?.description).not.toMatch(/separate, acknowledged contract change/);
  });

  it("keeps a missing branch_id inside the generic 401 refusal (runtime unchanged)", () => {
    const op = opById("posOperatorRoster");
    expect(Object.keys(op.responses ?? {}).sort()).toEqual(["200", "401"]);
    const unauthorized = (op.responses?.["401"] ?? {}) as { description?: string };
    expect(unauthorized.description).toMatch(/a missing\s+`branch_id`/);
  });
});
