/**
 * apps/api/test/catalog/erpnext-sync-ops/erpnext-sync-ops.contract-spec.ts
 *
 * Slice 025-CONTRACT (T003/T008/T016/T022) — OpenAPI conformance test for
 * `packages/contracts/openapi/erpnext-sync-ops/console-sync-ops.yaml`.
 *
 * Mirrors `erpnext-reconciliation/reconciliation.contract.spec.ts` (017):
 *   - loads via the production `loadOpenApiContracts` with an explicit `dir`
 *     (non-recursive loader; the new top-level `erpnext-sync-ops/` dir loads
 *     explicitly, R9 — else a false GREEN);
 *   - asserts the THREE 025 operationIds are present + UNIQUE against every
 *     shipped operationId (top-level + every nested sub-dir);
 *   - pins the slice's conventions: the HUMAN dashboard `cookieAuth` scheme at the
 *     document level — NOT `connectorBearer` (012/015 machine), NOT `clerkJwt`
 *     (POS device) (FR-007); all three ops are GET (read-only — no write/repair);
 *     strict wire schemas (§IV `additionalProperties: false`); the canonical Error
 *     envelope; the `DomainSummary.status` enum INCLUDING `not_available` in the
 *     WIRE shape (the 020/021 forward-compat stub, FR-004); and NO money /
 *     valuation field anywhere (the 015/017 source tables carry none).
 *
 * Structural / load-only (no app boot, no HTTP).
 */
import "reflect-metadata";

import { resolve } from "node:path";

import { loadOpenApiContracts } from "../../../src/openapi/loader";

const NEW_CONTRACT_ID = "console-sync-ops";
const NEW_SUBDIR = "erpnext-sync-ops";

const OPERATION_IDS = [
  "consoleGetSyncOpsSummary",
  "consoleListPostingBacklog",
  "consoleListReconciliationRuns",
] as const;

const SUMMARY_PATH = "/api/v1/catalog/erpnext-sync-ops/summary";
const BACKLOG_PATH = "/api/v1/catalog/erpnext-sync-ops/posting-backlog";
const RUNS_PATH = "/api/v1/catalog/erpnext-sync-ops/reconciliation-runs";

function openapiSubDir(sub: string): string {
  // contract-spec → erpnext-sync-ops → catalog → test → api → apps → <root>
  return resolve(
    __dirname, "..", "..", "..", "..", "..",
    "packages", "contracts", "openapi", sub,
  );
}

interface OperationObject {
  operationId?: string;
  parameters?: Array<{ $ref?: string; name?: string; in?: string; required?: boolean }>;
  requestBody?: unknown;
  responses?: Record<string, unknown>;
}
type PathItem = Record<string, OperationObject>;
interface SchemaObject {
  type?: string | string[];
  additionalProperties?: boolean | Record<string, unknown>;
  required?: string[];
  properties?: Record<string, { enum?: string[]; $ref?: string }>;
}
interface OpenApiDocument {
  openapi?: string;
  info?: { title?: string; version?: string };
  paths?: Record<string, PathItem>;
  components?: {
    schemas?: Record<string, SchemaObject>;
    securitySchemes?: Record<string, Record<string, unknown>>;
    parameters?: Record<string, { name?: string; in?: string; required?: boolean }>;
  };
  security?: Array<Record<string, unknown>>;
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
  const contracts = loadOpenApiContracts({ dir: openapiSubDir(NEW_SUBDIR) });
  const newContract = contracts.find((c) => c.id === NEW_CONTRACT_ID);
  if (!newContract) {
    const ids = contracts.map((c) => c.id).join(", ");
    throw new Error(
      `${NEW_CONTRACT_ID} contract not found under ${openapiSubDir(NEW_SUBDIR)}; loaded ids: [${ids}]`,
    );
  }
  doc = newContract.document as OpenApiDocument;

  // Global uniqueness guard: top-level + every nested sub-dir (loader is
  // non-recursive, so each must be loaded explicitly).
  shippedOperationIds = new Set<string>();
  collectOperationIds(
    loadOpenApiContracts().map((c) => c.document as OpenApiDocument),
    shippedOperationIds,
  );
  for (const sub of [
    "catalog",
    "pos-sales",
    "pos-payments",
    "inventory",
    "erpnext-connector",
    "erpnext-reconciliation",
    "connector",
  ]) {
    collectOperationIds(
      loadOpenApiContracts({ dir: openapiSubDir(sub) }).map((c) => c.document as OpenApiDocument),
      shippedOperationIds,
    );
  }
});

