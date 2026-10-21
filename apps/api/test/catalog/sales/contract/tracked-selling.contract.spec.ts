/**
 * apps/api/test/catalog/sales/contract/tracked-selling.contract.spec.ts
 *
 * RT-450 (RT-50 Gate 7 follow-up F3) — structural conformance of the
 * contract-only tracked-selling change across the five contracts it touches:
 *
 *   pos-sales/tracked-lines.yaml          1.0.0-draft  (new: TLV + lot lookup)
 *   pos-sales/sales.yaml                  1.15.0-draft (capture `tracking`)
 *   catalog/read-down.yaml                1.1.0-draft  (row `tracking`)
 *   erpnext-connector/posting-feed.yaml   1.10.0-draft (batch ref on the line)
 *   erpnext-connector/stock-view.yaml     1.4.0-draft  (tracking evidence)
 *
 * Load-only (no app boot, no HTTP, no DB). Instances are checked with Ajv
 * (2020-12, the OpenAPI 3.1 dialect). The runtime is RT-451: nothing here
 * touches a DTO, so the two parity lists in `sales.contract.spec.ts` carry the
 * fields the contract declares ahead of the runtime.
 */
import "reflect-metadata";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import Ajv2020, { type ValidateFunction } from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { load as parseYaml } from "js-yaml";

import { CONTRACTS_DIR } from "../../../_helpers/openapi-routes";

type Sch = {
  type?: unknown;
  required?: string[];
  properties?: Record<string, Sch>;
  additionalProperties?: unknown;
  enum?: string[];
  maxItems?: number;
  maxLength?: number;
  anyOf?: Array<{ $ref?: string; type?: string }>;
  const?: unknown;
  description?: string;
  $ref?: string;
  format?: string;
  minimum?: number;
};
type Op = {
  operationId?: string;
  security?: Array<Record<string, unknown>>;
  parameters?: unknown[];
  responses?: Record<string, { $ref?: string; headers?: Record<string, unknown> }>;
  description?: string;
  "x-runtime-status"?: string;
  "x-runtime-note"?: string;
  "x-idempotency"?: string;
};
type Doc = {
  info: { version: string; description: string };
  paths: Record<string, Record<string, Op>>;
  components: {
    schemas: Record<string, Sch>;
    responses: Record<string, { headers?: Record<string, unknown>; description?: string }>;
    securitySchemes: Record<string, unknown>;
  };
};

const byName = (a: string, b: string): number => a.localeCompare(b);
const flat = (text: string): string => text.replace(/\s+/g, " ");
const loadDoc = (file: string): Doc => parseYaml(readFileSync(join(CONTRACTS_DIR, file), "utf8")) as Doc;
const schemaOf = (doc: Doc, name: string): Sch => doc.components.schemas[name] as Sch;
const propsOf = (schema: Sch): Record<string, Sch> => schema.properties as Record<string, Sch>;
const propOf = (doc: Doc, schemaName: string, prop: string): Sch => propsOf(schemaOf(doc, schemaName))[prop] as Sch;
const sortedKeys = (record: object): string[] => Object.keys(record).sort(byName);
const sortedList = (list: readonly string[]): string[] => [...list].sort(byName);
const infoOf = (doc: Doc): string => flat(doc.info.description);
const describedOf = (node: Sch): string => flat(node.description as string);
const opOf = (doc: Doc, path: string, method: string): Op => (doc.paths[path] as Record<string, Op>)[method] as Op;
const refOf = (schema: Sch): string => schema.$ref as string;
const anyOfKinds = (schema: Sch): string[] => (schema.anyOf as Array<{ $ref?: string; type?: string }>).map((alt) => alt.$ref ?? (alt.type as string));

function validatorFor(doc: Doc, name: string): ValidateFunction {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  ajv.addSchema({ ...doc, $id: "doc" });
  return ajv.compile({ $ref: `doc#/components/schemas/${name}` });
}

/** Asserts a validator's verdict for each instance, naming the instance on failure. */
function expectVerdicts(validate: ValidateFunction, instances: unknown[], expected: boolean): void {
  for (const instance of instances) expect({ instance, ok: validate(instance) }).toEqual({ instance, ok: expected });
}

