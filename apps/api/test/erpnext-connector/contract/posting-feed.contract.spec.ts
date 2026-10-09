/**
 * apps/api/test/erpnext-connector/contract/posting-feed.contract.spec.ts
 *
 * Slice 012-CONTRACT — OpenAPI conformance test for
 * `packages/contracts/openapi/erpnext-connector/posting-feed.yaml`.
 *
 * Mirrors `apps/api/test/catalog/read-down/contract/read-down.contract.spec.ts`
 * and `.../catalog/sales/contract/sales.contract.spec.ts`:
 *
 *   * Loads the new contract via the production `loadOpenApiContracts` helper
 *     with an explicit `dir`, because the helper's directory scan is
 *     non-recursive (`apps/api/src/openapi/loader.ts` — `readdirSync(dir)` with
 *     no recursive flag). The nested `erpnext-connector/` sub-directory is NOT
 *     picked up by the umbrella `loadOpenApiContracts()` call, so it loads here
 *     explicitly (same pattern as catalog/ + pos-sales/).
 *
 *   * Asserts presence of the two 012 operationIds (`connectorPullPostings`,
 *     `connectorAckOutcome`) and their UNIQUENESS against every shipped
 *     operationId — the top-level contracts PLUS every nested sub-dir
 *     (catalog/, pos-sales/, inventory/, pos-payments/), because the umbrella
 *     `loadOpenApiContracts()` is non-recursive and misses ALL of them (the
 *     slice's stop condition is "if any operationId collides with or renames a
 *     shipped operationId").
 *
 *   * Verifies the 012-specific contract conventions: OpenAPI 3.1 of record; the
 *     `connectorBearer` MACHINE security scheme defined + referenced on both ops
 *     (NOT the POS `clerkJwt` — this is a service principal, 011 version-pin /
 *     connector-lifecycle §2); the pull/feed cursor + `next_page_token`; the
 *     bidirectional shape (GET pull + POST ack, NOT read-only); the mirrored 008
 *     decimal-money `DecimalAmount`/`CurrencyCode` (no float); the strict
 *     `additionalProperties: false` projections (§XII); the REQUIRED
 *     `Idempotency-Key` on the ack (O-3); and the closed error set incl.
 *     `snapshot_required` riding the canonical `Error` envelope.
 *
 * The spec is structural / load-only (no app boot, no HTTP requests, no Docker).
 * The DP2-side feed/ack endpoints are authored in a future slice (015 +
 * connector-feed); the connector itself lives in the Retail-Tower-ERP-Next-Connector
 * repo (ADR 0008).
 */
import "reflect-metadata";

import { resolve } from "node:path";

import { loadOpenApiContracts } from "../../../src/openapi/loader";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NEW_CONTRACT_ID = "posting-feed";

const OPERATION_IDS = ["connectorPullPostings", "connectorAckOutcome"] as const;

const PULL_PATH = "/api/connector/v1/erpnext/postings";
const ACK_PATH = "/api/connector/v1/erpnext/postings/{workItemRef}/outcome";

/**
 * Resolve a `packages/contracts/openapi/<sub>` directory from this spec's
 * location:
 *   apps/api/test/erpnext-connector/contract/posting-feed.contract.spec.ts
 *   →  ../../../../..   = <repo root>
 *   (contract → erpnext-connector → test → api → apps → <root>)
 */
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

// ---------------------------------------------------------------------------
// Shared types — keep narrow; the loader returns `unknown` documents.
// ---------------------------------------------------------------------------

interface OperationObject {
  operationId?: string;
  security?: Array<Record<string, unknown>>;
  requestBody?: unknown;
  parameters?: Array<{
    $ref?: string;
    in?: string;
    name?: string;
    required?: boolean;
    schema?: Record<string, unknown>;
  }>;
  responses?: Record<string, unknown>;
}

type PathItem = Record<string, OperationObject>;

interface SchemaObject {
  type?: string | string[];
  additionalProperties?: boolean | Record<string, unknown>;
  required?: string[];
  properties?: Record<string, unknown>;
}

interface OpenApiDocument {
  openapi?: string;
  info?: { title?: string; version?: string; description?: string };
  paths?: Record<string, PathItem>;
  components?: {
    schemas?: Record<string, SchemaObject>;
    securitySchemes?: Record<string, Record<string, unknown>>;
    parameters?: Record<string, Record<string, unknown>>;
    responses?: Record<string, Record<string, unknown>>;
  };
  security?: Array<Record<string, unknown>>;
  tags?: Array<{ name?: string }>;
}

