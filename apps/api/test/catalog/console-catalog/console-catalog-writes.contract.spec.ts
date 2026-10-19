/**
 * apps/api/test/catalog/console-catalog/console-catalog-writes.contract.spec.ts
 *
 * RT-738 (CAT-W1 + CAT-W2 of the RT-281 decomposition, comment 12887 §2): the
 * interim console catalog writes added to `catalog/console-catalog.yaml`.
 * `[GATED]` contract, owner-approved 2026-10-19 (O-1 interim writes, O-2 no
 * price). The runtime ships in the RT-738 runtime change.
 *
 * Structural / load-only, plus AJV fixtures against the request schemas. No
 * app boot and no HTTP. What this pins:
 *
 *   1. Seven write operations at their paths, contract-only, each with its
 *      audit action, labelled interim, no operationId collision.
 *   2. Write scope: `cookieAuth` only; 403 only `origin_rejected` /
 *      `tax_override_forbidden`; the non-disclosing 404; `Idempotency-Key`
 *      on the create only; no tenant id from the request.
 *   3. No price, tenant, status or tracking field in any request (O-2).
 *   4. The conflict / precondition codes (`stale_write`, `alias_conflict`,
 *      `product_retired`, `price_override_present`, `override_empty`).
 *   5. AJV fixtures: valid bodies pass, each invalid one fails.
 */
import "reflect-metadata";

import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";

import {
  allContracts,
  contractDocument,
  operationIdsExcept,
  type OpenApiDocument,
  type OperationObject,
  type ParameterObject,
} from "../../_helpers/openapi-contract";

const CONTRACT_ID = "console-catalog";
const PRODUCTS = "/api/v1/catalog/products";
const PRODUCT = "/api/v1/catalog/products/{productId}";
const OVERRIDE = "/api/v1/catalog/products/{productId}/store-overrides/{storeId}";

type Method = "post" | "patch" | "put";
interface WriteOp {
  readonly id: string;
  readonly method: Method;
  readonly path: string;
  readonly audit: string;
  readonly ok: "200" | "201";
  readonly responses: readonly string[];
  readonly slice: "CAT-W1" | "CAT-W2";
}

const BASE = ["400", "401", "403", "404", "429", "500"];
const WRITES: readonly WriteOp[] = [
  {
    id: "consoleCreateCatalogProduct",
    method: "post",
    path: PRODUCTS,
    audit: "catalog.product.create",
    ok: "201",
    responses: [...BASE, "409", "422", "425"],
    slice: "CAT-W1",
  },
  {
    id: "consoleUpdateCatalogProduct",
    method: "patch",
    path: PRODUCT,
    audit: "catalog.product.update",
    ok: "200",
    responses: [...BASE, "409", "422"],
    slice: "CAT-W1",
  },
  {
    id: "consoleRetireCatalogProduct",
    method: "post",
    path: `${PRODUCT}/retire`,
    audit: "catalog.product.retire",
    ok: "200",
    responses: [...BASE, "409"],
    slice: "CAT-W1",
  },
  {
    id: "consoleAddProductIdentifier",
    method: "post",
    path: `${PRODUCT}/identifiers`,
    audit: "catalog.product_identifier.add",
    ok: "201",
    responses: [...BASE, "409"],
    slice: "CAT-W1",
  },
  {
    id: "consoleRetireProductIdentifier",
    method: "post",
    path: `${PRODUCT}/identifiers/retire`,
    audit: "catalog.product_identifier.retire",
    ok: "200",
    responses: BASE,
    slice: "CAT-W1",
  },
  {
    id: "consoleUpsertStoreOverride",
    method: "put",
    path: OVERRIDE,
    audit: "catalog.store_override.upsert",
    ok: "200",
    responses: [...BASE, "409", "422"],
    slice: "CAT-W2",
  },
  {
    id: "consoleRetireStoreOverride",
    method: "post",
    path: `${OVERRIDE}/retire`,
    audit: "catalog.store_override.retire",
    ok: "200",
    responses: [...BASE, "409"],
    slice: "CAT-W2",
  },
];

const REQUEST_SCHEMAS = [
  "CreateCatalogProductRequest",
  "UpdateCatalogProductRequest",
  "RetireRequest",
  "ProductIdentifierKey",
  "UpsertStoreOverrideRequest",
] as const;
type RequestSchema = (typeof REQUEST_SCHEMAS)[number];

let doc: OpenApiDocument;
let otherOperationIds: Set<string>;
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);

beforeAll(() => {
  const contracts = allContracts();
  doc = contractDocument(contracts, CONTRACT_ID);
  otherOperationIds = operationIdsExcept(contracts, CONTRACT_ID);
  ajv.addSchema(doc as object, CONTRACT_ID);
});

