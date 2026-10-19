/**
 * apps/api/test/catalog/erpnext-product-reconciliation/contract/product-reconciliation.contract.spec.ts
 *
 * Slice 021-CONTRACT (T007 / T012) — OpenAPI conformance test for
 * `packages/contracts/openapi/catalog/product-reconciliation.yaml`.
 *
 * Mirrors `apps/api/test/catalog/erpnext-warehouse-map/contract/erpnext-warehouse-map.contract.spec.ts`
 * (the new contract lives in the existing `catalog/` dir, loaded explicitly since
 * the loader scan is non-recursive):
 *   - asserts the FIVE 021 operationIds are present + UNIQUE against every shipped
 *     operationId (top-level + catalog/ + pos-sales/ + erpnext-connector/);
 *   - pins the slice's load-bearing conventions:
 *       · the HUMAN dashboard `cookieAuth` scheme — NOT `connectorBearer` (012
 *         machine) and NOT `clerkJwt` (POS device) (FR-019);
 *       · `Idempotency-Key` required on the two mutating ops;
 *       · strict request DTOs (§XII) — no body-supplied tenant/actor/trigger;
 *       · the closed Error set incl. `conflict` (409) + non-disclosing 404;
 *       · the toBody projections — `ProductReconciliationResult.mismatchClass` is
 *         021's product-master vocabulary ONLY; NO money/valuation field anywhere.
 *
 * Structural / load-only (no app boot, no HTTP).
 */
import "reflect-metadata";

import { resolve } from "node:path";

import { loadOpenApiContracts } from "../../../../src/openapi/loader";

const NEW_CONTRACT_ID = "product-reconciliation";

const OPERATION_IDS = [
  "listProductReconciliationBacklog",
  "repairProductMapping",
  "triggerProductReconciliationRun",
  "listProductReconciliationRuns",
  "getProductReconciliationRunResults",
] as const;

const MUTATING_IDEMPOTENT_OPS = [
  "repairProductMapping",
  "triggerProductReconciliationRun",
] as const;

const PRODUCT_VOCAB = [
  "attribute_drift",
  "match",
  "sellable_state_divergence",
  "suggestion_unconfirmed",
  "unmapped_dp2_product",
  "unmapped_erpnext_item",
] as const;

function openapiSubDir(sub: string): string {
  return resolve(
    __dirname, "..", "..", "..", "..", "..", "..",
    "packages", "contracts", "openapi", sub,
  );
}

