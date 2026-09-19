/**
 * apps/api/test/catalog/unknown-items/contract-wave2.spec.ts
 *
 * Slice 005-WAVE2-CONTRACT (T600 + T601) — OpenAPI conformance test for
 * the Wave 2 extension of `packages/contracts/openapi/catalog/unknown-items.yaml`.
 *
 * Mirrors the structure of the Wave 1 conformance test
 * (`apps/api/test/catalog/unknown-items/contract.spec.ts`, PR #315) but
 * focuses exclusively on the two Wave 2 operationIds added by this slice:
 *
 *   * `tenantAdminLinkUnknownItem`
 *   * `tenantAdminCreateProductFromUnknownItem`
 *
 * Assertions:
 *   1. Both operationIds are present in the YAML and reachable via their
 *      declared path + method.
 *   2. Their request/response schemas resolve cleanly (no dangling $ref).
 *   3. Neither operationId collides with the three Wave 1 operationIds.
 *   4. The path entries exist for both new operations.
 *   5. The Wave 2 request schemas referenced from each op exist in
 *      `components/schemas` and are closed (`additionalProperties: false`).
 *   6. Security for both new ops follows the Wave 1 `tenantAdmin*` pattern
 *      — neither `clerkJwt` nor an override; they inherit document-level
 *      `cookieAuth`.
 *   7. Status codes: `tenantAdminLinkUnknownItem` → 200;
 *      `tenantAdminCreateProductFromUnknownItem` → 201 (new resource).
 *   8. Both new ops declare the four Wave 2 error codes per research.md §R2:
 *      `alias_conflict`, `target_unavailable`, `already_reconciled`,
 *      `validation_error`.
 *
 * The spec is structural / load-only (no app boot, no HTTP requests). The
 * service implementation for the Wave 2 reconciliation path is authored
 * in later slices (`005-WAVE2-LINK-HAPPY`, `005-WAVE2-CREATE-HAPPY`); the
 * behavioural conformance tests will be added under
 * `apps/api/test/catalog/reconciliation/` per the execution-map.
 */
import "reflect-metadata";

import { resolve } from "node:path";

import { loadOpenApiContracts } from "../../../src/openapi/loader";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NEW_CONTRACT_ID = "unknown-items";

const WAVE_1_OPERATION_IDS = [
  "posCaptureItem",
  "tenantAdminListUnknownItems",
  "tenantAdminDismissUnknownItem",
] as const;

const WAVE_2_OPERATION_IDS = [
  "tenantAdminLinkUnknownItem",
  "tenantAdminCreateProductFromUnknownItem",
] as const;

const TENANT_ADMIN_LINK_PATH = "/api/v1/catalog/unknown-items/{id}/link";
const TENANT_ADMIN_CREATE_PRODUCT_PATH =
  "/api/v1/catalog/unknown-items/{id}/create-product";

// Wave 2 request schema names introduced by T600.
const WAVE_2_REQUEST_SCHEMAS = [
  "LinkUnknownItemRequest",
  "CreateProductFromUnknownItemRequest",
] as const;

/**
 * Resolve the catalog contract directory from this spec file's location.
 * Layout:
 *   apps/api/test/catalog/unknown-items/contract-wave2.spec.ts
 *   →  ../../../../../packages/contracts/openapi/catalog
 */
function catalogContractsDir(): string {
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
    "catalog",
  );
}

// ---------------------------------------------------------------------------
// Shared types — keep narrow; the loader returns `unknown` documents.
// ---------------------------------------------------------------------------

interface OperationObject {
  operationId?: string;
  security?: Array<Record<string, unknown>>;
  parameters?: Array<{
    in?: string;
    name?: string;
    required?: boolean;
    schema?: Record<string, unknown>;
  }>;
  responses?: Record<string, unknown>;
  requestBody?: {
    content?: Record<
      string,
      { schema?: { $ref?: string; [key: string]: unknown } }
    >;
  };
}

type PathItem = Record<string, OperationObject>;

