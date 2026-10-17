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
 *   - cookieAuth on both routes, implemented (RT-418 removed `contract-only`);
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

/** RT-572 (2.1.0): the payer repair route, contract-only until the RT-572 runtime PR. */
const UPDATE_OPERATION = {
  consoleUpdatePayerAccount: { path: "/api/v1/settlement/payer-accounts/{payerRef}", method: "patch" },
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

  it("is the RT-572 2.1.0 additive minor on the RT-417 2.0.0 major, citing the [GATED] approval", () => {
    expect(doc.info?.version).toBe("2.1.0");
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
  it("declares exactly the three payer-account operations at their paths", () => {
    const declared = operations().map(({ path, method, op }) => `${op.operationId} ${method} ${path}`);
    const expected = Object.entries({ ...KEPT_OPERATIONS, ...UPDATE_OPERATION }).map(
      ([id, { path, method }]) => `${id} ${method} ${path}`,
    );
    expect(declared.sort()).toEqual(expected.sort());
  });

  it("marks neither payer route contract-only: the RT-418 runtime serves both", () => {
    for (const id of Object.keys(KEPT_OPERATIONS)) {
      const op = findOp(id);
      expect(op?.["x-runtime-status"]).toBeUndefined();
      expect(op?.["x-runtime-note"]).toBeUndefined();
    }
  });

  it("guards every route with cookieAuth only (no POS envelope on this surface)", () => {
    for (const id of [...Object.keys(KEPT_OPERATIONS), ...Object.keys(UPDATE_OPERATION)]) {
      expect(findOp(id)?.security).toEqual([{ cookieAuth: [] }]);
    }
    expect(Object.keys(doc.components?.securitySchemes ?? {})).toEqual(["cookieAuth"]);
    expect(doc.security).toBeUndefined();
  });

  it("create declares the non-disclosing 404 for an out-of-scope storeId (CodeRabbit #779)", () => {
    const responses = (findOp("consoleCreatePayerAccount")?.responses ?? {}) as Record<string, { $ref?: string }>;
    expect(responses["404"]?.$ref).toBe("#/components/responses/NotFound");
    const notFound = (doc.components?.responses?.["NotFound"] ?? {}) as { description?: string };
    expect((notFound.description ?? "").replace(/\s+/g, " ")).toContain("out-of-scope `storeId`");
    expect((doc.info?.description ?? "").replace(/\s+/g, " ")).toContain("404 not-found (non-disclosing)");
  });

  it("the list excludes store-scoped payers outside the caller's store access (review #779)", () => {
    const list = findOp("consoleListPayerAccounts") as { description?: string } | undefined;
    expect((list?.description ?? "").replace(/\s+/g, " ")).toContain(
      "store-scoped payers outside the caller's store access are excluded",
    );
  });

  it("requires an Idempotency-Key on create", () => {
    expect(findOp("consoleCreatePayerAccount")?.["x-idempotency"]).toBe("required");
  });

  it("operationIds do not collide with any other contract", () => {
    const elsewhere = new Set(otherContracts.flatMap((d) => operations(d).map((o) => o.op.operationId)));
    for (const id of [...Object.keys(KEPT_OPERATIONS), ...Object.keys(UPDATE_OPERATION)]) {
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

// ===========================================================================
// 5. RT-572 — consoleUpdatePayerAccount (2.1.0, additive, contract-only)
// ===========================================================================
describe("settlement.yaml — consoleUpdatePayerAccount (RT-572)", () => {
  interface UpdateOperation extends OperationObject {
    description?: string;
    parameters?: Array<{ $ref?: string; name?: string; in?: string; required?: boolean }>;
    requestBody?: { required?: boolean; content?: Record<string, { schema?: { $ref?: string } }> };
  }

  const flat = (text: string | undefined): string => (text ?? "").replace(/\s+/g, " ");
  const update = (): UpdateOperation | undefined => findOp("consoleUpdatePayerAccount") as UpdateOperation | undefined;
  const expectAll = (text: string, parts: string[]): void => {
    for (const part of parts) expect(text).toContain(part);
  };

  type UpdateProperty = {
    type?: unknown;
    enum?: string[];
    minLength?: number;
    maxLength?: number;
    minimum?: number;
    pattern?: string;
    description?: string;
  };
  const updateSchema = () =>
    schema("PayerAccountUpdate") as
      | (SchemaObject & { anyOf?: Array<{ required?: string[] }>; properties?: Record<string, UpdateProperty> })
      | undefined;

  it("is a contract-only PATCH on the payer, with a runtime note naming the RT-572 runtime", () => {
    expect(update()?.["x-runtime-status"]).toBe("contract-only");
    const note = flat(update()?.["x-runtime-note"]);
    expect(note).toContain("RT-572 runtime");
    // M1: a malformed payerRef is a 400, never a pg 22P02 -> 500
    expect(note).toContain("validate `payerRef` as a uuid before any SQL cast");
    expect(note).toContain("22P02");
    // M3: the audit row is written in the update's transaction, not by @Auditable alone
    expectAll(note, ["same transaction", "insertSettlementAudit", "tenant-level"]);
  });

  it("requires an Idempotency-Key and addresses the payer by a uuid path parameter", () => {
    expect(update()?.["x-idempotency"]).toBe("required");
    const refs = (update()?.parameters ?? []).map((p) => p.$ref);
    expect(refs).toContain("#/components/parameters/IdempotencyKey");
    expect(refs).toContain("#/components/parameters/PayerRef");
    const payerRef = doc.components?.parameters?.["PayerRef"] as
      | { in?: string; required?: boolean; schema?: { format?: string } }
      | undefined;
    expect(payerRef?.in).toBe("path");
    expect(payerRef?.required).toBe(true);
    expect(payerRef?.schema?.format).toBe("uuid");
  });

  it("takes the strict PayerAccountUpdate body and returns the PayerAccount projection on 200", () => {
    const body = update()?.requestBody;
    expect(body?.required).toBe(true);
    expect(body?.content?.["application/json"]?.schema?.$ref).toBe("#/components/schemas/PayerAccountUpdate");
    const ok = (update()?.responses ?? {})["200"] as { content?: Record<string, { schema?: { $ref?: string } }> };
    expect(ok?.content?.["application/json"]?.schema?.$ref).toBe("#/components/schemas/PayerAccount");
  });

  it("declares 400/401/403/404/409/500 and no 201", () => {
    const codes = Object.keys(update()?.responses ?? {}).sort();
    expect(codes).toEqual(["200", "400", "401", "403", "404", "409", "500"]);
    const refs = update()?.responses as Record<string, { $ref?: string }>;
    expect(refs["403"]?.$ref).toBe("#/components/responses/ForbiddenOrOriginRejected");
    expect(refs["404"]?.$ref).toBe("#/components/responses/PayerNotFound");
    expect(refs["409"]?.$ref).toBe("#/components/responses/PayerUpdateConflict");
  });

  it("409 names payer_version_conflict (stale expectedVersion) and idempotency_key_conflict", () => {
    const conflict = (doc.components?.responses?.["PayerUpdateConflict"] ?? {}) as { description?: string };
    const text = flat(conflict.description);
    expectAll(text, ["payer_version_conflict", "idempotency_key_conflict", "expectedVersion"]);
  });

  it("404 is non-disclosing for an unknown, other-tenant or out-of-store-scope payer", () => {
    const notFound = (doc.components?.responses?.["PayerNotFound"] ?? {}) as { description?: string };
    const text = flat(notFound.description);
    expect(text.toLowerCase()).toContain("non-disclosing");
    expect(text).toContain("another tenant");
    expect(text).toContain("outside the caller's store access");
  });

  it("the body is strict, needs expectedVersion plus at least one changed field, and is the minimal field set", () => {
    const body = updateSchema();
    expect(body?.additionalProperties).toBe(false);
    expect(body?.required).toEqual(["expectedVersion"]);
    expect(Object.keys(body?.properties ?? {}).sort()).toEqual(["displayName", "expectedVersion", "externalRef", "status"]);
    expect((body?.anyOf ?? []).map((a) => a.required?.join(",")).sort()).toEqual(["displayName", "externalRef", "status"]);
    for (const immutable of ["category", "storeId", "payerRef", "tenant_id", "tenantId", "version", "creditTerms"]) {
      expect(body?.properties?.[immutable]).toBeUndefined();
    }
  });

  it("expectedVersion is the payer's existing version, bounded to int4 (M1), not a new column", () => {
    const expected = updateSchema()?.properties?.["expectedVersion"];
    expect(expected?.type).toBe("integer");
    expect(expected?.minimum).toBe(0);
    expect(expected?.maximum).toBe(2147483647);
    expect(flat(expected?.description)).toContain("PayerAccount.version");
  });

  it("status is the active / suspended vocabulary, and says what suspension also does (RT-577 D12)", () => {
    const status = updateSchema()?.properties?.["status"];
    expect(status?.enum).toEqual(["active", "suspended"]);
    const text = flat(status?.description);
    expectAll(text, ["credit_reversal_settlement_unavailable", "RT-577", "postings are unaffected"]);
  });

  it("displayName rejects blank, whitespace-only and NUL text at the schema (400, never 5xx)", () => {
    const prop = updateSchema()?.properties?.["displayName"];
    expect(prop?.type).toBe("string");
    expect(prop?.minLength).toBe(1);
    expect(prop?.maxLength).toBe(200);
    expect(prop?.pattern).toBe(String.raw`^\s*[^\s\u0000][^\u0000]*$`);
    const accepts = new RegExp(prop?.pattern ?? "$^");
    for (const ok of ["Acme Insurance", "x", " padded ", "a\nb"]) {
      expect({ ok, m: accepts.test(ok) }).toEqual({ ok, m: true });
    }
    for (const bad of ["", " ", "   ", "\t", " \n ", "a\u0000b", "\u0000", " \u0000 "]) {
      expect({ bad, m: accepts.test(bad) }).toEqual({ bad, m: false });
    }
  });

  it("externalRef is an identifier (M5): no surrounding whitespace, no control characters, no NUL, 1..140", () => {
    const prop = updateSchema()?.properties?.["externalRef"];
    expect(prop?.type).toBe("string"); // cannot be cleared: no null
    expect(prop?.minLength).toBe(1);
    expect(prop?.maxLength).toBe(140); // Frappe document names are at most 140 characters
    expect(prop?.pattern).toBe(
      String.raw`^[^\s\u0000-\u001f\u007f-\u009f](?:[^\u0000-\u001f\u007f-\u009f]*[^\s\u0000-\u001f\u007f-\u009f])?$`,
    );
    const accepts = new RegExp(prop?.pattern ?? "$^");
    for (const ok of ["CUST-0001", "Acme Insurance", "x", "a b", "ab"]) {
      expect({ ok, m: accepts.test(ok) }).toEqual({ ok, m: true });
    }
    const bad = [
      "", " ", "   ", "\t", " padded", "padded ", " padded ", "a\nb", "a\tb", "a\r", "a\u0000b", "\u0000",
      " \u0000 ", "a\u007fb", "a\u0085b", " x", "x ",
    ];
    for (const value of bad) {
      expect({ value, m: accepts.test(value) }).toEqual({ value, m: false });
    }
  });

  it("the text patterns are linear and pinned: long NUL / whitespace inputs are refused fast (Gitar #804)", () => {
    // The patterns are pinned above, so a rewrite into a backtracking form fails those tests first. The
    // timing is a coarse backstop with a very generous margin: a quadratic form takes minutes at 200k.
    const long = 200_000;
    const inputs: Array<[string, string, boolean]> = [
      ["displayName", "a".repeat(long) + "\u0000", false],
      ["displayName", "\u0000" + "a".repeat(long), false],
      ["displayName", " ".repeat(long) + "\u0000", false],
      ["displayName", " ".repeat(long) + "x" + "y".repeat(long), true],
      ["externalRef", "a".repeat(long) + "\u0000", false],
      ["externalRef", "a".repeat(long) + " ", false],
      ["externalRef", "a ".repeat(long / 2) + "\n", false],
      ["externalRef", " ".repeat(long) + "x", false],
    ];
    for (const [field, value, expected] of inputs) {
      const re = new RegExp(updateSchema()?.properties?.[field]?.pattern ?? "$^");
      const start = Date.now();
      expect({ field, m: re.test(value) }).toEqual({ field, m: expected });
      expect(Date.now() - start).toBeLessThan(3000);
    }
  });

  it("states that a changed externalRef never touches already-frozen postings (RT-332), except an operator re-resolution", () => {
    const text = flat(update()?.description);
    expectAll(text, ["RT-332", "frozen", "payerExternalRef", "only by resolutions frozen after", "freezeOperatorResolution", "re-reads the live"]);
    expect(flat(updateSchema()?.properties?.["externalRef"]?.description)).toContain("already-frozen");
  });

  it("documents the version bump, the no-op, the same-transaction audit with both externalRef values, and the role gate", () => {
    const text = flat(update()?.description);
    expectAll(text, ["version + 1", "no-op", "settlement.payer_account.updated", "owner / tenant_admin", "changedFields", "externalRefFrom", "externalRefTo", "same transaction as the update", "not emitted for a no-op", "never records the displayName"]);
    expect(text).not.toContain("never records the displayName or externalRef text");
  });

  it("suspension also fails credit reversals closed under RT-577 D12, and leaves postings alone", () => {
    const text = flat(update()?.description);
    expectAll(text, ["credit_reversal_settlement_unavailable", "RT-577", "fail closed"]);
    expect(text).not.toContain("Already-captured sales are unaffected");
  });

  it("a status or externalRef change on a tenant-wide payer needs tenant-wide store scope, else the same 404 (M4)", () => {
    const text = flat(update()?.description);
    expect(text).toContain("status` or `externalRef` of a tenant-wide payer");
    expect(text).toContain("tenant-wide store scope");
    const notFound = (doc.components?.responses?.["PayerNotFound"] ?? {}) as { description?: string };
    expect(flat(notFound.description)).toContain("tenant-wide payer");
  });

  it("the 2.1.0 changelog in info records the decisions, with the D12 reason for immutable storeId", () => {
    const info = flat(doc.info?.description);
    expectAll(info, ["RT-572 (2.1.0", "additive", "`consoleUpdatePayerAccount`", "scoped to another store", "RT-577 D12", "externalRefFrom"]);
  });
});
