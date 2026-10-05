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
  examples?: Record<string, { value?: unknown }>;
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

  otherOperationIds = new Set<string>();
  for (const c of contracts) {
    if (c.dir === "" && c.id === CONTRACT_ID) continue;
    for (const item of Object.values(c.document.paths ?? {})) {
      for (const o of Object.values(item)) {
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

/** Drop prose so two copies of a shared component compare on shape only. */
function shape(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(shape);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === "description" || k === "example" || k === "examples") continue;
      out[k] = shape(v);
    }
    return out;
  }
  return value;
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

  it("GET /shifts/stuck is unchanged: operationId, security, parameter, responses", () => {
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
    expect(Object.keys(stuck.responses ?? {}).sort()).toEqual(["200", "400", "401"]);
    expect(stuck.responses?.["200"]?.content?.["application/json"]?.schema).toEqual({
      $ref: "#/components/schemas/StuckShiftsResponse",
    });
    for (const status of ["400", "401"]) {
      expect(stuck.responses?.[status]?.content?.["application/json"]?.schema).toEqual({
        $ref: "#/components/schemas/Error",
      });
    }
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
    const identity = doc.components?.securitySchemes?.["operator-identity"];
    expect(identity?.["type"]).toBe("http");
    expect(identity?.["scheme"]).toBe("bearer");
    expect(identity?.["bearerFormat"]).toBe("JWT");
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
    const ids = Object.values(doc.paths ?? {})
      .flatMap((item) => Object.values(item))
      .map((o) => o.operationId)
      .sort();
    expect(ids).toEqual(["closeShift", "openShift", "posShiftsGetStuck", "recordCashMovement"]);
  });

  it("collides with no operationId in any other contract", () => {
    expect(NEW_OPERATION_IDS.filter((id) => otherOperationIds.has(id))).toEqual([]);
  });

  it.each(NEW_OPS)("%s is contract-only until RT-17 slice 2, with a runtime note", (_id, route) => {
    const o = op(route);
    expect(o["x-runtime-status"]).toBe("contract-only");
    expect(o["x-runtime-note"] ?? "").toContain("RT-17 slice 2");
  });

  it.each(NEW_OPS)("%s is tagged pos-shifts", (_id, route) => {
    expect(op(route).tags).toEqual(["pos-shifts"]);
  });

  it("the two shift-scoped operations take a required uuid `shift_id` path parameter", () => {
    for (const route of [MOVEMENT, CLOSE]) {
      const params = (op(route).parameters ?? []).map(resolveParameter);
      const shiftId = params.find((p) => p.name === "shift_id");
      expect(shiftId?.in).toBe("path");
      expect(shiftId?.required).toBe(true);
      expect(shiftId?.schema).toEqual({ type: "string", format: "uuid" });
    }
  });

  it("no operation takes a tenant / branch / store / terminal / device parameter or body field", () => {
    const scopeNames = ["tenant_id", "tenantId", "branch_id", "branchId", "store_id", "storeId", "device_id", "deviceId", "terminal_id", "terminalId"];
    for (const [, route] of NEW_OPS) {
      for (const p of (op(route).parameters ?? []).map(resolveParameter)) {
        expect(scopeNames).not.toContain(p.name);
      }
    }
    for (const name of ["OpenShiftRequest", "RecordCashMovementRequest", "CloseShiftRequest"]) {
      for (const forbidden of scopeNames) {
        expect(Object.keys(schema(name).properties ?? {})).not.toContain(forbidden);
      }
    }
  });
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
      const ours = doc.components?.securitySchemes?.[name] ?? {};
      const theirs = salesDoc.components?.securitySchemes?.[name] ?? {};
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
    const defined = new Set(Object.keys(doc.components?.securitySchemes ?? {}));
    for (const item of Object.values(doc.paths ?? {})) {
      for (const o of Object.values(item)) {
        for (const req of o.security ?? []) {
          for (const name of Object.keys(req)) expect(defined.has(name)).toBe(true);
        }
      }
    }
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
  it("declares the Idempotency-Key header exactly as pos-sales/sales.yaml (RT-181 rule)", () => {
    const ours = doc.components?.parameters?.["IdempotencyKey"];
    expect(ours?.name).toBe("Idempotency-Key");
    expect(ours?.in).toBe("header");
    expect(ours?.required).toBe(true);
    expect(ours?.schema).toEqual({
      type: "string",
      minLength: 16,
      maxLength: 128,
      pattern: "^[\\x21-\\x7E]{16,128}$",
    });
    expect(shape(ours)).toEqual(shape(salesDoc.components?.parameters?.["IdempotencyKey"]));
  });

  it.each(NEW_OPS)("%s requires the Idempotency-Key header and is x-idempotency: required", (_id, route) => {
    const o = op(route);
    expect(o["x-idempotency"]).toBe("required");
    expect(o.parameters).toContainEqual({ $ref: "#/components/parameters/IdempotencyKey" });
  });

  it.each(NEW_OPS)("%s answers 201 (first record) and 200 (replay), both with Idempotent-Replayed", (_id, route) => {
    for (const status of ["200", "201"]) {
      const r = response(route, status);
      expect(r.headers?.["Idempotent-Replayed"]).toEqual({
        $ref: "#/components/headers/IdempotentReplayed",
      });
    }
  });

  it("reuses the sales.yaml Idempotent-Replayed header shape", () => {
    expect(shape(doc.components?.headers?.["IdempotentReplayed"])).toEqual(
      shape(salesDoc.components?.headers?.["IdempotentReplayed"]),
    );
  });

  it("each request body is required JSON referencing its strict schema", () => {
    expect(op(OPEN).requestBody?.required).toBe(true);
    expect(op(MOVEMENT).requestBody?.required).toBe(true);
    expect(op(CLOSE).requestBody?.required).toBe(true);
    expect(requestSchemaRef(OPEN)).toBe("#/components/schemas/OpenShiftRequest");
    expect(requestSchemaRef(MOVEMENT)).toBe("#/components/schemas/RecordCashMovementRequest");
    expect(requestSchemaRef(CLOSE)).toBe("#/components/schemas/CloseShiftRequest");
  });

  it("the success projections are Shift (open, close) and CashMovement (movement)", () => {
    for (const status of ["200", "201"]) {
      expect(response(OPEN, status).content?.["application/json"]?.schema).toEqual({ $ref: "#/components/schemas/Shift" });
      expect(response(CLOSE, status).content?.["application/json"]?.schema).toEqual({ $ref: "#/components/schemas/Shift" });
      expect(response(MOVEMENT, status).content?.["application/json"]?.schema).toEqual({
        $ref: "#/components/schemas/CashMovement",
      });
    }
  });
});

