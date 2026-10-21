/**
 * apps/api/test/device-health/pos-device-health.contract.spec.ts
 *
 * RT-327 step 1 (AD-DEVICE-001, ratified 2026-10-21 with D-5 and D-7 amended):
 * `pos-device-health.openapi.yaml`. `[GATED]` contract-first; every operation
 * is `x-runtime-status: contract-only` until the runtime and the
 * `device_health` / version-policy migration ship as later, separately
 * approved steps.
 *
 * Structural / load-only, plus AJV fixtures against the contract schemas. No
 * app boot and no HTTP. Pinned here:
 *
 *   1. The five operations: paths, contract-only with a note, one audited
 *      write, no operationId collision.
 *   2. Auth and refusals per principal: device bearer, tenant session (404,
 *      never 403), platform session (403, never 404).
 *   3. The heartbeat body: closed, identity keys refused, bounded fields, and
 *      `app_version` byte-identical to the RT-719 `X-POS-App-Version` schema.
 *   4. The `HeartbeatAck`: no policy means `unknown`, never `ok`.
 *   5. The console row: unknown liveness without a heartbeat, labelled last
 *      seen, no PII key.
 *   6. The platform policy shapes.
 *   7. The documented rules (D-1 to D-5, and the header relation).
 */
import { readContract, type ContractReader, type JsonObject } from "../_helpers/openapi-contract-reader";

const HEARTBEAT = "/api/pos/v1/terminals/heartbeat";
const LIST = "/api/v1/device-health";
const GET = "/api/v1/device-health/{deviceId}";
const POLICY = "/api/v1/platform/pos-version-policy";
const POLICY_CHANNEL = "/api/v1/platform/pos-version-policy/{channel}";

const DEVICE_ID = "0190f5a2-3b4c-7d8e-9f01-23456789abcd";
const STORE_ID = "0190f5a2-3b4c-7d8e-9f01-000000000002";
const USER_ID = "0190f5a2-3b4c-7d8e-9f01-000000000003";
const AT = "2026-10-21T10:00:00.000Z";

let contract: ContractReader;

beforeAll(() => {
  contract = readContract("pos-device-health.openapi");
});

const info = (): string => String((contract.document["info"] as JsonObject)["description"]);
const statuses = (method: "get" | "post" | "put", path: `/${string}`): string[] =>
  Object.keys(contract.operation(method, path)["responses"] as JsonObject).sort();
const keysOf = (name: Capitalize<string>): string[] =>
  Object.keys((contract.schema(name)["properties"] ?? {}) as JsonObject).sort();

const FULL_BEAT = {
  app_version: "1.4.0",
  update_channel: "stable",
  update_state: "idle",
  pending_version: null,
  schema_head: "0042_local_outbox",
  source_clock_at: AT,
};
const POLICY_ACK = {
  channel: "stable",
  latest_version: "1.5.0",
  recommended_version: "1.4.2",
  min_supported_version: "1.4.0",
  policy_revision: 3,
};
const ACK = {
  acknowledged_at: AT,
  pos_contract_revision: 1,
  policy: POLICY_ACK,
  min_supported_grace_until: AT,
  compliance: "ok",
};
const NEVER_SEEN = {
  deviceId: DEVICE_ID,
  storeId: STORE_ID,
  label: null,
  trustState: "active",
  appVersion: null,
  updateChannel: null,
  updateState: null,
  pendingVersion: null,
  schemaHead: null,
  sourceClockAt: null,
  heartbeatAt: null,
  secondsSinceHeartbeat: null,
  liveness: "unknown",
  compliance: "unknown",
  minSupportedVersion: null,
  minSupportedGraceUntil: null,
  activityLastSeenAt: null,
  lastSeenAt: null,
  lastSeenSource: null,
};
const SEEN = {
  ...NEVER_SEEN,
  appVersion: "1.3.9",
  updateChannel: "stable",
  updateState: "update_pending",
  pendingVersion: "1.4.0",
  heartbeatAt: AT,
  secondsSinceHeartbeat: 120,
  liveness: "online",
  compliance: "below_minimum",
  minSupportedVersion: "1.4.0",
  minSupportedGraceUntil: AT,
  activityLastSeenAt: "2026-10-21T09:00:00.000Z",
  lastSeenAt: AT,
  lastSeenSource: "heartbeat",
};
const STORED_POLICY = {
  latestVersion: "1.5.0",
  recommendedVersion: "1.4.2",
  minSupportedVersion: "1.4.0",
  minSupportedGraceUntil: AT,
  revision: 3,
  updatedAt: AT,
  updatedByUserId: USER_ID,
};

