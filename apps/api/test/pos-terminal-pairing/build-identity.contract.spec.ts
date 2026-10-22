/**
 * RT-719 — the POS build identity request headers are documented, identically,
 * as optional header parameters on every route that sends the RT-639 rotate-soon
 * hint (the routes `PosDeviceAuthGuard` authenticates), and nowhere else; and
 * the pairing contract states the report rules once.
 *
 * `[GATED]` contract-first: nothing reads the headers yet. Structural only.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import Ajv from "ajv";
import { load as parseYaml } from "js-yaml";

const OPENAPI_DIR = resolve(__dirname, "..", "..", "..", "..", "packages", "contracts", "openapi");

/** contract file → the operations that document the build identity headers. */
const REPORTING_OPERATIONS: Readonly<Record<string, readonly string[]>> = {
  "catalog/read-down.yaml": ["posGetCatalogSnapshot", "posGetCatalogDeltas"],
  "pos-sales/sales.yaml": ["captureSale"],
  "pos-sales/sale-history.yaml": ["listSaleHistory", "readSaleHistoryDetail", "recordSaleReprint"],
  "cash-variance-policy.openapi.yaml": ["posGetCashVariancePolicy"],
  "pos-shifts.openapi.yaml": ["openShift", "recordCashMovement", "closeShift"],
  "pos-cashier-admissions.openapi.yaml": [
    "posCreateCashierAdmission",
    "posEndCashierAdmission",
    "posListCashierAdmissionRoster",
  ],
};

/** parameter component → header name. */
const HEADERS: Readonly<Record<string, string>> = {
  PosBuildCommit: "X-POS-Build-Commit",
  PosAppVersion: "X-POS-App-Version",
  PosContractPin: "X-POS-Contract-Pin",
};

const COMMIT = "0123456789abcdef0123456789abcdef01234567";

interface Parameter {
  $ref?: string;
  name?: string;
  in?: string;
  required?: boolean;
  schema?: Record<string, unknown>;
  description?: string;
}
interface Operation {
  operationId?: string;
  parameters?: Parameter[];
}
interface Doc {
  info: { version: string; description: string };
  paths: Record<string, Record<string, Operation>>;
  components?: { parameters?: Record<string, Parameter> };
}

const load = (file: string): Doc => parseYaml(readFileSync(resolve(OPENAPI_DIR, file), "utf8")) as Doc;

function operation(doc: Doc, operationId: string): Operation {
  for (const item of Object.values(doc.paths)) {
    for (const op of Object.values(item)) {
      if (op.operationId === operationId) return op;
    }
  }
  throw new Error(`operation ${operationId} not found`);
}

const parametersOf = (doc: Doc): Record<string, Parameter> => doc.components?.parameters ?? {};
const refsOf = (op: Operation): string[] => (op.parameters ?? []).flatMap((p) => (p.$ref ? [p.$ref] : []));
const buildRefs = Object.keys(HEADERS).map((name) => `#/components/parameters/${name}`);

