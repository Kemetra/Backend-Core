/**
 * apps/api/test/inventory/contract/inventory.contract.spec.ts
 *
 * Slice 009-CONTRACT (T010 + T011) — OpenAPI conformance test for
 * `packages/contracts/openapi/inventory/inventory.yaml`.
 *
 * Mirrors `apps/api/test/catalog/sales/contract/sales.contract.spec.ts`:
 *
 *   * Loads the new contract via the production `loadOpenApiContracts` helper
 *     with an explicit `dir`, because the helper's directory scan is
 *     non-recursive (`apps/api/src/openapi/loader.ts` uses `readdirSync(dir)`
 *     with no recursive flag). The nested `inventory/` sub-directory is
 *     therefore NOT picked up by the umbrella `loadOpenApiContracts()` call, so
 *     it must be loaded explicitly here. T011 is consequently a no-op: there is
 *     no central YAML registry to extend (same verdict as 005 T504 / 008 T011).
 *
 *   * Asserts presence of the six 009 operationIds and their uniqueness against
 *     the existing top-level contracts (stop condition: "if any operationId
 *     collides with or renames a shipped 005/007/008 operationId").
 *
 *   * Asserts the AUTH SPLIT (plan §4.2): the five operator operations are
 *     secured with `cookieAuth` (NOT a `/api/pos/v1/` device-token surface —
 *     a 009 stop condition); the sale-linked backfill is secured with
 *     `platformAdmin`, never `cookieAuth`.
 *
 *   * Asserts the write operations declare the REQUIRED `Idempotency-Key`
 *     header (FR-030); the read does not.
 *
 *   * Verifies structural conventions: OpenAPI 3.1 of record, the `cookieAuth`
 *     `dp2_session` scheme (mirrors `auth.openapi.yaml` / `outbox.openapi.yaml`),
 *     the canonical `Error` envelope, the on-hand projection carrying the
 *     `negativeBalance` flag (FR-024), strict command schemas (no
 *     mass-assignment, FR-052), and the ABSENCE of any PII / money / payment /
 *     tender field name (§XIV).
 *
 * The spec is structural / load-only (no app boot, no HTTP requests). The
 * controller / service are authored in the 009-US1-ONHAND slice onward.
 */
import "reflect-metadata";

import { resolve } from "node:path";

import { loadOpenApiContracts } from "../../../src/openapi/loader";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NEW_CONTRACT_ID = "inventory";

const OPERATION_IDS = [
  "createStockMovement",
  "getOnHand",
  "listStockMovements",
  "createStockTransfer",
  "recordStockCount",
  "backfillSaleLinkedMovements",
] as const;

// Operator-surface ops use cookieAuth; the backfill is platform/admin.
const OPERATOR_OPERATION_IDS = [
  "createStockMovement",
  "getOnHand",
  "listStockMovements",
  "createStockTransfer",
  "recordStockCount",
];
const ADMIN_OPERATION_IDS = ["backfillSaleLinkedMovements"];

// Write ops that MUST carry a required Idempotency-Key.
const WRITE_OPERATION_IDS = [
  "createStockMovement",
  "createStockTransfer",
  "recordStockCount",
  "backfillSaleLinkedMovements",
];
const READ_OPERATION_IDS = ["getOnHand", "listStockMovements"];

const MOVEMENTS_PATH = "/api/inventory/v1/stores/{storeId}/movements";
const ON_HAND_PATH = "/api/inventory/v1/on-hand/{storeId}/{productId}";
const TRANSFERS_PATH = "/api/inventory/v1/transfers";
const COUNTS_PATH = "/api/inventory/v1/stores/{storeId}/counts";
const BACKFILL_PATH = "/api/inventory/v1/admin/sale-linked-backfill";

// Field-name substrings forbidden anywhere in the contract (§XIV — no PII /
// money / payment / tender on the inventory ledger in v1).
const FORBIDDEN_FIELD_SUBSTRINGS = [
  "currency",
  "money",
  "amount",
  "price",
  "tender",
  "payment",
  "card",
  "cash",
  "customer",
  "email",
  "phone",
  "address",
];

// ---------------------------------------------------------------------------
// Shared types — keep narrow; the loader returns `unknown` documents.
// ---------------------------------------------------------------------------

interface OperationObject {
  operationId?: string;
  security?: Array<Record<string, unknown>>;
  parameters?: Array<{
    $ref?: string;
    in?: string;
    name?: string;
    required?: boolean;
    schema?: Record<string, unknown>;
  }>;
  requestBody?: Record<string, unknown>;
  responses?: Record<string, unknown>;
}

type PathItem = Record<string, OperationObject>;

interface SchemaObject {
  type?: string | string[];
  pattern?: string;
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
    parameters?: Record<string, Record<string, unknown>>;
    responses?: Record<string, Record<string, unknown>>;
  };
  security?: Array<Record<string, unknown>>;
  tags?: Array<{ name?: string }>;
}

let inventoryDoc: OpenApiDocument;
let topLevelOperationIds: Set<string>;