// ===========================================================================
// 1. The operations
// ===========================================================================
describe("pos device health contract — operations", () => {
  const EXPECTED: ReadonlyArray<readonly [string, string, string]> = [
    ["post", HEARTBEAT, "posReportDeviceHeartbeat"],
    ["get", LIST, "consoleListDeviceHealth"],
    ["get", GET, "consoleGetDeviceHealth"],
    ["get", POLICY, "platformGetPosVersionPolicy"],
    ["put", POLICY_CHANNEL, "platformSetPosVersionPolicy"],
  ];

  it("is OpenAPI 3.1.0 at 1.0.0-draft with exactly the five operations", () => {
    expect(contract.document["openapi"]).toBe("3.1.0");
    expect((contract.document["info"] as JsonObject)["version"]).toBe("1.0.0-draft");
    const declared = Object.entries(contract.document["paths"] as Record<string, JsonObject>).flatMap(([path, item]) =>
      Object.entries(item).map(([method, op]) => [method, path, (op as JsonObject)["operationId"]]),
    );
    expect(declared).toEqual(EXPECTED);
  });

  it.each(EXPECTED)("%s %s (%s) is contract-only with a note and collides with no other contract", (method, path, id) => {
    const op = contract.operation(method as "get", path as `/${string}`);
    expect(op["x-runtime-status"]).toBe("contract-only");
    expect(String(op["x-runtime-note"]).trim().length).toBeGreaterThan(0);
    expect(contract.foreignOperationIds.has(id)).toBe(false);
  });

  it("audits only the policy change, as pos.release_policy.changed", () => {
    for (const [method, path] of EXPECTED) {
      const action = contract.operation(method as "get", path as `/${string}`)["x-audit-action"];
      expect(action).toBe(path === POLICY_CHANNEL ? "pos.release_policy.changed" : undefined);
    }
  });
});

// ===========================================================================
// 2. Auth and refusals
// ===========================================================================
describe("pos device health contract — auth and refusals", () => {
  it("authenticates the heartbeat with the device bearer only and answers 200, 400, 401, 500", () => {
    expect(contract.operation("post", HEARTBEAT)["security"]).toEqual([{ device: [] }]);
    expect(statuses("post", HEARTBEAT)).toEqual(["200", "400", "401", "500"]);
    expect(contract.parameters("post", HEARTBEAT)).toEqual([]);
  });

  it("puts the console reads on the session cookie with a non-disclosing 404 and no 403", () => {
    for (const [method, path] of [["get", LIST], ["get", GET]] as const) {
      expect(contract.operation(method, path)["security"]).toEqual([{ cookieAuth: [] }]);
      expect(statuses(method, path)).toEqual(["200", "400", "401", "404", "429", "500"]);
    }
  });

  it("puts the platform policy on the session cookie with a 403 and no 404", () => {
    expect(contract.operation("get", POLICY)["security"]).toEqual([{ cookieAuth: [] }]);
    expect(contract.operation("put", POLICY_CHANNEL)["security"]).toEqual([{ cookieAuth: [] }]);
    expect(statuses("get", POLICY)).toEqual(["200", "401", "403", "429", "500"]);
    expect(statuses("put", POLICY_CHANNEL)).toEqual(["200", "400", "401", "403", "409", "422", "429", "500"]);
  });

  it("takes the list filters store, trust state, version, channel, compliance and liveness, plus keyset paging", () => {
    expect(contract.parameters("get", LIST).map((p) => [p["name"], p["in"], p["required"]])).toEqual([
      ["store_id", "query", false],
      ["trust_state", "query", false],
      ["app_version", "query", false],
      ["update_channel", "query", false],
      ["compliance", "query", false],
      ["liveness", "query", false],
      ["cursor", "query", false],
      ["page_size", "query", false],
    ]);
  });

  it("shapes store_id, trust_state, cursor and page_size as on consoleListDevices", () => {
    const devices = contract.sibling("devices.openapi");
    const theirs = ((devices["components"] as JsonObject)["parameters"] ?? {}) as Record<string, JsonObject>;
    const ours = ((contract.document["components"] as JsonObject)["parameters"] ?? {}) as Record<string, JsonObject>;
    for (const name of ["StoreIdQuery", "Cursor", "PageSize", "DeviceIdPath"]) {
      expect(JSON.stringify(ours[name]?.["schema"])).toBe(JSON.stringify(theirs[name]?.["schema"]));
    }
    expect(JSON.stringify(contract.schema("TrustState")["enum"])).toBe(
      JSON.stringify((((devices["components"] as JsonObject)["schemas"] as JsonObject)["TrustState"] as JsonObject)["enum"]),
    );
  });

  it("reads no tenant, actor or user from any request", () => {
    for (const path of [LIST, GET, POLICY] as const) {
      const names = contract.parameters("get", path).map((x) => String(x["name"]));
      expect(names.filter((n) => /tenant|actor|user/i.test(n))).toEqual([]);
    }
    expect(contract.parameters("put", POLICY_CHANNEL).map((p) => p["name"])).toEqual(["channel"]);
  });

  it("marks every 200 no-store", () => {
    for (const [method, path] of [["post", HEARTBEAT], ["get", LIST], ["get", GET], ["get", POLICY], ["put", POLICY_CHANNEL]] as const) {
      const ok = (contract.operation(method, path)["responses"] as Record<string, JsonObject>)["200"] as JsonObject;
      expect((ok["headers"] as JsonObject)["Cache-Control"]).toEqual({ $ref: "#/components/headers/CacheControlNoStore" });
    }
  });
});

