/**
 * apps/api/test/devices/devices-impact.contract.spec.ts
 *
 * RT-366 (RT-287 F3): the device lifecycle impact preview in
 * `devices.openapi.yaml` — `consoleGetDeviceImpact` and the impact payload on
 * the revoke's 409. `[GATED]` contract-first; the operation stays
 * `contract-only` until the stacked RT-366 runtime ships.
 *
 * Structural / load-only, plus AJV fixtures against the contract schemas. No
 * app boot and no HTTP. Pinned here:
 *
 *   1. The operation: same auth and 404 as the reads, read-only, the action /
 *      reason query, no note or tenant from the request.
 *   2. The vocabularies: actions, verdicts (RT-287 D-Q4 amended), block codes
 *      and requirements.
 *   3. A closed, credential-free projection whose consistency rules tie the
 *      verdict, the block code, the action's reason and the device state.
 *   4. The revoke's 409 carries the preview as `error.details`, additively:
 *      an envelope without it still conforms.
 *   5. The documented verdict → mutation mapping (the parity rule).
 */
import { readContract, type ContractReader, type JsonObject } from "../_helpers/openapi-contract-reader";

const IMPACT_PATH = "/api/v1/devices/{deviceId}/impact";
const REVOKE_PATH = "/api/v1/devices/{deviceId}/revoke";

const DEVICE_ID = "0190f5a2-3b4c-7d8e-9f01-23456789abcd";
const USER_ID = "0190f5a2-3b4c-7d8e-9f01-000000000003";
const SHIFT_ID = "0190f5a2-3b4c-7d8e-9f01-000000000004";
const OTHER_DEVICE_ID = "0190f5a2-3b4c-7d8e-9f01-000000000005";

const RECOVERY_REQUIRES = ["owner_or_tenant_admin", "note", "acknowledge_custody_exception"];

let contract: ContractReader;

beforeAll(() => {
  contract = readContract("devices.openapi");
});

const props = (name: Capitalize<string>): Record<string, JsonObject> =>
  (contract.schema(name)["properties"] ?? {}) as Record<string, JsonObject>;
const keysOf = (name: Capitalize<string>): string[] => Object.keys(props(name)).sort();
const info = (): string => String((contract.document["info"] as JsonObject)["description"]);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CASH_UP_SHIFT = {
  shiftId: SHIFT_ID,
  source: "cash_up",
  openedAt: "2026-10-16T08:00:00.000Z",
  openingCashierUserId: USER_ID,
  cashFacts: { view: "server_received", receivedCount: 3, lastReceivedAt: "2026-10-16T09:30:00.000Z" },
};

const LEGACY_SHIFT = { ...CASH_UP_SHIFT, source: "legacy", cashFacts: null };

const CASCADE = { operatorSessionCount: 2, pendingPairingCodeCount: 1 };

/** An active device without an open shift, previewed for a revoke: allowed. */
const ALLOWED = {
  deviceId: DEVICE_ID,
  action: "revoke",
  revokeReason: "admin_error",
  trustState: "active",
  verdict: "allowed",
  blockCode: null,
  requires: [],
  openShift: null,
  custodyExceptionShiftId: null,
  cascade: CASCADE,
  replacesDeviceId: null,
  replacedByDeviceId: null,
  evaluatedAt: "2026-10-16T10:00:00.000Z",
};

const BLOCKED = {
  ...ALLOWED,
  verdict: "blocked",
  blockCode: "unresolved_cash_session",
  openShift: CASH_UP_SHIFT,
};

const SECURITY = {
  ...ALLOWED,
  revokeReason: "stolen",
  verdict: "allowed_with_custody_exception",
  openShift: CASH_UP_SHIFT,
};

const RECOVERY = {
  ...SECURITY,
  revokeReason: "hardware_failure",
  requires: RECOVERY_REQUIRES,
};

const FORBIDDEN = { ...RECOVERY, verdict: "forbidden_recovery" };

/** A revoked device whose open shift is the custody exception. */
const REVOKED_STATE = {
  trustState: "revoked",
  openShift: CASH_UP_SHIFT,
  custodyExceptionShiftId: SHIFT_ID,
  cascade: null,
};

const NO_CHANGE = { ...ALLOWED, ...REVOKED_STATE, revokeReason: "lost", verdict: "no_change" };

