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

import { z } from "zod";
import Ajv2020, { type ValidateFunction } from "ajv/dist/2020";
import addFormats from "ajv-formats";

import {
  CaptureSaleReceiptSchema,
  CaptureSaleRequestWithTendersSchema,
} from "../../../../src/catalog/sales/dto/capture-sale-request.dto";
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
  "recordCreditSaleReversal",
] as const;

const WRITE_OPERATION_IDS = [
  "captureSale",
  "recordVoid",
  "recordRefund",
  "recordReturn",
  "recordCreditSaleReversal",
];

const CAPTURE_PATH = "/api/pos/v1/sales";
const READ_PATH = "/api/pos/v1/sales/{saleRef}";
const VOID_PATH = "/api/pos/v1/sales/{saleRef}/void";
const REFUND_PATH = "/api/pos/v1/sales/{saleRef}/refund";
const RETURNS_PATH = "/api/pos/v1/sales/{saleRef}/returns";
const CREDIT_REVERSALS_PATH = "/api/pos/v1/sales/{saleRef}/credit-reversals";

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
  // RT-359 (RT-264 D1/D3): the tender line's own identity.
  "SaleTender.tenderRef",
  // RT-577 (owner decision V1, 2026-10-17): a credit-sale reversal records the
  // cash it refunds, capped at the server-computed collected share.
  "CreditSaleReversalRequest.refundTenders",
  "CreditSaleReversal.refundTenders",
  // RT-577 D8 (owner ruling 2026-10-17): a credit void refunds by mirroring
  // each collected tender line, addressed by its tenderRef.
  "CreditReversalRefundTender.tenderRef",
];

/**
 * Capture fields the contract declares before the server accepts them.
 * RT-539 added the RT-537 `receipt` to the capture DTO; RT-418 added the
 * RT-417 `responsibilities`. None is ahead now.
 */
const CONTRACT_AHEAD_OF_CAPTURE_DTO: readonly string[] = [];

/** A property's `maxLength` in a schema; NaN when the schema does not bound it. */
function maxLengthOf(schemaObject: { properties?: Record<string, unknown> } | undefined, prop: string): number {
  const node = schemaObject?.properties?.[prop] as { maxLength?: number } | undefined;
  return node?.maxLength ?? Number.NaN;
}

/**
 * RT-537: the `maxLength` of a property of the terminal-pairing contract, the
 * source of the values the POS receipt prints.
 */
