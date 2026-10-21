/**
 * apps/api/test/device-builds/console-device-builds.contract.spec.ts
 *
 * RT-719 (RT-709 O-8; fleet baseline for the RT-713 POS compatibility matrix):
 * `console-device-builds.openapi.yaml`. `[GATED]` contract-first; both
 * operations are `x-runtime-status: contract-only` until the runtime, its
 * migration and the POS change ship as separate, separately approved work.
 *
 * Structural / load-only, plus AJV fixtures against the contract schemas. No
 * app boot and no HTTP. Pinned here:
 *
 *   1. The operations: two GETs, contract-only with a note, an audit action,
 *      no write and no operationId collision.
 *   2. Auth and refusals: `cookieAuth` only, 404 (never 403), no tenant from
 *      the request, the same filters as `consoleListDevices`.
 *   3. The identity is a strict set of bounded patterns: no free text, no PII
 *      key, a missing value is null (never a default), unknown keys refused.
 *   4. The baseline shape maps onto the RT-709 §C.1 `installed` entries, and
 *      counts unknown devices explicitly.
 *   5. The documented rules: self-reported, not `lastSeenAt`, never a trust
 *      signal, no PII, the RT-327 heartbeat is not pre-empted.
 */
import { readContract, type ContractReader, type JsonObject } from "../_helpers/openapi-contract-reader";

const LIST_PATH = "/api/v1/device-builds";
const BASELINE_PATH = "/api/v1/device-builds/baseline";

const OPERATIONS = [
  ["get", LIST_PATH, "consoleListDeviceBuilds", "devices.builds_listed"],
  ["get", BASELINE_PATH, "consoleGetFleetBaseline", "devices.fleet_baseline_read"],
] as const;

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const PIN_COMMIT = "89abcdef0123456789abcdef0123456789abcdef";
const DEVICE_ID = "0190f5a2-3b4c-7d8e-9f01-23456789abcd";
const STORE_ID = "0190f5a2-3b4c-7d8e-9f01-000000000002";
const REPORTED = "2026-10-21T10:00:00.000Z";

let contract: ContractReader;

beforeAll(() => {
  contract = readContract("console-device-builds.openapi");
});

const info = (): string => String((contract.document["info"] as JsonObject)["description"]);
const props = (name: Capitalize<string>): Record<string, JsonObject> =>
  (contract.schema(name)["properties"] ?? {}) as Record<string, JsonObject>;
const keysOf = (name: Capitalize<string>): string[] => Object.keys(props(name)).sort();

const omit = (value: Record<string, unknown>, key: string): Record<string, unknown> =>
  Object.fromEntries(Object.entries(value).filter(([k]) => k !== key));

