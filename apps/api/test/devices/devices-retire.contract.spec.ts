/**
 * apps/api/test/devices/devices-retire.contract.spec.ts
 *
 * RT-368 (RT-287 F5; D-Q2, D-Q4 as amended): `consoleRetireDevice` in
 * `devices.openapi.yaml`, and the list's new default filter. `[GATED]`
 * contract-first; the RT-368 runtime ships it unchanged on the wire
 * (`devices-retire.http.integration.spec.ts`).
 *
 * Structural / load-only, plus AJV fixtures against the contract schemas. No
 * app boot and no HTTP. Pinned here:
 *
 *   1. The operation: implemented, cookie auth, Origin-checked, the shared
 *      404, a closed body with a free-text `retireReason` (not a RevokeReason).
 *   2. The result: `retired` / `already_retired`, the device always retired.
 *   3. The 409: the retire preview, whose block code is the envelope's code.
 *   4. The documented rules: the evaluator mapping, revoke-first with reason
 *      `retired`, the code cascade, terminal, no DELETE, the audit row, the
 *      list's default filter.
 */
import { readContract, type ContractReader, type JsonObject } from "../_helpers/openapi-contract-reader";

const RETIRE_PATH = "/api/v1/devices/{deviceId}/retire";

const DEVICE_ID = "0190f5a2-3b4c-7d8e-9f01-23456789abcd";
const USER_ID = "0190f5a2-3b4c-7d8e-9f01-000000000003";
const SHIFT_ID = "0190f5a2-3b4c-7d8e-9f01-000000000004";

let contract: ContractReader;

beforeAll(() => {
  contract = readContract("devices.openapi");
});

const info = (): string => String((contract.document["info"] as JsonObject)["description"]);
const props = (name: Capitalize<string>): Record<string, JsonObject> =>
  (contract.schema(name)["properties"] ?? {}) as Record<string, JsonObject>;
const responses = (): Record<string, JsonObject> =>
  contract.operation("post", RETIRE_PATH)["responses"] as Record<string, JsonObject>;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const RETIRED_DEVICE = {
  deviceId: DEVICE_ID,
  storeId: "0190f5a2-3b4c-7d8e-9f01-000000000011",
  label: "Till 1",
  trustState: "retired",
  createdAt: "2026-01-01T00:00:00.000Z",
  expiresAt: "2026-04-01T00:00:00.000Z",
  lastSeenAt: null,
  lastSeenSource: null,
  revokedAt: "2026-10-17T10:00:00.000Z",
  revokedByUserId: USER_ID,
  revokeReason: "retired",
  retiredAt: "2026-10-17T10:00:00.000Z",
  replacesDeviceId: null,
  replacedByDeviceId: null,
  custodyExceptionShiftId: null,
  revokeNote: null,
  retiredByUserId: USER_ID,
  retireReason: "End of life, returned to vendor",
};

const OPEN_SHIFT = {
  shiftId: SHIFT_ID,
  source: "legacy",
  openedAt: "2026-10-17T08:00:00.000Z",
  openingCashierUserId: USER_ID,
  cashFacts: null,
};

/** A retire refused because the active device has an open shift. */
const BLOCKED_ACTIVE = {
  deviceId: DEVICE_ID,
  action: "retire",
  revokeReason: "retired",
  trustState: "active",
  verdict: "blocked",
  blockCode: "unresolved_cash_session",
  requires: [],
  openShift: OPEN_SHIFT,
  custodyExceptionShiftId: null,
  cascade: { operatorSessionCount: 1, pendingPairingCodeCount: 0 },
  replacesDeviceId: null,
  replacedByDeviceId: null,
  evaluatedAt: "2026-10-17T10:00:00.000Z",
};

/** A retire refused because the revoked device's open shift is the custody exception. */
const BLOCKED_CUSTODY = {
  ...BLOCKED_ACTIVE,
  trustState: "revoked",
  blockCode: "unresolved_custody_exception",
  custodyExceptionShiftId: SHIFT_ID,
  cascade: null,
};

const conflict = (code: string, details?: unknown): JsonObject => ({
  error: { code, message: "Refused.", ...(details !== undefined ? { details } : {}) },
});

// ===========================================================================
// 1. Operation and body
// ===========================================================================
describe("devices retire contract — operation", () => {
  it("is consoleRetireDevice, implemented (no contract-only marker), with no foreign collision", () => {
    const operation = contract.operation("post", RETIRE_PATH);
    expect(operation["operationId"]).toBe("consoleRetireDevice");
    expect(operation["x-runtime-status"]).toBeUndefined();
    expect(operation["x-runtime-note"]).toBeUndefined();
    expect(operation["security"]).toBeUndefined();
    expect(contract.foreignOperationIds.has("consoleRetireDevice")).toBe(false);
  });

  it("answers exactly 200 / 400 / 401 / 403 / 404 / 409 / 500, scope refusals as the shared 404", () => {
    expect(Object.keys(responses()).sort()).toEqual(["200", "400", "401", "403", "404", "409", "500"]);
    expect(responses()["404"]).toEqual({ $ref: "#/components/responses/NotFound" });
    expect(responses()["403"]).toEqual({ $ref: "#/components/responses/OriginRejected" });
    expect(responses()["409"]).toEqual({ $ref: "#/components/responses/DeviceRetireConflict" });
  });

  it("takes only the device path id, and a closed body with a free-text retireReason", () => {
    expect(contract.parameters("post", RETIRE_PATH).map((p) => p["name"])).toEqual(["deviceId"]);
    const s = contract.schema("DeviceRetireRequest");
    expect(s["additionalProperties"]).toBe(false);
    expect(s["required"]).toEqual(["retireReason"]);
    expect(props("DeviceRetireRequest")["retireReason"]).toMatchObject({ type: "string", minLength: 1, maxLength: 500 });
    expect(props("DeviceRetireRequest")["retireReason"]?.["$ref"]).toBeUndefined();
  });

  it.each([
    ["a reason", { retireReason: "End of life" }, true],
    ["no reason", {}, false],
    ["a blank reason", { retireReason: "   " }, false],
    ["a 501-character reason", { retireReason: "x".repeat(501) }, false],
    ["a NUL", { retireReason: "End\u0000of life" }, false],
    ["a smuggled tenantId", { retireReason: "End of life", tenantId: DEVICE_ID }, false],
    ["a revoke reason key", { retireReason: "End of life", reason: "retired" }, false],
  ])("the body with %s is %s", (_label, body, ok) => {
    expect(contract.accepts("DeviceRetireRequest", body)).toBe(ok);
  });
});

