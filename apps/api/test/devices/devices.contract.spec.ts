/**
 * apps/api/test/devices/devices.contract.spec.ts
 *
 * RT-365 (RT-287 F2): the Console device registry contract
 * (`devices.openapi.yaml`) that Admin-Console RT-371 / RT-372 consume — the
 * device list and detail, and the revoke with a structured reason, the
 * session / pairing-code cascade and the Cash Session rule (RT-287 D-Q3 and
 * D-Q4 as amended). `[GATED]` contract-first: the three operations are marked
 * `x-runtime-status: contract-only` until the RT-365 runtime ships.
 *
 * Structural / load-only, plus AJV fixtures against the contract schemas. No
 * app boot and no HTTP. Pinned here:
 *
 *   1. Two GETs and one POST, contract-only, no operationId collision.
 *   2. cookieAuth only; role / scope refusal is 404; the revoke declares its
 *      403 / 409 / 422 refusals and their stable codes; no tenant from the
 *      request.
 *   3. The list filters, cursor and page bounds.
 *   4. Strict projections without credentials, with trust state consistent
 *      with the revoke / retire timestamps.
 *   5. The revoke body: D-Q3 reasons, `other` needs a note, the 0040 note shape.
 *   6. No POS path; the POS pairing contract keeps its operations.
 */
import { readContract, type ContractReader, type HttpMethod, type JsonObject } from "../_helpers/openapi-contract";

const LIST_PATH = "/api/v1/devices";
const DETAIL_PATH = "/api/v1/devices/{deviceId}";
const REVOKE_PATH = "/api/v1/devices/{deviceId}/revoke";

/** [method, path, operationId] of every operation the contract declares. */
const OPERATIONS: ReadonlyArray<readonly [HttpMethod, string, string]> = [
  ["get", LIST_PATH, "consoleListDevices"],
  ["get", DETAIL_PATH, "consoleGetDevice"],
  ["post", REVOKE_PATH, "consoleRevokeDevice"],
];

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

const SUMMARY_KEYS = [
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
];

let contract: ContractReader;

beforeAll(() => {
  contract = readContract("devices.openapi");
});

const props = (name: string): Record<string, JsonObject> =>
  (contract.schema(name)["properties"] ?? {}) as Record<string, JsonObject>;
const keysOf = (name: string): string[] => Object.keys(props(name)).sort();
const paramNamed = (method: HttpMethod, path: string, name: string): JsonObject | undefined =>
  contract.parameters(method, path).find((p) => p["name"] === name);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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
};

const REVOKED = {
  ...ACTIVE,
  trustState: "revoked",
  revokedAt: "2026-10-16T10:00:00.000Z",
  revokedByUserId: USER_ID,
  revokeReason: "stolen",
  custodyExceptionShiftId: SHIFT_ID,
};

const RETIRED = {
  ...REVOKED,
  trustState: "retired",
  revokeReason: "retired",
  retiredAt: "2026-10-16T11:00:00.000Z",
  custodyExceptionShiftId: null,
  replacedByDeviceId: OTHER_DEVICE_ID,
};

const DETAIL_EXTRA = { revokeNote: null, retiredByUserId: null, retireReason: null };

const omit = (value: Record<string, unknown>, key: string): Record<string, unknown> =>
  Object.fromEntries(Object.entries(value).filter(([k]) => k !== key));

// ===========================================================================
// 1. Operations
// ===========================================================================
describe("devices contract — operations", () => {
  it("is OpenAPI 3.1.0 at 1.0.0-draft with exactly the three operations", () => {
    expect(contract.document["openapi"]).toBe("3.1.0");
    expect((contract.document["info"] as JsonObject)["version"]).toBe("1.0.0-draft");
    const declared = Object.entries(contract.document["paths"] as Record<string, JsonObject>).flatMap(([path, item]) =>
      Object.keys(item).map((method) => `${method} ${path}`),
    );
    expect(declared.sort()).toEqual(OPERATIONS.map(([m, p]) => `${m} ${p}`).sort());
  });

  it.each(OPERATIONS)("%s %s is %s, contract-only with an RT-365 note", (method, path, operationId) => {
    const operation = contract.operation(method, path);
    expect(operation["operationId"]).toBe(operationId);
    expect(operation["x-runtime-status"]).toBe("contract-only");
    expect(String(operation["x-runtime-note"])).toContain("RT-365");
    expect(contract.foreignOperationIds.has(operationId)).toBe(false);
  });

  it("takes a required JSON body on the revoke only", () => {
    expect(contract.operation("get", LIST_PATH)["requestBody"]).toBeUndefined();
    expect(contract.operation("get", DETAIL_PATH)["requestBody"]).toBeUndefined();
    expect(contract.operation("post", REVOKE_PATH)["requestBody"]).toEqual({
      required: true,
      content: { "application/json": { schema: { $ref: "#/components/schemas/DeviceRevokeRequest" } } },
    });
  });
});

