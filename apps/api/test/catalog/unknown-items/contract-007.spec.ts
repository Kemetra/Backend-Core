/**
 * apps/api/test/catalog/unknown-items/contract-007.spec.ts
 *
 * Slice 007-CONTRACT (T010 + T011) — OpenAPI conformance test for the 007
 * extension of `packages/contracts/openapi/catalog/unknown-items.yaml`.
 *
 * Mirrors the structure of the Wave 1 / Wave 2 conformance tests
 * (`contract.spec.ts`, `contract-wave2.spec.ts`) but focuses exclusively on
 * the 007 delta:
 *
 *   * Three NEW operationIds:
 *       - `tenantAdminInspectUnknownItem`        GET  /api/v1/catalog/unknown-items/{id}
 *       - `tenantAdminReopenUnknownItem`         POST /api/v1/catalog/unknown-items/{id}/reopen
 *       - `tenantAdminBulkDismissUnknownItems`   POST /api/v1/catalog/unknown-items/bulk-dismiss
 *   * The `ReviewQueueItem` schema = shipped `UnknownItem` MINUS `sale_context`
 *     (data-model §2.1, FR-007 / 006 FR-021a) — closed envelope.
 *   * The `forbidden` 8th error category exists in the contract vocabulary.
 *   * Reopen + bulk-dismiss declare the `Idempotency-Key` header (NOT
 *     `Idempotency-Token` — T564 trap; research §R6 / ISOLATE verdict).
 *   * The five SHIPPED operationIds (Wave 1 + Wave 2) are unchanged — no
 *     rename (renames are breaking; additive MINOR only).
 *
 * Structural / load-only (no app boot, no HTTP requests). Behavioural
 * conformance for the new operations is authored in the US3 / US7 / US8
 * slices per the execution-map.
 */
import "reflect-metadata";

import { resolve } from "node:path";

import { loadOpenApiContracts } from "../../../src/openapi/loader";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NEW_CONTRACT_ID = "unknown-items";

// The five operationIds shipped by 005 (Wave 1 + Wave 2). 007 MUST NOT
// rename any of them — that would be a breaking change.
const SHIPPED_OPERATION_IDS = [
  "posCaptureItem",
  "tenantAdminListUnknownItems",
  "tenantAdminDismissUnknownItem",
  "tenantAdminLinkUnknownItem",
  "tenantAdminCreateProductFromUnknownItem",
] as const;

// The three operationIds 007 adds.
const NEW_007_OPERATION_IDS = [
  "tenantAdminInspectUnknownItem",
  "tenantAdminReopenUnknownItem",
  "tenantAdminBulkDismissUnknownItems",
] as const;

const TENANT_ADMIN_INSPECT_PATH = "/api/v1/catalog/unknown-items/{id}";
const TENANT_ADMIN_REOPEN_PATH = "/api/v1/catalog/unknown-items/{id}/reopen";
const TENANT_ADMIN_BULK_DISMISS_PATH =
  "/api/v1/catalog/unknown-items/bulk-dismiss";

// The operations that carry an Idempotency-Key (ISOLATE verdict, T003):
// only the new state-changing reopen + bulk-dismiss.
const KEY_BEARING_PATHS = [
  TENANT_ADMIN_REOPEN_PATH,
  TENANT_ADMIN_BULK_DISMISS_PATH,
] as const;

