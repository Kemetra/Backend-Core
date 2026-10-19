/**
 * apps/api/test/console-sales/console-sales-summary.contract.spec.ts
 *
 * RT-649 (BC-009-1, RT-642 D0 P3): the console sales summary contract that
 * Admin-Console spec 009 P-6 and a future Daily Briefing read. `[GATED]`
 * contract, owner-approved 2026-10-19.
 *
 * Structural / load-only, plus AJV fixtures against the contract schemas. No
 * app boot and no HTTP. What this pins:
 *
 *   1. One GET operation at `/api/v1/sales-summary` with its audit action;
 *      no write, no operationId collision, no path under `/api/v1/sales/`.
 *   2. Read scope: `cookieAuth` only; 404 (never 403); no tenant id from the
 *      request; `store_id` optional (store vs all-in-scope).
 *   3. The 31-day range, the store paging and the cursor binding.
 *   4. The vocabulary shared with `console-sales.openapi` is identical.
 *   5. Completeness, unknown and money semantics are stated and typed.
 *   6. AJV fixtures: valid payloads pass, each invalid one fails.
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

const CONTRACT_ID = "console-sales-summary.openapi";
const CONSOLE_SALES_ID = "console-sales.openapi";
const PATH = "/api/v1/sales-summary";
const OPERATION_ID = "consoleGetSalesSummary";

type SchemaName = "ConsoleSalesSummary" | "SalesKpis" | "MoneyFacts" | "Error";

let doc: OpenApiDocument;
let salesDoc: OpenApiDocument;
let api: ContractReader;
let sales: ContractReader;
let otherOperationIds: Set<string>;
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);

beforeAll(() => {
  const contracts = allContracts();
  doc = contractDocument(contracts, CONTRACT_ID);
  salesDoc = contractDocument(contracts, CONSOLE_SALES_ID);
  api = contractReader(doc);
  sales = contractReader(salesDoc);
  otherOperationIds = operationIdsExcept(contracts, CONTRACT_ID);
  ajv.addSchema(doc as object, CONTRACT_ID);
});

function validator(name: SchemaName): ValidateFunction {
  const v = ajv.getSchema(`${CONTRACT_ID}#/components/schemas/${name}`);
  if (!v) throw new Error(`ajv cannot resolve ${name}`);
  return v;
}

const STORE_REF = "0190f5a2-3b4c-7d8e-9f01-000000000002";

const ZERO_KPIS = {
  receivedSales: { count: 0, byCurrency: [] },
  voids: { count: 0, byCurrency: [] },
  returns: { count: 0, byCurrency: [] },
  legacyRefunds: { count: 0, byCurrency: [] },
  syncStatus: { captured: 0, synced: 0, failedRetryable: 0, failedNeedsRepair: 0 },
  erpPosting: { posted: 0, pending: 0, failed: 0, unknown: 0 },
  shiftCloses: { count: 0, normal: 0, forced: 0, withVariance: 0, approvalMissing: { yes: 0, no: 0, unknown: 0 } },
} as const;

const KPIS = {
  receivedSales: {
    count: 3,
    byCurrency: [
      { currencyCode: "EGP", count: 2, total: "300.0000" },
      { currencyCode: "USD", count: 1, total: "10.5000" },
    ],
  },
  voids: { count: 1, byCurrency: [{ currencyCode: "EGP", count: 1, total: "150.0000" }] },
  returns: { count: 0, byCurrency: [] },
  legacyRefunds: { count: 0, byCurrency: [] },
  syncStatus: { captured: 1, synced: 2, failedRetryable: 0, failedNeedsRepair: 0 },
  erpPosting: { posted: 1, pending: 0, failed: 0, unknown: 2 },
  shiftCloses: { count: 1, normal: 1, forced: 0, withVariance: 1, approvalMissing: { yes: 0, no: 0, unknown: 1 } },
} as const;

const SUMMARY = {
  scope: "store",
  storeRef: STORE_REF,
  from: "2026-10-18",
  to: "2026-10-19",
  asOf: "2026-10-19T08:00:00.000Z",
  completeness: "received_only",
  stores: [
    {
      storeRef: STORE_REF,
      storeTimezone: "Africa/Cairo",
      currentBusinessDate: "2026-10-19",
      days: [
        { businessDate: "2026-10-18", kpis: ZERO_KPIS },
        { businessDate: "2026-10-19", kpis: KPIS },
      ],
      rangeTotals: KPIS,
    },
  ],
  nextCursor: null,
  scopeTotals: {
    storeCount: 1,
    days: [
      { businessDate: "2026-10-18", kpis: ZERO_KPIS },
      { businessDate: "2026-10-19", kpis: KPIS },
    ],
    rangeTotals: KPIS,
  },
} as const;

// ===========================================================================
// 1. Document + operation
// ===========================================================================
describe("console-sales-summary — document and operation", () => {
  it("is an OpenAPI 3.1 document at version 1.0.0-draft", () => {
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info?.version).toBe("1.0.0-draft");
  });

  it("declares exactly one read, outside the /api/v1/sales/{saleRef} template", () => {
    expect(Object.keys(doc.paths ?? {})).toEqual([PATH]);
    expect(Object.keys(doc.paths![PATH]!)).toEqual(["get"]);
    expect(api.get(PATH).operationId).toBe(OPERATION_ID);
    expect(api.get(PATH).requestBody).toBeUndefined();
    expect(PATH.startsWith("/api/v1/sales/")).toBe(false);
  });

  it("is served: not marked contract-only (RT-649 runtime)", () => {
    expect(api.get(PATH)["x-runtime-status"]).toBeUndefined();
    expect(api.get(PATH)["x-runtime-note"]).toBeUndefined();
  });

  it("names its audit action", () => {
    expect(api.get(PATH)["x-audit-action"]).toBe("console_sales.summary_read");
  });

  it("collides with no operationId in any other contract", () => {
    expect(otherOperationIds.has(OPERATION_ID)).toBe(false);
  });

  it("returns aggregates only: no sale ref, line or name anywhere in the body", () => {
    const shape = JSON.stringify(api.shape(api.schema("ConsoleSalesSummary")));
    for (const field of ["saleRef", "lineRef", "displayName", "saleNumber", "posTotal"]) {
      expect(shape).not.toContain(`"${field}"`);
    }
  });
});

// ===========================================================================
// 2. Read scope
// ===========================================================================
describe("console-sales-summary — auth and read scope", () => {
  it("accepts only the human cookieAuth session", () => {
    expect(doc.security).toEqual([{ cookieAuth: [] }]);
    expect(api.get(PATH).security).toBeUndefined();
    expect(Object.keys(doc.components?.securitySchemes ?? {})).toEqual(["cookieAuth"]);
    expect(doc.components!.securitySchemes!["cookieAuth"]).toMatchObject({
      type: "apiKey",
      in: "cookie",
      name: "dp2_session",
    });
  });

  it("answers 200 / 400 / 401 / 404 / 429 / 500 only: the refusal is 404, never 403", () => {
    expect(Object.keys(api.get(PATH).responses ?? {}).sort()).toEqual(["200", "400", "401", "404", "429", "500"]);
    expect(api.get(PATH).responses!["404"]).toEqual({ $ref: "#/components/responses/NotFound" });
  });

  it("declares the console 429 headers: Retry-After, no-store and X-Request-Id", () => {
    const tooMany = doc.components!.responses!["TooManyRequests"]!;
    expect(api.get(PATH).responses!["429"]).toEqual({ $ref: "#/components/responses/TooManyRequests" });
    expect(tooMany.headers?.["Retry-After"]).toEqual({ $ref: "#/components/headers/ConsoleRetryAfter" });
    expect(tooMany.headers?.["Cache-Control"]).toMatchObject({ required: true, schema: { type: "string", enum: ["no-store"] } });
    expect(tooMany.headers?.["X-Request-Id"]).toMatchObject({ required: true, schema: { type: "string", format: "uuid" } });
  });

  it("names a specific grant's soft-deleted stores out of the scope, as consoleListSales does", () => {
    const description = doc.info?.description ?? "";
    expect(description).toContain("listGrantedStoreIds");
    expect(description).toMatch(/exactly the store set `consoleListSales` accepts/);
  });

  it("takes no tenant id and no POS selector from the request", () => {
    expect(api.params(PATH).filter((p) => /tenant|admission|device|operator/i.test(p.name ?? ""))).toEqual([]);
    expect(api.params(PATH).filter((p) => p.in === "header")).toEqual([]);
  });

  it("makes store_id optional: one store, or every store in the caller's scope", () => {
    expect(api.param(PATH, "store_id")).toMatchObject({
      in: "query",
      required: false,
      schema: { type: "string", format: "uuid" },
    });
    expect(api.schema("ConsoleSalesSummary").properties!["scope"]).toMatchObject({ enum: ["store", "all_in_scope"] });
  });

  it("marks the 200 Cache-Control: no-store", () => {
    expect(api.get(PATH).responses!["200"]!.headers?.["Cache-Control"]).toEqual({
      $ref: "#/components/headers/CacheControlNoStore",
    });
    expect(doc.components!.headers!["CacheControlNoStore"]!.schema).toEqual({ type: "string", const: "no-store" });
  });

  it("runs the guards before validation and applies an explicit store predicate", () => {
    const description = doc.info?.description ?? "";
    expect(description).toMatch(/guards run before request validation/i);
    expect(description).toMatch(/explicit store predicate/);
    expect(description).toContain("operator-store-scope.ts");
  });

  it("names every scope refusal in the one non-disclosing 404", () => {
    const description = api.responseDescription("NotFound");
    for (const cause of ["owner", "tenant_admin", "store_manager", "store_id", "another tenant", "absent"]) {
      expect(description).toContain(cause);
    }
  });
});

// ===========================================================================
// 3. Range and paging
// ===========================================================================
describe("console-sales-summary — range and paging", () => {
  it("declares the query keys, all query parameters", () => {
    expect(api.params(PATH).map((p) => p.name).sort()).toEqual(["cursor", "from", "page_size", "store_id", "to"]);
    for (const p of api.params(PATH)) expect(p.in).toBe("query");
  });

  it("requires an inclusive business-date range of at most 31 days, never truncated", () => {
    expect(api.param(PATH, "from")).toMatchObject({ required: true, schema: { type: "string", format: "date" } });
    expect(api.param(PATH, "to")).toMatchObject({ required: true, schema: { type: "string", format: "date" } });
    expect(api.param(PATH, "to").description).toMatch(/to - from <= 30/);
    expect(api.param(PATH, "to").description).toMatch(/Never truncated/);
  });

  it("pages stores 1..50 and bounds every day list by the range", () => {
    expect(api.param(PATH, "page_size").schema).toEqual({ type: "integer", minimum: 1, maximum: 50, default: 50 });
    expect(api.schema("ConsoleSalesSummary").properties!["stores"]).toMatchObject({ maxItems: 50 });
    expect(api.schema("StoreSalesSummary").properties!["days"]).toMatchObject({ minItems: 1, maxItems: 31 });
    expect(api.schema("ScopeSalesSummary").properties!["days"]).toMatchObject({ minItems: 1, maxItems: 31 });
  });

  it("binds the cursor to the tenant, store, range and page size, never to the scope", () => {
    const description = api.param(PATH, "cursor").description ?? "";
    for (const bound of ["tenant", "`store_id`", "`from`", "`to`", "`page_size`"]) expect(description).toContain(bound);
    expect(description).toMatch(/never carried\s+by the cursor/);
  });

  it("totals every store of the scope, whichever page is read, densely", () => {
    expect(api.schema("ScopeSalesSummary").description).toMatch(/EVERY store of the scope/);
    expect(api.schema("ScopeSalesSummary").properties!["days"]!["description"]).toMatch(/zero-filled/);
    expect(api.responseDescription("ValidationFailure")).toMatch(/operation, tenant,\s+`store_id`, range and page size/);
    expect(doc.info?.description).toMatch(/operation, tenant,\s+`store_id`, range and `page_size`/);
  });
});

// ===========================================================================
// 4. Shared vocabulary with console-sales
// ===========================================================================
describe("console-sales-summary — vocabulary shared with console-sales", () => {
  it("uses the console-sales CurrencyCode", () => {
    expect(api.schema("CurrencyCode")).toEqual(sales.schema("CurrencyCode"));
  });

  it("counts every console-sales SyncStatus and ErpPostingState value, no more", () => {
    const sync = sales.schema("SyncStatus")["enum"] as string[];
    const camel = sync.map((v) => v.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()));
    expect(Object.keys(api.schema("SyncStatusCounts").properties!).sort()).toEqual(camel.sort());
    const erp = sales.schema("ErpPostingState")["enum"] as string[];
    expect(Object.keys(api.schema("ErpPostingCounts").properties!).sort()).toEqual([...erp].sort());
  });

  it("uses the same 31-day range bound as consoleListSales", () => {
    expect(sales.param("/api/v1/sales", "to").description).toMatch(/to - from <= 30/);
  });
});

// ===========================================================================
// 5. Semantics
// ===========================================================================
describe("console-sales-summary — completeness, unknown and money", () => {
  it("always states completeness as received_only", () => {
    expect(api.schema("ConsoleSalesSummary").properties!["completeness"]).toMatchObject({ const: "received_only" });
    expect(doc.info?.description).toMatch(/still\s+queued on a\s+terminal/);
  });

  it("keeps unknown apart from zero and from 'not posted'", () => {
    expect(api.schema("ErpPostingCounts").description).toMatch(/`unknown` NEVER means "not posted"/);
    expect(api.schema("ApprovalMissingCounts").required).toEqual(["yes", "no", "unknown"]);
    expect(doc.info?.description).toMatch(/Unknown is never zero/);
  });

  it("buckets by store business date with the tz database (DST)", () => {
    const description = doc.info?.description ?? "";
    expect(description).toContain("stores.timezone");
    expect(description).toMatch(/23 or 25 hours on a DST change day/);
  });

  it("never sums the POS cash-only total as sales", () => {
    expect(doc.info?.description).toMatch(/`cashSalesTotal` is cash only and is NEVER a\s+sales total/);
    expect(JSON.stringify(api.shape(api.schema("ShiftCloseOutcomes")))).not.toContain("cashSalesTotal");
  });

  it("returns money as exact four-digit decimal strings per currency", () => {
    expect(api.schema("DecimalTotal")).toMatchObject({ type: "string", pattern: "^[0-9]{1,19}\\.[0-9]{4}$" });
    expect(api.schema("CurrencyTotal").required).toEqual(["currencyCode", "count", "total"]);
  });

  it("makes every object strict", () => {
    for (const name of [
      "ConsoleSalesSummary",
      "StoreSalesSummary",
      "ScopeSalesSummary",
      "BusinessDateKpis",
      "SalesKpis",
      "MoneyFacts",
      "CurrencyTotal",
      "SyncStatusCounts",
      "ErpPostingCounts",
      "ShiftCloseOutcomes",
      "ApprovalMissingCounts",
    ]) {
      expect(api.schema(name).additionalProperties).toBe(false);
    }
  });
});

// ===========================================================================
// 6. AJV fixtures
// ===========================================================================
describe("console-sales-summary — AJV fixtures", () => {
  it("accepts a store summary and an empty all-in-scope summary", () => {
    expect(validator("ConsoleSalesSummary")(SUMMARY)).toBe(true);
    const empty = {
      ...SUMMARY,
      scope: "all_in_scope",
      storeRef: null,
      stores: [],
      scopeTotals: { storeCount: 0, days: SUMMARY.scopeTotals.days.map((d) => ({ ...d, kpis: ZERO_KPIS })), rangeTotals: ZERO_KPIS },
    };
    expect(validator("ConsoleSalesSummary")(empty)).toBe(true);
  });

  it.each([
    ["a float total", { ...KPIS.receivedSales, byCurrency: [{ currencyCode: "EGP", count: 2, total: 300 }] }],
    ["a two-digit total", { ...KPIS.receivedSales, byCurrency: [{ currencyCode: "EGP", count: 2, total: "300.00" }] }],
    ["a negative total", { ...KPIS.receivedSales, byCurrency: [{ currencyCode: "EGP", count: 2, total: "-1.0000" }] }],
    ["a zero-count currency", { count: 0, byCurrency: [{ currencyCode: "EGP", count: 0, total: "0.0000" }] }],
    ["a lower-case currency", { count: 1, byCurrency: [{ currencyCode: "egp", count: 1, total: "1.0000" }] }],
    ["a null count", { count: null, byCurrency: [] }],
  ])("refuses %s in a money fact", (_name, value) => {
    expect(validator("MoneyFacts")(value)).toBe(false);
  });

  it.each([
    ["a missing unknown bucket", { ...KPIS, erpPosting: { posted: 1, pending: 0, failed: 0 } }],
    ["a null unknown", { ...KPIS, erpPosting: { ...KPIS.erpPosting, unknown: null } }],
    ["a negative count", { ...KPIS, syncStatus: { ...KPIS.syncStatus, captured: -1 } }],
    ["an extra figure", { ...KPIS, netSales: { count: 0, byCurrency: [] } }],
    ["a cash total on closes", { ...KPIS, shiftCloses: { ...KPIS.shiftCloses, cashSalesTotal: "1.0000" } }],
  ])("refuses %s in the KPIs", (_name, value) => {
    expect(validator("SalesKpis")(value)).toBe(false);
  });

  it.each([
    ["another completeness", { ...SUMMARY, completeness: "complete" }],
    ["no asOf", (({ asOf: _a, ...rest }) => rest)(SUMMARY)],
    ["an unknown scope", { ...SUMMARY, scope: "tenant" }],
    ["51 stores", { ...SUMMARY, stores: Array.from({ length: 51 }, () => SUMMARY.stores[0]) }],
    ["a store with no day", { ...SUMMARY, stores: [{ ...SUMMARY.stores[0], days: [] }] }],
  ])("refuses %s in the summary", (_name, value) => {
    expect(validator("ConsoleSalesSummary")(value)).toBe(false);
  });

  it("validates the error envelope", () => {
    expect(validator("Error")({ error: { code: "not_found", message: "Not Found" } })).toBe(true);
    expect(validator("Error")({ code: "not_found" })).toBe(false);
  });
});
