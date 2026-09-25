/**
 * apps/api/test/connector-health/contract/connector-health.contract.spec.ts
 *
 * Slice 020-FND (T009) — OpenAPI conformance test for
 * `packages/contracts/openapi/erpnext-connector/connector-health.yaml`.
 *
 * Mirrors `stock-view.contract.spec.ts` (019): loads the contract via the
 * production `loadOpenApiContracts` helper with an explicit `dir` (the helper's
 * scan is non-recursive — the nested `erpnext-connector/` sub-dir is not picked
 * up by the umbrella call). Asserts presence + global uniqueness of the three
 * 020 operationIds, the two security schemes (machine `connectorBearer` for the
 * heartbeat, human `cookieAuth` for the reads), the ConnectorHealthView /
 * HeartbeatAck projections, the strict heartbeat body (no identity field), and
 * the non-disclosing canonical Error envelope.
 *
 * Structural / load-only (no app boot, no HTTP, no Docker).
 */
import "reflect-metadata";

import { resolve } from "node:path";

import { loadOpenApiContracts } from "../../../src/openapi/loader";

const NEW_CONTRACT_ID = "connector-health";

const OPERATION_IDS = [
  "connectorReportHeartbeat",
  "listConnectorHealth",
  "getConnectorHealth",
] as const;

const HEARTBEAT_PATH = "/api/connector/v1/erpnext/health/heartbeat";
const LIST_PATH = "/api/v1/connector/health";
const DETAIL_PATH = "/api/v1/connector/health/{registrationId}";

function openapiSubDir(sub: string): string {
  return resolve(
    __dirname,
    "..",
    "..",
    "..",
    "..",
    "..",
    "packages",
    "contracts",
    "openapi",
    sub,
  );
}

interface OperationObject {
  operationId?: string;
  security?: Array<Record<string, unknown>>;
  requestBody?: unknown;
  parameters?: Array<{ $ref?: string; in?: string; name?: string }>;
  responses?: Record<string, unknown>;
}

type PathItem = Record<string, OperationObject>;

interface SchemaObject {
  type?: string | string[];
  additionalProperties?: boolean | Record<string, unknown>;
  required?: string[];
  properties?: Record<string, unknown>;
}

interface OpenApiDocument {
  openapi?: string;
  info?: { title?: string; version?: string };
  paths?: Record<string, PathItem>;
  components?: {
    schemas?: Record<string, SchemaObject>;
    securitySchemes?: Record<string, Record<string, unknown>>;
    responses?: Record<string, Record<string, unknown>>;
  };
}

let doc: OpenApiDocument;
let shippedOperationIds: Set<string>;

function collectOperationIds(docs: OpenApiDocument[], into: Set<string>): void {
  for (const d of docs) {
    if (!d.paths) continue;
    for (const path of Object.values(d.paths)) {
      for (const op of Object.values(path)) {
        if (op && typeof op.operationId === "string") into.add(op.operationId);
      }
    }
  }
}

beforeAll(() => {
  const connectorContracts = loadOpenApiContracts({
    dir: openapiSubDir("erpnext-connector"),
  });
  const newContract = connectorContracts.find((c) => c.id === NEW_CONTRACT_ID);
  if (!newContract) {
    const ids = connectorContracts.map((c) => c.id).join(", ");
    throw new Error(
      `${NEW_CONTRACT_ID} contract not found under ${openapiSubDir("erpnext-connector")}; loaded ids: [${ids}]`,
    );
  }
  doc = newContract.document as OpenApiDocument;

  shippedOperationIds = new Set<string>();
  collectOperationIds(
    loadOpenApiContracts().map((c) => c.document as OpenApiDocument),
    shippedOperationIds,
  );
  for (const sub of [
    "catalog",
    "pos-sales",
    "inventory",
    "pos-payments",
    "connector",
    "erpnext-reconciliation",
  ]) {
    collectOperationIds(
      loadOpenApiContracts({ dir: openapiSubDir(sub) }).map(
        (c) => c.document as OpenApiDocument,
      ),
      shippedOperationIds,
    );
  }
  for (const c of connectorContracts) {
    if (c.id === NEW_CONTRACT_ID) continue;
    collectOperationIds([c.document as OpenApiDocument], shippedOperationIds);
  }
});

