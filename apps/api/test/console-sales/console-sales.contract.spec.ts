/**
 * apps/api/test/console-sales/console-sales.contract.spec.ts
 *
 * RT-561 (RT-556 F1): the console sales read contract that Admin-Console spec
 * 012 (sales search and sale detail) consumes. `[GATED]` contract, pending
 * owner approval on RT-561; contract only. The runtime (and its HTTP
 * read-scope suite) is RT-562.
 *
 * Structural / load-only, plus AJV fixtures against the contract schemas. No
 * app boot and no HTTP. What this pins:
 *
 *   1. Two GET operations at their paths, both `contract-only` until RT-562,
 *      with their audit actions; no write, and no operationId collision.
 *   2. Read scope (contract level): `cookieAuth` only; 404 (never 403) is the
 *      role / scope refusal; no tenant id from the request; `store_id`
 *      REQUIRED on the list (OD-556-2); the detail takes the saleRef alone.
 *   3. The list filters, the 31-day range, the cursor binding and the page bounds.
 *   4. The shared vocabulary is IDENTICAL to `pos-sales/sale-history.yaml`
 *      (descriptions aside), minus the POS-only parts and plus the store.
 *   5. Projections are strict and use exact-decimal string money.
 *   6. AJV fixtures: valid payloads pass, each invalid one fails.
 *   7. The POS sale-history contract is unchanged (OD-556-1).
 */
import "reflect-metadata";

import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";

import { loadOpenApiContracts, type LoadedContract } from "../../src/openapi/loader";

const CONTRACT_ID = "console-sales.openapi";
const SALE_HISTORY_ID = "sale-history";

const LIST_PATH = "/api/v1/sales";
const DETAIL_PATH = "/api/v1/sales/{saleRef}";

const OPERATIONS = [
  { id: "consoleListSales", path: LIST_PATH, audit: "console_sales.listed" },
  { id: "consoleGetSale", path: DETAIL_PATH, audit: "console_sales.detail_read" },
] as const;

/** Nested shapes shared with the POS sale history, by name. */
const SHARED_SCHEMAS = [
  "DecimalAmount",
  "CurrencyCode",
  "ErpPostingState",
  "NameSource",
  "DeviceView",
  "OperatorView",
  "SaleHistoryLine",
  "SaleTenderView",
  "ReceiptHeader",
  "VoidSummary",
  "ReturnSummary",
  "ReturnSummaryLine",
  "ErpPostingView",
] as const;

const POS_ONLY_FIELDS = ["visibility", "receiptFacts", "reprint"] as const;

interface ParameterObject {
  $ref?: string;
  in?: string;
  name?: string;
  required?: boolean;
  description?: string;
  schema?: Record<string, unknown>;
}

interface OperationObject {
  operationId?: string;
  security?: Array<Record<string, unknown>>;
  parameters?: ParameterObject[];
  requestBody?: unknown;
  responses?: Record<string, { $ref?: string }>;
  "x-runtime-status"?: string;
  "x-runtime-note"?: string;
  "x-audit-action"?: string;
}

type SchemaObject = Record<string, unknown> & {
  required?: string[];
  properties?: Record<string, Record<string, unknown>>;
  additionalProperties?: unknown;
};

interface OpenApiDocument {
  openapi?: string;
  info?: { version?: string; description?: string };
  security?: Array<Record<string, unknown>>;
  paths?: Record<string, Record<string, OperationObject>>;
  components?: {
    schemas?: Record<string, SchemaObject>;
    parameters?: Record<string, ParameterObject>;
    securitySchemes?: Record<string, Record<string, unknown>>;
  };
}

function contractsDir(): string {
  return resolve(__dirname, "..", "..", "..", "..", "packages", "contracts", "openapi");
}

/** Every contract, top level and one folder down (the loader's scan is non-recursive). */
function allContracts(): LoadedContract[] {
  const root = contractsDir();
  const folders = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name));
  return [...loadOpenApiContracts(), ...folders.flatMap((dir) => loadOpenApiContracts({ dir }))];
}

let doc: OpenApiDocument;
let historyDoc: OpenApiDocument;
let otherOperationIds: Set<string>;
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);