// ===========================================================================
// 3. The heartbeat body
// ===========================================================================
describe("pos device health contract — heartbeat body (D-1)", () => {
  it("is closed and holds exactly the six D-1 fields, all optional", () => {
    const s = contract.schema("DeviceHeartbeatReport");
    expect(s["additionalProperties"]).toBe(false);
    expect(s["required"]).toBeUndefined();
    expect(keysOf("DeviceHeartbeatReport")).toEqual(
      ["app_version", "pending_version", "schema_head", "source_clock_at", "update_channel", "update_state"].sort(),
    );
  });

  it("accepts an empty beat, a full beat and nulls", () => {
    expect(contract.accepts("DeviceHeartbeatReport", {})).toBe(true);
    expect(contract.accepts("DeviceHeartbeatReport", FULL_BEAT)).toBe(true);
    const allNull = Object.fromEntries(Object.keys(FULL_BEAT).map((k) => [k, null]));
    expect(contract.accepts("DeviceHeartbeatReport", allNull)).toBe(true);
  });

  it.each(["device_id", "tenant_id", "store_id", "last_seen_at", "hostname", "cashier_id"])(
    "refuses the key %s",
    (key) => {
      expect(contract.accepts("DeviceHeartbeatReport", { ...FULL_BEAT, [key]: "x" })).toBe(false);
    },
  );

  it.each([
    ["a version with build metadata", { app_version: "1.4.0+build.7" }],
    ["a word as a version", { app_version: "latest" }],
    ["an unknown channel", { update_channel: "beta" }],
    ["an unknown update state", { update_state: "done" }],
    ["a path as the schema head", { schema_head: "../migrations/0042" }],
    ["free text as the schema head", { schema_head: "local migration 42" }],
    ["a schema head over 64 characters", { schema_head: "a".repeat(65) }],
    ["a terminal clock that is not a timestamp", { source_clock_at: "yesterday" }],
  ])("refuses %s", (_label, patch) => {
    expect(contract.accepts("DeviceHeartbeatReport", { ...FULL_BEAT, ...patch })).toBe(false);
  });

  it("closes update_state on the ten ADR-0006 §9 states and update_channel on lab, canary, stable", () => {
    expect(contract.schema("UpdateState")["enum"]).toEqual([
      "idle",
      "checking",
      "downloading",
      "downloaded",
      "verify_failed",
      "verify_unavailable",
      "compat_blocked",
      "update_pending",
      "installing",
      "error",
    ]);
    expect(contract.schema("UpdateChannel")["enum"]).toEqual(["lab", "canary", "stable"]);
  });

  it("gives app_version the exact schema of X-POS-App-Version and of the RT-719 build identity", () => {
    const ours = contract.schema("AppVersion");
    const pick = (s: JsonObject) => JSON.stringify([s["type"], s["minLength"], s["maxLength"], s["pattern"]]);
    const header = (
      ((contract.sibling("cash-variance-policy.openapi")["components"] as JsonObject)["parameters"] as JsonObject)[
        "PosAppVersion"
      ] as JsonObject
    )["schema"] as JsonObject;
    const identity = ((contract.sibling("devices.openapi")["components"] as JsonObject)["schemas"] as JsonObject)[
      "AppVersion"
    ] as JsonObject;
    expect(pick(ours)).toBe(pick(header));
    expect(pick(ours)).toBe(pick(identity));
  });
});

