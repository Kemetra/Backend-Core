/**
 * apps/api/test/pos-payments/vouchers.contract.spec.ts
 *
 * POS-Pulse 006-payments-tender Slice 4 — Voucher Contract V-A.
 *
 * Mirrors the precedent established by
 * `apps/api/test/catalog/unknown-items/contract.spec.ts` (PR #315):
 *
 *   * Loads the new nested YAML via the production `loadOpenApiContracts`
 *     helper with an explicit `dir` because the helper's default
 *     directory scan is non-recursive (`apps/api/src/openapi/loader.ts`
 *     uses `readdirSync(dir)` with no `recursive` flag). The
 *     `pos-payments/` sub-directory is therefore not picked up by the
 *     umbrella `loadOpenApiContracts()` call inside
 *     `contract-conformance.spec.ts`; the new YAML is loaded explicitly
 *     here. No central YAML registry exists to extend (see T504 verdict
 *     under spec 005 closeout).
 *
 *   * Asserts presence of the three Slice 4 operationIds
 *     (`posValidateVoucher`, `posRedeemVoucher`, `posReverseVoucher`)
 *     and uniqueness against the existing top-level contracts (the
 *     stop condition is "the YAML edits any existing operationId").
 *
 *   * Asserts every operation declares the `Idempotency-Key` header
 *     (not `Idempotency-Token`), aligning with the existing
 *     `IdempotencyInterceptor` and the `createInvitation` /
 *     `posCaptureItem` precedents.
 *
 *   * Verifies structural conventions shared with the other contracts:
 *     OpenAPI 3.1 of record, security schemes defined and referenced,
 *     `Error` envelope shape consistent with `outbox.openapi.yaml`,
 *     closed-set discriminator enums on every response body
 *     (`additionalProperties: false`).
 *
 * The spec is structural / load-only (no app boot, no HTTP requests).
 * Controllers / services / DB migrations / workers are out of scope for
 * this slice — implementation lands in a later, separately-gated slice
 * once POS-Pulse 006 commissions §A4-B + §A2 sign-off.
 */
import "reflect-metadata";

import { resolve } from "node:path";

import { loadOpenApiContracts } from "../../src/openapi/loader";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NEW_CONTRACT_ID = "vouchers";

const SLICE_4_OPERATION_IDS = [
  "posValidateVoucher",
  "posRedeemVoucher",
  "posReverseVoucher",
] as const;

const POS_VALIDATE_PATH = "/api/pos/v1/vouchers/validate";
const POS_REDEEM_PATH = "/api/pos/v1/vouchers/redeem";
const POS_REVERSE_PATH = "/api/pos/v1/vouchers/reverse";

/**
 * Resolve the pos-payments contract directory from this spec file's
 * location. The path is computed relative to `__dirname` at runtime so it
 * is stable across `ts-jest` (transpiled in-place) and any future
 * dist-based test execution.
 *
 * Layout:
 *   apps/api/test/pos-payments/vouchers.contract.spec.ts
 *   →  ../../..               = apps/
 *   →  ../../../..            = <repo root>
 *   →  ../../../../packages/contracts/openapi/pos-payments
 */
function posPaymentsContractsDir(): string {
  return resolve(
    __dirname,
    "..",
    "..",
    "..",
    "..",
    "packages",
    "contracts",
    "openapi",
    "pos-payments",
  );
}

// ---------------------------------------------------------------------------
// Shared types — keep narrow; the loader returns `unknown` documents.
// ---------------------------------------------------------------------------

interface OperationObject {
  operationId?: string;
  security?: Array<Record<string, unknown>>;
  parameters?: Array<{
    in?: string;
    name?: string;
    required?: boolean;
    schema?: Record<string, unknown>;
  }>;
  responses?: Record<string, unknown>;
}

type PathItem = Record<string, OperationObject>;

interface OpenApiDocument {
  openapi?: string;
  info?: { title?: string; version?: string };
  paths?: Record<string, PathItem>;
  components?: {
    schemas?: Record<string, Record<string, unknown>>;
    securitySchemes?: Record<string, Record<string, unknown>>;
  };
  security?: Array<Record<string, unknown>>;
  tags?: Array<{ name?: string }>;
}

