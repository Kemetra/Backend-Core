/**
 * apps/api/test/pos-terminal-pairing/pairing.contract.spec.ts
 *
 * POS-Pulse 002-terminal-pairing + 008-sale-finalization-and-receipts
 * — POS Terminal Pairing OpenAPI contract conformance.
 *
 * Mirrors the precedent established by
 * `apps/api/test/pos-payments/vouchers.contract.spec.ts` (PR #316):
 *
 *   * Loads the new top-level YAML via the production `loadOpenApiContracts`
 *     helper. Pairing lives at the top of `packages/contracts/openapi/`
 *     (not under a sub-directory like `pos-payments/`), so the default
 *     directory scan picks it up automatically.
 *
 *   * Asserts presence of the single operation (`posPairTerminal`) and
 *     uniqueness against the existing top-level contracts (the stop
 *     condition is "the YAML edits any existing operationId").
 *
 *   * Pairing is the ONLY backend operation that runs WITHOUT
 *     `clerkJwt` security — the test explicitly verifies the empty
 *     `security: []` override on the operation and asserts the
 *     contract does NOT declare a document-level default security.
 *     (Other POS contracts default to clerkJwt; this one is the
 *     bootstrap operation that issues the token, so it can't require
 *     one.)
 *
 *   * Idempotency-Key is NOT required for this operation. The
 *     `pairing_code` itself is server-side single-use; idempotency is
 *     enforced at the code-state level (`pending → used`), not at the
 *     request-header level. The test asserts the absence of the
 *     `Idempotency-Key` header to prevent drift toward the convention
 *     used by every other POS-authenticated operation.
 *
 *   * Verifies structural conventions shared with the other contracts:
 *     OpenAPI 3.1 of record, tag declared, `Error` envelope shape
 *     consistent with `outbox.openapi.yaml` /
 *     `pos-payments/vouchers.yaml`, closed-set discriminator enums on
 *     every response body (`additionalProperties: false`).
 *
 *   * Verifies the 6 new fields added 2026-05-28 from the POS-Pulse
 *     Slice 1 closeout-gap audit (branch_name, branch_address,
 *     tenant_tax_registration_id) and the POS-Pulse Slice 3 prep
 *     audit (printer_vendor_id, printer_product_id,
 *     printer_com_port). These fields are required on the response
 *     to ensure backend implementers cannot accidentally omit them.
 *
 *   * Verifies the closed-set `error.code` enum matches the five
 *     sentinels POS-Pulse `src/main/pairing/failure-mapping.ts`
 *     switches on (`INVALID_CODE`, `EXPIRED_CODE`, `ALREADY_PAIRED`,
 *     `BRANCH_MISMATCH`, `RATE_LIMITED`) plus the generic
 *     `validation_failure` for 400-body-shape failures. POS-Pulse's
 *     mapper has a catch-all `unknown_error` for any unrecognised
 *     code, so unknown codes don't break the client — but the enum
 *     drift guard helps reviewers catch contract regressions.
 *
 * The spec is structural / load-only (no app boot, no HTTP requests).
 * Controllers / services / DB migrations / workers / pairing-code
 * lifecycle implementation are out of scope for this slice —
 * implementation lands in a later, separately-gated slice once
 * POS-Pulse 008 commissions a §A2 backend handoff sign-off.
 */
import "reflect-metadata";

import { loadOpenApiContracts } from "../../src/openapi/loader";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NEW_CONTRACT_ID = "pos-terminal-pairing.openapi";

const PAIRING_OPERATION_IDS = ["posPairTerminal"] as const;

/** RT-369: the device-authenticated credential rotation. */
const ROTATE_OPERATION_ID = "posRotateTerminalToken";

/** Every operation this contract declares. */
const ALL_OPERATION_IDS = [...PAIRING_OPERATION_IDS, ROTATE_OPERATION_ID] as const;

const POS_PAIR_PATH = "/api/pos/v1/terminals/pair";

const POS_ROTATE_PATH = "/api/pos/v1/terminals/rotate";

/**
 * Expected closed-set `error.code` enum on the contract's `Error`
 * envelope. The five original SCREAMING_CASE codes mirror POS-Pulse
 * `src/main/pairing/failure-mapping.ts:73-87` switch keys exactly;
 * `REPLACEMENT_BLOCKED` (RT-367, pair-time Cash Session re-check on a
 * replacement code) is new and lands in POS-Pulse's `unknown_error`
 * catch-all until POS maps it. The `validation_failure` snake_case code
 * mirrors the convention used by `vouchers.yaml` and every other
 * Data-Pulse-2 contract for 400-body-shape failures.
 */