function op(w: WriteOp): OperationObject {
  const found = (doc.paths?.[w.path] as Record<string, OperationObject> | undefined)?.[w.method];
  if (!found) throw new Error(`${w.method.toUpperCase()} ${w.path} not declared`);
  return found;
}

function params(w: WriteOp): ParameterObject[] {
  return (op(w).parameters ?? []).map((p) =>
    p.$ref ? doc.components!.parameters![p.$ref.replace("#/components/parameters/", "")]! : p,
  );
}

function ref(value: unknown): string {
  return String((value as { $ref?: string } | undefined)?.$ref ?? "");
}

interface ResponseShape {
  readonly $ref?: string;
  readonly headers?: Record<string, unknown>;
  readonly content?: Record<string, { readonly schema?: unknown }>;
}

function response(w: WriteOp, status: string): ResponseShape {
  return (op(w).responses?.[status] ?? {}) as ResponseShape;
}

function statuses(w: WriteOp): string[] {
  return Object.keys(op(w).responses ?? {}).sort();
}

function responseDescription(w: WriteOp, status: string): string {
  const name = ref(op(w).responses?.[status]).replace("#/components/responses/", "");
  return String(doc.components?.responses?.[name]?.description ?? "");
}

function validator(name: RequestSchema): ValidateFunction {
  const v = ajv.getSchema(`${CONTRACT_ID}#/components/schemas/${name}`);
  if (!v) throw new Error(`ajv cannot resolve ${name}`);
  return v;
}

const STORE_ID = "0190f5a2-3b4c-7d8e-9f01-000000000002";
const CATEGORY_ID = "0190f5a2-3b4c-7d8e-9f01-000000000003";
const AT = "2026-10-19T09:00:00.123Z";