// Lazy-loaded once per file; populated in beforeAll.
let vouchersDoc: OpenApiDocument;
let topLevelOperationIds: Set<string>;

beforeAll(() => {
  const posPaymentsContracts = loadOpenApiContracts({
    dir: posPaymentsContractsDir(),
  });
  const newContract = posPaymentsContracts.find(
    (c) => c.id === NEW_CONTRACT_ID,
  );
  if (!newContract) {
    const ids = posPaymentsContracts.map((c) => c.id).join(", ");
    throw new Error(
      `${NEW_CONTRACT_ID} contract not found under ${posPaymentsContractsDir()}; loaded ids: [${ids}]`,
    );
  }
  vouchersDoc = newContract.document as OpenApiDocument;

  // Build the set of operationIds across the *existing* top-level
  // contracts so the uniqueness check below can reject any collision.
  // We deliberately call the default-dir loader (no `dir:` override) to
  // exercise the same surface the production startup uses.
  const topLevelContracts = loadOpenApiContracts();
  topLevelOperationIds = new Set<string>();
  for (const contract of topLevelContracts) {
    const doc = contract.document as OpenApiDocument;
    if (!doc.paths) continue;
    for (const path of Object.values(doc.paths)) {
      for (const op of Object.values(path)) {
        if (op && typeof op.operationId === "string") {
          topLevelOperationIds.add(op.operationId);
        }
      }
    }
  }
});

// Helper — flatten every operation in the new contract.
function newContractOperations(): Array<{
  path: string;
  method: string;
  op: OperationObject;
}> {
  const out: Array<{ path: string; method: string; op: OperationObject }> = [];
  const paths = vouchersDoc.paths ?? {};
  for (const [path, item] of Object.entries(paths)) {
    for (const [method, op] of Object.entries(item)) {
      out.push({ path, method, op });
    }
  }
  return out;
}

// ===========================================================================
// 1. Loadability + document-level conventions
// ===========================================================================
describe("pos-payments/vouchers.yaml — loadability", () => {
  it("is parseable by the production OpenAPI loader", () => {
    expect(vouchersDoc).toBeDefined();
    expect(typeof vouchersDoc).toBe("object");
  });

  it("declares OpenAPI 3.1 of record (matches the other contracts in this repo)", () => {
    expect(vouchersDoc.openapi).toBe("3.1.0");
  });

  it("declares an info block with title and version", () => {
    expect(vouchersDoc.info?.title).toEqual(expect.any(String));
    expect(vouchersDoc.info?.version).toEqual(expect.any(String));
  });

  it("declares the role-named operator-identity security scheme (spec 030; was clerkJwt)", () => {
    // Spec 030 retired the provider-named `clerkJwt` key on this surface and
    // re-pointed every (non-sale) voucher operation to the role-named
    // `operator-identity` scheme (a provider-identity JWT, identity proof only).
    const schemes = vouchersDoc.components?.securitySchemes ?? {};
    expect(schemes["operator-identity"]).toBeDefined();
    expect(schemes["clerkJwt"]).toBeUndefined();
  });

  it("does NOT declare cookieAuth (this surface is POS-only; no dashboard endpoints)", () => {
    // Tenant-admin voucher CRUD is not part of this contract (it has no
    // contract or route yet). This V-A
    // contract is strictly the POS terminal → backend voucher-authority
    // surface and uses the role-named `operator-identity` scheme exclusively.
    const schemes = vouchersDoc.components?.securitySchemes ?? {};
    expect(schemes["cookieAuth"]).toBeUndefined();
  });

  it("declares operator-identity as the document-level default security (spec 030)", () => {
    expect(vouchersDoc.security).toBeDefined();
    expect(vouchersDoc.security).toContainEqual({ "operator-identity": [] });
    expect(vouchersDoc.security).not.toContainEqual({ clerkJwt: [] });
  });

  it("declares the pos-payments-vouchers tag (matches the operation tag)", () => {
    const tagNames = (vouchersDoc.tags ?? []).map((t) => t.name);
    expect(tagNames).toContain("pos-payments-vouchers");
  });
});