/**
 * Resolve the catalog contract directory from this spec file's location.
 * Layout:
 *   apps/api/test/catalog/unknown-items/contract-007.spec.ts
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

// ===========================================================================
// 1. 007 operationId presence + path mounting
// ===========================================================================
describe("catalog/unknown-items.yaml — 007 operationIds present", () => {
  it.each(NEW_007_OPERATION_IDS)("declares the %s operationId", (expected) => {
    const ids = allOperations()
      .map(({ op }) => op.operationId)
      .filter((id): id is string => typeof id === "string");
    expect(ids).toContain(expected);
  });

  it("tenantAdminInspectUnknownItem is mounted at GET /api/v1/catalog/unknown-items/{id}", () => {
    const inspect = catalogDoc.paths?.[TENANT_ADMIN_INSPECT_PATH]?.["get"];
    expect(inspect?.operationId).toBe("tenantAdminInspectUnknownItem");
  });

  it("tenantAdminReopenUnknownItem is mounted at POST /api/v1/catalog/unknown-items/{id}/reopen", () => {
    const reopen = catalogDoc.paths?.[TENANT_ADMIN_REOPEN_PATH]?.["post"];
    expect(reopen?.operationId).toBe("tenantAdminReopenUnknownItem");
  });

  it("tenantAdminBulkDismissUnknownItems is mounted at POST /api/v1/catalog/unknown-items/bulk-dismiss", () => {
    const bulk = catalogDoc.paths?.[TENANT_ADMIN_BULK_DISMISS_PATH]?.["post"];
    expect(bulk?.operationId).toBe("tenantAdminBulkDismissUnknownItems");
  });
});

// ===========================================================================
// 2. Shipped operationIds unchanged — no rename (additive MINOR only)
// ===========================================================================
describe("catalog/unknown-items.yaml — shipped operationIds unchanged", () => {
  it.each(SHIPPED_OPERATION_IDS)(
    "still declares the shipped %s operationId (no rename)",
    (expected) => {
      const ids = allOperations()
        .map(({ op }) => op.operationId)
        .filter((id): id is string => typeof id === "string");
      expect(ids).toContain(expected);
    },
  );

  it("declares exactly the eight expected operationIds (5 shipped + 3 new)", () => {
    const declared = allOperations()
      .map(({ op }) => op.operationId)
      .filter((id): id is string => typeof id === "string");
    const expected = [...SHIPPED_OPERATION_IDS, ...NEW_007_OPERATION_IDS];
    expect(declared).toEqual(expect.arrayContaining(expected));
    expect(declared).toHaveLength(expected.length);
  });

  it("the 007 operationIds are disjoint from the shipped set", () => {
    const shipped = new Set<string>(SHIPPED_OPERATION_IDS);
    const collisions = NEW_007_OPERATION_IDS.filter((id) => shipped.has(id));
    expect(collisions).toEqual([]);
  });
});

// ===========================================================================
// 3. ReviewQueueItem schema — closed, omits sale_context (FR-007)
// ===========================================================================
describe("catalog/unknown-items.yaml — ReviewQueueItem projection", () => {
  it("declares the ReviewQueueItem schema in components/schemas", () => {
    expect(catalogDoc.components?.schemas?.["ReviewQueueItem"]).toBeDefined();
  });

  it("ReviewQueueItem closes with additionalProperties: false (response safety)", () => {
    const schema = catalogDoc.components?.schemas?.["ReviewQueueItem"];
    expect(schema?.["additionalProperties"]).toBe(false);
  });

  it("ReviewQueueItem OMITS sale_context (FR-007 / 006 FR-021a MUST NOT)", () => {
    const schema = catalogDoc.components?.schemas?.["ReviewQueueItem"];
    const props = schema?.["properties"] as
      | Record<string, unknown>
      | undefined;
    expect(props).toBeDefined();
    expect(props).not.toHaveProperty("sale_context");
  });

  it("ReviewQueueItem carries the data-model §2.1 field set (UnknownItem minus sale_context)", () => {
    const schema = catalogDoc.components?.schemas?.["ReviewQueueItem"];
    const props = schema?.["properties"] as
      | Record<string, unknown>
      | undefined;
    // Every UnknownItem field except sale_context (data-model §2.1).
    for (const field of [
      "id",
      "tenant_id",
      "store_id",
      "identifier_type",
      "identifier_value",
      "source_system",
      "resolution_status",
      "resolution_action",
      "resolved_at",
      "resolved_by",
      "resolved_product_id",
      "encountered_at",
    ]) {
      expect(props).toHaveProperty(field);
    }
  });

  it("the shipped UnknownItem schema is unchanged — still carries sale_context (POS capture round-trip, R7.3)", () => {
    // 007 does NOT strip sale_context from UnknownItem itself; the POS
    // capture response keeps it (provenance). The review surface uses the
    // separate ReviewQueueItem projection.
    const schema = catalogDoc.components?.schemas?.["UnknownItem"];
    const props = schema?.["properties"] as
      | Record<string, unknown>
      | undefined;
    expect(props).toHaveProperty("sale_context");
  });
});

// ===========================================================================
// 4. Review-read responses ref ReviewQueueItem (no sale_context leak)
// ===========================================================================
describe("catalog/unknown-items.yaml — review reads return ReviewQueueItem", () => {
  it("tenantAdminInspectUnknownItem 200 response body refs ReviewQueueItem", () => {
    const inspect = catalogDoc.paths?.[TENANT_ADMIN_INSPECT_PATH]?.["get"];
    const responses = inspect?.responses as
      | Record<
          string,
          { content?: Record<string, { schema?: { $ref?: string } }> }
        >
      | undefined;
    const ref =
      responses?.[200]?.content?.["application/json"]?.schema?.["$ref"];
    expect(ref).toBe("#/components/schemas/ReviewQueueItem");
  });

  it("ListUnknownItemsResponse.items refs ReviewQueueItem (the list IS the review queue, T002 TIGHTEN)", () => {
    // FR-007 / T002: the shipped list response is the review surface and
    // must not carry sale_context. The contract narrows items to the
    // ReviewQueueItem projection in this slice (US1 runtime T032 follows).
    const schema = catalogDoc.components?.schemas?.["ListUnknownItemsResponse"];
    const props = schema?.["properties"] as
      | Record<string, { items?: { $ref?: string } }>
      | undefined;
    expect(props?.["items"]?.items?.["$ref"]).toBe(
      "#/components/schemas/ReviewQueueItem",
    );
  });

  // research §R7.2 / spec.md:83: "no dashboard response echoes sale_context".
  // dismiss + link + create-product were residual leaks the list-focused
  // T002 wording missed — every dashboard response narrows to
  // ReviewQueueItem. (posCapture KEEPS UnknownItem per R7.3 — provenance.)
  it("tenantAdminDismissUnknownItem 200 response body refs ReviewQueueItem (R7.2)", () => {
    const dismiss =
      catalogDoc.paths?.["/api/v1/catalog/unknown-items/{id}/dismiss"]?.["post"];
    const responses = dismiss?.responses as
      | Record<
          string,
          { content?: Record<string, { schema?: { $ref?: string } }> }
        >
      | undefined;
    const ref =
      responses?.[200]?.content?.["application/json"]?.schema?.["$ref"];
    expect(ref).toBe("#/components/schemas/ReviewQueueItem");
  });

  it("tenantAdminLinkUnknownItem 200 response body refs ReviewQueueItem (R7.2)", () => {
    const link =
      catalogDoc.paths?.["/api/v1/catalog/unknown-items/{id}/link"]?.["post"];
    const responses = link?.responses as
      | Record<
          string,
          { content?: Record<string, { schema?: { $ref?: string } }> }
        >
      | undefined;
    const ref =
      responses?.[200]?.content?.["application/json"]?.schema?.["$ref"];
    expect(ref).toBe("#/components/schemas/ReviewQueueItem");
  });

  it("tenantAdminCreateProductFromUnknownItem 201 response body refs ReviewQueueItem (R7.2)", () => {
    const create =
      catalogDoc.paths?.[
        "/api/v1/catalog/unknown-items/{id}/create-product"
      ]?.["post"];
    const responses = create?.responses as
      | Record<
          string,
          { content?: Record<string, { schema?: { $ref?: string } }> }
        >
      | undefined;
    const ref =
      responses?.[201]?.content?.["application/json"]?.schema?.["$ref"];
    expect(ref).toBe("#/components/schemas/ReviewQueueItem");
  });
});

// ===========================================================================
// 5. `forbidden` 8th error category in the contract vocabulary (US9)
// ===========================================================================
describe("catalog/unknown-items.yaml — forbidden error category", () => {
  it("the Error.code description documents the `forbidden` 8th category", () => {
    // Stronger than a whole-document substring scan: assert the token is
    // documented on the Error envelope's `code` field, where the closed
    // taxonomy lives (the code field is `type: string`, no enum, so the
    // vocabulary is documented in its description).
    const errorSchema = catalogDoc.components?.schemas?.["Error"];
    const props = errorSchema?.["properties"] as
      | { error?: { properties?: { code?: { description?: string } } } }
      | undefined;
    const codeDesc = props?.error?.properties?.code?.description ?? "";
    expect(codeDesc).toContain("forbidden");
  });

  it("tenantAdminInspectUnknownItem declares a 403 response (forbidden surface exists, FR-051)", () => {
    const inspect = catalogDoc.paths?.[TENANT_ADMIN_INSPECT_PATH]?.["get"];
    expect(
      (inspect?.responses as Record<string, unknown> | undefined)?.[403],
    ).toBeDefined();
  });

  it("tenantAdminInspectUnknownItem declares a 400 response (malformed path UUID — parity with other {id} ops)", () => {
    // Every other {id} operation in this contract documents a 400 for an
    // invalid path UUID; inspect must too (CodeRabbit PR #404).
    const inspect = catalogDoc.paths?.[TENANT_ADMIN_INSPECT_PATH]?.["get"];
    expect(
      (inspect?.responses as Record<string, unknown> | undefined)?.[400],
    ).toBeDefined();
  });
});

// ===========================================================================
// 5c. Response bodies reference the correct schema (not just status presence)
// ===========================================================================
// CodeRabbit PR #404: presence-only assertions are shallow. Assert each
// documented response actually refs the right schema — 200→ReviewQueueItem,
// error codes (400/401/403/404/409/425)→Error envelope. The 425 refs Error to
// MIRROR the shipped posCaptureItem 425 (a contract-wide convention); the
// interceptor's raw in-progress body-shape mismatch is a recorded finding,
// not changed here.
describe("catalog/unknown-items.yaml — 007 response body schema refs", () => {
  /** Extract the application/json schema $ref for a given op + status. */
  function responseRef(
    path: string,
    method: string,
    status: number,
  ): string | undefined {
    const op = catalogDoc.paths?.[path]?.[method];
    const responses = op?.responses as
      | Record<
          string,
          { content?: Record<string, { schema?: { $ref?: string } }> }
        >
      | undefined;
    return responses?.[status]?.content?.["application/json"]?.schema?.["$ref"];
  }

  it("inspect: 200→ReviewQueueItem, 400/401/403/404→Error", () => {
    const p = TENANT_ADMIN_INSPECT_PATH;
    expect(responseRef(p, "get", 200)).toBe(
      "#/components/schemas/ReviewQueueItem",
    );
    for (const status of [400, 401, 403, 404]) {
      expect(responseRef(p, "get", status)).toBe("#/components/schemas/Error");
    }
  });

  it("reopen: 201→ReviewQueueItem, 400/401/403/404/409/425→Error", () => {
    const p = TENANT_ADMIN_REOPEN_PATH;
    expect(responseRef(p, "post", 201)).toBe(
      "#/components/schemas/ReviewQueueItem",
    );
    for (const status of [400, 401, 403, 404, 409, 425]) {
      expect(responseRef(p, "post", status)).toBe("#/components/schemas/Error");
    }
  });

  it("bulk-dismiss: 200→BulkDismissUnknownItemsResponse, 400/401/403/409/425→Error", () => {
    const p = TENANT_ADMIN_BULK_DISMISS_PATH;
    expect(responseRef(p, "post", 200)).toBe(
      "#/components/schemas/BulkDismissUnknownItemsResponse",
    );
    for (const status of [400, 401, 403, 409, 425]) {
      expect(responseRef(p, "post", status)).toBe("#/components/schemas/Error");
    }
  });

  it("reopen + bulk-dismiss 425 declare a Retry-After header (transport retry signal)", () => {
    for (const p of KEY_BEARING_PATHS) {
      const op = catalogDoc.paths?.[p]?.["post"] as
        | {
            responses?: Record<
              string,
              { headers?: Record<string, unknown> }
            >;
          }
        | undefined;
      expect(op?.responses?.[425]?.headers?.["Retry-After"]).toBeDefined();
    }
  });
});

