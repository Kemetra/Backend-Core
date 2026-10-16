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

import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";

import {
  allContracts,
  contractDocument,
  contractReader,
  operationIdsExcept,
  type ContractReader,
  type OpenApiDocument,
} from "../_helpers/openapi-contract";

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

type SchemaName = "ConsoleSalePage" | "ConsoleSaleItem" | "ConsoleSaleDetail" | "Error";

const POS_ONLY_FIELDS = ["visibility", "receiptFacts", "reprint"] as const;

let doc: OpenApiDocument;
let historyDoc: OpenApiDocument;
let api: ContractReader;
let pos: ContractReader;
let otherOperationIds: Set<string>;
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);

beforeAll(() => {
  const contracts = allContracts();
  doc = contractDocument(contracts, CONTRACT_ID);
  historyDoc = contractDocument(contracts, SALE_HISTORY_ID);
  api = contractReader(doc);
  pos = contractReader(historyDoc);
  otherOperationIds = operationIdsExcept(contracts, CONTRACT_ID);
  ajv.addSchema(doc as object, CONTRACT_ID);
});

function validator(name: SchemaName): ValidateFunction {
  const v = ajv.getSchema(`${CONTRACT_ID}#/components/schemas/${name}`);
  if (!v) throw new Error(`ajv cannot resolve ${name}`);
  return v;
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
  nextCursor: "bmV4dC1wYWdl",
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
      expect(api.get(path).operationId).toBe(id);
      expect(api.get(path).requestBody).toBeUndefined();
    }
  });

  it("marks both operations contract-only until the RT-562 runtime", () => {
    for (const { path } of OPERATIONS) {
      expect(api.get(path)["x-runtime-status"]).toBe("contract-only");
      expect(api.get(path)["x-runtime-note"]).toMatch(/RT-562/);
    }
  });

  it("names one audit action per operation", () => {
    for (const { path, audit } of OPERATIONS) expect(api.get(path)["x-audit-action"]).toBe(audit);
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
    for (const { path } of OPERATIONS) expect(api.get(path).security).toBeUndefined();
    expect(Object.keys(doc.components?.securitySchemes ?? {})).toEqual(["cookieAuth"]);
    expect(doc.components!.securitySchemes!["cookieAuth"]).toMatchObject({
      type: "apiKey",
      in: "cookie",
      name: "dp2_session",
    });
  });

  it("answers 200 / 400 / 401 / 404 / 500 only: the role or scope refusal is 404, never 403", () => {
    for (const { path } of OPERATIONS) {
      expect(Object.keys(api.get(path).responses ?? {}).sort()).toEqual(["200", "400", "401", "404", "500"]);
      expect(api.get(path).responses!["404"]).toEqual({ $ref: "#/components/responses/NotFound" });
    }
  });

  it("takes no tenant id and no POS selector from the request", () => {
    for (const { path } of OPERATIONS) {
      expect(api.params(path).filter((p) => /tenant|admission|device|operator/i.test(p.name ?? ""))).toEqual([]);
      expect(api.params(path).filter((p) => p.in === "header")).toEqual([]);
    }
  });

  it("requires store_id on the list (OD-556-2)", () => {
    expect(api.param(LIST_PATH, "store_id")).toMatchObject({
      in: "query",
      required: true,
      schema: { type: "string", format: "uuid" },
    });
  });

  it("resolves the detail by saleRef alone, anywhere in the caller's scope", () => {
    expect(api.params(DETAIL_PATH)).toHaveLength(1);
    expect(api.param(DETAIL_PATH, "saleRef")).toMatchObject({
      in: "path",
      required: true,
      schema: { type: "string", format: "uuid" },
    });
  });

  it("marks both 200 responses Cache-Control: no-store (staff names, tax id)", () => {
    for (const { path } of OPERATIONS) {
      const ok = api.get(path).responses!["200"]!;
      expect(ok.headers?.["Cache-Control"]).toEqual({ $ref: "#/components/headers/CacheControlNoStore" });
    }
    const header = doc.components!.headers!["CacheControlNoStore"]!;
    expect(header.schema).toEqual({ type: "string", const: "no-store" });
  });

  it("runs the guards before validation, so a refused role gets 404 for any input", () => {
    expect(doc.info?.description).toMatch(/guards run before request validation/i);
  });

  it("states how a platform-admin session is handled (the RolesGuard bypass)", () => {
    expect(doc.info?.description).toMatch(/platform admin/i);
    expect(doc.info?.description).toContain("RT-132 D6");
  });

  it("records the audit ids in the event metadata, never as the interceptor's target", () => {
    const description = doc.info?.description ?? "";
    expect(description).toContain("annotateAudit");
    expect(description).toContain("`sale_ref`");
    expect(description).not.toMatch(/as its target/);
  });

  it("guarantees every non-null cursor moves the walk forward", () => {
    expect(api.get(LIST_PATH).description).toMatch(/every non-null cursor moves the position forward/);
  });

  it("resolves the detail in one scoped query, never fetch-then-check", () => {
    expect(api.get(DETAIL_PATH).description).toMatch(/never fetched first and checked after/);
  });

  it("names every scope refusal in the one non-disclosing 404", () => {
    const description = api.responseDescription("NotFound");
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
    expect(api.params(LIST_PATH).map((p) => p.name).sort()).toEqual(
      ["store_id", "from", "to", ...FILTERS, "cursor", "page_size"].sort(),
    );
    for (const p of api.params(LIST_PATH)) expect(p.in).toBe("query");
  });

  it("requires an inclusive business-date range of at most 31 days", () => {
    for (const name of ["from", "to"]) {
      expect(api.param(LIST_PATH, name)).toMatchObject({ required: true, schema: { type: "string", format: "date" } });
    }
    expect(api.param(LIST_PATH, "to").description).toMatch(/to - from <= 30/);
    expect(api.param(LIST_PATH, "to").description).toMatch(/Never truncated/);
  });

  it("makes every filter optional", () => {
    for (const name of [...FILTERS, "cursor", "page_size"]) expect(api.param(LIST_PATH, name).required).toBe(false);
  });

  it("uses the sale-history enums for the status filters and a boolean for voided", () => {
    expect(api.shape(api.param(LIST_PATH, "sync_status").schema)).toEqual({
      type: "string",
      enum: ["captured", "synced", "failed-retryable", "failed-needs-repair"],
    });
    expect(api.shape(api.param(LIST_PATH, "return_state").schema)).toEqual({
      type: "string",
      enum: ["none", "partial", "full"],
    });
    expect(api.shape(api.param(LIST_PATH, "erp_posting_state").schema)).toEqual({
      type: "string",
      enum: ["posted", "pending", "failed", "unknown"],
    });
    expect(api.param(LIST_PATH, "voided").schema).toEqual({ type: "boolean" });
  });

  it("matches the ERP filter on the projected state, not the raw posting status", () => {
    const description = api.param(LIST_PATH, "erp_posting_state").description ?? "";
    expect(description).toMatch(/PROJECTED/);
    expect(description).toContain("failed_transient");
    expect(description).toContain("no sale posting row");
  });

  it("bounds sale_number like the POS history filter", () => {
    expect(api.param(LIST_PATH, "sale_number").schema).toEqual({ type: "string", minLength: 1, maxLength: 96 });
  });

  it("keeps the cursor opaque, bounded and bound to the store and every filter", () => {
    const cursor = api.param(LIST_PATH, "cursor");
    expect(cursor.schema).toEqual({ type: "string", minLength: 1, maxLength: 512, pattern: "^[A-Za-z0-9_-]+$" });
    for (const name of ["tenant", "store", "from", "to", ...FILTERS]) expect(cursor.description).toContain(name);
  });

  it("refuses a repeated query key and a non-calendar date as 400", () => {
    const description = api.responseDescription("ValidationFailure");
    expect(description).toContain("a query key given more than once");
    expect(description).toContain("2026-02-30");
  });

  it("ANDs the cursor position with the scope and range, never replacing them", () => {
    expect(api.param(LIST_PATH, "cursor").description).toMatch(/never replaces them/);
  });

  it("lets a bounded page be short or empty while nextCursor is non-null", () => {
    expect(validator("ConsoleSalePage")({ ...PAGE, items: [], nextCursor: "cGFnZS0y" })).toBe(true);
    expect(String(api.schema("ConsoleSalePage").properties!["nextCursor"]!["description"])).toMatch(
      /only `null` ends the walk/,
    );
  });

  it("bounds page_size to 1..100, default 50, and caps a page at the maximum", () => {
    expect(api.param(LIST_PATH, "page_size").schema).toEqual({ type: "integer", minimum: 1, maximum: 100, default: 50 });
    expect(api.schema("ConsoleSalePage").properties?.["items"]).toMatchObject({ maxItems: 100 });
  });
});