// ===========================================================================
// 2. Auth and refusals
// ===========================================================================
describe("devices contract — auth and refusals", () => {
  it("declares the dp2_session cookie as the only scheme, document-wide", () => {
    const components = contract.document["components"] as JsonObject;
    expect(contract.document["security"]).toEqual([{ cookieAuth: [] }]);
    expect(Object.keys(components["securitySchemes"] as JsonObject)).toEqual(["cookieAuth"]);
    expect((components["securitySchemes"] as Record<string, JsonObject>)["cookieAuth"]).toMatchObject({
      type: "apiKey",
      in: "cookie",
      name: "dp2_session",
    });
    for (const [method, path] of OPERATIONS) expect(contract.operation(method, path)["security"]).toBeUndefined();
  });

  it.each([
    ["get", LIST_PATH, ["200", "400", "401", "404", "500"]],
    ["get", DETAIL_PATH, ["200", "400", "401", "404", "500"]],
    ["post", REVOKE_PATH, ["200", "400", "401", "403", "404", "409", "422", "500"]],
  ] as const)("%s %s answers exactly %j (scope refusals are 404)", (method, path, statuses) => {
    expect(Object.keys(contract.operation(method, path)["responses"] as JsonObject).sort()).toEqual([...statuses].sort());
  });

  it("maps the revoke refusals to named responses carrying their stable codes", () => {
    const responses = contract.operation("post", REVOKE_PATH)["responses"] as Record<string, JsonObject>;
    const named = (status: string): string => String(responses[status]?.["$ref"]).replace("#/components/responses/", "");
    const shared = (contract.document["components"] as JsonObject)["responses"] as Record<string, JsonObject>;
    const codes: Record<string, string[]> = {
      "403": ["origin_rejected", "recovery_revoke_forbidden"],
      "409": ["unresolved_cash_session"],
      "422": ["recovery_note_required", "custody_exception_not_acknowledged"],
    };
    expect([named("403"), named("409"), named("422")]).toEqual([
      "RevokeForbidden",
      "UnresolvedCashSession",
      "RecoveryRequirementsUnmet",
    ]);
    for (const [status, expected] of Object.entries(codes)) {
      for (const code of expected) expect(String(shared[named(status)]?.["description"])).toContain(code);
    }
  });

  it("reads no tenant, store or actor from the request", () => {
    const fromRequest = [
      ...OPERATIONS.flatMap(([m, p]) => contract.parameters(m, p).map((x) => String(x["name"]))),
      ...keysOf("DeviceRevokeRequest"),
    ];
    expect(fromRequest.filter((n) => /tenant|actor|user/i.test(n))).toEqual([]);
    expect(keysOf("DeviceRevokeRequest").filter((n) => /store/i.test(n))).toEqual([]);
  });
});

// ===========================================================================
// 3. List filters and paging
// ===========================================================================
describe("devices contract — filters and paging", () => {
  it("lists only optional query parameters: store, trust state, cursor, page size", () => {
    const list = contract.parameters("get", LIST_PATH);
    expect(list.map((p) => [p["name"], p["in"], p["required"]]).sort()).toEqual(
      [
        ["cursor", "query", false],
        ["page_size", "query", false],
        ["store_id", "query", false],
        ["trust_state", "query", false],
      ].sort(),
    );
  });

  it.each([
    ["store_id", { type: "string", format: "uuid" }],
    ["trust_state", { $ref: "#/components/schemas/TrustState" }],
    ["page_size", { type: "integer", minimum: 1, maximum: 200, default: 50 }],
    ["cursor", { type: "string", minLength: 1, maxLength: 512, pattern: "^[A-Za-z0-9_-]+$" }],
  ])("bounds %s as %j", (name, expected) => {
    expect(paramNamed("get", LIST_PATH, name)?.["schema"]).toEqual(expected);
  });

  it("has three mutually exclusive trust states and a 200-item page cap", () => {
    expect(contract.schema("TrustState")["enum"]).toEqual(["active", "revoked", "retired"]);
    expect(props("DevicePage")["items"]).toMatchObject({ maxItems: 200 });
  });

  it.each([
    ["get", DETAIL_PATH],
    ["post", REVOKE_PATH],
  ] as const)("%s %s takes only the deviceId UUID path parameter", (method, path) => {
    expect(contract.parameters(method, path)).toEqual([
      expect.objectContaining({ name: "deviceId", in: "path", required: true, schema: { type: "string", format: "uuid" } }),
    ]);
  });
});