describe("POS build identity headers in the contracts (RT-719)", () => {
  describe.each(Object.entries(REPORTING_OPERATIONS))("%s", (file, operationIds) => {
    const doc = load(file);

    it("defines the three headers as optional, closed patterns", () => {
      const parameters = parametersOf(doc);
      for (const [component, header] of Object.entries(HEADERS)) {
        expect(parameters[component]).toMatchObject({ name: header, in: "header", required: false });
        expect(parameters[component]).toMatchObject({
          schema: { type: "string", pattern: expect.any(String), maxLength: expect.any(Number) },
        });
      }
    });

    it.each(operationIds)("%s documents all three headers", (operationId) => {
      const refs = refsOf(operation(doc, operationId));
      for (const ref of buildRefs) expect(refs).toContain(ref);
    });
  });

  it("defines each header identically in every contract that documents it", () => {
    const definitions = Object.keys(REPORTING_OPERATIONS).map((file) => parametersOf(load(file)));
    for (const component of Object.keys(HEADERS)) {
      const [first, ...rest] = definitions.map((d) => JSON.stringify(d[component]));
      for (const other of rest) expect(other).toBe(first);
    }
  });

  it("bounds the commit as 40 lower-case hex and the version as a short semantic version", () => {
    const parameters = parametersOf(load("pos-shifts.openapi.yaml"));
    const ajv = new Ajv({ strict: false });
    const accepts = (component: string, value: string): boolean =>
      ajv.compile(parameters[component]?.schema ?? {})(value) === true;
    for (const component of ["PosBuildCommit", "PosContractPin"]) {
      expect(accepts(component, COMMIT)).toBe(true);
      expect(accepts(component, COMMIT.toUpperCase())).toBe(false);
      expect(accepts(component, COMMIT.slice(0, 12))).toBe(false);
      expect(accepts(component, `${COMMIT}\n`)).toBe(false);
    }
    expect(accepts("PosAppVersion", "1.4.0")).toBe(true);
    expect(accepts("PosAppVersion", "1.4.0-rc.1")).toBe(true);
    expect(accepts("PosAppVersion", "1.4.0+build.7")).toBe(false);
    expect(accepts("PosAppVersion", "latest")).toBe(false);
    expect(accepts("PosAppVersion", `1.4.0-${"a".repeat(30)}`)).toBe(false);
  });

  it("documents them on no other operation: not the pairing, not the rotation, no operator route", () => {
    const documented = new Set(Object.values(REPORTING_OPERATIONS).flat());
    const pairing = load("pos-terminal-pairing.openapi.yaml");
    for (const operationId of ["posPairTerminal", "posRotateTerminalToken"]) {
      const refs = refsOf(operation(pairing, operationId));
      for (const ref of buildRefs) expect(refs).not.toContain(ref);
    }
    expect(parametersOf(pairing)["PosBuildCommit"]).toBeUndefined();
    expect(documented.size).toBe(13);
  });

  it("does not document them on the RT-327 heartbeat (hinted, but not a reporting operation)", () => {
    const health = load("pos-device-health.openapi.yaml");
    const refs = refsOf(operation(health, "posReportDeviceHeartbeat"));
    for (const ref of buildRefs) expect(refs).not.toContain(ref);
    for (const component of Object.keys(HEADERS)) expect(parametersOf(health)[component]).toBeUndefined();
  });

  describe("the pairing contract states the report rules once", () => {
    const pairing = load("pos-terminal-pairing.openapi.yaml");
    const text = pairing.info.description;

    it("is 1.4.0-draft, and both RT-719 and RT-327 postures say they add no operation", () => {
      expect(pairing.info.version).toBe("1.4.0-draft");
      expect(text).toMatch(/`1\.3\.0-draft` is additive and adds no operation/);
      expect(text).toMatch(/`1\.4\.0-draft` is additive and adds no operation/);
    });

    it("names the thirteen reporting operations explicitly, not by reference to the hinted set", () => {
      const reporting = Object.values(REPORTING_OPERATIONS).flat();
      for (const operationId of reporting) expect(text).toContain(`\`${operationId}\``);
      expect(text).toMatch(/exactly these\s+thirteen operations/);
      expect(text).toMatch(/carrying the\s+rotate-soon hint does not make an operation a reporting one/);
    });

    it.each([
      ["the commit header", /`X-POS-Build-Commit`: the POS git commit/],
      ["the version header", /`X-POS-App-Version`: the POS semantic version/],
      ["the contract pin header", /`X-POS-Contract-Pin`: the Backend-Core commit/],
      ["optional and additive, never refusing a request", /A request is never refused,\s+slowed or changed in its answer for a header/],
      ["unknown is never a default", /without a valid `X-POS-Build-Commit` records the device's build as\s+unknown/],
      ["other device-token routes neither record nor clear it", /leaves the stored identity unchanged: it can\s+neither record nor clear it/],
      ["an older build is never shown as the newer one it replaced", /never\s+be shown as the newer build it replaced/],
      ["a strict character set and bound per header", /exactly 40 characters of `\[0-9a-f\]`/],
      ["a bad value is treated as missing, never repaired", /is treated as missing: it is never truncated, normalised or repaired/],
      ["no PII, no secret, never logged raw, never a metric label", /never logs a\s+raw value and never uses one as a metric label/],
      ["the server clock, not a terminal time", /never a terminal time/],
      ["not lastSeenAt and not a trust signal", /nothing about `lastSeenAt` or `lastSeenSource` changes/],
      ["a store may be deferred to the next write window, a change included", /MAY defer any store,\s+a changed or a cleared identity included/],
      ["a failed store never reaches the response", /A failure to\s+store is counted and swallowed/],
      ["the heartbeat stays the canonical channel", /remains the canonical reporting channel/],
      ["the heartbeat reuses the same names and formats", /`app_version` and `update_channel` keep the names and formats/],
      ["the RT-327 heartbeat is not pre-empted", /does not fix the heartbeat's wire\s+shape/],
      ["the POS change is separate, through the PIN", /coordinated through the\s+contracts PIN/],
    ])("says: %s", (_rule, pattern) => {
      expect(text).toMatch(pattern);
    });
  });
});