// ===========================================================================
// 2. Operation presence + uniqueness vs. existing top-level contracts
// ===========================================================================
describe("pos-payments/vouchers.yaml — Slice 4 operationIds", () => {
  it.each(SLICE_4_OPERATION_IDS)(
    "declares the %s operationId",
    (expected) => {
      const ids = newContractOperations()
        .map(({ op }) => op.operationId)
        .filter((id): id is string => typeof id === "string");
      expect(ids).toContain(expected);
    },
  );

  it("posValidateVoucher is mounted at POST /api/pos/v1/vouchers/validate", () => {
    const op = vouchersDoc.paths?.[POS_VALIDATE_PATH]?.["post"];
    expect(op?.operationId).toBe("posValidateVoucher");
  });

  it("posRedeemVoucher is mounted at POST /api/pos/v1/vouchers/redeem", () => {
    const op = vouchersDoc.paths?.[POS_REDEEM_PATH]?.["post"];
    expect(op?.operationId).toBe("posRedeemVoucher");
  });

  it("posReverseVoucher is mounted at POST /api/pos/v1/vouchers/reverse", () => {
    const op = vouchersDoc.paths?.[POS_REVERSE_PATH]?.["post"];
    expect(op?.operationId).toBe("posReverseVoucher");
  });

  it("declares only the three Slice 4 operationIds (no smuggled-in operations)", () => {
    const declared = newContractOperations()
      .map(({ op }) => op.operationId)
      .filter((id): id is string => typeof id === "string")
      .sort();
    expect(declared).toEqual([...SLICE_4_OPERATION_IDS].sort());
  });

  it("does not collide with any operationId in the existing top-level contracts", () => {
    // Stop condition: this YAML must not edit or shadow any existing
    // operationId across `packages/contracts/openapi/*.yaml`.
    const collisions: string[] = [];
    for (const id of SLICE_4_OPERATION_IDS) {
      if (topLevelOperationIds.has(id)) {
        collisions.push(id);
      }
    }
    expect(collisions).toEqual([]);
  });

  it.each(SLICE_4_OPERATION_IDS)(
    "%s uses operator-identity security (spec 030; provider-identity JWT bearer)",
    (operationId) => {
      const found = newContractOperations().find(
        ({ op }) => op.operationId === operationId,
      );
      expect(found).toBeDefined();
      expect(found?.op.security).toContainEqual({ "operator-identity": [] });
      expect(found?.op.security).not.toContainEqual({ clerkJwt: [] });
    },
  );
});

// ===========================================================================
// 3. Idempotency-Key alignment (consistent with createInvitation + posCaptureItem)
// ===========================================================================
describe("pos-payments/vouchers.yaml — Idempotency-Key header convention", () => {
  it.each(SLICE_4_OPERATION_IDS)(
    "%s declares a required Idempotency-Key header parameter",
    (operationId) => {
      const found = newContractOperations().find(
        ({ op }) => op.operationId === operationId,
      );
      expect(found).toBeDefined();
      const headers = (found?.op.parameters ?? []).filter(
        (p) => p.in === "header",
      );
      const idempotencyHeader = headers.find(
        (p) => p.name === "Idempotency-Key",
      );
      expect(idempotencyHeader).toBeDefined();
      expect(idempotencyHeader?.required).toBe(true);
    },
  );

  it.each(SLICE_4_OPERATION_IDS)(
    "%s does NOT declare an Idempotency-Token header (drift guard)",
    (operationId) => {
      // The existing IdempotencyInterceptor uses `Idempotency-Key`
      // (see apps/api/src/idempotency/idempotency.interceptor.ts).
      // POS-Pulse bridge handlers generate UUID v4 keys and pass them
      // through unchanged. The contract MUST follow the implementation.
      const found = newContractOperations().find(
        ({ op }) => op.operationId === operationId,
      );
      const headerNames = (found?.op.parameters ?? [])
        .filter((p) => p.in === "header")
        .map((p) => p.name);
      expect(headerNames).not.toContain("Idempotency-Token");
    },
  );

  it.each(SLICE_4_OPERATION_IDS)(
    "%s declares x-idempotency: required (matches createInvitation / posCaptureItem)",
    (operationId) => {
      const found = newContractOperations().find(
        ({ op }) => op.operationId === operationId,
      );
      const op = found?.op as
        | (OperationObject & { "x-idempotency"?: string })
        | undefined;
      expect(op?.["x-idempotency"]).toBe("required");
    },
  );

  it.each(SLICE_4_OPERATION_IDS)(
    "%s declares Idempotency-Key with the shared pattern (16–128 visible ASCII)",
    (operationId) => {
      const found = newContractOperations().find(
        ({ op }) => op.operationId === operationId,
      );
      const header = (found?.op.parameters ?? []).find(
        (p) => p.in === "header" && p.name === "Idempotency-Key",
      );
      const schema = header?.schema ?? {};
      expect(schema["type"]).toBe("string");
      expect(schema["minLength"]).toBe(16);
      expect(schema["maxLength"]).toBe(128);
      expect(schema["pattern"]).toBe("^[\\x21-\\x7E]{16,128}$");
    },
  );
});