const UUID = "0191d0e0-0000-7000-8000-000000000001";
const UUID2 = "0191d0e0-0000-7000-8000-000000000002";
const NOW = "2026-10-21T10:00:00Z";
const COMBINATORS = ["allOf", "oneOf", "anyOf", "if", "then", "else", "not"];

function expectNoCombinator(schema: Sch): void {
  expect(Object.keys(schema).filter((key) => COMBINATORS.includes(key))).toEqual([]);
}

// ===========================================================================
// pos-sales/tracked-lines.yaml — the TLV and the lot lookup (new, contract-only)
// ===========================================================================
describe("pos-sales/tracked-lines.yaml — RT-450 TLV and lot lookup", () => {
  const doc = loadDoc("pos-sales/tracked-lines.yaml");
  const tlvPath = "/api/pos/v1/tracked-line-validations";
  const lotsPath = "/api/pos/v1/products/{productId}/tracked-lots";
  const tlv = opOf(doc, tlvPath, "post");
  const lots = opOf(doc, lotsPath, "get");
  const ops = [tlv, lots];
  const refusalReasons = [
    "unknown_identity",
    "wrong_product",
    "expired",
    "held",
    "recalled",
    "profile_mismatch",
    "not_sellable",
  ];
  const lot = { identityId: UUID, code: "LOT-A1", expiryDate: "2027-03-31" };
  const accepted = {
    outcome: "accepted",
    validationId: UUID2,
    validatedAt: NOW,
    safetyRevision: 7,
    identity: lot,
    fefoSuggestion: { ...lot, identityId: UUID2, code: "LOT-A0" },
  };
  const refused = { outcome: "refused", reason: "expired", validationId: UUID2, validatedAt: NOW, safetyRevision: 7 };
  const request = { productId: UUID, identity: { identityId: UUID }, quantity: "2", selection: "scanned", draftLineRef: "draft-1" };
  const withIdentity = (identity: unknown) => ({ ...request, identity });

  it("is a new 1.0.0-draft contract whose two operations are contract-only with a runtime note", () => {
    expect(doc.info.version).toBe("1.0.0-draft");
    expect(ops.map((op) => op.operationId)).toEqual(["posValidateTrackedLine", "posListTrackedLots"]);
    expect(ops.map((op) => op["x-runtime-status"])).toEqual(["contract-only", "contract-only"]);
    for (const op of ops) expect((op["x-runtime-note"] as string).trim().length).toBeGreaterThan(0);
  });

  it("accepts the envelope OR the device token as separate alternatives, never both in one requirement", () => {
    for (const op of ops) expect(op.security).toEqual([{ operatorAuthorization: [] }, { device: [] }]);
    expect(sortedKeys(doc.components.securitySchemes)).toEqual(["device", "operatorAuthorization"]);
  });

  it("takes no Idempotency-Key and says each call is a new validation", () => {
    expect(tlv["x-idempotency"]).toBeUndefined();
    expect(tlv.parameters).toBeUndefined();
    expect(infoOf(doc)).toContain("takes NO `Idempotency-Key`, on purpose");
    expect(infoOf(doc)).toContain("a retry is a new validation");
  });

  it("states that only a 200 means the TLV succeeded and that every other outcome means unavailable", () => {
    const info = infoOf(doc);
    expect(info).toContain('"Online" means the TLV succeeded');
    expect(info).toContain("A 4xx, a 5xx, a timeout or a network failure all mean the TLV is UNAVAILABLE");
    expect(info).toContain("never refuses on quantity");
    expect(flat(tlv.description as string)).toContain("A 200 is the only signal that the TLV succeeded");
  });

  it("the request is strict, takes no tenant, store or terminal, and requires the TLV inputs", () => {
    const req = schemaOf(doc, "ValidateTrackedLineRequest");
    expect(req.additionalProperties).toBe(false);
    expect(sortedList(req.required as string[])).toEqual(["draftLineRef", "identity", "productId", "quantity", "selection"]);
    const names = Object.keys(propsOf(req)).join(" ").toLowerCase();
    for (const banned of ["tenant", "store", "terminal", "device"]) expect(names).not.toContain(banned);
    expect(Object.keys(propsOf(req))).toContain("operatorUserId");
    expectNoCombinator(req);
  });

  it("validates identity by id or by code, and refuses an ambiguous or empty identity", () => {
    const validate = validatorFor(doc, "ValidateTrackedLineRequest");
    expectVerdicts(validate, [request, withIdentity({ code: "LOT-A1" }), withIdentity({ code: "LOT-A1", expiryDate: "2027-03-31" })], true);
    const bad = [{}, { identityId: UUID, code: "LOT-A1" }, { identityId: UUID, expiryDate: "2027-03-31" }, { identityId: UUID, code: "LOT-A1", expiryDate: "2027-03-31" }, { code: "" }];
    expectVerdicts(validate, bad.map(withIdentity), false);
  });

  it("validates quantity, selection and strict keys", () => {
    const validate = validatorFor(doc, "ValidateTrackedLineRequest");
    expectVerdicts(validate, ["0", "0.000000", "-1", "abc"].map((quantity) => ({ ...request, quantity })), false);
    expectVerdicts(validate, [{ ...request, quantity: "1.5" }, { ...request, operatorUserId: UUID }], true);
    expectVerdicts(validate, [{ ...request, selection: "random" }, { ...request, tenantId: UUID }], false);
  });

  it("answers a tagged union: accepted carries the identity and the FEFO suggestion", () => {
    const validate = validatorFor(doc, "TrackedLineValidation");
    const nullExpiry = { ...accepted, identity: { ...lot, expiryDate: null } };
    expectVerdicts(validate, [accepted, { ...accepted, fefoSuggestion: null }, nullExpiry], true);
    expectVerdicts(validate, [{ ...accepted, validationId: undefined }, { ...accepted, reason: "expired" }], false);
  });

  it("answers a tagged union: refused carries exactly one of the closed reasons", () => {
    const validate = validatorFor(doc, "TrackedLineValidation");
    expectVerdicts(validate, refusalReasons.map((reason) => ({ ...refused, reason })), true);
    expectVerdicts(validate, [{ ...refused, reason: "out_of_stock" }, { ...refused, identity: lot }, { ...refused, outcome: "maybe" }], false);
    expect(propOf(doc, "TrackedLineRefused", "reason").enum).toEqual(refusalReasons);
  });

  it("documents the refusal order, the expiry rule and that a refusal is recorded, not an HTTP error", () => {
    const text = flat(tlv.description as string);
    expect(text).toContain("the first in this order wins");
    expect(text).toContain("`recalled` (an active `recall_hold`); then `held` (an active `quality_hold`)");
    expect(text).toContain("a refusal is a business answer, not an HTTP error, and it is recorded like an acceptance");
    expect(text).toContain("the identity record's expiry governs");
    expect(infoOf(doc)).toContain("A lot is sellable through its `expiryDate`, inclusive");
    expect(infoOf(doc)).toContain("The till's clock is never used");
    expect(infoOf(doc)).toContain("its `validationId` is never a valid `validationId` for a sale line");
  });

  it("every 200 carries the RT-639 rotate headers", () => {
    for (const op of ops) {
      const headers = (op.responses as Record<string, { headers?: Record<string, unknown> }>)["200"] as { headers: Record<string, unknown> };
      expect(sortedKeys(headers.headers)).toEqual(["X-Device-Token-Rotate-After", "X-Device-Token-Rotate-Stage"]);
    }
  });

  it("every 429 carries Retry-After and the status sets are closed", () => {
    for (const op of ops) expect((op.responses as Record<string, { $ref?: string }>)["429"]?.$ref).toBe("#/components/responses/TooManyRequests");
    expect(sortedKeys(doc.components.responses["TooManyRequests"]?.headers as object)).toEqual(["Retry-After"]);
    expect(sortedKeys(tlv.responses as object)).toEqual(["200", "400", "401", "403", "404", "429", "500"]);
    expect(sortedKeys(lots.responses as object)).toEqual(["200", "400", "401", "404", "429", "500"]);
  });

  it("the lot list is bounded and strict, with a closed FEFO policy", () => {
    const list = schemaOf(doc, "TrackedLotList");
    expect(list.additionalProperties).toBe(false);
    expect(propOf(doc, "TrackedLotList", "lots").maxItems).toBe(500);
    expect(propOf(doc, "TrackedLotList", "fefoPolicy").enum).toEqual(["off", "suggest"]);
    expect(Object.keys(propsOf(list))).toEqual(["productId", "businessDate", "fefoPolicy", "safetyRevision", "lots"]);
  });

  it("the lot list accepts a nullable rank and position and refuses extra fields", () => {
    const validate = validatorFor(doc, "TrackedLotList");
    const row = { identityId: UUID, code: "LOT-A1", expiryDate: "2027-03-31", fefoRank: 1, sellablePosition: "12" };
    const body = { productId: UUID, businessDate: "2026-10-21", fefoPolicy: "suggest", safetyRevision: 7, lots: [row] };
    const nullRow = { ...row, fefoRank: null, sellablePosition: null, expiryDate: null };
    expectVerdicts(validate, [body, { ...body, lots: [nullRow] }, { ...body, lots: [{ ...row, sellablePosition: "-3" }] }, { ...body, lots: [] }], true);
    expectVerdicts(validate, [{ ...body, lots: [{ ...row, fefoRank: 0 }] }, { ...body, lots: [{ ...row, erpnextBatchRef: "B-1" }] }, { ...body, fefoPolicy: "enforce" }], false);
  });

  it("describes the lookup order, the advisory position and the non-disclosing 404", () => {
    const lookup = flat(lots.description as string);
    expect(lookup).toContain("rank 1 is the lot the TLV would suggest");
    expect(lookup).toContain("never a reason to refuse a sale");
    expect(lookup).toContain("a non-disclosing 404");
  });

  it("states a source of truth for the identity, the expiry, the Batch ref and the revision", () => {
    const info = infoOf(doc);
    expect(info).toContain("the Backend-Core Inventory tracking identity");
    expect(info).toContain("expiry is the identity record's");
    expect(info).toContain("The ERPNext Batch behind an identity is NOT on this surface");
    expect(info).toContain("`safetyRevision` is Inventory's per-tenant Safety Revision");
    expect(JSON.stringify(doc)).not.toMatch(/erpnextBatchRef|batchRef/);
  });

  it("carries the rollout order and adds no safety-feed, hold, recall or resolution operation", () => {
    expect(infoOf(doc)).toContain("ROLLOUT ORDER: (1) this contract; (2) the RT-451 runtime");
    expect(Object.keys(doc.paths)).toEqual([tlvPath, lotsPath]);
  });
});

