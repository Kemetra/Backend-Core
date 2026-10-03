/**
 * apps/api/test/catalog/sales/contract/sales.contract.spec.ts
 *
 * Slice 008-CONTRACT (T010 + T011) — OpenAPI conformance test for
 * `packages/contracts/openapi/pos-sales/sales.yaml`.
 *
 * Mirrors `apps/api/test/catalog/unknown-items/contract.spec.ts`:
 *
 *   * Loads the new contract via the production `loadOpenApiContracts`
 *     helper with an explicit `dir`, because the helper's directory scan is
 *     non-recursive (`apps/api/src/openapi/loader.ts` uses `readdirSync(dir)`
 *     with no recursive flag). The nested `pos-sales/` sub-directory is
 *     therefore NOT picked up by the umbrella `loadOpenApiContracts()` call,
 *     so it must be loaded explicitly here. T011 is consequently a no-op:
 *     there is no central YAML registry to extend (same verdict as 005 T504).
 *
 *   * Asserts presence of the four 008 operationIds (`captureSale`,
 *     `recordVoid`, `recordRefund`, `readSale`) plus the RT-72
 *     `recordReturn`, and their uniqueness against
 *     the existing top-level contracts (the slice's stop condition is "if any
 *     operationId collides with or renames a shipped 005/007 operationId").
 *
 *   * Asserts the write operations declare the REQUIRED `Idempotency-Key`
 *     header (FR-051), aligning with the existing `IdempotencyInterceptor`
 *     and the `posCaptureItem` precedent.
 *
 *   * Verifies structural conventions shared with the other contracts:
 *     OpenAPI 3.1 of record, `clerkJwt` POS security scheme defined and
 *     referenced, canonical `Error` envelope, and the FR-101 failure-category
 *     responses. Tender fields appear only where the owner approved them
 *     (RT-14 D3 return tender, RT-10 D1 sale tender); gate A.5 bans the rest.
 *
 * The spec is structural / load-only (no app boot, no HTTP requests). The
 * controller / service are authored in the 008-US1-CAPTURE slice onward.
 */
import "reflect-metadata";

import { resolve } from "node:path";

import { loadOpenApiContracts } from "../../../../src/openapi/loader";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NEW_CONTRACT_ID = "sales";

const OPERATION_IDS = [
  "captureSale",
  "recordVoid",
  "recordRefund",
  "readSale",
  "recordReturn",
] as const;

const WRITE_OPERATION_IDS = [
  "captureSale",
  "recordVoid",
  "recordRefund",
  "recordReturn",
];

const CAPTURE_PATH = "/api/pos/v1/sales";
const READ_PATH = "/api/pos/v1/sales/{saleRef}";
const VOID_PATH = "/api/pos/v1/sales/{saleRef}/void";
const REFUND_PATH = "/api/pos/v1/sales/{saleRef}/refund";
const RETURNS_PATH = "/api/pos/v1/sales/{saleRef}/returns";

/**
 * The owner-approved tender fields — the only `schema.property` pairs exempt
 * from the gate A.5 tender-field ban:
 *   - RT-14 D3: a return records its refund tender (`refundTenders`);
 *   - RT-10 D1: a sale carries its tender facts (`tenders`) on capture and read.
 * Any other tender/payment-named field is still a violation.
 */
const APPROVED_TENDER_FIELDS = [
  "RecordReturnRequest.refundTenders",
  "SaleReturn.refundTenders",
  "CaptureSaleRequest.tenders",
  "Sale.tenders",
];

/** RT-10 D2: the pilot tender methods. `voucher` is deliberately excluded. */
const PILOT_TENDER_METHODS = ["card_external", "cash"];

/**
 * Resolve the pos-sales contract directory from this spec file's location.
 *
 * Layout:
 *   apps/api/test/catalog/sales/contract/sales.contract.spec.ts
 *   →  ../../../../../..        = <repo root>
 *   →  ../../../../../../packages/contracts/openapi/pos-sales
 */
function posSalesContractsDir(): string {
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
    "pos-sales",
  );
}

// ---------------------------------------------------------------------------
// Shared types — keep narrow; the loader returns `unknown` documents.
// ---------------------------------------------------------------------------

interface OperationObject {
  operationId?: string;
  deprecated?: boolean;
  "x-runtime-status"?: string;
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
  additionalProperties?: boolean | Record<string, unknown>;
  required?: string[];
  properties?: Record<string, unknown>;
}