// ===========================================================================
// 4. The HeartbeatAck
// ===========================================================================
describe("pos device health contract — HeartbeatAck (D-2, D-3)", () => {
  it("is closed and requires the policy, the contract revision, the grace and the verdict", () => {
    const s = contract.schema("HeartbeatAck");
    expect(s["additionalProperties"]).toBe(false);
    expect([...((s["required"] ?? []) as string[])].sort()).toEqual(keysOf("HeartbeatAck"));
    expect(keysOf("HeartbeatAck")).toEqual(
      ["acknowledged_at", "compliance", "min_supported_grace_until", "policy", "pos_contract_revision"].sort(),
    );
    expect(contract.accepts("HeartbeatAck", ACK)).toBe(true);
    expect(contract.accepts("HeartbeatAck", { ...ACK, device_id: DEVICE_ID })).toBe(false);
  });

  it("holds the three distinct versions in the policy", () => {
    expect(keysOf("HeartbeatPolicy")).toEqual(
      ["channel", "latest_version", "min_supported_version", "policy_revision", "recommended_version"].sort(),
    );
  });

  it("is unknown with a null grace when no policy applies, never ok", () => {
    const none = { ...ACK, policy: null, min_supported_grace_until: null, compliance: "unknown" };
    expect(contract.accepts("HeartbeatAck", none)).toBe(true);
    expect(contract.accepts("HeartbeatAck", { ...none, compliance: "ok" })).toBe(false);
    expect(contract.accepts("HeartbeatAck", { ...none, min_supported_grace_until: AT })).toBe(false);
    expect(contract.accepts("HeartbeatAck", { ...ACK, min_supported_grace_until: null })).toBe(false);
  });

  it("carries a positive integer contract revision", () => {
    expect(contract.accepts("HeartbeatAck", { ...ACK, pos_contract_revision: 0 })).toBe(false);
    expect(contract.accepts("HeartbeatAck", { ...ACK, pos_contract_revision: "1" })).toBe(false);
    expect(contract.accepts("HeartbeatAck", { ...ACK, compliance: "below_minimum" })).toBe(true);
  });
});

// ===========================================================================
// 5. The console row
// ===========================================================================
describe("pos device health contract — console row (D-4, D-5)", () => {
  it("is closed and requires every key", () => {
    const s = contract.schema("DeviceHealthView");
    expect(s["additionalProperties"]).toBe(false);
    expect([...((s["required"] ?? []) as string[])].sort()).toEqual(keysOf("DeviceHealthView"));
  });

  it("accepts a device that never beat (unknown) and one that did", () => {
    expect(contract.accepts("DeviceHealthView", NEVER_SEEN)).toBe(true);
    expect(contract.accepts("DeviceHealthView", SEEN)).toBe(true);
    expect(contract.accepts("DeviceHealthPage", { items: [NEVER_SEEN, SEEN], nextCursor: null })).toBe(true);
  });

  it("never shows a device without a heartbeat as online or compliant", () => {
    expect(contract.accepts("DeviceHealthView", { ...NEVER_SEEN, liveness: "online" })).toBe(false);
    expect(contract.accepts("DeviceHealthView", { ...NEVER_SEEN, compliance: "ok" })).toBe(false);
    expect(contract.accepts("DeviceHealthView", { ...SEEN, liveness: "unknown" })).toBe(false);
  });

  it.each(["appVersion", "updateChannel", "minSupportedVersion"])(
    "is never ok or below_minimum with a heartbeat but a null %s",
    (key) => {
      const missing = { ...SEEN, [key]: null, minSupportedGraceUntil: key === "minSupportedVersion" ? null : AT };
      expect(contract.accepts("DeviceHealthView", { ...missing, compliance: "unknown" })).toBe(true);
      expect(contract.accepts("DeviceHealthView", { ...missing, compliance: "ok" })).toBe(false);
      expect(contract.accepts("DeviceHealthView", { ...missing, compliance: "below_minimum" })).toBe(false);
    },
  );

  it("labels the last seen with its source, null exactly when it is null", () => {
    expect(contract.accepts("DeviceHealthView", { ...SEEN, lastSeenSource: "activity" })).toBe(true);
    expect(contract.accepts("DeviceHealthView", { ...SEEN, lastSeenSource: null })).toBe(false);
    expect(contract.accepts("DeviceHealthView", { ...NEVER_SEEN, lastSeenSource: "activity" })).toBe(false);
    expect(contract.accepts("DeviceHealthView", { ...SEEN, lastSeenSource: "probe" })).toBe(false);
  });

  it("carries no key that can hold PII, a secret or free text", () => {
    const keys = [...keysOf("DeviceHealthView"), ...keysOf("DeviceHeartbeatReport"), ...keysOf("HeartbeatAck")];
    expect(keys.filter((k) => /user|cashier|host|machine|ip$|path|token|secret|note|name|email|phone|tenant/i.test(k))).toEqual(
      [],
    );
  });
});