// ===========================================================================
// pos-sales/sales.yaml — capture `tracking`, safety fields, echoes
// ===========================================================================
describe("pos-sales/sales.yaml — RT-450 tracked capture (1.15.0-draft)", () => {
  const doc = loadDoc("pos-sales/sales.yaml");
  const capture = opOf(doc, "/api/pos/v1/sales", "post");
  const line = {
    lineName: "Panadol Extra 24",
    unitPrice: "45.00",
    currencyCode: "EGP",
    quantity: "2",
    lineAmount: "90.00",
    unit: "box",
  };
  const tracking = { identityId: UUID, code: "LOT-A1", expiryDate: "2027-03-31", selection: "fefo_suggested", validationId: UUID2 };
  const withTracking = (value: unknown) => ({ ...line, tracking: value });

  it("bumps the version and the note cites the owner authorization and the rollout order", () => {
    expect(doc.info.version).toBe("1.15.0-draft");
    const info = infoOf(doc);
    expect(info).toContain("RT-450 (1.15.0-draft; [GATED] owner authorization Jira RT-450 comment 13212, 2026-10-21");
    expect(info).toContain("the POS MUST NOT send them before RT-451 is deployed and tracked selling is activated for the tenant");
  });

  it("the note states hash membership, never-reject and the Batch boundary", () => {
    const info = infoOf(doc);
    expect(info).toContain("Capture NEVER rejects a real sale for tracking reasons");
    expect(info).toContain("`tracking` is part of the sale `payload_hash`");
    expect(info).toContain("`safetyRevision` and `safetySyncedAt` are not part of the `payload_hash`");
    expect(info).toContain("The ERPNext Batch behind it is NOT on this surface");
  });

  it("CaptureSaleLine and CaptureSaleRequest gain only optional properties and no combinator", () => {
    const lineSchema = schemaOf(doc, "CaptureSaleLine");
    const request = schemaOf(doc, "CaptureSaleRequest");
    expect(lineSchema.required).toEqual(["lineName", "unitPrice", "currencyCode", "quantity", "lineAmount", "unit"]);
    expect(request.required).toEqual(["sourceSystem", "externalId", "currencyCode", "posTotal", "occurredAt", "lines"]);
    expectNoCombinator(lineSchema);
    expectNoCombinator(request);
  });

  it("the new capture properties are declared and optional", () => {
    expect(refOf(propOf(doc, "CaptureSaleLine", "tracking"))).toBe("#/components/schemas/CaptureSaleLineTracking");
    expect(propOf(doc, "CaptureSaleRequest", "safetyRevision")).toMatchObject({ type: "integer", minimum: 0 });
    expect(propOf(doc, "CaptureSaleRequest", "safetySyncedAt")).toMatchObject({ type: "string", format: "date-time" });
  });

  it("CaptureSaleLineTracking is strict with a closed selection and no combinator", () => {
    const schema = schemaOf(doc, "CaptureSaleLineTracking");
    expect(schema.additionalProperties).toBe(false);
    expect(sortedList(schema.required as string[])).toEqual(["code", "identityId", "selection"]);
    expect(propOf(doc, "CaptureSaleLineTracking", "selection").enum).toEqual(["scanned", "fefo_suggested", "operator_selected"]);
    expect(propOf(doc, "CaptureSaleLineTracking", "code").maxLength).toBe(128);
    expect(propOf(doc, "CaptureSaleLineTracking", "expiryDate")).toMatchObject({ type: "string", format: "date" });
    expectNoCombinator(schema);
  });

  it("keeps validationId and expiryDate optional so no G7-9 row needs a 400", () => {
    const validate = validatorFor(doc, "CaptureSaleLine");
    const { validationId: _v, expiryDate: _e, ...minimal } = tracking;
    expectVerdicts(validate, [line, withTracking(tracking), withTracking(minimal)], true);
  });

  it("refuses malformed tracking objects", () => {
    const validate = validatorFor(doc, "CaptureSaleLine");
    const malformed = [
      { ...tracking, selection: "guess" },
      { ...tracking, identityId: "not-a-uuid" },
      { ...tracking, erpnextBatchRef: "B-1" },
      { code: "LOT-A1", selection: "scanned" },
    ];
    expectVerdicts(validate, malformed.map(withTracking), false);
  });

  it("documents the G7-9 classification on captureSale", () => {
    const text = flat(capture.description as string);
    for (const row of ["Valid:", "Exact identity, but no `validationId`", "Exact identity, but expired", "Unrepresentable:"]) {
      expect(text).toContain(row);
    }
    expect(text).toContain("`tracking_unresolved`: no Inventory effect and no ERP posting intent");
    expect(text).toContain("When several rows match, the lower (more severe) row wins");
    expect(text).toContain("an ad-hoc line (no `tenantProductRef`) can never be tracked");
  });

  it("adds no status code, error code or classification field to capture", () => {
    const text = flat(capture.description as string);
    expect(text).toContain("adds no status code, no error code and no classification field to capture");
    expect(sortedKeys(capture.responses as object)).toEqual(["200", "201", "400", "401", "403", "409", "422", "429", "500"]);
    expect(flat(doc.components.responses["CaptureUnprocessable"]?.description as string)).not.toContain("tracking");
  });

  it("the line echo is optional, strict and never required", () => {
    expect(schemaOf(doc, "SaleLine").required).not.toContain("tracking");
    expect(refOf(propOf(doc, "SaleLine", "tracking"))).toBe("#/components/schemas/SaleLineTracking");
    const echo = schemaOf(doc, "SaleLineTracking");
    expect(echo.additionalProperties).toBe(false);
    expect(sortedList(echo.required as string[])).toEqual(["code", "identityId", "selection"]);
    const validate = validatorFor(doc, "SaleLineTracking");
    expectVerdicts(validate, [{ ...tracking, validationId: null, expiryDate: null }], true);
    expectVerdicts(validate, [{ ...tracking, selection: "other" }], false);
  });

  it("the sale echoes the safety fields as optional nullable values", () => {
    const sale = schemaOf(doc, "Sale");
    expect(sale.required).not.toContain("safetyRevision");
    expect(sale.required).not.toContain("safetySyncedAt");
    expect(propOf(doc, "Sale", "safetyRevision").type).toEqual(["integer", "null"]);
    expect(propOf(doc, "Sale", "safetySyncedAt").type).toEqual(["string", "null"]);
  });

  it("states a source of truth for the identity and the safety fields", () => {
    expect(describedOf(schemaOf(doc, "CaptureSaleLineTracking"))).toContain("are the Backend-Core Inventory tracking identity record");
    expect(describedOf(propOf(doc, "CaptureSaleRequest", "safetyRevision"))).toContain("Source of truth: Backend-Core Inventory");
  });
});

