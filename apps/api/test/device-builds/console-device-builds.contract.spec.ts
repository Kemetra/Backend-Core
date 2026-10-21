/**
 * apps/api/test/device-builds/console-device-builds.contract.spec.ts
 *
 * RT-719 (RT-709 O-8; fleet baseline for the RT-713 POS compatibility matrix):
 * `console-device-builds.openapi.yaml` and the optional `buildIdentity` key of
 * `devices.openapi.yaml`. `[GATED]` contract-first; the baseline is
 * `x-runtime-status: contract-only` until the runtime, its migration and the
 * POS change ship as separate, separately approved work.
 *
 * Structural / load-only, plus AJV fixtures against the contract schemas. No
 * app boot and no HTTP. Pinned here:
 *
 *   1. The operation: one GET, contract-only with a note, an audit action, no
 *      write and no operationId collision.
 *   2. Auth and refusals: `cookieAuth` only, 404 (never 403), no tenant from
 *      the request, one optional `store_id` filter.
 *   3. The identity (on the devices projections) is a strict set of bounded
 *      patterns: no free text, no PII key, a missing value is null (never a
 *      default), unknown keys refused, and the key itself is optional.
 *   4. The baseline shape maps onto the RT-709 §C.1 `installed` entries, and
 *      counts unknown devices explicitly.
 *   5. The documented rules: self-reported, not `lastSeenAt`, never a trust
 *      signal, no PII, the RT-327 heartbeat is not pre-empted.
 */
import { readContract, type ContractReader, type JsonObject } from "../_helpers/openapi-contract-reader";

const BASELINE_PATH = "/api/v1/device-builds/baseline";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const PIN_COMMIT = "89abcdef0123456789abcdef0123456789abcdef";
const DEVICE_ID = "0190f5a2-3b4c-7d8e-9f01-23456789abcd";
const STORE_ID = "0190f5a2-3b4c-7d8e-9f01-000000000002";
const REPORTED = "2026-10-21T10:00:00.000Z";

let contract: ContractReader;
let devices: ContractReader;

beforeAll(() => {
  contract = readContract("console-device-builds.openapi");
  devices = readContract("devices.openapi");
});

const info = (): string => String((contract.document["info"] as JsonObject)["description"]);
const props = (name: Capitalize<string>): Record<string, JsonObject> =>
  (contract.schema(name)["properties"] ?? {}) as Record<string, JsonObject>;
const keysOf = (name: Capitalize<string>): string[] => Object.keys(props(name)).sort();
const omit = (value: Record<string, unknown>, key: string): Record<string, unknown> =>
  Object.fromEntries(Object.entries(value).filter(([k]) => k !== key));

const IDENTITY = { buildCommit: COMMIT, appVersion: null, contractPinCommit: PIN_COMMIT, reportedAt: REPORTED };
const BUILD_ENTRY = {
  kind: "build",
  posVersion: null,
  buildId: COMMIT,
  contractPinCommit: PIN_COMMIT,
  deviceCount: 2,
  oldestReportedAt: REPORTED,
  latestReportedAt: REPORTED,
};
const RELEASE_ENTRY = { ...BUILD_ENTRY, kind: "release", posVersion: "1.4.0" };
const BASELINE = {
  scope: "all_in_scope",
  storeRef: null,
  basis: "terminal_reported",
  generatedAt: REPORTED,
  deviceCount: 3,
  reportingDeviceCount: 2,
  unknownDeviceCount: 1,
  installed: [BUILD_ENTRY],
};