// ===========================================================================
// 4. Schema shape — closed envelopes for response safety
// ===========================================================================
describe("pos-payments/vouchers.yaml — schema closedness", () => {
  it.each([
    "PosValidateVoucherRequest",
    "PosValidateVoucherResponse",
    "PosRedeemVoucherRequest",
    "PosRedeemVoucherResponse",
    "PosReverseVoucherRequest",
    "PosReverseVoucherResponse",
    "Error",
  ])(
    "%s closes with additionalProperties: false (defence-in-depth response shape)",
    (schemaName) => {
      const schema = vouchersDoc.components?.schemas?.[schemaName];
      expect(schema).toBeDefined();
      expect(schema?.["additionalProperties"]).toBe(false);
    },
  );

  it("PosValidateVoucherResponse.kind is the closed enum {validated}", () => {
    const schema = vouchersDoc.components?.schemas?.["PosValidateVoucherResponse"];
    const props = schema?.["properties"] as
      | Record<string, { enum?: string[] }>
      | undefined;
    expect(props?.["kind"]?.enum).toEqual(["validated"]);
  });

  it("PosRedeemVoucherResponse.kind is the closed enum {redeemed}", () => {
    const schema = vouchersDoc.components?.schemas?.["PosRedeemVoucherResponse"];
    const props = schema?.["properties"] as
      | Record<string, { enum?: string[] }>
      | undefined;
    expect(props?.["kind"]?.enum).toEqual(["redeemed"]);
  });

  it("PosReverseVoucherResponse.kind is the closed enum {reversed}", () => {
    const schema = vouchersDoc.components?.schemas?.["PosReverseVoucherResponse"];
    const props = schema?.["properties"] as
      | Record<string, { enum?: string[] }>
      | undefined;
    expect(props?.["kind"]?.enum).toEqual(["reversed"]);
  });

  it("Error envelope shape matches the outbox.openapi.yaml convention (error.code + error.message)", () => {
    const schema = vouchersDoc.components?.schemas?.["Error"];
    const props = schema?.["properties"] as
      | { error?: { required?: string[]; additionalProperties?: boolean } }
      | undefined;
    expect(props?.error?.required).toEqual(
      expect.arrayContaining(["code", "message"]),
    );
    expect(props?.error?.additionalProperties).toBe(false);
  });
});