let feedDoc: OpenApiDocument;
let shippedOperationIds: Set<string>;

function collectOperationIds(docs: OpenApiDocument[], into: Set<string>): void {
  for (const doc of docs) {
    if (!doc.paths) continue;
    for (const path of Object.values(doc.paths)) {
      for (const op of Object.values(path)) {
        if (op && typeof op.operationId === "string") into.add(op.operationId);
      }
    }
  }
}

beforeAll(() => {
  const connectorContracts = loadOpenApiContracts({
    dir: openapiSubDir("erpnext-connector"),
  });
  const newContract = connectorContracts.find((c) => c.id === NEW_CONTRACT_ID);
  if (!newContract) {
    const ids = connectorContracts.map((c) => c.id).join(", ");
    throw new Error(
      `${NEW_CONTRACT_ID} contract not found under ${openapiSubDir("erpnext-connector")}; loaded ids: [${ids}]`,
    );
  }
  feedDoc = newContract.document as OpenApiDocument;

  // Build the set of SHIPPED operationIds the new ops must not collide with:
  // the top-level contracts PLUS the nested catalog/ + pos-sales/ siblings
  // (the umbrella loader is non-recursive). Exclude the new contract itself.
  shippedOperationIds = new Set<string>();
  collectOperationIds(
    loadOpenApiContracts().map((c) => c.document as OpenApiDocument),
    shippedOperationIds,
  );
  // Every nested contract dir — the non-recursive umbrella loader misses ALL of
  // them, so each must be loaded explicitly for a TRUE global-uniqueness guard.
  for (const sub of ["catalog", "pos-sales", "inventory", "pos-payments"]) {
    collectOperationIds(
      loadOpenApiContracts({ dir: openapiSubDir(sub) }).map(
        (c) => c.document as OpenApiDocument,
      ),
      shippedOperationIds,
    );
  }
});

function feedOperations(): Array<{
  path: string;
  method: string;
  op: OperationObject;
}> {
  const out: Array<{ path: string; method: string; op: OperationObject }> = [];
  for (const [path, item] of Object.entries(feedDoc.paths ?? {})) {
    for (const [method, op] of Object.entries(item)) {
      out.push({ path, method, op });
    }
  }
  return out;
}

function findOp(operationId: string): OperationObject | undefined {
  return feedOperations().find((o) => o.op.operationId === operationId)?.op;
}

// ===========================================================================
// 1. Loadability + document-level conventions
// ===========================================================================
describe("erpnext-connector/posting-feed.yaml — loadability", () => {
  it("is parseable by the production OpenAPI loader", () => {
    expect(feedDoc).toBeDefined();
    expect(typeof feedDoc).toBe("object");
  });

  it("declares OpenAPI 3.1 of record", () => {
    expect(feedDoc.openapi).toBe("3.1.0");
  });

  it("declares an info block with title and a *-draft version", () => {
    expect(feedDoc.info?.title).toEqual(expect.any(String));
    expect(feedDoc.info?.version).toEqual(expect.stringMatching(/-draft$/));
  });

  it("declares the connectorBearer MACHINE scheme — NOT the POS clerkJwt", () => {
    const schemes = feedDoc.components?.securitySchemes ?? {};
    expect(schemes["connectorBearer"]).toBeDefined();
    // The connector is a service principal, not a POS device — clerkJwt MUST NOT
    // appear on this surface (advisor design sign-off).
    expect(schemes["clerkJwt"]).toBeUndefined();
    const cb = schemes["connectorBearer"] as { type?: string; scheme?: string };
    expect(cb.type).toBe("http");
    expect(cb.scheme).toBe("bearer");
  });
});

