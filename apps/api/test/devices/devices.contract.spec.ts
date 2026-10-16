/**
 * apps/api/test/devices/devices.contract.spec.ts
 *
 * RT-365 (RT-287 F2): the Console device registry contract
 * (`devices.openapi.yaml`) that Admin-Console RT-371 / RT-372 consume — the
 * device list and detail, and the revoke with a structured reason, the
 * session / pairing-code cascade and the Cash Session rule (RT-287 D-Q3 and
 * D-Q4 as amended). `[GATED]` contract-first (PR #777); the RT-365 runtime
 * ships all three operations unchanged on the wire
 * (`devices.http.integration.spec.ts` covers them over HTTP).
 *
 * Structural / load-only, plus AJV fixtures against the contract schemas. No
 * app boot and no HTTP. What this pins:
 *
 *   1. Two GETs and one POST at their paths, implemented, with no collision
 *      with another contract's operationIds.
 *   2. Security is the human `cookieAuth` only; 404 (not 403) is the role /
 *      scope refusal; no tenant id is accepted from the request; the revoke
 *      declares the recovery 403, the 409 Cash Session refusal and the 422
 *      recovery-requirement refusals.
 *   3. The list filters, cursor and page bounds.
 *   4. Projections are strict, never carry a credential, a previous token or a
 *      tenant id, and keep trust state consistent with the revoke / retire
 *      timestamps.
 *   5. The revoke body: the D-Q3 reason enum, `other` requires a note, the note
 *      matches the 0040 CHECK (1..500, not blank), unknown keys refused.
 *   6. AJV fixtures: valid payloads pass, each invalid one fails.
 *   7. No POS path, and the POS pairing contract keeps its operations.
 */
import "reflect-metadata";

import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";

import { loadOpenApiContracts } from "../../src/openapi/loader";

const CONTRACT_ID = "devices.openapi";
const PAIRING_ID = "pos-terminal-pairing.openapi";

const LIST_PATH = "/api/v1/devices";
const DETAIL_PATH = "/api/v1/devices/{deviceId}";
const REVOKE_PATH = "/api/v1/devices/{deviceId}/revoke";

const OPERATION_IDS = ["consoleGetDevice", "consoleListDevices", "consoleRevokeDevice"] as const;

const REVOKE_REASONS = [
  "lost",
  "stolen",
  "suspected_compromise",
  "hardware_failure",
  "replaced",
  "moved",
  "retired",
  "admin_error",
  "other",
];

type SchemaName =
  | "DeviceSummary"
  | "DevicePage"
  | "DeviceDetail"
  | "DeviceRevokeRequest"
  | "DeviceRevokeResult"
  | "Error";

interface ParameterObject {
  $ref?: string;
  in?: string;
  name?: string;
  required?: boolean;
  schema?: Record<string, unknown>;
}

interface OperationObject {
  operationId?: string;
  security?: Array<Record<string, unknown>>;
  parameters?: ParameterObject[];
  requestBody?: { required?: boolean; content?: Record<string, { schema?: unknown }> };
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
  info?: { version?: string };
  security?: Array<Record<string, unknown>>;
  paths?: Record<string, Record<string, OperationObject>>;
  components?: {
    schemas?: Record<string, SchemaObject>;
    parameters?: Record<string, ParameterObject>;
    securitySchemes?: Record<string, Record<string, unknown>>;
  };
}

let doc: OpenApiDocument;
let pairingDoc: OpenApiDocument;
let otherOperationIds: Set<string>;
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);

