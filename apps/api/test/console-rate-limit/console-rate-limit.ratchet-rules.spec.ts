/**
 * RT-805 — negative tests for the console rate-limit ratchet rules. The
 * classes live in one file per contract under `classes/` (no shared list), so
 * these pin every way the ratchet must still fail.
 */
import {
  classFilePathFor,
  ratchetViolations,
  type RateLimitClassFile,
  type RatchetInput,
} from "../_helpers/console-rate-limit-classes";
import type { ContractRoute, Operation } from "../_helpers/openapi-routes";

const cookieOp = (file: string, operation: Operation, path = `/api/v1/${operation.operationId}`): ContractRoute => ({
  file,
  path,
  method: "get",
  operation,
  security: [{ cookieAuth: [] }],
});

const runtime = (file: string, operationId: string) => cookieOp(file, { operationId });
const contractOnly = (file: string, operationId: string) =>
  cookieOp(file, { operationId, "x-runtime-status": "contract-only", "x-runtime-note": "RT-1" });

const VALID = new Set(["cheapRead", "expensiveRead", "write", "exempt"]);

function input(overrides: Partial<RatchetInput>): RatchetInput {
  return {
    cookieOps: [runtime("stores.openapi.yaml", "listStores"), contractOnly("stores.openapi.yaml", "archiveStore")],
    classFiles: [{ path: "stores.rate-limit.yaml", classes: { listStores: "cheapRead", archiveStore: "write" } }],
    validClasses: VALID,
    resolveRuntime: (op) => (op.operation.operationId === "listStores" ? "cheapRead" : undefined),
    ...overrides,
  };
}

describe("console rate-limit ratchet rules (RT-805)", () => {
  it("maps a contract to its class file", () => {
    expect(classFilePathFor("audit.openapi.yaml")).toBe("audit.rate-limit.yaml");
    expect(classFilePathFor("catalog/console-catalog.yaml")).toBe("catalog/console-catalog.rate-limit.yaml");
  });

  it("passes when every cookieAuth operation is classified and the runtime agrees", () => {
    expect(ratchetViolations(input({}))).toEqual([]);
  });

  it("fails on an unclassified runtime cookieAuth operation", () => {
    const classFiles: RateLimitClassFile[] = [{ path: "stores.rate-limit.yaml", classes: { archiveStore: "write" } }];
    expect(ratchetViolations(input({ classFiles }))).toEqual([
      "unclassified cookieAuth operation: listStores (add it to classes/stores.rate-limit.yaml)",
    ]);
  });

  it("fails on an unclassified contract-only cookieAuth operation", () => {
    const classFiles: RateLimitClassFile[] = [{ path: "stores.rate-limit.yaml", classes: { listStores: "cheapRead" } }];
    expect(ratchetViolations(input({ classFiles }))).toEqual([
      "unclassified cookieAuth operation: archiveStore (add it to classes/stores.rate-limit.yaml)",
    ]);
  });

  it("fails when the runtime resolves a different class", () => {
    expect(ratchetViolations(input({ resolveRuntime: (op) => (op.operation.operationId === "listStores" ? "expensiveRead" : undefined) }))).toEqual([
      "class mismatch: listStores is declared cheapRead but the runtime resolves expensiveRead",
    ]);
  });

  it("fails on a runtime cookieAuth operation with no controller route", () => {
    expect(ratchetViolations(input({ resolveRuntime: () => undefined }))).toEqual([
      "no controller route: listStores: GET /api/v1/listStores",
    ]);
  });

  it("fails on a contract-only operation that already has a route", () => {
    expect(ratchetViolations(input({ resolveRuntime: () => "write" }))).toEqual([
      "class mismatch: listStores is declared cheapRead but the runtime resolves write",
      "contract-only but routed: archiveStore (drop x-runtime-status; its class stays in classes/stores.rate-limit.yaml)",
    ]);
  });

  it("fails on a stale entry naming no cookieAuth operation of that contract", () => {
    const classFiles: RateLimitClassFile[] = [
      { path: "stores.rate-limit.yaml", classes: { listStores: "cheapRead", archiveStore: "write", gone: "write" } },
    ];
    expect(ratchetViolations(input({ classFiles }))).toEqual([
      "stale entry: gone in classes/stores.rate-limit.yaml is not a cookieAuth operation of that contract",
    ]);
  });

  it("fails on an entry filed under another contract's class file", () => {
    const classFiles: RateLimitClassFile[] = [
      { path: "stores.rate-limit.yaml", classes: { listStores: "cheapRead" } },
      { path: "tenants.rate-limit.yaml", classes: { archiveStore: "write" } },
    ];
    expect(ratchetViolations(input({ classFiles }))).toEqual([
      "stale entry: archiveStore in classes/tenants.rate-limit.yaml is not a cookieAuth operation of that contract",
      "unclassified cookieAuth operation: archiveStore (add it to classes/stores.rate-limit.yaml)",
    ]);
  });

  it("fails on an operation declared in two class files", () => {
    const classFiles: RateLimitClassFile[] = [
      { path: "stores.rate-limit.yaml", classes: { listStores: "cheapRead", archiveStore: "write" } },
      { path: "tenants.rate-limit.yaml", classes: { listStores: "cheapRead" } },
    ];
    expect(ratchetViolations(input({ classFiles }))).toContain(
      "duplicate entry: listStores in classes/stores.rate-limit.yaml and classes/tenants.rate-limit.yaml",
    );
  });

  it("fails on an unknown class", () => {
    const classFiles: RateLimitClassFile[] = [
      { path: "stores.rate-limit.yaml", classes: { listStores: "cheapRead", archiveStore: "veryExpensive" } },
    ];
    expect(ratchetViolations(input({ classFiles }))).toEqual([
      'unknown class "veryExpensive": archiveStore in classes/stores.rate-limit.yaml',
    ]);
  });
});