const REPLACE_AFTER_EXCEPTION = {
  ...ALLOWED,
  ...REVOKED_STATE,
  action: "replace",
  revokeReason: "replaced",
  replacedByDeviceId: OTHER_DEVICE_ID,
};

const RETIRE_BLOCKED_BY_EXCEPTION = {
  ...ALLOWED,
  ...REVOKED_STATE,
  action: "retire",
  revokeReason: "retired",
  verdict: "blocked",
  blockCode: "unresolved_custody_exception",
};

const RETIRED_STATE = { trustState: "retired", openShift: null, custodyExceptionShiftId: null, cascade: null };

const omit = (value: Record<string, unknown>, key: string): Record<string, unknown> =>
  Object.fromEntries(Object.entries(value).filter(([k]) => k !== key));

// ===========================================================================
// 1. Operation
// ===========================================================================
describe("devices impact contract — operation", () => {
  it("is consoleGetDeviceImpact, contract-only until the RT-366 runtime, with no foreign collision", () => {
    const operation = contract.operation("get", IMPACT_PATH);
    expect(operation["operationId"]).toBe("consoleGetDeviceImpact");
    expect(operation["x-runtime-status"]).toBe("contract-only");
    expect(String(operation["x-runtime-note"])).toMatch(/RT-366/);
    expect(contract.foreignOperationIds.has("consoleGetDeviceImpact")).toBe(false);
  });

  it("inherits the cookie-only scheme and answers like the reads (scope refusals are 404)", () => {
    const operation = contract.operation("get", IMPACT_PATH);
    expect(operation["security"]).toBeUndefined();
    expect(Object.keys(operation["responses"] as JsonObject).sort()).toEqual(["200", "400", "401", "404", "500"]);
    const responses = operation["responses"] as Record<string, JsonObject>;
    expect(responses["404"]).toEqual({ $ref: "#/components/responses/NotFound" });
    expect(responses["200"]).toMatchObject({
      content: { "application/json": { schema: { $ref: "#/components/schemas/DeviceImpactPreview" } } },
    });
  });

  it("takes the device path id, a required action and an optional reason, and nothing else", () => {
    const params = contract.parameters("get", IMPACT_PATH);
    expect(params.map((p) => [p["name"], p["in"], p["required"]])).toEqual([
      ["deviceId", "path", true],
      ["action", "query", true],
      ["reason", "query", false],
    ]);
    expect(params[1]?.["schema"]).toEqual({ $ref: "#/components/schemas/DeviceLifecycleAction" });
    expect(params[2]?.["schema"]).toEqual({ $ref: "#/components/schemas/RevokeReason" });
    expect(String(params[2]?.["description"])).toMatch(/Required when `action` is `revoke`/);
  });

  it("reads no tenant, store, actor, note or acknowledgement from the request", () => {
    const names = contract.parameters("get", IMPACT_PATH).map((p) => String(p["name"]));
    expect(names.filter((n) => /tenant|store|actor|user|note|ack/i.test(n))).toEqual([]);
  });
});

// ===========================================================================
// 2. Vocabularies
// ===========================================================================
describe("devices impact contract — vocabularies", () => {
  it.each([
    ["DeviceLifecycleAction", ["revoke", "replace", "move", "retire"]],
    ["ImpactVerdict", ["allowed", "allowed_with_custody_exception", "blocked", "forbidden_recovery", "no_change"]],
    ["ImpactBlockCode", ["unresolved_cash_session", "unresolved_custody_exception", "device_retired"]],
    ["ImpactRequirement", RECOVERY_REQUIRES],
  ] as const)("%s is exactly %j", (name, values) => {
    expect(contract.schema(name)["enum"]).toEqual(values);
  });
});

