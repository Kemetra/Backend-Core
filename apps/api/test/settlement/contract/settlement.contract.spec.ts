/**
 * settlement.contract.spec.ts — 035 T030 OpenAPI conformance (load-only, no DB).
 *
 * Pins the THREE T030 operationIds + their load-bearing conventions against
 * `packages/contracts/openapi/settlement/settlement.yaml` (a NEW openapi
 * subdir; the loader scan is non-recursive so it is loaded explicitly):
 *   - operation presence + global uniqueness;
 *   - PER-OPERATION auth (this contract has NO document-level `security:`):
 *       POS intent → operatorAuthorization; Console read/list → cookieAuth;
 *   - strict request DTO (SettlementIntentCreate) — no server-resolved keys;
 *   - the closed Error set: POS intent declares 409 (no 404/403); Console read
 *     declares the non-disclosing 404;
 *   - the §IV Receivable projection (camelCase, no tenant_id/payload_hash).
 *
 * Structural / load-only (no app boot, no HTTP).
 */
import "reflect-metadata";

import { resolve } from "node:path";

import { loadOpenApiContracts } from "../../../src/openapi/loader";

const NEW_CONTRACT_ID = "settlement";

const T030_OPERATION_IDS = [
  "posRecordSettlementIntent",
  "consoleGetReceivable",
  "consoleListReceivables",
] as const;

function openapiSubDir(sub: string): string {
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
    sub,
  );
}

interface OperationObject {
  operationId?: string;
  security?: Array<Record<string, unknown>>;
  requestBody?: { content?: Record<string, { schema?: { $ref?: string } }> };
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
  const settlementContracts = loadOpenApiContracts({ dir: openapiSubDir("settlement") });
  const newContract = settlementContracts.find((c) => c.id === NEW_CONTRACT_ID);
  if (!newContract) {
    const ids = settlementContracts.map((c) => c.id).join(", ");
    throw new Error(
      `${NEW_CONTRACT_ID} contract not found under ${openapiSubDir("settlement")}; loaded ids: [${ids}]`,
    );
  }
  doc = newContract.document as OpenApiDocument;

  // SHIPPED operationIds the T030 ops must not collide with: top-level + the
  // nested feature subdirs (excl. self).
  shippedOperationIds = new Set<string>();
  collectOperationIds(
    loadOpenApiContracts().map((c) => c.document as OpenApiDocument),
    shippedOperationIds,
  );
  for (const sub of ["catalog", "pos-sales", "erpnext-connector", "sale-sync-ops"]) {
    collectOperationIds(
      loadOpenApiContracts({ dir: openapiSubDir(sub) }).map((c) => c.document as OpenApiDocument),
      shippedOperationIds,
    );
  }
});

function operations(): Array<{ path: string; method: string; op: OperationObject }> {
  const out: Array<{ path: string; method: string; op: OperationObject }> = [];
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    for (const [method, op] of Object.entries(item)) {
      out.push({ path, method, op });
    }
  }
  return out;
}

function findOp(operationId: string): OperationObject | undefined {
  return operations().find((o) => o.op.operationId === operationId)?.op;
}

function schema(name: string): SchemaObject | undefined {
  return doc.components?.schemas?.[name];
}

// ===========================================================================
// 1. Loadability + document conventions
// ===========================================================================
describe("settlement.yaml — loadability", () => {
  it("is parseable by the production OpenAPI loader", () => {
    expect(doc).toBeDefined();
    expect(typeof doc).toBe("object");
  });

  it("declares OpenAPI 3.1 of record", () => {
    expect(doc.openapi).toBe("3.1.0");
  });
});

// ===========================================================================
// 2. T030 operations present + globally unique
// ===========================================================================
describe("settlement.yaml — T030 operations", () => {
  it("declares all three T030 operationIds", () => {
    for (const id of T030_OPERATION_IDS) {
      expect(findOp(id)).toBeDefined();
    }
  });

  it("does NOT collide with or rename any shipped operationId", () => {
    for (const id of T030_OPERATION_IDS) {
      expect(shippedOperationIds.has(id)).toBe(false);
    }
  });
});

// ===========================================================================
// 3. Per-operation auth (NO document-level security in this contract)
// ===========================================================================
describe("settlement.yaml — per-operation auth split (§8)", () => {
  it("defines both the cookieAuth and operatorAuthorization schemes", () => {
    const cookie = doc.components?.securitySchemes?.["cookieAuth"];
    expect(cookie?.["type"]).toBe("apiKey");
    expect(cookie?.["in"]).toBe("cookie");
    expect(cookie?.["name"]).toBe("dp2_session");
    const env = doc.components?.securitySchemes?.["operatorAuthorization"];
    expect(env?.["type"]).toBe("http");
    expect(env?.["scheme"]).toBe("bearer");
  });

  it("guards the POS intent route with operatorAuthorization (not cookieAuth)", () => {
    const op = findOp("posRecordSettlementIntent");
    expect(op?.security).toEqual([{ operatorAuthorization: [] }]);
  });

  it("guards the Console read/list routes with cookieAuth (not the envelope)", () => {
    for (const id of ["consoleGetReceivable", "consoleListReceivables"] as const) {
      expect(findOp(id)?.security).toEqual([{ cookieAuth: [] }]);
    }
  });
});

// ===========================================================================
// 4. Strict request DTO (§XII) — no server-resolved keys
// ===========================================================================
describe("settlement.yaml — SettlementIntentCreate DTO", () => {
  it("is strict and requires only saleRef + payers (no tenant/store/actor)", () => {
    const s = schema("SettlementIntentCreate");
    expect(s?.additionalProperties).toBe(false);
    expect(s?.required?.sort()).toEqual(["payers", "saleRef"]);
    for (const forbidden of ["tenant_id", "tenantId", "store_id", "storeId", "created_by"]) {
      expect(s?.properties?.[forbidden]).toBeUndefined();
    }
  });
});