beforeAll(() => {
  const contracts = loadOpenApiContracts();
  const found = contracts.find((c) => c.id === CONTRACT_ID);
  if (!found) throw new Error(`${CONTRACT_ID} not found in packages/contracts/openapi/`);
  doc = found.document as OpenApiDocument;
  const pairing = contracts.find((c) => c.id === PAIRING_ID);
  if (!pairing) throw new Error(`${PAIRING_ID} not found in packages/contracts/openapi/`);
  pairingDoc = pairing.document as OpenApiDocument;
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

function op(path: string, method: "get" | "post" = "get"): OperationObject {
  const found = doc.paths?.[path]?.[method];
  if (!found) throw new Error(`${method.toUpperCase()} ${path} not declared`);
  return found;
}

const OPS: ReadonlyArray<[string, "get" | "post"]> = [
  [LIST_PATH, "get"],
  [DETAIL_PATH, "get"],
  [REVOKE_PATH, "post"],
];

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
function params(path: string, method: "get" | "post" = "get"): ParameterObject[] {
  return (op(path, method).parameters ?? []).map((p) =>
    p.$ref ? doc.components!.parameters![p.$ref.replace("#/components/parameters/", "")]! : p,
  );
}

function param(path: string, name: string, method: "get" | "post" = "get"): ParameterObject {
  const found = params(path, method).find((p) => p.name === name);
  if (!found) throw new Error(`parameter ${name} not declared on ${path}`);
  return found;
}

const DEVICE_ID = "0190f5a2-3b4c-7d8e-9f01-23456789abcd";
const STORE_ID = "0190f5a2-3b4c-7d8e-9f01-000000000002";
const USER_ID = "0190f5a2-3b4c-7d8e-9f01-000000000003";
const SHIFT_ID = "0190f5a2-3b4c-7d8e-9f01-000000000004";
const OTHER_DEVICE_ID = "0190f5a2-3b4c-7d8e-9f01-000000000005";

const ACTIVE = {
  deviceId: DEVICE_ID,
  storeId: STORE_ID,
  label: "Till 1",
  trustState: "active",
  createdAt: "2026-10-01T09:00:00.000Z",
  expiresAt: "2026-12-30T09:00:00.000Z",
  lastSeenAt: null,
  revokedAt: null,
  revokedByUserId: null,
  revokeReason: null,
  retiredAt: null,
  replacesDeviceId: null,
  replacedByDeviceId: null,
  custodyExceptionShiftId: null,
} as const;

const REVOKED_WITH_EXCEPTION = {
  ...ACTIVE,
  trustState: "revoked",
  revokedAt: "2026-10-16T10:00:00.000Z",
  revokedByUserId: USER_ID,
  revokeReason: "stolen",
  custodyExceptionShiftId: SHIFT_ID,
} as const;

const DETAIL = {
  ...REVOKED_WITH_EXCEPTION,
  revokeNote: "Till taken from counter 2; drawer cash in the back-office safe",
  retiredByUserId: null,
  retireReason: null,
} as const;

function without<T extends object>(value: T, key: keyof T): Omit<T, typeof key> {
  const copy = { ...value };
  delete copy[key];
  return copy;
}

// ===========================================================================
// 1. Document + operations
// ===========================================================================
describe("devices — document and operations", () => {
  it("is an OpenAPI 3.1 document at version 1.0.0-draft", () => {
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info?.version).toBe("1.0.0-draft");
  });

  it("declares exactly the list, detail and revoke, and nothing else", () => {
    expect(Object.keys(doc.paths ?? {}).sort()).toEqual([LIST_PATH, DETAIL_PATH, REVOKE_PATH].sort());
    expect(Object.keys(doc.paths![LIST_PATH]!)).toEqual(["get"]);
    expect(Object.keys(doc.paths![DETAIL_PATH]!)).toEqual(["get"]);
    expect(Object.keys(doc.paths![REVOKE_PATH]!)).toEqual(["post"]);
    expect(op(LIST_PATH).operationId).toBe("consoleListDevices");
    expect(op(DETAIL_PATH).operationId).toBe("consoleGetDevice");
    expect(op(REVOKE_PATH, "post").operationId).toBe("consoleRevokeDevice");
  });

  it("has a request body on the revoke only", () => {
    expect(op(LIST_PATH).requestBody).toBeUndefined();
    expect(op(DETAIL_PATH).requestBody).toBeUndefined();
    const body = op(REVOKE_PATH, "post").requestBody;
    expect(body?.required).toBe(true);
    expect(body?.content?.["application/json"]?.schema).toEqual({
      $ref: "#/components/schemas/DeviceRevokeRequest",
    });
  });

  it("marks no operation contract-only (the RT-365 runtime ships all three)", () => {
    for (const [path, method] of OPS) {
      expect(op(path, method)["x-runtime-status"]).toBeUndefined();
      expect(op(path, method)["x-runtime-note"]).toBeUndefined();
    }
  });

  it("collides with no operationId in any other contract", () => {
    expect(OPERATION_IDS.filter((id) => otherOperationIds.has(id))).toEqual([]);
  });
});

// ===========================================================================
// 2. Auth, non-disclosure and the revoke refusals
// ===========================================================================
describe("devices — auth and refusals", () => {
  it("accepts only the human cookieAuth session", () => {
    expect(doc.security).toEqual([{ cookieAuth: [] }]);
    for (const [path, method] of OPS) expect(op(path, method).security).toBeUndefined();
    expect(Object.keys(doc.components?.securitySchemes ?? {})).toEqual(["cookieAuth"]);
    expect(doc.components!.securitySchemes!["cookieAuth"]).toMatchObject({
      type: "apiKey",
      in: "cookie",
      name: "dp2_session",
    });
  });

  it("answers the reads with 200 / 400 / 401 / 404 / 500, refusing role or scope as 404", () => {
    for (const path of [LIST_PATH, DETAIL_PATH]) {
      expect(Object.keys(op(path).responses ?? {}).sort()).toEqual(["200", "400", "401", "404", "500"]);
    }
  });

  it("answers the revoke with 200 / 400 / 401 / 403 / 404 / 409 / 422 / 500", () => {
    expect(Object.keys(op(REVOKE_PATH, "post").responses ?? {}).sort()).toEqual(
      ["200", "400", "401", "403", "404", "409", "422", "500"].sort(),
    );
    const responses = op(REVOKE_PATH, "post").responses!;
    expect(responses["403"]).toEqual({ $ref: "#/components/responses/RevokeForbidden" });
    expect(responses["409"]).toEqual({ $ref: "#/components/responses/UnresolvedCashSession" });
    expect(responses["422"]).toEqual({ $ref: "#/components/responses/RecoveryRequirementsUnmet" });
  });

  it("names the stable error codes of the revoke refusals", () => {
    const text = JSON.stringify(doc);
    for (const code of [
      "origin_rejected",
      "recovery_revoke_forbidden",
      "unresolved_cash_session",
      "recovery_note_required",
      "custody_exception_not_acknowledged",
    ]) {
      expect(text).toContain(code);
    }
  });

  it("takes no tenant id from the request", () => {
    for (const [path, method] of OPS) {
      expect(params(path, method).map((p) => p.name)).not.toEqual(
        expect.arrayContaining([expect.stringMatching(/tenant/i)]),
      );
    }
    expect(Object.keys(schema("DeviceRevokeRequest").properties ?? {})).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/tenant|store|user|actor/i)]),
    );
  });
});

