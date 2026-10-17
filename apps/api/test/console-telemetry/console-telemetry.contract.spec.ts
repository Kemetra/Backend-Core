/**
 * apps/api/test/console-telemetry/console-telemetry.contract.spec.ts
 *
 * RT-632 (OBS-3): the Console Sentry tunnel contract,
 * `console-telemetry.openapi.yaml` 1.0.0-draft. `[GATED]` contract, approved
 * on RT-632. Structural / load-only: no app boot and no HTTP. operationId
 * uniqueness across contracts is pinned by `runtime-route-conformance.spec.ts`.
 * What this pins:
 *
 *   1. The tunnel `POST` and the config `GET`, on paths without "sentry".
 *   2. Auth: `security: []`; the tunnel also requires an `Origin` header.
 *   3. The envelope body types and the 64 KiB cap.
 *   4. The closed response sets, with error bodies on the canonical envelope.
 *   5. The config never carries a DSN; 204 when inert; `no-store`.
 *   6. The not-an-open-relay, scrub, server-stamp and inert rules in prose.
 */
import "reflect-metadata";

import { loadOpenApiContracts } from "../../src/openapi/loader";

const PATH = "/api/v1/console/telemetry/envelope";
const CONFIG_PATH = "/api/v1/console/telemetry/config";
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
  parameters?: Array<{ in: string; name: string; required?: boolean }>;
  requestBody?: { required: boolean; content: MediaMap };
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
let config: OperationObject;

beforeAll(() => {
  const found = loadOpenApiContracts().find((c) => c.id === "console-telemetry.openapi");
  if (!found) throw new Error("console-telemetry.openapi not found in packages/contracts/openapi/");
  doc = found.document as Contract;
  op = doc.paths[PATH]!["post"]!;
  config = doc.paths[CONFIG_PATH]!["get"]!;
});

function flat(text: string): string {
  return text.replace(/\s+/g, " ");
}

describe("console-telemetry.openapi — RT-632 Console Sentry tunnel", () => {
  it("declares the tunnel POST and the config GET, keeping 'sentry' out of the paths", () => {
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info.version).toBe("1.0.0-draft");
    expect(Object.keys(doc.paths).sort()).toEqual([CONFIG_PATH, PATH]);
    expect(Object.keys(doc.paths[PATH]!)).toEqual(["post"]);
    expect(Object.keys(doc.paths[CONFIG_PATH]!)).toEqual(["get"]);
    expect(op.operationId).toBe("consoleForwardTelemetryEnvelope");
    expect(config.operationId).toBe("consoleGetTelemetryConfig");
    expect(`${PATH} ${CONFIG_PATH}`.toLowerCase()).not.toContain("sentry");
  });

  it("is unauthenticated and requires an Origin header", () => {
    expect(op.security).toEqual([]);
    expect(op.parameters).toContainEqual(expect.objectContaining({ in: "header", name: "Origin", required: true }));
  });

  it("takes a raw envelope body capped at 64 KiB", () => {
    const body = op.requestBody!;
    expect(body.required).toBe(true);
    expect(Object.keys(body.content).sort()).toEqual([
      "application/octet-stream",
      "application/x-sentry-envelope",
      "text/plain",
    ]);
    const refs = Object.values(body.content).map((media) => media.schema.$ref);
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

  it("config: public, no-store, 200 with tunnel + environment or 204 when inert", () => {
    expect(config.security).toEqual([]);
    expect(Object.keys(config.responses).sort()).toEqual(["200", "204"]);
    for (const status of ["200", "204"]) {
      expect(config.responses[status]!.headers).toHaveProperty("Cache-Control");
    }
    expect(config.responses["204"]!.content).toBeUndefined();
    expect(config.responses["200"]!.content!["application/json"]!.schema.$ref).toBe(
      "#/components/schemas/ConsoleTelemetryConfig",
    );
  });

  it("config schema is strict, pins the tunnel path and never carries a DSN", () => {
    const schema = doc.components.schemas["ConsoleTelemetryConfig"] as {
      additionalProperties: boolean;
      required: string[];
      properties: Record<string, Record<string, unknown>>;
    };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required.sort()).toEqual(["environment", "tunnel"]);
    expect(Object.keys(schema.properties).sort()).toEqual(["environment", "tunnel"]);
    expect(schema.properties["tunnel"]).toMatchObject({ const: PATH });
  });

  it("records the relay, scrub, inert and auth rules", () => {
    const text = flat(doc.info.description);
    expect(text).toContain("CONSOLE_SENTRY_DSN");
    expect(text).toContain("`dsn` in the envelope header is ignored");
    expect(text).toContain("packages/shared/src/observability/sentry.ts");
    expect(text).toContain("Default-inert");
    expect(text).toContain("`security: []`");
    expect(text).toContain("never logs envelope content");
    expect(text).toContain('infer_ip: "never"');
    expect(text).toContain("It never returns a DSN");
  });

  it.each(["post", "get"])("keeps the %s operation contract-only until the RT-632 runtime ships", (method) => {
    const operation = method === "post" ? op : config;
    expect(operation["x-runtime-status"]).toBe("contract-only");
    expect(operation["x-runtime-note"]!.trim().length).toBeGreaterThan(0);
  });
});