// ===========================================================================
// catalog/read-down.yaml — row `tracking`
// ===========================================================================
describe("catalog/read-down.yaml — RT-450 row tracking (1.1.0-draft)", () => {
  const doc = loadDoc("catalog/read-down.yaml");
  const row = {
    product_id: UUID,
    sku: "PAN-24",
    name: "Panadol Extra 24",
    aliases: [],
    price: { amount: "45.00", currency_code: "EGP" },
    tax_category: "standard",
    active: true,
    row_cursor: "c1",
  };
  const withTracking = (value: unknown) => ({ ...row, tracking: value });

  it("bumps the version and the note names Catalog as the source of truth and the re-pin order", () => {
    expect(doc.info.version).toBe("1.1.0-draft");
    const info = infoOf(doc);
    expect(info).toContain("1.1.0-draft (RT-450; [GATED] owner authorization Jira RT-450 comment 13212, 2026-10-21");
    expect(info).toContain("Source of truth: Catalog (`catalog/tracking-profile.yaml`");
    expect(info).toContain("MUST re-pin this version BEFORE the server emits the field");
  });

  it("SellableCatalogRow keeps its required list and gains an optional tracking reference", () => {
    const rowSchema = schemaOf(doc, "SellableCatalogRow");
    expect(rowSchema.required).toEqual(["product_id", "sku", "name", "aliases", "price", "tax_category", "active", "row_cursor"]);
    expect(refOf(propOf(doc, "SellableCatalogRow", "tracking"))).toBe("#/components/schemas/SellableRowTracking");
    expectNoCombinator(rowSchema);
  });

  it("SellableRowTracking is strict and its mode already carries serial", () => {
    const tracking = schemaOf(doc, "SellableRowTracking");
    expect(tracking.additionalProperties).toBe(false);
    expect(tracking.required).toEqual(["mode", "expiry_required"]);
    expect(propOf(doc, "SellableRowTracking", "mode").enum).toEqual(["none", "batch", "serial"]);
  });

  it("validates rows with and without tracking and refuses malformed tracking", () => {
    const validate = validatorFor(doc, "SellableCatalogRow");
    expectVerdicts(validate, [row, withTracking({ mode: "batch", expiry_required: true }), withTracking({ mode: "none", expiry_required: false })], true);
    const malformed = [{ mode: "lot", expiry_required: true }, { mode: "batch" }, { mode: "batch", expiry_required: true, erpnext_flag: true }];
    expectVerdicts(validate, malformed.map(withTracking), false);
  });

  it("says a serial product is never sold and that an absent field means untracked", () => {
    expect(describedOf(propOf(doc, "SellableRowTracking", "mode"))).toContain("the till MUST NOT sell a `serial` product");
    expect(infoOf(doc)).toContain("`tracking` is absent and the product is untracked");
  });
});