function operations(): Array<{ path: string; method: string; op: OperationObject }> {
  const out: Array<{ path: string; method: string; op: OperationObject }> = [];
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    for (const [method, op] of Object.entries(item)) {
      out.push({ path, method, op });
    }
  }
  return out;
}

function findOp(operationId: string): OperationObject | undefined {
  return operations().find((o) => o.op.operationId === operationId)?.op;
}

function schemaProps(name: string): Record<string, unknown> {
  const schemas = doc.components!.schemas!;
  return schemas[name]!.properties!;
}

describe("connector-health.yaml — loadability + conventions", () => {
  it("is parseable by the production OpenAPI loader", () => {
    expect(doc).toBeDefined();
    expect(typeof doc).toBe("object");
  });

  it("declares OpenAPI 3.1 of record + a *-draft version", () => {
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info?.version).toEqual(expect.stringMatching(/-draft$/));
  });

  it("declares BOTH the connectorBearer (machine) and cookieAuth (human) schemes; NOT clerkJwt", () => {
    const schemes = doc.components?.securitySchemes ?? {};
    expect(schemes["connectorBearer"]).toBeDefined();
    expect(schemes["cookieAuth"]).toBeDefined();
    expect(schemes["clerkJwt"]).toBeUndefined();
    const cb = schemes["connectorBearer"] as { type?: string; scheme?: string };
    expect(cb.type).toBe("http");
    expect(cb.scheme).toBe("bearer");
    const ck = schemes["cookieAuth"] as { type?: string; in?: string };
    expect(ck.type).toBe("apiKey");
    expect(ck.in).toBe("cookie");
  });
});

describe("connector-health.yaml — operations", () => {
  it("declares exactly the three 020 operationIds", () => {
    const ids = operations()
      .map((o) => o.op.operationId)
      .filter((id): id is string => typeof id === "string")
      .sort();
    expect(ids).toEqual([...OPERATION_IDS].sort());
  });

  it("maps heartbeat=POST(connectorBearer), list=GET(cookieAuth), detail=GET(cookieAuth)", () => {
    expect(doc.paths?.[HEARTBEAT_PATH]?.["post"]?.operationId).toBe("connectorReportHeartbeat");
    expect(doc.paths?.[HEARTBEAT_PATH]?.["post"]?.security).toContainEqual({ connectorBearer: [] });
    expect(doc.paths?.[LIST_PATH]?.["get"]?.operationId).toBe("listConnectorHealth");
    expect(doc.paths?.[LIST_PATH]?.["get"]?.security).toContainEqual({ cookieAuth: [] });
    expect(doc.paths?.[DETAIL_PATH]?.["get"]?.operationId).toBe("getConnectorHealth");
    expect(doc.paths?.[DETAIL_PATH]?.["get"]?.security).toContainEqual({ cookieAuth: [] });
  });

  it("the operator reads use cookieAuth, NEVER connectorBearer (session-only)", () => {
    expect(doc.paths?.[LIST_PATH]?.["get"]?.security).not.toContainEqual({ connectorBearer: [] });
    expect(doc.paths?.[DETAIL_PATH]?.["get"]?.security).not.toContainEqual({ connectorBearer: [] });
  });

  it("does NOT collide with or rename any shipped operationId", () => {
    for (const id of OPERATION_IDS) {
      expect(shippedOperationIds.has(id)).toBe(false);
    }
  });

  it("only the heartbeat carries a write request body", () => {
    expect(findOp("connectorReportHeartbeat")).toHaveProperty("requestBody");
    expect(findOp("listConnectorHealth")).not.toHaveProperty("requestBody");
    expect(findOp("getConnectorHealth")).not.toHaveProperty("requestBody");
  });
});

