/**
 * apps/api/test/catalog/erpnext-reconciliation/contract/reconciliation.contract.spec.ts
 *
 * Slice 017-CONTRACT (T010) — OpenAPI conformance test for
 * `packages/contracts/openapi/erpnext-reconciliation/reconciliation.yaml`.
 *
 * Mirrors `apps/api/test/catalog/erpnext-warehouse-map/contract/erpnext-warehouse-map.contract.spec.ts`:
 *   - loads the new contract via the production `loadOpenApiContracts` helper with
 *     an explicit `dir` (the helper's scan is non-recursive — the new top-level
 *     `erpnext-reconciliation/` directory is loaded explicitly);
 *   - asserts the SIX 017 operationIds are present + UNIQUE against every shipped
 *     operationId (top-level + catalog/ + pos-sales/ + erpnext-connector/);
 *   - pins the slice's load-bearing conventions:
 *       · the HUMAN dashboard `cookieAuth` scheme — NOT `connectorBearer` (012
 *         machine) and NOT `clerkJwt` (POS device) (FR-018, the slice stop);
 *       · strict request DTOs (§XII) — no body-supplied tenant/actor/server fields;
 *       · `Idempotency-Key` required on the three mutating ops (O-3, no new primitive);
 *       · the closed Error set incl. `idempotency_key_conflict` (409) + non-disclosing 404;
 *       · the toBody projections — `ReconciliationResult.mismatchClass` is 014's
 *         vocabulary ONLY (no 015 posting categories — READ-NOT-MIRROR); `kind` is
 *         stock-only; NO money/valuation field anywhere.
 *
 * RT-177 adds the two read-only ERPNext negative on-hand operations
 * (`listErpnextNegativeOnHandStores`, `listErpnextNegativeOnHand`): operation
 * shape, strict schemas, the D4 freshness block, the signed strictly-negative
 * quantity pattern, instance validation of fixture pages (Ajv 2020), and the D3
 * description-only edits.
 *
 * Structural / load-only (no app boot, no HTTP).
 */
import "reflect-metadata";

import { resolve } from "node:path";

import Ajv2020, { type ValidateFunction } from "ajv/dist/2020";
import addFormats from "ajv-formats";

import { loadOpenApiContracts } from "../../../../src/openapi/loader";

const NEW_CONTRACT_ID = "reconciliation";
const NEW_SUBDIR = "erpnext-reconciliation";

const OPERATION_IDS = [
  "listPostingBacklog",
  "repairPosting",
  "triggerReconciliationRun",
  "getReconciliationRun",
  "listReconciliationResults",
  "repairStockMismatch",
  "reResolvePosting",
] as const;

const MUTATING_IDEMPOTENT_OPS = [
  "repairPosting",
  "triggerReconciliationRun",
  "repairStockMismatch",
  "reResolvePosting",
] as const;

function openapiSubDir(sub: string): string {
  return resolve(
    __dirname, "..", "..", "..", "..", "..", "..",
    "packages", "contracts", "openapi", sub,
  );
}

interface OperationObject {
  operationId?: string;
  parameters?: Array<{ $ref?: string; name?: string; in?: string; required?: boolean }>;
  requestBody?: { content?: Record<string, { schema?: { $ref?: string } }> };
  responses?: Record<string, unknown>;
}
type PathItem = Record<string, OperationObject>;
interface SchemaObject {
  type?: string | string[];
  additionalProperties?: boolean | Record<string, unknown>;
  required?: string[];
  properties?: Record<string, { enum?: string[] }>;
}
interface OpenApiDocument {
  openapi?: string;
  info?: { title?: string; version?: string };
  paths?: Record<string, PathItem>;
  components?: {
    schemas?: Record<string, SchemaObject>;
    securitySchemes?: Record<string, Record<string, unknown>>;
    parameters?: Record<string, { name?: string; in?: string; required?: boolean }>;
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
  const contracts = loadOpenApiContracts({ dir: openapiSubDir(NEW_SUBDIR) });
  const newContract = contracts.find((c) => c.id === NEW_CONTRACT_ID);
  if (!newContract) {
    const ids = contracts.map((c) => c.id).join(", ");
    throw new Error(
      `${NEW_CONTRACT_ID} contract not found under ${openapiSubDir(NEW_SUBDIR)}; loaded ids: [${ids}]`,
    );
  }
  doc = newContract.document as OpenApiDocument;

  shippedOperationIds = new Set<string>();
  collectOperationIds(
    loadOpenApiContracts().map((c) => c.document as OpenApiDocument),
    shippedOperationIds,
  );
  for (const sub of ["catalog", "pos-sales", "erpnext-connector"]) {
    collectOperationIds(
      loadOpenApiContracts({ dir: openapiSubDir(sub) }).map((c) => c.document as OpenApiDocument),
      shippedOperationIds,
    );
  }
});

