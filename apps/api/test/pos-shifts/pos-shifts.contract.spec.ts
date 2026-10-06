/**
 * apps/api/test/pos-shifts/pos-shifts.contract.spec.ts
 *
 * RT-17 slice 1: the thin shift cash-up contract, `pos-shifts.openapi.yaml`
 * 1.0.0-draft -> 1.1.0-draft (additive). `[GATED]` approval: Jira RT-17
 * comment 10760 (owner authorization) + the owner's confirmation of the
 * 10919 design record (comment 10920, 2026-10-05).
 *
 * Structural / load-only, plus AJV fixtures against the contract schemas.
 * No app boot and no HTTP: the runtime is RT-17 slice 2, so the three new
 * operations are marked `x-runtime-status: contract-only`. What this pins:
 *
 *   1. Version bump and the RT-17 version note; `GET /shifts/stuck`, its
 *      `operator-identity` scheme and its schemas are unchanged.
 *   2. The three new operations (`openShift`, `recordCashMovement`,
 *      `closeShift`) at their paths, contract-only, with no operationId
 *      collision in any other contract.
 *   3. Security: `[operatorAuthorization] | [device]`, as on `captureSale`
 *      (RT-224), with the same scheme shapes as `pos-sales/sales.yaml`.
 *   4. The REQUIRED `Idempotency-Key` header (`^[\x21-\x7E]{16,128}$`) and
 *      the `Idempotent-Replayed` header on 200/201, reused from sales.yaml.
 *   5. Strict request bodies: fields, required lists, enums, formats.
 *   6. Money: the shared decimal components, the new `SignedDecimalAmount`
 *      and `PositiveDecimalAmount`, and the documented money semantics.
 *   7. The canonical error envelope and every documented `error.code`.
 *   8. AJV fixtures: the contract's own examples validate; valid payloads
 *      pass and each invalid one fails.
 *
 * RT-17 slice 2b-1 (same [GATED] approval): `openShift` and
 * `recordCashMovement` have routes, so they are no longer contract-only
 * (`closeShift` stays contract-only until 2b-2); the interceptor's real 425
 * `idempotency_in_progress` body and its 400 `idempotency_key_required` /
 * `idempotency_key_malformed` codes are documented; `openShift` states its
 * natural-key scoping (Codex P2, RT-17 comment 10925) and
 * `recordCashMovement` its path-shift replay scope (comment 10929).
 *
 * RT-17 slice 2b-2 (same [GATED] approval): `closeShift` has its route, so
 * no operation is contract-only; the info note states that an exact
 * envelope replay is answered before the stated user's live check (RT-17
 * comment 10931 #4), and `varianceApprovedByUserId` that the approver must
 * be a user of the caller's tenant while its role never refuses the close.
 * PR #714 round 1: `saleCount` declares the database integer maximum and
 * `cashRefundReturnRefs` at most 1000 items, as the runtime enforces.
 */
import "reflect-metadata";

import { resolve } from "node:path";

import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";

import { loadOpenApiContracts } from "../../src/openapi/loader";

const CONTRACT_ID = "pos-shifts.openapi";
const CONTRACTS_DIR = resolve(__dirname, "..", "..", "..", "..", "packages", "contracts", "openapi");

type Method = "get" | "post";
interface Route {
  readonly path: string;
  readonly method: Method;
}

const STUCK: Route = { path: "/api/pos/v1/shifts/stuck", method: "get" };
const OPEN: Route = { path: "/api/pos/v1/shifts", method: "post" };
const MOVEMENT: Route = { path: "/api/pos/v1/shifts/{shift_id}/cash-movements", method: "post" };
const CLOSE: Route = { path: "/api/pos/v1/shifts/{shift_id}/close", method: "post" };

const NEW_OPS = [
  ["openShift", OPEN],
  ["recordCashMovement", MOVEMENT],
  ["closeShift", CLOSE],
] as const;
const NEW_OPERATION_IDS = NEW_OPS.map(([id]) => id);

interface ParameterObject {
  $ref?: string;
  in?: string;
  name?: string;
  required?: boolean;
  schema?: Record<string, unknown>;
  description?: string;
}

interface MediaObject {
  schema?: { $ref?: string };
  examples?: Record<string, { $ref?: string; value?: unknown }>;
}

interface ResponseObject {
  $ref?: string;
  description?: string;
  headers?: Record<string, { $ref?: string; schema?: Record<string, unknown> }>;
  content?: Record<string, MediaObject>;
}

interface OperationObject {
  operationId?: string;
  description?: string;
  security?: Array<Record<string, unknown>>;
  parameters?: ParameterObject[];
  requestBody?: { required?: boolean; content?: Record<string, MediaObject> };
  responses?: Record<string, ResponseObject>;
  tags?: string[];
  "x-runtime-status"?: string;
  "x-runtime-note"?: string;
  "x-idempotency"?: string;
}

type SchemaObject = Record<string, unknown> & {
  type?: unknown;
  format?: string;
  pattern?: string;
  enum?: unknown[];
  required?: string[];
  properties?: Record<string, SchemaObject>;
  additionalProperties?: unknown;
  description?: string;
  items?: SchemaObject;
  $ref?: string;
  allOf?: SchemaObject[];
};

interface OpenApiDocument {
  openapi?: string;
  info?: { title?: string; version?: string; description?: string };
  paths?: Record<string, Record<string, OperationObject>>;
  components?: {
    schemas?: Record<string, SchemaObject>;
    responses?: Record<string, ResponseObject>;
    parameters?: Record<string, ParameterObject>;
    headers?: Record<string, { description?: string; schema?: Record<string, unknown> }>;
    examples?: Record<string, { value?: unknown }>;
    securitySchemes?: Record<string, Record<string, unknown>>;
  };
}

let doc: OpenApiDocument;
let salesDoc: OpenApiDocument;
let otherOperationIds: Set<string>;
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);