function operations(): Array<{ path: string; method: string; op: OperationObject }> {
  const out: Array<{ path: string; method: string; op: OperationObject }> = [];
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    for (const [method, op] of Object.entries(item)) out.push({ path, method, op });
  }
  return out;
}
function findOp(operationId: string): OperationObject | undefined {
  return operations().find((o) => o.op.operationId === operationId)?.op;
}
function schema(name: string): SchemaObject | undefined {
  return doc.components?.schemas?.[name];
}

// ===========================================================================
describe("erpnext-sync-ops/console-sync-ops.yaml — loadability", () => {
  it("is parseable by the production OpenAPI loader", () => {
    expect(doc).toBeDefined();
    expect(typeof doc).toBe("object");
  });
  it("declares OpenAPI 3.1 of record", () => {
    expect(doc.openapi).toBe("3.1.0");
  });
  it("declares an info block with title and a *-draft version", () => {
    expect(doc.info?.title).toEqual(expect.any(String));
    expect(doc.info?.version).toEqual(expect.stringMatching(/-draft$/));
  });
});

describe("console-sync-ops.yaml — operations (3 read-only GETs)", () => {
  it("declares exactly the three 025 operationIds", () => {
    const ids = operations()
      .map((o) => o.op.operationId)
      .filter((id): id is string => typeof id === "string")
      .sort();
    expect(ids).toEqual([...OPERATION_IDS].sort());
  });
  it("does NOT collide with or rename any shipped operationId", () => {
    for (const id of OPERATION_IDS) expect(shippedOperationIds.has(id)).toBe(false);
  });
  it("maps each op to its GET route under the erpnext-sync-ops namespace", () => {
    expect(doc.paths?.[SUMMARY_PATH]?.["get"]?.operationId).toBe("consoleGetSyncOpsSummary");
    expect(doc.paths?.[BACKLOG_PATH]?.["get"]?.operationId).toBe("consoleListPostingBacklog");
    expect(doc.paths?.[RUNS_PATH]?.["get"]?.operationId).toBe("consoleListReconciliationRuns");
  });
  it("is READ-ONLY — every operation is a GET, no POST/PUT/PATCH/DELETE, no requestBody", () => {
    for (const { method, op } of operations()) {
      expect(method).toBe("get");
      expect(op).not.toHaveProperty("requestBody");
    }
  });
  it("routes all ops under /api/v1/catalog/erpnext-sync-ops", () => {
    for (const { path } of operations()) {
      expect(path.startsWith("/api/v1/catalog/erpnext-sync-ops")).toBe(true);
    }
  });
});

describe("console-sync-ops.yaml — auth boundary (FR-007, human-only)", () => {
  it("defines the cookieAuth (httpOnly dp2_session) scheme", () => {
    const cookie = doc.components?.securitySchemes?.["cookieAuth"];
    expect(cookie?.["type"]).toBe("apiKey");
    expect(cookie?.["in"]).toBe("cookie");
    expect(cookie?.["name"]).toBe("dp2_session");
  });
  it("requires cookieAuth at the document level", () => {
    expect(doc.security).toEqual([{ cookieAuth: [] }]);
  });
  it("does NOT define connectorBearer (machine) or clerkJwt (POS device)", () => {
    expect(doc.components?.securitySchemes?.["connectorBearer"]).toBeUndefined();
    expect(doc.components?.securitySchemes?.["clerkJwt"]).toBeUndefined();
  });
});

describe("console-sync-ops.yaml — SyncOpsSummary + DomainSummary (US1, FR-004)", () => {
  it("SyncOpsSummary is strict and carries a domains array", () => {
    const s = schema("SyncOpsSummary");
    expect(s?.additionalProperties).toBe(false);
    expect(s?.properties).toHaveProperty("domains");
    expect(s?.required).toEqual(expect.arrayContaining(["domains"]));
  });
  it("DomainSummary.status enumerates ok | attention | not_available (the 020/021 forward-compat stub)", () => {
    const d = schema("DomainSummary");
    expect(d?.additionalProperties).toBe(false);
    const status = (d?.properties ?? {})["status"];
    expect(status?.enum?.sort()).toEqual(["attention", "not_available", "ok"].sort());
  });
  it("DomainSummary names the domain via a closed key set incl. connector_health + product_master", () => {
    const d = schema("DomainSummary");
    const domain = (d?.properties ?? {})["domain"];
    expect(domain?.enum?.sort()).toEqual(
      ["connector_health", "posting", "product_master", "reconciliation"].sort(),
    );
  });
});