// ===========================================================================
// 6. Idempotency-Key on new state-changing ops (NOT Idempotency-Token)
// ===========================================================================
describe("catalog/unknown-items.yaml — Idempotency-Key on reopen + bulk-dismiss", () => {
  it.each(KEY_BEARING_PATHS)(
    "%s declares an Idempotency-Key header parameter",
    (path) => {
      const op = catalogDoc.paths?.[path]?.["post"];
      const headers = (op?.parameters ?? []).filter((p) => p.in === "header");
      const key = headers.find((p) => p.name === "Idempotency-Key");
      expect(key).toBeDefined();
    },
  );

  it.each(KEY_BEARING_PATHS)(
    "%s does NOT declare an Idempotency-Token header (T564 drift guard)",
    (path) => {
      const op = catalogDoc.paths?.[path]?.["post"];
      const headerNames = (op?.parameters ?? [])
        .filter((p) => p.in === "header")
        .map((p) => p.name);
      expect(headerNames).not.toContain("Idempotency-Token");
    },
  );

  it.each(KEY_BEARING_PATHS)(
    "%s Idempotency-Key bounds match the runtime IdempotencyInterceptor (16-128, printable-ASCII pattern)",
    (path) => {
      // The runtime interceptor (apps/api/src/idempotency/
      // idempotency.interceptor.ts) enforces /^[\x21-\x7E]{16,128}$/. The
      // contract MUST declare the same bounds — a looser schema (e.g.
      // minLength 1) accepts keys the interceptor then rejects 400, a
      // contract/runtime lie. posCaptureItem already declares these bounds.
      const op = catalogDoc.paths?.[path]?.["post"];
      const key = (op?.parameters ?? []).find(
        (p) => p.in === "header" && p.name === "Idempotency-Key",
      );
      const schema = key?.schema as
        | { minLength?: number; maxLength?: number; pattern?: string }
        | undefined;
      expect(schema?.minLength).toBe(16);
      expect(schema?.maxLength).toBe(128);
      expect(schema?.pattern).toBe("^[\\x21-\\x7E]{16,128}$");
    },
  );

  it("no operation declares an Idempotency-Token header parameter (drift guard, all ops)", () => {
    // Scoped to actual header PARAMETER names — not raw document text. The
    // shipped Wave 1 prose mentions `Idempotency-Token` only to document
    // that it is deliberately NOT used (lines ~67-68), so a whole-document
    // substring guard is unsatisfiable by construction. The meaningful
    // invariant is that no operation declares it as a real header param.
    const offenders = allOperations()
      .filter(({ op }) =>
        (op.parameters ?? []).some(
          (p) => p.in === "header" && p.name === "Idempotency-Token",
        ),
      )
      .map(({ op }) => op.operationId);
    expect(offenders).toEqual([]);
  });
});