beforeAll(() => {
  const contracts = allContracts();
  const found = contracts.find((c) => c.id === CONTRACT_ID);
  if (!found) throw new Error(`${CONTRACT_ID} not found in packages/contracts/openapi/`);
  doc = found.document as OpenApiDocument;
  const history = contracts.find((c) => c.id === SALE_HISTORY_ID);
  if (!history) throw new Error(`${SALE_HISTORY_ID} not found in packages/contracts/openapi/pos-sales/`);
  historyDoc = history.document as OpenApiDocument;
  otherOperationIds = new Set<string>();
  for (const c of contracts) {
    if (c.id === CONTRACT_ID) continue;
    for (const item of Object.values((c.document as OpenApiDocument).paths ?? {})) {
      for (const o of Object.values(item)) {
        if (typeof o?.operationId === "string") otherOperationIds.add(o.operationId);
      }
    }
  }
  ajv.addSchema(doc as object, CONTRACT_ID);
});

function op(path: string): OperationObject {
  const found = doc.paths?.[path]?.["get"];
  if (!found) throw new Error(`GET ${path} not declared`);
  return found;
}

function schemaOf(source: OpenApiDocument, name: string): SchemaObject {
  const s = source.components?.schemas?.[name];
  if (!s) throw new Error(`schema ${name} not declared`);
  return s;
}

function schema(name: string): SchemaObject {
  return schemaOf(doc, name);
}

function validator(name: string): ValidateFunction {
  const v = ajv.getSchema(`${CONTRACT_ID}#/components/schemas/${name}`);
  if (!v) throw new Error(`ajv cannot resolve ${name}`);
  return v;
}

/** Resolves `#/components/parameters/<Name>` references. */
function params(path: string): ParameterObject[] {
  return (op(path).parameters ?? []).map((p) =>
    p.$ref ? doc.components!.parameters![p.$ref.replace("#/components/parameters/", "")]! : p,
  );
}

function param(path: string, name: string): ParameterObject {
  const found = params(path).find((p) => p.name === name);
  if (!found) throw new Error(`parameter ${name} not declared on ${path}`);
  return found;
}

/**
 * The wire shape of a schema in `source`: every local `$ref` inlined and every
 * `description` dropped, so a named enum and an inline one compare equal and
 * only the shape is compared.
 */
function shapeOf(source: OpenApiDocument, value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => shapeOf(source, v));
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  if (typeof record["$ref"] === "string") {
    return shapeOf(source, schemaOf(source, record["$ref"].replace("#/components/schemas/", "")));
  }
  return Object.fromEntries(
    Object.entries(record)
      .filter(([key]) => key !== "description")
      .map(([key, v]) => [key, shapeOf(source, v)]),
  );
}

function without<T extends object>(value: T, key: keyof T): Omit<T, typeof key> {
  const copy = { ...value };
  delete copy[key];
  return copy;
}

const SALE_REF = "0190f5a2-3b4c-7d8e-9f01-23456789abcd";
const STORE_REF = "0190f5a2-3b4c-7d8e-9f01-000000000002";
const USER_REF = "0190f5a2-3b4c-7d8e-9f01-000000000003";
const DEVICE_REF = "0190f5a2-3b4c-7d8e-9f01-000000000004";
const LINE_REF = "0190f5a2-3b4c-7d8e-9f01-000000000005";
const RETURN_REF = "0190f5a2-3b4c-7d8e-9f01-000000000006";

const ITEM = {
  saleRef: SALE_REF,
  storeRef: STORE_REF,
  saleNumber: "S-0001-000042",
  businessDate: "2026-10-15",
  occurredAt: "2026-10-15T09:30:00.000Z",
  receivedAt: "2026-10-15T09:30:02.000Z",
  device: { deviceRef: DEVICE_REF, label: "Till 1", labelSource: "snapshot" },
  operator: { userRef: USER_REF, displayName: "Mona", nameSource: "snapshot" },
  currencyCode: "EGP",
  posTotal: "150.00",
  syncStatus: "synced",
  voided: false,
  returnState: "none",
  erpPostingState: "posted",
} as const;

const PAGE = {
  items: [ITEM],
  nextCursor: "eyJrIjoiY29uc29sZV9zYWxlcyJ9",
  asOf: "2026-10-16T08:00:00.000Z",
  storeRef: STORE_REF,
  storeTimezone: "Africa/Cairo",
  from: "2026-10-01",
  to: "2026-10-16",
} as const;