// ===========================================================================
// 5. Closed error set — POS 409 (no 404/403); Console non-disclosing 404
// ===========================================================================
describe("settlement.yaml — error envelope", () => {
  it("POS intent declares 409 and NO 404/403 (the surface's closed set)", () => {
    const responses = findOp("posRecordSettlementIntent")?.responses ?? {};
    expect(responses["409"]).toBeDefined();
    expect(responses["404"]).toBeUndefined();
    expect(responses["403"]).toBeUndefined();
  });

  it("Console read declares the non-disclosing 404", () => {
    expect((findOp("consoleGetReceivable")?.responses ?? {})["404"]).toBeDefined();
  });

  it("Error is the canonical envelope { error: { code, message, request_id? } }", () => {
    const err = schema("Error");
    expect(err?.required).toEqual(["error"]);
  });
});

// ===========================================================================
// 6. Receivable projection — §IV (camelCase, no raw DB leakage)
// ===========================================================================
describe("settlement.yaml — Receivable projection", () => {
  const proj = () => schema("Receivable");

  it("is a strict projection (no raw DB entity, §IV)", () => {
    expect(proj()?.additionalProperties).toBe(false);
  });

  it("carries the contract identity + lifecycle fields (camelCase)", () => {
    const props = proj()?.properties ?? {};
    for (const name of [
      "receivableRef",
      "saleRef",
      "payerRef",
      "outstandingBalance",
      "state",
      "version",
    ]) {
      expect(props[name]).toBeDefined();
    }
  });

  it("leaks NO tenant_id / payload_hash / raw sale lines", () => {
    const props = proj()?.properties ?? {};
    for (const forbidden of ["tenant_id", "tenantId", "payload_hash", "lines", "saleLines"]) {
      expect(props[forbidden]).toBeUndefined();
    }
  });
});

// ===========================================================================
// 7. Money patterns — per-field, not one shared non-negative pattern.
//    variance is signed (claimed − remitted, negative on over-remittance).
//    Request fields follow the Zod rule for that field. remittedAmount is >= 0.
// ===========================================================================
const SIGNED_MONEY = "^-?[0-9]{1,15}(\\.[0-9]{1,4})?$";
const NON_NEGATIVE_MONEY = "^[0-9]{1,15}(\\.[0-9]{1,4})?$";
// Same digit bound as the Zod regex, plus a zero-reject so it matches the > 0 refine.
const POSITIVE_MONEY = "^(?!0+(?:\\.0+)?$)[0-9]{1,15}(\\.[0-9]{1,4})?$";

function moneyRef(schemaName: string, field: string): string | undefined {
  const prop = schema(schemaName)?.properties?.[field] as { $ref?: string } | undefined;
  return prop?.$ref;
}

describe("settlement.yaml — money patterns", () => {
  it("splits signed, non-negative, and positive money", () => {
    expect(schema("Money")?.pattern).toBe(SIGNED_MONEY);
    expect(schema("NonNegativeMoney")?.pattern).toBe(NON_NEGATIVE_MONEY);
    expect(schema("PositiveMoney")?.pattern).toBe(POSITIVE_MONEY);
  });

  it("keeps signed Money only where the value can be negative", () => {
    expect(moneyRef("ReconciliationResult", "variance")).toBe("#/components/schemas/Money");
  });

  it("points each other money field at that field's own rule", () => {
    expect(moneyRef("Receivable", "outstandingBalance")).toBe(
      "#/components/schemas/NonNegativeMoney",
    );
    expect(moneyRef("PaymentApplicationCreate", "amount")).toBe(
      "#/components/schemas/PositiveMoney",
    );
    expect(moneyRef("SettlementIntentPayer", "owedAmount")).toBe(
      "#/components/schemas/PositiveMoney",
    );
    expect(moneyRef("RemittanceReconcile", "remittedAmount")).toBe(
      "#/components/schemas/NonNegativeMoney",
    );
    expect(moneyRef("ReconciliationResult", "claimedAmount")).toBe(
      "#/components/schemas/NonNegativeMoney",
    );
    expect(moneyRef("ReconciliationResult", "remittedAmount")).toBe(
      "#/components/schemas/NonNegativeMoney",
    );
  });

  it("types cashTendered as nullable non-negative money (0 allowed)", () => {
    const cash = schema("SettlementIntentCreate")?.properties?.["cashTendered"] as {
      anyOf?: Array<{ $ref?: string; type?: string }>;
    };
    expect(cash?.anyOf).toEqual([
      { $ref: "#/components/schemas/NonNegativeMoney" },
      { type: "null" },
    ]);
  });

  it("the patterns accept and reject the boundary examples", () => {
    const signed = new RegExp(SIGNED_MONEY);
    const nonNeg = new RegExp(NON_NEGATIVE_MONEY);
    const positive = new RegExp(POSITIVE_MONEY);
    for (const ok of ["0", "0.0000", "120.00", "999999999999999.9999"]) {
      expect(nonNeg.test(ok)).toBe(true);
    }
    expect(signed.test("-30.0000")).toBe(true);
    expect(nonNeg.test("-30.0000")).toBe(false);
    expect(positive.test("0")).toBe(false);
    expect(positive.test("0.0000")).toBe(false);
    expect(positive.test("0.0001")).toBe(true);
    expect(positive.test("120.00")).toBe(true);
    expect(positive.test("-1.00")).toBe(false);
  });
});
