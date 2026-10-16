/**
 * apps/api/test/catalog/sales/contract/sale-history.contract.spec.ts
 *
 * RT-537 (RT-534 S1) — OpenAPI conformance test for
 * `packages/contracts/openapi/pos-sales/sale-history.yaml`.
 *
 * [GATED] approval: Jira RT-537 comment 12057 (owner, 2026-10-16). Design:
 * RT-537 comments 12054-12056; owner decisions OD-534-1..8 (RT-534 comment
 * 12048, Confluence 40468506).
 *
 * Structural / load-only, like `sales.contract.spec.ts`: the contract is loaded
 * through the production `loadOpenApiContracts` helper with an explicit `dir`
 * (the helper's scan is non-recursive). No app boot and no HTTP: the runtime is
 * RT-539.
 */
import { resolve } from "node:path";

import { loadOpenApiContracts } from "../../../../src/openapi/loader";

const CONTRACT_ID = "sale-history";

const LIST_PATH = "/api/pos/v1/sale-history";
const DETAIL_PATH = "/api/pos/v1/sale-history/{saleRef}";
const REPRINT_PATH = "/api/pos/v1/sale-history/{saleRef}/reprints";

const OPERATIONS: Array<{ id: string; path: string; method: string; audit: string }> = [
  { id: "listSaleHistory", path: LIST_PATH, method: "get", audit: "sale_history.listed" },
  {
    id: "readSaleHistoryDetail",
    path: DETAIL_PATH,
    method: "get",
    audit: "sale_history.detail_read",
  },
  { id: "recordSaleReprint", path: REPRINT_PATH, method: "post", audit: "sale.receipt.reprinted" },
];

/** OD-534 "tender information" in the detail: the only tender-named fields allowed. */
const APPROVED_TENDER_FIELDS = ["SaleHistoryDetail.tenders", "SaleHistoryDetail.tenderState"];

function posSalesContractsDir(): string {
  return resolve(__dirname, "..", "..", "..", "..", "..", "..", "packages", "contracts", "openapi", "pos-sales");
}

interface ParameterObject {
  $ref?: string;
  name?: string;
  in?: string;
  required?: boolean;
  description?: string;
  schema?: Record<string, unknown>;
}

interface OperationObject {
  operationId?: string;
  description?: string;
  security?: Array<Record<string, unknown>>;
  parameters?: ParameterObject[];
  requestBody?: { required?: boolean; content?: Record<string, { schema?: { $ref?: string } }> };
  responses?: Record<string, { $ref?: string; headers?: Record<string, unknown> }>;
  "x-idempotency"?: string;
  "x-audit-action"?: string;
}

interface SchemaObject {
  type?: string | string[];
  enum?: unknown[];
  additionalProperties?: boolean;
  required?: string[];
  properties?: Record<string, Record<string, unknown>>;
  description?: string;
  default?: unknown;
  maximum?: number;
}

interface OpenApiDocument {
  openapi?: string;
  info?: { title?: string; version?: string; description?: string };
  paths?: Record<string, Record<string, OperationObject>>;
  components?: {
    schemas?: Record<string, SchemaObject>;
    securitySchemes?: Record<string, Record<string, unknown>>;
    parameters?: Record<string, ParameterObject>;
    responses?: Record<string, { description?: string; headers?: Record<string, unknown> }>;
    headers?: Record<string, unknown>;
  };
}

let doc: OpenApiDocument;
let salesDoc: OpenApiDocument;
let topLevelOperationIds: Set<string>;

beforeAll(() => {
  const contracts = loadOpenApiContracts({ dir: posSalesContractsDir() });
  const found = contracts.find((c) => c.id === CONTRACT_ID);
  if (!found) {
    throw new Error(
      `${CONTRACT_ID} not found; loaded ids: [${contracts.map((c) => c.id).join(", ")}]`,
    );
  }
  doc = found.document as OpenApiDocument;
  salesDoc = contracts.find((c) => c.id === "sales")?.document as OpenApiDocument;

  topLevelOperationIds = new Set<string>();
  for (const contract of loadOpenApiContracts()) {
    for (const item of Object.values((contract.document as OpenApiDocument).paths ?? {})) {
      for (const op of Object.values(item)) {
        if (op && typeof op.operationId === "string") topLevelOperationIds.add(op.operationId);
      }
    }
  }
});