/** Every contract under openapi/, recursively (the loader is per-directory). */
function allContracts(): Array<{ id: string; dir: string; document: OpenApiDocument }> {
  const dirs = [
    "",
    "catalog",
    "connector",
    "erpnext-connector",
    "erpnext-reconciliation",
    "erpnext-sync-ops",
    "inventory",
    "pos-payments",
    "pos-sales",
    "sale-sync-ops",
    "settlement",
  ];
  return dirs.flatMap((sub) =>
    loadOpenApiContracts({ dir: resolve(CONTRACTS_DIR, sub) }).map((c) => ({
      id: c.id,
      dir: sub,
      document: c.document as OpenApiDocument,
    })),
  );
}

beforeAll(() => {
  const contracts = allContracts();
  const found = contracts.find((c) => c.dir === "" && c.id === CONTRACT_ID);
  if (!found) throw new Error(`${CONTRACT_ID} not found in packages/contracts/openapi/`);
  doc = found.document;
  salesDoc = contracts.find((c) => c.dir === "pos-sales" && c.id === "sales")!.document;

  otherOperationIds = new Set(
    contracts
      .filter((c) => !(c.dir === "" && c.id === CONTRACT_ID))
      .flatMap((c) => operationsOf(c.document))
      .map((o) => o.operationId)
      .filter((id): id is string => typeof id === "string"),
  );
  ajv.addSchema(doc as object, CONTRACT_ID);
});

/** Every operation object of a document, flattened. */
function operationsOf(document: OpenApiDocument): OperationObject[] {
  return Object.values(document.paths ?? {}).flatMap((item) => Object.values(item));
}

/** Every scheme name a document's operations reference. */
function referencedSchemes(document: OpenApiDocument): string[] {
  return operationsOf(document)
    .flatMap((o) => o.security ?? [])
    .flatMap((req) => Object.keys(req));
}

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

function resolveResponse(response: ResponseObject): ResponseObject {
  if (!response.$ref) return response;
  const name = response.$ref.replace("#/components/responses/", "");
  const found = doc.components?.responses?.[name];
  if (!found) throw new Error(`response ${name} not declared`);
  return found;
}

function response(route: Route, status: string): ResponseObject {
  const r = op(route).responses?.[status];
  if (!r) throw new Error(`${route.path} declares no ${status}`);
  return resolveResponse(r);
}

function resolveParameter(p: ParameterObject): ParameterObject {
  if (!p.$ref) return p;
  const name = p.$ref.replace("#/components/parameters/", "");
  return doc.components?.parameters?.[name] ?? {};
}

function requestSchemaRef(route: Route): string | undefined {
  return op(route).requestBody?.content?.["application/json"]?.schema?.$ref;
}

/** The parameters an operation declares, with component refs resolved. */
function parametersOf(route: Route): ParameterObject[] {
  return (op(route).parameters ?? []).map(resolveParameter);
}

/** One property of a component schema; throws when it is not declared. */
function prop(schemaName: string, field: string): SchemaObject {
  const p = schema(schemaName).properties?.[field];
  if (!p) throw new Error(`${schemaName}.${field} not declared`);
  return p;
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort();
}

/** A closed object schema with exactly `fields`, of which exactly `required` are required. */
function assertStrictObject(schemaName: string, fields: readonly string[], required: readonly string[]): void {
  const s = schema(schemaName);
  expect(s.additionalProperties).toBe(false);
  expect(sorted(Object.keys(s.properties ?? {}))).toEqual(sorted(fields));
  expect(sorted(s.required ?? [])).toEqual(sorted(required));
}

/** The JSON content of one of an operation's responses. */
function responseMedia(route: Route, status: string): MediaObject | undefined {
  return response(route, status).content?.["application/json"];
}

/** The JSON body schema of one of an operation's responses. */
function responseSchema(route: Route, status: string): unknown {
  return responseMedia(route, status)?.schema;
}

/** The status codes an operation declares, sorted. */
function statusesOf(route: Route): string[] {
  return sorted(Object.keys(op(route).responses ?? {}));
}

/** One security scheme of a document (empty when undefined). */
function securityScheme(document: OpenApiDocument, name: string): Record<string, unknown> {
  return document.components?.securitySchemes?.[name] ?? {};
}

/** A document's `IdempotencyKey` parameter component; throws when absent. */
function idempotencyKeyParameter(document: OpenApiDocument): ParameterObject {
  const p = document.components?.parameters?.["IdempotencyKey"];
  if (!p) throw new Error("IdempotencyKey parameter not declared");
  return p;
}

/** The JSON media objects of an operation: its request body and every response. */
function mediaOf(route: Route): MediaObject[] {
  const body = op(route).requestBody?.content?.["application/json"];
  const responses = Object.keys(op(route).responses ?? {}).map((status) => responseMedia(route, status));
  return [body, ...responses].filter((m): m is MediaObject => m !== undefined);
}

/** The schema name a `#/components/schemas/<Name>` reference points at. */
function schemaFor(ref: string): string {
  return ref.replace("#/components/schemas/", "");
}

/** An example's value, following a `#/components/examples/<Name>` reference. */
function exampleValue(raw: { $ref?: string; value?: unknown }): unknown {
  if (!raw.$ref) return raw.value;
  return doc.components?.examples?.[raw.$ref.replace("#/components/examples/", "")]?.value;
}

/** Every example of an operation, paired with the schema it must satisfy. */
function collectExamples(route: Route): Array<{ schemaName: string; value: unknown }> {
  return mediaOf(route)
    .filter((m) => m.schema?.$ref !== undefined)
    .flatMap((m) =>
      Object.values(m.examples ?? {}).map((raw) => ({
        schemaName: schemaFor(m.schema!.$ref!),
        value: exampleValue(raw),
      })),
    );
}

const PROSE_KEYS = new Set(["description", "example", "examples"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Drop prose so two copies of a shared component compare on shape only. */
function shape(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(shape);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([k]) => !PROSE_KEYS.has(k))
      .map(([k, v]) => [k, shape(v)]),
  );
}