// ===========================================================================
// 2. Operations present, uniquely named, machine-secured, bidirectional
// ===========================================================================
describe("erpnext-connector/posting-feed.yaml — operations", () => {
  it("declares exactly the two 012 operationIds", () => {
    const ids = feedOperations()
      .map((o) => o.op.operationId)
      .filter((id): id is string => typeof id === "string")
      .sort();
    expect(ids).toEqual([...OPERATION_IDS].sort());
  });

  it("maps the pull to GET and the ack to POST (bidirectional, NOT read-only)", () => {
    expect(feedDoc.paths?.[PULL_PATH]?.["get"]?.operationId).toBe(
      "connectorPullPostings",
    );
    expect(feedDoc.paths?.[ACK_PATH]?.["post"]?.operationId).toBe(
      "connectorAckOutcome",
    );
  });

  it("does NOT collide with or rename any shipped operationId (top-level + catalog/ + pos-sales/)", () => {
    for (const id of OPERATION_IDS) {
      expect(shippedOperationIds.has(id)).toBe(false);
    }
  });

  it("uses a connector (machine) path namespace, NOT the POS namespace", () => {
    for (const { path } of feedOperations()) {
      expect(path.startsWith("/api/connector/v1/erpnext/")).toBe(true);
      expect(path.startsWith("/api/pos/")).toBe(false);
    }
  });

  it("secures every operation with connectorBearer (machine principal)", () => {
    for (const { op } of feedOperations()) {
      expect(op.security).toContainEqual({ connectorBearer: [] });
      expect(op.security).not.toContainEqual({ clerkJwt: [] });
    }
  });
});

// ===========================================================================
// 3. Pull feed — cursor + pagination (mirrors 010 delta)
// ===========================================================================
describe("erpnext-connector/posting-feed.yaml — pull feed cursor", () => {
  it("the pull accepts an OPTIONAL opaque `since` cursor (omit = re-baseline)", () => {
    const params = findOp("connectorPullPostings")?.parameters ?? [];
    expect(params.some((p) => p.$ref === "#/components/parameters/Since")).toBe(
      true,
    );
    const since = feedDoc.components?.parameters?.["Since"] as
      | { name?: string; in?: string; required?: boolean }
      | undefined;
    expect(since?.name).toBe("since");
    expect(since?.in).toBe("query");
    // OPTIONAL — unlike 010's required `since`, omitting it pulls from the start.
    expect(since?.required).not.toBe(true);
  });

  it("the feed page carries `next_page_token` + advanced `cursor` (opaque)", () => {
    const page = feedDoc.components?.schemas?.["PostingFeedPage"];
    expect(page?.properties).toHaveProperty("next_page_token");
    expect(page?.required).toContain("next_page_token");
    expect(page?.properties).toHaveProperty("cursor");
    expect(page?.required).toContain("cursor");
  });

  it("the work-item carries the opaque per-item `itemCursor`", () => {
    const item = feedDoc.components?.schemas?.["PostingWorkItem"];
    expect(item?.properties).toHaveProperty("itemCursor");
    expect(item?.required).toContain("itemCursor");
  });
});