interface OperationObject {
  operationId?: string;
  parameters?: Array<{ $ref?: string; name?: string; in?: string; required?: boolean }>;
  requestBody?: { content?: Record<string, { schema?: { $ref?: string } }> };
  responses?: Record<string, unknown>;
}
type PathItem = Record<string, OperationObject>;
interface SchemaObject {
  type?: string | string[];
  additionalProperties?: boolean | Record<string, unknown>;
  required?: string[];
  properties?: Record<string, { enum?: string[] }>;
}
interface OpenApiDocument {
  openapi?: string;
  info?: { title?: string; version?: string };
  paths?: Record<string, PathItem>;
  components?: {
    schemas?: Record<string, SchemaObject>;
    securitySchemes?: Record<string, Record<string, unknown>>;
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
  const contracts = loadOpenApiContracts({ dir: openapiSubDir("catalog") });
  const newContract = contracts.find((c) => c.id === NEW_CONTRACT_ID);
  if (!newContract) {
    const ids = contracts.map((c) => c.id).join(", ");
    throw new Error(
      `${NEW_CONTRACT_ID} contract not found under ${openapiSubDir("catalog")}; loaded ids: [${ids}]`,
    );
  }
  doc = newContract.document as OpenApiDocument;

  shippedOperationIds = new Set<string>();
  collectOperationIds(
    loadOpenApiContracts().map((c) => c.document as OpenApiDocument),
    shippedOperationIds,
  );
  for (const sub of ["pos-sales", "erpnext-connector", "erpnext-reconciliation"]) {
    collectOperationIds(
      loadOpenApiContracts({ dir: openapiSubDir(sub) }).map((c) => c.document as OpenApiDocument),
      shippedOperationIds,
    );
  }
  // The catalog dir includes our own contract — exclude its ids from "shipped".
  for (const id of OPERATION_IDS) shippedOperationIds.delete(id);
  for (const c of loadOpenApiContracts({ dir: openapiSubDir("catalog") })) {
    if (c.id === NEW_CONTRACT_ID) continue;
    collectOperationIds([c.document as OpenApiDocument], shippedOperationIds);
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

describe("catalog/product-reconciliation.yaml — loadability", () => {
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

describe("catalog/product-reconciliation.yaml — operations", () => {
  it("declares all five 021 operationIds", () => {
    for (const id of OPERATION_IDS) expect(findOp(id)).toBeDefined();
  });
  it("does NOT collide with or rename any shipped operationId", () => {
    for (const id of OPERATION_IDS) expect(shippedOperationIds.has(id)).toBe(false);
  });
  it("routes all ops under /api/v1/catalog/erpnext-product-reconciliation", () => {
    for (const { path } of operations()) {
      expect(path.startsWith("/api/v1/catalog/erpnext-product-reconciliation")).toBe(true);
    }
  });
});

describe("catalog/product-reconciliation.yaml — auth boundary (FR-019)", () => {
  it("defines the cookieAuth (httpOnly dp2_session) scheme", () => {
    const cookie = doc.components?.securitySchemes?.["cookieAuth"];
    expect(cookie?.["type"]).toBe("apiKey");
    expect(cookie?.["in"]).toBe("cookie");
    expect(cookie?.["name"]).toBe("dp2_session");
  });
  it("requires cookieAuth at the document level", () => {
    expect(doc.security).toEqual([{ cookieAuth: [] }]);
  });
  it("does NOT define connectorBearer (012 machine) or clerkJwt (POS device)", () => {
    expect(doc.components?.securitySchemes?.["connectorBearer"]).toBeUndefined();
    expect(doc.components?.securitySchemes?.["clerkJwt"]).toBeUndefined();
  });
});

describe("catalog/product-reconciliation.yaml — idempotency (O-3, no new primitive)", () => {
  it("the two mutating ops require an Idempotency-Key header", () => {
    for (const id of MUTATING_IDEMPOTENT_OPS) {
      const op = findOp(id);
      const hasKeyRef = (op?.parameters ?? []).some(
        (p) => p.$ref?.endsWith("/IdempotencyKey") || p.name === "Idempotency-Key",
      );
      expect(hasKeyRef).toBe(true);
    }
  });
});

describe("catalog/product-reconciliation.yaml — request DTOs (§XII)", () => {
  it("repair request is strict and carries NO tenant/actor/server fields", () => {
    const s = schema("RepairProductMappingRequest");
    expect(s?.additionalProperties).toBe(false);
    for (const forbidden of ["tenant_id", "tenantId", "actor_user_id", "actorUserId", "outcome", "result_state"]) {
      expect(s?.properties?.[forbidden]).toBeUndefined();
    }
  });
  it("trigger-run request is strict and carries NO tenant/trigger/actor", () => {
    const s = schema("TriggerProductRunRequest");
    expect(s?.additionalProperties).toBe(false);
    for (const forbidden of ["tenant_id", "tenantId", "trigger", "actor_user_id", "status"]) {
      expect(s?.properties?.[forbidden]).toBeUndefined();
    }
  });
});

describe("catalog/product-reconciliation.yaml — error envelope", () => {
  it("the mutating ops declare 409 (conflict) + non-disclosing 404 where applicable", () => {
    const repair = findOp("repairProductMapping")?.responses ?? {};
    expect(repair["404"]).toBeDefined();
    expect(repair["409"]).toBeDefined();
    const trigger = findOp("triggerProductReconciliationRun")?.responses ?? {};
    expect(trigger["409"]).toBeDefined();
  });
  it("Error is the strict canonical envelope { error: { code, message, request_id? } }", () => {
    const err = schema("Error");
    expect(err?.additionalProperties).toBe(false);
    expect(err?.required).toEqual(["error"]);
  });
});

describe("catalog/product-reconciliation.yaml — projections (021 vocab, no money)", () => {
  it("ProductReconciliationResult.mismatchClass is 021's product-master vocabulary ONLY", () => {
    const cls = schema("ProductReconciliationResult")?.properties?.["mismatchClass"]?.enum ?? [];
    expect([...cls].sort()).toEqual([...PRODUCT_VOCAB]);
    // 014 stock + 015 posting categories must NOT leak in.
    for (const foreign of ["quantity_divergence", "unmapped_store", "dp2_only", "erpnext_only", "validation", "closed_period"]) {
      expect(cls).not.toContain(foreign);
    }
  });
  it("the run projection has NO kind field (021 has one run kind)", () => {
    expect(schema("ProductReconciliationRun")?.properties?.["kind"]).toBeUndefined();
  });
  it("the run projection records erpnext_view_status (FR-007 stub-tolerance)", () => {
    const vs = schema("ProductReconciliationRun")?.properties?.["erpnextViewStatus"]?.enum ?? [];
    expect([...vs].sort()).toEqual(["available", "partial", "unavailable"]);
  });
  it("no projection carries a money / valuation / on-hand field", () => {
    for (const name of ["BacklogItem", "ProductReconciliationRun", "ProductReconciliationResult", "RecordedProductRepair"]) {
      const props = schema(name)?.properties ?? {};
      for (const forbidden of ["amount", "pos_total", "valuation", "cost", "price", "on_hand", "stock_value"]) {
        expect(props[forbidden]).toBeUndefined();
      }
    }
  });
  it("all projections are strict (no raw DB entity, §IV)", () => {
    for (const name of ["BacklogItem", "ProductReconciliationRun", "ProductReconciliationResult", "RecordedProductRepair", "BacklogPage", "RunPage", "ResultPage"]) {
      expect(schema(name)?.additionalProperties).toBe(false);
    }
  });
});

describe("catalog/product-reconciliation.yaml — RT-733 mapping version (additive)", () => {
  type Prop = { type?: string | string[]; minimum?: number; format?: string };
  const prop = (schemaName: string, name: string): Prop | undefined =>
    (schema(schemaName)?.properties as Record<string, Prop> | undefined)?.[name];

  it("BacklogItem exposes an optional, nullable suggestionMappingVersion", () => {
    const p = prop("BacklogItem", "suggestionMappingVersion");
    expect(p?.type).toEqual(["integer", "null"]);
    expect(p?.minimum).toBe(1);
    expect(schema("BacklogItem")?.required).not.toContain("suggestionMappingVersion");
  });

  it("ProductReconciliationResult exposes optional, nullable mappingId + mappingVersion", () => {
    expect(prop("ProductReconciliationResult", "mappingId")).toMatchObject({
      type: ["string", "null"],
      format: "uuid",
    });
    expect(prop("ProductReconciliationResult", "mappingVersion")).toMatchObject({
      type: ["integer", "null"],
      minimum: 1,
    });
    const required = schema("ProductReconciliationResult")?.required ?? [];
    expect(required).not.toContain("mappingId");
    expect(required).not.toContain("mappingVersion");
  });
});
