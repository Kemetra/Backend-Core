/**
 * apps/api/test/console-telemetry/console-telemetry.contract.spec.ts
 *
 * RT-632 (OBS-3): the Console Sentry tunnel contract,
 * `console-telemetry.openapi.yaml` 1.0.0-draft. `[GATED]` contract, approved
 * on RT-632. Structural / load-only: no app boot and no HTTP. operationId
 * uniqueness across contracts is pinned by `runtime-route-conformance.spec.ts`.
 * What this pins:
 *
 *   1. One `POST` at a path without "sentry" in it.
 *   2. Auth: `security: []` plus a required `Origin` header (the RT-430 rule).
 *   3. The envelope body types and the 64 KiB cap.
 *   4. The closed response set, with error bodies on the canonical envelope.
 *   5. The not-an-open-relay, scrub and default-inert rules in prose.
 */
import "reflect-metadata";

import { loadOpenApiContracts } from "../../src/openapi/loader";

const PATH = "/api/v1/console/telemetry/envelope";
const MAX_BYTES = 65536;
const ERROR_REF = "#/components/schemas/Error";
const ERROR_CODES: Record<string, string> = {
  "400": "envelope_malformed",
  "403": "origin_rejected",
  "413": "envelope_too_large",
  "415": "unsupported_media_type",
  "429": "RATE_LIMITED",
};

type MediaMap = Record<string, { schema: { $ref?: string } }>;

interface ResponseObject {
  description: string;
  headers?: Record<string, unknown>;
  content?: MediaMap;
}

interface OperationObject {
  operationId: string;
  security: unknown[];
  parameters: Array<{ in: string; name: string; required?: boolean }>;
  requestBody: { required: boolean; content: MediaMap };
  responses: Record<string, ResponseObject>;
  "x-runtime-status"?: string;
  "x-runtime-note"?: string;
}

interface Contract {
  openapi: string;
  info: { version: string; description: string };
  paths: Record<string, Record<string, OperationObject>>;
  components: { schemas: Record<string, Record<string, unknown>> };
}

let doc: Contract;
let op: OperationObject;

beforeAll(() => {
  const found = loadOpenApiContracts().find((c) => c.id === "console-telemetry.openapi");
  if (!found) throw new Error("console-telemetry.openapi not found in packages/contracts/openapi/");
  doc = found.document as Contract;
  op = doc.paths[PATH]!["post"]!;
});

function flat(text: string): string {
  return text.replace(/\s+/g, " ");
}

describe("console-telemetry.openapi — RT-632 Console Sentry tunnel", () => {
  it("declares one POST and keeps 'sentry' out of the path", () => {
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info.version).toBe("1.0.0-draft");
    expect(Object.keys(doc.paths)).toEqual([PATH]);
    expect(Object.keys(doc.paths[PATH]!)).toEqual(["post"]);
    expect(op.operationId).toBe("consoleForwardTelemetryEnvelope");
    expect(PATH.toLowerCase()).not.toContain("sentry");
  });

  it("is unauthenticated and requires an Origin header", () => {
    expect(op.security).toEqual([]);
    expect(op.parameters).toContainEqual(expect.objectContaining({ in: "header", name: "Origin", required: true }));
  });

  it("takes a raw envelope body capped at 64 KiB", () => {
    expect(op.requestBody.required).toBe(true);
    expect(Object.keys(op.requestBody.content).sort()).toEqual([
      "application/octet-stream",
      "application/x-sentry-envelope",
      "text/plain",
    ]);
    const refs = Object.values(op.requestBody.content).map((media) => media.schema.$ref);
    expect(new Set(refs)).toEqual(new Set(["#/components/schemas/Envelope"]));
    expect(doc.components.schemas["Envelope"]).toMatchObject({ type: "string", maxLength: MAX_BYTES });
  });

  it("answers an empty 204 on success", () => {
    expect(Object.keys(op.responses).sort()).toEqual(["204", ...Object.keys(ERROR_CODES)].sort());
    expect(op.responses["204"]!.content).toBeUndefined();
  });

  it.each(Object.entries(ERROR_CODES))("documents %s %s on the canonical error envelope", (status, code) => {
    const response = op.responses[status]!;
    expect(response.content!["application/json"]!.schema.$ref).toBe(ERROR_REF);
    expect(flat(response.description)).toContain(code);
  });

  it("sends Retry-After with a 429", () => {
    expect(op.responses["429"]!.headers).toHaveProperty("Retry-After");
  });

  it("records the relay, scrub, inert and auth rules", () => {
    const text = flat(doc.info.description);
    expect(text).toContain("CONSOLE_SENTRY_DSN");
    expect(text).toContain("`dsn` in the envelope header is ignored");
    expect(text).toContain("packages/shared/src/observability/sentry.ts");
    expect(text).toContain("Default-inert");
    expect(text).toContain("`security: []`");
    expect(text).toContain("never logs envelope content");
  });

  it("stays contract-only until the RT-632 runtime ships", () => {
    expect(op["x-runtime-status"]).toBe("contract-only");
    expect(op["x-runtime-note"]!.trim().length).toBeGreaterThan(0);
  });
});