const LINE = {
  lineRef: LINE_REF,
  sequence: 1,
  lineName: "Water 1.5L",
  unitPrice: "75.00",
  currencyCode: "EGP",
  quantity: "2",
  lineAmount: "150.00",
  taxAmount: null,
  unit: "each",
  returnedQuantity: "0",
} as const;

const DETAIL = {
  summary: ITEM,
  storeTimezone: "Africa/Cairo",
  lines: [LINE],
  lineOrder: "recorded",
  tenderState: "recorded",
  tenders: [{ method: "cash", amount: "150.00", reference: null, sequence: 1 }],
  changeGiven: "0",
  settledAt: "2026-10-15T09:30:00.000Z",
  receiptNumber: "S-0001-000042",
  receiptHeader: { branchName: "Downtown", branchAddress: "1 Nile St", taxRegistrationId: "123-456-789" },
  void: null,
  returns: [],
  erpPosting: { sale: "posted", saleDocumentRef: "ACC-SINV-2026-00042", reversal: null, reversalDocumentRef: null },
} as const;

/** A voided, partially returned, tender-unknown pre-RT-77 sale with an unknown ERP state. */
const LEGACY_DETAIL = {
  ...DETAIL,
  summary: {
    ...ITEM,
    saleNumber: null,
    device: { deviceRef: null, label: null, labelSource: "unavailable" },
    operator: { userRef: USER_REF, displayName: "Mona", nameSource: "current" },
    voided: true,
    returnState: "partial",
    erpPostingState: "unknown",
  },
  lines: [{ ...LINE, sequence: null, returnedQuantity: "1" }],
  lineOrder: "not_recorded",
  tenderState: "unknown",
  tenders: [],
  changeGiven: null,
  settledAt: null,
  receiptNumber: null,
  receiptHeader: null,
  void: { voidedAt: "2026-10-15T10:00:00.000Z", voidBusinessDate: "2026-10-15", approved: true, approverRole: "store_manager" },
  returns: [
    {
      returnRef: RETURN_REF,
      recordedAt: "2026-10-15T09:45:00.000Z",
      businessDate: "2026-10-15",
      returnTotal: "75.00",
      lines: [{ lineRef: LINE_REF, quantity: "1", lineAmount: "75.00" }],
    },
  ],
  erpPosting: { sale: "unknown", saleDocumentRef: null, reversal: "pending", reversalDocumentRef: null },
} as const;

// ===========================================================================
// 1. Document + operations
// ===========================================================================
describe("console-sales — document and operations", () => {
  it("is an OpenAPI 3.1 document at version 1.0.0-draft", () => {
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info?.version).toBe("1.0.0-draft");
  });

  it("declares exactly the list and detail reads, and nothing else", () => {
    expect(Object.keys(doc.paths ?? {}).sort()).toEqual([LIST_PATH, DETAIL_PATH].sort());
    for (const { id, path } of OPERATIONS) {
      expect(Object.keys(doc.paths![path]!)).toEqual(["get"]);
      expect(op(path).operationId).toBe(id);
      expect(op(path).requestBody).toBeUndefined();
    }
  });

  it("marks both operations contract-only until the RT-562 runtime", () => {
    for (const { path } of OPERATIONS) {
      expect(op(path)["x-runtime-status"]).toBe("contract-only");
      expect(op(path)["x-runtime-note"]).toMatch(/RT-562/);
    }
  });

  it("names one audit action per operation", () => {
    for (const { path, audit } of OPERATIONS) expect(op(path)["x-audit-action"]).toBe(audit);
  });

  it("collides with no operationId in any other contract", () => {
    expect(OPERATIONS.map((o) => o.id).filter((id) => otherOperationIds.has(id))).toEqual([]);
  });
});