// ===========================================================================
// erpnext-connector/posting-feed.yaml — batch ref on the line
// ===========================================================================
describe("erpnext-connector/posting-feed.yaml — RT-450 batch ref (1.10.0-draft)", () => {
  const doc = loadDoc("erpnext-connector/posting-feed.yaml");
  const line = {
    lineRef: UUID,
    lineName: "Panadol Extra 24",
    unitPrice: "45.00",
    currencyCode: "EGP",
    quantity: "2",
    lineAmount: "90.00",
    unit: "box",
    erpnextItemRef: { doctype: "Item", name: "ITEM-1" },
  };
  const batch = { doctype: "Batch", name: "BATCH-0001" };

  it("bumps the version and the note cites the owner authorization and the freeze", () => {
    expect(doc.info.version).toBe("1.10.0-draft");
    const info = infoOf(doc);
    expect(info).toContain("RT-450 (1.10.0-draft; [GATED] owner authorization Jira RT-450 comment 13212, 2026-10-21");
    expect(info).toContain("FROZEN when the posting intent is created");
  });

  it("the note states the Connector-first order and the emit rules", () => {
    const info = infoOf(doc);
    expect(info).toContain("ROLLOUT ORDER (Connector first)");
    expect(info).toContain("Backend-Core MUST NOT emit `trackingMode: serial`");
    expect(info).toContain("MUST NOT emit a non-null `erpnextBatchRef` or `trackingMode: batch` to a Connector that has not accepted them");
  });

  it("SaleLine keeps its required list and gains two optional nullable fields", () => {
    const saleLine = schemaOf(doc, "SaleLine");
    expect(saleLine.required).toEqual(["lineRef", "lineName", "unitPrice", "currencyCode", "quantity", "lineAmount", "unit", "erpnextItemRef"]);
    expect(anyOfKinds(propOf(doc, "SaleLine", "erpnextBatchRef"))).toEqual(["#/components/schemas/ErpnextBatchRef", "null"]);
    expect(anyOfKinds(propOf(doc, "SaleLine", "trackingMode"))).toEqual(["string", "null"]);
  });

  it("ErpnextBatchRef is strict, fixed to the Batch doctype and bounded", () => {
    const batchRef = schemaOf(doc, "ErpnextBatchRef");
    expect(batchRef.additionalProperties).toBe(false);
    expect(batchRef.required).toEqual(["doctype", "name"]);
    expect(propOf(doc, "ErpnextBatchRef", "doctype").const).toBe("Batch");
    expect(propOf(doc, "ErpnextBatchRef", "name").maxLength).toBe(140);
  });

  it("validates lines without the fields, with null fields and with a Batch", () => {
    const validate = validatorFor(doc, "SaleLine");
    expectVerdicts(validate, [line, { ...line, erpnextBatchRef: null, trackingMode: null }, { ...line, erpnextBatchRef: batch, trackingMode: "batch" }], true);
  });

  it("refuses another doctype, extra keys and an unknown mode", () => {
    const validate = validatorFor(doc, "SaleLine");
    expectVerdicts(validate, [{ ...line, erpnextBatchRef: { ...batch, doctype: "Item" } }, { ...line, erpnextBatchRef: { ...batch, extra: 1 } }, { ...line, trackingMode: "lot" }], false);
  });

  it("states that the identity, its expiry and the edge map stay in Backend-Core", () => {
    expect(describedOf(propOf(doc, "SaleLine", "erpnextBatchRef"))).toContain("Source of truth: the Inventory edge map");
    expect(describedOf(propOf(doc, "SaleLine", "erpnextBatchRef"))).toContain("FROZEN at posting-intent creation");
    expect(infoOf(doc)).toContain("neither appears on this feed");
  });
});