const SHIFT_ID = "0192f5a2-3b4c-7d8e-9f01-23456789ab01";
const MOVEMENT_ID = "0192f5a2-3b4c-7d8e-9f01-23456789ab02";
const USER_ID = "0190f5a2-3b4c-7d8e-9f01-23456789abcd";
const MANAGER_ID = "0190f5a2-3b4c-7d8e-9f01-23456789abce";
const RETURN_ID = "0192f5a2-3b4c-7d8e-9f01-23456789ab03";

const VALID_OPEN = {
  shiftId: SHIFT_ID,
  openedAt: "2026-10-05T08:00:00Z",
  openingUserId: USER_ID,
  currencyCode: "EGP",
  openingFloat: "500.00",
};

const VALID_MOVEMENT = {
  movementId: MOVEMENT_ID,
  kind: "pay_out",
  amount: "120.00",
  reasonCode: "petty_expense",
  occurredAt: "2026-10-05T11:30:00Z",
};

/** `count` distinct return ids. */
const manyRefs = (count: number): string[] =>
  Array.from({ length: count }, (_v, i) => `0192f5a2-3b4c-7d8e-9f01-${i.toString(16).padStart(12, "0")}`);

const VALID_CLOSE = {
  closedAt: "2026-10-05T16:00:00Z",
  closingUserId: USER_ID,
  closeKind: "normal",
  openingFloat: "500.00",
  cashSalesTotal: "2450.00",
  cashRefundsTotal: "75.00",
  payInTotal: "0.00",
  payOutTotal: "120.00",
  expectedCash: "2755.00",
  countedCash: "2750.00",
  variance: "-5.00",
  saleCount: 37,
  cashRefundReturnRefs: [RETURN_ID],
  varianceApprovedByUserId: MANAGER_ID,
};

// ===========================================================================
// 1. Document, version, and the unchanged stuck-shift surface
// ===========================================================================
describe("pos-shifts — document and version", () => {
  it("is an OpenAPI 3.1 document at version 1.1.0-draft", () => {
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info?.version).toBe("1.1.0-draft");
  });

  it("carries an RT-17 version note citing the [GATED] approval and the design record", () => {
    const info = doc.info?.description ?? "";
    expect(info).toContain("RT-17 (1.1.0-draft");
    expect(info).toContain("comment 10760");
    expect(info).toContain("10919");
    expect(info).toContain("additive");
  });

  it("GET /shifts/stuck is unchanged: operationId, security, parameter", () => {
    const stuck = op(STUCK);
    expect(stuck.operationId).toBe("posShiftsGetStuck");
    expect(stuck.security).toEqual([{ "operator-identity": [] }]);
    expect(stuck["x-runtime-status"]).toBeUndefined();
    expect(stuck.parameters).toEqual([
      {
        name: "branch_id",
        in: "query",
        required: true,
        description: "UUID of the branch (store) to query.",
        schema: { type: "string", format: "uuid" },
      },
    ]);
  });

  it("GET /shifts/stuck still declares exactly 200, 400 and 401", () => {
    expect(statusesOf(STUCK)).toEqual(["200", "400", "401"]);
  });

  it.each([
    ["200", "StuckShiftsResponse"],
    ["400", "Error"],
    ["401", "Error"],
  ])("GET /shifts/stuck %s still returns %s", (status, schemaName) => {
    expect(responseSchema(STUCK, status)).toEqual({ $ref: `#/components/schemas/${schemaName}` });
  });

  it("the stuck-shift schemas and the operator-identity scheme are unchanged", () => {
    expect(shape(schema("StuckShiftsResponse"))).toEqual({
      type: "object",
      required: ["kind", "shifts"],
      properties: {
        kind: { type: "string", enum: ["ok"] },
        shifts: { type: "array", items: { $ref: "#/components/schemas/StuckShift" } },
      },
    });
    expect(schema("StuckShift").required).toEqual([
      "shift_id",
      "cashier_display_name",
      "terminal_label",
      "opened_at",
      "duration_minutes",
    ]);
    expect(shape(schema("Error"))).toEqual({
      type: "object",
      required: ["error"],
      properties: {
        error: {
          type: "object",
          required: ["code", "message", "request_id"],
          properties: {
            code: { type: "string" },
            message: { type: "string" },
            request_id: { type: "string", nullable: true },
          },
        },
      },
    });
    const identity = securityScheme(doc, "operator-identity");
    expect(identity["type"]).toBe("http");
    expect(identity["scheme"]).toBe("bearer");
    expect(identity["bearerFormat"]).toBe("JWT");
  });
});