const EXPECTED_ERROR_CODES = [
  "INVALID_CODE",
  "EXPIRED_CODE",
  "ALREADY_PAIRED",
  "BRANCH_MISMATCH",
  "REPLACEMENT_BLOCKED",
  "RATE_LIMITED",
  "validation_failure",
] as const;

/**
 * Required fields on `TerminalPairResponse`. The 5 baseline fields
 * (`device_token`, `tenant_id`, `branch_id`, `terminal_id`,
 * `terminal_label`) match the pinned snapshot at
 * `POS-Pulse/scripts/openapi-snapshot.json`. The 6 new fields added
 * 2026-05-28 (`branch_name`, `branch_address`,
 * `tenant_tax_registration_id`, `printer_vendor_id`,
 * `printer_product_id`, `printer_com_port`) come from the POS-Pulse
 * Slice 1 closeout-gap audit + Slice 3 prep audit (recorded in
 * POS-Pulse `coordination.md` §"Slice 1 closeout gap discovery" and
 * §"Slice 3 prep audit").
 */
const EXPECTED_PAIR_RESPONSE_REQUIRED_FIELDS = [
  // Baseline (5)
  "device_token",
  "tenant_id",
  "branch_id",
  "terminal_id",
  "terminal_label",
  // Slice 1 closeout-gap audit additions (3)
  "branch_name",
  "branch_address",
  "tenant_tax_registration_id",
  // Slice 3 prep-audit additions (3)
  "printer_vendor_id",
  "printer_product_id",
  "printer_com_port",
] as const;

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
let pairingDoc: OpenApiDocument;
let topLevelOperationIds: Set<string>;

