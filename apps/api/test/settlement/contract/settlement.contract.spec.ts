/**
 * settlement.contract.spec.ts — OpenAPI conformance for
 * `packages/contracts/openapi/settlement/settlement.yaml` (load-only, no DB).
 *
 * RT-417 (2.0.0; Option B, RT-413): the contract keeps only the payer-account
 * facade. Pins:
 *   - the 2.0.0 version and the exact operation set (the two payer routes);
 *   - the six retired operations: absent from `paths`, listed in
 *     `x-retired-operations` (runtime removal in RT-422), and declared by no
 *     other contract;
 *   - cookieAuth on both routes, `contract-only` until RT-418;
 *   - the strict payer DTO without `creditTerms`, and `externalRef` as the
 *     ERPNext Customer link;
 *   - the §IV payer projection (camelCase, no tenant_id / credit terms).
 *
 * Structural / load-only (no app boot, no HTTP).
 */
import "reflect-metadata";

import { readdirSync } from "node:fs";
import { resolve } from "node:path";

import { loadOpenApiContracts } from "../../../src/openapi/loader";

const NEW_CONTRACT_ID = "settlement";

const KEPT_OPERATIONS = {
  consoleCreatePayerAccount: { path: "/api/v1/settlement/payer-accounts", method: "post" },
  consoleListPayerAccounts: { path: "/api/v1/settlement/payer-accounts", method: "get" },
} as const;

const RETIRED_OPERATIONS = {
  consoleApplyPayment: "POST /api/v1/settlement/receivables/{receivableRef}/apply-payment",
  consoleSubmitClaim: "POST /api/v1/settlement/claims",
  consoleReconcileRemittance: "POST /api/v1/settlement/claims/{claimRef}/reconcile-remittance",
  posRecordSettlementIntent: "POST /api/v1/settlement/settlement-intent",
  consoleGetReceivable: "GET /api/v1/settlement/receivables/{receivableRef}",
  consoleListReceivables: "GET /api/v1/settlement/receivables",
} as const;

const RETIRED_SCHEMAS = [
  "Receivable",
  "ReceivablePage",
  "ReceivableState",
  "PaymentApplicationCreate",
  "SettlementIntentCreate",
  "SettlementIntentPayer",
  "SettlementIntentResult",
  "ClaimCreate",
  "Claim",
  "RemittanceReconcile",
  "ReconciliationResult",
];

const CONTRACTS_ROOT = resolve(__dirname, "..", "..", "..", "..", "..", "packages", "contracts", "openapi");

interface OperationObject {
  operationId?: string;
  security?: Array<Record<string, unknown>>;
  "x-runtime-status"?: string;
  "x-runtime-note"?: string;
  "x-idempotency"?: string;
  responses?: Record<string, unknown>;
}

type PathItem = Record<string, OperationObject>;

interface SchemaObject {
  type?: string | string[];
  additionalProperties?: boolean | Record<string, unknown>;
  required?: string[];
  properties?: Record<string, { description?: string } & Record<string, unknown>>;
  description?: string;
}

interface RetiredOperation {
  operationId?: string;
  route?: string;
  removedRuntimeIn?: string;
}

interface OpenApiDocument {
  openapi?: string;
  info?: { title?: string; version?: string; description?: string };
  paths?: Record<string, PathItem>;
  components?: {
    schemas?: Record<string, SchemaObject>;
    securitySchemes?: Record<string, Record<string, unknown>>;
    responses?: Record<string, unknown>;
    parameters?: Record<string, unknown>;
  };
  security?: Array<Record<string, unknown>>;
  "x-retired-operations"?: RetiredOperation[];
}

let doc: OpenApiDocument;
let otherContracts: OpenApiDocument[];