// ===========================================================================
// erpnext-connector/stock-view.yaml — tracking master and batch-wise evidence
// ===========================================================================
describe("erpnext-connector/stock-view.yaml — RT-450 tracking evidence (1.4.0-draft)", () => {
  const doc = loadDoc("erpnext-connector/stock-view.yaml");
  const entry = { erpnextItemRef: { doctype: "Item", name: "ITEM-1" }, quantity: "10", stockUom: "Nos" };
  const batchRow = { batchRef: { doctype: "Batch", name: "BATCH-0001" }, quantity: "6", expiryDate: "2027-03-31", disabled: false };
  const flags = { hasBatchNo: true, hasSerialNo: false, hasExpiryDate: true };
  const withTracking = (tracking: unknown) => ({ ...entry, tracking });
  const withBatches = (batches: unknown[]) => withTracking({ ...flags, batches });

  it("bumps the version and the note says evidence only", () => {
    expect(doc.info.version).toBe("1.4.0-draft");
    const info = infoOf(doc);
    expect(info).toContain("VERSION 1.4 (RT-450; [GATED] owner authorization Jira RT-450 comment 13212, 2026-10-21");
    expect(info).toContain("THIS IS EVIDENCE ONLY");
    expect(info).toContain("it creates no Tracking Identity, moves no position, posts nothing, and carries no valuation");
  });

  it("the note states Backend-Core first, the reverse of the posting feed", () => {
    const info = infoOf(doc);
    expect(info).toContain("ROLLOUT ORDER (Backend-Core first: this is the REVERSE of `posting-feed.yaml` 1.10.0-draft");
    expect(info).toContain("The Connector MUST NOT send `tracking` until a Backend-Core that accepts it is deployed");
    expect(info).toContain('means the tracking evidence is UNKNOWN, never "untracked"');
  });

  it("BinEntry keeps its required list and gains an optional tracking reference", () => {
    const binEntry = schemaOf(doc, "BinEntry");
    expect(binEntry.required).toEqual(["erpnextItemRef", "quantity", "stockUom"]);
    expect(refOf(propOf(doc, "BinEntry", "tracking"))).toBe("#/components/schemas/BinEntryTracking");
    expectNoCombinator(binEntry);
  });

  it("BinEntryTracking and BinEntryBatch are strict and bounded", () => {
    const tracking = schemaOf(doc, "BinEntryTracking");
    expect(tracking.additionalProperties).toBe(false);
    expect(tracking.required).toEqual(["hasBatchNo", "hasSerialNo", "hasExpiryDate"]);
    expect(propOf(doc, "BinEntryTracking", "batches").maxItems).toBe(200);
    const batch = schemaOf(doc, "BinEntryBatch");
    expect(batch.additionalProperties).toBe(false);
    expect(sortedList(batch.required as string[])).toEqual(["batchRef", "disabled", "expiryDate", "quantity"]);
  });

  it("validates v1 entries and entries with flags and Batches", () => {
    const validate = validatorFor(doc, "BinEntry");
    const none = { hasBatchNo: false, hasSerialNo: false, hasExpiryDate: false };
    const disabled = { ...batchRow, quantity: "-1", expiryDate: null, disabled: true };
    expectVerdicts(validate, [entry, withTracking(none), withBatches([batchRow, disabled])], true);
  });

  it("refuses incomplete flags, unknown keys, bad quantities, another doctype and too many Batches", () => {
    const validate = validatorFor(doc, "BinEntry");
    const refused = [
      withTracking({ hasBatchNo: true }),
      withBatches([{ ...batchRow, price: "1" }]),
      withBatches([{ ...batchRow, quantity: "1e3" }]),
      withBatches([{ ...batchRow, batchRef: { doctype: "Item", name: "X" } }]),
      withBatches(Array.from({ length: 201 }, () => batchRow)),
    ];
    expectVerdicts(validate, refused, false);
  });

  it("carries no valuation-style property name on the new schemas", () => {
    const banned = /^(cost|price|valuation|amount|value|rate|total|currency)/i;
    const names = ["BinEntryTracking", "BinEntryBatch", "ErpnextBatchRef"].flatMap((name) => Object.keys(propsOf(schemaOf(doc, name))));
    expect(names.filter((prop) => banned.test(prop))).toEqual([]);
  });
});