// ===========================================================================
// 4. Projections
// ===========================================================================
describe("devices contract — projections", () => {
  it.each(["DeviceSummary", "DevicePage", "DeviceDetail", "DeviceRevokeResult"])(
    "%s is closed and requires every key it declares",
    (name) => {
      const s = contract.schema(name);
      expect(s["additionalProperties"]).toBe(false);
      expect([...((s["required"] ?? []) as string[])].sort()).toEqual(keysOf(name));
    },
  );

  it("never exposes a tenant id, credential, previous token or contact field", () => {
    const leaked = ["DeviceSummary", "DeviceDetail", "DeviceRevokeResult", "DevicePage"].flatMap((name) =>
      keysOf(name).filter((k) => /tenant|hash|token|secret|^pin|previous|validUntil|email|phone/i.test(k)),
    );
    expect(leaked).toEqual([]);
  });

  it("lists the RT-365 fields; the detail adds only the revoke note and retire attribution", () => {
    expect(keysOf("DeviceSummary")).toEqual(SUMMARY_KEYS);
    expect(keysOf("DeviceDetail").filter((k) => !SUMMARY_KEYS.includes(k))).toEqual([
      "retireReason",
      "retiredByUserId",
      "revokeNote",
    ]);
  });

  it("gives every summary field the same shape on the detail", () => {
    const bare = (s: JsonObject | undefined): JsonObject => omit(s ?? {}, "description");
    const summary = props("DeviceSummary");
    const detail = props("DeviceDetail");
    const mismatched = SUMMARY_KEYS.filter((k) => JSON.stringify(bare(summary[k])) !== JSON.stringify(bare(detail[k])));
    expect(mismatched).toEqual([]);
  });

  it("uses the D-Q3 reason enum and the revoked / already_revoked outcome", () => {
    expect(contract.schema("RevokeReason")["enum"]).toEqual(REVOKE_REASONS);
    expect(props("DeviceRevokeResult")["outcome"]).toMatchObject({ enum: ["revoked", "already_revoked"] });
    expect(props("DeviceRevokeResult")["device"]).toEqual({ $ref: "#/components/schemas/DeviceDetail" });
  });

  it.each([
    ["an active device", "DeviceSummary", ACTIVE],
    ["an active device seen recently, no label", "DeviceSummary", { ...ACTIVE, label: null, lastSeenAt: "2026-10-16T09:00:00Z" }],
    ["a revoked device with a custody exception", "DeviceSummary", REVOKED],
    ["a revoke recorded before RT-365", "DeviceSummary", { ...REVOKED, revokeReason: null, revokedByUserId: null }],
    ["a retired device", "DeviceSummary", RETIRED],
    ["a page", "DevicePage", { items: [REVOKED, ACTIVE], nextCursor: "eyJyIjowfQ" }],
    ["an empty last page", "DevicePage", { items: [], nextCursor: null }],
    ["a detail with a note", "DeviceDetail", { ...REVOKED, ...DETAIL_EXTRA, revokeNote: "Drawer cash in the safe" }],
    ["a retired detail", "DeviceDetail", { ...RETIRED, revokeNote: null, retiredByUserId: USER_ID, retireReason: "Decommissioned" }],
    ["a revoke result", "DeviceRevokeResult", { outcome: "already_revoked", device: { ...ACTIVE, ...DETAIL_EXTRA } }],
    ["the error envelope", "Error", { error: { code: "unresolved_cash_session", message: "Conflict", request_id: DEVICE_ID } }],
  ])("accepts %s", (_label, name, payload) => {
    expect(contract.accepts(name, payload)).toBe(true);
  });

  it.each([
    ["an active device with a revoke time", "DeviceSummary", { ...ACTIVE, revokedAt: "2026-10-16T10:00:00Z" }],
    ["an active device with a custody exception", "DeviceSummary", { ...ACTIVE, custodyExceptionShiftId: SHIFT_ID }],
    ["a revoked device without a revoke time", "DeviceSummary", { ...REVOKED, revokedAt: null }],
    ["a revoked device with a retire time", "DeviceSummary", { ...REVOKED, retiredAt: "2026-10-16T11:00:00Z" }],
    ["a retired device without a retire time", "DeviceSummary", { ...RETIRED, retiredAt: null }],
    ["an expired trust state", "DeviceSummary", { ...ACTIVE, trustState: "expired" }],
    ["an unknown reason", "DeviceSummary", { ...REVOKED, revokeReason: "broken" }],
    ["a missing nullable key", "DeviceSummary", omit(ACTIVE, "lastSeenAt")],
    ["a token hash", "DeviceSummary", { ...ACTIVE, tokenHash: "abc" }],
    ["a revoke note on the list item", "DeviceSummary", { ...REVOKED, revokeNote: "x" }],
    ["a page over 200 items", "DevicePage", { items: new Array(201).fill(ACTIVE), nextCursor: null }],
    ["a page without nextCursor", "DevicePage", { items: [] }],
    ["an unknown outcome", "DeviceRevokeResult", { outcome: "noop", device: { ...ACTIVE, ...DETAIL_EXTRA } }],
    ["a result without the device", "DeviceRevokeResult", { outcome: "revoked" }],
    ["a bare error code", "Error", { code: "not_found" }],
    ["a retired detail without a retire reason", "DeviceDetail", { ...RETIRED, ...DETAIL_EXTRA, retiredByUserId: USER_ID }],
  ])("rejects %s", (_label, name, payload) => {
    expect(contract.accepts(name, payload)).toBe(false);
  });
});