// ===========================================================================
// 1. The operation
// ===========================================================================
describe("console device builds contract — operation", () => {
  it("is OpenAPI 3.1.0 at 1.0.0-draft with exactly the one read", () => {
    expect(contract.document["openapi"]).toBe("3.1.0");
    expect((contract.document["info"] as JsonObject)["version"]).toBe("1.0.0-draft");
    const declared = Object.entries(contract.document["paths"] as Record<string, JsonObject>).flatMap(([path, item]) =>
      Object.keys(item).map((method) => `${method} ${path}`),
    );
    expect(declared).toEqual([`get ${BASELINE_PATH}`]);
  });

  it("is consoleGetFleetBaseline: contract-only, noted, audited, with no foreign collision", () => {
    const operation = contract.operation("get", BASELINE_PATH);
    expect(operation["operationId"]).toBe("consoleGetFleetBaseline");
    expect(operation["x-runtime-status"]).toBe("contract-only");
    expect(String(operation["x-runtime-note"]).trim().length).toBeGreaterThan(0);
    expect(operation["x-audit-action"]).toBe("devices.fleet_baseline_read");
    expect(operation["requestBody"]).toBeUndefined();
    expect(contract.foreignOperationIds.has("consoleGetFleetBaseline")).toBe(false);
  });

  it("adds no operation to the served devices contract", () => {
    const declared = Object.values(devices.document["paths"] as Record<string, JsonObject>).flatMap((item) =>
      Object.values(item).map((o) => (o as JsonObject)["operationId"]),
    );
    expect(declared.filter((id) => /build|baseline/i.test(String(id)))).toEqual([]);
  });
});

// ===========================================================================
// 2. Auth, scope and filters
// ===========================================================================
describe("console device builds contract — auth and scope", () => {
  it("declares the dp2_session cookie as the only scheme, document-wide", () => {
    const components = contract.document["components"] as JsonObject;
    expect(contract.document["security"]).toEqual([{ cookieAuth: [] }]);
    expect(Object.keys(components["securitySchemes"] as JsonObject)).toEqual(["cookieAuth"]);
    expect(contract.operation("get", BASELINE_PATH)["security"]).toBeUndefined();
  });

  it("answers exactly 200, 400, 401, 404, 429, 500 (scope refusals are 404, never 403)", () => {
    const statuses = Object.keys(contract.operation("get", BASELINE_PATH)["responses"] as JsonObject).sort();
    expect(statuses).toEqual(["200", "400", "401", "404", "429", "500"]);
  });

  it("marks the 200 no-store", () => {
    const ok = (contract.operation("get", BASELINE_PATH)["responses"] as Record<string, JsonObject>)["200"] as JsonObject;
    expect((ok["headers"] as JsonObject)["Cache-Control"]).toEqual({ $ref: "#/components/headers/CacheControlNoStore" });
  });

  it("takes only the optional store_id, shaped as on consoleListDevices", () => {
    const params = contract.parameters("get", BASELINE_PATH);
    expect(params.map((p) => [p["name"], p["in"], p["required"]])).toEqual([["store_id", "query", false]]);
    const there = devices.parameters("get", "/api/v1/devices").find((p) => p["name"] === "store_id");
    expect(JSON.stringify(params[0]?.["schema"])).toBe(JSON.stringify(there?.["schema"]));
  });

  it("reads no tenant, actor or user from the request", () => {
    const names = contract.parameters("get", BASELINE_PATH).map((x) => String(x["name"]));
    expect(names.filter((n) => /tenant|actor|user/i.test(n))).toEqual([]);
  });
});