// ===========================================================================
// 2. Read scope (contract level; the HTTP read-scope suite is RT-562)
// ===========================================================================
describe("console-sales — auth and read scope", () => {
  it("accepts only the human cookieAuth session", () => {
    expect(doc.security).toEqual([{ cookieAuth: [] }]);
    for (const { path } of OPERATIONS) expect(op(path).security).toBeUndefined();
    expect(Object.keys(doc.components?.securitySchemes ?? {})).toEqual(["cookieAuth"]);
    expect(doc.components!.securitySchemes!["cookieAuth"]).toMatchObject({
      type: "apiKey",
      in: "cookie",
      name: "dp2_session",
    });
  });

  it("answers 200 / 400 / 401 / 404 / 500 only: the role or scope refusal is 404, never 403", () => {
    for (const { path } of OPERATIONS) {
      expect(Object.keys(op(path).responses ?? {}).sort()).toEqual(["200", "400", "401", "404", "500"]);
      expect(op(path).responses!["404"]).toEqual({ $ref: "#/components/responses/NotFound" });
    }
  });

  it("takes no tenant id and no POS selector from the request", () => {
    for (const { path } of OPERATIONS) {
      expect(params(path).filter((p) => /tenant|admission|device|operator/i.test(p.name ?? ""))).toEqual([]);
      expect(params(path).filter((p) => p.in === "header")).toEqual([]);
    }
  });

  it("requires store_id on the list (OD-556-2)", () => {
    expect(param(LIST_PATH, "store_id")).toMatchObject({
      in: "query",
      required: true,
      schema: { type: "string", format: "uuid" },
    });
  });

  it("resolves the detail by saleRef alone, anywhere in the caller's scope", () => {
    expect(params(DETAIL_PATH)).toHaveLength(1);
    expect(param(DETAIL_PATH, "saleRef")).toMatchObject({
      in: "path",
      required: true,
      schema: { type: "string", format: "uuid" },
    });
  });

  it("names every scope refusal in the one non-disclosing 404", () => {
    const description = String(
      (doc.components as Record<string, Record<string, { description?: string }>>)["responses"]!["NotFound"]!
        .description,
    );
    for (const cause of ["owner", "tenant_admin", "store_manager", "store_id", "another tenant", "absent"]) {
      expect(description).toContain(cause);
    }
  });
});

// ===========================================================================
// 3. List filters and paging
// ===========================================================================
describe("console-sales — list filters and paging", () => {
  const FILTERS = ["sale_number", "sync_status", "voided", "return_state", "erp_posting_state"];

  it("declares the v1 query keys, all query parameters", () => {
    expect(params(LIST_PATH).map((p) => p.name).sort()).toEqual(
      ["store_id", "from", "to", ...FILTERS, "cursor", "page_size"].sort(),
    );
    for (const p of params(LIST_PATH)) expect(p.in).toBe("query");
  });

  it("requires an inclusive business-date range of at most 31 days", () => {
    for (const name of ["from", "to"]) {
      expect(param(LIST_PATH, name)).toMatchObject({ required: true, schema: { type: "string", format: "date" } });
    }
    expect(param(LIST_PATH, "to").description).toMatch(/to - from <= 30/);
    expect(param(LIST_PATH, "to").description).toMatch(/Never truncated/);
  });

  it("makes every filter optional", () => {
    for (const name of [...FILTERS, "cursor", "page_size"]) expect(param(LIST_PATH, name).required).toBe(false);
  });

  it("uses the sale-history enums for the status filters and a boolean for voided", () => {
    expect(shapeOf(doc, param(LIST_PATH, "sync_status").schema)).toEqual({
      type: "string",
      enum: ["captured", "synced", "failed-retryable", "failed-needs-repair"],
    });
    expect(shapeOf(doc, param(LIST_PATH, "return_state").schema)).toEqual({
      type: "string",
      enum: ["none", "partial", "full"],
    });
    expect(shapeOf(doc, param(LIST_PATH, "erp_posting_state").schema)).toEqual({
      type: "string",
      enum: ["posted", "pending", "failed", "unknown"],
    });
    expect(param(LIST_PATH, "voided").schema).toEqual({ type: "boolean" });
  });

  it("matches the ERP filter on the projected state, not the raw posting status", () => {
    const description = param(LIST_PATH, "erp_posting_state").description ?? "";
    expect(description).toMatch(/PROJECTED/);
    expect(description).toContain("failed_transient");
    expect(description).toContain("no sale posting row");
  });

  it("bounds sale_number like the POS history filter", () => {
    expect(param(LIST_PATH, "sale_number").schema).toEqual({ type: "string", minLength: 1, maxLength: 96 });
  });

  it("keeps the cursor opaque, bounded and bound to the store and every filter", () => {
    const cursor = param(LIST_PATH, "cursor");
    expect(cursor.schema).toEqual({ type: "string", minLength: 1, maxLength: 512, pattern: "^[A-Za-z0-9_-]+$" });
    for (const name of ["tenant", "store", "from", "to", ...FILTERS]) expect(cursor.description).toContain(name);
  });

  it("bounds page_size to 1..100, default 50, and caps a page at the maximum", () => {
    expect(param(LIST_PATH, "page_size").schema).toEqual({ type: "integer", minimum: 1, maximum: 100, default: 50 });
    expect(schema("ConsoleSalePage").properties?.["items"]).toMatchObject({ maxItems: 100 });
  });
});