const IDENTITY = { buildCommit: COMMIT, appVersion: null, contractPinCommit: PIN_COMMIT, reportedAt: REPORTED };
const ROW = { deviceId: DEVICE_ID, storeId: STORE_ID, label: "Till 1", trustState: "active", buildIdentity: IDENTITY };
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
// 1. Operations
// ===========================================================================
describe("console device builds contract — operations", () => {
  it("is OpenAPI 3.1.0 at 1.0.0-draft with exactly the two reads", () => {
    expect(contract.document["openapi"]).toBe("3.1.0");
    expect((contract.document["info"] as JsonObject)["version"]).toBe("1.0.0-draft");
    const declared = Object.entries(contract.document["paths"] as Record<string, JsonObject>).flatMap(([path, item]) =>
      Object.keys(item).map((method) => `${method} ${path}`),
    );
    expect(declared.sort()).toEqual(OPERATIONS.map(([m, p]) => `${m} ${p}`).sort());
  });

  it.each(OPERATIONS)("%s %s is %s: contract-only, noted, audited, with no foreign collision", (m, p, id, audit) => {
    const operation = contract.operation(m, p);
    expect(operation["operationId"]).toBe(id);
    expect(operation["x-runtime-status"]).toBe("contract-only");
    expect(String(operation["x-runtime-note"]).trim().length).toBeGreaterThan(0);
    expect(operation["x-audit-action"]).toBe(audit);
    expect(operation["requestBody"]).toBeUndefined();
    expect(contract.foreignOperationIds.has(id)).toBe(false);
  });

  it("adds no operation to the served devices contract and no key to its projections", () => {
    const devices = readContract("devices.openapi");
    const declared = Object.values(devices.document["paths"] as Record<string, JsonObject>).flatMap((item) =>
      Object.values(item).map((o) => (o as JsonObject)["operationId"]),
    );
    expect(declared.filter((id) => /build/i.test(String(id)))).toEqual([]);
    for (const name of ["DeviceSummary", "DeviceDetail"] as const) {
      const keys = Object.keys((devices.schema(name)["properties"] ?? {}) as JsonObject);
      expect(keys.filter((k) => /build|version|commit/i.test(k))).toEqual([]);
    }
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
    for (const [m, p] of OPERATIONS) expect(contract.operation(m, p)["security"]).toBeUndefined();
  });

  it.each([
    [LIST_PATH, ["200", "400", "401", "404", "429", "500"]],
    [BASELINE_PATH, ["200", "400", "401", "404", "429", "500"]],
  ] as const)("%s answers exactly %j (scope refusals are 404, never 403)", (path, statuses) => {
    expect(Object.keys(contract.operation("get", path)["responses"] as JsonObject).sort()).toEqual([...statuses].sort());
  });

  it("marks every 200 no-store", () => {
    for (const [m, p] of OPERATIONS) {
      const ok = (contract.operation(m, p)["responses"] as Record<string, JsonObject>)["200"] as JsonObject;
      expect((ok["headers"] as JsonObject)["Cache-Control"]).toEqual({ $ref: "#/components/headers/CacheControlNoStore" });
    }
  });

  it("takes the same optional filters as consoleListDevices, and only store_id on the baseline", () => {
    const list = contract.parameters("get", LIST_PATH);
    expect(list.map((p) => [p["name"], p["in"], p["required"]]).sort()).toEqual(
      [
        ["cursor", "query", false],
        ["page_size", "query", false],
        ["store_id", "query", false],
        ["trust_state", "query", false],
      ].sort(),
    );
    expect(contract.parameters("get", BASELINE_PATH).map((p) => [p["name"], p["required"]])).toEqual([
      ["store_id", false],
    ]);
    const devices = readContract("devices.openapi");
    for (const name of ["store_id", "trust_state", "cursor", "page_size"]) {
      const here = list.find((p) => p["name"] === name);
      const there = devices.parameters("get", "/api/v1/devices").find((p) => p["name"] === name);
      expect(JSON.stringify(here?.["schema"])).toBe(JSON.stringify(there?.["schema"]));
    }
  });

  it("reads no tenant, actor or user from the request", () => {
    const names = OPERATIONS.flatMap(([m, p]) => contract.parameters(m, p).map((x) => String(x["name"])));
    expect(names.filter((n) => /tenant|actor|user/i.test(n))).toEqual([]);
  });

  it("keeps the device trust-state vocabulary identical to the devices contract", () => {
    expect(contract.schema("TrustState")["enum"]).toEqual(
      readContract("devices.openapi").schema("TrustState")["enum"],
    );
  });
});