// ===========================================================================
// 7. Reopen authority split: 403 forbidden + non-disclosing 404
// ===========================================================================
describe("catalog/unknown-items.yaml — reopen authority responses", () => {
  it.each([
    [403, "tenant-wide authority required, FR-042"],
    [404, "non-disclosing, out-of-scope, SI-004"],
    [409, "already-reconciled when resolved, FR-043"],
  ])("tenantAdminReopenUnknownItem declares a %i response (%s)", (status) => {
    const reopen = catalogDoc.paths?.[TENANT_ADMIN_REOPEN_PATH]?.["post"];
    expect(
      (reopen?.responses as Record<string, unknown> | undefined)?.[status],
    ).toBeDefined();
  });
});

// ===========================================================================
// 7b. Idempotent ops publish the full interceptor retry/conflict surface
// ===========================================================================
// Both new ops declare `x-idempotency: required`, so at runtime the
// IdempotencyInterceptor can emit 425 (in-progress replay) and 409 (key
// conflict). posCapture documents both in this same contract; the new ops
// must too, or contract-generated clients miss real responses (CodeRabbit
// PR #404, verified against idempotency.interceptor.ts:241/283).
describe("catalog/unknown-items.yaml — idempotent ops publish 425 / 409", () => {
  it.each(KEY_BEARING_PATHS)(
    "%s declares a 425 response (Idempotency-Key in-progress replay)",
    (path) => {
      const op = catalogDoc.paths?.[path]?.["post"];
      expect(
        (op?.responses as Record<string, unknown> | undefined)?.[425],
      ).toBeDefined();
    },
  );

  it("tenantAdminBulkDismissUnknownItems declares a 409 response (idempotency_key_conflict)", () => {
    // Reopen already declares 409 (already_reconciled OR key_conflict);
    // bulk-dismiss had none — its only top-level 409 is key_conflict
    // (per-item terminal states surface in the 200 outcome list, not a
    // top-level 409).
    const bulk = catalogDoc.paths?.[TENANT_ADMIN_BULK_DISMISS_PATH]?.["post"];
    expect(
      (bulk?.responses as Record<string, unknown> | undefined)?.[409],
    ).toBeDefined();
  });
});