// ===========================================================================
// 2. The three new operations
// ===========================================================================
describe("pos-shifts — cash-up operations", () => {
  it.each(NEW_OPS)("%s is declared at its path", (id, route) => {
    expect(op(route).operationId).toBe(id);
  });

  it("declares exactly the stuck query plus the three cash-up operations", () => {
    const ids = operationsOf(doc)
      .map((o) => o.operationId)
      .sort();
    expect(ids).toEqual(["closeShift", "openShift", "posShiftsGetStuck", "recordCashMovement"]);
  });

  it("collides with no operationId in any other contract", () => {
    expect(NEW_OPERATION_IDS.filter((id) => otherOperationIds.has(id))).toEqual([]);
  });

  it.each([
    ["openShift", OPEN],
    ["recordCashMovement", MOVEMENT],
    ["closeShift", CLOSE],
  ])("%s has a runtime route since RT-17 slices 2b-1 / 2b-2 (no contract-only marker)", (_id, route) => {
    const o = op(route);
    expect([o["x-runtime-status"], o["x-runtime-note"]]).toEqual([undefined, undefined]);
  });

  it("the info runtime-status note says all three cash-up operations are implemented", () => {
    const info = (doc.info?.description ?? "").replace(/\s+/g, " ");
    expect(info).toContain("`openShift`, `recordCashMovement` and `closeShift` are implemented");
    expect(info).not.toContain("contract-only");
  });

  it("the idempotency note says an exact envelope replay is answered before the stated user's live check", () => {
    const info = (doc.info?.description ?? "").replace(/\s+/g, " ");
    expect(info).toContain("answered as that replay before the stated user's live store check");
  });

  it("the variance approver must be a user of the caller's tenant, never refused for its role", () => {
    const text = (prop("CloseShiftRequest", "varianceApprovedByUserId").description ?? "").replace(/\s+/g, " ");
    expect(text).toContain("must be a user of the caller's tenant");
    expect(text).toContain("never refuses the close");
  });

  it.each(NEW_OPS)("%s is tagged pos-shifts", (_id, route) => {
    expect(op(route).tags).toEqual(["pos-shifts"]);
  });

  it.each([
    ["recordCashMovement", MOVEMENT],
    ["closeShift", CLOSE],
  ])("%s takes a required uuid `shift_id` path parameter", (_id, route) => {
    const shiftId = parametersOf(route).find((p) => p.name === "shift_id");
    expect(shiftId).toMatchObject({
      in: "path",
      required: true,
      schema: { type: "string", format: "uuid" },
    });
    expect(shiftId!.schema).toEqual({ type: "string", format: "uuid" });
  });

  const SCOPE_NAMES = ["tenant_id", "tenantId", "branch_id", "branchId", "store_id", "storeId", "device_id", "deviceId", "terminal_id", "terminalId"];

  it.each(NEW_OPS)("%s takes no tenant / branch / store / terminal / device parameter", (_id, route) => {
    const names = parametersOf(route).map((p) => p.name);
    expect(names.filter((n) => SCOPE_NAMES.includes(n ?? ""))).toEqual([]);
  });

  it.each(["OpenShiftRequest", "RecordCashMovementRequest", "CloseShiftRequest"])(
    "%s carries no tenant / branch / store / terminal / device body field",
    (name) => {
      const fields = Object.keys(schema(name).properties ?? {});
      expect(SCOPE_NAMES.filter((forbidden) => fields.includes(forbidden))).toEqual([]);
    },
  );
});

// ===========================================================================
// 3. Security: envelope OR device bearer, as on captureSale (RT-224)
// ===========================================================================
describe("pos-shifts — security", () => {
  it.each(NEW_OPS)("%s accepts the envelope OR the device bearer, as two alternatives", (_id, route) => {
    expect(op(route).security).toEqual([{ operatorAuthorization: [] }, { device: [] }]);
  });

  it.each(["operatorAuthorization", "device"])(
    "defines `%s` with the same type, scheme and format as pos-sales/sales.yaml",
    (name) => {
      const ours = securityScheme(doc, name);
      const theirs = securityScheme(salesDoc, name);
      expect(ours["type"]).toBe("http");
      expect(ours["scheme"]).toBe("bearer");
      expect(ours["bearerFormat"]).toBeUndefined();
      expect({ type: ours["type"], scheme: ours["scheme"], bearerFormat: ours["bearerFormat"] }).toEqual({
        type: theirs["type"],
        scheme: theirs["scheme"],
        bearerFormat: theirs["bearerFormat"],
      });
    },
  );

  it("every referenced scheme is defined", () => {
    const defined = Object.keys(doc.components?.securitySchemes ?? {});
    const referenced = referencedSchemes(doc);
    expect(referenced.length).toBeGreaterThan(0);
    expect(referenced.filter((name) => !defined.includes(name))).toEqual([]);
  });

  it.each([
    ["OpenShiftRequest"],
    ["RecordCashMovementRequest"],
    ["CloseShiftRequest"],
  ])("%s carries an OPTIONAL `operatorUserId` (uuid), documented as a verified device-path claim", (name) => {
    const s = schema(name);
    expect(s.required ?? []).not.toContain("operatorUserId");
    const field = s.properties?.["operatorUserId"];
    expect(field?.type).toBe("string");
    expect(field?.format).toBe("uuid");
    const text = field?.description ?? "";
    expect(text).toContain("REQUIRED with the `device` scheme");
    expect(text).toContain("MUST be absent with `operatorAuthorization`");
    expect(text).toContain("cashier admission");
    expect(text).toContain("never trusted");
  });

  it("documents the RT-224 attribution window, its tolerance and both dating caps", () => {
    const info = doc.info?.description ?? "";
    expect(info).toContain("created_at - 120 s <= t < LEAST(ended_at, expires_at) + 120 s");
    expect(info).toContain("more than 7 days ago");
    expect(info).toContain("more than 120 s after the server's current time");
    expect(info).toContain("generic 401");
    expect(info).toContain("generic 403 `refused`");
  });

  it("documents forced close as manager-envelope only", () => {
    const text = [
      op(CLOSE).description ?? "",
      schema("CloseShiftRequest").properties?.["closeKind"]?.description ?? "",
    ].join("\n");
    expect(text).toContain("`operatorAuthorization`");
    expect(text).toMatch(/forced close is manager-envelope only/i);
  });
});