// ===========================================================================
// 4. Shared vocabulary with pos-sales/sale-history.yaml
// ===========================================================================
describe("console-sales — shared vocabulary with the POS sale history", () => {
  it.each(SHARED_SCHEMAS)("%s is identical to sale-history.yaml", (name) => {
    expect(shapeOf(doc, schema(name))).toEqual(shapeOf(historyDoc, schemaOf(historyDoc, name)));
  });

  it("ConsoleSaleItem is the SaleHistoryItem plus storeRef", () => {
    const item = schema("ConsoleSaleItem");
    const history = schemaOf(historyDoc, "SaleHistoryItem");
    expect(Object.keys(item.properties ?? {}).sort()).toEqual(
      [...Object.keys(history.properties ?? {}), "storeRef"].sort(),
    );
    for (const [key, value] of Object.entries(history.properties ?? {})) {
      expect({ key, shape: shapeOf(doc, item.properties![key]) }).toEqual({ key, shape: shapeOf(historyDoc, value) });
    }
    expect(item.properties!["storeRef"]).toMatchObject({ type: "string", format: "uuid" });
  });

  it("ConsoleSaleDetail is the SaleHistoryDetail minus receiptFacts / reprint, plus storeTimezone", () => {
    const detail = schema("ConsoleSaleDetail");
    const history = schemaOf(historyDoc, "SaleHistoryDetail");
    const kept = Object.keys(history.properties ?? {}).filter((k) => !POS_ONLY_FIELDS.includes(k as never));
    expect(Object.keys(detail.properties ?? {}).sort()).toEqual([...kept, "storeTimezone"].sort());
    for (const key of kept.filter((k) => k !== "summary")) {
      expect({ key, shape: shapeOf(doc, detail.properties![key]) }).toEqual({
        key,
        shape: shapeOf(historyDoc, history.properties![key]),
      });
    }
    expect(detail.properties!["summary"]).toEqual({ $ref: "#/components/schemas/ConsoleSaleItem" });
  });

  it("ConsoleSalePage is the SaleHistoryPage minus visibility, plus storeRef", () => {
    const page = schema("ConsoleSalePage");
    const history = schemaOf(historyDoc, "SaleHistoryPage");
    const kept = Object.keys(history.properties ?? {}).filter((k) => !POS_ONLY_FIELDS.includes(k as never));
    expect(Object.keys(page.properties ?? {}).sort()).toEqual([...kept, "storeRef"].sort());
  });

  it("carries no POS-only field or schema anywhere", () => {
    const names = Object.keys(doc.components?.schemas ?? {});
    expect(names.filter((n) => /reprint|receiptfacts/i.test(n))).toEqual([]);
    for (const name of names) {
      const keys = Object.keys(schema(name).properties ?? {});
      expect({ name, posOnly: keys.filter((k) => POS_ONLY_FIELDS.includes(k as never)) }).toEqual({ name, posOnly: [] });
    }
  });
});

// ===========================================================================
// 5. Projections
// ===========================================================================
describe("console-sales — projections", () => {
  it("is strict, and every key of every object is required", () => {
    const objects = Object.entries(doc.components?.schemas ?? {}).filter(([n, s]) => s.type === "object" && n !== "Error");
    // The sweep is not vacuous: the three console projections plus the nested shared shapes.
    expect(objects.length).toBeGreaterThanOrEqual(12);
    for (const [name, s] of objects) {
      expect({ name, additionalProperties: s.additionalProperties }).toEqual({ name, additionalProperties: false });
      expect({ name, required: [...(s.required ?? [])].sort() }).toEqual({
        name,
        required: Object.keys(s.properties ?? {}).sort(),
      });
    }
  });

  it("carries no tenant id, payload hash, credential or email", () => {
    const forbidden = /tenant|payload|hash|token|pin|secret|email|phone|password/i;
    for (const [name, s] of Object.entries(doc.components?.schemas ?? {})) {
      expect({ name, keys: Object.keys(s.properties ?? {}).filter((k) => forbidden.test(k)) }).toEqual({ name, keys: [] });
    }
  });

  it("returns the item total as an exact-decimal string", () => {
    expect(schema("ConsoleSaleItem").properties!["posTotal"]).toEqual({ $ref: "#/components/schemas/DecimalAmount" });
    expect(schema("DecimalAmount")).toMatchObject({ type: "string" });
  });
});