// ===========================================================================
// 6. The platform policy
// ===========================================================================
describe("pos device health contract — platform policy (D-2)", () => {
  it("returns every channel with its policy or null", () => {
    const set = {
      items: [
        { channel: "lab", policy: null },
        { channel: "canary", policy: null },
        { channel: "stable", policy: STORED_POLICY },
      ],
    };
    expect(contract.accepts("PosVersionPolicySet", set)).toBe(true);
    expect(contract.accepts("PosVersionPolicySet", { items: set.items.slice(0, 2) })).toBe(false);
  });

  it("takes a full replacement with a compare-and-set revision and no free text", () => {
    const change = {
      latestVersion: "1.5.0",
      recommendedVersion: "1.4.2",
      minSupportedVersion: "1.4.0",
      minSupportedGraceUntil: AT,
      expectedRevision: 3,
    };
    expect(contract.accepts("PosVersionPolicyChange", change)).toBe(true);
    expect(contract.accepts("PosVersionPolicyChange", { ...change, expectedRevision: null })).toBe(true);
    expect(contract.accepts("PosVersionPolicyChange", { ...change, reason: "hotfix" })).toBe(false);
    const { expectedRevision: _omitted, ...withoutRevision } = change;
    expect(contract.accepts("PosVersionPolicyChange", withoutRevision)).toBe(false);
  });
});

// ===========================================================================
// 7. The documented rules
// ===========================================================================
describe("pos device health contract — documented rules", () => {
  it.each([
    ["identity only from the guard", /Identity comes from the guard only/],
    ["the server clock is last_seen_at", /`last_seen_at` is the Backend-Core server clock at receipt/],
    ["an omitted field is unknown, never kept", /a field the beat omits\s+is stored as `null` \(unknown\), never kept from an earlier beat/],
    ["throttled storage, the reply always returned", /at most one beat per device per 60 seconds/],
    ["the reply is computed from this request", /computed from THIS request's body and the current\s+policy, never from the stored row/],
    ["no audit row per beat", /No audit row per beat, one metric counter/],
    ["bounded metric labels", /never a version, channel value, device or tenant id/],
    ["app_version is the X-POS-App-Version value", /same\s+name,\s+bound\s+and\s+pattern\s+as\s+`X-POS-App-Version`/],
    ["the heartbeat neither records nor clears the build identity", /the heartbeat neither records nor clears the build identity/],
    ["no duplicated fleet baseline", /`consoleGetFleetBaseline` stays\s+the one baseline read/],
    ["a mismatch is never a refusal", /a mismatch is not an\s+error, refuses nothing and changes no verdict/],
    ["compliance from the body only", /Compliance is computed\s+from the body `app_version` only/],
    ["never ok on missing data", /Never `ok` on\s+missing data/],
    ["behind latest never blocks", /Being behind\s+`latest_version` or `recommended_version` never blocks anything/],
    ["the revision rule", /incremented in the same pull request as the OpenAPI change/],
    ["no install without a fresh signal", /no reply or a stale one leaves the update `update_pending`/],
    ["liveness from the heartbeat clock only", /`lastSeenAt` never drives `liveness`/],
    ["the devices contract is unchanged", /devices contract \(`lastSeenAt` \/ `lastSeenSource` on `DeviceSummary`\) is\s+unchanged/],
    ["platform routes stay off TenantContextGuard", /do not sit behind `TenantContextGuard`, need no support session/],
    ["a no-op change writes no audit row", /writes nothing and no row/],
    ["health never revokes trust", /never a trust revoke/],
  ])("says: %s", (_rule, pattern) => {
    expect(info()).toMatch(pattern);
  });
});