// ===========================================================================
// 1. Operations
// ===========================================================================
describe("console-catalog writes — operations", () => {
  it("declares the seven writes at their paths and methods", () => {
    for (const w of WRITES) expect(op(w).operationId).toBe(w.id);
    const methods = Object.entries(doc.paths ?? {}).flatMap(([path, item]) =>
      Object.keys(item)
        .filter((m) => m !== "get" && m !== "parameters")
        .map((m) => `${m} ${path}`),
    );
    expect(methods.sort()).toEqual(WRITES.map((w) => `${w.method} ${w.path}`).sort());
  });

  it("marks every write contract-only until the RT-738 runtime serves it", () => {
    for (const w of WRITES) {
      expect(op(w)["x-runtime-status"]).toBe("contract-only");
      expect(op(w)["x-runtime-note"]).toMatch(new RegExp(`RT-738 \\(${w.slice}\\)`));
    }
  });

  it("states the release posture of the writes apart from the reads", () => {
    expect(doc.info?.description).toMatch(/The seven writes come in `1\.1\.0-draft` \(RT-738/);
    expect(doc.info?.description).toMatch(/until the RT-738\s+runtime serves them/);
  });

  it("names one audit action per write (audited per mutation, decision O-6)", () => {
    for (const w of WRITES) expect(op(w)["x-audit-action"]).toBe(w.audit);
    expect(doc.info?.description).toMatch(/in the same\s+transaction as the change/);
    expect(doc.info?.description).toMatch(/catalog_change_log/);
  });

  it("labels every write interim, before Change Sets (decision 400)", () => {
    for (const w of WRITES) expect(op(w).description).toMatch(/^Interim \(pre Change Sets, decision 400\)/);
    expect(doc.info?.description).toMatch(/INTERIM console writes/);
  });

  it("collides with no operationId in any other contract", () => {
    expect(WRITES.map((w) => w.id).filter((id) => otherOperationIds.has(id))).toEqual([]);
  });
});

// ===========================================================================
// 2. Write scope
// ===========================================================================
describe("console-catalog writes — auth and scope", () => {
  it("inherits the cookieAuth-only document security", () => {
    expect(doc.security).toEqual([{ cookieAuth: [] }]);
    for (const w of WRITES) expect(op(w).security).toBeUndefined();
  });

  it("answers its success status and exactly its error statuses", () => {
    for (const w of WRITES) {
      expect({ id: w.id, statuses: statuses(w) }).toEqual({ id: w.id, statuses: [w.ok, ...w.responses].sort() });
    }
  });

  it("answers every success with the no-store product detail and every 404 with WriteNotFound", () => {
    for (const w of WRITES) {
      const success = response(w, w.ok);
      expect(ref(response(w, "404"))).toBe("#/components/responses/WriteNotFound");
      expect(success.headers?.["Cache-Control"]).toEqual({ $ref: "#/components/headers/CacheControlNoStore" });
      expect(ref(success.content?.["application/json"]?.schema)).toBe("#/components/schemas/ConsoleCatalogProductDetail");
    }
  });

  it("refuses with 403 only for origin_rejected, and tax_override_forbidden on the overrides", () => {
    for (const w of WRITES) {
      const text = responseDescription(w, "403");
      expect(text).toMatch(/origin_rejected/);
      if (w.slice === "CAT-W2") expect(text).toMatch(/tax_override_forbidden/);
      else expect(text).not.toMatch(/tax_override_forbidden/);
    }
  });

  it("makes the 404 non-disclosing, soft-deleted stores included", () => {
    const text = String(doc.components?.responses?.["WriteNotFound"]?.description);
    expect(text).toMatch(/non-disclosing/);
    expect(text).toMatch(/soft-deleted/);
    expect(text).toMatch(/role outside the\s+write's list/);
  });

  it("takes Idempotency-Key on the create only, and no tenant id anywhere", () => {
    for (const w of WRITES) {
      const headers = params(w).filter((p) => p.in === "header").map((p) => p.name);
      const create = w.id === "consoleCreateCatalogProduct";
      expect(headers).toEqual(create ? ["Idempotency-Key"] : []);
      expect((op(w) as Record<string, unknown>)["x-idempotency"]).toBe(create ? "required" : undefined);
      expect(params(w).filter((p) => /tenant/i.test(p.name ?? ""))).toEqual([]);
    }
    const key = doc.components!.parameters!["IdempotencyKey"]!;
    expect(key.schema).toMatchObject({ minLength: 16, maxLength: 128, pattern: "^[\\x21-\\x7E]{16,128}$" });
  });

  it("limits CAT-W1 to owner / tenant_admin and lets store_manager set availability only (O-4)", () => {
    const description = String(doc.info?.description);
    expect(description).toMatch(/CAT-W1 \(roles `owner`, `tenant_admin`\)/);
    expect(description).toMatch(/`store_manager` for the\s+availability of a store in its scope/);
    const upsert = WRITES.find((w) => w.id === "consoleUpsertStoreOverride")!;
    expect(op(upsert).description).toMatch(/`isActive` only; a `taxCategory` key is 403\s+`tax_override_forbidden`/);
  });
});

// ===========================================================================
// 3. No price (O-2) and strict requests
// ===========================================================================
describe("console-catalog writes — request bodies", () => {
  it("keeps every request strict and free of price, tenant, status and tracking fields", () => {
    for (const name of REQUEST_SCHEMAS) {
      const schema = doc.components!.schemas![name]!;
      expect(schema.additionalProperties).toBe(false);
      const keys = Object.keys((schema.properties as Record<string, unknown>) ?? {});
      expect(keys.filter((k) => /price|currency|amount|tenant|status|tracking|expiry|retired/i.test(k))).toEqual([]);
    }
  });

  it("states the price exclusion and keeps an override's price as is", () => {
    expect(doc.info?.description).toMatch(/no write sets or clears a default\s+price or an override price, O-2/);
    expect(doc.info?.description).toMatch(/an override's price, when it has one, is kept as is/);
  });
});

// ===========================================================================
// 4. Conflicts and preconditions
// ===========================================================================
describe("console-catalog writes — conflicts", () => {
  it("answers a stale expectedUpdatedAt with 409 stale_write", () => {
    for (const id of [
      "consoleUpdateCatalogProduct",
      "consoleRetireCatalogProduct",
      "consoleUpsertStoreOverride",
      "consoleRetireStoreOverride",
    ]) {
      const w = WRITES.find((x) => x.id === id)!;
      expect(responseDescription(w, "409")).toMatch(/stale_write/);
    }
    expect(doc.info?.description).toMatch(/strictly later `updatedAt`/);
  });

  it("makes alias_conflict non-disclosing", () => {
    const add = WRITES.find((w) => w.id === "consoleAddProductIdentifier")!;
    const text = responseDescription(add, "409");
    expect(text).toMatch(/alias_conflict/);
    expect(text).toMatch(/never\s+names, counts or hints at the product/);
  });

  it("refuses to retire an override that carries a price, and an empty override", () => {
    const retire = WRITES.find((w) => w.id === "consoleRetireStoreOverride")!;
    expect(responseDescription(retire, "409")).toMatch(/price_override_present/);
    const upsert = WRITES.find((w) => w.id === "consoleUpsertStoreOverride")!;
    expect(responseDescription(upsert, "422")).toMatch(/override_empty/);
  });

  it("refuses an unusable category and an idempotency-key reuse on the create", () => {
    const create = WRITES.find((w) => w.id === "consoleCreateCatalogProduct")!;
    expect(responseDescription(create, "422")).toMatch(/category_unavailable/);
    expect(responseDescription(create, "409")).toMatch(/idempotency_key_conflict/);
  });
});

// ===========================================================================
// 5. AJV fixtures
// ===========================================================================
describe("console-catalog writes — AJV fixtures", () => {
  it("create: accepts the minimal and full bodies, rejects a price, a blank name and a NUL", () => {
    const create = validator("CreateCatalogProductRequest");
    expect(create({ name: "Water 1.5L", taxCategory: "standard" })).toBe(true);
    expect(
      create({ name: "Water", taxCategory: "standard", description: null, categoryId: CATEGORY_ID, isActive: false }),
    ).toBe(true);
    expect(create({ name: "Water", taxCategory: "standard", defaultPrice: { amount: "1.00", currencyCode: "EGP" } })).toBe(
      false,
    );
    expect(create({ name: "Water", taxCategory: "standard", tenantId: CATEGORY_ID })).toBe(false);
    expect(create({ name: "   ", taxCategory: "standard" })).toBe(false);
    expect(create({ name: "a\u0000b", taxCategory: "standard" })).toBe(false);
    expect(create({ name: "x".repeat(501), taxCategory: "standard" })).toBe(false);
    expect(create({ name: "Water", taxCategory: "x".repeat(51) })).toBe(false);
    expect(create({ name: "Water" })).toBe(false);
  });

  it("update: needs expectedUpdatedAt and at least one field", () => {
    const update = validator("UpdateCatalogProductRequest");
    expect(update({ expectedUpdatedAt: AT, name: "New" })).toBe(true);
    expect(update({ expectedUpdatedAt: AT, description: null, categoryId: null })).toBe(true);
    expect(update({ expectedUpdatedAt: AT })).toBe(false);
    expect(update({ name: "New" })).toBe(false);
    expect(update({ expectedUpdatedAt: AT, taxCategory: null })).toBe(false);
    expect(update({ expectedUpdatedAt: AT, isActive: null })).toBe(false);
    expect(update({ expectedUpdatedAt: AT, trackingMode: "batch" })).toBe(false);
  });

  it("retire: needs exactly expectedUpdatedAt", () => {
    const retire = validator("RetireRequest");
    expect(retire({ expectedUpdatedAt: AT })).toBe(true);
    expect(retire({})).toBe(false);
    expect(retire({ expectedUpdatedAt: "yesterday" })).toBe(false);
  });

  it("identifier key: store scope and source system follow the identifier type", () => {
    const key = validator("ProductIdentifierKey");
    expect(key({ identifierType: "barcode", value: "000123" })).toBe(true);
    expect(key({ identifierType: "plu", value: "42", storeId: STORE_ID, sourceSystem: null })).toBe(true);
    expect(key({ identifierType: "external_pos_id", value: "A-1", sourceSystem: "legacy-pos" })).toBe(true);
    expect(key({ identifierType: "external_pos_id", value: "A-1" })).toBe(false);
    expect(key({ identifierType: "external_pos_id", value: "A-1", sourceSystem: "legacy", storeId: STORE_ID })).toBe(false);
    expect(key({ identifierType: "sku", value: "S1", sourceSystem: "legacy" })).toBe(false);
    expect(key({ identifierType: "ean", value: "1" })).toBe(false);
    expect(key({ identifierType: "barcode", value: " 000123" })).toBe(false);
    expect(key({ identifierType: "barcode", value: "000123 " })).toBe(false);
    expect(key({ identifierType: "barcode", value: "12\n3" })).toBe(false);
    expect(key({ identifierType: "barcode", value: "x".repeat(201) })).toBe(false);
  });

  it("override upsert: expectedUpdatedAt may be null, needs isActive or taxCategory, never a price", () => {
    const upsert = validator("UpsertStoreOverrideRequest");
    expect(upsert({ expectedUpdatedAt: null, isActive: false })).toBe(true);
    expect(upsert({ expectedUpdatedAt: AT, taxCategory: "zero" })).toBe(true);
    expect(upsert({ expectedUpdatedAt: AT, isActive: null, taxCategory: null })).toBe(true);
    expect(upsert({ isActive: false })).toBe(false);
    expect(upsert({ expectedUpdatedAt: null })).toBe(false);
    expect(upsert({ expectedUpdatedAt: null, isActive: true, price: { amount: "1.00", currencyCode: "EGP" } })).toBe(false);
    expect(upsert({ expectedUpdatedAt: null, taxCategory: " " })).toBe(false);
  });
});