function op(operationId: string): OperationObject {
  for (const item of Object.values(doc.paths ?? {})) {
    for (const candidate of Object.values(item)) {
      if (candidate.operationId === operationId) return candidate;
    }
  }
  throw new Error(`operation ${operationId} not found`);
}

function param(name: string): ParameterObject {
  const found = doc.components?.parameters?.[name];
  if (!found) throw new Error(`parameter ${name} not found`);
  return found;
}

function paramRefs(operationId: string): string[] {
  return (op(operationId).parameters ?? []).map((p) => p.$ref ?? "");
}

function schema(name: string): SchemaObject {
  const found = doc.components?.schemas?.[name];
  if (!found) throw new Error(`schema ${name} not found`);
  return found;
}

function responseRef(operationId: string, status: string): string | undefined {
  return op(operationId).responses?.[status]?.$ref;
}

/** Collect every `$ref` string in a value. */
function refsIn(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(refsIn);
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, inner]) => refOrNested(key, inner));
}

function refOrNested(key: string, inner: unknown): string[] {
  return key === "$ref" && typeof inner === "string" ? [inner] : refsIn(inner);
}

describe("pos-sales/sale-history.yaml — loadability and document conventions", () => {
  it("is parseable by the production OpenAPI loader as OpenAPI 3.1", () => {
    expect(doc.openapi).toBe("3.1.0");
  });

  it("is a 1.0.0-draft that cites the [GATED] approval and the owner decisions", () => {
    expect(doc.info?.version).toBe("1.0.0-draft");
    const info = doc.info?.description ?? "";
    expect(info).toContain("[GATED] approval Jira RT-537 comment 12057");
    expect(info).toContain("OD-534-1..8");
    expect(info).toContain("Contract only");
  });

  it("states that a list covers only what the server has received (never the complete store)", () => {
    const info = doc.info?.description ?? "";
    expect(info).toContain("RECEIVED up to `asOf`");
    expect(info).toContain("never present a page as the complete store");
  });

  it("states that readSale and the Sale projection are unchanged", () => {
    expect(doc.info?.description ?? "").toContain("`readSale` (`sales.yaml`) and its `Sale` projection are unchanged");
  });

  it("resolves every internal $ref within this file (self-contained)", () => {
    const missing = refsIn(doc).filter((ref) => {
      const [, kind, name] = ref.match(/^#\/components\/([^/]+)\/([^/]+)$/) ?? [];
      if (!kind || !name) return true;
      const bucket = (doc.components as Record<string, Record<string, unknown> | undefined>)[kind];
      return !bucket || !(name in bucket);
    });
    expect(missing).toEqual([]);
  });

  it("reuses the canonical Error envelope of sales.yaml verbatim", () => {
    expect(schema("Error")).toMatchObject({
      required: ["error"],
      properties: salesDoc.components?.schemas?.["Error"]?.properties,
    });
  });
});

describe("pos-sales/sale-history.yaml — operations", () => {
  it("declares exactly the three history operations, on their paths and methods", () => {
    const declared: string[] = [];
    for (const [path, item] of Object.entries(doc.paths ?? {})) {
      for (const [method, candidate] of Object.entries(item)) {
        declared.push(`${method} ${path} ${candidate.operationId}`);
      }
    }
    expect(declared.sort()).toEqual(OPERATIONS.map((o) => `${o.method} ${o.path} ${o.id}`).sort());
  });

  it("collides with no shipped operationId (top-level or sales.yaml)", () => {
    const salesIds = new Set<string>();
    for (const item of Object.values(salesDoc.paths ?? {})) {
      for (const candidate of Object.values(item)) {
        if (candidate.operationId) salesIds.add(candidate.operationId);
      }
    }
    for (const { id } of OPERATIONS) {
      expect(topLevelOperationIds.has(id)).toBe(false);
      expect(salesIds.has(id)).toBe(false);
    }
  });

  it("accepts the envelope OR the device bearer on every operation (OD-534-1)", () => {
    for (const { id } of OPERATIONS) {
      expect(op(id).security).toEqual([{ operatorAuthorization: [] }, { device: [] }]);
    }
  });

  it("names its audit action on every operation (OD-534-7)", () => {
    for (const { id, audit } of OPERATIONS) {
      expect(op(id)["x-audit-action"]).toBe(audit);
    }
  });

  it("takes the cashier admission selector on every operation, and no store parameter", () => {
    for (const { id } of OPERATIONS) {
      expect(paramRefs(id)).toContain("#/components/parameters/CashierAdmission");
      const names = (op(id).parameters ?? []).map((p) => p.$ref?.split("/").pop() ?? p.name);
      expect(names).not.toContain("StoreId");
    }
    for (const name of Object.keys(doc.components?.parameters ?? {})) {
      expect(param(name).name).not.toMatch(/store/i);
    }
  });
});

describe("pos-sales/sale-history.yaml — the cashier path (Q-2)", () => {
  it("X-Cashier-Admission is an optional uuid header at the OpenAPI level", () => {
    expect(param("CashierAdmission")).toMatchObject({
      name: "X-Cashier-Admission",
      in: "header",
      required: false,
      schema: { type: "string", format: "uuid" },
    });
  });

  it("documents: required with device, a 401 with the envelope, a selector not a credential", () => {
    const text = param("CashierAdmission").description ?? "";
    expect(text).toContain("REQUIRED with the `device` scheme");
    expect(text).toContain("MUST be absent with");
    expect(text).toContain("generic 401");
    expect(text).toContain("It is a selector, not a");
    expect(text).toContain("live NOW");
    expect(text).toContain("covering `printedAt`");
    expect(text).toContain("generic 403 `refused`");
  });

  it("the device scheme is an opaque bearer accepted only with the admission header", () => {
    const device = doc.components?.securitySchemes?.["device"] ?? {};
    expect(device).toMatchObject({ type: "http", scheme: "bearer" });
    expect(device).not.toHaveProperty("bearerFormat");
    expect(String(device["description"])).toContain("ONLY together with the `X-Cashier-Admission` header");
  });

  it("restricts a cashier to their own sales across the store's terminals", () => {
    // The folded description keeps the line breaks of its indented bullets.
    const info = (doc.info?.description ?? "").replace(/\s+/g, " ");
    expect(info).toContain("only sales whose `created_by` is the admitted cashier");
    expect(info).toContain("from any");
    expect(info).toContain("non-disclosing 404");
    expect(info).toContain("never carried by the cursor");
  });
});

describe("pos-sales/sale-history.yaml — listSaleHistory (OD-534-4)", () => {
  it("requires inclusive business-date from/to (format: date)", () => {
    for (const name of ["BusinessDateFrom", "BusinessDateTo"]) {
      expect(param(name)).toMatchObject({ in: "query", required: true, schema: { type: "string", format: "date" } });
    }
    expect(param("BusinessDateFrom").name).toBe("from");
    expect(param("BusinessDateTo").name).toBe("to");
    expect(param("BusinessDateTo").description ?? "").toContain("`to - from <= 30`");
  });

  it("caps the range at 31 business days and never truncates", () => {
    const text = op("listSaleHistory").description ?? "";
    expect(text).toContain("at most 31 business days (`to - from <= 30`)");
    expect(text).toContain("400 `validation_error`; it is never");
    expect(text).toContain("truncated");
  });

  it("pages with an opaque cursor, default 50 and at most 100", () => {
    expect(param("PageSize").schema).toMatchObject({ type: "integer", minimum: 1, maximum: 100, default: 50 });
    expect(param("Cursor").schema).toMatchObject({ maxLength: 512, pattern: "^[A-Za-z0-9_-]+$" });
    expect(schema("SaleHistoryPage").properties?.["items"]).toMatchObject({ maxItems: 100 });
  });

  it("returns the freshness, timezone and visibility of the page", () => {
    expect(schema("SaleHistoryPage").required?.slice().sort()).toEqual(
      ["asOf", "from", "items", "nextCursor", "storeTimezone", "to", "visibility"].sort(),
    );
    expect(schema("SaleHistoryPage").properties?.["visibility"]).toMatchObject({ enum: ["store", "own_sales"] });
  });

  it("filters by device, operator (envelope only) and exact sale number", () => {
    expect(paramRefs("listSaleHistory")).toEqual(
      expect.arrayContaining([
        "#/components/parameters/DeviceRefQuery",
        "#/components/parameters/OperatorUserIdQuery",
        "#/components/parameters/SaleNumberQuery",
      ]),
    );
    expect(param("OperatorUserIdQuery").description ?? "").toContain("400 `validation_error` on the device");
  });

  it("maps 200/400/401/403/429/500", () => {
    expect(Object.keys(op("listSaleHistory").responses ?? {}).sort()).toEqual(
      ["200", "400", "401", "403", "429", "500"].sort(),
    );
  });
});

describe("pos-sales/sale-history.yaml — readSaleHistoryDetail", () => {
  it("maps 200/400/401/403/404/429/500 with the non-disclosing 404", () => {
    expect(Object.keys(op("readSaleHistoryDetail").responses ?? {}).sort()).toEqual(
      ["200", "400", "401", "403", "404", "429", "500"].sort(),
    );
    const notFound = doc.components?.responses?.["NotFound"]?.description ?? "";
    expect(notFound).toContain("another cashier's sale");
  });

  it("marks every fact that may be missing as nullable or unavailable, never guessed", () => {
    const detail = schema("SaleHistoryDetail");
    for (const name of ["changeGiven", "receiptHeader", "void"]) {
      expect(JSON.stringify(detail.properties?.[name])).toContain('"type":"null"');
    }
    expect(detail.properties?.["settledAt"]).toMatchObject({ type: ["string", "null"] });
    expect(detail.properties?.["lineOrder"]).toMatchObject({ enum: ["recorded", "not_recorded"] });
    expect(detail.properties?.["tenderState"]).toMatchObject({ enum: ["recorded", "unknown"] });
    expect(detail.properties?.["receiptFacts"]).toMatchObject({ enum: ["complete", "partial"] });
    expect(schema("SaleHistoryLine").properties?.["sequence"]).toMatchObject({ type: ["integer", "null"] });
  });

  it("a snapshot without changeGiven projects as \"0\"; null means no snapshot only", () => {
    const text = String(schema("SaleHistoryDetail").properties?.["changeGiven"]?.["description"]).replace(/\s+/g, " ");
    expect(text).toContain('"0" when a snapshot was captured without `changeGiven`');
    expect(text).toContain("null ONLY when the sale has no receipt snapshot");
    expect((schema("SaleHistoryDetail").description ?? "").replace(/\s+/g, " ")).toContain(
      "so the change is known",
    );
  });

  it("a complete receipt needs the tender order: a sequence on every tender, or a single tender", () => {
    expect((schema("SaleHistoryDetail").description ?? "").replace(/\s+/g, " ")).toContain(
      "with the tender order known (a `sequence` on every tender, or a single tender)",
    );
  });

  it("the sale_number filter fits the longest pairing-format sale number (82 characters)", () => {
    expect(param("SaleNumberQuery").schema).toMatchObject({ maxLength: 96 });
  });

  it("exposes the receipt number: equal to saleNumber when omitted, null only without a snapshot", () => {
    const detail = schema("SaleHistoryDetail");
    expect(detail.required).toContain("receiptNumber");
    expect(detail.properties?.["receiptNumber"]).toMatchObject({ type: ["string", "null"] });
    const text = String(detail.properties?.["receiptNumber"]?.["description"]).replace(/\s+/g, " ");
    expect(text).toContain("Equals `summary.saleNumber` when the snapshot omitted `receiptNumber`");
    expect(text).toContain("null ONLY when the sale has no receipt snapshot");
  });

  it("names the source of every displayed name and never falls back to email (OD-534-6)", () => {
    expect(schema("NameSource").enum).toEqual(["snapshot", "current", "unavailable"]);
    expect(schema("OperatorView").properties?.["displayName"]?.["description"]).toContain(
      "Never an email address",
    );
    expect(schema("DeviceView").properties?.["labelSource"]?.["$ref"]).toBe("#/components/schemas/NameSource");
  });

  it("takes the receipt header from the capture snapshot only (Q-3)", () => {
    expect(schema("ReceiptHeader").description ?? "").toContain("Never today's store");
  });

  it("shows the void approver's role only, no name or id", () => {
    expect(Object.keys(schema("VoidSummary").properties ?? {}).sort()).toEqual(
      ["approved", "approverRole", "voidBusinessDate", "voidedAt"].sort(),
    );
  });

  it("maps ERP posting to four read-only states, not a fiscal claim (OD-534-5, Q-4)", () => {
    const erp = schema("ErpPostingState");
    expect(erp.enum).toEqual(["posted", "pending", "failed", "unknown"]);
    const text = erp.description ?? "";
    expect(text).toContain("NOT a tax or");
    expect(text).toContain("`pending` and `failed_transient` -> pending");
    expect(text).toContain("`permanently_rejected` -> failed");
    expect(text).toContain("no posting row");
    expect(schema("ErpPostingView").required?.slice().sort()).toEqual(
      ["reversal", "reversalDocumentRef", "sale", "saleDocumentRef"].sort(),
    );
  });

  it("states the reprint eligibility the server enforces (OD-534-3/8)", () => {
    const eligibility = schema("ReprintEligibility");
    expect(eligibility.properties?.["duplicate"]).toMatchObject({
      enum: ["allowed", "unavailable_incomplete", "unavailable_voided"],
    });
    expect(eligibility.properties?.["saleRecord"]).toMatchObject({ enum: ["allowed"] });
    expect(schema("ReprintMark").enum).toEqual(["voided", "returned"]);
    expect(eligibility.description ?? "").toContain("A voided sale never gets a duplicate");
  });
});

describe("pos-sales/sale-history.yaml — recordSaleReprint (OD-534-2/3/7/8, Q-5/6/8)", () => {
  it("requires the Idempotency-Key with the interceptor's 16-128 printable ASCII rule", () => {
    expect(op("recordSaleReprint")["x-idempotency"]).toBe("required");
    expect(paramRefs("recordSaleReprint")).toContain("#/components/parameters/IdempotencyKey");
    expect(param("IdempotencyKey")).toMatchObject({
      name: "Idempotency-Key",
      in: "header",
      required: true,
      schema: { minLength: 16, maxLength: 128, pattern: "^[\\x21-\\x7E]{16,128}$" },
    });
    const pattern = new RegExp(String(param("IdempotencyKey").schema?.["pattern"]));
    expect(pattern.test("pos-pulse:7b1e0f7a-2c7d-4c47-9a54-5a1f0c2e9b11")).toBe(true);
    expect(pattern.test("too short")).toBe(false);
  });

  it("the reads take no Idempotency-Key", () => {
    for (const id of ["listSaleHistory", "readSaleHistoryDetail"]) {
      expect(paramRefs(id)).not.toContain("#/components/parameters/IdempotencyKey");
    }
  });

  it("has two modes and two kinds, with a required print time", () => {
    const request = schema("SaleReprintRequest");
    expect(request.additionalProperties).toBe(false);
    expect(request.required?.slice().sort()).toEqual(["kind", "mode", "printedAt"]);
    expect(request.properties?.["mode"]).toMatchObject({ enum: ["authorize", "record"] });
    expect(request.properties?.["kind"]).toMatchObject({ enum: ["duplicate", "sale_record"] });
    expect(request.properties?.["printedAt"]).toMatchObject({ type: "string", format: "date-time" });
  });

  it("requires localCopyNumber with record and forbids it with authorize", () => {
    const request = schema("SaleReprintRequest") as SchemaObject & {
      if?: unknown;
      then?: unknown;
      else?: unknown;
    };
    expect(request.if).toEqual({ properties: { mode: { const: "record" } }, required: ["mode"] });
    expect(request.then).toEqual({ required: ["localCopyNumber"] });
    expect(request.else).toEqual({ not: { required: ["localCopyNumber"] } });
    expect(request.description ?? "").toContain("400 `validation_error`");
  });

  it("a record is capturing-device only, never refused for eligibility, checked at printedAt", () => {
    const text = op("recordSaleReprint").description ?? "";
    expect(text).toContain("ONLY the sale's own capturing device");
    expect(text).toContain("never refused for eligibility");
    expect(text).toContain("checked against `printedAt`");
    expect(text).toContain("until the sale has a `saleRef`");
    expect(text).toContain("same `Idempotency-Key` (the local print event id)");
  });

  it("states the copy-number split and the waived cross-terminal print precondition", () => {
    const text = op("recordSaleReprint").description ?? "";
    expect(text).toContain("`localCopyNumber`");
    expect(text).toContain("the server's next");
    expect(text).toContain("waived for cross-terminal");
  });

  it("audits every call, refusals included, and changes no sale fact", () => {
    const text = op("recordSaleReprint").description ?? "";
    expect(text).toContain("including a 403 or 422 refusal");
    expect(text).toContain("`outcome` (`recorded` / `refused`)");
    expect(text).toContain("authorizes no payout");
  });

  it("maps 201/400/401/403/404/409/422/429/500; a same-key retry replays the stored 201 (RT-82 K4)", () => {
    expect(Object.keys(op("recordSaleReprint").responses ?? {}).sort()).toEqual(
      ["201", "400", "401", "403", "404", "409", "422", "429", "500"].sort(),
    );
    const created = op("recordSaleReprint").responses?.["201"] as
      | { headers?: Record<string, unknown>; description?: string }
      | undefined;
    expect(created?.headers).toHaveProperty("Idempotent-Replayed");
    expect((created?.description ?? "").replace(/\s+/g, " ")).toContain(
      "this stored `201` and `Idempotent-Replayed: true` (RT-82 K4)",
    );
    expect(responseRef("recordSaleReprint", "422")).toBe("#/components/responses/ReprintNotAllowed");
    expect(doc.components?.responses?.["ReprintNotAllowed"]?.description ?? "").toContain(
      "reprint_duplicate_unavailable",
    );
  });
});

describe("pos-sales/sale-history.yaml — object safety", () => {
  it("every object schema is strict (additionalProperties: false)", () => {
    const loose = Object.entries(doc.components?.schemas ?? {})
      .filter(([name, s]) => s.type === "object" && name !== "Error" && s.additionalProperties !== false)
      .map(([name]) => name);
    expect(loose).toEqual([]);
  });

  it("exposes no tenant, payload hash or created_by field", () => {
    const offending = Object.entries(doc.components?.schemas ?? {}).flatMap(([name, s]) =>
      Object.keys(s.properties ?? {})
        .filter((prop) => /tenant|payload_?hash|created_?by/i.test(prop))
        .map((prop) => `${name}.${prop}`),
    );
    expect(offending).toEqual([]);
  });

  it("declares no tender/payment field names outside the owner-approved detail fields (gate A.5)", () => {
    const banned = ["tender", "paymentmethod", "payment_method", "card", "cash"];
    const offending = Object.entries(doc.components?.schemas ?? {})
      .flatMap(([name, s]) =>
        Object.keys(s.properties ?? {})
          .filter((prop) => banned.some((b) => prop.toLowerCase().includes(b)))
          .map((prop) => `${name}.${prop}`),
      )
      .filter((field) => !APPROVED_TENDER_FIELDS.includes(field));
    expect(offending).toEqual([]);
  });

  it("money stays an exact-decimal string, never a number", () => {
    expect(schema("DecimalAmount")).toMatchObject({ type: "string" });
    for (const [name, s] of Object.entries(doc.components?.schemas ?? {})) {
      for (const [prop, node] of Object.entries(s.properties ?? {})) {
        if (/amount|total|price|changeGiven/i.test(prop)) {
          expect({ field: `${name}.${prop}`, type: node["type"] }).not.toEqual({
            field: `${name}.${prop}`,
            type: "number",
          });
        }
      }
    }
  });
});