// ===========================================================================
// 4. Work-item payload — O-1 (mirrors 008 sale) + O-4 reversal
// ===========================================================================
describe("erpnext-connector/posting-feed.yaml — work-item payload (O-1/O-4)", () => {
  it("the work-item carries provenance + businessDate (O-1)", () => {
    const item = feedDoc.components?.schemas?.["PostingWorkItem"];
    expect(item?.additionalProperties).toBe(false);
    expect(item?.required).toEqual(
      expect.arrayContaining([
        "workItemRef",
        "kind",
        "sourceSystem",
        "externalId",
        "payloadHash",
        "businessDate",
        "sale",
      ]),
    );
  });

  it("kind enumerates sale_post | reversal (O-4 reversal as a work-item)", () => {
    const kind = (feedDoc.components?.schemas?.["PostingWorkItem"]?.properties ??
      {})["kind"] as { enum?: string[] } | undefined;
    expect(kind?.enum?.sort()).toEqual(["reversal", "sale_post"].sort());
  });

  it("mirrors the 008 Sale projection with decimal money (no float)", () => {
    const sale = feedDoc.components?.schemas?.["Sale"];
    expect(sale?.additionalProperties).toBe(false);
    expect(sale?.required).toEqual(
      expect.arrayContaining([
        "saleRef",
        "storeId",
        "currencyCode",
        "posTotal",
        "businessDate",
        "lines",
      ]),
    );
    const amount = feedDoc.components?.schemas?.["DecimalAmount"] as
      | { type?: string; pattern?: string }
      | undefined;
    expect(amount?.type).toBe("string");
    expect(amount?.pattern).toBeDefined();
  });

  // 012-EXT: DP2-resolved ERPNext Item identity per line (011 posting rider R2/R3/R4).
  it("requires a DP2-resolved erpnextItemRef on every offered SaleLine (R2)", () => {
    const line = feedDoc.components?.schemas?.["SaleLine"];
    expect(line?.additionalProperties).toBe(false);
    expect(line?.required).toEqual(expect.arrayContaining(["erpnextItemRef"]));
    const ref = (line?.properties ?? {})["erpnextItemRef"] as
      | { $ref?: string }
      | undefined;
    expect(ref?.$ref).toBe("#/components/schemas/ErpnextItemRef");
  });

  it("erpnextItemRef is generic {doctype:'Item', name} addressing (O-6), NOT a connector lookup", () => {
    const itemRef = feedDoc.components?.schemas?.["ErpnextItemRef"];
    expect(itemRef?.additionalProperties).toBe(false);
    expect(itemRef?.required?.sort()).toEqual(["doctype", "name"].sort());
    const props = itemRef?.properties ?? {};
    expect((props["doctype"] as { const?: string })?.const).toBe("Item");
    // name = the 013 erpnext_item_ref opaque string (maxLength 140).
    expect((props["name"] as { maxLength?: number })?.maxLength).toBe(140);
  });

  it("keeps tenantProductRef nullable lineage only — NO Misc fallback, NO lineType (R3/R4)", () => {
    const props = feedDoc.components?.schemas?.["SaleLine"]?.properties ?? {};
    // tenantProductRef stays nullable (008 FR-004 ad-hoc lineage), not required.
    const tpr = props["tenantProductRef"] as { anyOf?: Array<{ type?: string }> };
    expect(tpr?.anyOf).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "null" })]),
    );
    expect(feedDoc.components?.schemas?.["SaleLine"]?.required).not.toEqual(
      expect.arrayContaining(["tenantProductRef"]),
    );
    // An ad-hoc line DLQs before offer (R2); no substitute item (R3) -> no lineType discriminator.
    expect(props).not.toHaveProperty("lineType");
  });

  // RT-72: line-aware returns (RT-14 D1/D6/D7) + reversal event time (RT-63).
  it("reversalKind adds return; void + legacy refund stay readable", () => {
    const kind = (feedDoc.components?.schemas?.["ReversalRef"]?.properties ?? {})[
      "reversalKind"
    ] as { enum?: string[] } | undefined;
    expect(kind?.enum?.sort()).toEqual(["refund", "return", "void"]);
  });

  it("a reversal carries its own server event time + business date (RT-63 P1)", () => {
    const ref = feedDoc.components?.schemas?.["ReversalRef"];
    expect(ref?.additionalProperties).toBe(false);
    // RT-73 emits them: recordedAt for every kind; businessDate only where it
    // is persisted (void / return — a legacy refund has none, RT-63 P2).
    expect(ref?.required).toContain("recordedAt");
    expect(ref?.required).not.toContain("businessDate");
    const props = ref?.properties ?? {};
    expect((props["recordedAt"] as { format?: string })?.format).toBe("date-time");
    expect((props["businessDate"] as { format?: string })?.format).toBe("date");
  });

  it("a return reversal carries only the returned lines, as non-negative magnitudes (D1)", () => {
    const props = feedDoc.components?.schemas?.["ReversalRef"]?.properties ?? {};
    const lines = props["returnLines"] as { type?: string; items?: { $ref?: string } } | undefined;
    expect(lines?.type).toBe("array");
    expect(lines?.items?.$ref).toBe("#/components/schemas/ReturnLine");
    const line = feedDoc.components?.schemas?.["ReturnLine"];
    expect(line?.additionalProperties).toBe(false);
    expect(line?.required?.sort()).toEqual(["lineAmount", "lineRef", "quantity", "taxAmount"]);
    const amount = (line?.properties ?? {})["lineAmount"] as { $ref?: string } | undefined;
    expect(amount?.$ref).toBe("#/components/schemas/NonNegativeDecimalAmount");
  });

  it("returnLines is required for a return and forbidden on other kinds (schema-enforced)", () => {
    const ref = feedDoc.components?.schemas?.["ReversalRef"] as
      | { if?: unknown; then?: unknown; else?: unknown }
      | undefined;
    expect(ref?.if).toEqual({
      properties: { reversalKind: { const: "return" } },
      required: ["reversalKind"],
    });
    expect(ref?.then).toEqual({ required: ["returnLines"] });
    // RT-76: refundTenders (RT-10 D6) is also return-only.
    expect(ref?.else).toEqual({
      not: { anyOf: [{ required: ["returnLines"] }, { required: ["refundTenders"] }] },
    });
  });

  it("businessDate is required for void and return reversals (persisted, RT-63 P2)", () => {
    const ref = feedDoc.components?.schemas?.["ReversalRef"] as
      | { allOf?: Array<Record<string, unknown>> }
      | undefined;
    expect(ref?.allOf).toContainEqual({
      if: {
        properties: { reversalKind: { enum: ["void", "return"] } },
        required: ["reversalKind"],
      },
      then: { required: ["businessDate"] },
    });
  });

  it("every offered sale line carries its lineRef (D6 line mapping)", () => {
    const line = feedDoc.components?.schemas?.["SaleLine"];
    // Required: RT-73's projection emits it on every offered line.
    expect(line?.required).toContain("lineRef");
    expect(((line?.properties ?? {})["lineRef"] as { format?: string })?.format).toBe("uuid");
  });
});