// ===========================================================================
// 3. List filters and paging
// ===========================================================================
describe("devices — list filters and paging", () => {
  it("declares the store and trust-state filters plus paging, all optional query parameters", () => {
    expect(params(LIST_PATH).map((p) => p.name).sort()).toEqual(
      ["cursor", "page_size", "store_id", "trust_state"].sort(),
    );
    for (const p of params(LIST_PATH)) {
      expect(p.in).toBe("query");
      expect(p.required).toBe(false);
    }
  });

  it("filters by a UUID store and the three trust states", () => {
    expect(param(LIST_PATH, "store_id").schema).toMatchObject({ type: "string", format: "uuid" });
    expect(param(LIST_PATH, "trust_state").schema).toEqual({ $ref: "#/components/schemas/TrustState" });
    expect(doc.components!.schemas!["TrustState"]!["enum"]).toEqual(["active", "revoked", "retired"]);
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

  it("takes the device id as a UUID path parameter on the detail and the revoke", () => {
    for (const [path, method] of [
      [DETAIL_PATH, "get"],
      [REVOKE_PATH, "post"],
    ] as const) {
      expect(params(path, method)).toHaveLength(1);
      expect(param(path, "deviceId", method)).toMatchObject({
        in: "path",
        required: true,
        schema: { type: "string", format: "uuid" },
      });
    }
  });

  it("caps a page at the page_size maximum", () => {
    expect(schema("DevicePage").properties?.["items"]).toMatchObject({ maxItems: 200 });
  });
});

// ===========================================================================
// 4. Projections
// ===========================================================================
describe("devices — projections", () => {
  const PROJECTIONS: SchemaName[] = ["DeviceSummary", "DevicePage", "DeviceDetail", "DeviceRevokeResult"];

  it("is strict, and every key is required", () => {
    for (const name of PROJECTIONS) {
      const s = schema(name);
      expect(s.additionalProperties).toBe(false);
      expect([...(s.required ?? [])].sort()).toEqual(Object.keys(s.properties ?? {}).sort());
    }
  });

  it("carries no tenant id, credential, previous token or contact data", () => {
    const forbidden = /tenant|hash|token|secret|^pin|previous|validUntil|email|phone/i;
    for (const name of PROJECTIONS) {
      expect(Object.keys(schema(name).properties ?? {}).filter((k) => forbidden.test(k))).toEqual([]);
    }
  });

  it("lists the RT-365 fields, with the custody exception as a shift link", () => {
    expect(Object.keys(schema("DeviceSummary").properties ?? {}).sort()).toEqual(
      [
        "createdAt",
        "custodyExceptionShiftId",
        "deviceId",
        "expiresAt",
        "label",
        "lastSeenAt",
        "replacedByDeviceId",
        "replacesDeviceId",
        "retiredAt",
        "revokeReason",
        "revokedAt",
        "revokedByUserId",
        "storeId",
        "trustState",
      ].sort(),
    );
  });

  it("adds only the revoke note and the retire attribution on the detail", () => {
    const summary = Object.keys(schema("DeviceSummary").properties ?? {});
    const detail = Object.keys(schema("DeviceDetail").properties ?? {});
    expect(detail.filter((k) => !summary.includes(k)).sort()).toEqual(
      ["retireReason", "retiredByUserId", "revokeNote"].sort(),
    );
    expect(Object.keys(schema("DeviceSummary").properties ?? {})).not.toContain("revokeNote");
  });

  it("matches the summary fields on the detail", () => {
    const summary = schema("DeviceSummary").properties!;
    const detail = schema("DeviceDetail").properties!;
    const shape = (s: Record<string, unknown> | undefined): Record<string, unknown> | undefined => {
      if (!s) return s;
      const { description: _description, ...rest } = s;
      return rest;
    };
    for (const [key, value] of Object.entries(summary)) {
      expect({ key, schema: shape(detail[key]) }).toEqual({ key, schema: shape(value) });
    }
  });

  it("uses the D-Q3 revoke reasons, nullable on a projection (a pre-0040 revoke has none)", () => {
    expect(doc.components!.schemas!["RevokeReason"]!["enum"]).toEqual(REVOKE_REASONS);
    expect(validator("DeviceSummary")({ ...REVOKED_WITH_EXCEPTION, revokeReason: null, revokedByUserId: null })).toBe(
      true,
    );
  });

  it("reports the revoke outcome with the current device state", () => {
    expect(schema("DeviceRevokeResult").properties?.["outcome"]).toMatchObject({
      enum: ["revoked", "already_revoked"],
    });
    expect(schema("DeviceRevokeResult").properties?.["device"]).toEqual({
      $ref: "#/components/schemas/DeviceDetail",
    });
  });
});

// ===========================================================================
// 5. Revoke body
// ===========================================================================
describe("devices — revoke body", () => {
  it("requires a D-Q3 reason; the note and the acknowledgement are optional keys", () => {
    const body = schema("DeviceRevokeRequest");
    expect(body.additionalProperties).toBe(false);
    expect(body.required).toEqual(["reason"]);
    expect(Object.keys(body.properties ?? {}).sort()).toEqual(
      ["acknowledgeCustodyException", "note", "reason"].sort(),
    );
    expect(body.properties?.["reason"]).toEqual({ $ref: "#/components/schemas/RevokeReason" });
    expect(body.properties?.["acknowledgeCustodyException"]).toMatchObject({ type: "boolean" });
  });

  it("bounds the note like the 0040 CHECK (1..500, not blank)", () => {
    expect(schema("DeviceRevokeRequest").properties?.["note"]).toEqual({
      $ref: "#/components/schemas/RevokeNote",
    });
    expect(doc.components!.schemas!["RevokeNote"]).toMatchObject({
      type: "string",
      minLength: 1,
      maxLength: 500,
      pattern: "\\S",
    });
  });

  it.each(REVOKE_REASONS.filter((r) => r !== "other"))("accepts reason %s without a note", (reason) => {
    expect(validator("DeviceRevokeRequest")({ reason })).toBe(true);
  });

  it("accepts a recovery revoke with a note and the acknowledgement", () => {
    expect(
      validator("DeviceRevokeRequest")({
        reason: "hardware_failure",
        note: "Till will not boot; drawer cash counted into the safe",
        acknowledgeCustodyException: true,
      }),
    ).toBe(true);
    expect(validator("DeviceRevokeRequest")({ reason: "other", note: "Pilot ended" })).toBe(true);
  });

  it.each([
    ["no reason", {}],
    ["an unknown reason", { reason: "broken" }],
    ["other without a note", { reason: "other" }],
    ["an empty note", { reason: "lost", note: "" }],
    ["a blank note", { reason: "lost", note: "   " }],
    ["a note over 500 characters", { reason: "lost", note: "x".repeat(501) }],
    ["a string acknowledgement", { reason: "hardware_failure", acknowledgeCustodyException: "true" }],
    ["an unknown key", { reason: "lost", storeId: STORE_ID }],
    ["a snake_case acknowledgement", { reason: "lost", acknowledge_custody_exception: true }],
  ])("rejects a body with %s", (_label, payload) => {
    expect(validator("DeviceRevokeRequest")(payload)).toBe(false);
  });
});

// ===========================================================================
// 6. AJV fixtures
// ===========================================================================
describe("devices — AJV fixtures", () => {
  it("accepts an active device, a revoked one with a custody exception, a retired one and a page", () => {
    expect(validator("DeviceSummary")(ACTIVE)).toBe(true);
    expect(validator("DeviceSummary")({ ...ACTIVE, label: null, lastSeenAt: "2026-10-16T09:00:00.000Z" })).toBe(true);
    expect(validator("DeviceSummary")(REVOKED_WITH_EXCEPTION)).toBe(true);
    expect(
      validator("DeviceSummary")({
        ...REVOKED_WITH_EXCEPTION,
        trustState: "retired",
        revokeReason: "retired",
        retiredAt: "2026-10-16T11:00:00.000Z",
        custodyExceptionShiftId: null,
        replacedByDeviceId: OTHER_DEVICE_ID,
      }),
    ).toBe(true);
    expect(validator("DevicePage")({ items: [REVOKED_WITH_EXCEPTION, ACTIVE], nextCursor: "eyJyIjowfQ" })).toBe(true);
    expect(validator("DevicePage")({ items: [], nextCursor: null })).toBe(true);
  });

  it("accepts a detail and both revoke outcomes", () => {
    expect(validator("DeviceDetail")(DETAIL)).toBe(true);
    expect(validator("DeviceDetail")({ ...ACTIVE, revokeNote: null, retiredByUserId: null, retireReason: null })).toBe(
      true,
    );
    expect(validator("DeviceRevokeResult")({ outcome: "revoked", device: DETAIL })).toBe(true);
    expect(validator("DeviceRevokeResult")({ outcome: "already_revoked", device: DETAIL })).toBe(true);
  });

  it.each([
    ["an active device with a revoke time", { ...ACTIVE, revokedAt: "2026-10-16T10:00:00.000Z" }],
    ["an active device with a custody exception", { ...ACTIVE, custodyExceptionShiftId: SHIFT_ID }],
    ["a revoked device without a revoke time", { ...REVOKED_WITH_EXCEPTION, revokedAt: null }],
    ["a revoked device with a retire time", { ...REVOKED_WITH_EXCEPTION, retiredAt: "2026-10-16T11:00:00.000Z" }],
    ["a retired device without a retire time", { ...REVOKED_WITH_EXCEPTION, trustState: "retired" }],
    ["an unknown trust state", { ...ACTIVE, trustState: "expired" }],
    ["an unknown revoke reason", { ...REVOKED_WITH_EXCEPTION, revokeReason: "broken" }],
    ["a missing last-seen key", without(ACTIVE, "lastSeenAt")],
    ["a token hash", { ...ACTIVE, tokenHash: "abc" }],
    ["the revoke note on the list item", { ...REVOKED_WITH_EXCEPTION, revokeNote: "x" }],
  ])("rejects a summary with %s", (_label, payload) => {
    expect(validator("DeviceSummary")(payload)).toBe(false);
  });

  it("rejects a revoke result with an unknown outcome or without the device", () => {
    expect(validator("DeviceRevokeResult")({ outcome: "noop", device: DETAIL })).toBe(false);
    expect(validator("DeviceRevokeResult")({ outcome: "revoked" })).toBe(false);
  });

  it("rejects a page over 200 items or without nextCursor", () => {
    expect(validator("DevicePage")({ items: Array(201).fill(ACTIVE), nextCursor: null })).toBe(false);
    expect(validator("DevicePage")({ items: [] })).toBe(false);
  });

  it("accepts the canonical error envelope", () => {
    expect(
      validator("Error")({ error: { code: "unresolved_cash_session", message: "Conflict", request_id: DEVICE_ID } }),
    ).toBe(true);
    expect(validator("Error")({ code: "not_found" })).toBe(false);
  });
});

// ===========================================================================
// 7. POS surface untouched
// ===========================================================================
describe("devices — POS surface unchanged", () => {
  it("adds no POS path, and the pairing contract keeps its operations", () => {
    expect(Object.keys(doc.paths ?? {}).filter((p) => p.startsWith("/api/pos/"))).toEqual([]);
    const pairingOps = Object.values(pairingDoc.paths ?? {}).flatMap((item) =>
      Object.values(item).map((o) => o.operationId),
    );
    expect(pairingOps.length).toBeGreaterThan(0);
    expect(pairingOps.filter((id) => typeof id === "string" && OPERATION_IDS.includes(id as never))).toEqual([]);
  });
});