// ===========================================================================
// 8. Bulk-dismiss ceiling: bounded selection (≤200) — validation on overflow
// ===========================================================================
describe("catalog/unknown-items.yaml — bulk-dismiss bounded selection", () => {
  it("tenantAdminBulkDismissUnknownItems requestBody refs a closed request schema", () => {
    const bulk = catalogDoc.paths?.[TENANT_ADMIN_BULK_DISMISS_PATH]?.["post"];
    const ref =
      bulk?.requestBody?.content?.["application/json"]?.schema?.["$ref"];
    expect(typeof ref).toBe("string");
    const schemaName = (ref ?? "").replace("#/components/schemas/", "");
    const schema = catalogDoc.components?.schemas?.[schemaName];
    expect(schema).toBeDefined();
    expect(schema?.["additionalProperties"]).toBe(false);
  });

  it("the bulk-dismiss request `ids` array declares a maxItems ceiling of 200 (FR-044)", () => {
    const bulk = catalogDoc.paths?.[TENANT_ADMIN_BULK_DISMISS_PATH]?.["post"];
    const ref =
      bulk?.requestBody?.content?.["application/json"]?.schema?.["$ref"] ?? "";
    const schemaName = ref.replace("#/components/schemas/", "");
    const schema = catalogDoc.components?.schemas?.[schemaName];
    const props = schema?.["properties"] as
      | Record<string, { maxItems?: number }>
      | undefined;
    expect(props?.["ids"]?.maxItems).toBe(200);
  });

  it("tenantAdminBulkDismissUnknownItems declares a 400 response (whole-batch reject above ceiling, FR-044)", () => {
    const bulk = catalogDoc.paths?.[TENANT_ADMIN_BULK_DISMISS_PATH]?.["post"];
    expect(
      (bulk?.responses as Record<string, unknown> | undefined)?.[400],
    ).toBeDefined();
  });
});

// ===========================================================================
// 9. List-param extensions — source_system, sort, group_by (US2)
// ===========================================================================
describe("catalog/unknown-items.yaml — list query-param extensions", () => {
  const LIST_PATH = "/api/v1/catalog/unknown-items";

  it.each(["source_system", "sort", "group_by"])(
    "tenantAdminListUnknownItems declares the `%s` query parameter",
    (paramName) => {
      const list = catalogDoc.paths?.[LIST_PATH]?.["get"];
      const names = (list?.parameters ?? [])
        .filter((p) => p.in === "query")
        .map((p) => p.name);
      expect(names).toContain(paramName);
    },
  );
});