// ===========================================================================
// 5. Outcome ack — O-2 (return path) + O-3 (idempotency)
// ===========================================================================
describe("erpnext-connector/posting-feed.yaml — outcome ack (O-2/O-3)", () => {
  it("the ack REQUIRES the Idempotency-Key header (O-3)", () => {
    const params = findOp("connectorAckOutcome")?.parameters ?? [];
    expect(
      params.some((p) => p.$ref === "#/components/parameters/IdempotencyKey"),
    ).toBe(true);
    const key = feedDoc.components?.parameters?.["IdempotencyKey"] as
      | { name?: string; in?: string; required?: boolean }
      | undefined;
    expect(key?.name).toBe("Idempotency-Key");
    expect(key?.in).toBe("header");
    expect(key?.required).toBe(true);
  });

  it("the ack carries a request body (write surface, unlike 010)", () => {
    expect(findOp("connectorAckOutcome")).toHaveProperty("requestBody");
    // The pull is read-only (no body).
    expect(findOp("connectorPullPostings")).not.toHaveProperty("requestBody");
  });

  it("the outcome enumerates posted | failed_transient | permanently_rejected | reconciliation_required (O-2, RT-332)", () => {
    const outcome = (feedDoc.components?.schemas?.["OutcomeAckRequest"]
      ?.properties ?? {})["outcome"] as { enum?: string[] } | undefined;
    expect(outcome?.enum?.sort()).toEqual(
      ["failed_transient", "permanently_rejected", "posted", "reconciliation_required"].sort(),
    );
  });

  it("the ack request + recorded outcome are strict projections (§XII)", () => {
    const req = feedDoc.components?.schemas?.["OutcomeAckRequest"];
    const res = feedDoc.components?.schemas?.["RecordedOutcome"];
    expect(req?.additionalProperties).toBe(false);
    expect(res?.additionalProperties).toBe(false);
  });

  it("carries the ETA status passthrough (016, nullable until live) — O-2", () => {
    const props =
      feedDoc.components?.schemas?.["OutcomeAckRequest"]?.properties ?? {};
    expect(props).toHaveProperty("etaStatus");
  });

  it("speaks generic ERPNext doc addressing (doctype+name), NOT field internals (O-6)", () => {
    const ref = feedDoc.components?.schemas?.["ErpnextDocumentRef"];
    expect(ref?.required).toEqual(expect.arrayContaining(["doctype", "name"]));
  });
});