// ===========================================================================
// 3. The identity: bounded patterns, no free text, unknown is null
// ===========================================================================
describe("devices contract — build identity (RT-719)", () => {
  const identityKeys = (): string[] =>
    Object.keys(((devices.schema("DeviceBuildIdentity")["properties"] ?? {}) as JsonObject)).sort();
  const summaryProps = (name: Capitalize<string>): Record<string, JsonObject> =>
    (devices.schema(name)["properties"] ?? {}) as Record<string, JsonObject>;

  it("is closed, requires every key, and holds a commit, a version, a pin commit and a server time", () => {
    const s = devices.schema("DeviceBuildIdentity");
    expect(s["additionalProperties"]).toBe(false);
    expect(identityKeys()).toEqual(["appVersion", "buildCommit", "contractPinCommit", "reportedAt"]);
    expect([...((s["required"] ?? []) as string[])].sort()).toEqual(identityKeys());
  });

  it("is an optional, nullable key on the summary and the detail, never required", () => {
    for (const name of ["DeviceSummary", "DeviceDetail"] as const) {
      expect(Object.keys(summaryProps(name))).toContain("buildIdentity");
      expect((devices.schema(name)["required"] as string[]) ?? []).not.toContain("buildIdentity");
      expect(summaryProps(name)["buildIdentity"]).toMatchObject({
        oneOf: [{ $ref: "#/components/schemas/DeviceBuildIdentity" }, { type: "null" }],
      });
    }
  });

  it("accepts a summary with the key, with a null key and without it (an old served response)", () => {
    const device = {
      deviceId: DEVICE_ID,
      storeId: STORE_ID,
      label: null,
      trustState: "active",
      createdAt: REPORTED,
      expiresAt: REPORTED,
      lastSeenAt: null,
      lastSeenSource: null,
      revokedAt: null,
      revokedByUserId: null,
      revokeReason: null,
      retiredAt: null,
      replacesDeviceId: null,
      replacedByDeviceId: null,
      custodyExceptionShiftId: null,
    };
    expect(devices.accepts("DeviceSummary", device)).toBe(true);
    expect(devices.accepts("DeviceSummary", { ...device, buildIdentity: null })).toBe(true);
    expect(devices.accepts("DeviceSummary", { ...device, buildIdentity: IDENTITY })).toBe(true);
    expect(devices.accepts("DeviceSummary", { ...device, buildIdentity: { ...IDENTITY, hostname: "till-1" } })).toBe(false);
  });

  it("carries no key that can hold PII, a secret or free text", () => {
    const keys = [...identityKeys(), ...keysOf("FleetBuildEntry"), ...keysOf("FleetBaseline")];
    expect(keys.filter((k) => /user|cashier|host|machine|ip$|path|token|secret|note|name|email|phone|pin$/i.test(k))).toEqual(
      [],
    );
  });

  it.each([
    ["a full lower-case commit", COMMIT, true],
    ["an abbreviated commit", COMMIT.slice(0, 12), false],
    ["an upper-case commit", COMMIT.toUpperCase(), false],
    ["a commit with a suffix", `${COMMIT}\n`, false],
    ["a non-hex commit", "z".repeat(40), false],
  ])("%s as a buildCommit is judged %s", (_label, value, expected) => {
    expect(devices.accepts("DeviceBuildIdentity", { ...IDENTITY, buildCommit: value })).toBe(expected);
  });

  it.each([
    ["1.4.0", true],
    ["0.0.1", true],
    ["1.4.0-rc.1", true],
    ["1.4", false],
    ["v1.4.0", false],
    ["01.4.0", false],
    ["1.4.0+build.7", false],
    [`1.4.0-${"a".repeat(30)}`, false],
    ["1.4.0\nextra", false],
    ["", false],
  ])("%j as an appVersion is judged %s", (value, expected) => {
    expect(devices.accepts("DeviceBuildIdentity", { ...IDENTITY, appVersion: value })).toBe(expected);
  });

  it("accepts a null version and a null pin commit (not sent), and never a missing key", () => {
    expect(devices.accepts("DeviceBuildIdentity", IDENTITY)).toBe(true);
    expect(devices.accepts("DeviceBuildIdentity", { ...IDENTITY, contractPinCommit: null })).toBe(true);
    for (const key of identityKeys()) {
      expect(devices.accepts("DeviceBuildIdentity", omit(IDENTITY, key))).toBe(false);
    }
    expect(devices.accepts("DeviceBuildIdentity", { ...IDENTITY, buildCommit: null })).toBe(false);
  });

  it("refuses an unknown key and a free-text value", () => {
    expect(devices.accepts("DeviceBuildIdentity", { ...IDENTITY, hostname: "till-1" })).toBe(false);
    expect(devices.accepts("DeviceBuildIdentity", { ...IDENTITY, appVersion: "latest" })).toBe(false);
    expect(devices.accepts("DeviceBuildIdentity", { ...IDENTITY, reportedAt: "yesterday" })).toBe(false);
  });

  it("states the optional-key exception in the info and on the projection", () => {
    const text = String((devices.document["info"] as JsonObject)["description"]);
    expect(text).toMatch(/\*\*1\.5\.0-draft \(RT-719, additive\)\.\*\*/);
    expect(text).toMatch(/the one exception to "every key is always present"/);
    expect(text).toMatch(/reads an\s+absent key and `null` the same way, as unknown/);
    expect(String(devices.schema("DeviceSummary")["description"])).toMatch(/except the\s+optional `buildIdentity`/);
  });
});