describe("console-sync-ops.yaml — posting freshness (1.2.0-draft, RT-565 D1–D7)", () => {
  type Prop = { type?: string | string[]; format?: string; enum?: string[]; minimum?: number; $ref?: string };
  const prop = (schemaName: string, name: string): Prop | undefined =>
    (schema(schemaName)?.properties ?? {})[name] as Prop | undefined;

  it("bumps the contract to 1.2.0-draft (additive minor)", () => {
    expect(doc.info?.version).toBe("1.2.0-draft");
  });
  it("D1: extends the existing summary — no new operation, no new request parameter", () => {
    const summary = findOp("consoleGetSyncOpsSummary");
    expect(summary?.parameters).toEqual([{ $ref: "#/components/parameters/StoreIdQuery" }]);
    const ref = (
      summary?.responses?.["200"] as {
        content?: Record<string, { schema?: { $ref?: string } }>;
      }
    )?.content?.["application/json"]?.schema?.$ref;
    expect(ref).toBe("#/components/schemas/SyncOpsSummary");
  });
  it("D6: SyncOpsSummary requires a top-level date-time asOf and postingFreshness", () => {
    const s = schema("SyncOpsSummary");
    expect(s?.required?.slice().sort()).toEqual(["asOf", "domains", "postingFreshness"]);
    expect(prop("SyncOpsSummary", "asOf")).toMatchObject({ type: "string", format: "date-time" });
    expect(prop("SyncOpsSummary", "postingFreshness")?.$ref).toBe(
      "#/components/schemas/PostingFreshness",
    );
  });
  it("D2/D3: PostingFreshness is strict and requires every fact (nullable, never omitted)", () => {
    const f = schema("PostingFreshness");
    expect(f?.additionalProperties).toBe(false);
    expect(f?.required?.slice().sort()).toEqual(
      ["lastPosted", "oldestPendingAgeSeconds", "oldestPendingAt", "pendingCount"].sort(),
    );
    expect(Object.keys(f?.properties ?? {}).sort()).toEqual(
      ["lastPosted", "oldestPendingAgeSeconds", "oldestPendingAt", "pendingCount"].sort(),
    );
    expect(prop("PostingFreshness", "lastPosted")?.$ref).toBe("#/components/schemas/LastPosted");
    expect(prop("PostingFreshness", "pendingCount")).toMatchObject({ type: "integer", minimum: 0 });
    expect(prop("PostingFreshness", "oldestPendingAt")).toMatchObject({
      type: ["string", "null"],
      format: "date-time",
    });
    expect(prop("PostingFreshness", "oldestPendingAgeSeconds")).toMatchObject({
      type: ["integer", "null"],
      minimum: 0,
    });
  });
  it("D3: LastPosted.state is exactly known | unknown | none, with a nullable date-time at", () => {
    const l = schema("LastPosted");
    expect(l?.additionalProperties).toBe(false);
    expect(l?.required?.slice().sort()).toEqual(["at", "state"]);
    expect(Object.keys(l?.properties ?? {}).sort()).toEqual(["at", "state"]);
    expect(prop("LastPosted", "state")?.enum?.slice().sort()).toEqual(["known", "none", "unknown"]);
    expect(prop("LastPosted", "at")).toMatchObject({ type: ["string", "null"], format: "date-time" });
  });
  it("D5: facts only — no verdict / status / threshold field on the freshness shapes", () => {
    for (const name of ["PostingFreshness", "LastPosted"]) {
      for (const p of Object.keys(schema(name)?.properties ?? {})) {
        expect(`${name}.${p}`).not.toMatch(/status|verdict|current|behind|healthy|threshold|lag/i);
      }
    }
  });
  it("D5: the posting DomainSummary rule is unchanged (status enum and fields)", () => {
    const d = schema("DomainSummary");
    expect(Object.keys(d?.properties ?? {}).sort()).toEqual(
      ["detail", "domain", "headlineCount", "status"].sort(),
    );
  });
  it("D4: the freshness shapes carry no identifier (aggregates and timestamps only)", () => {
    for (const name of ["PostingFreshness", "LastPosted"]) {
      for (const p of Object.keys(schema(name)?.properties ?? {})) {
        expect(`${name}.${p}`).not.toMatch(/id$|Id$|_id|tenant|store|sale|external/i);
      }
    }
  });
});