// ===========================================================================
// 5. Request bodies
// ===========================================================================
describe("pos-shifts — request bodies", () => {
  it("OpenShiftRequest: fields, required list, closed", () => {
    const s = schema("OpenShiftRequest");
    expect(s.additionalProperties).toBe(false);
    expect(Object.keys(s.properties ?? {}).sort()).toEqual(
      ["currencyCode", "openedAt", "openingFloat", "openingUserId", "operatorUserId", "shiftId"].sort(),
    );
    expect([...(s.required ?? [])].sort()).toEqual(
      ["currencyCode", "openedAt", "openingFloat", "openingUserId", "shiftId"].sort(),
    );
    expect(s.properties?.["shiftId"]).toMatchObject({ type: "string", format: "uuid" });
    expect(s.properties?.["openedAt"]).toMatchObject({ type: "string", format: "date-time" });
    expect(s.properties?.["openingUserId"]).toMatchObject({ type: "string", format: "uuid" });
    expect(s.properties?.["currencyCode"]).toEqual({ $ref: "#/components/schemas/CurrencyCode" });
    expect(s.properties?.["openingFloat"]).toEqual({ $ref: "#/components/schemas/NonNegativeDecimalAmount" });
    expect(s.properties?.["shiftId"]?.description ?? "").toContain("UUIDv7");
  });

  it("RecordCashMovementRequest: fields, required list, enums, closed", () => {
    const s = schema("RecordCashMovementRequest");
    expect(s.additionalProperties).toBe(false);
    expect(Object.keys(s.properties ?? {}).sort()).toEqual(
      ["amount", "kind", "movementId", "note", "occurredAt", "operatorUserId", "reasonCode"].sort(),
    );
    expect([...(s.required ?? [])].sort()).toEqual(["amount", "kind", "movementId", "occurredAt", "reasonCode"].sort());
    expect(s.properties?.["movementId"]).toMatchObject({ type: "string", format: "uuid" });
    expect(s.properties?.["kind"]?.enum).toEqual(["pay_in", "pay_out"]);
    expect(s.properties?.["reasonCode"]?.enum).toEqual(["bank_drop", "float_top_up", "petty_expense", "other"]);
    expect(s.properties?.["amount"]).toEqual({ $ref: "#/components/schemas/PositiveDecimalAmount" });
    expect(s.properties?.["occurredAt"]).toMatchObject({ type: "string", format: "date-time" });
    expect(s.properties?.["note"]).toMatchObject({ type: "string", minLength: 1, maxLength: 200 });
    expect(s.properties?.["note"]?.description ?? "").toMatch(/no PII/);
  });

  it("CloseShiftRequest: fields, required list, enums, closed", () => {
    const s = schema("CloseShiftRequest");
    expect(s.additionalProperties).toBe(false);
    const money = [
      "openingFloat",
      "cashSalesTotal",
      "cashRefundsTotal",
      "payInTotal",
      "payOutTotal",
      "expectedCash",
      "countedCash",
    ];
    expect(Object.keys(s.properties ?? {}).sort()).toEqual(
      [
        "closedAt",
        "closingUserId",
        "closeKind",
        "forcedReason",
        ...money,
        "variance",
        "saleCount",
        "cashRefundReturnRefs",
        "varianceApprovedByUserId",
        "operatorUserId",
      ].sort(),
    );
    expect([...(s.required ?? [])].sort()).toEqual(
      ["closedAt", "closingUserId", "closeKind", ...money, "variance", "saleCount", "cashRefundReturnRefs"].sort(),
    );
    expect(s.properties?.["closeKind"]?.enum).toEqual(["normal", "forced"]);
    for (const m of money) {
      expect(s.properties?.[m]).toEqual({ $ref: "#/components/schemas/NonNegativeDecimalAmount" });
    }
    expect(s.properties?.["variance"]).toEqual({ $ref: "#/components/schemas/SignedDecimalAmount" });
    expect(s.properties?.["saleCount"]).toMatchObject({ type: "integer", minimum: 0 });
    expect(s.properties?.["cashRefundReturnRefs"]).toMatchObject({
      type: "array",
      uniqueItems: true,
      items: { type: "string", format: "uuid" },
    });
    expect(s.properties?.["varianceApprovedByUserId"]).toMatchObject({ type: "string", format: "uuid" });
    expect(s.properties?.["closedAt"]).toMatchObject({ type: "string", format: "date-time" });
    expect(s.properties?.["closingUserId"]).toMatchObject({ type: "string", format: "uuid" });
    expect(s.properties?.["forcedReason"]).toMatchObject({ type: "string", minLength: 1, maxLength: 200 });
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
  const EXPECTED_STATUSES: Record<string, string[]> = {
    openShift: ["200", "201", "400", "401", "403", "409", "429", "500"],
    recordCashMovement: ["200", "201", "400", "401", "403", "404", "409", "429", "500"],
    closeShift: ["200", "201", "400", "401", "403", "404", "409", "422", "429", "500"],
  };

  it.each(NEW_OPS)("%s declares exactly its documented statuses", (id, route) => {
    expect(Object.keys(op(route).responses ?? {}).sort()).toEqual(EXPECTED_STATUSES[id]!.sort());
  });

  it("the cash-up error envelope is the canonical sales.yaml Error shape", () => {
    expect(shape(schema("ApiError"))).toEqual(shape(salesDoc.components?.schemas?.["Error"]));
  });

  it.each(NEW_OPS)("%s: every error response uses the canonical envelope", (_id, route) => {
    for (const status of Object.keys(op(route).responses ?? {})) {
      if (status === "200" || status === "201") continue;
      expect(response(route, status).content?.["application/json"]?.schema).toEqual({
        $ref: "#/components/schemas/ApiError",
      });
    }
  });

  const CODES: Array<[string, Route, string, string[]]> = [
    ["openShift", OPEN, "400", ["validation_error"]],
    ["openShift", OPEN, "403", ["refused"]],
    ["openShift", OPEN, "409", ["idempotency_key_conflict", "shift_payload_conflict", "shift_already_open"]],
    ["openShift", OPEN, "401", ["unauthorized"]],
    ["openShift", OPEN, "429", ["RATE_LIMITED"]],
    ["recordCashMovement", MOVEMENT, "400", ["validation_error"]],
    ["recordCashMovement", MOVEMENT, "403", ["refused"]],
    ["recordCashMovement", MOVEMENT, "404", ["shift_not_found"]],
    ["recordCashMovement", MOVEMENT, "409", ["idempotency_key_conflict", "shift_payload_conflict", "shift_closed"]],
    ["closeShift", CLOSE, "400", ["validation_error"]],
    ["closeShift", CLOSE, "403", ["refused"]],
    ["closeShift", CLOSE, "404", ["shift_not_found"]],
    ["closeShift", CLOSE, "409", ["idempotency_key_conflict", "shift_payload_conflict"]],
    ["closeShift", CLOSE, "422", ["shift_cashup_inconsistent", "currency_mismatch", "refund_ref_invalid"]],
  ];

  it.each(CODES)("%s %s documents error codes %s", (_id, route, status, codes) => {
    const text = response(route, status).description ?? "";
    for (const code of codes) expect(text).toContain(`\`${code}\``);
  });

  it("the 404 is non-disclosing across tenant, store and device", () => {
    const text = response(MOVEMENT, "404").description ?? "";
    expect(text).toMatch(/non-disclosing/i);
    for (const word of ["tenant", "store", "device"]) expect(text).toContain(word);
  });

  it("the 429 carries Retry-After", () => {
    for (const [, route] of NEW_OPS) {
      expect(response(route, "429").headers?.["Retry-After"]).toEqual({ $ref: "#/components/headers/RetryAfter" });
    }
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
    const media: MediaObject[] = [];
    const body = op(route).requestBody?.content?.["application/json"];
    if (body) media.push(body);
    for (const status of Object.keys(op(route).responses ?? {})) {
      const m = response(route, status).content?.["application/json"];
      if (m) media.push(m);
    }
    let seen = 0;
    for (const m of media) {
      const ref = m.schema?.$ref;
      if (!ref) continue;
      for (const ex of Object.values(m.examples ?? {})) {
        const v = validator(ref.replace("#/components/schemas/", ""));
        expect({ ok: v(ex.value), errors: v.errors }).toEqual({ ok: true, errors: null });
        seen += 1;
      }
    }
    // A request example plus at least one success example per operation.
    expect(seen).toBeGreaterThanOrEqual(2);
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