// ===========================================================================
// 2. Result and 409
// ===========================================================================
describe("devices retire contract — result and 409", () => {
  it("returns retired / already_retired with a retired device", () => {
    expect(contract.accepts("DeviceRetireResult", { outcome: "retired", device: RETIRED_DEVICE })).toBe(true);
    expect(contract.accepts("DeviceRetireResult", { outcome: "already_retired", device: RETIRED_DEVICE })).toBe(true);
    const revoked = { ...RETIRED_DEVICE, trustState: "revoked", retiredAt: null, retiredByUserId: null, retireReason: null };
    expect(contract.accepts("DeviceRetireResult", { outcome: "retired", device: revoked })).toBe(false);
    expect(contract.accepts("DeviceRetireResult", { outcome: "revoked", device: RETIRED_DEVICE })).toBe(false);
  });

  it("refuses with the retire preview, whose block code is the envelope's code", () => {
    expect(contract.accepts("DeviceRetireConflict", conflict("unresolved_cash_session", BLOCKED_ACTIVE))).toBe(true);
    expect(contract.accepts("DeviceRetireConflict", conflict("unresolved_custody_exception", BLOCKED_CUSTODY))).toBe(true);
  });

  it.each([
    ["a refusal without its preview", conflict("unresolved_cash_session")],
    ["a preview whose block code differs", conflict("unresolved_custody_exception", BLOCKED_ACTIVE)],
    ["a preview for another action", conflict("unresolved_cash_session", { ...BLOCKED_ACTIVE, action: "replace", revokeReason: "replaced" })],
    ["a code a retire cannot raise", conflict("device_retired", { ...BLOCKED_ACTIVE, blockCode: "device_retired" })],
  ])("refuses %s", (_label, body) => {
    expect(contract.accepts("DeviceRetireConflict", body)).toBe(false);
  });
});

// ===========================================================================
// 3. Documented rules
// ===========================================================================
describe("devices retire contract — rules", () => {
  it("is 1.3.0-draft and maps the retire verdict one-to-one onto the outcome", () => {
    expect((contract.document["info"] as JsonObject)["version"]).toBe("1.3.0-draft");
    expect(info()).toMatch(/For `consoleRetireDevice`:\s+`allowed` → 200 `retired`; `blocked` → 409/);
    expect(info()).toMatch(/`no_change` → 200\s+`already_retired`/);
  });

  it("revokes an active device first with reason retired, cancels codes, and is terminal", () => {
    expect(info()).toMatch(/An active device is first revoked with reason\s+`retired` through the revoke cascade/);
    expect(info()).toMatch(/so a retired\s+device can never be paired or replaced/);
    expect(info()).toMatch(/Retire is terminal: there is no un-retire/);
    expect(info()).toMatch(/There is no un-retire and no DELETE of a device, on any path/);
  });

  it("declares no DELETE anywhere on the device registry", () => {
    const paths = contract.document["paths"] as Record<string, JsonObject>;
    for (const item of Object.values(paths)) expect(Object.keys(item)).not.toContain("delete");
  });

  it("audits pos.device.retired without the reason", () => {
    expect(info()).toMatch(/RT-368 adds `pos.device.retired`/);
    expect(info()).toMatch(/The retire reason never enters audit\s+metadata/);
  });

  it("notes on the live list that production keeps the old default until the RT-368 runtime", () => {
    const list = contract.operation("get", "/api/v1/devices");
    expect(String(list["x-runtime-note"])).toMatch(/production still returns retired devices by default/);
    const trust = contract.parameters("get", "/api/v1/devices").find((p) => p["name"] === "trust_state");
    expect(String(trust?.["x-runtime-note"])).toMatch(/RT-368 runtime PR removes this note/);
  });

  it("warns that retiring a revoked device cancels its pending replacement codes", () => {
    expect(info()).toMatch(/Retiring a revoked device cancels its pending replacement codes/);
    expect(info()).toMatch(/looks for one whose `replacesDeviceId` is\s+the device/);
  });

  it("counts on pos.device.retired only the codes the retire step itself cancelled", () => {
    expect(info()).toMatch(/only the codes the retire step itself\s+cancelled/);
    expect(info()).toMatch(/nothing is counted twice/);
  });

  it("states the posture without the stale 'no existing operation changes' claim", () => {
    expect(info()).not.toMatch(/No existing operation, schema or response changes/);
    expect(info()).toMatch(/so must the\s+pairing-code issue and cancel, and the retire/);
  });

  it("drops retired devices from the default list, keeping them queryable", () => {
    expect(info()).toMatch(/Without `trust_state`, the list returns the\s+`active` and `revoked` devices only/);
    const trust = contract.parameters("get", "/api/v1/devices").find((p) => p["name"] === "trust_state");
    expect(String(trust?.["description"])).toMatch(/never `retired` ones \(RT-368\); pass `retired` to list them/);
  });
});
