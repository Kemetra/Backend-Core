/**
 * apps/api/test/console-telemetry/console-telemetry.contract.spec.ts
 *
 * RT-632 (OBS-3): the Console Sentry tunnel contract,
 * `console-telemetry.openapi.yaml` 1.0.0-draft. `[GATED]` contract, approved
 * on RT-632. Structural / load-only: no app boot and no HTTP. What this pins:
 *
 *   1. One `POST` at a path without "sentry" in it, with a unique operationId.
 *   2. Auth: `security: []` plus a required `Origin` header (the RT-430 rule).
 *   3. The envelope body types and the 64 KiB cap.
 *   4. The closed response set, with error bodies on the canonical envelope.
 *   5. The not-an-open-relay, scrub and default-inert rules in prose.
 */
import "reflect-metadata";

import { loadOpenApiContracts } from "../../src/openapi/loader";

const CONTRACT_ID = "console-telemetry.openapi";
const PATH = "/api/v1/console/telemetry/envelope";
const OPERATION_ID = "consoleForwardTelemetryEnvelope";
const MAX_BYTES = 65536;

interface ParameterObject {
  in?: string;
  name?: string;
  required?: boolean;
}

interface ResponseObject {
  description?: string;
  headers?: Record<string, unknown>;
  content?: Record<string, { schema?: { $ref?: string } }>;
}

interface OperationObject {
  operationId?: string;
  security?: Array<Record<string, unknown>>;
  parameters?: ParameterObject[];
  requestBody?: { required?: boolean; content?: Record<string, { schema?: { $ref?: string } }> };
  responses?: Record<string, ResponseObject>;
  "x-runtime-status"?: string;
  "x-runtime-note"?: string;
}

interface OpenApiDocument {
  openapi?: string;
  info?: { version?: string; description?: string };
  paths?: Record<string, Record<string, OperationObject>>;
  components?: { schemas?: Record<string, Record<string, unknown>> };
}

let doc: OpenApiDocument;
let otherOperationIds: Set<string>;

beforeAll(() => {
  const contracts = loadOpenApiContracts();
  const found = contracts.find((c) => c.id === CONTRACT_ID);
  if (!found) throw new Error(`${CONTRACT_ID} not found in packages/contracts/openapi/`);
  doc = found.document as OpenApiDocument;
  otherOperationIds = new Set<string>();
  for (const c of contracts) {
    if (c.id === CONTRACT_ID) continue;
    for (const item of Object.values((c.document as OpenApiDocument).paths ?? {})) {
      for (const o of Object.values(item)) {
        if (typeof o?.operationId === "string") otherOperationIds.add(o.operationId);
      }
    }
  }
});

function op(): OperationObject {
  const found = doc.paths?.[PATH]?.["post"];
  if (!found) throw new Error(`POST ${PATH} not declared`);
  return found;
}

function flat(text: string | undefined): string {
  return (text ?? "").replace(/\s+/g, " ");
}

describe("console-telemetry.openapi — RT-632 Console Sentry tunnel", () => {
  it("declares one POST, unique operationId, and keeps 'sentry' out of the path", () => {
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info?.version).toBe("1.0.0-draft");
    expect(Object.keys(doc.paths ?? {})).toEqual([PATH]);
    expect(Object.keys(doc.paths?.[PATH] ?? {})).toEqual(["post"]);
    expect(op().operationId).toBe(OPERATION_ID);
    expect(otherOperationIds.has(OPERATION_ID)).toBe(false);
    expect(PATH.toLowerCase()).not.toContain("sentry");
  });

  it("is unauthenticated and requires an Origin header", () => {
    expect(op().security).toEqual([]);
    const origin = (op().parameters ?? []).find((p) => p.in === "header" && p.name === "Origin");
    expect(origin?.required).toBe(true);
  });

  it("takes a raw envelope body capped at 64 KiB", () => {
    const body = op().requestBody;
    expect(body?.required).toBe(true);
    expect(Object.keys(body?.content ?? {}).sort()).toEqual([
      "application/octet-stream",
      "application/x-sentry-envelope",
      "text/plain",
    ]);
    for (const media of Object.values(body?.content ?? {})) {
      expect(media.schema?.$ref).toBe("#/components/schemas/Envelope");
    }
    expect(doc.components?.schemas?.["Envelope"]).toMatchObject({ type: "string", maxLength: MAX_BYTES });
  });

  it("has the closed response set; every error uses the canonical envelope", () => {
    const responses = op().responses ?? {};
    expect(Object.keys(responses).sort()).toEqual(["204", "400", "403", "413", "415", "429"]);
    expect(responses["204"]?.content).toBeUndefined();
    for (const status of ["400", "403", "413", "415", "429"]) {
      expect(responses[status]?.content?.["application/json"]?.schema?.$ref).toBe("#/components/schemas/Error");
    }
    expect(responses["429"]?.headers?.["Retry-After"]).toBeDefined();
    expect(flat(responses["400"]?.description)).toContain("envelope_malformed");
    expect(flat(responses["403"]?.description)).toContain("origin_rejected");
    expect(flat(responses["413"]?.description)).toContain("envelope_too_large");
    expect(flat(responses["415"]?.description)).toContain("unsupported_media_type");
    expect(flat(responses["429"]?.description)).toContain("RATE_LIMITED");
  });

  it("records the relay, scrub, inert and auth rules", () => {
    const text = flat(doc.info?.description);
    expect(text).toContain("CONSOLE_SENTRY_DSN");
    expect(text).toContain("`dsn` in the envelope header is ignored");
    expect(text).toContain("packages/shared/src/observability/sentry.ts");
    expect(text).toContain("Default-inert");
    expect(text).toContain("`security: []`");
    expect(text).toContain("never logs envelope content");
  });

  it("is implemented: no contract-only marker since the RT-632 runtime", () => {
    expect(op()["x-runtime-status"]).toBeUndefined();
    expect(op()["x-runtime-note"]).toBeUndefined();
  });
});