beforeAll(() => {
  // Pairing yaml is a top-level contract under
  // `packages/contracts/openapi/`, so the default-dir loader (no `dir:`
  // override) picks it up alongside the other top-level contracts.
  const topLevelContracts = loadOpenApiContracts();
  const newContract = topLevelContracts.find((c) => c.id === NEW_CONTRACT_ID);
  if (!newContract) {
    const ids = topLevelContracts.map((c) => c.id).join(", ");
    throw new Error(
      `${NEW_CONTRACT_ID} contract not found among top-level contracts; loaded ids: [${ids}]`,
    );
  }
  pairingDoc = newContract.document as OpenApiDocument;

  // Build the set of operationIds across the existing top-level
  // contracts (excluding the new one) so the uniqueness check below
  // can reject any collision.
  topLevelOperationIds = new Set<string>();
  for (const contract of topLevelContracts) {
    if (contract.id === NEW_CONTRACT_ID) continue;
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
  const paths = pairingDoc.paths ?? {};
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
describe("pos-terminal-pairing.yaml — loadability", () => {
  it("is parseable by the production OpenAPI loader", () => {
    expect(pairingDoc).toBeDefined();
    expect(typeof pairingDoc).toBe("object");
  });

  it("declares OpenAPI 3.1 of record (matches the other contracts in this repo)", () => {
    expect(pairingDoc.openapi).toBe("3.1.0");
  });

  it("declares an info block with title and version", () => {
    expect(pairingDoc.info?.title).toEqual(expect.any(String));
    expect(pairingDoc.info?.version).toEqual(expect.any(String));
  });

  it("declares the pos-terminal-pairing tag (matches the operation tag)", () => {
    const tagNames = (pairingDoc.tags ?? []).map((t) => t.name);
    expect(tagNames).toContain("pos-terminal-pairing");
  });
});

// ===========================================================================
// 2. Operation presence + uniqueness vs. existing top-level contracts
// ===========================================================================
describe("pos-terminal-pairing.yaml — operationId", () => {
  it.each(PAIRING_OPERATION_IDS)(
    "declares the %s operationId",
    (expected) => {
      const ids = newContractOperations()
        .map(({ op }) => op.operationId)
        .filter((id): id is string => typeof id === "string");
      expect(ids).toContain(expected);
    },
  );

  it("posPairTerminal is mounted at POST /api/pos/v1/terminals/pair", () => {
    const op = pairingDoc.paths?.[POS_PAIR_PATH]?.["post"];
    expect(op?.operationId).toBe("posPairTerminal");
  });

  it("declares only the pair and rotate operations (no smuggled-in operations)", () => {
    const declared = newContractOperations()
      .map(({ op }) => op.operationId)
      .filter((id): id is string => typeof id === "string")
      .sort();
    expect(declared).toEqual([...ALL_OPERATION_IDS].sort());
  });

  it("does not collide with any operationId in the existing top-level contracts", () => {
    // Stop condition: this YAML must not edit or shadow any existing
    // operationId across `packages/contracts/openapi/*.yaml`.
    const collisions: string[] = [];
    for (const id of ALL_OPERATION_IDS) {
      if (topLevelOperationIds.has(id)) {
        collisions.push(id);
      }
    }
    expect(collisions).toEqual([]);
  });
});

// ===========================================================================
// 3. Security: pairing is the ONLY unauthenticated POS operation
// ===========================================================================
describe("pos-terminal-pairing.yaml — unauthenticated bootstrap operation", () => {
  it("posPairTerminal declares an explicit empty security override (no clerkJwt, no other scheme)", () => {
    // Pairing IS the bootstrap operation that issues the device_token;
    // it cannot require a token. Other contracts default to
    // `security: [{ clerkJwt: [] }]`; this one must explicitly override
    // to `security: []` so the OpenAPI runtime treats the operation
    // as unauthenticated.
    const op = pairingDoc.paths?.[POS_PAIR_PATH]?.["post"];
    expect(op?.security).toBeDefined();
    expect(op?.security).toEqual([]);
  });

  it("does NOT declare a document-level default security block", () => {
    // Each operation states its own security: pairing is unauthenticated,
    // rotate (RT-369) takes the device bearer. There is no document-level
    // default to inherit from. (Compare with vouchers.yaml which declares
    // `security: [{ clerkJwt: [] }]` at the document level.)
    expect(pairingDoc.security).toBeUndefined();
  });

  it("declares only the role-named `device` scheme (no clerkJwt, no cookieAuth)", () => {
    // RT-369 adds the device bearer for the rotation; nothing else.
    const schemes = pairingDoc.components?.securitySchemes ?? {};
    expect(Object.keys(schemes)).toEqual(["device"]);
    expect(schemes["device"]).toMatchObject({ type: "http", scheme: "bearer" });
    expect(schemes["device"]?.["bearerFormat"]).toBeUndefined();
  });
});

// ===========================================================================
// 4. Idempotency: NOT header-based (pairing_code itself is single-use)
// ===========================================================================
describe("pos-terminal-pairing.yaml — pairing_code is single-use (no Idempotency-Key required)", () => {
  it.each(PAIRING_OPERATION_IDS)(
    "%s does NOT declare an Idempotency-Key header parameter",
    (operationId) => {
      // Other POS operations (vouchers, captures, etc.) require an
      // Idempotency-Key header. Pairing does NOT, because the
      // `pairing_code` itself is server-side single-use: a successful
      // pair transitions the code from `pending → used`, and a replay
      // returns 410 EXPIRED_CODE rather than a fresh device_token.
      // POS-Pulse spec 002 chose this model deliberately (FR-14).
      const found = newContractOperations().find(
        ({ op }) => op.operationId === operationId,
      );
      const headerNames = (found?.op.parameters ?? [])
        .filter((p) => p.in === "header")
        .map((p) => p.name);
      expect(headerNames).not.toContain("Idempotency-Key");
    },
  );

  it.each(PAIRING_OPERATION_IDS)(
    "%s does NOT declare x-idempotency: required (consistent with no-header design)",
    (operationId) => {
      const found = newContractOperations().find(
        ({ op }) => op.operationId === operationId,
      );
      const op = found?.op as
        | (OperationObject & { "x-idempotency"?: string })
        | undefined;
      expect(op?.["x-idempotency"]).toBeUndefined();
    },
  );
});

// ===========================================================================
// 5. Schema shape — closed envelopes for response safety
// ===========================================================================
describe("pos-terminal-pairing.yaml — schema closedness", () => {
  it.each(["TerminalPairRequest", "TerminalPairResponse", "Error"])(
    "%s closes with additionalProperties: false (defence-in-depth response shape)",
    (schemaName) => {
      const schema = pairingDoc.components?.schemas?.[schemaName];
      expect(schema).toBeDefined();
      expect(schema?.["additionalProperties"]).toBe(false);
    },
  );

  it("Error envelope shape matches the outbox.openapi.yaml convention (error.code + error.message)", () => {
    const schema = pairingDoc.components?.schemas?.["Error"];
    const props = schema?.["properties"] as
      | { error?: { required?: string[]; additionalProperties?: boolean } }
      | undefined;
    expect(props?.error?.required).toEqual(
      expect.arrayContaining(["code", "message"]),
    );
    expect(props?.error?.additionalProperties).toBe(false);
  });

  it("Error.error.code declares the closed-set enum POS-Pulse failure-mapping switches on", () => {
    // POS-Pulse `src/main/pairing/failure-mapping.ts:73-87` switches on
    // the five SCREAMING_CASE sentinels. The contract MUST declare the
    // exact enum so a future backend implementer cannot silently
    // introduce a code that POS-Pulse will route to
    // `unknown_error` without anyone noticing.
    const schema = pairingDoc.components?.schemas?.["Error"];
    const props = schema?.["properties"] as
      | {
          error?: {
            properties?: { code?: { enum?: string[] } };
          };
        }
      | undefined;
    const codeEnum = props?.error?.properties?.code?.enum ?? [];
    expect([...codeEnum].sort()).toEqual([...EXPECTED_ERROR_CODES].sort());
  });
});

// ===========================================================================
// 6. Request shape — pairing_code is the only field
// ===========================================================================
describe("pos-terminal-pairing.yaml — TerminalPairRequest shape", () => {
  it("declares pairing_code as the only required field", () => {
    const schema = pairingDoc.components?.schemas?.["TerminalPairRequest"];
    const required = (schema?.["required"] ?? []) as string[];
    expect(required).toEqual(["pairing_code"]);
  });

  it("declares pairing_code as the only property (drift guard against silent optional additions)", () => {
    // CR1 fix: a bare `required` check would still pass if someone
    // adds optional properties (e.g. `device_fingerprint`) to the
    // request. Pin the property set explicitly so additions land in
    // the diff and force a contract review.
    const schema = pairingDoc.components?.schemas?.["TerminalPairRequest"];
    const props = schema?.["properties"] as
      | Record<string, unknown>
      | undefined;
    expect(Object.keys(props ?? {})).toEqual(["pairing_code"]);
  });

  it("pairing_code bounds are EXACTLY 6 to 32 chars (not a loose range)", () => {
    // CR1 fix: bounds-as-range assertions (`.toBeGreaterThanOrEqual` /
    // `.toBeLessThanOrEqual`) would silently allow the contract to
    // drift to `minLength: 1` / `maxLength: 64`. Pin the exact
    // numbers — the contract's value is the precise shape, not a
    // permissive envelope.
    const schema = pairingDoc.components?.schemas?.["TerminalPairRequest"];
    const props = schema?.["properties"] as
      | Record<string, { type?: string; minLength?: number; maxLength?: number }>
      | undefined;
    const code = props?.["pairing_code"];
    expect(code?.type).toBe("string");
    expect(code?.minLength).toBe(6);
    expect(code?.maxLength).toBe(32);
  });
});

// ===========================================================================
// 7. Response shape — the 11-field envelope (5 baseline + 6 new from
//    POS-Pulse Slice 1/3 audits)
// ===========================================================================
describe("pos-terminal-pairing.yaml — TerminalPairResponse shape", () => {
  it("declares all 11 fields as required (5 baseline + 6 new from 2026-05-28 audits)", () => {
    const schema = pairingDoc.components?.schemas?.["TerminalPairResponse"];
    const required = (schema?.["required"] ?? []) as string[];
    expect([...required].sort()).toEqual(
      [...EXPECTED_PAIR_RESPONSE_REQUIRED_FIELDS].sort(),
    );
  });

  it.each(EXPECTED_PAIR_RESPONSE_REQUIRED_FIELDS)(
    "declares %s with a non-empty schema",
    (fieldName) => {
      const schema = pairingDoc.components?.schemas?.["TerminalPairResponse"];
      const props = schema?.["properties"] as
        | Record<string, Record<string, unknown>>
        | undefined;
      expect(props?.[fieldName]).toBeDefined();
      expect(Object.keys(props?.[fieldName] ?? {}).length).toBeGreaterThan(0);
    },
  );

  it("device_token is a bounded-length opaque string (it is SECRET; not a UUID-shaped field)", () => {
    const schema = pairingDoc.components?.schemas?.["TerminalPairResponse"];
    const props = schema?.["properties"] as
      | Record<
          string,
          { type?: string; minLength?: number; maxLength?: number; format?: string }
        >
      | undefined;
    const token = props?.["device_token"];
    expect(token?.type).toBe("string");
    expect(token?.minLength).toBeGreaterThanOrEqual(32);
    expect(token?.maxLength).toBeGreaterThan(0);
    // Critical: device_token must NOT be format: uuid — it is an opaque
    // bearer, not a tenant-scoped UUID. A `format: uuid` declaration
    // would mislead clients into validating it as a structured id.
    expect(token?.format).toBeUndefined();
  });

  it("tenant_id / branch_id / terminal_id are UUID-formatted strings", () => {
    const schema = pairingDoc.components?.schemas?.["TerminalPairResponse"];
    const props = schema?.["properties"] as
      | Record<string, { type?: string; format?: string }>
      | undefined;
    for (const f of ["tenant_id", "branch_id", "terminal_id"] as const) {
      expect(props?.[f]?.type).toBe("string");
      expect(props?.[f]?.format).toBe("uuid");
    }
  });

  it("terminal_label is a bounded-length human-readable string", () => {
    const schema = pairingDoc.components?.schemas?.["TerminalPairResponse"];
    const props = schema?.["properties"] as
      | Record<string, { type?: string; minLength?: number; maxLength?: number }>
      | undefined;
    const label = props?.["terminal_label"];
    expect(label?.type).toBe("string");
    expect(label?.minLength).toBeGreaterThanOrEqual(1);
  });

  it("expires_at is OPTIONAL (not in required[]), date-time, nullable", () => {
    // expires_at is the one optional field per the contract — every
    // other field is required so backend implementers can't omit them.
    const schema = pairingDoc.components?.schemas?.["TerminalPairResponse"];
    const required = (schema?.["required"] ?? []) as string[];
    expect(required).not.toContain("expires_at");

    const props = schema?.["properties"] as
      | Record<string, { type?: string; format?: string; nullable?: boolean }>
      | undefined;
    expect(props?.["expires_at"]?.format).toBe("date-time");
    expect(props?.["expires_at"]?.nullable).toBe(true);
  });
});

// ===========================================================================
// 8. New fields from POS-Pulse Slice 1 closeout-gap audit (2026-05-28)
// ===========================================================================
describe("pos-terminal-pairing.yaml — Slice 1 closeout-gap fields (branch + tax detail)", () => {
  it("branch_name is a bounded-length non-empty string", () => {
    const schema = pairingDoc.components?.schemas?.["TerminalPairResponse"];
    const props = schema?.["properties"] as
      | Record<string, { type?: string; minLength?: number }>
      | undefined;
    expect(props?.["branch_name"]?.type).toBe("string");
    expect(props?.["branch_name"]?.minLength).toBeGreaterThanOrEqual(1);
  });

  it("branch_address is a bounded-length non-empty string", () => {
    const schema = pairingDoc.components?.schemas?.["TerminalPairResponse"];
    const props = schema?.["properties"] as
      | Record<string, { type?: string; minLength?: number }>
      | undefined;
    expect(props?.["branch_address"]?.type).toBe("string");
    expect(props?.["branch_address"]?.minLength).toBeGreaterThanOrEqual(1);
  });

  it("tenant_tax_registration_id is a bounded-length string (Egyptian Tax Authority + forward-compat)", () => {
    // Stored as string (not integer) for forward compatibility with
    // other jurisdictions and ETA spec evolution. Egyptian ETA format
    // is 9-digit numeric, but the contract is intentionally permissive
    // at the string level.
    const schema = pairingDoc.components?.schemas?.["TerminalPairResponse"];
    const props = schema?.["properties"] as
      | Record<string, { type?: string; minLength?: number }>
      | undefined;
    expect(props?.["tenant_tax_registration_id"]?.type).toBe("string");
    expect(props?.["tenant_tax_registration_id"]?.minLength).toBeGreaterThanOrEqual(1);
  });
});

// ===========================================================================
// 9. New fields from POS-Pulse Slice 3 prep audit (2026-05-28)
// ===========================================================================
describe("pos-terminal-pairing.yaml — Slice 3 prep audit fields (printer config)", () => {
  it("printer_vendor_id is a hex-string-pattern 4-digit USB vendor identifier", () => {
    const schema = pairingDoc.components?.schemas?.["TerminalPairResponse"];
    const props = schema?.["properties"] as
      | Record<string, { type?: string; pattern?: string }>
      | undefined;
    expect(props?.["printer_vendor_id"]?.type).toBe("string");
    expect(props?.["printer_vendor_id"]?.pattern).toBe("^0x[0-9A-Fa-f]{4}$");
  });

  it("printer_product_id is a hex-string-pattern 4-digit USB product identifier", () => {
    const schema = pairingDoc.components?.schemas?.["TerminalPairResponse"];
    const props = schema?.["properties"] as
      | Record<string, { type?: string; pattern?: string }>
      | undefined;
    expect(props?.["printer_product_id"]?.type).toBe("string");
    expect(props?.["printer_product_id"]?.pattern).toBe("^0x[0-9A-Fa-f]{4}$");
  });

  it("printer_com_port is OPTIONAL nullable string (RS-232 serial fallback)", () => {
    // The COM port is populated only when the printer is attached over
    // RS-232 serial instead of USB. NULL when USB-only. The field is
    // REQUIRED in the response (so the backend cannot silently drop
    // it) but NULLABLE (so backends with USB-only printers can send
    // NULL).
    const schema = pairingDoc.components?.schemas?.["TerminalPairResponse"];
    const required = (schema?.["required"] ?? []) as string[];
    expect(required).toContain("printer_com_port");

    const props = schema?.["properties"] as
      | Record<string, { type?: string; nullable?: boolean }>
      | undefined;
    expect(props?.["printer_com_port"]?.type).toBe("string");
    expect(props?.["printer_com_port"]?.nullable).toBe(true);
  });
});

// ===========================================================================
// 10. Failure-response coverage — all five mapped codes + validation
// ===========================================================================
describe("pos-terminal-pairing.yaml — failure-response coverage", () => {
  it("declares 400 / 404 / 409 / 410 / 429 response codes for posPairTerminal", () => {
    // POS-Pulse `src/main/pairing/failure-mapping.ts` routes:
    //   - 404 INVALID_CODE    -> 'invalid_code'
    //   - 410 EXPIRED_CODE    -> 'expired_code'
    //   - 409 ALREADY_PAIRED  -> 'already_paired'
    //   - 409 BRANCH_MISMATCH -> 'branch_mismatch'
    //   - 429 RATE_LIMITED    -> 'rate_limited'
    //   - 400 validation_failure -> 'unknown_error' (catch-all)
    // The contract MUST declare all five HTTP statuses so the
    // codegen-generated client (`openapi-typescript`) has the right
    // union for `PairResult.status`.
    const op = pairingDoc.paths?.[POS_PAIR_PATH]?.["post"];
    const responses = op?.responses ?? {};
    for (const code of ["400", "404", "409", "410", "429"] as const) {
      expect(responses[code]).toBeDefined();
    }
  });

  it("declares 200 success response", () => {
    const op = pairingDoc.paths?.[POS_PAIR_PATH]?.["post"];
    const responses = op?.responses ?? {};
    expect(responses["200"]).toBeDefined();
  });

  it("429 response declares the mandatory Retry-After integer header bounded [1, 300]", () => {
    // CR2 fix: a bare `expect(responses["429"]).toBeDefined()` check
    // would still pass if a future edit deletes the Retry-After header
    // or widens its bounds. POS-Pulse `src/main/pairing/network.ts:69-71`
    // clamps the parsed value to [1, 300] defensively; the contract
    // MUST declare the same bounds so the client clamp doesn't surface
    // surprising server behavior. Verify the header shape end-to-end.
    interface RetryAfterHeader {
      schema?: { type?: string; minimum?: number; maximum?: number };
    }
    interface ResponseObject {
      headers?: Record<string, RetryAfterHeader>;
    }
    const op = pairingDoc.paths?.[POS_PAIR_PATH]?.["post"];
    const r429 = op?.responses?.["429"] as ResponseObject | undefined;
    const retryAfter = r429?.headers?.["Retry-After"];
    expect(retryAfter).toBeDefined();
    expect(retryAfter?.schema?.type).toBe("integer");
    expect(retryAfter?.schema?.minimum).toBe(1);
    expect(retryAfter?.schema?.maximum).toBe(300);
  });
});

// ===========================================================================
// 11. RT-369 — device token rotation (contract-first)
// ===========================================================================
describe("pos-terminal-pairing.yaml — posRotateTerminalToken (RT-369)", () => {
  type RotateOperation = OperationObject & {
    tags?: string[];
    requestBody?: unknown;
    "x-idempotency"?: string;
    "x-runtime-status"?: string;
    "x-runtime-note"?: string;
  };
  interface ParameterRef {
    $ref?: string;
  }
  interface ResponseObject {
    headers?: Record<string, unknown>;
    content?: Record<string, { schema?: { $ref?: string } }>;
  }
  interface ParameterObject {
    name?: string;
    in?: string;
    required?: boolean;
    schema?: Record<string, unknown>;
  }

  const rotateOp = (): RotateOperation | undefined =>
    pairingDoc.paths?.[POS_ROTATE_PATH]?.["post"] as RotateOperation | undefined;

  const schema = (name: string): Record<string, unknown> =>
    pairingDoc.components?.schemas?.[name] ?? {};

  const responseSchemaRef = (status: string): string | undefined =>
    (rotateOp()?.responses?.[status] as ResponseObject | undefined)?.content?.[
      "application/json"
    ]?.schema?.$ref;

  it("is mounted at POST /api/pos/v1/terminals/rotate under the pos-terminal-pairing tag", () => {
    expect(rotateOp()?.operationId).toBe(ROTATE_OPERATION_ID);
    expect(rotateOp()?.tags).toEqual(["pos-terminal-pairing"]);
  });

  it("is served by the RT-369 runtime (no contract-only marker)", () => {
    expect(rotateOp()?.["x-runtime-status"]).toBeUndefined();
    expect(rotateOp()?.["x-runtime-note"]).toBeUndefined();
  });

  it("is authenticated by the device bearer only", () => {
    expect(rotateOp()?.security).toEqual([{ device: [] }]);
  });

  it("reads no request body", () => {
    expect(rotateOp()?.requestBody).toBeUndefined();
  });

  it("requires a non-replayable Idempotency-Key header", () => {
    expect(rotateOp()?.["x-idempotency"]).toBe("required");
    const refs = (rotateOp()?.parameters ?? []) as ParameterRef[];
    expect(refs).toEqual([{ $ref: "#/components/parameters/IdempotencyKey" }]);
    const param = (
      pairingDoc.components as { parameters?: Record<string, ParameterObject> } | undefined
    )?.parameters?.["IdempotencyKey"];
    expect(param).toMatchObject({ name: "Idempotency-Key", in: "header", required: true });
    expect(param?.schema).toMatchObject({ type: "string", minLength: 16, maxLength: 128 });
  });

  it("declares exactly 200 / 400 / 401 / 409 / 425 / 429 / 500", () => {
    expect(Object.keys(rotateOp()?.responses ?? {}).sort()).toEqual(
      ["200", "400", "401", "409", "425", "429", "500"].sort(),
    );
  });

  it("answers 200 with TerminalRotateResponse and every error with its own RotateError", () => {
    expect(responseSchemaRef("200")).toBe("#/components/schemas/TerminalRotateResponse");
    for (const status of ["400", "401", "409", "429", "500"]) {
      expect(responseSchemaRef(status)).toBe("#/components/schemas/RotateError");
    }
    expect(responseSchemaRef("425")).toBe("#/components/schemas/IdempotencyInProgress");
  });

  it("425 declares Retry-After", () => {
    const r425 = rotateOp()?.responses?.["425"] as ResponseObject | undefined;
    expect(r425?.headers?.["Retry-After"]).toBeDefined();
  });

  it("429 declares Retry-After bounded [1, 300], as the pair 429", () => {
    const r429 = rotateOp()?.responses?.["429"] as
      | { headers?: Record<string, { schema?: Record<string, unknown> }> }
      | undefined;
    expect(r429?.headers?.["Retry-After"]?.schema).toEqual({ type: "integer", minimum: 1, maximum: 300 });
  });

  it("marks the 200 Cache-Control: no-store and Pragma: no-cache (the body carries a secret)", () => {
    const ok = rotateOp()?.responses?.["200"] as { headers?: Record<string, unknown> } | undefined;
    expect(ok?.headers?.["Cache-Control"]).toEqual({ $ref: "#/components/headers/CacheControlNoStore" });
    expect(ok?.headers?.["Pragma"]).toEqual({ $ref: "#/components/headers/PragmaNoCache" });
    const headers = (pairingDoc.components as { headers?: Record<string, { schema?: unknown }> } | undefined)
      ?.headers;
    expect(headers?.["CacheControlNoStore"]?.schema).toEqual({ type: "string", const: "no-store" });
    expect(headers?.["PragmaNoCache"]?.schema).toEqual({ type: "string", const: "no-cache" });
  });

  it("TerminalRotateResponse is closed and requires the token, terminal id, expiry and hint", () => {
    const s = schema("TerminalRotateResponse") as {
      additionalProperties?: unknown;
      required?: string[];
      properties?: Record<string, Record<string, unknown>>;
    };
    expect(s.additionalProperties).toBe(false);
    expect([...(s.required ?? [])].sort()).toEqual(
      ["device_token", "expires_at", "rotate_after", "terminal_id"].sort(),
    );
    expect(Object.keys(s.properties ?? {}).sort()).toEqual(
      ["device_token", "expires_at", "rotate_after", "terminal_id"].sort(),
    );
    expect(s.properties?.["device_token"]).toMatchObject({
      type: "string",
      minLength: 32,
      maxLength: 512,
    });
    expect(s.properties?.["terminal_id"]).toMatchObject({ type: "string", format: "uuid" });
    expect(s.properties?.["expires_at"]).toMatchObject({ type: "string", format: "date-time" });
    expect(s.properties?.["rotate_after"]).toMatchObject({ type: "string", format: "date-time" });
  });

  it("RotateError is closed with its own error.code set; the pairing Error enum is unchanged", () => {
    const s = schema("RotateError") as {
      additionalProperties?: unknown;
      properties?: {
        error?: {
          additionalProperties?: unknown;
          properties?: { code?: { enum?: string[] } };
        };
      };
    };
    expect(s.additionalProperties).toBe(false);
    expect(s.properties?.error?.additionalProperties).toBe(false);
    expect([...(s.properties?.error?.properties?.code?.enum ?? [])].sort()).toEqual(
      [
        "unauthorized",
        "idempotency_key_required",
        "idempotency_key_malformed",
        "idempotency_key_conflict",
        "RATE_LIMITED",
        "internal_error",
      ].sort(),
    );
  });

  /** The contract's rotation prose: the info description plus the operation's, whitespace-normalised. */
  const prose = (): string =>
    [(pairingDoc.info as { description?: string } | undefined)?.description, (rotateOp() as { description?: string } | undefined)?.description]
      .join(" ")
      .replace(/\s+/g, " ");

  it("names both RT-369 audit actions (RT-135 catalogue)", () => {
    expect(prose()).toContain("pos.device.rotated");
    expect(prose()).toContain("pos.device.rotation_rejected");
  });

  it("pins the ratified constants: 90 days, 10 minutes, 7 days, 15 days", () => {
    const text = prose();
    expect(text).toContain("`expires_at` becomes `now() + 90 days`");
    expect(text).toMatch(/`previous_valid_until = now\(\) \+ 10 minutes`/);
    expect(text).toContain("`now() < expires_at + 7 days`");
    expect(text).toContain("`rotate_after = expires_at - 15 days`");
  });

  it("states the window is never extended and the grace is rotate-only", () => {
    const text = prose();
    expect(text).toContain("the window is never extended");
    expect(text).toMatch(/rotate-only grace/);
    expect(text).toContain("this operation is the ONLY one that reads `expires_at`");
  });

  it("keeps tokens, hashes and keys out of audit and uses unambiguous rejection reasons", () => {
    const text = prose();
    expect(text).toContain("Neither row ever carries a token, a token hash, an `Idempotency-Key` or a request header");
    for (const reason of ["revoked", "retired", "previous_expired", "token_replaced", "grace_elapsed"]) {
      expect(text).toContain(`\`${reason}\``);
    }
    expect(text).not.toContain("superseded");
  });

  it("states the client rules (one rotation in flight, first-start rotation) and the previous-token trade-off", () => {
    const text = prose();
    expect(text).toContain("at most one rotation in flight");
    expect(text).toContain("never rotates with the previous token once it has stored a 200");
    expect(text).toContain("rotates once on its first start with the rotation client");
    expect(text).toContain("a leaked previous token can rotate the device");
  });

  it("documents the per-device rate limit before the idempotency checks", () => {
    const text = prose();
    expect(text).toContain("429 `RATE_LIMITED`");
    expect(text).toContain("per-device rotation budget");
  });
});