describe("console-sync-ops.yaml — list projections + pagination (US2/US3, FR-014)", () => {
  // Per-endpoint page schemas (NOT a shared oneOf envelope) so the Console's
  // openapi-typescript generator produces a homogeneous, fully-typed items array
  // per endpoint (review cross-repo-fit; §IV).
  it("PostingBacklogPage is strict, items are PostingBacklogItem (no oneOf)", () => {
    const p = schema("PostingBacklogPage");
    expect(p?.additionalProperties).toBe(false);
    expect(p?.properties).toHaveProperty("items");
    expect(p?.properties).toHaveProperty("nextCursor");
    const items = (p?.properties ?? {})["items"] as {
      items?: { $ref?: string; oneOf?: unknown };
    };
    expect(items?.items?.$ref).toBe("#/components/schemas/PostingBacklogItem");
    expect(items?.items?.oneOf).toBeUndefined();
  });
  it("ReconciliationRunPage is strict, items are ReconciliationRunView (no oneOf)", () => {
    const p = schema("ReconciliationRunPage");
    expect(p?.additionalProperties).toBe(false);
    const items = (p?.properties ?? {})["items"] as {
      items?: { $ref?: string; oneOf?: unknown };
    };
    expect(items?.items?.$ref).toBe("#/components/schemas/ReconciliationRunView");
    expect(items?.items?.oneOf).toBeUndefined();
  });
  it("each list op references its own page schema in the 200 response", () => {
    const ref = (path: string) =>
      (
        doc.paths?.[path]?.["get"]?.responses?.["200"] as {
          content?: Record<string, { schema?: { $ref?: string } }>;
        }
      )?.content?.["application/json"]?.schema?.$ref;
    expect(ref(BACKLOG_PATH)).toBe("#/components/schemas/PostingBacklogPage");
    expect(ref(RUNS_PATH)).toBe("#/components/schemas/ReconciliationRunPage");
  });
  it("PostingBacklogItem is strict + carries class/provenance/reason/timestamp, NO write/repair field", () => {
    const b = schema("PostingBacklogItem");
    expect(b?.additionalProperties).toBe(false);
    expect(b?.required).toEqual(
      expect.arrayContaining(["sourceSystem", "externalId", "status", "deadLetteredAt"]),
    );
    const props = b?.properties ?? {};
    for (const writeField of ["repair", "repairKind", "retry"]) {
      expect(props).not.toHaveProperty(writeField);
    }
  });
  it("ReconciliationRunView is strict + carries status/trigger/timestamps/mismatchSummary", () => {
    const r = schema("ReconciliationRunView");
    expect(r?.additionalProperties).toBe(false);
    expect(r?.required).toEqual(
      expect.arrayContaining(["runId", "status", "trigger", "startedAt"]),
    );
  });
});

describe("console-sync-ops.yaml — error envelope + object safety", () => {
  it("defines the canonical Error envelope { error: { code, message, request_id } }", () => {
    const e = schema("Error") as
      | { required?: string[]; properties?: { error?: { properties?: Record<string, unknown> } } }
      | undefined;
    expect(e?.required).toContain("error");
    const inner = e?.properties?.error?.properties ?? {};
    expect(Object.keys(inner)).toEqual(expect.arrayContaining(["code", "message", "request_id"]));
  });
  it("all wire schemas are strict (additionalProperties: false)", () => {
    for (const name of [
      "SyncOpsSummary",
      "DomainSummary",
      "PostingBacklogPage",
      "ReconciliationRunPage",
      "PostingBacklogItem",
      "ReconciliationRunView",
      "PostingFreshness",
      "LastPosted",
    ]) {
      expect(schema(name)?.additionalProperties).toBe(false);
    }
  });
  it("NO money/valuation field anywhere (the 015/017 source tables carry none)", () => {
    const schemas = doc.components?.schemas ?? {};
    const banned = /money|amount|price|cost|valuation|currency|total|rate/i;
    for (const [name, s] of Object.entries(schemas)) {
      for (const prop of Object.keys(s.properties ?? {})) {
        expect(`${name}.${prop}`).not.toMatch(banned);
      }
    }
  });
  it("no schema leaks raw DB column / credential / tenant_id (§IV)", () => {
    const schemas = doc.components?.schemas ?? {};
    for (const s of Object.values(schemas)) {
      const props = s.properties ?? {};
      for (const leak of ["tenant_id", "tenantId", "payload_hash", "payloadHash", "correlation_id"]) {
        expect(props).not.toHaveProperty(leak);
      }
    }
  });
});