describe("connector-health.yaml — heartbeat body is strict + identity-free (§XII)", () => {
  it("HeartbeatReport is strict (additionalProperties:false) and carries ONLY self-reported fields", () => {
    const report = doc.components?.schemas?.["HeartbeatReport"];
    expect(report?.additionalProperties).toBe(false);
    const props = report?.properties ?? {};
    expect(props).toHaveProperty("connectorVersion");
    expect(props).toHaveProperty("backlogIndicator");
    expect(props).toHaveProperty("erpnextReachable");
    expect(props).toHaveProperty("sourceClockAt");
    // No identity / server-owned field may be body-supplied.
    for (const leak of [
      "tenant_id", "tenantId", "registration_id", "registrationId",
      "connector_registration_id", "connectorId", "last_seen_at", "lastSeenAt",
    ]) {
      expect(props).not.toHaveProperty(leak);
    }
  });

  it("bounds the heartbeat backlogIndicator to a non-negative int4", () => {
    const field = schemaProps("HeartbeatReport")["backlogIndicator"] as {
      type: string;
      minimum: number;
      maximum: number;
    };
    expect(field.type).toBe("integer");
    expect(field.minimum).toBe(0);
    expect(field.maximum).toBe(2147483647);
  });

  it("bounds the health-view backlogIndicator to a non-negative int4", () => {
    const field = schemaProps("ConnectorHealthView")["backlogIndicator"] as {
      minimum: number;
      maximum: number;
    };
    expect(field.minimum).toBe(0);
    expect(field.maximum).toBe(2147483647);
  });

  it("HeartbeatAck is minimal — server-clock acknowledgedAt only, no secret/identity echo", () => {
    const ack = doc.components?.schemas?.["HeartbeatAck"];
    expect(ack?.additionalProperties).toBe(false);
    expect(ack?.required).toContain("acknowledgedAt");
    expect(Object.keys(ack?.properties ?? {})).toEqual(["acknowledgedAt"]);
  });
});

describe("connector-health.yaml — ConnectorHealthView projection (§IV)", () => {
  it("carries identity + verdict + last-seen + lag, NO secret / health-row id / tenant_id", () => {
    const view = doc.components?.schemas?.["ConnectorHealthView"];
    expect(view?.additionalProperties).toBe(false);
    expect(view?.required).toEqual(
      expect.arrayContaining([
        "connectorId", "displayName", "environment", "erpnextSiteRef",
        "lastSeenAt", "liveness", "secondsSinceLastSeen",
      ]),
    );
    const props = view?.properties ?? {};
    for (const leak of [
      "id", "tenant_id", "tenantId", "secret", "token", "token_hash", "tokenHash",
    ]) {
      expect(props).not.toHaveProperty(leak);
    }
  });

  it("the liveness enum is the closed four-verdict set", () => {
    const view = doc.components?.schemas?.["ConnectorHealthView"];
    const liveness = (view?.properties ?? {})["liveness"] as { enum?: string[] };
    expect(liveness?.enum?.sort()).toEqual(
      ["disabled", "healthy", "never_seen", "stale"].sort(),
    );
  });
});

describe("connector-health.yaml — non-disclosure + error envelope", () => {
  it("detail declares 401 + 404; the canonical Error envelope has NO details field", () => {
    const responses = findOp("getConnectorHealth")?.responses ?? {};
    expect(Object.keys(responses)).toEqual(expect.arrayContaining(["401", "404"]));
    const errorSchema = doc.components?.schemas?.["Error"] as
      | { required?: string[]; properties?: { error?: { properties?: Record<string, unknown> } } }
      | undefined;
    expect(errorSchema?.required).toContain("error");
    const inner = errorSchema?.properties?.error?.properties ?? {};
    expect(Object.keys(inner).sort()).toEqual(["code", "message", "request_id"].sort());
    expect(inner).not.toHaveProperty("details");
  });

  it("declares the closed error-response set", () => {
    const responses = doc.components?.responses ?? {};
    for (const name of ["ValidationFailure", "Unauthorized", "NotFound", "SystemFailure"]) {
      expect(responses[name]).toBeDefined();
    }
  });

  it("NO money / valuation field appears in any schema (§XIV)", () => {
    const schemas = doc.components?.schemas ?? {};
    const banned = /(cost|price|valuation|amount|currency|total|money)/i;
    for (const [name, schema] of Object.entries(schemas)) {
      for (const prop of Object.keys(schema.properties ?? {})) {
        expect(`${name}.${prop}`).not.toMatch(banned);
      }
    }
  });
});