// ===========================================================================
// 4. The baseline
// ===========================================================================
describe("console device builds contract — baseline", () => {
  it("maps each baseline entry onto the RT-709 C.1 installed kinds: release has a version, build has none", () => {
    expect(contract.schema("FleetBuildKind")["enum"]).toEqual(["release", "build"]);
    expect(contract.accepts("FleetBuildEntry", BUILD_ENTRY)).toBe(true);
    expect(contract.accepts("FleetBuildEntry", RELEASE_ENTRY)).toBe(true);
    expect(contract.accepts("FleetBuildEntry", { ...BUILD_ENTRY, posVersion: "1.4.0" })).toBe(false);
    expect(contract.accepts("FleetBuildEntry", { ...RELEASE_ENTRY, posVersion: null })).toBe(false);
    expect(contract.accepts("FleetBuildEntry", { ...BUILD_ENTRY, deviceCount: 0 })).toBe(false);
    expect(contract.accepts("FleetBuildEntry", { ...BUILD_ENTRY, buildId: COMMIT.slice(0, 12) })).toBe(false);
  });

  it("counts the devices whose build is unknown, as a number that is never omitted", () => {
    expect(contract.accepts("FleetBaseline", BASELINE)).toBe(true);
    expect(contract.accepts("FleetBaseline", { ...BASELINE, installed: [], reportingDeviceCount: 0 })).toBe(true);
    expect(contract.accepts("FleetBaseline", omit(BASELINE, "unknownDeviceCount"))).toBe(false);
    expect(contract.accepts("FleetBaseline", { ...BASELINE, unknownDeviceCount: -1 })).toBe(false);
    expect(contract.accepts("FleetBaseline", { ...BASELINE, basis: "attested" })).toBe(false);
  });

  it("scopes the baseline to one store or to every store in scope, with storeRef set exactly for one store", () => {
    expect(contract.accepts("FleetBaseline", { ...BASELINE, scope: "store", storeRef: STORE_ID })).toBe(true);
    expect(contract.accepts("FleetBaseline", { ...BASELINE, scope: "tenant" })).toBe(false);
    expect(contract.accepts("FleetBaseline", { ...BASELINE, scope: "store", storeRef: null })).toBe(false);
    expect(contract.accepts("FleetBaseline", { ...BASELINE, scope: "all_in_scope", storeRef: STORE_ID })).toBe(false);
  });

  it("declares a closed envelope that requires every key it declares", () => {
    for (const name of ["FleetBuildEntry", "FleetBaseline"] as const) {
      expect(contract.schema(name)["additionalProperties"]).toBe(false);
      expect([...((contract.schema(name)["required"] ?? []) as string[])].sort()).toEqual(keysOf(name));
    }
  });

  it("keeps the identity formats identical to the devices contract", () => {
    for (const name of ["GitCommit", "AppVersion"] as const) {
      expect(JSON.stringify(contract.schema(name))).toBe(JSON.stringify(devices.schema(name)));
    }
  });
});

// ===========================================================================
// 5. The documented rules
// ===========================================================================
describe("console device builds contract — documented rules", () => {
  it.each([
    ["unknown is never a default", /\*\*Unknown is never a default\.\*\*/],
    ["a self-report, never a trust signal", /never a security or trust signal/],
    ["not lastSeenAt", /It is not `lastSeenAt` and does not\s+replace or alias it/],
    ["the server clock, never a terminal clock", /server clock when Backend-Core last stored\s+the\s+identity, never a terminal clock/],
    ["no PII and no egress", /No PII, no new egress/],
    ["the baseline counts active devices only", /ACTIVE devices of the caller's tenant and store scope/],
    ["unknown devices are counted, never folded", /never folded into a\s+build/],
    ["the RT-327 heartbeat is not pre-empted", /this contract does not fix its wire\s+shape/],
    ["the RT-709 C.1 mapping", /RT-709 §C\.1 `fleet_baseline\.installed`/],
    ["the per-device read is the devices key", /`buildIdentity` key that\s+`DeviceSummary` and `DeviceDetail` gain/],
  ])("states: %s", (_rule, pattern) => {
    expect(info()).toMatch(pattern);
  });

  it("states that the store scope has no RLS backstop and the query applies it", () => {
    expect(info()).toMatch(/store scope has no\s+database backstop/);
  });

  it("names the posture: contract-only, with the runtime, migration and POS change separate", () => {
    expect(info()).toMatch(/`x-runtime-status: contract-only` on the\s+operation/);
    expect(info()).toMatch(/separate, separately\s+approved work/);
  });
});