// ===========================================================================
// 3. The identity: bounded patterns, no free text, unknown is null
// ===========================================================================
describe("console device builds contract — build identity", () => {
  it("is closed, requires every key, and holds a commit, a version, a pin commit and a server time", () => {
    const s = contract.schema("DeviceBuildIdentity");
    expect(s["additionalProperties"]).toBe(false);
    expect(keysOf("DeviceBuildIdentity")).toEqual(["appVersion", "buildCommit", "contractPinCommit", "reportedAt"]);
    expect([...((s["required"] ?? []) as string[])].sort()).toEqual(keysOf("DeviceBuildIdentity"));
  });

  it("carries no key that can hold PII, a secret or free text", () => {
    const keys = [
      ...keysOf("DeviceBuildIdentity"),
      ...keysOf("DeviceBuildRow"),
      ...keysOf("FleetBuildEntry"),
      ...keysOf("FleetBaseline"),
    ];
    expect(keys.filter((k) => /user|cashier|host|machine|ip$|path|token|secret|note|name|email|phone|pin$/i.test(k))).toEqual(
      [],
    );
  });

  it.each([
    ["a full lower-case commit", COMMIT, true],
    ["an abbreviated commit", COMMIT.slice(0, 12), false],
    ["an upper-case commit", COMMIT.toUpperCase(), false],
    ["a commit with a suffix", `${COMMIT}\n`, false],
    ["a non-hex commit", `${"z".repeat(40)}`, false],
  ])("%s as a buildCommit is judged %s", (_label, value, expected) => {
    expect(contract.accepts("DeviceBuildIdentity", { ...IDENTITY, buildCommit: value })).toBe(expected);
  });

  it.each([
    ["1.4.0", true],
    ["0.0.1", true],
    ["1.4.0-rc.1", true],
    ["1.4", false],
    ["v1.4.0", false],
    ["01.4.0", false],
    ["1.4.0+build.7", false],
    ["1.4.0-" + "a".repeat(30), false],
    ["1.4.0\nextra", false],
    ["", false],
  ])("%j as an appVersion is judged %s", (value, expected) => {
    expect(contract.accepts("DeviceBuildIdentity", { ...IDENTITY, appVersion: value })).toBe(expected);
  });

  it("accepts a null version and a null pin commit (not sent), and never a missing key", () => {
    expect(contract.accepts("DeviceBuildIdentity", IDENTITY)).toBe(true);
    expect(contract.accepts("DeviceBuildIdentity", { ...IDENTITY, contractPinCommit: null })).toBe(true);
    for (const key of ["buildCommit", "appVersion", "contractPinCommit", "reportedAt"]) {
      expect(contract.accepts("DeviceBuildIdentity", omit(IDENTITY, key))).toBe(false);
    }
    expect(contract.accepts("DeviceBuildIdentity", { ...IDENTITY, buildCommit: null })).toBe(false);
  });

  it("refuses an unknown key and a free-text value", () => {
    expect(contract.accepts("DeviceBuildIdentity", { ...IDENTITY, hostname: "till-1" })).toBe(false);
    expect(contract.accepts("DeviceBuildIdentity", { ...IDENTITY, appVersion: "latest" })).toBe(false);
    expect(contract.accepts("DeviceBuildIdentity", { ...IDENTITY, reportedAt: "yesterday" })).toBe(false);
  });
});

// ===========================================================================
// 4. The rows and the baseline
// ===========================================================================
describe("console device builds contract — rows and baseline", () => {
  it("gives every row a build identity or an explicit null, never an omitted key", () => {
    expect(contract.accepts("DeviceBuildRow", ROW)).toBe(true);
    expect(contract.accepts("DeviceBuildRow", { ...ROW, buildIdentity: null })).toBe(true);
    expect(contract.accepts("DeviceBuildRow", omit(ROW, "buildIdentity"))).toBe(false);
    expect(contract.accepts("DeviceBuildRow", { ...ROW, trustState: "expired" })).toBe(false);
    expect(contract.accepts("DeviceBuildRow", { ...ROW, tenantId: STORE_ID })).toBe(false);
  });

  it("bounds a page at the page_size maximum and ends with a null cursor", () => {
    expect(props("DeviceBuildPage")["items"]).toMatchObject({ maxItems: 200 });
    expect(contract.accepts("DeviceBuildPage", { items: [ROW], nextCursor: null })).toBe(true);
    expect(contract.accepts("DeviceBuildPage", { items: [], nextCursor: null })).toBe(true);
    expect(contract.accepts("DeviceBuildPage", { items: [ROW] })).toBe(false);
  });

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

  it("scopes the baseline to one store or to every store in scope", () => {
    expect(contract.accepts("FleetBaseline", { ...BASELINE, scope: "store", storeRef: STORE_ID })).toBe(true);
    expect(contract.accepts("FleetBaseline", { ...BASELINE, scope: "tenant" })).toBe(false);
  });

  it("declares a closed envelope and refuses an extra key on every projection", () => {
    for (const name of ["DeviceBuildRow", "DeviceBuildPage", "FleetBuildEntry", "FleetBaseline"] as const) {
      expect(contract.schema(name)["additionalProperties"]).toBe(false);
      expect([...((contract.schema(name)["required"] ?? []) as string[])].sort()).toEqual(keysOf(name));
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
  ])("states: %s", (_rule, pattern) => {
    expect(info()).toMatch(pattern);
  });

  it("states that the store scope has no RLS backstop and the query applies it", () => {
    expect(info()).toMatch(/store scope has no\s+database backstop/);
  });

  it("names the posture: contract-only, with the runtime, migration and POS change separate", () => {
    expect(info()).toMatch(/`x-runtime-status: contract-only` on both\s+operations/);
    expect(info()).toMatch(/separate, separately\s+approved work/);
  });
});