// ===========================================================================
// 4. Idempotency
// ===========================================================================
describe("pos-shifts — idempotency", () => {
  it("declares the Idempotency-Key header (RT-181 rule)", () => {
    expect(idempotencyKeyParameter(doc)).toEqual({
      name: "Idempotency-Key",
      in: "header",
      required: true,
      schema: {
        type: "string",
        minLength: 16,
        maxLength: 128,
        pattern: "^[\\x21-\\x7E]{16,128}$",
      },
      description: expect.any(String),
    });
  });

  it("the Idempotency-Key header has exactly the pos-sales/sales.yaml shape", () => {
    expect(shape(idempotencyKeyParameter(doc))).toEqual(shape(idempotencyKeyParameter(salesDoc)));
  });

  it.each(NEW_OPS)("%s requires the Idempotency-Key header and is x-idempotency: required", (_id, route) => {
    const o = op(route);
    expect(o["x-idempotency"]).toBe("required");
    expect(o.parameters).toContainEqual({ $ref: "#/components/parameters/IdempotencyKey" });
  });

  it.each(NEW_OPS.flatMap(([id, route]) => ["200", "201"].map((status) => [id, status, route] as const)))(
    "%s answers %s with the Idempotent-Replayed header",
    (_id, status, route) => {
      expect(response(route, status).headers?.["Idempotent-Replayed"]).toEqual({
        $ref: "#/components/headers/IdempotentReplayed",
      });
    },
  );

  it("reuses the sales.yaml Idempotent-Replayed header shape", () => {
    expect(shape(doc.components?.headers?.["IdempotentReplayed"])).toEqual(
      shape(salesDoc.components?.headers?.["IdempotentReplayed"]),
    );
  });

  it.each([
    ["openShift", "OpenShiftRequest", OPEN],
    ["recordCashMovement", "RecordCashMovementRequest", MOVEMENT],
    ["closeShift", "CloseShiftRequest", CLOSE],
  ] as const)("%s takes a required JSON body referencing its strict schema %s", (_id, schemaName, route) => {
    expect(op(route).requestBody?.required).toBe(true);
    expect(requestSchemaRef(route)).toBe(`#/components/schemas/${schemaName}`);
  });

  it.each([
    ["openShift", "200", "Shift", OPEN],
    ["openShift", "201", "Shift", OPEN],
    ["closeShift", "200", "Shift", CLOSE],
    ["closeShift", "201", "Shift", CLOSE],
    ["recordCashMovement", "200", "CashMovement", MOVEMENT],
    ["recordCashMovement", "201", "CashMovement", MOVEMENT],
  ] as const)("%s answers %s with the %s projection", (_id, status, schemaName, route) => {
    expect(responseSchema(route, status)).toEqual({ $ref: `#/components/schemas/${schemaName}` });
  });
});

// ===========================================================================
// 5. Request bodies
// ===========================================================================
describe("pos-shifts — request bodies", () => {
  const UUID = { type: "string", format: "uuid" };
  const DATE_TIME = { type: "string", format: "date-time" };
  const SHORT_TEXT = { type: "string", minLength: 1, maxLength: 200 };
  const ref = (name: string): { $ref: string } => ({ $ref: `#/components/schemas/${name}` });
  const CLOSE_MONEY = [
    "openingFloat",
    "cashSalesTotal",
    "cashRefundsTotal",
    "payInTotal",
    "payOutTotal",
    "expectedCash",
    "countedCash",
  ];

  it.each([
    [
      "OpenShiftRequest",
      ["currencyCode", "openedAt", "openingFloat", "openingUserId", "operatorUserId", "shiftId"],
      ["currencyCode", "openedAt", "openingFloat", "openingUserId", "shiftId"],
    ],
    [
      "RecordCashMovementRequest",
      ["amount", "kind", "movementId", "note", "occurredAt", "operatorUserId", "reasonCode"],
      ["amount", "kind", "movementId", "occurredAt", "reasonCode"],
    ],
    [
      "CloseShiftRequest",
      [
        "closedAt",
        "closingUserId",
        "closeKind",
        "forcedReason",
        ...CLOSE_MONEY,
        "variance",
        "saleCount",
        "cashRefundReturnRefs",
        "varianceApprovedByUserId",
        "operatorUserId",
      ],
      ["closedAt", "closingUserId", "closeKind", ...CLOSE_MONEY, "variance", "saleCount", "cashRefundReturnRefs"],
    ],
  ])("%s is closed with exactly its fields and required list", (schemaName, fields, required) => {
    assertStrictObject(schemaName, fields, required);
  });

  // Fields that must match a shape (toMatchObject: extra keys such as a description are allowed).
  it.each([
    ["OpenShiftRequest", "shiftId", UUID],
    ["OpenShiftRequest", "openedAt", DATE_TIME],
    ["OpenShiftRequest", "openingUserId", UUID],
    ["RecordCashMovementRequest", "movementId", UUID],
    ["RecordCashMovementRequest", "occurredAt", DATE_TIME],
    ["RecordCashMovementRequest", "note", SHORT_TEXT],
    ["CloseShiftRequest", "saleCount", { type: "integer", minimum: 0, maximum: 2147483647 }],
    ["CloseShiftRequest", "cashRefundReturnRefs", { type: "array", uniqueItems: true, maxItems: 1000, items: UUID }],
    ["ShiftClose", "saleCount", { type: "integer", minimum: 0, maximum: 2147483647 }],
    ["ShiftClose", "cashRefundReturnRefs", { type: "array", uniqueItems: true, maxItems: 1000, items: UUID }],
    ["CloseShiftRequest", "varianceApprovedByUserId", UUID],
    ["CloseShiftRequest", "closedAt", DATE_TIME],
    ["CloseShiftRequest", "closingUserId", UUID],
    ["CloseShiftRequest", "forcedReason", SHORT_TEXT],
  ])("%s.%s has the expected type", (schemaName, field, expected) => {
    expect(prop(schemaName, field)).toMatchObject(expected);
  });

  // Fields that are exactly a reference to a shared component.
  it.each([
    ["OpenShiftRequest", "currencyCode", "CurrencyCode"],
    ["OpenShiftRequest", "openingFloat", "NonNegativeDecimalAmount"],
    ["RecordCashMovementRequest", "amount", "PositiveDecimalAmount"],
    ...CLOSE_MONEY.map((m) => ["CloseShiftRequest", m, "NonNegativeDecimalAmount"]),
    ["CloseShiftRequest", "variance", "SignedDecimalAmount"],
  ])("%s.%s is exactly a $ref to %s", (schemaName, field, component) => {
    expect(prop(schemaName!, field!)).toEqual(ref(component!));
  });

  it.each([
    ["RecordCashMovementRequest", "kind", ["pay_in", "pay_out"]],
    ["RecordCashMovementRequest", "reasonCode", ["bank_drop", "float_top_up", "petty_expense", "other"]],
    ["CloseShiftRequest", "closeKind", ["normal", "forced"]],
  ])("%s.%s is the enum %j", (schemaName, field, values) => {
    expect(prop(schemaName, field).enum).toEqual(values);
  });

  it.each([
    // Codex #4188345312: UUIDv7 preferred, UUIDv4 accepted (repo ID convention); not a v7-only pattern.
    ["OpenShiftRequest", "shiftId", /client-generated UUID \(UUIDv7 preferred; UUIDv4 fallback\)/],
    ["RecordCashMovementRequest", "movementId", /client-generated UUID \(UUIDv7 preferred; UUIDv4 fallback\)/],
    ["RecordCashMovementRequest", "note", /no PII/],
  ])("%s.%s documents %s", (schemaName, field, text) => {
    expect(prop(schemaName, field).description ?? "").toMatch(text);
  });

  it("documents the cash-up arithmetic invariant and its 422", () => {
    const text = [schema("CloseShiftRequest").description ?? "", op(CLOSE).description ?? ""].join("\n");
    expect(text).toContain(
      "expectedCash = openingFloat + cashSalesTotal − cashRefundsTotal + payInTotal − payOutTotal",
    );
    expect(text).toContain("variance = countedCash − expectedCash");
    expect(text).toContain("422 `shift_cashup_inconsistent`");
  });
});