function operations(): Array<{ path: string; method: string; op: OperationObject }> {
  const out: Array<{ path: string; method: string; op: OperationObject }> = [];
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    for (const [method, op] of Object.entries(item)) out.push({ path, method, op });
  }
  return out;
}
function findOp(operationId: string): OperationObject | undefined {
  return operations().find((o) => o.op.operationId === operationId)?.op;
}
function schema(name: string): SchemaObject | undefined {
  return doc.components?.schemas?.[name];
}

describe("erpnext-reconciliation/reconciliation.yaml — loadability", () => {
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

describe("erpnext-reconciliation/reconciliation.yaml — operations", () => {
  it("declares the 017 operationIds (+ RT-333 reResolvePosting)", () => {
    for (const id of OPERATION_IDS) expect(findOp(id)).toBeDefined();
  });
  it("does NOT collide with or rename any shipped operationId", () => {
    for (const id of OPERATION_IDS) expect(shippedOperationIds.has(id)).toBe(false);
  });
  it("routes all ops under /api/v1/catalog/erpnext-reconciliation (not /api/admin, not /api/connector)", () => {
    for (const { path } of operations()) {
      expect(path.startsWith("/api/v1/catalog/erpnext-reconciliation")).toBe(true);
    }
  });
});

describe("erpnext-reconciliation/reconciliation.yaml — auth boundary (FR-018)", () => {
  it("defines the cookieAuth (httpOnly dp2_session) scheme", () => {
    const cookie = doc.components?.securitySchemes?.["cookieAuth"];
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

describe("erpnext-reconciliation/reconciliation.yaml — idempotency (O-3, no new primitive)", () => {
  it("the three mutating ops require an Idempotency-Key header", () => {
    for (const id of MUTATING_IDEMPOTENT_OPS) {
      const op = findOp(id);
      // The IdempotencyKey param is a $ref; resolve by checking the referenced name.
      const hasKeyRef = (op?.parameters ?? []).some(
        (p) => p.$ref?.endsWith("/IdempotencyKey") || p.name === "Idempotency-Key",
      );
      expect(hasKeyRef).toBe(true);
    }
  });
});

describe("erpnext-reconciliation/reconciliation.yaml — request DTOs (§XII)", () => {
  it("trigger-run request is strict and carries ONLY storeId (no tenant/kind/trigger/actor)", () => {
    const s = schema("TriggerRunRequest");
    expect(s?.additionalProperties).toBe(false);
    expect(s?.required).toEqual(["storeId"]);
    for (const forbidden of ["tenant_id", "tenantId", "kind", "trigger", "actor_user_id"]) {
      expect(s?.properties?.[forbidden]).toBeUndefined();
    }
  });
  it("stock-repair request is strict (repairKind + optional note only)", () => {
    const s = schema("RepairStockRequest");
    expect(s?.additionalProperties).toBe(false);
    expect(s?.required).toEqual(["repairKind"]);
    for (const forbidden of ["tenant_id", "result_state", "actor_user_id"]) {
      expect(s?.properties?.[forbidden]).toBeUndefined();
    }
  });
  it("posting-repair request is strict (no body-supplied identity/actor)", () => {
    const s = schema("RepairPostingRequest");
    expect(s?.additionalProperties).toBe(false);
    for (const forbidden of ["tenant_id", "workItemRef", "status", "actor_user_id"]) {
      expect(s?.properties?.[forbidden]).toBeUndefined();
    }
  });
});

describe("erpnext-reconciliation/reconciliation.yaml — error envelope", () => {
  it("the mutating ops declare 409 (idempotency_key_conflict) + non-disclosing 404", () => {
    for (const id of MUTATING_IDEMPOTENT_OPS) {
      const responses = findOp(id)?.responses ?? {};
      expect(responses["404"]).toBeDefined();
      expect(responses["409"]).toBeDefined();
    }
  });
  it("Error is the strict canonical envelope { error: { code, message, request_id? } }", () => {
    const err = schema("Error");
    expect(err?.additionalProperties).toBe(false);
    expect(err?.required).toEqual(["error"]);
  });
});

describe("erpnext-reconciliation/reconciliation.yaml — projections (READ-NOT-MIRROR, no money)", () => {
  it("ReconciliationResult.mismatchClass is 014's vocabulary ONLY (no 015 posting categories)", () => {
    const cls = schema("ReconciliationResult")?.properties?.["mismatchClass"]?.enum ?? [];
    expect(cls.sort()).toEqual([
      "dp2_only", "erpnext_only", "match", "negative_balance_flagged",
      "quantity_divergence", "unmapped_item", "unmapped_store",
    ]);
    // The 015 posting categories must NOT leak into the 017 result class.
    for (const posting of ["validation", "closed_period", "unmapped_account", "retry_budget_exhausted"]) {
      expect(cls).not.toContain(posting);
    }
  });
  it("ReconciliationRun.kind is stock-only (the backlog is a read-projection, not a run)", () => {
    const kind = schema("ReconciliationRun")?.properties?.["kind"]?.enum ?? [];
    expect(kind).toEqual(["stock"]);
  });
  it("no projection carries a money / valuation / on-hand field", () => {
    for (const name of ["PostingBacklogItem", "ReconciliationRun", "ReconciliationResult", "RecordedRepair"]) {
      const props = schema(name)?.properties ?? {};
      for (const forbidden of ["amount", "pos_total", "valuation", "cost", "price", "on_hand", "stock_value"]) {
        expect(props[forbidden]).toBeUndefined();
      }
    }
  });
  it("all projections are strict (no raw DB entity, §IV)", () => {
    for (const name of ["PostingBacklogItem", "ReconciliationRun", "ReconciliationResult", "RecordedRepair", "PostingBacklogPage", "ReconciliationResultPage"]) {
      expect(schema(name)?.additionalProperties).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// RT-177 — ERPNext negative on-hand read contract (RT-51 §C, D3)
// ---------------------------------------------------------------------------

const NEGATIVE_ON_HAND_OPS = {
  listErpnextNegativeOnHandStores: {
    path: "/api/v1/catalog/erpnext-reconciliation/negative-on-hand/stores",
    page: "StoreNegativeOnHandSummaryPage",
  },
  listErpnextNegativeOnHand: {
    path: "/api/v1/catalog/erpnext-reconciliation/stores/{storeId}/negative-on-hand",
    page: "StoreNegativeOnHandPage",
  },
} as const;

const NEGATIVE_ON_HAND_SCHEMAS = [
  "StockSnapshotStatus",
  "PendingSnapshotRequest",
  "ErpnextItemRef",
  "NegativeOnHandItem",
  "NegativeOnHandTenantProduct",
  "StoreNegativeOnHandSummary",
  "StoreNegativeOnHandSummaryPage",
  "StoreNegativeOnHandPage",
] as const;

type LooseSchema = Record<string, unknown> & {
  properties?: Record<string, Record<string, unknown>>;
  required?: string[];
};
function looseSchema(name: string): LooseSchema {
  const s = doc.components?.schemas?.[name] as LooseSchema | undefined;
  if (!s) throw new Error(`schema ${name} missing`);
  return s;
}

function validatorFor(name: string): ValidateFunction {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  ajv.addSchema({ ...(doc as object), $id: "reconciliation" });
  return ajv.compile({ $ref: `reconciliation#/components/schemas/${name}` });
}

const STORE_ID = "0a000000-0000-7000-8000-000001770001";
const RUN_ID = "0a000000-0000-7000-8000-000001770002";
const PRODUCT_ID = "0a000000-0000-7000-8000-000001770003";

function freshSnapshot(): Record<string, unknown> {
  return {
    status: "fresh",
    erpnextWarehouseRef: "Stores - RT",
    runId: RUN_ID,
    readAt: "2026-10-04T10:00:00.123456+02:00",
    recordedAt: "2026-10-04T08:00:01.000Z",
    staleAfterSeconds: 86400,
    reportedEntryCount: 3,
    pendingRequest: null,
  };
}

function itemA(): Record<string, unknown> {
  return {
    discrepancyKind: "erpnext_negative_on_hand",
    erpnextItemRef: { doctype: "Item", name: "ITEM-A" },
    mappingStatus: "mapped",
    tenantProduct: { id: PRODUCT_ID, name: "Apples" },
    erpnextWarehouseRef: "Stores - RT",
    quantity: "-3.000000",
    stockUom: "Nos",
  };
}

describe("reconciliation.yaml — RT-177 negative on-hand operations", () => {
  it("declares both operations at the approved paths, GET only", () => {
    for (const [id, spec] of Object.entries(NEGATIVE_ON_HAND_OPS)) {
      const item = doc.paths?.[spec.path];
      expect(Object.keys(item ?? {})).toEqual(["get"]);
      expect(item?.["get"]?.operationId).toBe(id);
    }
  });

  it("does NOT collide with any shipped operationId", () => {
    for (const id of Object.keys(NEGATIVE_ON_HAND_OPS)) {
      expect(shippedOperationIds.has(id)).toBe(false);
    }
  });

  it("is read-only: no request body, no Idempotency-Key, no 409", () => {
    for (const id of Object.keys(NEGATIVE_ON_HAND_OPS)) {
      const op = findOp(id);
      expect(op?.requestBody).toBeUndefined();
      expect(
        (op?.parameters ?? []).some((p) => p.$ref?.endsWith("/IdempotencyKey")),
      ).toBe(false);
      expect(op?.responses?.["409"]).toBeUndefined();
    }
  });

  it("declares 200 + 400 + 401 + non-disclosing 404", () => {
    for (const [id, spec] of Object.entries(NEGATIVE_ON_HAND_OPS)) {
      const responses = findOp(id)?.responses ?? {};
      expect(Object.keys(responses).sort()).toEqual(["200", "400", "401", "404"]);
      expect(responses["404"]).toEqual({ $ref: "#/components/responses/NotFound" });
      expect(JSON.stringify(responses["200"])).toContain(`#/components/schemas/${spec.page}`);
    }
  });

  it("takes an opaque cursor + limit 1..500 (default 100); the item list adds a uuid storeId path param", () => {
    const params = doc.components?.parameters as Record<string, Record<string, unknown>>;
    const cursor = params["NegativeOnHandCursor"]!;
    expect(cursor["in"]).toBe("query");
    expect(cursor["required"]).toBe(false);
    const limit = params["Limit"]!["schema"] as Record<string, unknown>;
    expect(limit).toMatchObject({ type: "integer", minimum: 1, maximum: 500, default: 100 });
    const storeId = params["StoreId"]!;
    expect(storeId).toMatchObject({ name: "storeId", in: "path", required: true });
    expect(storeId["schema"]).toEqual({ type: "string", format: "uuid" });

    const refs = (id: string) => (findOp(id)?.parameters ?? []).map((p) => p.$ref);
    expect(refs("listErpnextNegativeOnHandStores")).toEqual([
      "#/components/parameters/NegativeOnHandCursor",
      "#/components/parameters/Limit",
    ]);
    expect(refs("listErpnextNegativeOnHand")).toEqual([
      "#/components/parameters/StoreId",
      "#/components/parameters/NegativeOnHandCursor",
      "#/components/parameters/Limit",
    ]);
  });

  it("every RT-177 schema is strict (additionalProperties: false)", () => {
    for (const name of NEGATIVE_ON_HAND_SCHEMAS) {
      expect(looseSchema(name)["additionalProperties"]).toBe(false);
    }
  });

  it("StockSnapshotStatus carries the D4 freshness block", () => {
    const s = looseSchema("StockSnapshotStatus");
    expect(s.required?.slice().sort()).toEqual([
      "erpnextWarehouseRef", "pendingRequest", "readAt", "recordedAt",
      "reportedEntryCount", "runId", "staleAfterSeconds", "status",
    ]);
    expect(s.properties?.["status"]?.["enum"]).toEqual([
      "no_warehouse_mapping", "no_snapshot", "fresh", "stale",
    ]);
  });

  it("NegativeOnHandItem: const kind, Item ref, mapped|unmapped, signed strictly-negative pattern", () => {
    const s = looseSchema("NegativeOnHandItem");
    expect(s.properties?.["discrepancyKind"]?.["const"]).toBe("erpnext_negative_on_hand");
    expect(s.properties?.["mappingStatus"]?.["enum"]).toEqual(["mapped", "unmapped"]);
    const pattern = new RegExp(String(s.properties?.["quantity"]?.["pattern"]));
    for (const ok of ["-3.000000", "-1.5", "-1", "-999999999999999.999999"]) {
      expect(pattern.test(ok)).toBe(true);
    }
    for (const bad of ["5.000000", "0", "3", "-1e3", "-1.0000001", "--1"]) {
      expect(pattern.test(bad)).toBe(false);
    }
    const ref = looseSchema("ErpnextItemRef");
    expect(ref.properties?.["doctype"]?.["const"]).toBe("Item");
    expect(ref.properties?.["name"]).toMatchObject({ minLength: 1, maxLength: 140 });
  });

  it("no RT-177 schema carries a money / valuation / 009-ledger / acknowledge field", () => {
    for (const name of NEGATIVE_ON_HAND_SCHEMAS) {
      const props = Object.keys(looseSchema(name).properties ?? {});
      for (const forbidden of [
        "amount", "valuation", "valuationRate", "cost", "price", "stockValue",
        "movementId", "ledgerBalance", "acknowledged", "acknowledgedAt", "resultState",
      ]) {
        expect(props).not.toContain(forbidden);
      }
    }
  });

  it("validates a store page fixture (A mapped, C unmapped) and rejects contract violations", () => {
    const page = validatorFor("StoreNegativeOnHandPage");
    const itemC = {
      ...itemA(),
      erpnextItemRef: { doctype: "Item", name: "ITEM-C" },
      mappingStatus: "unmapped",
      tenantProduct: null,
      quantity: "-1.500000",
    };
    const body = { storeId: STORE_ID, snapshot: freshSnapshot(), items: [itemA(), itemC], nextCursor: null };
    expect(page(body)).toBe(true);

    expect(page({ ...body, items: [{ ...itemA(), quantity: "5.000000" }] })).toBe(false);
    expect(page({ ...body, items: [{ ...itemA(), extra: 1 }] })).toBe(false);
    expect(page({ ...body, items: [{ ...itemA(), erpnextItemRef: { doctype: "Bin", name: "X" } }] })).toBe(false);
    expect(page({ ...body, snapshot: { ...freshSnapshot(), status: "live" } })).toBe(false);
  });

  it("validates every snapshot state, incl. pendingRequest, in a summary page", () => {
    const summaries = validatorFor("StoreNegativeOnHandSummaryPage");
    const unmappedState = {
      status: "no_warehouse_mapping", erpnextWarehouseRef: null, runId: null, readAt: null,
      recordedAt: null, staleAfterSeconds: 86400, reportedEntryCount: null, pendingRequest: null,
    };
    const pendingState = {
      ...unmappedState, status: "no_snapshot", erpnextWarehouseRef: "Stores - RT",
      pendingRequest: { runId: RUN_ID, requestedAt: "2026-10-04T08:00:00.000Z" },
    };
    const staleRow = {
      storeId: STORE_ID, storeName: "S1",
      snapshot: { ...freshSnapshot(), status: "stale" }, negativeItemCount: 2,
    };
    const body = {
      items: [
        { storeId: STORE_ID, storeName: "S1", snapshot: unmappedState, negativeItemCount: 0 },
        { storeId: STORE_ID, storeName: "S1", snapshot: pendingState, negativeItemCount: 0 },
        staleRow,
      ],
      nextCursor: "eyJrIjoicyJ9",
    };
    expect(summaries(body)).toBe(true);
    expect(summaries({ ...body, items: [{ ...staleRow, negativeItemCount: -1 }] })).toBe(false);
    expect(
      summaries({
        ...body,
        items: [{ ...staleRow, snapshot: { ...pendingState, pendingRequest: { runId: RUN_ID } } }],
      }),
    ).toBe(false);
  });
});

describe("reconciliation.yaml — RT-177 description-only edits (D3)", () => {
  it("negative_balance_flagged is described as 009-ledger-derived, not an ERPNext Bin signal (value kept)", () => {
    const cls = looseSchema("ReconciliationResult").properties?.["mismatchClass"] ?? {};
    expect(cls["enum"]).toContain("negative_balance_flagged");
    const description = String(cls["description"]);
    expect(description).toContain("negative_balance_flagged");
    expect(description).toContain("009");
    expect(description).toMatch(/NOT an ERPNext Bin signal/);
  });

  it("the run summary is no longer described as counts only", () => {
    const summary = looseSchema("ReconciliationRun").properties?.["summary"] ?? {};
    expect(String(summary["description"])).not.toMatch(/counts only/i);
    expect(String(summary["description"])).toContain("bin_view_report");
  });
});