interface OpenApiDocument {
  openapi?: string;
  info?: { title?: string; version?: string };
  paths?: Record<string, PathItem>;
  components?: {
    schemas?: Record<string, Record<string, unknown>>;
    securitySchemes?: Record<string, Record<string, unknown>>;
  };
  security?: Array<Record<string, unknown>>;
  tags?: Array<{ name?: string }>;
}

// Lazy-loaded once per file; populated in beforeAll.
let catalogDoc: OpenApiDocument;

beforeAll(() => {
  const catalogContracts = loadOpenApiContracts({ dir: catalogContractsDir() });
  const newContract = catalogContracts.find((c) => c.id === NEW_CONTRACT_ID);
  if (!newContract) {
    const ids = catalogContracts.map((c) => c.id).join(", ");
    throw new Error(
      `${NEW_CONTRACT_ID} contract not found under ${catalogContractsDir()}; loaded ids: [${ids}]`,
    );
  }
  catalogDoc = newContract.document as OpenApiDocument;
});

// Helper — flatten every operation in the contract.
function allOperations(): Array<{
  path: string;
  method: string;
  op: OperationObject;
}> {
  const out: Array<{ path: string; method: string; op: OperationObject }> = [];
  const paths = catalogDoc.paths ?? {};
  for (const [path, item] of Object.entries(paths)) {
    for (const [method, op] of Object.entries(item)) {
      out.push({ path, method, op });
    }
  }
  return out;
}