// ===========================================================================
// 6. Money
// ===========================================================================
describe("pos-shifts — money", () => {
  it("reuses the sales.yaml NonNegativeDecimalAmount and CurrencyCode shapes", () => {
    expect(shape(schema("NonNegativeDecimalAmount"))).toEqual(
      shape(salesDoc.components?.schemas?.["NonNegativeDecimalAmount"]),
    );
    expect(shape(schema("CurrencyCode"))).toEqual(shape(salesDoc.components?.schemas?.["CurrencyCode"]));
  });

  it("SignedDecimalAmount is the signed exact-decimal string (the sales DecimalAmount shape)", () => {
    expect(shape(schema("SignedDecimalAmount"))).toEqual(shape(salesDoc.components?.schemas?.["DecimalAmount"]));
  });

  it("PositiveDecimalAmount is NonNegativeDecimalAmount with a non-zero digit", () => {
    expect(schema("PositiveDecimalAmount").allOf).toEqual([
      { $ref: "#/components/schemas/NonNegativeDecimalAmount" },
      { type: "string", pattern: "[1-9]" },
    ]);
  });

  it.each([
    ["0", true],
    ["500.00", true],
    ["0.0001", true],
    ["-1.00", false],
    ["1.00001", false],
    ["1e3", false],
    ["", false],
  ])("NonNegativeDecimalAmount %j -> %s", (value, ok) => {
    expect(validator("NonNegativeDecimalAmount")(value)).toBe(ok);
  });

  it.each([
    ["0.01", true],
    ["120", true],
    ["0", false],
    ["0.00", false],
    ["-5.00", false],
    ["1.00001", false],
  ])("PositiveDecimalAmount %j -> %s", (value, ok) => {
    expect(validator("PositiveDecimalAmount")(value)).toBe(ok);
  });

  it.each([
    ["-5.00", true],
    ["0", true],
    ["12.5", true],
    ["+5", false],
    ["5.00001", false],
  ])("SignedDecimalAmount %j -> %s", (value, ok) => {
    expect(validator("SignedDecimalAmount")(value)).toBe(ok);
  });

  it("documents the money semantics: ISO-4217 minor unit (400), one currency, net of change (RT-160 D-3)", () => {
    const info = doc.info?.description ?? "";
    expect(info).toContain("ISO-4217");
    expect(info).toContain("400 `validation_error`");
    expect(info).toMatch(/A shift has one currency/);
    expect(info).toContain("net of change (RT-160 D-3)");
  });
});