/**
 * Resolve the inventory contract directory from this spec file's location.
 *
 * Layout:
 *   apps/api/test/inventory/contract/inventory.contract.spec.ts
 *   →  ../../../../..  = <repo root>
 *   →  <repo root>/packages/contracts/openapi/inventory
 */
function inventoryContractsDir(): string {
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
    "inventory",
  );
}

beforeAll(() => {
  const inventoryContracts = loadOpenApiContracts({ dir: inventoryContractsDir() });
  const newContract = inventoryContracts.find((c) => c.id === NEW_CONTRACT_ID);
  if (!newContract) {
    const ids = inventoryContracts.map((c) => c.id).join(", ");
    throw new Error(
      `${NEW_CONTRACT_ID} contract not found under ${inventoryContractsDir()}; loaded ids: [${ids}]`,
    );
  }
  inventoryDoc = newContract.document as OpenApiDocument;

  // Build the set of operationIds across the *existing* top-level contracts so
  // the uniqueness check can reject any collision/rename. The default-dir
  // loader exercises the same surface production startup uses.
  const topLevelContracts = loadOpenApiContracts();
  topLevelOperationIds = new Set<string>();
  for (const contract of topLevelContracts) {
    const doc = contract.document as OpenApiDocument;
    if (!doc.paths) continue;
    for (const path of Object.values(doc.paths)) {
      for (const op of Object.values(path)) {
        if (op && typeof op.operationId === "string") {
          topLevelOperationIds.add(op.operationId);
        }
      }
    }
  }
});

function inventoryOperations(): Array<{
  path: string;
  method: string;
  op: OperationObject;
}> {
  const out: Array<{ path: string; method: string; op: OperationObject }> = [];
  const paths = inventoryDoc.paths ?? {};
  for (const [path, item] of Object.entries(paths)) {
    for (const [method, op] of Object.entries(item)) {
      out.push({ path, method, op });
    }
  }
  return out;
}

function findOp(operationId: string): OperationObject | undefined {
  return inventoryOperations().find((o) => o.op.operationId === operationId)?.op;
}

// ===========================================================================
// 1. Loadability + document-level conventions
// ===========================================================================
describe("inventory/inventory.yaml — loadability", () => {
  it("is parseable by the production OpenAPI loader", () => {
    expect(inventoryDoc).toBeDefined();
    expect(typeof inventoryDoc).toBe("object");
  });

  it("declares OpenAPI 3.1 of record (matches the other contracts in this repo)", () => {
    expect(inventoryDoc.openapi).toBe("3.1.0");
  });

  it("declares an info block with title and a *-draft version", () => {
    expect(inventoryDoc.info?.title).toEqual(expect.any(String));
    expect(inventoryDoc.info?.version).toEqual(expect.stringMatching(/-draft$/));
  });

  it("declares the cookieAuth dp2_session scheme (mirrors auth/outbox contracts)", () => {
    const schemes = inventoryDoc.components?.securitySchemes ?? {};
    const cookie = schemes["cookieAuth"] as
      | { type?: string; in?: string; name?: string }
      | undefined;
    expect(cookie?.type).toBe("apiKey");
    expect(cookie?.in).toBe("cookie");
    expect(cookie?.name).toBe("dp2_session");
  });

  it("declares the platformAdmin scheme for the backfill path", () => {
    const schemes = inventoryDoc.components?.securitySchemes ?? {};
    expect(schemes["platformAdmin"]).toBeDefined();
  });
});

// ===========================================================================
// 2. Operations present, uniquely named, correctly secured
// ===========================================================================
describe("inventory/inventory.yaml — operations", () => {
  it("declares exactly the six 009 operationIds", () => {
    const ids = inventoryOperations()
      .map((o) => o.op.operationId)
      .filter((id): id is string => typeof id === "string")
      .sort();
    expect(ids).toEqual([...OPERATION_IDS].sort());
  });

  it("maps each operationId to its expected path + method", () => {
    expect(inventoryDoc.paths?.[MOVEMENTS_PATH]?.["post"]?.operationId).toBe(
      "createStockMovement",
    );
    expect(inventoryDoc.paths?.[MOVEMENTS_PATH]?.["get"]?.operationId).toBe(
      "listStockMovements",
    );
    expect(inventoryDoc.paths?.[ON_HAND_PATH]?.["get"]?.operationId).toBe("getOnHand");
    expect(inventoryDoc.paths?.[TRANSFERS_PATH]?.["post"]?.operationId).toBe(
      "createStockTransfer",
    );
    expect(inventoryDoc.paths?.[COUNTS_PATH]?.["post"]?.operationId).toBe(
      "recordStockCount",
    );
    expect(inventoryDoc.paths?.[BACKFILL_PATH]?.["post"]?.operationId).toBe(
      "backfillSaleLinkedMovements",
    );
  });

  it("does NOT collide with or rename any shipped top-level operationId", () => {
    for (const id of OPERATION_IDS) {
      expect(topLevelOperationIds.has(id)).toBe(false);
    }
  });

  it("secures every operator operation with cookieAuth", () => {
    for (const id of OPERATOR_OPERATION_IDS) {
      const op = findOp(id);
      expect(op).toBeDefined();
      expect(op?.security).toContainEqual({ cookieAuth: [] });
    }
  });

  it("secures the backfill with platformAdmin, NOT cookieAuth", () => {
    for (const id of ADMIN_OPERATION_IDS) {
      const op = findOp(id);
      expect(op).toBeDefined();
      expect(op?.security).toContainEqual({ platformAdmin: [] });
      expect(op?.security).not.toContainEqual({ cookieAuth: [] });
    }
  });

  it("models NO operation as a /api/pos/v1/ device-token route (009 is a cookieAuth surface)", () => {
    const paths = Object.keys(inventoryDoc.paths ?? {});
    for (const p of paths) {
      expect(p.startsWith("/api/pos/")).toBe(false);
      expect(p.startsWith("/api/inventory/v1/")).toBe(true);
    }
  });
});