interface OpenApiDocument {
  openapi?: string;
  info?: { title?: string; version?: string; description?: string };
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

// Lazy-loaded once per file; populated in beforeAll.
let salesDoc: OpenApiDocument;
let topLevelOperationIds: Set<string>;

beforeAll(() => {
  const posSalesContracts = loadOpenApiContracts({ dir: posSalesContractsDir() });
  const newContract = posSalesContracts.find((c) => c.id === NEW_CONTRACT_ID);
  if (!newContract) {
    const ids = posSalesContracts.map((c) => c.id).join(", ");
    throw new Error(
      `${NEW_CONTRACT_ID} contract not found under ${posSalesContractsDir()}; loaded ids: [${ids}]`,
    );
  }
  salesDoc = newContract.document as OpenApiDocument;

  // Build the set of operationIds across the *existing* top-level contracts
  // so the uniqueness check below can reject any collision/rename. We call
  // the default-dir loader (no `dir:` override) to exercise the same surface
  // the production startup uses.
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

// Helper — flatten every operation in the new contract.
function salesOperations(): Array<{
  path: string;
  method: string;
  op: OperationObject;
}> {
  const out: Array<{ path: string; method: string; op: OperationObject }> = [];
  const paths = salesDoc.paths ?? {};
  for (const [path, item] of Object.entries(paths)) {
    for (const [method, op] of Object.entries(item)) {
      out.push({ path, method, op });
    }
  }
  return out;
}

function findOp(operationId: string): OperationObject | undefined {
  return salesOperations().find((o) => o.op.operationId === operationId)?.op;
}

// ===========================================================================
// 1. Loadability + document-level conventions
// ===========================================================================
describe("pos-sales/sales.yaml — loadability", () => {
  it("is parseable by the production OpenAPI loader", () => {
    expect(salesDoc).toBeDefined();
    expect(typeof salesDoc).toBe("object");
  });

  it("declares OpenAPI 3.1 of record (matches the other contracts in this repo)", () => {
    expect(salesDoc.openapi).toBe("3.1.0");
  });

  it("declares an info block with title and a *-draft version", () => {
    expect(salesDoc.info?.title).toEqual(expect.any(String));
    expect(salesDoc.info?.version).toEqual(expect.stringMatching(/-draft$/));
  });

  it("declares the operatorAuthorization scheme (031 D1+D2 envelope; NOT clerkJwt)", () => {
    const schemes = salesDoc.components?.securitySchemes ?? {};
    // 031 retired clerkJwt on the sale routes in favour of the opaque
    // operator-authorization envelope; the old Clerk-JWT scheme is gone.
    expect(schemes["operatorAuthorization"]).toBeDefined();
    expect(schemes["clerkJwt"]).toBeUndefined();
    // The envelope is opaque, not a JWT — no bearerFormat.
    const scheme = schemes["operatorAuthorization"] as { type?: string; scheme?: string; bearerFormat?: string };
    expect(scheme.type).toBe("http");
    expect(scheme.scheme).toBe("bearer");
    expect(scheme.bearerFormat).toBeUndefined();
    // MUST NOT reuse spec 030's identity-proof-only scheme.
    expect(schemes["operator-identity"]).toBeUndefined();
  });
});

// ===========================================================================
// 2. Operations present, uniquely named, POS-secured
// ===========================================================================
describe("pos-sales/sales.yaml — operations", () => {
  it("declares exactly the four 008 operationIds plus the RT-72 recordReturn", () => {
    const ids = salesOperations()
      .map((o) => o.op.operationId)
      .filter((id): id is string => typeof id === "string")
      .sort();
    expect(ids).toEqual([...OPERATION_IDS].sort());
  });

  it("maps each operationId to its expected path", () => {
    expect(findOp("captureSale")).toBeDefined();
    expect(salesDoc.paths?.[CAPTURE_PATH]?.["post"]?.operationId).toBe("captureSale");
    expect(salesDoc.paths?.[READ_PATH]?.["get"]?.operationId).toBe("readSale");
    expect(salesDoc.paths?.[VOID_PATH]?.["post"]?.operationId).toBe("recordVoid");
    expect(salesDoc.paths?.[REFUND_PATH]?.["post"]?.operationId).toBe("recordRefund");
    expect(salesDoc.paths?.[RETURNS_PATH]?.["post"]?.operationId).toBe("recordReturn");
  });

  it("does NOT collide with or rename any shipped top-level operationId", () => {
    for (const id of OPERATION_IDS) {
      expect(topLevelOperationIds.has(id)).toBe(false);
    }
  });

  it("secures every operation with the operatorAuthorization envelope (031 D1+D2)", () => {
    for (const { op } of salesOperations()) {
      expect(op.security).toContainEqual({ operatorAuthorization: [] });
    }
  });
});

// ===========================================================================
// 3. Idempotency — required Idempotency-Key on every write
// ===========================================================================
describe("pos-sales/sales.yaml — idempotency", () => {
  it("requires the Idempotency-Key header on every write operation", () => {
    for (const id of WRITE_OPERATION_IDS) {
      const op = findOp(id);
      expect(op).toBeDefined();
      const params = op?.parameters ?? [];
      // The header is declared via a $ref to components.parameters.IdempotencyKey.
      const hasIdempotencyRef = params.some(
        (p) => p.$ref === "#/components/parameters/IdempotencyKey",
      );
      expect(hasIdempotencyRef).toBe(true);
    }
    // The shared parameter itself is REQUIRED and named correctly.
    const idemParam = salesDoc.components?.parameters?.["IdempotencyKey"] as
      | { name?: string; in?: string; required?: boolean }
      | undefined;
    expect(idemParam?.name).toBe("Idempotency-Key");
    expect(idemParam?.in).toBe("header");
    expect(idemParam?.required).toBe(true);
  });

  it("does NOT require an Idempotency-Key on the read", () => {
    const params = findOp("readSale")?.parameters ?? [];
    const hasIdempotencyRef = params.some(
      (p) => p.$ref === "#/components/parameters/IdempotencyKey",
    );
    expect(hasIdempotencyRef).toBe(false);
  });
});

// ===========================================================================
// 4. Error envelope + FR-101 failure categories
// ===========================================================================
describe("pos-sales/sales.yaml — error vocabulary", () => {
  it("defines a canonical Error envelope { error: { code, message } }", () => {
    const errorSchema = salesDoc.components?.schemas?.["Error"];
    expect(errorSchema).toBeDefined();
    expect(errorSchema?.required).toContain("error");
  });

  it("declares the FR-101 failure-category responses", () => {
    const responses = salesDoc.components?.responses ?? {};
    for (const name of [
      "ValidationFailure",
      "Unauthorized",
      "NotFound",
      "Conflict",
      "AlreadyApplied",
      "SystemFailure",
    ]) {
      expect(responses[name]).toBeDefined();
    }
  });

  it("maps capture to 200(replay)/201/400/401/409/500 and reads to 200/401/404", () => {
    const capture = salesDoc.paths?.[CAPTURE_PATH]?.["post"]?.responses ?? {};
    expect(Object.keys(capture)).toEqual(
      expect.arrayContaining(["200", "201", "400", "401", "409", "500"]),
    );
    const read = salesDoc.paths?.[READ_PATH]?.["get"]?.responses ?? {};
    expect(Object.keys(read)).toEqual(
      expect.arrayContaining(["200", "401", "404", "500"]),
    );
  });

  it("declares a documented 200 idempotent-replay (Idempotent-Replayed header) on every write", () => {
    for (const p of [CAPTURE_PATH, VOID_PATH, REFUND_PATH, RETURNS_PATH]) {
      const post = salesDoc.paths?.[p]?.["post"];
      const ok = (post?.responses ?? {})["200"] as
        | { headers?: Record<string, unknown> }
        | undefined;
      expect(ok).toBeDefined();
      expect(ok?.headers).toHaveProperty("Idempotent-Replayed");
    }
  });

  // RT-82 K4: a same-Idempotency-Key replay keeps the stored status (201), so
  // the 201 must document the replay header too; clients key on the header.
  it("declares Idempotent-Replayed on every write's 201 (stored-status replay, RT-82 K4)", () => {
    for (const p of [CAPTURE_PATH, VOID_PATH, REFUND_PATH, RETURNS_PATH]) {
      const created = (salesDoc.paths?.[p]?.["post"]?.responses ?? {})["201"] as
        | { headers?: Record<string, unknown> }
        | undefined;
      expect(created?.headers).toHaveProperty("Idempotent-Replayed");
    }
  });

  // RT-82 K1: the replay key is per resource (resolved path params) and the
  // clientId is the operator, not the device.
  it("documents per-resource idempotency keying on the operator principal (RT-82 K1)", () => {
    const param = salesDoc.components?.parameters?.["IdempotencyKey"] as
      | { description?: string }
      | undefined;
    expect(param?.description).toMatch(/resolved path parameters/);
    expect(param?.description).toMatch(/operator/);
    expect(param?.description).not.toMatch(/POS device principal/);
  });
});

// ===========================================================================
// 5. Object-safety + no-tender invariants encoded in the contract
// ===========================================================================
describe("pos-sales/sales.yaml — object safety + gate A.5 (no tender)", () => {
  it("declares strict request schemas (additionalProperties: false)", () => {
    const schemas = salesDoc.components?.schemas ?? {};
    for (const name of [
      "CaptureSaleRequest",
      "CaptureSaleLine",
      "RecordVoidRequest",
      "RecordRefundRequest",
      "RecordReturnRequest",
      "ReturnLineRequest",
      "RefundTender",
      "SaleTender",
    ]) {
      expect(schemas[name]?.additionalProperties).toBe(false);
    }
  });

  it("does NOT accept body-supplied tenant/store/actor on capture (FR-061)", () => {
    const props = salesDoc.components?.schemas?.["CaptureSaleRequest"]?.properties ?? {};
    for (const banned of [
      "tenant_id",
      "tenantId",
      "store_id",
      "storeId",
      "created_by",
      "createdBy",
      "received_at",
      "receivedAt",
      "business_date",
      "businessDate",
      "processed_at",
      "processedAt",
      "mismatch_flag",
      "mismatchFlag",
    ]) {
      expect(props).not.toHaveProperty(banned);
    }
  });

  it("declares no tender/payment field NAMES outside the owner-approved tender fields (gate A.5)", () => {
    // Gate A.5 bans tender/payment *fields* — not the word "tender" in the
    // prose. So inspect property names across every component schema, not the
    // whole serialized document. Only APPROVED_TENDER_FIELDS (RT-14 D3, RT-10
    // D1) are exempt — field by field, so a new tender-named field on any
    // schema (even one that already carries an approved field) still fails.
    const bannedFieldFragments = [
      "tender",
      "paymentmethod",
      "payment_method",
      "card",
      "cash",
    ];
    const isBanned = (prop: string): boolean =>
      bannedFieldFragments.some((banned) => prop.toLowerCase().includes(banned));
    const offending = Object.entries(salesDoc.components?.schemas ?? {})
      .flatMap(([schemaName, schema]) =>
        Object.keys(schema.properties ?? {})
          .filter(isBanned)
          .map((prop) => `${schemaName}.${prop}`),
      )
      .filter((field) => !APPROVED_TENDER_FIELDS.includes(field));
    expect(offending).toEqual([]);
  });
});

// ===========================================================================
// 6. CodeRabbit review invariants (PR #422)
// ===========================================================================
describe("pos-sales/sales.yaml — review-hardening invariants", () => {
  function props(schema: string): Record<string, unknown> {
    return (salesDoc.components?.schemas?.[schema]?.properties ?? {}) as Record<
      string,
      unknown
    >;
  }

  it("Error envelope matches the shared auth/outbox shape verbatim (no details, exactly code/message/request_id)", () => {
    const errorSchema = salesDoc.components?.schemas?.["Error"] as
      | { properties?: { error?: { properties?: Record<string, unknown> } } }
      | undefined;
    const inner = errorSchema?.properties?.error?.properties ?? {};
    expect(Object.keys(inner).sort()).toEqual(
      ["code", "message", "request_id"].sort(),
    );
    expect(inner).not.toHaveProperty("details");
  });

  it("terminal events carry no occurredAt (no occurred_at column on sale_voids/sale_refunds)", () => {
    expect(props("RecordVoidRequest")).not.toHaveProperty("occurredAt");
    expect(props("RecordRefundRequest")).not.toHaveProperty("occurredAt");
    expect(props("SaleTerminalEvent")).not.toHaveProperty("occurredAt");
    // recordedAt (server-clock stamp) is the only timestamp.
    expect(props("SaleTerminalEvent")).toHaveProperty("recordedAt");
  });

  it("nullable money/currency fields still reuse the DecimalAmount/CurrencyCode schemas (anyOf)", () => {
    const checks: Array<{ schema: string; field: string; ref: string }> = [
      { schema: "SaleLine", field: "taxAmount", ref: "#/components/schemas/DecimalAmount" },
      { schema: "SaleTerminalEvent", field: "posRefundAmount", ref: "#/components/schemas/DecimalAmount" },
      { schema: "SaleTerminalEvent", field: "currencyCode", ref: "#/components/schemas/CurrencyCode" },
    ];
    for (const { schema, field, ref } of checks) {
      const f = props(schema)[field] as { anyOf?: Array<Record<string, unknown>> } | undefined;
      expect(f?.anyOf).toBeDefined();
      const refs = (f?.anyOf ?? []).map((m) => m["$ref"]);
      const hasNull = (f?.anyOf ?? []).some((m) => m["type"] === "null");
      expect(refs).toContain(ref);
      expect(hasNull).toBe(true);
    }
  });
});

// ===========================================================================
// 7. RT-72 — line-aware returns contract (RT-14 D1–D8, RT-63)
// ===========================================================================
describe("pos-sales/sales.yaml — RT-72 returns contract", () => {
  function schema(name: string): SchemaObject | undefined {
    return salesDoc.components?.schemas?.[name];
  }
  function prop<T>(name: string, field: string): T | undefined {
    return (schema(name)?.properties ?? {})[field] as T | undefined;
  }

  it("recordReturn is live (RT-73) and documents its POS_RETURNS_ENABLED gate (AC4)", () => {
    const op = findOp("recordReturn") as (OperationObject & { description?: string; "x-runtime-note"?: string }) | undefined;
    expect(op?.["x-runtime-status"]).toBeUndefined();
    expect(op?.["x-runtime-note"]).toMatch(/POS_RETURNS_ENABLED/);
    expect(op?.description).toMatch(/POS_RETURNS_ENABLED/);
  });

  it("the returns gate waits for Connector settlement (RT-78) as well as returns (RT-16) (review #650)", () => {
    const op = findOp("recordReturn") as (OperationObject & { description?: string; "x-runtime-note"?: string }) | undefined;
    for (const text of [op?.["x-runtime-note"] ?? "", op?.description ?? ""]) {
      expect(text).toMatch(/RT-16/);
      expect(text).toMatch(/RT-78/);
    }
  });

  it("prices returns by the cumulative-difference rule (option (a), RT-73 comment 10406)", () => {
    const op = findOp("recordReturn") as (OperationObject & { description?: string }) | undefined;
    expect(op?.description).toMatch(/round4\(A × \(c \+ q\) \/ Q\) − round4\(A × c \/ Q\)/);
    expect(op?.description).not.toMatch(/EXACT\s+remainder instead/);
  });

  it("deprecates the amount-only recordRefund for new use (D1)", () => {
    expect(findOp("recordRefund")?.deprecated).toBe(true);
    expect(findOp("recordReturn")?.deprecated).not.toBe(true);
  });

  it("the return request names lines by lineRef + quantity only — the server computes all money (D1)", () => {
    expect(schema("RecordReturnRequest")?.required?.sort()).toEqual(
      ["externalId", "lines", "refundTenders", "sourceSystem"].sort(),
    );
    const lineProps = Object.keys(schema("ReturnLineRequest")?.properties ?? {}).sort();
    expect(lineProps).toEqual(["lineRef", "quantity"]);
    expect(schema("ReturnLineRequest")?.required?.sort()).toEqual(["lineRef", "quantity"]);
    expect(prop<{ format?: string }>("ReturnLineRequest", "lineRef")?.format).toBe("uuid");
  });

  it("records the refund tender as cash-only for the pilot (D3)", () => {
    expect(schema("RefundTender")?.required?.sort()).toEqual(["amount", "method"]);
    expect(prop<{ enum?: string[] }>("RefundTender", "method")?.enum).toEqual(["cash"]);
  });

  it("maps recordReturn to 200(replay)/201/400/401/404/409/422/500 with return-specific 409/422", () => {
    const responses = (findOp("recordReturn")?.responses ?? {}) as Record<string, { $ref?: string }>;
    expect(Object.keys(responses)).toEqual(
      expect.arrayContaining(["200", "201", "400", "401", "404", "409", "422", "500"]),
    );
    expect(responses["409"]?.$ref).toBe("#/components/responses/ReversalConflict");
    expect(responses["422"]?.$ref).toBe("#/components/responses/ReturnTenderMismatch");
  });

  it("a void conflicting with a return shares the reversal-conflict vocabulary (D2)", () => {
    const responses = (findOp("recordVoid")?.responses ?? {}) as Record<string, { $ref?: string }>;
    expect(responses["409"]?.$ref).toBe("#/components/responses/ReversalConflict");
  });

  it("the return projection is strict and leaks no DB internals (§IV)", () => {
    expect(schema("SaleReturn")?.additionalProperties).toBe(false);
    expect(schema("ReturnLine")?.additionalProperties).toBe(false);
    const props = schema("SaleReturn")?.properties ?? {};
    for (const leak of ["tenant_id", "tenantId", "payload_hash", "payloadHash", "created_by", "createdBy"]) {
      expect(props).not.toHaveProperty(leak);
    }
    expect(schema("SaleReturn")?.required).toEqual(
      expect.arrayContaining(["returnRef", "saleRef", "recordedAt", "businessDate", "returnTotal", "lines"]),
    );
  });

  it("sale lines expose lineRef + returnability and the sale exposes voided (additive)", () => {
    expect(prop<{ format?: string }>("SaleLine", "lineRef")?.format).toBe("uuid");
    expect(schema("SaleLine")?.properties).toHaveProperty("returnedQuantity");
    expect(schema("SaleLine")?.properties).toHaveProperty("returnableQuantity");
    expect(prop<{ type?: string }>("Sale", "voided")?.type).toBe("boolean");
  });

  it("requires the RT-72 read fields now that RT-73 emits them", () => {
    expect(schema("SaleLine")?.required).toEqual(
      expect.arrayContaining(["lineRef", "returnedQuantity", "returnableQuantity"]),
    );
    expect(schema("Sale")?.required).toEqual(expect.arrayContaining(["voided"]));
  });
});

// ===========================================================================
// 8. RT-76 — sale tender contract (RT-10 D1/D2/D7/D8)
// ===========================================================================
describe("pos-sales/sales.yaml — RT-76 sale tender contract", () => {
  function schema(name: string): SchemaObject | undefined {
    return salesDoc.components?.schemas?.[name];
  }
  function prop<T>(name: string, field: string): T | undefined {
    return (schema(name)?.properties ?? {})[field] as T | undefined;
  }
  type ArrayProp = { type?: string; minItems?: number; items?: { $ref?: string } };

  it("capture accepts an OPTIONAL tenders list — absent means a tender-unknown sale (D1/D8)", () => {
    expect(schema("CaptureSaleRequest")?.required).not.toContain("tenders");
    const tenders = prop<ArrayProp>("CaptureSaleRequest", "tenders");
    expect(tenders?.type).toBe("array");
    expect(tenders?.minItems).toBe(1);
    expect(tenders?.items?.$ref).toBe("#/components/schemas/SaleTender");
  });

  it("a sale tender is strict {method, amount, reference?} with non-negative decimal money (D1)", () => {
    expect(schema("SaleTender")?.additionalProperties).toBe(false);
    expect(schema("SaleTender")?.required?.sort()).toEqual(["amount", "method"]);
    expect(Object.keys(schema("SaleTender")?.properties ?? {}).sort()).toEqual(
      ["amount", "method", "reference"],
    );
    expect(prop<{ $ref?: string }>("SaleTender", "amount")?.$ref).toBe(
      "#/components/schemas/NonNegativeDecimalAmount",
    );
  });

  it("the pilot tender methods are cash + card_external; voucher is excluded (D2)", () => {
    const method = prop<{ enum?: string[] }>("SaleTender", "method");
    expect(method?.enum?.slice().sort()).toEqual(PILOT_TENDER_METHODS);
    expect(method?.enum).not.toContain("voucher");
  });

  it("the card reference is a short terminal reference, never a card number (D1)", () => {
    const reference = prop<{ type?: string; pattern?: string }>("SaleTender", "reference");
    expect(reference?.type).toBe("string");
    expect(reference?.pattern).toBe("^[A-Z0-9]{1,6}$");
  });

  it("the schema itself forbids a reference on a cash tender (card-only, review #645)", () => {
    const tender = schema("SaleTender") as
      | (SchemaObject & { if?: unknown; then?: unknown })
      | undefined;
    expect(tender?.if).toEqual({ properties: { method: { const: "cash" } }, required: ["method"] });
    expect(tender?.then).toEqual({ not: { required: ["reference"] } });
  });

  it("no longer describes return settlement as deferred to RT-10 (review #645)", () => {
    const text = JSON.stringify([findOp("recordReturn"), schema("RefundTender")]);
    expect(text).not.toContain("deferred to RT-10");
  });

  it("refunds stay cash-only on a return (RT-14 D3 is unchanged by RT-10)", () => {
    expect(prop<{ enum?: string[] }>("RefundTender", "method")?.enum).toEqual(["cash"]);
  });

  it("capture rejects tenders that do not sum to posTotal with 422 sale_tender_mismatch (D1)", () => {
    const responses = (findOp("captureSale")?.responses ?? {}) as Record<string, { $ref?: string }>;
    expect(responses["422"]?.$ref).toBe("#/components/responses/CaptureUnprocessable");
    const mismatch = salesDoc.components?.responses?.["CaptureUnprocessable"] as
      | { description?: string }
      | undefined;
    expect(mismatch?.description).toContain("sale_tender_mismatch");
  });

  it("the device is server-resolved — capture accepts no device/terminal field (D7-i)", () => {
    const props = schema("CaptureSaleRequest")?.properties ?? {};
    for (const banned of ["deviceId", "device_id", "terminalId", "terminal_id", "shiftId", "shift_id"]) {
      expect(props).not.toHaveProperty(banned);
    }
  });

  it("tells strict response validators to re-pin before RT-77 emits Sale.tenders (review #645)", () => {
    expect(salesDoc.info?.description ?? "").toContain(
      "must re-pin this version BEFORE RT-77 deploys",
    );
  });

  it("the sale read exposes tenders, OPTIONAL until RT-77 emits them (safe re-pin order)", () => {
    const tenders = prop<ArrayProp>("Sale", "tenders");
    expect(tenders?.type).toBe("array");
    expect(tenders?.items?.$ref).toBe("#/components/schemas/SaleTender");
    expect(schema("Sale")?.required).not.toContain("tenders");
  });
});

// ===========================================================================
// RT-105 (RT-87 decision D) — sale-line price invariant at capture
// ===========================================================================
describe("pos-sales/sales.yaml — RT-105 sale-line price invariant", () => {
  function captureLine(): SchemaObject | undefined {
    return salesDoc.components?.schemas?.["CaptureSaleLine"];
  }
  /** The `description` of a contract node, or "" (the loader's types omit it). */
  function describedBy(node: unknown): string {
    return (node as { description?: string } | undefined)?.description ?? "";
  }

  it("capture's 422 names the new sale_line_pricing_invalid code beside sale_tender_mismatch", () => {
    const text = describedBy(salesDoc.components?.responses?.["CaptureUnprocessable"]);
    expect(text).toContain("sale_line_pricing_invalid");
    expect(text).toContain("sale_tender_mismatch");
  });

  it("a capture line states all three invariant conditions", () => {
    const text = describedBy(captureLine());
    expect(text).toContain("lineAmount = unitPrice × quantity");
    expect(text).toContain("minor unit");
    expect(text).toContain("whole number");
    expect(text).toContain("sale_line_pricing_invalid");
  });

  it("a replay of an already-captured sale is exempt from the invariant", () => {
    expect(describedBy(findOp("captureSale"))).toContain(
      "a replay of a sale captured before RT-105 is never re-checked",
    );
  });

  it("returns prose says conforming lines return at exactly unitPrice × q", () => {
    expect(describedBy(findOp("recordReturn"))).toContain(
      "prices to exactly `unitPrice × q`",
    );
  });

  it("the minor unit is the currency's ISO-4217 exponent, never an assumed 2 (comment 10537 gap 2)", () => {
    const text = describedBy(captureLine());
    expect(text).toContain("never an assumed 2");
    expect(text).toContain("no ISO-4217 minor unit");
  });

  it("a line sold in a whole quantity is returned in whole quantities only (comment 10537 gap 1)", () => {
    const op = describedBy(findOp("recordReturn"));
    expect(op).toContain("accepts only a whole return `quantity`");
    expect(op).toContain("A replay is never re-checked");
    const quantity = salesDoc.components?.schemas?.["ReturnLineRequest"]?.properties?.["quantity"];
    expect(describedBy(quantity)).toContain("MUST be a whole number when the line was sold in a whole quantity");
  });

  it("the version note records RT-105 and that the request shape is unchanged", () => {
    const info = salesDoc.info?.description ?? "";
    expect(info).toContain("RT-105");
    expect(info).toContain("The request shape is unchanged");
    expect(salesDoc.info?.version).toBe("1.3.0-draft");
  });
});