// ===========================================================================
// 6. Error envelope + closed error set
// ===========================================================================
describe("erpnext-connector/posting-feed.yaml — error vocabulary", () => {
  it("defines the canonical Error envelope { error: { code, message } } (no details)", () => {
    const errorSchema = feedDoc.components?.schemas?.["Error"] as
      | {
          required?: string[];
          properties?: { error?: { properties?: Record<string, unknown> } };
        }
      | undefined;
    expect(errorSchema?.required).toContain("error");
    const inner = errorSchema?.properties?.error?.properties ?? {};
    expect(Object.keys(inner).sort()).toEqual(
      ["code", "message", "request_id"].sort(),
    );
    expect(inner).not.toHaveProperty("details");
  });

  it("declares the closed error-response set incl. snapshot_required + conflict", () => {
    const responses = feedDoc.components?.responses ?? {};
    for (const name of [
      "ValidationFailure",
      "Unauthorized",
      "NotFound",
      "Conflict",
      "SnapshotRequired",
      "SystemFailure",
    ]) {
      expect(responses[name]).toBeDefined();
    }
  });

  it("maps pull to 200/400/401/404/409/500 and ack to 200/201/400/401/404/409/500", () => {
    const pull = feedDoc.paths?.[PULL_PATH]?.["get"]?.responses ?? {};
    expect(Object.keys(pull)).toEqual(
      expect.arrayContaining(["200", "400", "401", "404", "409", "500"]),
    );
    const ack = feedDoc.paths?.[ACK_PATH]?.["post"]?.responses ?? {};
    expect(Object.keys(ack)).toEqual(
      expect.arrayContaining(["200", "201", "400", "401", "404", "409", "500"]),
    );
  });

  it("the 409 on the pull is snapshot_required (stale cursor re-baseline)", () => {
    const pull = feedDoc.paths?.[PULL_PATH]?.["get"]?.responses ?? {};
    const conflict = pull["409"] as { $ref?: string } | undefined;
    expect(conflict?.$ref).toBe("#/components/responses/SnapshotRequired");
  });

  it("the 409 on the ack is the idempotency-key conflict", () => {
    const ack = feedDoc.paths?.[ACK_PATH]?.["post"]?.responses ?? {};
    const conflict = ack["409"] as { $ref?: string } | undefined;
    expect(conflict?.$ref).toBe("#/components/responses/Conflict");
  });
});

// ===========================================================================
// 7. Object-safety invariants (§XII / §IV)
// ===========================================================================
describe("erpnext-connector/posting-feed.yaml — object safety", () => {
  it("all payload schemas are strict (additionalProperties: false)", () => {
    const schemas = feedDoc.components?.schemas ?? {};
    for (const name of [
      "PostingWorkItem",
      "ReversalRef",
      "Sale",
      "SaleLine",
      "PostingFeedPage",
      "OutcomeAckRequest",
      "ErpnextDocumentRef",
      "EtaStatus",
      "RejectionReason",
      "RecordedOutcome",
      "ReturnLine",
      "SaleTender",
      "RefundTender",
    ]) {
      expect(schemas[name]?.additionalProperties).toBe(false);
    }
  });

  it("the sale projection leaks no raw DB column / credential / tenant_id (§IV)", () => {
    const props = feedDoc.components?.schemas?.["Sale"]?.properties ?? {};
    for (const leak of [
      "tenant_id",
      "tenantId",
      "payload_hash",
      "payloadHash",
      "created_by",
      "createdBy",
      "processed_at",
    ]) {
      expect(props).not.toHaveProperty(leak);
    }
  });
});