// ===========================================================================
// 7. Errors
// ===========================================================================
describe("pos-shifts — errors", () => {
  const SUCCESS_STATUSES = ["200", "201"];

  const EXPECTED_STATUSES: Record<string, string[]> = {
    openShift: ["200", "201", "400", "401", "403", "409", "425", "429", "500"],
    recordCashMovement: ["200", "201", "400", "401", "403", "404", "409", "425", "429", "500"],
    closeShift: ["200", "201", "400", "401", "403", "404", "409", "422", "425", "429", "500"],
  };

  it.each(NEW_OPS)("%s declares exactly its documented statuses", (id, route) => {
    expect(statusesOf(route)).toEqual(sorted(EXPECTED_STATUSES[id]!));
  });

  it("the cash-up error envelope is the canonical sales.yaml Error shape", () => {
    expect(shape(schema("ApiError"))).toEqual(shape(salesDoc.components?.schemas?.["Error"]));
  });

  // The 425 is the IdempotencyInterceptor's own body, not the envelope (below).
  const NON_ENVELOPE_STATUSES = [...SUCCESS_STATUSES, "425"];

  it.each(NEW_OPS)("%s: every other error response uses the canonical envelope", (_id, route) => {
    const errorStatuses = statusesOf(route).filter((status) => !NON_ENVELOPE_STATUSES.includes(status));
    expect(errorStatuses.length).toBeGreaterThan(0);
    const schemas = errorStatuses.map((status) => responseSchema(route, status));
    expect(schemas).toEqual(errorStatuses.map(() => ({ $ref: "#/components/schemas/ApiError" })));
  });

  const CODES: Array<[string, Route, string, string[]]> = [
    ["openShift", OPEN, "400", ["validation_error", "idempotency_key_required", "idempotency_key_malformed"]],
    ["openShift", OPEN, "403", ["refused"]],
    ["openShift", OPEN, "409", ["idempotency_key_conflict", "shift_payload_conflict", "shift_already_open"]],
    ["openShift", OPEN, "401", ["unauthorized"]],
    ["openShift", OPEN, "429", ["RATE_LIMITED"]],
    ["recordCashMovement", MOVEMENT, "400", ["validation_error", "idempotency_key_required", "idempotency_key_malformed"]],
    ["recordCashMovement", MOVEMENT, "403", ["refused"]],
    ["recordCashMovement", MOVEMENT, "404", ["shift_not_found"]],
    ["recordCashMovement", MOVEMENT, "409", ["idempotency_key_conflict", "shift_payload_conflict", "shift_closed"]],
    ["closeShift", CLOSE, "400", ["validation_error", "idempotency_key_required", "idempotency_key_malformed"]],
    ["closeShift", CLOSE, "403", ["refused"]],
    ["closeShift", CLOSE, "404", ["shift_not_found"]],
    ["closeShift", CLOSE, "409", ["idempotency_key_conflict", "shift_payload_conflict"]],
    ["closeShift", CLOSE, "422", ["shift_cashup_inconsistent", "currency_mismatch", "refund_ref_invalid"]],
    ...NEW_OPS.map(([id, route]): [string, Route, string, string[]] => [id, route, "425", ["idempotency_in_progress"]]),
  ];

  it.each(CODES)("%s %s documents error codes %s", (_id, route, status, codes) => {
    const text = response(route, status).description ?? "";
    expect(codes.filter((code) => !text.includes(`\`${code}\``))).toEqual([]);
  });

  it("the 404 is non-disclosing across tenant, store and device", () => {
    const text = response(MOVEMENT, "404").description ?? "";
    expect(text).toMatch(/non-disclosing/i);
    expect(["tenant", "store", "device"].filter((word) => !text.includes(word))).toEqual([]);
  });

  it.each(NEW_OPS)("%s: the 429 carries Retry-After", (_id, route) => {
    expect(response(route, "429").headers?.["Retry-After"]).toEqual({ $ref: "#/components/headers/RetryAfter" });
  });

  it.each(NEW_OPS)("%s: the 425 is the interceptor's own body with Retry-After", (_id, route) => {
    expect(op(route).responses?.["425"]).toEqual({ $ref: "#/components/responses/IdempotencyInProgress" });
    expect(responseSchema(route, "425")).toEqual({ $ref: "#/components/schemas/IdempotencyInProgressBody" });
    expect(response(route, "425").headers?.["Retry-After"]).toEqual({
      $ref: "#/components/headers/RetryAfterInProgress",
    });
  });

  it("IdempotencyInProgressBody is exactly what IdempotencyInterceptor writes", () => {
    assertStrictObject("IdempotencyInProgressBody", ["error", "retryAfterSec"], ["error", "retryAfterSec"]);
    const valid = validator("IdempotencyInProgressBody");
    // The interceptor's literal body (idempotency.interceptor.ts replyInProgress).
    expect(valid({ error: "idempotency_in_progress", retryAfterSec: 2 })).toBe(true);
    expect(valid({ error: { code: "idempotency_in_progress", message: "x" } })).toBe(false);
    expect(valid({ error: "other", retryAfterSec: 2 })).toBe(false);
  });
});

// ===========================================================================
// 7b. Scope of the natural keys (Codex P2, RT-17 comments 10925 / 10929)
// ===========================================================================
describe("pos-shifts — natural-key scope", () => {
  it("openShift states that an out-of-scope shiftId is a non-disclosing 409 shift_payload_conflict", () => {
    const text = op(OPEN).description ?? "";
    expect(text).toContain("**Scope of `shiftId`**");
    expect(text).toMatch(/another device, another store or another tenant\) is 409\s+`shift_payload_conflict`/);
    expect(text).toMatch(/never returns that shift's projection/);
  });

  it("openShift states the one adoption case (the audit-ingest open of the same shift) as a 201", () => {
    const text = op(OPEN).description ?? "";
    expect(text).toMatch(/audit-ingest `shift\.open`[\s\S]*adopted by this open and answered\s+`201`/);
  });

  it("recordCashMovement scopes the movement replay to the path shift_id", () => {
    const text = op(MOVEMENT).description ?? "";
    expect(text).toMatch(/resolves `movementId` only on the path `shift_id`/);
    expect(text).toMatch(/any other shift[\s\S]*409 `shift_payload_conflict` and is never returned/);
  });
});

