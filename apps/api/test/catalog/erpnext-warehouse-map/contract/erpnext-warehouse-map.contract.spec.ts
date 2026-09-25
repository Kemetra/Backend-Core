/**
 * apps/api/test/catalog/erpnext-warehouse-map/contract/erpnext-warehouse-map.contract.spec.ts
 *
 * Slice 014-CONTRACT (T010 + T011) — OpenAPI conformance test for
 * `packages/contracts/openapi/catalog/erpnext-warehouse-map.yaml`.
 *
 * Mirrors `apps/api/test/catalog/erpnext-item-map/contract/erpnext-item-map.contract.spec.ts`:
 *   - loads the new contract via the production `loadOpenApiContracts` helper
 *     with an explicit `dir` (the helper's scan is non-recursive, so the nested
 *     `catalog/` directory is loaded explicitly; T011 is a no-op — no central
 *     YAML registry to extend);
 *   - asserts the THREE 014 operationIds are present + UNIQUE against every
 *     shipped operationId (top-level + nested catalog/ + pos-sales/ +
 *     erpnext-connector/);
 *   - pins the slice's load-bearing conventions:
 *       · the HUMAN dashboard `cookieAuth` scheme — NOT the 012 `connectorBearer`
 *         machine scheme and NOT the POS `clerkJwt` device scheme (the slice's
 *         stop condition);
 *       · strict request DTOs (§XII): set carries ONLY store_id +
 *         erpnext_warehouse_ref (no tenant_id/purpose/version/set_by); retire
 *         carries ONLY version (optimistic concurrency, §III);
 *       · the closed Error set incl. `409 conflict` + non-disclosing `404`;
 *       · the toBody `ErpnextWarehouseMapping` projection — identity only, NO
 *         Bin-quantity / valuation / on-hand field (OQ-1, the rejected
 *         read-down look-alike).
 *
 * Structural / load-only (no app boot, no HTTP).
 */
import "reflect-metadata";

import { resolve } from "node:path";

import { loadOpenApiContracts } from "../../../../src/openapi/loader";

const NEW_CONTRACT_ID = "erpnext-warehouse-map";

const OPERATION_IDS = [
  "tenantAdminListErpnextWarehouseMappings",
  "tenantAdminSetErpnextWarehouseMapping",
  "tenantAdminRetireErpnextWarehouseMapping",
] as const;

