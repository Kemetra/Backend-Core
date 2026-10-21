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
 *
 * RT-384 (1.2.0-draft, `[GATED]`, AD-CASH-001 D-6 / D-7): strictly additive.
 * `OpenShiftRequest` gains one OPTIONAL `frozenPolicy` object (accepted from
 * RT-387; a nested object, so the existing body gains no `allOf` / `if`,
 * which oasdiff grades as breaking); `Shift` gains an OPTIONAL recorded
 * `frozenPolicy` and `ShiftClose` the OPTIONAL derived approval fields
 * (emitted from RT-387; the RT-17 HTTP harness AJV-checks every response, so
 * they cannot be required yet); the stale "threshold, default 0" prose is
 * replaced. No operation, status, required list or existing field changes.
 *
 * RT-742 (1.4.0-draft, `[GATED]`): one NEW contract-only operation,
 * `forceCloseShift`, a manager's store-scoped force close recorded as not
 * counted; `closeShift`, the stuck list and every existing schema are
 * unchanged, and the late close / open replay of the opening terminal get the
 * distinct 409 `shift_force_closed` (a late movement keeps `shift_closed`);
 * the last describe block.
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
const FORCE_CLOSE: Route = { path: "/api/pos/v1/shifts/{shift_id}/forced-close", method: "post" };

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
let policyDoc: OpenApiDocument;
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
  policyDoc = contracts.find((c) => c.dir === "" && c.id === "cash-variance-policy.openapi")!.document;

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
  it("is an OpenAPI 3.1 document at version 1.4.0-draft (RT-742; RT-490 was 1.3.0-draft)", () => {
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info?.version).toBe("1.4.0-draft");
  });

  it("carries an RT-384 version note: additive, [GATED], AD-CASH-001", () => {
    const info = (doc.info?.description ?? "").replace(/\s+/g, " ");
    expect(info).toContain("RT-384 (1.2.0-draft");
    expect(info).toContain("[GATED]");
    expect(info).toContain("AD-CASH-001");
    expect(info).toContain("strictly additive");
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

  it("declares exactly the stuck query, the three cash-up operations and the RT-742 forced close", () => {
    const ids = operationsOf(doc)
      .map((o) => o.operationId)
      .sort();
    expect(ids).toEqual(["closeShift", "forceCloseShift", "openShift", "posShiftsGetStuck", "recordCashMovement"]);
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
      [
        "currencyCode",
        "openedAt",
        "openingFloat",
        "openingUserId",
        "operatorUserId",
        "shiftId",
        "frozenPolicy",
      ],
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
    ["closeShift", CLOSE, "422", [
      "shift_cashup_inconsistent",
      "currency_mismatch",
      "refund_ref_invalid",
      // RT-490 (RT-271 R-9), from the F-3 runtime.
      "refund_ref_unsettled",
      "cash_refunds_total_mismatch",
    ]],
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

// ===========================================================================
// 9. RT-384: the shift variance policy on open and close (AD-CASH-001 D-6 / D-7)
// ===========================================================================
describe("pos-shifts — RT-384 shift variance policy", () => {
  const REVISION_ID = "0190f5a2-3b4c-7d8e-9f01-0000000000a1";
  const LIMIT = { mode: "limit", limitAmount: "50.00", currencyCode: "EGP" };
  const FALLBACK = { mode: "limit", limitAmount: "0", currencyCode: "EGP" };
  const TENANT_POLICY = { policySource: "tenant", policyRevisionId: REVISION_ID, policyValue: LIMIT };
  const FALLBACK_POLICY = { policySource: "fallback", policyRevisionId: null, policyValue: FALLBACK };
  const SYSTEM_POLICY = { policySource: "system", policyRevisionId: null, policyValue: { mode: "none" } };
  const open = (frozenPolicy: unknown): Record<string, unknown> => ({ ...VALID_OPEN, frozenPolicy });

  it("keeps the RT-17 OpenShiftRequest required list exactly (frozenPolicy stays optional)", () => {
    expect(sorted(schema("OpenShiftRequest").required ?? [])).toEqual(
      sorted(["shiftId", "openedAt", "openingUserId", "currencyCode", "openingFloat"]),
    );
  });

  it("documents the canonical hash form of policyValue.limitAmount", () => {
    const text = (op(OPEN).description ?? "").replace(/\s+/g, " ");
    expect(text).toContain("`policyValue.limitAmount` is hashed in the canonical money form");
    expect(text).toContain("hashed verbatim");
  });

  it("adds one optional frozenPolicy object to the open; its three members are all required", () => {
    expect(schema("OpenShiftRequest").required ?? []).not.toContain("frozenPolicy");
    expect(prop("OpenShiftRequest", "frozenPolicy")).toEqual({ $ref: "#/components/schemas/FrozenPolicy" });
    expect(schema("FrozenPolicy").additionalProperties).toBe(false);
    expect(sorted(schema("FrozenPolicy").required ?? [])).toEqual(
      sorted(["policySource", "policyRevisionId", "policyValue"]),
    );
    expect(prop("FrozenPolicy", "policySource")).toMatchObject({ enum: ["system", "tenant", "store", "fallback"] });
    expect(prop("FrozenPolicy", "policyRevisionId")).toMatchObject({ type: ["string", "null"], format: "uuid" });
    expect(prop("FrozenPolicy", "policyValue")).toEqual({ $ref: "#/components/schemas/CashVariancePolicyValue" });
    expect(shape(schema("CashVariancePolicyValue"))).toEqual(
      shape(policyDoc.components?.schemas?.["CashVariancePolicyValue"]),
    );
  });

  // oasdiff grades an `allOf` (WARN) or an `if` / `then` (ERR) added to an
  // existing REQUEST body as a break; the rules live in the new FrozenPolicy.
  // A response-side `allOf` is not a break (the first gate run on this PR
  // reported only the request body).
  it("adds no allOf / anyOf / oneOf / if / then to the existing request body", () => {
    const s = schema("OpenShiftRequest");
    expect({ allOf: s.allOf, anyOf: s["anyOf"], oneOf: s["oneOf"], if: s["if"], then: s["then"] }).toEqual({});
  });

  it("ShiftClose and Shift carry only the RT-384 response-side rule schemas", () => {
    expect(schema("ShiftClose").allOf).toEqual([
      { $ref: "#/components/schemas/ApproverCheckMatchesApprover" },
      { $ref: "#/components/schemas/ApprovalMissingMatches" },
    ]);
    expect(schema("Shift").allOf).toEqual([{ $ref: "#/components/schemas/ShiftPolicyMatchesClose" }]);
  });

  it("accepts a legacy open (no frozenPolicy), a tenant, store, system and fallback open", () => {
    const v = validator("OpenShiftRequest");
    const bodies = [
      VALID_OPEN,
      open(TENANT_POLICY),
      open({ ...TENANT_POLICY, policySource: "store" }),
      open(SYSTEM_POLICY),
      open(FALLBACK_POLICY),
      { ...open(TENANT_POLICY), operatorUserId: USER_ID },
    ];
    expect(bodies.map((body) => v(body))).toEqual(bodies.map(() => true));
  });

  it.each([
    ["only the source", { policySource: "tenant" }],
    ["no value", { policySource: "tenant", policyRevisionId: REVISION_ID }],
    ["no revision id key", { policySource: "system", policyValue: { mode: "none" } }],
    ["no source", { policyRevisionId: null, policyValue: { mode: "none" } }],
    ["a tenant source with a null id", { ...TENANT_POLICY, policyRevisionId: null }],
    ["a store source with a null id", { ...TENANT_POLICY, policySource: "store", policyRevisionId: null }],
    ["a system source with an id", { ...SYSTEM_POLICY, policyRevisionId: REVISION_ID }],
    ["a fallback source with an id", { ...FALLBACK_POLICY, policyRevisionId: REVISION_ID }],
    ["a limit without an amount", { ...TENANT_POLICY, policyValue: { mode: "limit", currencyCode: "EGP" } }],
    ["none with an amount", { ...SYSTEM_POLICY, policyValue: { mode: "none", limitAmount: "0" } }],
    ["an unknown source", { ...TENANT_POLICY, policySource: "cached" }],
    ["a non-uuid revision id", { ...TENANT_POLICY, policyRevisionId: "rev-1" }],
    ["an unknown member", { ...TENANT_POLICY, policyFlags: [] }],
    ["a null object", null],
  ])("rejects an open whose frozenPolicy has %s (a structural 400 only)", (_label, frozenPolicy) => {
    expect(validator("OpenShiftRequest")(open(frozenPolicy))).toBe(false);
  });

  it("rejects the policy members at the top level of the open", () => {
    expect(validator("OpenShiftRequest")({ ...VALID_OPEN, ...TENANT_POLICY })).toBe(false);
  });

  it("accepts a system open whose value is not none (accept-and-flag policy_value_mismatch, never a 400)", () => {
    expect(validator("OpenShiftRequest")(open({ ...SYSTEM_POLICY, policyValue: LIMIT }))).toBe(true);
  });

  it("documents the payload-hash rule: absent is omitted, a present null is hashed as null", () => {
    const text = (op(OPEN).description ?? "").replace(/\s+/g, " ");
    expect(text).toContain("omitted from the payload hash");
    expect(text).toContain("hashed as `null`");
    expect(text).toContain("`shift_payload_conflict`");
  });

  it("documents the rollout rule and that policy grounds never refuse an open", () => {
    const text = (op(OPEN).description ?? "").replace(/\s+/g, " ");
    expect(text).toContain("RT-387");
    expect(text).toMatch(/must not send/i);
    expect(text).toMatch(/never refuses an open or a close on policy grounds/i);
    for (const flag of ["policy_revision_unknown", "policy_revision_superseded", "policy_value_mismatch"]) {
      expect(text).toContain(`\`${flag}\``);
    }
  });

  it("replaces the stale 'threshold, default 0' prose with the frozen session policy", () => {
    const text = (op(CLOSE).description ?? "").replace(/\s+/g, " ");
    expect(text).not.toContain("default 0");
    expect(text).toContain("frozen");
    expect(text).toContain("`none`");
    expect(text).toContain("never refuses the close");
  });

  it("Shift echoes the recorded frozen policy as one optional object with its flags", () => {
    expect(schema("Shift").required ?? []).not.toContain("frozenPolicy");
    expect(prop("Shift", "frozenPolicy")).toEqual({ $ref: "#/components/schemas/RecordedFrozenPolicy" });
    expect(sorted(schema("RecordedFrozenPolicy").required ?? [])).toEqual(
      sorted(["policySource", "policyRevisionId", "policyValue", "policyFlags"]),
    );
    expect(prop("RecordedFrozenPolicy", "policyFlags")).toMatchObject({ type: "array", uniqueItems: true });
  });

  it("ShiftClose gains the derived approval values and the approver check, all optional", () => {
    const s = schema("ShiftClose");
    for (const key of ["approvalRequiredByPolicy", "approvalMissing", "approverCheck"]) {
      expect(s.properties?.[key]).toBeDefined();
      expect(s.required ?? []).not.toContain(key);
    }
    expect(schema("PolicyTriState").enum).toEqual(["yes", "no", "unknown"]);
    expect(prop("ShiftClose", "approverCheck")).toEqual({ $ref: "#/components/schemas/ApproverCheck" });
  });

  it("keeps the RT-17 Shift and ShiftClose required lists exactly", () => {
    expect(sorted(schema("Shift").required ?? [])).toEqual(
      sorted(["shiftId", "status", "currencyCode", "openingFloat", "openedAt", "openingUserId", "receivedAt"]),
    );
    expect(sorted(schema("ShiftClose").required ?? [])).toEqual(
      sorted([
        "closedAt",
        "closingUserId",
        "closeKind",
        "openingFloat",
        "cashSalesTotal",
        "cashRefundsTotal",
        "payInTotal",
        "payOutTotal",
        "expectedCash",
        "countedCash",
        "variance",
        "saleCount",
        "cashRefundReturnRefs",
        "receivedAt",
      ]),
    );
  });

  it("validates a closed shift carrying every RT-384 field, and rejects malformed ones", () => {
    const v = validator("Shift");
    const closed = exampleValue({ $ref: "#/components/examples/ShiftClosed" }) as Record<string, unknown>;
    const close = closed["close"] as Record<string, unknown>;
    const recorded = { ...TENANT_POLICY, policyFlags: ["policy_revision_superseded"] };
    const withPolicy = {
      ...closed,
      frozenPolicy: recorded,
      close: {
        ...close,
        approvalRequiredByPolicy: "no",
        approvalMissing: "no",
        approverCheck: { status: "verified", reason: null },
      },
    };
    expect(v(withPolicy)).toBe(true);
    expect(v({ ...withPolicy, frozenPolicy: { ...recorded, policyFlags: ["stale"] } })).toBe(false);
    expect(v({ ...withPolicy, frozenPolicy: TENANT_POLICY })).toBe(false);
    expect(v({ ...withPolicy, policyFlags: [] })).toBe(false);
    expect(v({ ...withPolicy, close: { ...withPolicy.close, approvalMissing: false } })).toBe(false);
    expect(v({ ...withPolicy, close: { ...withPolicy.close, approverCheck: { status: "unverified", reason: null } } })).toBe(
      false,
    );
  });

  it("ShiftClose: approverCheck is not_applicable exactly when no approver was recorded", () => {
    const v = validator("ShiftClose");
    const closed = exampleValue({ $ref: "#/components/examples/ShiftClosed" }) as { close: Record<string, unknown> };
    const withApprover = closed.close;
    const { varianceApprovedByUserId: _approver, ...noApprover } = withApprover;
    // Approval required by a frozen limit: missing is "no" with an approver, "yes" without one.
    const check = (status: string, reason: string | null = null) => ({
      approvalRequiredByPolicy: "yes",
      approvalMissing: "no",
      approverCheck: { status, reason },
    });
    const noApproverCheck = (status: string, reason: string | null = null) => ({ ...check(status, reason), approvalMissing: "yes" });
    expect(v({ ...withApprover, ...check("verified") })).toBe(true);
    expect(v({ ...withApprover, ...check("unverified", "approver_is_closer") })).toBe(true);
    expect(v({ ...noApprover, ...noApproverCheck("not_applicable") })).toBe(true);
    expect(v({ ...withApprover, ...check("not_applicable") })).toBe(false);
    expect(v({ ...noApprover, ...noApproverCheck("verified") })).toBe(false);
    expect(v({ ...noApprover, ...noApproverCheck("unverified", "check_unavailable") })).toBe(false);
  });

  it.each([
    ["only the approver check", { approverCheck: { status: "verified", reason: null } }],
    ["only approvalRequiredByPolicy", { approvalRequiredByPolicy: "no" }],
    ["no approver check", { approvalRequiredByPolicy: "no", approvalMissing: "no" }],
  ])("ShiftClose: the three RT-384 close fields are all-or-none (rejects %s)", (_label, fields) => {
    const closed = exampleValue({ $ref: "#/components/examples/ShiftClosed" }) as { close: Record<string, unknown> };
    expect(validator("ShiftClose")({ ...closed.close, ...fields })).toBe(false);
  });

  it("Shift: a close reads unknown exactly when the shift carries no frozenPolicy", () => {
    const v = validator("Shift");
    const closed = exampleValue({ $ref: "#/components/examples/ShiftClosed" }) as Record<string, unknown>;
    const close = closed["close"] as Record<string, unknown>;
    const fields = (required: string, missing: string) => ({
      approvalRequiredByPolicy: required,
      approvalMissing: missing,
      approverCheck: { status: "verified", reason: null },
    });
    const frozen = { ...TENANT_POLICY, policyFlags: [] };
    expect(v({ ...closed, close: { ...close, ...fields("unknown", "unknown") } })).toBe(true);
    expect(v({ ...closed, frozenPolicy: frozen, close: { ...close, ...fields("no", "no") } })).toBe(true);
    expect(v({ ...closed, close: { ...close, ...fields("no", "no") } })).toBe(false);
    expect(v({ ...closed, frozenPolicy: frozen, close: { ...close, ...fields("unknown", "unknown") } })).toBe(false);
  });

  it.each([
    ["yes", true, "no", true],
    ["yes", false, "yes", true],
    ["no", false, "no", true],
    ["unknown", true, "unknown", true],
    ["no", true, "yes", false],
    ["yes", true, "yes", false],
    ["yes", false, "no", false],
    ["unknown", false, "no", false],
    ["no", false, "unknown", false],
  ])("ShiftClose: approvalRequired %s, approver recorded %s, approvalMissing %s -> %s", (required, hasApprover, missing, ok) => {
    const closed = exampleValue({ $ref: "#/components/examples/ShiftClosed" }) as { close: Record<string, unknown> };
    const { varianceApprovedByUserId: _approver, ...noApprover } = closed.close;
    const base = hasApprover ? closed.close : noApprover;
    const approverCheck = hasApprover ? { status: "verified", reason: null } : { status: "not_applicable", reason: null };
    expect(validator("ShiftClose")({ ...base, approvalRequiredByPolicy: required, approvalMissing: missing, approverCheck })).toBe(ok);
  });

  it("the shared policy shapes match the shift-closes contract", () => {
    const shiftCloses = loadOpenApiContracts().find((c) => c.id === "shift-closes.openapi")!.document as OpenApiDocument;
    for (const name of ["ApproverCheck", "PolicyTriState", "PolicyFlag", "CashVariancePolicyValue", "RecordedFrozenPolicy"]) {
      expect({ name, shape: shape(schema(name)) }).toEqual({ name, shape: shape(shiftCloses.components?.schemas?.[name]) });
    }
  });
});
// ===========================================================================
// RT-490 (RT-271 R-9) — refund cross-check on close
// ===========================================================================
describe("pos-shifts — RT-490 refund cross-check on close (1.3.0-draft)", () => {
  const flat = (text: string | undefined): string => (text ?? "").replace(/\s+/g, " ");
  const info = (): string => flat(doc.info?.description);
  const closeText = (): string => flat(op(CLOSE).description);

  it("carries an RT-490 note citing the [GATED] owner authorization and R-9, enforced from F-3", () => {
    expect(info()).toContain("RT-490 (1.3.0-draft; [GATED] owner authorization Jira RT-490 comment 13211, 2026-10-21; RT-271 R-9");
    expect(info()).toContain("F-3 enforces the rule only after that. Until F-3 the close behaves as in 1.2.0-draft.");
    expect(info()).toContain("OPEN for F-3");
  });

  it("states the R-9 rule normatively: a settled cash execution in this shift per ref, and the total equal to their sum", () => {
    const text = closeText();
    expect(text).toContain("**Refund cross-check** (RT-271 R-9, RT-490; normative from the F-3 runtime)");
    expect(text).toContain("every claimed `recordReturn` return with a non-zero `returnTotal` must be fully SETTLED in this shift: its settled cash executions whose `evidence.shiftRef` is this shift's `shiftId` sum to its `returnTotal`");
    // Codex P1 on #879: a partly paid return cannot be claimed, so no later payout is left out of every close.
    expect(text).toContain("A partly paid return cannot be claimed");
    expect(text).toContain("a further execution for it is refused (422 `refund_execution_exceeds_allocation`)");
    expect(text).not.toContain("at least one settled cash execution");
    // A zero-total return can have no execution (amount is strictly positive), so it is exempt.
    expect(text).toContain("A zero-total return owes nothing, has no execution and is exempt");
    expect(text).toContain("`cashRefundsTotal` must equal, in exact decimal, the sum of the amounts of the settled cash executions of the claimed `recordReturn` returns whose `evidence.shiftRef` is this shift, plus the recorded cash refund tenders of the claimed credit-sale returns, else 422 `cash_refunds_total_mismatch`");
  });

  it("a credit-sale return is outside RT-490 and counts at its recorded refund tenders (review finding 1)", () => {
    expect(closeText()).toContain("A credit-sale return (`recordCreditSaleReversal`) is outside RT-490: it has no executions, so it is not checked against them");
  });

  it("the POS holds a close until the shift's executions are acknowledged, so both 422s stay deterministic (review finding 2)", () => {
    const text = closeText();
    expect(text).toContain("the POS MUST NOT send a shift's close until every refund execution it recorded with that shift's `shiftId` has been acknowledged");
    expect(text).toContain("both 422s are deterministic");
    expect(info()).toContain("holds a shift's close until that shift's executions are acknowledged");
  });

  it("no longer says the server never checks cashRefundsTotal", () => {
    expect(closeText()).not.toContain("The server does not check `cashSalesTotal`, `cashRefundsTotal`");
    expect(closeText()).toContain("`cashRefundsTotal` is the exception from the F-3 runtime");
  });

  it("the close 422 names the two new codes after the existing ones, in order", () => {
    const text = flat(response(CLOSE, "422").description);
    const order = ["shift_cashup_inconsistent", "refund_ref_invalid", "refund_ref_unsettled", "cash_refunds_total_mismatch"]
      .map((code) => text.lastIndexOf(`\`${code}\``));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});

// ===========================================================================
// RT-742 — manager forced close of a stuck shift from any terminal (1.4.0-draft)
// ===========================================================================
describe("pos-shifts — RT-742 manager forced close from any terminal (1.4.0-draft)", () => {
  const flat = (text: string | undefined): string => (text ?? "").replace(/\s+/g, " ");
  const info = (): string => flat(doc.info?.description);
  const forceText = (): string => flat(op(FORCE_CLOSE).description);
  const describeOf = (status: string): string => flat(response(FORCE_CLOSE, status).description);
  const componentText = (name: string): string => flat(doc.components?.responses?.[name]?.description);
  /** Every part is stated in the text (a list of missing parts is the diff on failure). */
  const expectAll = (text: string, parts: readonly string[]): void => {
    expect(parts.filter((part) => !text.includes(part))).toEqual([]);
  };
  /** None of the fields is declared on any of the schemas. */
  const declaredAmong = (names: readonly string[], fields: readonly string[]): string[] =>
    names.flatMap((name) => Object.keys(schema(name).properties ?? {})).filter((f) => fields.includes(f));

  const VALID_FORCE_CLOSE = { forcedReason: "Cashier left without closing; shift opened on till A" };
  const FORCED_EXAMPLE = (): Record<string, unknown> =>
    exampleValue({ $ref: "#/components/examples/ForceClosedShiftExample" }) as Record<string, unknown>;
  const SCOPE_NAMES = ["tenant_id", "store_id", "branch_id", "device_id", "terminal_id"];
  const CASH_UP_FIELDS = ["countedCash", "expectedCash", "variance", "saleCount", "cashSalesTotal", "cashRefundsTotal"];

  it("carries an RT-742 note: [GATED], strictly additive, not counted, no runtime yet", () => {
    expectAll(info(), [
      "RT-742 (1.4.0-draft; [GATED] owner authorization 2026-10-21; RT-554 follow-up, owner decision 2026-10-19): strictly additive",
      "`cashCount: not_counted`",
      "no totals, no variance and no `ShiftClose`",
      "`forceCloseShift` has no runtime route yet",
      "lists recorded cash-ups only, so a force-closed shift is not listed there",
    ]);
  });

  it("declares forceCloseShift at its path, contract-only, tagged pos-shifts, with no operationId collision", () => {
    const o = op(FORCE_CLOSE);
    expect([o.operationId, o["x-runtime-status"], o.tags]).toEqual(["forceCloseShift", "contract-only", ["pos-shifts"]]);
    expect(o["x-runtime-note"]).toContain("RT-742");
    expect(otherOperationIds.has("forceCloseShift")).toBe(false);
  });

  it("accepts the manager envelope ONLY, manager / admin, re-checked live, by the stuck-list eligibility", () => {
    expect(op(FORCE_CLOSE).security).toEqual([{ operatorAuthorization: [] }]);
    expectAll(forceText(), [
      "The `operatorAuthorization` envelope only; the `device` scheme is not accepted (a device token is the generic 401)",
      "the `operatorAuthorization` scheme) is the generic 401, so a manager whose store access was removed is a 401",
      "A valid operator who does not hold the manager or admin role of the tenant",
      "`store_staff` is refused",
      "is the generic 403 `refused`",
    ]);
    expectAll(describeOf("403"), [
      "the envelope operator is valid but does not hold the manager or admin role of the tenant",
      "including a removed store access), are a 401",
    ]);
  });

  it("is store-scoped: any device of the store, tenant and store from the envelope only, a non-disclosing 404", () => {
    expectAll(forceText(), [
      "opened on ANY device of that store, including the caller's own",
      "Tenant and store come only from the envelope, never the request",
    ]);
    expect(describeOf("404")).toMatch(/non-disclosing/i);
    expectAll(describeOf("404"), ["another store", "another tenant", "unknown id"]);
    expect(response(FORCE_CLOSE, "404")).not.toBe(response(CLOSE, "404"));
  });

  it("takes the store-scoped shift_id path parameter and the required Idempotency-Key, and no scope parameter", () => {
    const o = op(FORCE_CLOSE);
    expect(o["x-idempotency"]).toBe("required");
    expect(o.parameters).toEqual([
      { $ref: "#/components/parameters/StoreShiftId" },
      { $ref: "#/components/parameters/IdempotencyKey" },
    ]);
    const shiftId = parametersOf(FORCE_CLOSE).find((p) => p.name === "shift_id");
    expect(shiftId).toMatchObject({ in: "path", required: true, schema: { type: "string", format: "uuid" } });
    expectAll(flat(shiftId?.description), ["opened on ANY device of that store"]);
    expect(parametersOf(FORCE_CLOSE).filter((p) => SCOPE_NAMES.includes(p.name ?? ""))).toEqual([]);
  });

  it("declares exactly its documented statuses (no 422: there is no cash-up to be inconsistent)", () => {
    expect(statusesOf(FORCE_CLOSE)).toEqual(["200", "201", "400", "401", "403", "404", "409", "425", "429", "500"]);
  });

  it("answers 200 / 201 with ForceClosedShift and Idempotent-Replayed only; every error is the canonical envelope", () => {
    for (const status of ["200", "201"]) {
      expect(responseSchema(FORCE_CLOSE, status)).toEqual({ $ref: "#/components/schemas/ForceClosedShift" });
      expect(response(FORCE_CLOSE, status).headers).toEqual({
        "Idempotent-Replayed": { $ref: "#/components/headers/IdempotentReplayed" },
      });
    }
    const envelope = ["400", "401", "403", "404", "409", "429", "500"].map((status) => responseSchema(FORCE_CLOSE, status));
    expect(envelope).toEqual(envelope.map(() => ({ $ref: "#/components/schemas/ApiError" })));
    expect(op(FORCE_CLOSE).responses?.["425"]).toEqual({ $ref: "#/components/responses/IdempotencyInProgress" });
    expect(op(FORCE_CLOSE).responses?.["429"]).toEqual({ $ref: "#/components/responses/TooManyRequests" });
  });

  it("documents the 409 codes: key conflict, not stuck, closed with a cash-up, already force-closed", () => {
    expectAll(
      describeOf("409"),
      ["idempotency_key_conflict", "shift_not_stuck", "shift_closed", "shift_force_closed"].map((code) => `\`${code}\``),
    );
  });

  it("requires the shift to be stuck now, so a live drawer is never closed remotely", () => {
    expectAll(forceText(), [
      "The shift must be stuck now, by the `GET /shifts/stuck` rule: open, opened longer ago than the staleness threshold, and its opening cashier has no active `pos_operator` session on the store",
      "a manager cannot close a live drawer from another terminal",
    ]);
  });

  it("records NOT COUNTED: no cash-up, never a ShiftClose, never computed by the server (§III)", () => {
    expectAll(forceText(), [
      "It records NO cash-up: `cashCount` is `not_counted`, and there is no `countedCash`, `expectedCash`, `variance` or other total",
      "The server never computes or rewrites a POS cash-up (Constitution §III)",
      "This is not a `ShiftClose`",
      "close the shift on the terminal that holds it with `closeShift`, `closeKind: forced`",
    ]);
  });

  it("states normatively that a not-counted close is never a counted zero and is outside variance flags and the R-9 cross-check", () => {
    expectAll(forceText(), [
      "**Not counted** (normative). The recorded fact is not a counted zero: it has no `countedCash`, `expectedCash`, `variance`, total or `saleCount` at all, never `\"0.00\"`",
      "EXCLUDED from every variance flag (the RT-384 `approvalRequiredByPolicy`, `approvalMissing` and `approverCheck`, which exist only on a `ShiftClose`)",
      "It is also outside the R-9 cash refund cross-check (`closeShift`, Refund cross-check): no close exists for the shift, so no return is claimed, `cashRefundsTotal` is not checked",
    ]);
    expectAll(info(), ["A not-counted close is excluded from every variance flag and from the R-9 cash-refund cross-check, and is never a counted zero"]);
    const flags = ["cashRefundReturnRefs", "approvalRequiredByPolicy", "approvalMissing", "approverCheck"];
    expect(declaredAmong(["ForcedCloseRecord", "ForceClosedShift"], [...CASH_UP_FIELDS, ...flags])).toEqual([]);
  });

  it("states the effect: no longer stuck, no timezone block (RT-544), a new shift may open, nothing edited", () => {
    expectAll(forceText(), [
      "`GET /shifts/stuck` stops listing it",
      "409 `STORE_HAS_OPEN_SHIFT`, RT-544",
      "its terminal may open a new shift",
      "Nothing already recorded for it is edited or deleted",
    ]);
  });

  it("states the late-facts rule: shift_force_closed only for the opening device's close and another-key open replay; a late movement keeps shift_closed", () => {
    expectAll(forceText(), [
      "every later `closeShift` from the device that holds it (any payload) and every `openShift` re-delivery under another `Idempotency-Key` is 409 `shift_force_closed`",
      "Any other device still gets the non-disclosing 404 `shift_not_found` on `closeShift`, as for any shift outside its device, so the code is no oracle for another terminal",
      "An `openShift` re-delivered under the SAME key gets the stored open response (the shared interceptor answers it before the handler), not this code",
      "A later NEW `recordCashMovement` keeps the existing 409 `shift_closed` (a movement recorded BEFORE the force close still replays as `200`)",
      "The POS treats `shift_force_closed` as final for that shift, not as a transient or a payload conflict (`shift_payload_conflict`)",
    ]);
    expectAll(flat(op(CLOSE).description), [
      "A shift of this device that a manager closed with `forceCloseShift` (RT-742) takes no close: it is 409 `shift_force_closed`",
      "A shift that does not resolve to this device, force-closed or not, is the non-disclosing 404 `shift_not_found`; the new code never reaches another device",
    ]);
    expect(flat(op(CLOSE).description)).not.toContain("from any device: it is 409");
    expectAll(flat(op(OPEN).description), [
      "under ANOTHER `Idempotency-Key` is 409 `shift_force_closed`",
      "The same open under the SAME `Idempotency-Key` is answered by the shared `IdempotencyInterceptor` with the stored open response and status (RT-82 K4, within the replay window) before the handler runs",
      "never from an open replay",
    ]);
    expectAll(flat(op(MOVEMENT).description), ["including one a manager closed with `forceCloseShift` (RT-742), is 409 `shift_closed`"]);
    expect(flat(op(MOVEMENT).description)).not.toContain("shift_force_closed");
    expectAll(componentText("OpenShiftConflict"), ["`shift_force_closed`", "under another `Idempotency-Key`"]);
    expectAll(componentText("CloseShiftConflict"), ["`shift_force_closed`", "a shift of another device is 404 `shift_not_found`, never this code"]);
    expectAll(componentText("CashMovementConflict"), ["includes a shift a manager closed with `forceCloseShift`"]);
    expect(componentText("CashMovementConflict")).not.toContain("shift_force_closed");
  });

  it("states the natural key (shift + forcedReason, never the actor) and the audit event", () => {
    expectAll(forceText(), [
      "The natural key is `shift_id` with the payload hash of `forcedReason`, never the actor",
      "A different `forcedReason` for a shift already force-closed is 409 `shift_force_closed`",
      "**Order.** Authentication (401), then the live manager/admin check (403 `refused`), then scope (404 `shift_not_found`), then the natural-key replay (`200`) or, for a different `forcedReason`, 409 `shift_force_closed`, then 409 `shift_closed`, then the stuck rule (409 `shift_not_stuck`)",
      "A replay of a recorded force close is never answered `shift_not_stuck`",
      "One audit event records the closing manager, the terminal the request came from, the terminal that opened the shift and the shift",
      "The reason is stored with the fact and never logged",
    ]);
  });

  it("the request is strict: only forcedReason, no actor, time, scope or cash-up field", () => {
    assertStrictObject("ForceCloseShiftRequest", ["forcedReason"], ["forcedReason"]);
    expect(requestSchemaRef(FORCE_CLOSE)).toBe("#/components/schemas/ForceCloseShiftRequest");
    expect(op(FORCE_CLOSE).requestBody?.required).toBe(true);
    const v = validator("ForceCloseShiftRequest");
    expect([VALID_FORCE_CLOSE, { forcedReason: "x" }, { forcedReason: "x".repeat(200) }].map((body) => v(body))).toEqual([true, true, true]);
    const refused = [{}, { forcedReason: "" }, { forcedReason: "x".repeat(201) }].map((body) => v(body));
    expect(refused).toEqual([false, false, false]);
    const extras = [
      { operatorUserId: USER_ID },
      { closingUserId: USER_ID },
      { closedAt: "2026-10-06T09:10:00Z" },
      { countedCash: "100.00" },
      { tenantId: USER_ID },
      { storeId: USER_ID },
      { deviceId: USER_ID },
    ];
    expect(extras.map((extra) => v({ ...VALID_FORCE_CLOSE, ...extra }))).toEqual(extras.map(() => false));
  });

  it("the projection is a closed ForceClosedShift whose status is force_closed, never closed", () => {
    const fields = ["shiftId", "status", "currencyCode", "openingFloat", "openedAt", "openingUserId", "receivedAt", "forcedClose"];
    assertStrictObject("ForceClosedShift", fields, fields);
    expect(prop("ForceClosedShift", "status")).toMatchObject({ type: "string", const: "force_closed" });
    expect(schema("Shift").properties?.["status"]?.enum).toEqual(["open", "closed"]);
    const v = validator("ForceClosedShift");
    const bad = [{ status: "closed" }, { forcedClose: undefined }, { tenantId: USER_ID }].map((patch) => v({ ...FORCED_EXAMPLE(), ...patch }));
    expect([v(FORCED_EXAMPLE()), ...bad]).toEqual([true, false, false, false]);
  });

  it("the recorded force close names who, when, from which terminal and why, and carries no cash-up field", () => {
    const required = ["closedByUserId", "closedAt", "closedFromTerminalLabel", "openedOnTerminalLabel", "forcedReason", "cashCount"];
    assertStrictObject("ForcedCloseRecord", required, required);
    expect(prop("ForcedCloseRecord", "cashCount")).toMatchObject({ type: "string", const: "not_counted" });
    // A device label is optional (devices.label is nullable): an unlabeled terminal is `null`, never a made-up value.
    expect(prop("ForcedCloseRecord", "closedFromTerminalLabel").type).toEqual(["string", "null"]);
    expect(prop("ForcedCloseRecord", "openedOnTerminalLabel").type).toEqual(["string", "null"]);
    const v = validator("ForcedCloseRecord");
    const record = FORCED_EXAMPLE()["forcedClose"] as Record<string, unknown>;
    const bad = [{ cashCount: "counted" }, { countedCash: "100.00" }, { forcedReason: "" }, { openedOnTerminalLabel: undefined }].map((patch) =>
      v({ ...record, ...patch }),
    );
    const unlabeled = v({ ...record, closedFromTerminalLabel: null, openedOnTerminalLabel: null });
    expect([v(record), unlabeled, ...bad]).toEqual([true, true, false, false, false, false]);
  });

  it("the request and response examples validate against their schemas", () => {
    const results = collectExamples(FORCE_CLOSE).map(({ schemaName, value }) => validator(schemaName)(value));
    // The request example plus the 200 and 201 response examples.
    expect(results.length).toBeGreaterThanOrEqual(3);
    expect(results.filter((ok) => !ok)).toEqual([]);
  });

  it("leaves closeShift, the stuck list and the normal close unchanged (additive)", () => {
    const body = [
      "closedAt", "closingUserId", "closeKind", "forcedReason", "openingFloat", "cashSalesTotal", "cashRefundsTotal",
      "payInTotal", "payOutTotal", "expectedCash", "countedCash", "variance", "saleCount", "cashRefundReturnRefs",
      "varianceApprovedByUserId", "operatorUserId",
    ];
    const required = body.filter((f) => !["forcedReason", "varianceApprovedByUserId", "operatorUserId"].includes(f));
    assertStrictObject("CloseShiftRequest", body, required);
    expect(op(CLOSE).security).toEqual([{ operatorAuthorization: [] }, { device: [] }]);
    expect(statusesOf(CLOSE)).toEqual(["200", "201", "400", "401", "403", "404", "409", "422", "425", "429", "500"]);
    expect(op(CLOSE)["x-runtime-status"]).toBeUndefined();
    expectAll(flat(parametersOf(CLOSE).find((p) => p.name === "shift_id")?.description), ["tenant, store and device"]);
    expect(statusesOf(STUCK)).toEqual(["200", "400", "401"]);
    expect(schema("Shift").required).toEqual(["shiftId", "status", "currencyCode", "openingFloat", "openedAt", "openingUserId", "receivedAt"]);
    expectAll(flat(op(CLOSE).description), ["A stuck shift opened on ANOTHER terminal is 404 `shift_not_found` here"]);
  });

  it("the stuck list gains no field: a listed shift_id is all the force close needs", () => {
    expect(Object.keys(schema("StuckShift").properties ?? {})).toEqual([
      "shift_id", "cashier_display_name", "terminal_label", "opened_at", "duration_minutes",
    ]);
    expectAll(flat(op(STUCK).description), ["a listed `shift_id` is all a manager needs to clear the shift with `forceCloseShift`"]);
  });
});