function pairingMaxLengths(): (prop: string) => number {
  const pairing = loadOpenApiContracts().find((c) => c.id === "pos-terminal-pairing.openapi");
  const schemas = Object.values(
    (pairing?.document as { components?: { schemas?: Record<string, { properties?: Record<string, unknown> }> } })
      ?.components?.schemas ?? {},
  );
  return (prop) => {
    const bounded = schemas.map((s) => maxLengthOf(s, prop)).filter((n) => !Number.isNaN(n));
    if (bounded.length === 0) throw new Error(`pairing property ${prop} not found`);
    return Math.max(...bounded);
  };
}

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
  it("declares exactly the four 008 operationIds plus the RT-72 recordReturn and the RT-577 recordCreditSaleReversal", () => {
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
    expect(salesDoc.paths?.[CREDIT_REVERSALS_PATH]?.["post"]?.operationId).toBe("recordCreditSaleReversal");
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
    for (const p of [CAPTURE_PATH, VOID_PATH, REFUND_PATH, RETURNS_PATH, CREDIT_REVERSALS_PATH]) {
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
    for (const p of [CAPTURE_PATH, VOID_PATH, REFUND_PATH, RETURNS_PATH, CREDIT_REVERSALS_PATH]) {
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
      "CaptureSaleReceipt",
      "CaptureSaleLine",
      "RecordVoidRequest",
      "VoidApproval",
      "RecordRefundRequest",
      "RecordReturnRequest",
      "ReturnLineRequest",
      "RefundTender",
      "SaleTender",
      "CreditSaleReversalRequest",
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
    // RT-359 adds the optional tender-line identity (tenderRef, sequence).
    expect(Object.keys(schema("SaleTender")?.properties ?? {}).sort()).toEqual(
      ["amount", "method", "reference", "sequence", "tenderRef"],
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
  });
});

// ===========================================================================
// RT-181 — Idempotency-Key declared as the IdempotencyInterceptor rule
// ===========================================================================
describe("pos-sales/sales.yaml — RT-181 Idempotency-Key bounds", () => {
  // apps/api/src/idempotency/idempotency.interceptor.ts enforces
  // /^[\x21-\x7E]{16,128}$/ on every @Idempotent route. The contract MUST
  // declare the same rule; 1-255 accepted keys the interceptor rejects 400.
  const keySchema = (): { minLength?: number; maxLength?: number; pattern?: string } =>
    ((salesDoc.components?.parameters?.["IdempotencyKey"] as { schema?: object } | undefined)
      ?.schema ?? {}) as { minLength?: number; maxLength?: number; pattern?: string };

  it("declares 16-128 printable ASCII, matching the interceptor", () => {
    const schema = keySchema();
    expect(schema.minLength).toBe(16);
    expect(schema.maxLength).toBe(128);
    expect(schema.pattern).toBe("^[\\x21-\\x7E]{16,128}$");
  });

  it("accepts the key the POS sends and rejects keys the interceptor rejects", () => {
    const pattern = new RegExp(keySchema().pattern ?? "(?!)");
    // POS: `pos-pulse:${envelope_handoff_action_id}` (a crypto.randomUUID()), 46 chars.
    expect(pattern.test("pos-pulse:0b8a7c3e-5f1d-4e2a-9c6b-7d8e9f0a1b2c")).toBe(true);
    expect(pattern.test("a".repeat(15))).toBe(false);
    expect(pattern.test("a".repeat(129))).toBe(false);
    expect(pattern.test("pos-pulse key with spaces")).toBe(false);
  });

  it("the version note records RT-181 at 1.4.0-draft (version moved on in RT-224)", () => {
    const info = salesDoc.info?.description ?? "";
    expect(info).toContain("RT-181 (1.4.0-draft");
    expect(info).toContain("The server is unchanged");
  });
});

// ===========================================================================
// RT-224 Option B — device-bearer sale capture with server-verified cashier
// attribution ([GATED] approval: Jira RT-224 comment 10889)
// ===========================================================================
describe("pos-sales/sales.yaml — RT-224 device-bearer cashier capture", () => {
  type DescribedNode = { description?: string };
  function describedBy(node: unknown): string {
    return (node as DescribedNode | undefined)?.description ?? "";
  }
  function captureRequest(): SchemaObject | undefined {
    return salesDoc.components?.schemas?.["CaptureSaleRequest"];
  }
  function operatorUserId():
    | { type?: string; format?: string; description?: string }
    | undefined {
    return (captureRequest()?.properties ?? {})["operatorUserId"] as
      | { type?: string; format?: string; description?: string }
      | undefined;
  }

  it("the version note records RT-224 at 1.5.0-draft, citing the approval (version moved on in RT-225)", () => {
    const info = salesDoc.info?.description ?? "";
    expect(info).toContain("RT-224 (1.5.0-draft");
    expect(info).toContain("comment 10889");
  });

  it("captureSale accepts the envelope OR the device bearer, as two alternatives", () => {
    expect(findOp("captureSale")?.security).toEqual([
      { operatorAuthorization: [] },
      { device: [] },
    ]);
  });

  it("no other sale operation accepts the device bearer (only captureSale changes)", () => {
    for (const { op } of salesOperations()) {
      if (op.operationId === "captureSale") continue;
      expect(op.security).toEqual([{ operatorAuthorization: [] }]);
    }
  });

  it("declares the role-named device scheme: opaque http bearer, not a JWT", () => {
    const scheme = salesDoc.components?.securitySchemes?.["device"] as
      | { type?: string; scheme?: string; bearerFormat?: string; description?: string }
      | undefined;
    expect(scheme?.type).toBe("http");
    expect(scheme?.scheme).toBe("bearer");
    expect(scheme?.bearerFormat).toBeUndefined();
    // Device-scoped: never proves a sale's author alone.
    expect(scheme?.description).toContain("operatorUserId");
    expect(scheme?.description).toContain("cashier admission");
  });

  it("adds an OPTIONAL operatorUserId (uuid) to the strict capture body", () => {
    expect(captureRequest()?.additionalProperties).toBe(false);
    expect(captureRequest()?.required).not.toContain("operatorUserId");
    expect(operatorUserId()?.type).toBe("string");
    expect(operatorUserId()?.format).toBe("uuid");
  });

  it("documents which scheme the field selects and that it is a verified claim, never trusted", () => {
    const text = describedBy(operatorUserId());
    expect(text).toContain("REQUIRED with the `device` scheme");
    expect(text).toContain("MUST be absent with `operatorAuthorization`");
    expect(text).toContain("`created_by`");
    expect(text).toContain("never trusted");
  });

  it("documents the admission window precisely, with the 120 s clock-skew tolerance (rev709 F2)", () => {
    const text = describedBy(operatorUserId());
    expect(text).toContain(
      "created_at - 120 s <= occurredAt < LEAST(ended_at, expires_at) + 120 s",
    );
    expect(text).toContain("has since ended or expired");
    expect(text).toContain("same device");
  });

  it("documents the back-dating and future-dating caps (rev709 F3)", () => {
    const text = describedBy(operatorUserId());
    expect(text).toContain("more than 7 days ago");
    expect(text).toContain("more than 120 s after the server's current time");
  });

  it("keeps the attribution out of the sale payload hash", () => {
    expect(describedBy(operatorUserId())).toContain("not part of the sale `payload_hash`");
  });

  it("a bad device credential is the generic 401; a refused claim is the generic 403 (rev709 F1)", () => {
    const text = describedBy(findOp("captureSale"));
    expect(text).toContain("Cashier attribution (RT-224)");
    expect(text).toContain("generic 401");
    expect(text).toContain("generic 403 `refused`");
    const scheme = describedBy(salesDoc.components?.securitySchemes?.["device"]);
    expect(scheme).toContain("generic 401");
    expect(scheme).toContain("generic 403");
    expect(describedBy(operatorUserId())).toContain("403 `refused`");
  });

  it("captureSale declares the 403 CaptureForbidden response (RT-224 refused + RT-417 role refusal); the other 403s are the void's, the RT-577 credit-sale refusal and the credit reversal's own", () => {
    const responses = (op: unknown): Record<string, unknown> =>
      ((op as { responses?: Record<string, unknown> }).responses ?? {});
    expect(responses(findOp("captureSale"))["403"]).toEqual({
      $ref: "#/components/responses/CaptureForbidden",
    });
    expect(responses(findOp("captureSale"))["401"]).toEqual({
      $ref: "#/components/responses/Unauthorized",
    });
    for (const { op } of salesOperations()) {
      if (op.operationId === "captureSale") continue;
      if (op.operationId === "recordVoid") {
        // RT-530: the void's 403 is its own approval refusal, not the device-path `Refused`.
        expect(responses(op)["403"]).toEqual({ $ref: "#/components/responses/VoidForbidden" });
        continue;
      }
      if (op.operationId === "recordReturn" || op.operationId === "recordRefund") {
        // RT-577: a responsibility-bearing sale is refused on the ordinary routes.
        expect(responses(op)["403"]).toEqual({ $ref: "#/components/responses/CreditSaleReversalRestricted" });
        continue;
      }
      if (op.operationId === "recordCreditSaleReversal") {
        expect(responses(op)["403"]).toEqual({ $ref: "#/components/responses/CreditReversalForbidden" });
        continue;
      }
      expect(responses(op)["403"]).toBeUndefined();
    }
  });

  it("the capture 403 (CaptureForbidden) is the generic Error envelope and says the device itself is valid", () => {
    const refused = salesDoc.components?.responses?.["CaptureForbidden"] as
      | { description?: string; content?: Record<string, { schema?: unknown }> }
      | undefined;
    expect(refused?.content?.["application/json"]?.schema).toEqual({
      $ref: "#/components/schemas/Error",
    });
    const text = refused?.description ?? "";
    expect(text).toContain("`refused`");
    expect(text).toContain("the device credential is valid");
    expect(text).toContain("never a sign that the device was revoked");
  });
});

// ===========================================================================
// RT-225 — admissionCheckAt ([GATED] approval: Jira RT-225, owner,
// 2026-10-05: "optional CaptureSaleRequest.admissionCheckAt, contract
// 1.6.0-draft, no migration; gap cap 7 days")
// ===========================================================================
describe("pos-sales/sales.yaml — RT-225 admissionCheckAt", () => {
  type FieldNode = { type?: string; format?: string; description?: string };
  function captureRequest(): SchemaObject | undefined {
    return salesDoc.components?.schemas?.["CaptureSaleRequest"];
  }
  function field(name: string): FieldNode | undefined {
    return (captureRequest()?.properties ?? {})[name] as FieldNode | undefined;
  }
  const text = (): string => field("admissionCheckAt")?.description ?? "";

  /** The DTO's object keys and required keys, unwrapping any refinement. */
  function dtoShape(schema: z.ZodTypeAny): { keys: string[]; required: string[] } {
    let inner: z.ZodTypeAny = schema;
    while (inner instanceof z.ZodEffects) inner = inner.innerType() as z.ZodTypeAny;
    if (!(inner instanceof z.ZodObject)) return { keys: [], required: [] };
    const shape = inner.shape as Record<string, z.ZodTypeAny>;
    const keys = Object.keys(shape).sort();
    return { keys, required: keys.filter((k) => !shape[k]!.isOptional()) };
  }

  it("the version note records RT-225 at 1.6.0-draft, citing the approval (version moved on in RT-359)", () => {
    const info = salesDoc.info?.description ?? "";
    expect(info).toContain("RT-225 (1.6.0-draft");
    expect(info).toContain("[GATED] approval Jira RT-225");
    expect(info).toContain("A client that does not send `admissionCheckAt` sees no difference");
  });

  it("adds an OPTIONAL admissionCheckAt (date-time) to the strict capture body", () => {
    expect(captureRequest()?.additionalProperties).toBe(false);
    expect(captureRequest()?.required).not.toContain("admissionCheckAt");
    expect(field("admissionCheckAt")?.type).toBe("string");
    expect(field("admissionCheckAt")?.format).toBe("date-time");
  });

  it("states the cross-field rules OpenAPI cannot express, each a 400", () => {
    expect(text()).toContain("ONLY together with `operatorUserId`");
    expect(text()).toContain("`admissionCheckAt <= occurredAt`");
    expect(text()).toContain("`occurredAt - admissionCheckAt <= 7 days`");
    expect(text()).toContain("400 `validation_error`");
  });

  it("documents that it replaces occurredAt in the window comparison only; the caps and the refusal are unchanged", () => {
    expect(text()).toContain(
      "created_at - 120 s <= admissionCheckAt < LEAST(ended_at, expires_at) + 120 s",
    );
    expect(text()).toContain("only in the admission-window comparison");
    expect(text()).toContain("future-dating cap applies to `occurredAt` and to `admissionCheckAt`");
    expect(text()).toContain("back-dating cap is unchanged");
    expect(text()).toContain("generic 403 `refused`");
  });

  it("keeps the field out of the sale facts: payload_hash, occurred_at and business_date", () => {
    expect(text()).toContain("not part of the sale `payload_hash`");
    expect(text()).toContain("`occurred_at`");
    expect(text()).toContain("`business_date`");
    expect(text()).toContain("idempotency fingerprint");
  });

  it("operatorUserId points at admissionCheckAt for the window instant", () => {
    expect(field("operatorUserId")?.description ?? "").toContain("`admissionCheckAt` when present");
  });

  it("DTO/contract parity: the capture DTO accepts exactly the contract's properties and requires the same ones", () => {
    // RT-537 declared `receipt` ahead of the DTO; RT-539 added it, so nothing
    // is filtered out any more (the RT-537 block below pins its shape).
    const contractKeys = Object.keys(captureRequest()?.properties ?? {})
      .filter((key) => !CONTRACT_AHEAD_OF_CAPTURE_DTO.includes(key))
      .sort();
    const contractRequired = [...(captureRequest()?.required ?? [])].sort();
    const dto = dtoShape(CaptureSaleRequestWithTendersSchema);
    expect(dto.keys).toEqual(contractKeys);
    expect(dto.required).toEqual(contractRequired);
    expect(dto.keys).toContain("admissionCheckAt");
  });
});

// ===========================================================================
// RT-359 (RT-264 G1 decisions D1–D4) — tender-line identity (1.7.0-draft)
// ===========================================================================
describe("pos-sales/sales.yaml — RT-359 tender-line identity", () => {
  type FieldNode = { type?: string; format?: string; minimum?: number; description?: string };
  function tender(): SchemaObject | undefined {
    return salesDoc.components?.schemas?.["SaleTender"];
  }
  function field(name: string): FieldNode | undefined {
    return (tender()?.properties ?? {})[name] as FieldNode | undefined;
  }
  function tendersText(): string {
    const props = salesDoc.components?.schemas?.["CaptureSaleRequest"]?.properties ?? {};
    return (props["tenders"] as { description?: string } | undefined)?.description ?? "";
  }

  it("the version note records RT-359 at 1.7.0-draft, citing the [GATED] approval (version moved on in RT-530)", () => {
    const info = salesDoc.info?.description ?? "";
    expect(info).toContain("RT-359 (1.7.0-draft");
    expect(info).toContain("[GATED] approval Jira RT-359");
  });

  it("adds an OPTIONAL tenderRef (uuid) and sequence (integer >= 1); the tender stays strict", () => {
    expect(tender()?.additionalProperties).toBe(false);
    expect(tender()?.required?.slice().sort()).toEqual(["amount", "method"]);
    expect(field("tenderRef")).toMatchObject({ type: "string", format: "uuid" });
    expect(field("sequence")).toMatchObject({ type: "integer", minimum: 1 });
  });

  it("tenderRef is the POS-minted tender-line identity, stable across retries", () => {
    const text = field("tenderRef")?.description ?? "";
    expect(text).toContain("minted by the producer when the tender line is created");
    expect(text).toContain("never changes on a retry");
    expect(text).toContain("Tender method is not tender identity");
  });

  it("states the per-sale uniqueness rules OpenAPI cannot express, each a 400", () => {
    const text = tendersText();
    expect(text).toContain("`tenderRef` is unique within the sale");
    expect(text).toContain("`sequence` is unique within the sale");
    expect(text).toContain("only when EVERY entry carries a `tenderRef`");
    expect(text).toContain("400 `validation_error`");
  });

  it("keeps a legacy (ref-less) tender addressable by (sale, method), with no backfill", () => {
    const info = salesDoc.info?.description ?? "";
    expect(info).toContain("addressed by `(sale, method)`");
    expect(info).toContain("never backfilled or derived");
  });

  it("orders the rollout: no tenderRef before RT-360, no same-method tenders before the flag", () => {
    const info = salesDoc.info?.description ?? "";
    expect(info).toContain("MUST NOT send `tenderRef` or `sequence` before RT-360 is deployed");
    expect(info).toContain("at most one entry per `method` until");
    expect(tendersText()).toContain("Accepted from RT-360");
  });
});

// ===========================================================================
// RT-530 — manager-approved void (1.8.0-draft; [GATED] approval Jira RT-530
// comment 11988)
// ===========================================================================
describe("pos-sales/sales.yaml — RT-530 manager-approved void", () => {
  type FieldNode = { type?: string; format?: string; $ref?: string; description?: string };
  type DescribedNode = { description?: string };
  const text = (node: unknown): string => (node as DescribedNode | undefined)?.description ?? "";
  function field(schemaName: string, name: string): FieldNode | undefined {
    return (salesDoc.components?.schemas?.[schemaName]?.properties ?? {})[name] as FieldNode | undefined;
  }
  function responseRef(operationId: string, status: string): string | undefined {
    const responses = (findOp(operationId)?.responses ?? {}) as Record<string, { $ref?: string }>;
    return responses[status]?.$ref;
  }

  it("the version note records RT-530 at 1.8.0-draft, citing the [GATED] approval (version moved on in RT-537)", () => {
    const info = salesDoc.info?.description ?? "";
    expect(info).toContain("RT-530 (1.8.0-draft");
    expect(info).toContain("[GATED] approval Jira RT-530 comment 11988");
  });

  it("adds OPTIONAL approval and businessDate to the strict void request (additive in shape)", () => {
    const request = salesDoc.components?.schemas?.["RecordVoidRequest"];
    expect(request?.additionalProperties).toBe(false);
    expect(request?.required?.slice().sort()).toEqual(["externalId", "sourceSystem"]);
    expect(field("RecordVoidRequest", "approval")?.$ref).toBe("#/components/schemas/VoidApproval");
    expect(field("RecordVoidRequest", "businessDate")).toMatchObject({ type: "string", format: "date" });
  });

  it("models the approval on the RT-114 C7 evidence: id, approver, policy version, time, binding", () => {
    const approval = salesDoc.components?.schemas?.["VoidApproval"];
    expect(approval?.additionalProperties).toBe(false);
    expect(approval?.required?.slice().sort()).toEqual(
      [
        "action",
        "amount",
        "approvalId",
        "approvedAt",
        "approverUserId",
        "policyVersion",
        "requesterUserId",
        "saleRef",
      ].sort(),
    );
    for (const uuid of ["approvalId", "saleRef", "requesterUserId", "approverUserId"]) {
      expect(field("VoidApproval", uuid)).toMatchObject({ type: "string", format: "uuid" });
    }
    expect(field("VoidApproval", "approvedAt")).toMatchObject({ type: "string", format: "date-time" });
    expect(field("VoidApproval", "amount")?.$ref).toBe("#/components/schemas/NonNegativeDecimalAmount");
  });

  it("recordVoid adds 403 and 422 with void-specific codes, and keeps 200/201/404/409", () => {
    expect(responseRef("recordVoid", "403")).toBe("#/components/responses/VoidForbidden");
    expect(responseRef("recordVoid", "422")).toBe("#/components/responses/VoidUnprocessable");
    expect(responseRef("recordVoid", "409")).toBe("#/components/responses/ReversalConflict");
    const forbidden = text(salesDoc.components?.responses?.["VoidForbidden"]);
    for (const code of [
      "void_approval_required",
      "void_requester_mismatch",
      "void_self_approval",
      "void_requester_not_eligible",
      "void_approver_not_eligible",
    ]) {
      expect(forbidden).toContain(code);
    }
    const unprocessable = text(salesDoc.components?.responses?.["VoidUnprocessable"]);
    for (const code of ["void_approval_invalid", "void_outside_business_day"]) {
      expect(unprocessable).toContain(code);
    }
  });

  it("states the check order, the eligible roles and that a replay never re-checks", () => {
    const op = text(findOp("recordVoid"));
    expect(op).toContain("`owner`, `tenant_admin` or `store_manager`");
    expect(op).toContain("never re-runs them");
    expect(op).toContain("`approval.requesterUserId` is the authenticated operator of the");
    expect(op).toContain("An offline-queued void is checked on");
    expect(op.indexOf("void_approval_required")).toBeLessThan(op.indexOf("void_approval_invalid"));
    expect(op.indexOf("void_approval_invalid")).toBeLessThan(op.indexOf("void_outside_business_day"));
    expect(op.indexOf("void_outside_business_day")).toBeLessThan(op.indexOf("void_requester_mismatch"));
    expect(op.indexOf("void_requester_mismatch")).toBeLessThan(op.indexOf("void_self_approval"));
    expect(op.indexOf("void_self_approval")).toBeLessThan(op.indexOf("void_approver_not_eligible"));
  });

  it("states the residual risk: the PIN is not provable server-side", () => {
    const info = salesDoc.info?.description ?? "";
    expect(info).toContain("cannot prove that the approver's PIN was typed");
    expect(info).toContain("ROLLOUT ORDER: a POS that sends no approval gets");
  });

  it("the void stays envelope-only: no new security requirement", () => {
    expect(findOp("recordVoid")?.security).toEqual([{ operatorAuthorization: [] }]);
  });
});

// ===========================================================================
// RT-537 — receipt snapshot on capture (1.9.0-draft; [GATED] approval Jira
// RT-537 comment 12057; design comments 12054-12056)
// ===========================================================================
describe("pos-sales/sales.yaml — RT-537 receipt snapshot", () => {
  type FieldNode = { type?: string; format?: string; $ref?: string; description?: string };
  const schema = (name: string): SchemaObject | undefined => salesDoc.components?.schemas?.[name];
  function field(schemaName: string, name: string): FieldNode | undefined {
    return (schema(schemaName)?.properties ?? {})[name] as FieldNode | undefined;
  }
  const receiptText = (): string => (schema("CaptureSaleReceipt") as { description?: string })?.description ?? "";

  /** Unwrap refinements down to the strict capture DTO object. */
  function captureDtoObject(): z.AnyZodObject {
    let inner: z.ZodTypeAny = CaptureSaleRequestWithTendersSchema;
    while (inner instanceof z.ZodEffects) inner = inner.innerType() as z.ZodTypeAny;
    if (!(inner instanceof z.ZodObject)) throw new Error("capture DTO is not a Zod object");
    return inner;
  }

  it("the version note records RT-537 at 1.9.0-draft, citing the [GATED] approval (version moved on in RT-417)", () => {
    const info = salesDoc.info?.description ?? "";
    expect(info).toContain("RT-537 (1.9.0-draft");
    expect(info).toContain("[GATED] approval Jira RT-537 comment 12057");
    expect(info).toContain("A client that does");
    expect(info).toContain("not send `receipt` sees no difference");
  });

  it("adds an OPTIONAL receipt to the strict capture body (key set pinned, RT-417 adds responsibilities)", () => {
    const request = schema("CaptureSaleRequest");
    expect(request?.additionalProperties).toBe(false);
    expect(request?.required).not.toContain("receipt");
    expect(field("CaptureSaleRequest", "receipt")?.$ref).toBe("#/components/schemas/CaptureSaleReceipt");
    expect(Object.keys(request?.properties ?? {}).sort()).toEqual(
      [
        "admissionCheckAt",
        "currencyCode",
        "externalId",
        "lines",
        "occurredAt",
        "operatorUserId",
        "posTotal",
        "receipt",
        "responsibilities",
        "sourceClockAt",
        "sourceSystem",
        "tenders",
      ].sort(),
    );
  });

  it("accepts every value the pairing contract allows the receipt to print (no valid sale rejected)", () => {
    const pairingMax = pairingMaxLengths();
    const receiptMax = (prop: string): number => maxLengthOf(schema("CaptureSaleReceipt"), prop);

    expect(receiptMax("terminalLabel")).toBeGreaterThanOrEqual(pairingMax("terminal_label"));
    expect(receiptMax("branchName")).toBeGreaterThanOrEqual(pairingMax("branch_name"));
    expect(receiptMax("branchAddress")).toBeGreaterThanOrEqual(pairingMax("branch_address"));
    expect(receiptMax("taxRegistrationId")).toBeGreaterThanOrEqual(
      pairingMax("tenant_tax_registration_id"),
    );
    // `<terminal_label>-<YYYY-MM-DD>-<NNNNNN>`: label + 1 + 10 + 1 + 6.
    // The display name has no upstream bound (users.display_name is text), so none here.
    expect(Number.isNaN(receiptMax("operatorDisplayName"))).toBe(true);
    const longestSaleNumber = pairingMax("terminal_label") + 18;
    expect(receiptMax("saleNumber")).toBeGreaterThanOrEqual(longestSaleNumber);
    expect(receiptMax("receiptNumber")).toBeGreaterThanOrEqual(longestSaleNumber);
  });

  it("models every field the POS receipt prints that is not already a sale fact", () => {
    const receipt = schema("CaptureSaleReceipt");
    expect(receipt?.additionalProperties).toBe(false);
    expect(receipt?.required?.slice().sort()).toEqual(
      [
        "branchAddress",
        "branchName",
        "operatorDisplayName",
        "saleNumber",
        "settledAt",
        "taxRegistrationId",
        "terminalLabel",
      ].sort(),
    );
    expect(field("CaptureSaleReceipt", "settledAt")).toMatchObject({ type: "string", format: "date-time" });
    expect(field("CaptureSaleReceipt", "changeGiven")?.$ref).toBe(
      "#/components/schemas/NonNegativeDecimalAmount",
    );
    expect(field("CaptureSaleReceipt", "receiptNumber")).toMatchObject({ type: "string" });
    expect(field("CaptureSaleReceipt", "operatorDisplayName")?.description ?? "").toContain(
      "Never an email address",
    );
  });

  it("keeps the snapshot out of the payload_hash but in the idempotency fingerprint", () => {
    expect(receiptText()).toContain("NOT part of the sale `payload_hash`");
    expect(receiptText()).toContain("IS part of the idempotency");
    expect(receiptText()).toContain("First write wins");
  });

  it("is presentation only: never authorization, attribution or scope (FR-061 unchanged)", () => {
    const text = receiptText().replace(/\s+/g, " ");
    expect(text).toContain("used for PRESENTATION ONLY");
    expect(text).toContain("never used for authorization, attribution, scope or any money rule");
    expect(text).toContain("the authenticated actor (`created_by`)");
    expect(salesDoc.info?.description ?? "").toContain("posting feed and the provenance-divergence rule");
  });

  it("orders the rollout: accepted from RT-539, sent only after a POS cutoff (RT-79 pattern)", () => {
    const info = salesDoc.info?.description ?? "";
    expect(info).toContain("the server accepts `receipt` from RT-539");
    expect(info).toContain("the strict capture DTO rejects the unknown field (400)");
    expect(info).toContain("configured cutoff");
    expect(receiptText()).toContain("Accepted from RT-539; do not");
  });

  it("states the line-order behaviour without adding a line field", () => {
    expect(salesDoc.info?.description ?? "").toContain("1-based position in `lines[]`");
    expect(Object.keys(schema("CaptureSaleLine")?.properties ?? {})).not.toContain("sequence");
  });

  it("leaves the Sale projection untouched (no receipt on reads)", () => {
    expect(Object.keys(schema("Sale")?.properties ?? {})).not.toContain("receipt");
  });

  it("the capture DTO accepts receipt since RT-539, with exactly the contract's fields and bounds", () => {
    const dto = captureDtoObject();
    expect(Object.keys(dto.shape)).toContain("receipt");
    expect(dto._def.unknownKeys).toBe("strict");
    expect(CONTRACT_AHEAD_OF_CAPTURE_DTO).not.toContain("receipt");

    const receiptDto = CaptureSaleReceiptSchema;
    expect(receiptDto._def.unknownKeys).toBe("strict");
    const contract = schema("CaptureSaleReceipt");
    const shape = receiptDto.shape as Record<string, z.ZodTypeAny>;
    expect(Object.keys(shape).sort()).toEqual(Object.keys(contract?.properties ?? {}).sort());
    expect(Object.keys(shape).filter((k) => !shape[k]!.isOptional()).sort()).toEqual(
      [...(contract?.required ?? [])].sort(),
    );
    for (const prop of ["saleNumber", "receiptNumber", "terminalLabel", "branchName", "branchAddress", "taxRegistrationId"]) {
      const max = maxLengthOf(contract, prop);
      const at = { ...validReceipt(), [prop]: "x".repeat(max) };
      const over = { ...validReceipt(), [prop]: "x".repeat(max + 1) };
      expect({ prop, ok: receiptDto.safeParse(at).success }).toEqual({ prop, ok: true });
      expect({ prop, ok: receiptDto.safeParse(over).success }).toEqual({ prop, ok: false });
    }
    // operatorDisplayName has no bound of its own (users.display_name is unbounded).
    expect(receiptDto.safeParse({ ...validReceipt(), operatorDisplayName: "n".repeat(2000) }).success).toBe(true);
    expect(receiptDto.safeParse({ ...validReceipt(), changeGiven: "-1" }).success).toBe(false);
  });

  function validReceipt(): Record<string, string> {
    return {
      saleNumber: "till-1-2026-10-16-000001",
      terminalLabel: "till-1",
      operatorDisplayName: "Cashier One",
      settledAt: "2026-10-16T09:00:00.000Z",
      branchName: "Branch",
      branchAddress: "1 Nile St",
      taxRegistrationId: "123-456-789",
    };
  }
});

// ===========================================================================
// RT-417 — sale payer responsibilities + coverage rule (1.10.0-draft; [GATED]
// approval Jira RT-417 comment 11671; owner decision R-1, RT-413 comment 11669)
// ===========================================================================
describe("pos-sales/sales.yaml — RT-417 payer responsibilities", () => {
  type FieldNode = {
    type?: string;
    format?: string;
    minimum?: number;
    minItems?: number;
    maxItems?: number;
    pattern?: string;
    $ref?: string;
    items?: { $ref?: string };
    description?: string;
  };
  const schema = (name: string): SchemaObject | undefined => salesDoc.components?.schemas?.[name];
  const field = (schemaName: string, name: string): FieldNode | undefined =>
    (schema(schemaName)?.properties ?? {})[name] as FieldNode | undefined;
  const flat = (text: string | undefined): string => (text ?? "").replace(/\s+/g, " ");
  const info = (): string => flat(salesDoc.info?.description);
  const captureText = (): string => flat((findOp("captureSale") as { description?: string } | undefined)?.description);
  const fieldText = (): string => flat(field("CaptureSaleRequest", "responsibilities")?.description);
  const unprocessable = (): string =>
    flat((salesDoc.components?.responses?.["CaptureUnprocessable"] as { description?: string } | undefined)?.description);

  it("the version note records RT-417 at 1.10.0-draft, citing the [GATED] approval and R-1 (version moved on in RT-577)", () => {
    expect(info()).toContain("RT-417 (1.10.0-draft; [GATED] approval Jira RT-417 comment 11671");
    expect(info()).toContain("R-1");
  });

  it("capture accepts an OPTIONAL responsibilities list of exactly one payer in this version (Codex #779 P1)", () => {
    expect(schema("CaptureSaleRequest")?.required).not.toContain("responsibilities");
    const list = field("CaptureSaleRequest", "responsibilities");
    expect(list).toMatchObject({ type: "array", minItems: 1, maxItems: 1 });
    expect(fieldText()).toContain("At most one payer per sale in this version");
    expect(list?.items?.$ref).toBe("#/components/schemas/SaleResponsibility");
  });

  it("a responsibility is strict {payerRef uuid, amount > 0, sequence >= 1}, all required", () => {
    const entry = schema("SaleResponsibility");
    expect(entry?.additionalProperties).toBe(false);
    expect(entry?.required?.slice().sort()).toEqual(["amount", "payerRef", "sequence"]);
    expect(Object.keys(entry?.properties ?? {}).sort()).toEqual(["amount", "payerRef", "sequence"]);
    expect(field("SaleResponsibility", "payerRef")).toMatchObject({ type: "string", format: "uuid" });
    expect(field("SaleResponsibility", "amount")?.$ref).toBe("#/components/schemas/PositiveDecimalAmount");
    expect(field("SaleResponsibility", "sequence")).toMatchObject({ type: "integer", minimum: 1 });
  });

  it("PositiveDecimalAmount is exact-decimal, numeric(19,4)-bounded, and rejects zero and negatives", () => {
    const pattern = (schema("PositiveDecimalAmount") as { pattern?: string } | undefined)?.pattern;
    expect(pattern).toBeDefined();
    const positive = new RegExp(pattern ?? "$^");
    for (const ok of ["0.0001", "1", "120.00", "999999999999999.9999"]) expect({ ok, m: positive.test(ok) }).toEqual({ ok, m: true });
    for (const bad of ["0", "0.0000", "-1.00", "1.00001", "1e3", "1000000000000000"]) {
      expect({ bad, m: positive.test(bad) }).toEqual({ bad, m: false });
    }
  });

  it("states the coverage rule: sum(tenders) + sum(responsibilities) = posTotal, exactly", () => {
    expect(fieldText()).toContain("sum(tenders) + sum(responsibilities) = posTotal");
    expect(fieldText()).toContain("exact decimal arithmetic, no rounding");
    expect(captureText()).toContain("sum(tenders) + sum(responsibilities) = posTotal");
  });

  it("a sale with responsibilities and no tenders is NOT a tender-unknown sale (absent tenders = 0)", () => {
    expect(fieldText()).toContain("an absent `tenders` counts as zero");
    expect(fieldText()).toContain("is NOT a tender-unknown sale");
  });

  it("qualifies the RT-76 tender-only rule to bodies without responsibilities (Codex #779 P1)", () => {
    expect(captureText()).toContain(
      "When `responsibilities` is absent, the amounts MUST sum to `posTotal` exactly",
    );
    expect(captureText()).toContain("When it is present, the combined coverage rule replaces this one");
    expect(captureText()).toContain("The coverage rule (tender-only or combined) is checked first");
    const tenders = flat(field("CaptureSaleRequest", "tenders")?.description);
    expect(tenders).toContain("Without `responsibilities`, summing to `posTotal` exactly");
  });

  it("names 422 sale_responsibility_mismatch and orders it against sale_tender_mismatch", () => {
    expect(unprocessable()).toContain("`sale_responsibility_mismatch`");
    expect(unprocessable()).toContain("`sale_tender_mismatch` is returned only when `responsibilities` is absent");
    expect(captureText()).toContain(
      "Order of the 422s: the device-path offline refusal, then the coverage rule, then the line price invariant, then the payers",
    );
    expect(captureText()).not.toContain("the coverage rule is checked first, then the line price invariant");
  });

  it("names one non-disclosing 422 sale_responsibility_payer_invalid for every payer refusal", () => {
    const text = unprocessable();
    expect(text).toContain("`sale_responsibility_payer_invalid`");
    for (const cause of [
      "does not exist",
      "belongs to another tenant",
      "scoped to another store",
      "is `suspended`",
      "has no `externalRef`",
      "null or blank",
    ]) {
      expect({ cause, found: text.includes(cause) }).toEqual({ cause, found: true });
    }
    expect(text).toContain("one body for every cause");
  });

  it("states the per-sale uniqueness rules OpenAPI cannot express, each a 400", () => {
    expect(fieldText()).toContain("`payerRef` is unique within the sale");
    expect(fieldText()).toContain("`sequence` is unique within the sale");
    expect(fieldText()).toContain("400 `validation_error`");
  });

  it("hashes responsibilities into the payload; an absent list leaves the hash unchanged", () => {
    expect(fieldText()).toContain("part of the sale `payload_hash`");
    expect(fieldText()).toContain("a replay that adds, drops or changes a responsibility is a different payload (409)");
    expect(fieldText()).toContain("An absent list leaves the `payload_hash` of the sale unchanged");
  });

  it("a replay answers after authentication and the RT-224 claim check, before the role check and every 422 (review #779)", () => {
    expect(captureText()).toContain(
      "A replay of an already-captured sale answers after authentication and the RT-224 cashier-claim check (403 `refused`), and before the role check (403 `sale_responsibility_role_refused`) and every 422",
    );
  });

  it("a refusal of a responsibility-bearing sale is repair evidence, never silently retried", () => {
    expect(info()).toContain("never silently retried");
  });

  it("offline credit (owner decision 2026-10-16, option A): envelope path only, synchronous before finalize", () => {
    expect(info()).toContain("OFFLINE CREDIT (owner decision 2026-10-16, option A;");
    expect(info()).toContain("accepted only on the `operatorAuthorization` path");
    expect(info()).toContain(
      "MUST capture a responsibility-bearing sale synchronously, online, before finalizing it, and MUST NOT queue it",
    );
    expect(info()).toContain("credit is manager/admin-only");
    expect(info()).not.toContain("OFFLINE CREDIT (OWNER-PENDING");
    expect(fieldText()).toContain("422 `sale_responsibility_offline_refused`");
  });

  it("limits responsibilities to an owner / tenant_admin / store_manager envelope operator, else 403 sale_responsibility_role_refused", () => {
    expect(info()).not.toContain("OWNER-PENDING");
    expect(info()).toContain("only for an envelope operator whose role is `owner`, `tenant_admin` or `store_manager`");
    const forbidden = flat(
      (salesDoc.components?.responses?.["CaptureForbidden"] as { description?: string } | undefined)?.description,
    );
    expect(forbidden).toContain("`refused`");
    expect(forbidden).toContain("`sale_responsibility_role_refused`");
    expect(forbidden).toContain("the RT-530 eligible set");
    expect(
      (salesDoc.components?.responses?.["CaptureForbidden"] as { content?: Record<string, { schema?: unknown }> } | undefined)
        ?.content?.["application/json"]?.schema,
    ).toEqual({ $ref: "#/components/schemas/Error" });
    expect(captureText()).toContain(
      "the role check (403 `sale_responsibility_role_refused`) is decided after authentication and before every 422",
    );
    expect(fieldText()).toContain("403 `sale_responsibility_role_refused`");
  });

  it("names 422 sale_responsibility_offline_refused for responsibilities on the device path, ordered first", () => {
    expect(unprocessable()).toContain("`sale_responsibility_offline_refused`");
    expect(unprocessable()).toContain("on the `device` path");
    expect(captureText()).toContain(
      "On the `device` path a body with `responsibilities` is 422 `sale_responsibility_offline_refused`, decided before the coverage rule",
    );
  });

  it("on the synchronous path every 422 reaches the till before finalize; a transient failure is retried synchronously only", () => {
    expect(info()).toContain("reaches the till BEFORE the sale is finalized");
    expect(info()).toContain("never through the background drain");
  });

  it("states reversal semantics of a responsibility-bearing sale are undefined (OQ-4 carve)", () => {
    expect(info()).toContain("Reversal (void / return) of a responsibility-bearing sale is UNDEFINED");
  });

  it("the sale read exposes responsibilities, OPTIONAL until RT-418 emits them", () => {
    const list = field("Sale", "responsibilities");
    expect(list?.type).toBe("array");
    expect(list?.items?.$ref).toBe("#/components/schemas/SaleResponsibility");
    expect(list?.maxItems).toBe(1);
    expect(list?.minItems).toBeUndefined();
    expect(schema("Sale")?.required).not.toContain("responsibilities");
  });

  it("orders the rollout: accepted from RT-418; strict clients re-pin first (RT-76 precedent)", () => {
    expect(info()).toContain("the server accepts `responsibilities` from RT-418");
    expect(info()).toContain("must re-pin this version BEFORE RT-418 deploys");
    expect(fieldText()).toContain("Accepted from RT-418");
  });

  it("a share is gross: tax is not split per payer (035 OQ-2, review #779)", () => {
    expect(flat((schema("SaleResponsibility") as { description?: string } | undefined)?.description)).toContain("a gross share of `posTotal`; tax is not split per payer (035 OQ-2");
  });

  it("a payer resolves to this store or a tenant-wide payer (review #779)", () => {
    expect(flat(field("SaleResponsibility", "payerRef")?.description)).toContain(
      "a payer of this store or a tenant-wide payer (`storeId` null)",
    );
  });

  it("the read says absent, not empty, for a sale without responsibilities (review #779)", () => {
    const list = flat(field("Sale", "responsibilities")?.description);
    expect(list).toContain("Absent for a sale captured without them");
    expect(list).not.toContain("Empty for");
  });

  it("is not a payment ledger and carries no balance or lifecycle state", () => {
    expect(info()).toContain("NOT a receivable");
    for (const banned of ["balance", "outstanding", "state", "status"]) {
      expect(Object.keys(schema("SaleResponsibility")?.properties ?? {})).not.toContain(banned);
    }
  });
});

// ===========================================================================
// RT-577 — reversal of a responsibility-bearing (credit) sale (1.11.0-draft;
// owner-approved V1 decision, Jira RT-577, 2026-10-17): the ordinary
// void / return / refund routes refuse it for every operator, and a
// Manager/Admin reverses it through `recordCreditSaleReversal`, which pays out
// only the collected share and turns the credit share into a receivable
// adjustment. The new operation is contract-only until the RT-577 runtime PR.
// ===========================================================================
describe("pos-sales/sales.yaml — RT-577 credit-sale reversal", () => {
  type Node = {
    type?: string | string[];
    format?: string;
    enum?: string[];
    minItems?: number;
    minLength?: number;
    maxLength?: number;
    pattern?: string;
    $ref?: string;
    items?: { $ref?: string };
    anyOf?: Array<{ $ref?: string; type?: string }>;
    description?: string;
  };
  const flat = (t: string | undefined): string => (t ?? "").replace(/\s+/g, " ");
  const described = (node: unknown): string => flat((node as { description?: string } | undefined)?.description);
  const schema = (name: string): (SchemaObject & Record<string, unknown>) | undefined =>
    salesDoc.components?.schemas?.[name] as (SchemaObject & Record<string, unknown>) | undefined;
  const field = (schemaName: string, name: string): Node | undefined =>
    (schema(schemaName)?.properties ?? {})[name] as Node | undefined;
  const response = (name: string): string => described(salesDoc.components?.responses?.[name]);
  const responseRef = (operationId: string, status: string): string | undefined =>
    ((findOp(operationId)?.responses ?? {}) as Record<string, { $ref?: string }>)[status]?.$ref;
  const info = (): string => flat(salesDoc.info?.description);
  const reversalOp = (): (OperationObject & Record<string, unknown>) | undefined =>
    findOp("recordCreditSaleReversal") as (OperationObject & Record<string, unknown>) | undefined;
  const reversalText = (): string => described(reversalOp());

  it("bumps the version to 1.11.0-draft with an RT-577 note citing the owner decision of 2026-10-17", () => {
    expect(salesDoc.info?.version).toBe("1.11.0-draft");
    expect(info()).toContain("RT-577 (1.11.0-draft; [GATED] owner-approved V1 decision, Jira RT-577, 2026-10-17");
  });

  it("marks the new operation contract-only with a runtime note naming the RT-577 runtime PR", () => {
    const op = reversalOp();
    expect(op?.["x-runtime-status"]).toBe("contract-only");
    expect(String(op?.["x-runtime-note"] ?? "")).toContain("RT-577 runtime");
  });

  it("is a POS write on the operator envelope with the shared Idempotency-Key", () => {
    const op = reversalOp();
    expect(op?.security).toEqual([{ operatorAuthorization: [] }]);
    expect(op?.["x-idempotency"]).toBe("required");
    expect(JSON.stringify(op?.parameters)).toContain("#/components/parameters/IdempotencyKey");
    expect(JSON.stringify(op?.parameters)).toContain("#/components/parameters/SaleRef");
  });

  it("maps its responses: 200 replay / 201 / 400 / 401 / 403 / 404 / 409 / 422 / 500", () => {
    const responses = (reversalOp()?.responses ?? {}) as Record<string, { $ref?: string }>;
    expect(Object.keys(responses).sort()).toEqual(["200", "201", "400", "401", "403", "404", "409", "422", "500"]);
    expect(responseRef("recordCreditSaleReversal", "409")).toBe("#/components/responses/ReversalConflict");
    expect(responseRef("recordCreditSaleReversal", "422")).toBe("#/components/responses/CreditReversalUnprocessable");
    expect(JSON.stringify(responses["201"])).toContain("#/components/schemas/CreditSaleReversal");
  });

  describe("the ordinary routes refuse a responsibility-bearing sale", () => {
    it("recordReturn and recordRefund declare the 403 CreditSaleReversalRestricted; recordVoid names the code in VoidForbidden", () => {
      expect(responseRef("recordReturn", "403")).toBe("#/components/responses/CreditSaleReversalRestricted");
      expect(responseRef("recordRefund", "403")).toBe("#/components/responses/CreditSaleReversalRestricted");
      expect(response("CreditSaleReversalRestricted")).toContain("`credit_sale_reversal_restricted`");
      expect(response("VoidForbidden")).toContain("`credit_sale_reversal_restricted`");
    });

    it("refuses every operator, a cashier included, keyed on responsibility_count > 0, and points eligible operators at the credit reversal", () => {
      const text = response("CreditSaleReversalRestricted");
      expect(text).toContain("`sales.responsibility_count > 0`");
      expect(text).toContain("for every operator, whatever the role");
      expect(text).toContain("`recordCreditSaleReversal`");
      expect(text).toContain("Hiding the action on the till is not the control");
    });

    it("orders the refusal after the sale resolves and a provenance replay, before every other check", () => {
      for (const id of ["recordVoid", "recordReturn", "recordRefund"]) {
        expect({ id, ordered: described(findOp(id)).includes("Credit sales (RT-577, from the RT-577 runtime)") }).toEqual({ id, ordered: true });
      }
      expect(described(findOp("recordVoid"))).toContain(
        "after the sale resolves (404) and a provenance replay (200), and before reversal exclusivity (409) and every RT-530 check",
      );
      expect(described(findOp("recordReturn"))).toContain(
        "after the returns gate and the sale resolve (404) and a provenance replay (200, or its 409 `conflict`), and before reversal exclusivity (409), the line checks (400, 409 `over_return`) and the tender check (422)",
      );
      expect(described(findOp("recordRefund"))).toContain(
        "after the sale resolves (404) and a provenance replay (200, or its 409 provenance conflict)",
      );
    });

    it("states the replay semantics: stored results replay unchanged, a refused request stores nothing and answers the same again", () => {
      const text = response("CreditSaleReversalRestricted");
      expect(text).toContain("A reversal recorded before the RT-577 runtime still replays its stored result");
      expect(text).toContain("nothing is recorded and no idempotency entry is stored");
      expect(text).toContain("the same request answers the same 403 every time");
      expect(text).toContain("MUST NOT re-send it under another envelope");
    });

    it("leaves sales without responsibilities unchanged", () => {
      expect(response("CreditSaleReversalRestricted")).toContain(
        "A sale without responsibilities is unaffected",
      );
    });
  });

  describe("the credit reversal request", () => {
    it("is strict and requires provenance, kind, refundTenders and reason", () => {
      expect(schema("CreditSaleReversalRequest")?.additionalProperties).toBe(false);
      expect(schema("CreditSaleReversalRequest")?.required?.slice().sort()).toEqual(
        ["externalId", "kind", "reason", "refundTenders", "sourceSystem"],
      );
      expect(field("CreditSaleReversalRequest", "kind")?.enum).toEqual(["void", "return"]);
    });

    it("reuses the return line and the RT-530 approval evidence; refund tenders are the D8 mirror shape", () => {
      expect(field("CreditSaleReversalRequest", "lines")?.items?.$ref).toBe("#/components/schemas/ReturnLineRequest");
      expect(field("CreditSaleReversalRequest", "refundTenders")?.items?.$ref).toBe("#/components/schemas/CreditReversalRefundTender");
      expect(field("CreditSaleReversalRequest", "refundTenders")?.minItems).toBe(0);
      expect(field("CreditSaleReversalRequest", "approval")?.$ref).toBe("#/components/schemas/VoidApproval");
      expect(field("CreditSaleReversalRequest", "businessDate")).toMatchObject({ type: "string", format: "date" });
      expect(schema("RefundTender")?.properties?.["method"]).toMatchObject({ enum: ["cash"] });
    });

    it("binds lines and cash-only refunds to a return, and businessDate to a void, in the schema (D6/D8)", () => {
      const s = schema("CreditSaleReversalRequest") as Record<string, unknown>;
      expect(s["if"]).toEqual({ properties: { kind: { const: "return" } }, required: ["kind"] });
      expect(s["then"]).toEqual({
        required: ["lines"],
        not: { required: ["businessDate"] },
        properties: { refundTenders: { items: { $ref: "#/components/schemas/RefundTender" } } },
      });
      expect(s["else"]).toEqual({ not: { required: ["lines"] } });
    });

    it("requires a reason with a non-whitespace character; NUL is a 400", () => {
      const reason = field("CreditSaleReversalRequest", "reason");
      expect(reason).toMatchObject({ type: "string", minLength: 1, maxLength: 500 });
      const re = new RegExp(reason?.pattern ?? "$^");
      expect(re.test("customer changed mind")).toBe(true);
      expect(re.test("   ")).toBe(false);
      expect(reason?.description).toContain("NUL");
    });
  });

  describe("authorization: an elevated role is necessary but not sufficient", () => {
    it("accepts only a live owner / tenant_admin / store_manager with access to the sale store, else 403 credit_reversal_role_refused", () => {
      const forbidden = response("CreditReversalForbidden");
      expect(forbidden).toContain("`credit_reversal_role_refused`");
      expect(forbidden).toContain("`owner`, `tenant_admin` or `store_manager`");
      expect(forbidden).toContain("cannot be established");
      expect(reversalText()).toContain("An eligible role is necessary but never sufficient");
    });

    it("keeps the RT-530 four-eyes approval and business-day rule for a void", () => {
      expect(reversalText()).toContain("the RT-530 checks 1 to 7 run in their order");
      const forbidden = response("CreditReversalForbidden");
      for (const code of ["void_approval_required", "void_requester_mismatch", "void_self_approval", "void_requester_not_eligible", "void_approver_not_eligible"]) {
        expect({ code, named: forbidden.includes(`\`${code}\``) }).toEqual({ code, named: true });
      }
      const unprocessable = response("CreditReversalUnprocessable");
      expect(unprocessable).toContain("`void_approval_invalid`");
      expect(unprocessable).toContain("`void_outside_business_day`");
    });
  });

  describe("money: never pay out credit-funded or uncollected money", () => {
    it("states the cumulative pro-rata allocation, rounded down to the currency minor unit", () => {
      expect(reversalText()).toContain(
        "`refundableAmount = floor_m(C × X1 / P) − floor_m(C × X0 / P)`",
      );
      expect(reversalText()).toContain("the receivable adjustment is `reversalTotal − refundableAmount`");
      expect(reversalText()).toContain("the cash refunded on a sale never exceeds C");
      expect(reversalText()).toContain("never a float");
    });

    it("requires the refund tenders to equal the server-computed refundable amount, else 422 credit_reversal_refund_mismatch", () => {
      expect(response("CreditReversalUnprocessable")).toContain("`credit_reversal_refund_mismatch`");
      expect(reversalText()).toContain("A full-credit sale (no `tenders`) refunds nothing");
    });

    it("routes the credit share to the payer through the posting feed, which stays held until RT-571 / RT-419", () => {
      expect(reversalText()).toContain("Backend-Core → ERPNext-Connector → ERPNext");
      expect(reversalText()).toContain("does not lift that hold");
      expect(field("CreditSaleReversal", "receivableAdjustment")?.anyOf).toEqual([
        { $ref: "#/components/schemas/ReceivableAdjustment" },
        { type: "null" },
      ]);
      expect(schema("ReceivableAdjustment")?.required?.slice().sort()).toEqual(["adjustmentRef", "amount", "payerRef"]);
    });

    it("fails closed with no writes when allocation, payer settlement or the sale's credit status cannot be established", () => {
      const text = response("CreditReversalUnprocessable");
      for (const code of [
        "credit_reversal_not_applicable",
        "credit_reversal_allocation_unavailable",
        "credit_reversal_settlement_unavailable",
        "credit_reversal_refund_mismatch",
      ]) {
        expect({ code, named: text.includes(`\`${code}\``) }).toEqual({ code, named: true });
      }
      expect(text).toContain("Nothing is recorded and nothing is paid");
      expect(reversalText()).toContain("for administrative investigation");
    });
  });

  it("orders every check of the new operation", () => {
    expect(reversalText()).toContain(
      "Order: the returns gate (404, `kind: return` only), the sale (404), a provenance replay (200, or its 409 `conflict`), the role (403 `credit_reversal_role_refused`), the sale's credit status (422 `credit_reversal_not_applicable`), reversal exclusivity (409 `already_reversed`), then for a void the RT-530 checks and for a return the line checks (400, 409 `over_return`), then allocation (422 `credit_reversal_allocation_unavailable`), payer settlement (422 `credit_reversal_settlement_unavailable`), for a return the second approval (403 `credit_return_approval_required`, then 403 `credit_return_approval_refused`) and the refund tenders (422 `credit_reversal_refund_mismatch`)",
    );
  });

  it("places the provenance replay after the returns gate and the sale lookup, as the Order does (review #803)", () => {
    expect(reversalText()).toContain(
      "replays (200) right after the returns gate and the sale resolve (404) and before every other check",
    );
    expect(reversalText()).not.toContain("replays (200) before every check");
  });

  it("records the audit evidence the decision lists", () => {
    const text = reversalText();
    expect(text).toContain("`sale.credit_reversed`");
    for (const fact of ["the actor's user id and role", "the store", "the reason", "the server time", "the refund tenders", "the receivable adjustment", "`request_id`"]) {
      expect({ fact, found: text.includes(fact) }).toEqual({ fact, found: true });
    }
  });

  it("the reversal projection is strict and leaks no DB internals (§IV)", () => {
    expect(schema("CreditSaleReversal")?.additionalProperties).toBe(false);
    expect(schema("ReceivableAdjustment")?.additionalProperties).toBe(false);
    for (const banned of ["tenantId", "payloadHash", "createdBy"]) {
      expect(Object.keys(schema("CreditSaleReversal")?.properties ?? {})).not.toContain(banned);
    }
  });

  it("orders the rollout: the server refuses from the RT-577 runtime without waiting for the POS (RT-530 order)", () => {
    expect(info()).toContain("ROLLOUT ORDER");
    expect(info()).toContain("from the RT-577 runtime");
    expect(info()).toContain("which does not wait for a POS release: the server refusal is the control");
    expect(info()).toContain(
      "adds the code `credit_sale_reversal_restricted` to the existing 403 `VoidForbidden` of `recordVoid`, so a client that switches on its codes sees a new value",
    );
    expect(info()).toContain("No existing request schema or schema object changes");
    expect(info()).not.toContain("changes no existing request or response schema");
  });
});

// ===========================================================================
// RT-577 — coordinator Opus review of #803 (H1, M1, L1–L5, L7)
// ===========================================================================
describe("pos-sales/sales.yaml — RT-577 Opus review hardening", () => {
  const flat = (t: string | undefined): string => (t ?? "").replace(/\s+/g, " ");
  const described = (node: unknown): string => flat((node as { description?: string } | undefined)?.description);
  const reversalText = (): string => described(findOp("recordCreditSaleReversal"));
  const response = (name: string): string => described(salesDoc.components?.responses?.[name]);
  const prop = (schemaName: string, name: string): { $ref?: string; pattern?: string } | undefined =>
    (salesDoc.components?.schemas?.[schemaName]?.properties ?? {})[name] as { $ref?: string; pattern?: string } | undefined;

  function requestValidator(): ValidateFunction {
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    addFormats(ajv);
    ajv.addSchema({ ...(salesDoc as object), $id: "sales" });
    return ajv.compile({ $ref: "sales#/components/schemas/CreditSaleReversalRequest" });
  }
  const UUID = "0190a8a0-0000-7000-8000-000000000001";
  const base = { sourceSystem: "pos-pulse", externalId: "rev-1", refundTenders: [], reason: "customer returned goods" };
  const returnBody = { ...base, kind: "return", lines: [{ lineRef: UUID, quantity: "1" }] };
  const approval = {
    approvalId: UUID,
    action: "sale.void",
    saleRef: UUID,
    amount: "10.00",
    requesterUserId: UUID,
    approverUserId: "0190a8a0-0000-7000-8000-000000000002",
    policyVersion: "v1",
    approvedAt: "2026-10-17T10:00:00Z",
  };
  const voidBody = { ...base, kind: "void", refundTenders: [{ method: "cash", amount: "10.00" }], businessDate: "2026-10-17", approval };

  it("H1: a sale whose lines do not sum to posTotal is allocation_unavailable, so X1 never exceeds P", () => {
    expect(reversalText()).toContain(
      "the sale's lines do not sum to its `posTotal` exactly (its stored `mismatch_flag` is true or null,",
    );
    expect(reversalText()).toContain("so X1 never exceeds P");
    expect(response("CreditReversalUnprocessable")).toContain(
      "the sale's lines do not sum to its `posTotal` exactly",
    );
  });

  it("M1: the refund's 403 comes after the sale and a provenance replay, before every other check", () => {
    expect(described(findOp("recordRefund"))).toContain(
      "after the sale resolves (404) and a provenance replay (200, or its 409 provenance conflict), and before every other check (422 `already_applied`)",
    );
    expect(response("CreditSaleReversalRestricted")).toContain(
      "The `Idempotency-Key` layer answers first on every route",
    );
  });

  it("L1: the RT-417 UNDEFINED reversal note points at RT-577", () => {
    expect(flat(salesDoc.info?.description)).toContain(
      "UNDEFINED in this version (the 035 OQ-4 carve): the posting feed holds such reversal work items until a later issue defines them. Superseded on the POS side by RT-577 below; the posting-feed hold stays.",
    );
  });

  it("L2: refundableAmount and reversalTotal are non-negative amounts", () => {
    expect(prop("CreditSaleReversal", "refundableAmount")?.$ref).toBe("#/components/schemas/NonNegativeDecimalAmount");
    expect(prop("CreditSaleReversal", "reversalTotal")?.$ref).toBe("#/components/schemas/NonNegativeDecimalAmount");
  });

  it("L3: the reason pattern itself excludes NUL and blank values", () => {
    const re = new RegExp(prop("CreditSaleReversalRequest", "reason")?.pattern ?? "$^", "u");
    expect(re.test("customer returned goods")).toBe(true);
    expect(re.test(" \t ")).toBe(false);
    expect(re.test("bad\u0000reason")).toBe(false);
  });

  it("L4: the allocation reads X0 under the sale row lock", () => {
    expect(reversalText()).toContain("X0 is read under the sale row lock (`FOR UPDATE`)");
  });

  it("L7: the allocation relies on the RT-105 minor-unit line invariant", () => {
    expect(reversalText()).toContain("relies on the RT-105 line invariant");
  });

  describe("L5: sample bodies against the request schema (if/then/else)", () => {
    it("accepts a well-formed return and a well-formed void", () => {
      const validate = requestValidator();
      expect({ ok: validate(returnBody), errors: validate.errors }).toMatchObject({ ok: true });
      expect({ ok: validate(voidBody), errors: validate.errors }).toMatchObject({ ok: true });
    });

    it("rejects a void that carries lines", () => {
      expect(requestValidator()({ ...voidBody, lines: returnBody.lines })).toBe(false);
    });

    it("accepts a return carrying a second approval (D6) and rejects one carrying a businessDate", () => {
      const validate = requestValidator();
      const returnApproval = { ...approval, action: "sale.credit_return", amount: "10.00" };
      const paid = { ...returnBody, refundTenders: [{ method: "cash", amount: "10.00" }], approval: returnApproval };
      expect({ ok: validate(paid), errors: validate.errors }).toMatchObject({ ok: true });
      expect(validate({ ...returnBody, businessDate: "2026-10-17" })).toBe(false);
    });

    it("D8: a void may mirror a card tender; a return refund is cash only", () => {
      const validate = requestValidator();
      const card = { method: "card_external", amount: "4.00", tenderRef: UUID, reference: "A1B2" };
      const mirrored = { ...voidBody, refundTenders: [{ method: "cash", amount: "6.00", tenderRef: UUID }, card] };
      expect({ ok: validate(mirrored), errors: validate.errors }).toMatchObject({ ok: true });
      expect(validate({ ...returnBody, refundTenders: [card] })).toBe(false);
      expect(validate({ ...voidBody, refundTenders: [{ method: "cash", amount: "6.00", reference: "A1B2" }] })).toBe(false);
    });

    it("rejects a return without lines, a blank reason and a reason holding NUL", () => {
      const validate = requestValidator();
      const { lines: _omit, ...noLines } = returnBody;
      expect(validate(noLines)).toBe(false);
      expect(validate({ ...returnBody, reason: "   " })).toBe(false);
      expect(validate({ ...returnBody, reason: "a\u0000b" })).toBe(false);
    });
  });
});

// ===========================================================================
// RT-577 — owner rulings 2026-10-17 on #803 (D6 second approval, D8 void
// refund tenders) and review N1 (null mismatch_flag)
// ===========================================================================
describe("pos-sales/sales.yaml — RT-577 owner rulings (D6, D8, N1)", () => {
  const flat = (t: string | undefined): string => (t ?? "").replace(/\s+/g, " ");
  const described = (node: unknown): string => flat((node as { description?: string } | undefined)?.description);
  const reversalText = (): string => described(findOp("recordCreditSaleReversal"));
  const response = (name: string): string => described(salesDoc.components?.responses?.[name]);
  const schemaOf = (name: string): (SchemaObject & Record<string, unknown>) | undefined =>
    salesDoc.components?.schemas?.[name] as (SchemaObject & Record<string, unknown>) | undefined;

  describe("D6: a cash-paying credit return needs a second approval", () => {
    it("requires it only when the return pays out cash; a payout-free reversal needs the single Manager/Admin", () => {
      expect(reversalText()).toContain(
        "When a `return` pays out cash (`refundableAmount` > 0), a second approval is REQUIRED",
      );
      expect(reversalText()).toContain(
        "A reversal with no cash payout (a receivable adjustment only) needs only the authorized Manager/Admin",
      );
    });

    it("binds the approval to `sale.credit_return`, this sale and the server-computed refundableAmount", () => {
      expect(reversalText()).toContain(
        "`approval.action` is `sale.credit_return`, `approval.saleRef` is the path sale, `approval.amount` equals the server-computed `refundableAmount` as an exact decimal",
      );
    });

    it("never counts the same actor twice", () => {
      expect(reversalText()).toContain("The same actor never counts twice");
      expect(reversalText()).toContain(
        "the approver is an eligible manager who is neither the requester nor the user who captured the sale",
      );
    });

    it("refuses a missing approval and any failing one with stable 403 codes, recording nothing", () => {
      const forbidden = response("CreditReversalForbidden");
      expect(forbidden).toContain("`credit_return_approval_required`");
      expect(forbidden).toContain("`credit_return_approval_refused`");
      expect(forbidden).toContain("one body for every cause");
    });

    it("states the replay semantics: replay answers first; a refusal does not consume the approvalId", () => {
      expect(reversalText()).toContain(
        "An `approvalId` is single-use within the tenant across `recordVoid` and this route; a refused request does not consume it",
      );
    });

    it("the approval property describes both uses", () => {
      expect(described(schemaOf("CreditSaleReversalRequest")?.properties?.["approval"])).toContain(
        "`return`: required when `refundableAmount` > 0",
      );
    });
  });

  describe("D8: a void mirrors the collected tenders; a return refunds cash only", () => {
    it("states the mirror rule; only a void has no card-to-cash path, a return pays a card-collected share in cash", () => {
      expect(reversalText()).toContain("A `void` refunds by mirroring the sale's collected `tenders` (RT-10 D6)");
      expect(reversalText()).toContain(
        "For a void there is no card-to-cash path; a return refunds its collected share in cash, including any share collected by card (owner ruling D8).",
      );
      expect(reversalText()).not.toContain("There is no card-to-cash path");
      expect(reversalText()).toContain("A `return` refunds in cash only (RT-14 D3)");
      expect(reversalText()).not.toContain("whatever the collected tender method");
    });

    it("defines the strict mirror tender shape: cash or card_external, reference only on a card", () => {
      const t = schemaOf("CreditReversalRefundTender");
      expect(t?.additionalProperties).toBe(false);
      expect(t?.required?.slice().sort()).toEqual(["amount", "method"]);
      expect((t?.properties?.["method"] as { enum?: string[] } | undefined)?.enum).toEqual(["cash", "card_external"]);
      expect(t?.["if"]).toEqual({ properties: { method: { const: "cash" } }, required: ["method"] });
      expect(t?.["then"]).toEqual({ not: { required: ["reference"] } });
    });

    it("the reversal projection carries the mirror tender shape", () => {
      const items = (schemaOf("CreditSaleReversal")?.properties?.["refundTenders"] as { items?: { $ref?: string } } | undefined)?.items;
      expect(items?.$ref).toBe("#/components/schemas/CreditReversalRefundTender");
    });
  });

  it("N1: a null mismatch_flag is allocation_unavailable, never a pass", () => {
    expect(reversalText()).toContain("its stored `mismatch_flag` is true or null");
    expect(response("CreditReversalUnprocessable")).toContain("its stored `mismatch_flag` is true or null");
  });
});