// ===========================================================================
// 8. RT-76 — settlement on the feed (RT-10 D3(b)/D4/D6/D8)
// ===========================================================================
describe("erpnext-connector/posting-feed.yaml — RT-76 settlement", () => {
  function schema(name: string): SchemaObject | undefined {
    return feedDoc.components?.schemas?.[name];
  }
  function prop<T>(name: string, field: string): T | undefined {
    return (schema(name)?.properties ?? {})[field] as T | undefined;
  }
  type ArrayProp = { type?: string; items?: { $ref?: string } };

  it("the feed sale carries its tenders, OPTIONAL — absent or empty means tender-unknown (D4/D8)", () => {
    expect(schema("Sale")?.required).not.toContain("tenders");
    const tenders = prop<ArrayProp>("Sale", "tenders");
    expect(tenders?.type).toBe("array");
    expect(tenders?.items?.$ref).toBe("#/components/schemas/SaleTender");
  });

  it("a feed tender mirrors the capture tender: cash | card_external, no voucher (D2)", () => {
    expect(schema("SaleTender")?.required?.sort()).toEqual(["amount", "method"]);
    const method = prop<{ enum?: string[] }>("SaleTender", "method");
    expect(method?.enum?.slice().sort()).toEqual(["card_external", "cash"]);
    expect(prop<{ $ref?: string }>("SaleTender", "amount")?.$ref).toBe(
      "#/components/schemas/NonNegativeDecimalAmount",
    );
    expect(prop<{ pattern?: string }>("SaleTender", "reference")?.pattern).toBe("^[A-Z0-9]{1,6}$");
  });

  it("a return carries its refund tenders, cash-only and optional until emitted (D6)", () => {
    const refunds = prop<ArrayProp>("ReversalRef", "refundTenders");
    expect(refunds?.type).toBe("array");
    expect(refunds?.items?.$ref).toBe("#/components/schemas/RefundTender");
    expect(schema("ReversalRef")?.required).not.toContain("refundTenders");
    expect(prop<{ enum?: string[] }>("RefundTender", "method")?.enum).toEqual(["cash"]);
  });

  it("the schema itself forbids a reference on a cash tender (card-only)", () => {
    const tender = schema("SaleTender") as
      | (SchemaObject & { if?: unknown; then?: unknown })
      | undefined;
    expect(tender?.if).toEqual({ properties: { method: { const: "cash" } }, required: ["method"] });
    expect(tender?.then).toEqual({ not: { required: ["reference"] } });
  });

  it("orders the rollout Connector-first: no tender fields on the feed before settlement ships (review #645)", () => {
    // A pre-settlement Connector would post an unpaid invoice and ack `posted`,
    // which is terminal — a later Connector upgrade never settles that sale.
    const description = feedDoc.info?.description ?? "";
    expect(description).toContain("MUST NOT emit `sale.tenders` or `reversalOf.refundTenders`");
    expect(description).not.toContain("may emit them before the Connector ships");
    // Review #645: gating only the fields still posts a tender-bearing sale
    // unpaid (terminal). The work item must never be offered without them.
    expect(description).toContain(
      "MUST NOT offer a work item for a tender-bearing sale (or its return) without its tenders",
    );
    expect(description).not.toContain("may capture and store tenders (RT-77) before");
  });

  it("a return always pays out its refundTenders; only a void of a tender-unknown sale stays outstanding (D6, review #645)", () => {
    const description = feedDoc.info?.description ?? "";
    expect(description).toContain("a `return` ALWAYS pays out its `reversalOf.refundTenders`");
    expect(description).toContain("a `void` of a tender-unknown sale");
    expect(description).not.toContain("a tender-unknown sale's reversal stays");
  });

  it("fails closed when the tenders do not equal the invoice total built from the lines (review #645)", () => {
    const description = feedDoc.info?.description ?? "";
    expect(description).toContain("tender total differs from the document total");
    expect(description).toContain("`permanently_rejected` / `validation`");
  });

  it("reversal payouts are magnitudes the Connector negates (review #645)", () => {
    const description = feedDoc.info?.description ?? "";
    expect(description).toContain("non-negative MAGNITUDES that the Connector negates");
  });

  it("holds every return until settlement ships, whatever the original sale's tenders (review #645)", () => {
    // A return always carries refundTenders (RT-14 D3), even against a
    // tender-unknown sale; offered early, it posts an outstanding credit note
    // (terminal) although cash was paid out.
    const description = feedDoc.info?.description ?? "";
    expect(description).toContain("no `return` work item may be offered until the Connector supports settlement");
    expect(description).not.toContain("Sales captured without tenders are unaffected");
    // Review #650: every returns-gate instruction names both prerequisites.
    expect(description).toContain("gate is on, which follows RT-16 and RT-78");
    const kind = (feedDoc.components?.schemas?.["ReversalRef"]?.properties ?? {})["reversalKind"] as
      | { description?: string }
      | undefined;
    expect(kind?.description).toMatch(/RT-78/);
  });

  it("the ack is unchanged — one documentRef per work item (D4)", () => {
    const kind = prop<{ enum?: string[] }>("PostingWorkItem", "kind");
    expect(kind?.enum?.slice().sort()).toEqual(["reversal", "sale_post"]);
    // RT-332 adds only the optional resolutionVersion echo; still one documentRef.
    expect(Object.keys(schema("OutcomeAckRequest")?.properties ?? {}).sort()).toEqual(
      ["documentRef", "etaStatus", "outcome", "reason", "resolutionVersion"],
    );
  });

  it("retires the Payment Entry deferral and speaks no ERPNext field names (O-6)", () => {
    const description = feedDoc.info?.description ?? "";
    expect(description).not.toContain("CANNOT carry tender");
    for (const erpField of ["is_pos", "disable_rounded_total", "mode_of_payment"]) {
      expect(JSON.stringify(feedDoc)).not.toContain(erpField);
    }
  });
});