// ===========================================================================
// 5. Validate request — partial-redemption-refuse contract (POS-Pulse AD-7 / OQ-PLAN-3)
// ===========================================================================
describe("pos-payments/vouchers.yaml — partial-redemption refuse contract", () => {
  it("PosValidateVoucherRequest requires both applied_amount_minor and remaining_balance_minor", () => {
    const schema = vouchersDoc.components?.schemas?.["PosValidateVoucherRequest"];
    const required = (schema?.["required"] ?? []) as string[];
    expect(required).toEqual(
      expect.arrayContaining([
        "code",
        "payment_attempt_id",
        "applied_amount_minor",
        "remaining_balance_minor",
      ]),
    );
  });

  it("PosValidateVoucherRequest.applied_amount_minor is integer minor units (no float, no negative)", () => {
    // POS-Pulse Constitution §II / Data-Pulse-2 P-II — money is integer
    // minor units only; validation MUST refuse floats and negatives at
    // the contract boundary.
    const schema = vouchersDoc.components?.schemas?.["PosValidateVoucherRequest"];
    const props = schema?.["properties"] as
      | Record<string, { type?: string; minimum?: number; maximum?: number }>
      | undefined;
    expect(props?.["applied_amount_minor"]?.type).toBe("integer");
    expect(props?.["applied_amount_minor"]?.minimum).toBe(0);
    expect(props?.["applied_amount_minor"]?.maximum).toBe(
      Number.MAX_SAFE_INTEGER,
    );
  });

  it("PosValidateVoucherRequest.remaining_balance_minor is integer minor units (no float, no negative)", () => {
    const schema = vouchersDoc.components?.schemas?.["PosValidateVoucherRequest"];
    const props = schema?.["properties"] as
      | Record<string, { type?: string; minimum?: number; maximum?: number }>
      | undefined;
    expect(props?.["remaining_balance_minor"]?.type).toBe("integer");
    expect(props?.["remaining_balance_minor"]?.minimum).toBe(0);
    expect(props?.["remaining_balance_minor"]?.maximum).toBe(
      Number.MAX_SAFE_INTEGER,
    );
  });

  it("PosValidateVoucherResponse carries redemption_intent_token + intent_expires_at + applied_amount_minor", () => {
    const schema = vouchersDoc.components?.schemas?.["PosValidateVoucherResponse"];
    const required = (schema?.["required"] ?? []) as string[];
    expect(required).toEqual(
      expect.arrayContaining([
        "kind",
        "redemption_intent_token",
        "applied_amount_minor",
        "intent_expires_at",
      ]),
    );
  });

  it("PosValidateVoucherResponse.redemption_intent_token has shape constraints (length-bounded opaque string)", () => {
    const schema = vouchersDoc.components?.schemas?.["PosValidateVoucherResponse"];
    const props = schema?.["properties"] as
      | Record<string, { type?: string; minLength?: number; maxLength?: number }>
      | undefined;
    const token = props?.["redemption_intent_token"];
    expect(token?.type).toBe("string");
    expect(token?.minLength).toBeGreaterThanOrEqual(32);
    expect(token?.maxLength).toBeLessThanOrEqual(256);
  });

  it("PosValidateVoucherResponse.intent_expires_at is a date-time field", () => {
    const schema = vouchersDoc.components?.schemas?.["PosValidateVoucherResponse"];
    const props = schema?.["properties"] as
      | Record<string, { type?: string; format?: string }>
      | undefined;
    expect(props?.["intent_expires_at"]?.type).toBe("string");
    expect(props?.["intent_expires_at"]?.format).toBe("date-time");
  });

  it("validate operation declares 400 response (used by non_cash_overpayment_refused per AD-7)", () => {
    const op = vouchersDoc.paths?.[POS_VALIDATE_PATH]?.["post"];
    const responses = op?.responses ?? {};
    expect(responses["400"]).toBeDefined();
  });
});

