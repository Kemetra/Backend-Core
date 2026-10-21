/**
 * RT-639 — the rotate-soon hint headers are documented on every route that
 * sends them, and only there.
 *
 * The routes are the ones `PosDeviceAuthGuard` authenticates (directly or
 * through a reviewed composite). `posRotateTerminalToken` has its own guard and
 * its 200 carries `rotate_after` in the body, so it must not document them.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { load as parseYaml } from "js-yaml";

import { ROTATE_AFTER_HEADER, ROTATE_STAGE_HEADER } from "../../src/pos-terminal-pairing/rotation-hint";

const OPENAPI_DIR = resolve(__dirname, "..", "..", "..", "..", "packages", "contracts", "openapi");

/** contract file → the operations that send the hint. */
const HINTED_OPERATIONS: Readonly<Record<string, readonly string[]>> = {
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

interface Operation {
  operationId?: string;
  responses?: Record<string, { headers?: Record<string, { $ref?: string }> }>;
}
interface Doc {
  paths: Record<string, Record<string, Operation>>;
  components?: { headers?: Record<string, { required?: boolean; schema?: Record<string, unknown> }> };
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

/**
 * Every response the guard's headers can ride: the 2xx, and the 304 of a
 * conditional GET (the guard sets them before the controller turns the answer
 * into a 304: `posGetCashVariancePolicy`).
 */
const successResponses = (op: Operation) =>
  Object.entries(op.responses ?? {}).filter(([status]) => status.startsWith("2") || status === "304");

describe("rotate-soon hint headers in the contracts (RT-639)", () => {
  describe.each(Object.entries(HINTED_OPERATIONS))("%s", (file, operationIds) => {
    const doc = load(file);

    it("defines both headers as optional, with the stage a closed set", () => {
      const headers = doc.components?.headers ?? {};
      expect(headers["DeviceTokenRotateAfter"]).toMatchObject({
        required: false,
        schema: { type: "string", format: "date-time" },
      });
      expect(headers["DeviceTokenRotateStage"]).toMatchObject({
        required: false,
        schema: { type: "string", enum: ["notice", "warning", "urgent"] },
      });
    });

    it.each(operationIds)("%s documents both headers on every 2xx and 304 response", (operationId) => {
      const responses = successResponses(operation(doc, operationId));
      expect(responses.length).toBeGreaterThan(0);
      for (const [, response] of responses) {
        expect(response.headers?.[ROTATE_AFTER_HEADER]).toEqual({
          $ref: "#/components/headers/DeviceTokenRotateAfter",
        });
        expect(response.headers?.[ROTATE_STAGE_HEADER]).toEqual({
          $ref: "#/components/headers/DeviceTokenRotateStage",
        });
      }
    });
  });

  it("posRotateTerminalToken does not document them (its 200 carries rotate_after in the body)", () => {
    const op = operation(load("pos-terminal-pairing.openapi.yaml"), "posRotateTerminalToken");
    for (const [, response] of successResponses(op)) {
      expect(response.headers?.[ROTATE_AFTER_HEADER]).toBeUndefined();
      expect(response.headers?.[ROTATE_STAGE_HEADER]).toBeUndefined();
    }
  });

  it("the pairing contract describes the hint (stages and the routes that send it)", () => {
    const text = readFileSync(resolve(OPENAPI_DIR, "pos-terminal-pairing.openapi.yaml"), "utf8");
    expect(text).toContain(ROTATE_AFTER_HEADER);
    expect(text).toContain(ROTATE_STAGE_HEADER);
    expect(text).not.toContain("deferred to RT-370");
  });

  it("the pairing contract says they ride every response after a successful authentication, errors included", () => {
    const text = readFileSync(resolve(OPENAPI_DIR, "pos-terminal-pairing.openapi.yaml"), "utf8");
    // The per-operation responses are shared `$ref` components that also serve the 401 and routes
    // that send no hint, so the rule is stated once here instead of on every error response.
    expect(text).toContain("every response of that request");
    expect(text).toContain("never depends on one being absent");
  });

  it("the pairing contract says a previous-token request is treated as expiring when the overlap closes", () => {
    const text = readFileSync(resolve(OPENAPI_DIR, "pos-terminal-pairing.openapi.yaml"), "utf8");
    expect(text).toContain("presents the previous token");
    expect(text).toContain("when the overlap closes");
  });
});

describe("the conditional-GET 304 (RT-639)", () => {
  it("posGetCashVariancePolicy has a 304, and it is covered by the check above", () => {
    const op = operation(load("cash-variance-policy.openapi.yaml"), "posGetCashVariancePolicy");
    expect(successResponses(op).map(([status]) => status)).toEqual(["200", "304"]);
  });
});