function subDirs(): string[] {
  return readdirSync(CONTRACTS_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

beforeAll(() => {
  const settlementContracts = loadOpenApiContracts({ dir: resolve(CONTRACTS_ROOT, "settlement") });
  const found = settlementContracts.find((c) => c.id === NEW_CONTRACT_ID);
  if (!found) {
    const ids = settlementContracts.map((c) => c.id).join(", ");
    throw new Error(`${NEW_CONTRACT_ID} contract not found; loaded ids: [${ids}]`);
  }
  doc = found.document as OpenApiDocument;

  otherContracts = [
    ...loadOpenApiContracts(),
    ...subDirs()
      .filter((sub) => sub !== "settlement")
      .flatMap((sub) => loadOpenApiContracts({ dir: resolve(CONTRACTS_ROOT, sub) })),
  ].map((c) => c.document as OpenApiDocument);
});

function operations(source: OpenApiDocument = doc): Array<{ path: string; method: string; op: OperationObject }> {
  const out: Array<{ path: string; method: string; op: OperationObject }> = [];
  for (const [path, item] of Object.entries(source.paths ?? {})) {
    for (const [method, op] of Object.entries(item)) {
      if (op && typeof op === "object" && "operationId" in op) out.push({ path, method, op });
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
// 1. Loadability + version
// ===========================================================================
describe("settlement.yaml — loadability and version", () => {
  it("is parseable by the production OpenAPI loader and declares OpenAPI 3.1", () => {
    expect(typeof doc).toBe("object");
    expect(doc.openapi).toBe("3.1.0");
  });

  it("is the RT-417 2.0.0 major, replacing the stale 1.0.0-draft, citing the [GATED] approval", () => {
    expect(doc.info?.version).toBe("2.0.0");
    const info = doc.info?.description ?? "";
    expect(info).toContain("RT-417 (2.0.0; [GATED] approval Jira RT-417 comment 11671");
    expect(info).toContain("replacing the stale `1.0.0-draft`");
    expect(info).toContain("owner decision R-1");
  });
});

// ===========================================================================
// 2. Operation set — exactly the payer facade
// ===========================================================================
describe("settlement.yaml — operations (RT-417)", () => {
  it("declares exactly the two payer-account operations at their paths", () => {
    const declared = operations().map(({ path, method, op }) => `${op.operationId} ${method} ${path}`);
    const expected = Object.entries(KEPT_OPERATIONS).map(
      ([id, { path, method }]) => `${id} ${method} ${path}`,
    );
    expect(declared.sort()).toEqual(expected.sort());
  });

  it("keeps both payer routes contract-only, with a note naming RT-418", () => {
    for (const id of Object.keys(KEPT_OPERATIONS)) {
      const op = findOp(id);
      expect(op?.["x-runtime-status"]).toBe("contract-only");
      expect(op?.["x-runtime-note"] ?? "").toContain("RT-418");
    }
  });

  it("guards both routes with cookieAuth only (no POS envelope on this surface)", () => {
    for (const id of Object.keys(KEPT_OPERATIONS)) {
      expect(findOp(id)?.security).toEqual([{ cookieAuth: [] }]);
    }
    expect(Object.keys(doc.components?.securitySchemes ?? {})).toEqual(["cookieAuth"]);
    expect(doc.security).toBeUndefined();
  });

  it("requires an Idempotency-Key on create", () => {
    expect(findOp("consoleCreatePayerAccount")?.["x-idempotency"]).toBe("required");
  });

  it("operationIds do not collide with any other contract", () => {
    const elsewhere = new Set(otherContracts.flatMap((d) => operations(d).map((o) => o.op.operationId)));
    for (const id of Object.keys(KEPT_OPERATIONS)) {
      expect(elsewhere.has(id)).toBe(false);
    }
  });
});

// ===========================================================================
// 3. Retired operations — removed consistently (runtime removal in RT-422)
// ===========================================================================
describe("settlement.yaml — retired operations (RT-417 → RT-422)", () => {
  it("no retired operationId or route is declared in this contract", () => {
    const ids = operations().map((o) => o.op.operationId);
    const routes = operations().map(({ path, method }) => `${method.toUpperCase()} ${path}`);
    for (const [id, route] of Object.entries(RETIRED_OPERATIONS)) {
      expect(ids).not.toContain(id);
      expect(routes).not.toContain(route);
    }
  });

  it("no other contract re-declares a retired operation", () => {
    const elsewhere = otherContracts.flatMap((d) => operations(d).map((o) => o.op.operationId));
    for (const id of Object.keys(RETIRED_OPERATIONS)) {
      expect(elsewhere).not.toContain(id);
    }
  });

  it("lists every retired operation with its route and the RT-422 runtime removal", () => {
    const retired = doc["x-retired-operations"] ?? [];
    expect(
      retired.map((r) => `${r.operationId} ${r.route} ${r.removedRuntimeIn}`).sort(),
    ).toEqual(
      Object.entries(RETIRED_OPERATIONS)
        .map(([id, route]) => `${id} ${route} RT-422`)
        .sort(),
    );
  });

  it("drops the receivable / claim / remittance / intent schemas and the POS-only components", () => {
    for (const name of RETIRED_SCHEMAS) {
      expect(schema(name)).toBeUndefined();
    }
    expect(doc.components?.responses?.["TooManyRequests"]).toBeUndefined();
    for (const name of ["ReceivableRef", "ClaimRef", "ReceivableCursor", "ReceivableStateQuery"]) {
      expect(doc.components?.parameters?.[name]).toBeUndefined();
    }
  });

  it("documents that the runtime still serves the retired routes until RT-422", () => {
    const info = doc.info?.description ?? "";
    expect(info).toContain("still served by");
    expect(info).toContain("until RT-422 deletes them");
  });
});

// ===========================================================================
// 4. Payer DTO + projection
// ===========================================================================
describe("settlement.yaml — payer account shapes", () => {
  it("the create DTO is strict, without creditTerms or server-resolved keys", () => {
    const create = schema("PayerAccountCreate");
    expect(create?.additionalProperties).toBe(false);
    expect(create?.required?.slice().sort()).toEqual(["category", "displayName"]);
    expect(Object.keys(create?.properties ?? {}).sort()).toEqual(
      ["category", "displayName", "externalRef", "storeId"],
    );
    for (const forbidden of ["creditTerms", "credit_terms", "tenant_id", "tenantId", "created_by"]) {
      expect(create?.properties?.[forbidden]).toBeUndefined();
    }
  });

  it("externalRef is the payer's ERPNext Customer link, failing closed when absent", () => {
    const text = (schema("PayerAccountCreate")?.properties?.["externalRef"]?.description ?? "").replace(/\s+/g, " ");
    expect(text).toContain("ERPNext Customer link");
    expect(text).toContain("fails closed");
    expect(text).toContain("never falls back to the store's Customer");
  });

  it("a non-null externalRef must be nonblank (Codex #779: a blank link would dead-letter at posting)", () => {
    const ref = schema("PayerAccountCreate")?.properties?.["externalRef"] as
      | { type?: unknown; minLength?: number; pattern?: string; description?: string }
      | undefined;
    expect(ref?.type).toEqual(["string", "null"]);
    expect(ref?.minLength).toBe(1);
    const nonblank = new RegExp(ref?.pattern ?? "$^");
    for (const ok of ["CUST-0001", "Acme Insurance", "x"]) expect({ ok, m: nonblank.test(ok) }).toEqual({ ok, m: true });
    for (const bad of ["", " ", "   ", "\t", " \n "]) expect({ bad, m: nonblank.test(bad) }).toEqual({ bad, m: false });
    expect((ref?.description ?? "").replace(/\s+/g, " ")).toContain("blank or whitespace-only value is a 400");
  });

  it("the projection is strict, camelCase, with no tenant_id or credit terms (§IV)", () => {
    const payer = schema("PayerAccount");
    expect(payer?.additionalProperties).toBe(false);
    expect(Object.keys(payer?.properties ?? {}).sort()).toEqual(
      ["category", "displayName", "externalRef", "payerRef", "status", "storeId", "version"],
    );
    expect(payer?.required?.slice().sort()).toEqual(
      ["category", "displayName", "payerRef", "status", "version"],
    );
  });

  it("the payer page is bounded and keyset-paginated", () => {
    const page = schema("PayerAccountPage");
    expect(page?.additionalProperties).toBe(false);
    expect(page?.required?.slice().sort()).toEqual(["items", "nextCursor"]);
  });

  it("Error is the canonical envelope { error: { code, message, request_id? } }", () => {
    expect(schema("Error")?.required).toEqual(["error"]);
  });
});