// ===========================================================================
// 9. RT-181 — Idempotency-Key declared as the IdempotencyInterceptor rule
// ===========================================================================
describe("erpnext-connector/posting-feed.yaml — RT-181 Idempotency-Key bounds", () => {
  // apps/api/src/idempotency/idempotency.interceptor.ts enforces
  // /^[\x21-\x7E]{16,128}$/ on every @Idempotent route. The contract MUST
  // declare the same rule; 1-255 accepted keys the interceptor rejects 400.
  const keySchema = (): { minLength?: number; maxLength?: number; pattern?: string } =>
    (feedDoc.components?.parameters?.["IdempotencyKey"]?.["schema"] ?? {}) as {
      minLength?: number;
      maxLength?: number;
      pattern?: string;
    };

  it("declares 16-128 printable ASCII, matching the interceptor", () => {
    const schema = keySchema();
    expect(schema.minLength).toBe(16);
    expect(schema.maxLength).toBe(128);
    expect(schema.pattern).toBe("^[\\x21-\\x7E]{16,128}$");
  });

  it("accepts the keys the connector sends and rejects keys the interceptor rejects", () => {
    const pattern = new RegExp(keySchema().pattern ?? "(?!)");
    const ref = "00000000-0000-7000-8000-00000000a001";
    expect(pattern.test(`${ref}:posted`)).toBe(true);
    expect(pattern.test(`${ref}:permanently_rejected`)).toBe(true);
    // RT-171: `<workItemRef>:failed_transient:<itemCursor>`. The cursor is the
    // bigint sequence, so the longest key is 36 + 18 + 19 = 73 characters.
    const longest = `${ref}:failed_transient:9223372036854775807`;
    expect(longest).toHaveLength(73);
    expect(pattern.test(longest)).toBe(true);
    expect(pattern.test("a".repeat(15))).toBe(false);
    expect(pattern.test("a".repeat(129))).toBe(false);
    expect(pattern.test(`${ref} posted`)).toBe(false);
  });

  it("the version note records RT-181 at 1.5.0-draft", () => {
    expect(feedDoc.info?.description ?? "").toContain("RT-181 (1.5.0-draft");
  });
});

describe("erpnext-connector/posting-feed.yaml — RT-332 frozen resolution (1.6.0-draft)", () => {
  function schema(name: string): SchemaObject | undefined {
    return feedDoc.components?.schemas?.[name];
  }
  function prop<T>(name: string, field: string): T | undefined {
    return (schema(name)?.properties ?? {})[field] as T | undefined;
  }

  it("is 1.6.0-draft and its note records RT-332 with the Backend-Core-first rollout", () => {
    expect(feedDoc.info?.version).toBe("1.6.0-draft");
    const description = feedDoc.info?.description ?? "";
    expect(description).toContain("RT-332 (1.6.0-draft");
    expect(description).toContain("ROLLOUT ORDER (Backend-Core first)");
  });

  it("the work item and sale carry the frozen version and warehouse as OPTIONAL fields", () => {
    expect(prop<{ type?: string; minimum?: number }>("PostingWorkItem", "resolutionVersion")).toMatchObject({
      type: "integer",
      minimum: 1,
    });
    expect(schema("PostingWorkItem")?.required).not.toContain("resolutionVersion");
    expect(prop<{ $ref?: string }>("Sale", "warehouseRef")?.$ref).toBe(
      "#/components/schemas/ErpnextWarehouseRef",
    );
    expect(schema("Sale")?.required).not.toContain("warehouseRef");
  });

  it("ErpnextWarehouseRef is a strict {doctype: Warehouse, name}", () => {
    const ref = schema("ErpnextWarehouseRef");
    expect(ref?.additionalProperties).toBe(false);
    expect(ref?.required?.slice().sort()).toEqual(["doctype", "name"]);
    expect(prop<{ const?: string }>("ErpnextWarehouseRef", "doctype")?.const).toBe("Warehouse");
    // Same bound as the 014 warehouse-mapping DTO and DB CHECK (1..180).
    expect(prop<{ minLength?: number; maxLength?: number }>("ErpnextWarehouseRef", "name")).toMatchObject({
      minLength: 1,
      maxLength: 180,
    });
  });

  it("the ack carries an optional resolutionVersion echo", () => {
    expect(prop<{ type?: string; minimum?: number }>("OutcomeAckRequest", "resolutionVersion")).toMatchObject({
      type: "integer",
      minimum: 1,
    });
    expect(schema("OutcomeAckRequest")?.required ?? []).not.toContain("resolutionVersion");
  });
});