// ===========================================================================
// 3. Projection
// ===========================================================================
describe("devices impact contract — projection", () => {
  it.each(["DeviceImpactPreview", "ImpactOpenShift", "ImpactCashFacts", "ImpactCascade"] as const)(
    "%s is closed and requires every key it declares",
    (name) => {
      const s = contract.schema(name);
      expect(s["additionalProperties"]).toBe(false);
      expect([...((s["required"] ?? []) as string[])].sort()).toEqual(keysOf(name));
    },
  );

  it("never exposes a tenant id, credential, code, note or contact field", () => {
    const names = ["DeviceImpactPreview", "ImpactOpenShift", "ImpactCashFacts", "ImpactCascade"] as const;
    const leaked = names.flatMap((name) =>
      keysOf(name).filter((k) => /tenant|hash|token|secret|^pin|^code$|note|email|phone|name$/i.test(k)),
    );
    expect(leaked).toEqual([]);
  });

  it("labels the cash facts as a server-received view", () => {
    expect(props("ImpactCashFacts")["view"]).toMatchObject({ enum: ["server_received"] });
  });

  it.each([
    ["an allowed revoke", ALLOWED],
    ["a revoke blocked by the open shift", BLOCKED],
    ["a blocked revoke on a legacy shift", { ...BLOCKED, openShift: LEGACY_SHIFT }],
    ["a security revoke with an open shift", SECURITY],
    ["a recovery revoke by an owner", RECOVERY],
    ["a recovery revoke by a store manager", FORBIDDEN],
    ["a revoke of a revoked device", NO_CHANGE],
    ["a revoke of a retired device", { ...NO_CHANGE, ...RETIRED_STATE }],
    ["a hardware_failure revoke without an open shift", { ...ALLOWED, revokeReason: "hardware_failure" }],
    ["a replace after a security revoke", REPLACE_AFTER_EXCEPTION],
    ["a move of an active device", { ...ALLOWED, action: "move", revokeReason: "moved" }],
    ["a replace blocked by an open shift", { ...BLOCKED, action: "replace", revokeReason: "replaced" }],
    ["a replace of a retired device", {
      ...ALLOWED,
      ...RETIRED_STATE,
      action: "replace",
      revokeReason: "replaced",
      verdict: "blocked",
      blockCode: "device_retired",
    }],
    ["a retire blocked by the custody exception", RETIRE_BLOCKED_BY_EXCEPTION],
    ["a retire of an active device", { ...ALLOWED, action: "retire", revokeReason: "retired" }],
    ["a retire of a retired device", { ...ALLOWED, ...RETIRED_STATE, action: "retire", revokeReason: "retired", verdict: "no_change" }],
  ])("accepts %s", (_label, payload) => {
    expect(contract.accepts("DeviceImpactPreview", payload)).toBe(true);
  });

  it.each([
    ["a blocked verdict without a block code", { ...BLOCKED, blockCode: null }],
    ["a block code on an allowed verdict", { ...ALLOWED, blockCode: "unresolved_cash_session" }],
    ["requirements on an allowed verdict", { ...ALLOWED, requires: ["note"] }],
    ["a custody exception verdict without an open shift", { ...SECURITY, openShift: null }],
    ["a forbidden recovery for a security reason", { ...FORBIDDEN, revokeReason: "lost" }],
    ["a forbidden recovery without its requirements", { ...FORBIDDEN, requires: [] }],
    ["an allowed recovery revoke without its requirements", { ...RECOVERY, requires: [] }],
    ["an allowed recovery revoke with partial requirements", { ...RECOVERY, requires: ["note", "acknowledge_custody_exception"] }],
    ["recovery requirements out of check order", { ...RECOVERY, requires: ["note", "owner_or_tenant_admin", "acknowledge_custody_exception"] }],
    ["a security revoke carrying a requirement", { ...SECURITY, requires: ["note"] }],
    ["a forbidden recovery on a replace", { ...FORBIDDEN, action: "replace", revokeReason: "replaced" }],
    ["a no_change verdict with a cascade", { ...NO_CHANGE, cascade: CASCADE }],
    ["a replace recording another reason", { ...ALLOWED, action: "replace", revokeReason: "lost" }],
    ["a move recording another reason", { ...ALLOWED, action: "move", revokeReason: "replaced" }],
    ["a retire recording another reason", { ...ALLOWED, action: "retire", revokeReason: "admin_error" }],
    ["a revoke blocked by the custody exception", { ...RETIRE_BLOCKED_BY_EXCEPTION, action: "revoke", revokeReason: "other" }],
    ["a retire blocked as retired", { ...RETIRE_BLOCKED_BY_EXCEPTION, blockCode: "device_retired" }],
    ["an active device without a cascade", { ...ALLOWED, cascade: null }],
    ["an active device with a custody exception", { ...BLOCKED, custodyExceptionShiftId: SHIFT_ID }],
    ["a revoked device with a cascade", { ...REPLACE_AFTER_EXCEPTION, cascade: CASCADE }],
    ["a legacy shift with cash facts", { ...BLOCKED, openShift: { ...LEGACY_SHIFT, cashFacts: CASH_UP_SHIFT.cashFacts } }],
    ["a cash-up shift without cash facts", { ...BLOCKED, openShift: { ...CASH_UP_SHIFT, cashFacts: null } }],
    ["zero received facts", {
      ...BLOCKED,
      openShift: { ...CASH_UP_SHIFT, cashFacts: { ...CASH_UP_SHIFT.cashFacts, receivedCount: 0 } },
    }],
    ["an all-synced cash view", {
      ...BLOCKED,
      openShift: { ...CASH_UP_SHIFT, cashFacts: { ...CASH_UP_SHIFT.cashFacts, view: "all_synced" } },
    }],
    ["a negative cascade count", { ...ALLOWED, cascade: { ...CASCADE, operatorSessionCount: -1 } }],
    ["a token in the cascade", { ...ALLOWED, cascade: { ...CASCADE, tokenIds: [] } }],
    ["a pairing code", { ...ALLOWED, pairingCode: "ABCD-1234" }],
    ["a duplicated requirement", { ...RECOVERY, requires: ["note", "note", "owner_or_tenant_admin"] }],
    ["an unknown verdict", { ...ALLOWED, verdict: "allowed_with_override" }],
    ["an unknown action", { ...ALLOWED, action: "suspend" }],
    ["a missing nullable key", omit(ALLOWED, "openShift")],
    ["a missing evaluation time", omit(ALLOWED, "evaluatedAt")],
  ])("rejects %s", (_label, payload) => {
    expect(contract.accepts("DeviceImpactPreview", payload)).toBe(false);
  });
});

