/**
 * RT-805 — negative tests for the runtime-route conformance rules. The
 * contract-only set is derived from the `x-runtime-status` markers (no
 * hand-kept list), so these pin every way the sweep must still fail.
 */
import { conformanceViolations } from "../_helpers/openapi-conformance";
import type { ContractRoute, Operation } from "../_helpers/openapi-routes";

const op = (path: string, method: string, operation: Operation): ContractRoute => ({
  file: "things.openapi.yaml",
  path,
  method,
  operation,
  security: [],
});

const contractOnly = (operationId: string, note = "RT-1: the runtime ships later."): Operation => ({
  operationId,
  "x-runtime-status": "contract-only",
  "x-runtime-note": note,
});

describe("runtime-route conformance rules (RT-805)", () => {
  const routed = new Set(["GET /api/v1/things", "POST /api/v1/things/{param}"]);

  it("passes when every production operation is routed and every contract-only one is not", () => {
    expect(
      conformanceViolations(
        [
          op("/api/v1/things", "get", { operationId: "listThings" }),
          op("/api/v1/things/{id}", "post", { operationId: "touchThing" }),
          op("/api/v1/widgets", "get", contractOnly("listWidgets")),
        ],
        routed,
      ),
    ).toEqual([]);
  });

  it("fails on a production operation with no registered route", () => {
    expect(conformanceViolations([op("/api/v1/gone", "get", { operationId: "getGone" })], routed)).toEqual([
      "no registered route: getGone: GET /api/v1/gone",
    ]);
  });

  it("fails on a contract-only operation that already has a route (stale marker)", () => {
    expect(conformanceViolations([op("/api/v1/things", "get", contractOnly("listThings"))], routed)).toEqual([
      "contract-only but routed, drop the marker: listThings: GET /api/v1/things",
    ]);
  });

  it("fails on a contract-only operation without a runtime note", () => {
    expect(conformanceViolations([op("/api/v1/widgets", "get", contractOnly("listWidgets", "  "))], routed)).toEqual([
      "contract-only without x-runtime-note: listWidgets",
    ]);
  });

  it("fails on an x-runtime-status other than contract-only", () => {
    expect(
      conformanceViolations(
        [op("/api/v1/things", "get", { operationId: "listThings", "x-runtime-status": "shipped" })],
        routed,
      ),
    ).toEqual(['unknown x-runtime-status "shipped": listThings']);
  });

  it("fails on a duplicated operationId", () => {
    expect(
      conformanceViolations(
        [
          op("/api/v1/things", "get", { operationId: "listThings" }),
          op("/api/v1/widgets", "get", contractOnly("listThings")),
        ],
        routed,
      ),
    ).toEqual(["duplicate operationId: listThings"]);
  });
});