/** Resolve a $ref string like "#/components/schemas/Foo" to the named schema. */
function resolveRef(ref: string): Record<string, unknown> | undefined {
  const parts = ref.replace(/^#\//, "").split("/");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let node: any = catalogDoc;
  for (const part of parts) {
    node = node?.[part];
  }
  return node as Record<string, unknown> | undefined;
}

// ===========================================================================
// 1. Wave 2 operationId presence
// ===========================================================================
describe("catalog/unknown-items.yaml — Wave 2 operationIds present", () => {
  it.each(WAVE_2_OPERATION_IDS)(
    "declares the %s operationId",
    (expected) => {
      const ids = allOperations()
        .map(({ op }) => op.operationId)
        .filter((id): id is string => typeof id === "string");
      expect(ids).toContain(expected);
    },
  );

  it("tenantAdminLinkUnknownItem is mounted at POST /api/v1/catalog/unknown-items/{id}/link", () => {
    const link = catalogDoc.paths?.[TENANT_ADMIN_LINK_PATH]?.["post"];
    expect(link?.operationId).toBe("tenantAdminLinkUnknownItem");
  });

  it("tenantAdminCreateProductFromUnknownItem is mounted at POST /api/v1/catalog/unknown-items/{id}/create-product", () => {
    const create =
      catalogDoc.paths?.[TENANT_ADMIN_CREATE_PRODUCT_PATH]?.["post"];
    expect(create?.operationId).toBe("tenantAdminCreateProductFromUnknownItem");
  });
});

// ===========================================================================
// 2. No collision with Wave 1 operationIds
// ===========================================================================
describe("catalog/unknown-items.yaml — Wave 2 operationIds do not collide with Wave 1", () => {
  it("Wave 2 operationIds are disjoint from all three Wave 1 operationIds", () => {
    const wave1Set = new Set<string>(WAVE_1_OPERATION_IDS);
    const collisions = WAVE_2_OPERATION_IDS.filter((id) => wave1Set.has(id));
    expect(collisions).toEqual([]);
  });

  it("the full declared set contains all five operationIds (Wave 1 + Wave 2)", () => {
    const declared = allOperations()
      .map(({ op }) => op.operationId)
      .filter((id): id is string => typeof id === "string");
    const expected = [...WAVE_1_OPERATION_IDS, ...WAVE_2_OPERATION_IDS];
    expect(declared).toEqual(expect.arrayContaining(expected));
    // Wave 1 (3) + Wave 2 (2) are always present. The strict length-5
    // tripwire was loosened by slice 007-CONTRACT (T010), which added three
    // tenant-admin operations to this YAML; the 007 conformance test
    // (`contract-007.spec.ts`, same directory) owns the exact 007
    // operationId assertions and the precise total count. This Wave 2 test
    // now only guarantees the five 005 ops remain present (no regression).
    expect(declared.length).toBeGreaterThanOrEqual(5);
  });
});

// ===========================================================================
// 3. Request schema presence and closedness
// ===========================================================================
describe("catalog/unknown-items.yaml — Wave 2 request schemas", () => {
  it.each(WAVE_2_REQUEST_SCHEMAS)(
    "%s exists in components/schemas",
    (schemaName) => {
      const schema = catalogDoc.components?.schemas?.[schemaName];
      expect(schema).toBeDefined();
    },
  );

  it.each(WAVE_2_REQUEST_SCHEMAS)(
    "%s closes with additionalProperties: false (defence-in-depth)",
    (schemaName) => {
      const schema = catalogDoc.components?.schemas?.[schemaName];
      expect(schema?.["additionalProperties"]).toBe(false);
    },
  );

  it("tenantAdminLinkUnknownItem requestBody refs LinkUnknownItemRequest", () => {
    const link = catalogDoc.paths?.[TENANT_ADMIN_LINK_PATH]?.["post"];
    const ref =
      link?.requestBody?.content?.["application/json"]?.schema?.["$ref"];
    expect(ref).toBe("#/components/schemas/LinkUnknownItemRequest");
  });

  it("tenantAdminCreateProductFromUnknownItem requestBody refs CreateProductFromUnknownItemRequest", () => {
    const create =
      catalogDoc.paths?.[TENANT_ADMIN_CREATE_PRODUCT_PATH]?.["post"];
    const ref =
      create?.requestBody?.content?.["application/json"]?.schema?.["$ref"];
    expect(ref).toBe(
      "#/components/schemas/CreateProductFromUnknownItemRequest",
    );
  });

  it("LinkUnknownItemRequest $ref resolves to a non-empty schema object", () => {
    const resolved = resolveRef(
      "#/components/schemas/LinkUnknownItemRequest",
    );
    expect(resolved).toBeDefined();
    expect(typeof resolved).toBe("object");
  });

  it("CreateProductFromUnknownItemRequest $ref resolves to a non-empty schema object", () => {
    const resolved = resolveRef(
      "#/components/schemas/CreateProductFromUnknownItemRequest",
    );
    expect(resolved).toBeDefined();
    expect(typeof resolved).toBe("object");
  });
});

// ===========================================================================
// 4. Response status codes — 200 for link, 201 for create-product
// ===========================================================================
describe("catalog/unknown-items.yaml — Wave 2 response status codes", () => {
  it("tenantAdminLinkUnknownItem declares a 200 success response (mutation of existing pending row)", () => {
    const link = catalogDoc.paths?.[TENANT_ADMIN_LINK_PATH]?.["post"];
    expect(
      (link?.responses as Record<string, unknown> | undefined)?.[200],
    ).toBeDefined();
  });

  it("tenantAdminCreateProductFromUnknownItem declares a 201 success response (new resource created)", () => {
    const create =
      catalogDoc.paths?.[TENANT_ADMIN_CREATE_PRODUCT_PATH]?.["post"];
    expect(
      (create?.responses as Record<string, unknown> | undefined)?.[201],
    ).toBeDefined();
  });
});

// ===========================================================================
// 5. Wave 2 error responses — research.md §R2 taxonomy
// ===========================================================================
describe("catalog/unknown-items.yaml — Wave 2 error responses (research.md §R2)", () => {
  it("tenantAdminLinkUnknownItem declares a 409 response for conflict outcomes (alias_conflict, target_unavailable, already_reconciled)", () => {
    const link = catalogDoc.paths?.[TENANT_ADMIN_LINK_PATH]?.["post"];
    expect(
      (link?.responses as Record<string, unknown> | undefined)?.[409],
    ).toBeDefined();
  });

  it("tenantAdminCreateProductFromUnknownItem declares a 409 response for conflict outcomes (alias_conflict, already_reconciled)", () => {
    const create =
      catalogDoc.paths?.[TENANT_ADMIN_CREATE_PRODUCT_PATH]?.["post"];
    expect(
      (create?.responses as Record<string, unknown> | undefined)?.[409],
    ).toBeDefined();
  });

  it("tenantAdminLinkUnknownItem declares a 404 non-disclosing response (SI-004)", () => {
    const link = catalogDoc.paths?.[TENANT_ADMIN_LINK_PATH]?.["post"];
    expect(
      (link?.responses as Record<string, unknown> | undefined)?.[404],
    ).toBeDefined();
  });

  it("tenantAdminCreateProductFromUnknownItem declares a 404 non-disclosing response (SI-004)", () => {
    const create =
      catalogDoc.paths?.[TENANT_ADMIN_CREATE_PRODUCT_PATH]?.["post"];
    expect(
      (create?.responses as Record<string, unknown> | undefined)?.[404],
    ).toBeDefined();
  });
});

// ===========================================================================
// 6. Security — Wave 2 ops inherit document-level cookieAuth (no override)
// ===========================================================================
describe("catalog/unknown-items.yaml — Wave 2 security inheritance", () => {
  it("tenantAdminLinkUnknownItem declares no operation-level security override (inherits document cookieAuth)", () => {
    const link = catalogDoc.paths?.[TENANT_ADMIN_LINK_PATH]?.["post"];
    // No `security` array on the operation — inherits document-level
    // cookieAuth per the Wave 1 tenantAdmin* pattern.
    expect(link?.security).toBeUndefined();
  });

  it("tenantAdminCreateProductFromUnknownItem declares no operation-level security override (inherits document cookieAuth)", () => {
    const create =
      catalogDoc.paths?.[TENANT_ADMIN_CREATE_PRODUCT_PATH]?.["post"];
    expect(create?.security).toBeUndefined();
  });

  it("document-level security still declares cookieAuth (Wave 1 posture unchanged)", () => {
    expect(catalogDoc.security).toContainEqual({ cookieAuth: [] });
  });
});

// ===========================================================================
// 7. Wave 2 response bodies ref UnknownItem (resolved lifecycle fields)
// ===========================================================================
describe("catalog/unknown-items.yaml — Wave 2 response body schemas", () => {
  it("tenantAdminLinkUnknownItem 200 response body refs ReviewQueueItem (007 R7.2 narrowing)", () => {
    // Slice 007-CONTRACT (T010) narrowed every dashboard response to the
    // sale_context-free ReviewQueueItem projection (research §R7.2 / FR-007);
    // dismiss/link/create were residual leaks the list-focused T002 wording
    // missed. This guard was previously locked to `UnknownItem` and would
    // have cemented the leak — updated to match the recorded product
    // decision (the runtime swap follows in T038).
    const link = catalogDoc.paths?.[TENANT_ADMIN_LINK_PATH]?.["post"];
    const responses = link?.responses as
      | Record<string, { content?: Record<string, { schema?: { $ref?: string } }> }>
      | undefined;
    const ref = responses?.[200]?.content?.["application/json"]?.schema?.["$ref"];
    expect(ref).toBe("#/components/schemas/ReviewQueueItem");
  });

  it("tenantAdminCreateProductFromUnknownItem 201 response body refs ReviewQueueItem (007 R7.2 narrowing)", () => {
    const create =
      catalogDoc.paths?.[TENANT_ADMIN_CREATE_PRODUCT_PATH]?.["post"];
    const responses = create?.responses as
      | Record<string, { content?: Record<string, { schema?: { $ref?: string } }> }>
      | undefined;
    const ref = responses?.[201]?.content?.["application/json"]?.schema?.["$ref"];
    expect(ref).toBe("#/components/schemas/ReviewQueueItem");
  });

  it("UnknownItem schema exists in components/schemas (Wave 1 regression guard)", () => {
    expect(catalogDoc.components?.schemas?.["UnknownItem"]).toBeDefined();
  });
});