// ===========================================================================
// 6. Redeem + reverse — idempotent replay contract
// ===========================================================================
describe("pos-payments/vouchers.yaml — idempotent replay flags", () => {
  it("PosRedeemVoucherResponse.idempotent_replayed is a required boolean", () => {
    const schema = vouchersDoc.components?.schemas?.["PosRedeemVoucherResponse"];
    const required = (schema?.["required"] ?? []) as string[];
    expect(required).toContain("idempotent_replayed");
    const props = schema?.["properties"] as
      | Record<string, { type?: string }>
      | undefined;
    expect(props?.["idempotent_replayed"]?.type).toBe("boolean");
  });

  it("PosReverseVoucherResponse.already_reversed is a required boolean", () => {
    const schema = vouchersDoc.components?.schemas?.["PosReverseVoucherResponse"];
    const required = (schema?.["required"] ?? []) as string[];
    expect(required).toContain("already_reversed");
    const props = schema?.["properties"] as
      | Record<string, { type?: string }>
      | undefined;
    expect(props?.["already_reversed"]?.type).toBe("boolean");
  });

  it("PosRedeemVoucherResponse carries a durable redemption_id as a UUID", () => {
    // POS-Pulse FR-017 allowlist: redemption_id is the only voucher-side
    // identifier that may surface in receipt-handoff payloads / audit.
    const schema = vouchersDoc.components?.schemas?.["PosRedeemVoucherResponse"];
    const props = schema?.["properties"] as
      | Record<string, { type?: string; format?: string }>
      | undefined;
    expect(props?.["redemption_id"]?.type).toBe("string");
    expect(props?.["redemption_id"]?.format).toBe("uuid");
  });

  it("PosReverseVoucherRequest accepts only redemption_id (no token, no balance)", () => {
    // Reverse must NEVER carry the redemption_intent_token (which is
    // already consumed) or any voucher-side balance hint. The only
    // identity that crosses the wire is the public-safe redemption_id.
    const schema = vouchersDoc.components?.schemas?.["PosReverseVoucherRequest"];
    const props = schema?.["properties"] as
      | Record<string, unknown>
      | undefined;
    const keys = Object.keys(props ?? {});
    expect(keys).toEqual(["redemption_id"]);
  });

  it.each([POS_REDEEM_PATH, POS_REVERSE_PATH])(
    "%s declares 200, 400, 401, 404, 409, 425 response envelopes",
    (path) => {
      const op = vouchersDoc.paths?.[path]?.["post"];
      const responses = op?.responses ?? {};
      for (const status of ["200", "400", "401", "404", "409", "425"]) {
        expect(responses[status]).toBeDefined();
      }
    },
  );
});

// ===========================================================================
// 7. Sensitive-field minimisation (POS-Pulse FR-017 / Constitution §XIV)
// ===========================================================================
describe("pos-payments/vouchers.yaml — sensitive-field minimisation", () => {
  it("response schemas do NOT carry voucher_balance / holder / value fields", () => {
    // POS-Pulse FR-017: voucher balance, voucher-issuance metadata,
    // loyalty-campaign internals, voucher holder PII, and cross-cart
    // voucher state MUST NOT cross the wire. Only the closed allowlist
    // documented in `contracts/bridge-api.md` §"Renderer-visible fields"
    // is permitted (`redemption_id`, `intent_expires_at`, the kind
    // discriminator, and the timestamps).
    const forbiddenFieldNames = [
      "voucher_balance",
      "voucher_balance_minor",
      "voucher_value",
      "voucher_value_minor",
      "voucher_holder_id",
      "voucher_holder_email",
      "voucher_holder_phone",
      "voucher_holder_name",
      "issued_by_user_id",
      "remaining_uses",
      "max_uses",
      "discount_type",
      "discount_value",
    ];
    const responseSchemas = [
      "PosValidateVoucherResponse",
      "PosRedeemVoucherResponse",
      "PosReverseVoucherResponse",
    ];
    for (const schemaName of responseSchemas) {
      const schema = vouchersDoc.components?.schemas?.[schemaName];
      const props = schema?.["properties"] as
        | Record<string, unknown>
        | undefined;
      const propKeys = Object.keys(props ?? {});
      for (const forbidden of forbiddenFieldNames) {
        expect(propKeys).not.toContain(forbidden);
      }
    }
  });

  it("Error envelope keeps message human-readable but does not require any sensitive field", () => {
    const schema = vouchersDoc.components?.schemas?.["Error"];
    const props = schema?.["properties"] as
      | {
          error?: {
            properties?: Record<string, unknown>;
          };
        }
      | undefined;
    const errorProps = props?.error?.properties ?? {};
    const errorKeys = Object.keys(errorProps);
    // Only `code`, `message`, `request_id` are defined on the error
    // envelope. Anything else is a leak surface.
    expect(errorKeys.sort()).toEqual(["code", "message", "request_id"].sort());
  });
});