// ===========================================================================
// 5. Revoke body
// ===========================================================================
describe("devices contract — revoke body", () => {
  it("requires only the reason, closes the body and shapes the note like the 0040 CHECK", () => {
    const body = contract.schema("DeviceRevokeRequest");
    expect([body["required"], body["additionalProperties"]]).toEqual([["reason"], false]);
    expect(props("DeviceRevokeRequest")).toEqual({
      reason: { $ref: "#/components/schemas/RevokeReason" },
      note: { $ref: "#/components/schemas/RevokeNote" },
      acknowledgeCustodyException: expect.objectContaining({ type: "boolean" }),
    });
    expect(contract.schema("RevokeNote")).toMatchObject({
      type: "string",
      minLength: 1,
      maxLength: 500,
      pattern: "^[^\\u0000]*[^\\s\\u0000][^\\u0000]*$",
    });
  });

  it.each(REVOKE_REASONS.filter((r) => r !== "other").map((reason) => [reason]))("accepts %s alone", (reason) => {
    expect(contract.accepts("DeviceRevokeRequest", { reason })).toBe(true);
  });

  it.each([
    [{ reason: "hardware_failure", note: "Till will not boot; cash in the safe", acknowledgeCustodyException: true }, true],
    [{ reason: "other", note: "Pilot ended" }, true],
    [{}, false],
    [{ reason: "broken" }, false],
    [{ reason: "other" }, false],
    [{ reason: "lost", note: "" }, false],
    [{ reason: "lost", note: "   " }, false],
    [{ reason: "lost", note: "x".repeat(501) }, false],
    [{ reason: "lost", note: "cash\u0000safe" }, false],
    [{ reason: "lost", note: "\u0000" }, false],
    [{ reason: "hardware_failure", acknowledgeCustodyException: "true" }, false],
    [{ reason: "lost", storeId: STORE_ID }, false],
    [{ reason: "lost", acknowledge_custody_exception: true }, false],
  ])("judges %j as %s", (body, expected) => {
    expect(contract.accepts("DeviceRevokeRequest", body)).toBe(expected);
  });
});

// ===========================================================================
// 6. POS surface untouched
// ===========================================================================
describe("devices contract — POS surface", () => {
  it("adds no POS path, and the pairing contract keeps its own operations", () => {
    expect(Object.keys(contract.document["paths"] as JsonObject).filter((p) => p.startsWith("/api/pos/"))).toEqual([]);
    const pairingPaths = Object.keys(contract.sibling("pos-terminal-pairing.openapi")["paths"] as JsonObject);
    expect(pairingPaths.length).toBeGreaterThan(0);
    expect(pairingPaths.some((p) => p.startsWith("/api/v1/devices"))).toBe(false);
  });
});