// ===========================================================================
// 8. Projections and AJV fixtures
// ===========================================================================
describe("pos-shifts — projections and fixtures", () => {
  it.each(["Shift", "ShiftClose", "CashMovement"])("%s is a closed projection", (name) => {
    expect(schema(name).additionalProperties).toBe(false);
  });

  it("the Shift projection has a status enum open | closed", () => {
    expect(schema("Shift").properties?.["status"]?.enum).toEqual(["open", "closed"]);
  });

  it.each(NEW_OPS)("%s: every request and response example validates against its schema", (_id, route) => {
    const examples = collectExamples(route);
    // A request example plus at least one success example per operation.
    expect(examples.length).toBeGreaterThanOrEqual(2);
    const results = examples.map(({ schemaName, value }) => {
      const v = validator(schemaName);
      return { schemaName, defined: value !== undefined, ok: v(value), errors: v.errors ?? null };
    });
    expect(results).toEqual(
      examples.map(({ schemaName }) => ({ schemaName, defined: true, ok: true, errors: null })),
    );
  });

  it("a UUIDv4 shiftId / movementId is accepted (UUIDv4 fallback)", () => {
    const v4 = "4f6f1c1e-8a52-4c1b-9a0e-6d1f2b3c4d5e";
    expect(validator("OpenShiftRequest")({ ...VALID_OPEN, shiftId: v4 })).toBe(true);
    expect(validator("RecordCashMovementRequest")({ ...VALID_MOVEMENT, movementId: v4 })).toBe(true);
  });

  it("the info prose no longer calls the ids UUIDv7-only", () => {
    expect(doc.info?.description ?? "").not.toContain("client-generated UUIDv7");
  });

  // Codex #4188345319: `close` is required iff `status` is `closed`.
  it("Shift: `close` is required when closed and forbidden when open", () => {
    const v = validator("Shift");
    const closed = exampleValue({ $ref: "#/components/examples/ShiftClosed" }) as Record<string, unknown>;
    const open = exampleValue({ $ref: "#/components/examples/ShiftOpen" }) as Record<string, unknown>;
    expect(v(closed)).toBe(true);
    expect(v(open)).toBe(true);
    expect(v({ ...closed, close: undefined })).toBe(false);
    expect(v({ ...open, close: closed["close"] })).toBe(false);
  });

  // Codex #4188345321: the response mirrors the request's forced-close rule.
  it("ShiftClose: forcedReason is required when forced and forbidden when normal", () => {
    const v = validator("ShiftClose");
    const closed = exampleValue({ $ref: "#/components/examples/ShiftClosed" }) as { close: Record<string, unknown> };
    const normal = closed.close;
    expect(v(normal)).toBe(true);
    expect(v({ ...normal, closeKind: "forced", forcedReason: "Drawer jammed, closed by manager" })).toBe(true);
    expect(v({ ...normal, closeKind: "forced" })).toBe(false);
    expect(v({ ...normal, forcedReason: "not forced" })).toBe(false);
  });

  it("the request examples are the fixtures this spec uses", () => {
    expect(validator("OpenShiftRequest")(VALID_OPEN)).toBe(true);
    expect(validator("RecordCashMovementRequest")(VALID_MOVEMENT)).toBe(true);
    expect(validator("CloseShiftRequest")(VALID_CLOSE)).toBe(true);
  });

  it("device-path bodies (with operatorUserId) validate", () => {
    expect(validator("OpenShiftRequest")({ ...VALID_OPEN, operatorUserId: USER_ID })).toBe(true);
    expect(validator("RecordCashMovementRequest")({ ...VALID_MOVEMENT, note: "Cleaning supplies", operatorUserId: USER_ID })).toBe(true);
    expect(validator("CloseShiftRequest")({ ...VALID_CLOSE, operatorUserId: USER_ID })).toBe(true);
  });

  it("a forced close requires forcedReason; a normal close forbids it", () => {
    const v = validator("CloseShiftRequest");
    expect(v({ ...VALID_CLOSE, closeKind: "forced", forcedReason: "Drawer jammed, closed by manager" })).toBe(true);
    expect(v({ ...VALID_CLOSE, closeKind: "forced" })).toBe(false);
    expect(v({ ...VALID_CLOSE, forcedReason: "not forced" })).toBe(false);
  });

  const INVALID: Array<[string, string, Record<string, unknown>]> = [
    ["OpenShiftRequest", "unknown key", { ...VALID_OPEN, tenantId: USER_ID }],
    ["OpenShiftRequest", "missing shiftId", { ...VALID_OPEN, shiftId: undefined }],
    ["OpenShiftRequest", "non-uuid shiftId", { ...VALID_OPEN, shiftId: "shift-1" }],
    ["OpenShiftRequest", "lowercase currency", { ...VALID_OPEN, currencyCode: "egp" }],
    ["OpenShiftRequest", "negative float", { ...VALID_OPEN, openingFloat: "-1.00" }],
    ["OpenShiftRequest", "numeric float", { ...VALID_OPEN, openingFloat: 500 }],
    ["OpenShiftRequest", "bad openedAt", { ...VALID_OPEN, openedAt: "yesterday" }],
    ["OpenShiftRequest", "non-uuid operatorUserId", { ...VALID_OPEN, operatorUserId: "cashier-7" }],
    ["RecordCashMovementRequest", "unknown kind", { ...VALID_MOVEMENT, kind: "drop" }],
    ["RecordCashMovementRequest", "unknown reasonCode", { ...VALID_MOVEMENT, reasonCode: "tip" }],
    ["RecordCashMovementRequest", "zero amount", { ...VALID_MOVEMENT, amount: "0.00" }],
    ["RecordCashMovementRequest", "empty note", { ...VALID_MOVEMENT, note: "" }],
    ["RecordCashMovementRequest", "note over 200", { ...VALID_MOVEMENT, note: "x".repeat(201) }],
    ["RecordCashMovementRequest", "missing occurredAt", { ...VALID_MOVEMENT, occurredAt: undefined }],
    ["RecordCashMovementRequest", "currency on a movement", { ...VALID_MOVEMENT, currencyCode: "EGP" }],
    ["CloseShiftRequest", "unknown closeKind", { ...VALID_CLOSE, closeKind: "auto" }],
    ["CloseShiftRequest", "negative countedCash", { ...VALID_CLOSE, countedCash: "-1.00" }],
    ["CloseShiftRequest", "numeric variance", { ...VALID_CLOSE, variance: -5 }],
    ["CloseShiftRequest", "negative saleCount", { ...VALID_CLOSE, saleCount: -1 }],
    ["CloseShiftRequest", "fractional saleCount", { ...VALID_CLOSE, saleCount: 1.5 }],
    ["CloseShiftRequest", "saleCount beyond a database integer", { ...VALID_CLOSE, saleCount: 2147483648 }],
    ["CloseShiftRequest", "1001 return refs", { ...VALID_CLOSE, cashRefundReturnRefs: manyRefs(1001) }],
    ["CloseShiftRequest", "duplicate return refs", { ...VALID_CLOSE, cashRefundReturnRefs: [RETURN_ID, RETURN_ID] }],
    ["CloseShiftRequest", "non-uuid return ref", { ...VALID_CLOSE, cashRefundReturnRefs: ["r-1"] }],
    ["CloseShiftRequest", "missing expectedCash", { ...VALID_CLOSE, expectedCash: undefined }],
    ["CloseShiftRequest", "unknown key", { ...VALID_CLOSE, shiftId: SHIFT_ID }],
  ];

  it.each(INVALID)("%s rejects: %s", (name, _label, body) => {
    const clean = JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
    expect(validator(name)(clean)).toBe(false);
  });
});