// ===========================================================================
// 4. The revoke's 409 carries the preview (additively)
// ===========================================================================
describe("devices impact contract — revoke 409", () => {
  const conflict = (details?: unknown): unknown => ({
    error: {
      code: "unresolved_cash_session",
      message: "Conflict",
      request_id: DEVICE_ID,
      ...(details !== undefined ? { details } : {}),
    },
  });

  it("points the revoke's 409 at the impact conflict envelope", () => {
    const responses = (contract.document["components"] as JsonObject)["responses"] as Record<string, JsonObject>;
    const revoke409 = (contract.operation("post", REVOKE_PATH)["responses"] as Record<string, JsonObject>)["409"];
    expect(revoke409).toEqual({ $ref: "#/components/responses/UnresolvedCashSession" });
    expect(responses["UnresolvedCashSession"]).toMatchObject({
      content: { "application/json": { schema: { $ref: "#/components/schemas/DeviceImpactConflict" } } },
    });
  });

  it.each([
    ["the pre-RT-366 envelope without details", conflict(), true],
    ["the envelope with the blocked preview as details", conflict(BLOCKED), true],
    ["details that are not blocked", conflict(ALLOWED), false],
    ["details that are not a preview", conflict({ verdict: "blocked" }), false],
  ])("judges %s", (_label, payload, expected) => {
    expect(contract.accepts("DeviceImpactConflict", payload)).toBe(expected);
  });
});

// ===========================================================================
// 5. Parity rule (documented)
// ===========================================================================
describe("devices impact contract — parity rule", () => {
  it("binds the preview and every lifecycle mutation to one evaluator", () => {
    expect(info()).toMatch(/One evaluator decides both the verdict and the real mutation/);
    expect(info()).toMatch(/RT-367 replace \/ move and RT-368\s+retire/);
  });

  it.each([
    ["allowed", /`allowed` → 200 `revoked`/],
    ["allowed_with_custody_exception", /`allowed_with_custody_exception` → 200 `revoked` when the body meets/],
    ["forbidden_recovery", /`forbidden_recovery` → 403 `recovery_revoke_forbidden`/],
    ["blocked", /`blocked` → 409 with `error.code` = `blockCode`/],
    ["no_change", /`no_change` → 200 `already_revoked`/],
  ])("maps %s onto the revoke outcome", (_verdict, pattern) => {
    expect(info()).toMatch(pattern);
  });

  it("says the preview is a snapshot and the mutation re-decides under its lock", () => {
    expect(info()).toMatch(/snapshot, not a reservation/);
    expect(info()).toMatch(/decides again under the device lifecycle lock/);
  });
});