// ===========================================================================
// 3. Idempotency — required Idempotency-Key on every write
// ===========================================================================
describe("inventory/inventory.yaml — idempotency", () => {
  it("requires the Idempotency-Key header on every write operation", () => {
    for (const id of WRITE_OPERATION_IDS) {
      const op = findOp(id);
      expect(op).toBeDefined();
      const params = op?.parameters ?? [];
      const hasIdempotencyRef = params.some(
        (p) => p.$ref === "#/components/parameters/IdempotencyKey",
      );
      expect(hasIdempotencyRef).toBe(true);
    }
    const idemParam = inventoryDoc.components?.parameters?.["IdempotencyKey"] as
      | { name?: string; in?: string; required?: boolean }
      | undefined;
    expect(idemParam?.name).toBe("Idempotency-Key");
    expect(idemParam?.in).toBe("header");
    expect(idemParam?.required).toBe(true);
  });

  it("does NOT require an Idempotency-Key on read operations", () => {
    for (const id of READ_OPERATION_IDS) {
      const params = findOp(id)?.parameters ?? [];
      const hasIdempotencyRef = params.some(
        (p) => p.$ref === "#/components/parameters/IdempotencyKey",
      );
      expect(hasIdempotencyRef).toBe(false);
    }
  });
});

// ===========================================================================
// 4. Projections + envelope conventions
// ===========================================================================
describe("inventory/inventory.yaml — projections + envelope", () => {
  it("declares the canonical Error envelope (error.code + error.message)", () => {
    const err = inventoryDoc.components?.schemas?.["Error"];
    expect(err).toBeDefined();
    expect(err?.required).toContain("error");
  });

  it("movement projection carries the acting principal createdBy (FR-004)", () => {
    const mv = inventoryDoc.components?.schemas?.["StockMovement"];
    expect(mv).toBeDefined();
    expect(mv?.required).toContain("createdBy");
    const props = (mv?.properties ?? {}) as Record<string, { format?: string }>;
    expect(props["createdBy"]).toBeDefined();
  });

  it("on-hand projection carries the negativeBalance flag (FR-024)", () => {
    const onHand = inventoryDoc.components?.schemas?.["OnHand"];
    expect(onHand).toBeDefined();
    expect(onHand?.required).toContain("negativeBalance");
    const props = (onHand?.properties ?? {}) as Record<
      string,
      { type?: string | string[] }
    >;
    expect(props["negativeBalance"]?.type).toBe("boolean");
  });

  it("bounds DecimalQuantity to the numeric(19,4) Zod shape", () => {
    // inventory.controller.ts DecimalQtySchema: ≤15 integer digits, ≤4 fraction digits.
    expect(inventoryDoc.components?.schemas?.["DecimalQuantity"]?.pattern).toBe(
      "^-?\\d{1,15}(\\.\\d{1,4})?$",
    );
  });

  it("command schemas are strict (additionalProperties: false — mass-assignment ban, FR-052)", () => {
    const commandSchemas = [
      "CreateStockMovementCommand",
      "CreateStockTransferCommand",
      "RecordStockCountCommand",
      "SaleLinkedBackfillCommand",
    ];
    for (const name of commandSchemas) {
      const schema = inventoryDoc.components?.schemas?.[name];
      expect(schema).toBeDefined();
      expect(schema?.additionalProperties).toBe(false);
    }
  });
});

// ===========================================================================
// 5. No PII / money / payment / tender field names anywhere (§XIV)
// ===========================================================================
describe("inventory/inventory.yaml — §XIV no PII/payment", () => {
  it("declares no field name matching a PII / money / payment / tender substring", () => {
    const offenders: string[] = [];
    const schemas = inventoryDoc.components?.schemas ?? {};
    for (const [schemaName, schema] of Object.entries(schemas)) {
      const props = schema.properties ?? {};
      for (const fieldName of Object.keys(props)) {
        const lower = fieldName.toLowerCase();
        for (const bad of FORBIDDEN_FIELD_SUBSTRINGS) {
          if (lower.includes(bad)) {
            offenders.push(`${schemaName}.${fieldName} (matched "${bad}")`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