function openapiSubDir(sub: string): string {
  return resolve(
    __dirname,
    "..",
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
  requestBody?: {
    content?: Record<string, { schema?: { $ref?: string } }>;
  };
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
  const catalogContracts = loadOpenApiContracts({ dir: openapiSubDir("catalog") });
  const newContract = catalogContracts.find((c) => c.id === NEW_CONTRACT_ID);
  if (!newContract) {
    const ids = catalogContracts.map((c) => c.id).join(", ");
    throw new Error(
      `${NEW_CONTRACT_ID} contract not found under ${openapiSubDir("catalog")}; loaded ids: [${ids}]`,
    );
  }
  doc = newContract.document as OpenApiDocument;

  // SHIPPED operationIds the new ops must not collide with: top-level +
  // nested catalog/ (excl. self) + pos-sales/ + erpnext-connector/.
  shippedOperationIds = new Set<string>();
  collectOperationIds(
    loadOpenApiContracts().map((c) => c.document as OpenApiDocument),
    shippedOperationIds,
  );
  for (const sub of ["catalog", "pos-sales", "erpnext-connector"]) {
    collectOperationIds(
      loadOpenApiContracts({ dir: openapiSubDir(sub) })
        .filter((c) => c.id !== NEW_CONTRACT_ID)
        .map((c) => c.document as OpenApiDocument),
      shippedOperationIds,
    );
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

function schema(name: string): SchemaObject | undefined {
  return doc.components?.schemas?.[name];
}

// ===========================================================================
// 1. Loadability + document-level conventions
// ===========================================================================
describe("catalog/erpnext-warehouse-map.yaml — loadability", () => {
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

// ===========================================================================
// 2. Operations present + globally unique
// ===========================================================================
describe("catalog/erpnext-warehouse-map.yaml — operations", () => {
  it("declares all three 014 operationIds", () => {
    for (const id of OPERATION_IDS) {
      expect(findOp(id)).toBeDefined();
    }
  });

  it("does NOT collide with or rename any shipped operationId", () => {
    for (const id of OPERATION_IDS) {
      expect(shippedOperationIds.has(id)).toBe(false);
    }
  });
});

// ===========================================================================
// 3. Auth — the HUMAN dashboard cookieAuth scheme (the slice's stop condition)
// ===========================================================================
describe("catalog/erpnext-warehouse-map.yaml — auth boundary", () => {
  it("defines the cookieAuth (httpOnly dp2_session) scheme", () => {
    const cookie = doc.components?.securitySchemes?.["cookieAuth"];
    expect(cookie).toBeDefined();
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

// ===========================================================================
// 4. Strict request DTOs (§XII) + optimistic concurrency (§III)
// ===========================================================================
describe("catalog/erpnext-warehouse-map.yaml — request DTOs", () => {
  it("set request is strict and carries ONLY the mappable fields (no mass-assignment)", () => {
    const s = schema("SetErpnextWarehouseMappingRequest");
    expect(s?.additionalProperties).toBe(false);
    expect(s?.required?.sort()).toEqual(["erpnext_warehouse_ref", "store_id"]);
    // Security-sensitive / server-resolved fields MUST NOT be body-assignable.
    for (const forbidden of [
      "tenant_id",
      "purpose",
      "version",
      "set_by",
    ]) {
      expect(s?.properties?.[forbidden]).toBeUndefined();
    }
  });

  it("retire request carries the expected version for optimistic concurrency (§III)", () => {
    const v = schema("VersionedMutationRequest");
    expect(v?.additionalProperties).toBe(false);
    expect(v?.required).toEqual(["version"]);
    expect(v?.properties?.["version"]).toBeDefined();
  });

  it("bounds the mutation version to a positive int4", () => {
    const version = schema("VersionedMutationRequest")?.properties?.["version"] as {
      type?: string;
      minimum?: number;
      maximum?: number;
    };
    expect(version?.type).toBe("integer");
    expect(version?.minimum).toBe(1);
    expect(version?.maximum).toBe(2147483647);
  });
});

// ===========================================================================
// 5. Closed error set + non-disclosing 404 + 409 conflict
// ===========================================================================
describe("catalog/erpnext-warehouse-map.yaml — error envelope", () => {
  it("set declares the 1:1 conflict (409) and non-disclosing 404", () => {
    const op = findOp("tenantAdminSetErpnextWarehouseMapping");
    const responses = op?.responses ?? {};
    expect(responses["409"]).toBeDefined();
    expect(responses["404"]).toBeDefined();
  });

  it("retire declares 401/404/409 on the canonical Error envelope", () => {
    const op = findOp("tenantAdminRetireErpnextWarehouseMapping");
    const responses = op?.responses ?? {};
    for (const code of ["401", "404", "409"]) {
      expect(responses[code]).toBeDefined();
    }
  });

  it("Error is the strict canonical envelope { error: { code, message, request_id? } }", () => {
    const err = schema("Error");
    expect(err?.additionalProperties).toBe(false);
    expect(err?.required).toEqual(["error"]);
  });
});

// ===========================================================================
// 6. toBody projection — identity only, NO Bin-quantity/valuation/on-hand (OQ-1)
// ===========================================================================
describe("catalog/erpnext-warehouse-map.yaml — ErpnextWarehouseMapping projection", () => {
  const proj = () => schema("ErpnextWarehouseMapping");

  it("is a strict projection (no raw DB entity, §IV)", () => {
    expect(proj()?.additionalProperties).toBe(false);
  });

  it("carries the identity + lifecycle fields", () => {
    const props = proj()?.properties ?? {};
    for (const name of [
      "id",
      "store_id",
      "purpose",
      "erpnext_warehouse_ref",
      "version",
      "set_by",
      "set_at",
      "retired_at",
    ]) {
      expect(props[name]).toBeDefined();
    }
  });

  it("carries NO Bin-quantity / valuation / cost / on-hand field (OQ-1, no read-down mirror)", () => {
    const props = proj()?.properties ?? {};
    for (const forbidden of [
      "quantity",
      "bin_quantity",
      "qty",
      "on_hand",
      "valuation",
      "valuation_rate",
      "cost",
      "stock_value",
    ]) {
      expect(props[forbidden]).toBeUndefined();
    }
  });
});