// ===========================================================================
// 6. AJV fixtures
// ===========================================================================
describe("console-sales — AJV fixtures", () => {
  it("accepts a page, an empty last page, a detail and a legacy detail", () => {
    expect(validator("ConsoleSalePage")(PAGE)).toBe(true);
    expect(validator("ConsoleSalePage")({ ...PAGE, items: [], nextCursor: null })).toBe(true);
    expect(validator("ConsoleSaleDetail")(DETAIL)).toBe(true);
    expect(validator("ConsoleSaleDetail")(LEGACY_DETAIL)).toBe(true);
  });

  it.each([
    ["a float total", { ...ITEM, posTotal: 150 }],
    ["more than 4 fractional digits", { ...ITEM, posTotal: "1.00001" }],
    ["a lower-case currency", { ...ITEM, currencyCode: "egp" }],
    ["no storeRef", without(ITEM, "storeRef")],
    ["an unknown key", { ...ITEM, tenantId: STORE_REF }],
    ["an unknown sync status", { ...ITEM, syncStatus: "posted" }],
    ["an unknown ERP state", { ...ITEM, erpPostingState: "not_posted" }],
    ["an unknown name source", { ...ITEM, operator: { ...ITEM.operator, nameSource: "email" } }],
  ])("rejects an item with %s", (_label, payload) => {
    expect(validator("ConsoleSaleItem")(payload)).toBe(false);
  });

  it.each([
    ["receipt facts", { ...DETAIL, receiptFacts: "complete" }],
    ["reprint eligibility", { ...DETAIL, reprint: { duplicate: "allowed", saleRecord: "allowed", marks: [] } }],
    ["no storeTimezone", without(DETAIL, "storeTimezone")],
    ["no erpPosting", without(DETAIL, "erpPosting")],
  ])("rejects a detail with %s", (_label, payload) => {
    expect(validator("ConsoleSaleDetail")(payload)).toBe(false);
  });

  it.each([
    ["more than 100 items", { ...PAGE, items: Array(101).fill(ITEM) }],
    ["no asOf", without(PAGE, "asOf")],
    ["no storeRef", without(PAGE, "storeRef")],
    ["a POS visibility", { ...PAGE, visibility: "store" }],
  ])("rejects a page with %s", (_label, payload) => {
    expect(validator("ConsoleSalePage")(payload)).toBe(false);
  });

  it("accepts the canonical error envelope", () => {
    expect(validator("Error")({ error: { code: "not_found", message: "Not Found", request_id: SALE_REF } })).toBe(true);
    expect(validator("Error")({ code: "not_found" })).toBe(false);
  });
});

// ===========================================================================
// 7. POS sale-history contract untouched (OD-556-1)
// ===========================================================================
describe("console-sales — POS sale-history contract unchanged", () => {
  it("adds no POS path, and the POS history keeps its paths, operations and credentials", () => {
    expect(Object.keys(doc.paths ?? {}).filter((p) => p.startsWith("/api/pos/"))).toEqual([]);
    expect(Object.keys(historyDoc.paths ?? {}).sort()).toEqual(
      [
        "/api/pos/v1/sale-history",
        "/api/pos/v1/sale-history/{saleRef}",
        "/api/pos/v1/sale-history/{saleRef}/reprints",
      ].sort(),
    );
    const ids = Object.values(historyDoc.paths ?? {}).flatMap((item) => Object.values(item).map((o) => o.operationId));
    expect(ids.sort()).toEqual(["listSaleHistory", "readSaleHistoryDetail", "recordSaleReprint"]);
    expect(Object.keys(historyDoc.components?.securitySchemes ?? {}).sort()).toEqual(["device", "operatorAuthorization"]);
  });
});