// ===========================================================================
// 4. Shared vocabulary with pos-sales/sale-history.yaml
// ===========================================================================
describe("console-sales — shared vocabulary with the POS sale history", () => {
  it.each(SHARED_SCHEMAS)("%s is identical to sale-history.yaml", (name) => {
    expect(api.shape(api.schema(name))).toEqual(pos.shape(pos.schema(name)));
  });

  it("ConsoleSaleItem is the SaleHistoryItem plus storeRef", () => {
    const item = api.schema("ConsoleSaleItem");
    const history = pos.schema("SaleHistoryItem");
    expect(Object.keys(item.properties ?? {}).sort()).toEqual(
      [...Object.keys(history.properties ?? {}), "storeRef"].sort(),
    );
    for (const [key, value] of Object.entries(history.properties ?? {})) {
      expect({ key, shape: api.shape(item.properties![key]) }).toEqual({ key, shape: pos.shape(value) });
    }
    expect(item.properties!["storeRef"]).toMatchObject({ type: "string", format: "uuid" });
  });

  it("ConsoleSaleDetail is the SaleHistoryDetail minus receiptFacts / reprint, plus storeTimezone", () => {
    const detail = api.schema("ConsoleSaleDetail");
    const history = pos.schema("SaleHistoryDetail");
    const kept = Object.keys(history.properties ?? {}).filter((k) => !POS_ONLY_FIELDS.includes(k as never));
    expect(Object.keys(detail.properties ?? {}).sort()).toEqual([...kept, "storeTimezone"].sort());
    for (const key of kept.filter((k) => k !== "summary")) {
      expect({ key, shape: api.shape(detail.properties![key]) }).toEqual({
        key,
        shape: pos.shape(history.properties![key]),
      });
    }
    expect(detail.properties!["summary"]).toEqual({ $ref: "#/components/schemas/ConsoleSaleItem" });
  });

  it("ConsoleSalePage is the SaleHistoryPage minus visibility, plus storeRef", () => {
    const page = api.schema("ConsoleSalePage");
    const history = pos.schema("SaleHistoryPage");
    const kept = Object.keys(history.properties ?? {}).filter((k) => !POS_ONLY_FIELDS.includes(k as never));
    expect(Object.keys(page.properties ?? {}).sort()).toEqual([...kept, "storeRef"].sort());
    for (const key of kept.filter((k) => k !== "items")) {
      expect({ key, shape: api.shape(page.properties![key]) }).toEqual({
        key,
        shape: pos.shape(history.properties![key]),
      });
    }
    expect(page.properties!["items"]).toMatchObject({
      type: "array",
      maxItems: history.properties!["items"]!["maxItems"],
      items: { $ref: "#/components/schemas/ConsoleSaleItem" },
    });
    expect(page.properties!["storeRef"]).toMatchObject({ type: "string", format: "uuid" });
  });

  it("carries no POS-only field or schema anywhere", () => {
    const names = Object.keys(doc.components?.schemas ?? {});
    expect(names.filter((n) => /reprint|receiptfacts/i.test(n))).toEqual([]);
    for (const name of names) {
      const keys = Object.keys(api.schema(name).properties ?? {});
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
    expect(api.schema("ConsoleSaleItem").properties!["posTotal"]).toEqual({ $ref: "#/components/schemas/DecimalAmount" });
    expect(api.schema("DecimalAmount")).toMatchObject({ type: "string" });
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
    { label: "a float total", payload: { ...ITEM, posTotal: 150 } },
    { label: "more than 4 fractional digits", payload: { ...ITEM, posTotal: "1.00001" } },
    { label: "a lower-case currency", payload: { ...ITEM, currencyCode: "egp" } },
    { label: "no storeRef", payload: without(ITEM, "storeRef") },
    { label: "an unknown key", payload: { ...ITEM, tenantId: STORE_REF } },
    { label: "an unknown sync status", payload: { ...ITEM, syncStatus: "posted" } },
    { label: "an unknown ERP state", payload: { ...ITEM, erpPostingState: "not_posted" } },
    { label: "an unknown name source", payload: { ...ITEM, operator: { ...ITEM.operator, nameSource: "email" } } },
  ])("rejects an item with $label", ({ payload }) => {
    expect(validator("ConsoleSaleItem")(payload)).toBe(false);
  });

  it.each([
    { label: "receipt facts", payload: { ...DETAIL, receiptFacts: "complete" } },
    { label: "reprint eligibility", payload: { ...DETAIL, reprint: { duplicate: "allowed", saleRecord: "allowed", marks: [] } } },
    { label: "no storeTimezone", payload: without(DETAIL, "storeTimezone") },
    { label: "no erpPosting", payload: without(DETAIL, "erpPosting") },
  ])("rejects a detail with $label", ({ payload }) => {
    expect(validator("ConsoleSaleDetail")(payload)).toBe(false);
  });

  it.each([
    { label: "more than 100 items", payload: { ...PAGE, items: Array(101).fill(ITEM) } },
    { label: "no asOf", payload: without(PAGE, "asOf") },
    { label: "no storeRef", payload: without(PAGE, "storeRef") },
    { label: "a POS visibility", payload: { ...PAGE, visibility: "store" } },
  ])("rejects a page with $label", ({ payload }) => {
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
