/**
 * apps/api/test/auth-contract-cleanup/auth-contract-cleanup.contract.spec.ts
 *
 * Spec 030 — Auth Contract Cleanup (role-named security schemes, additive).
 *
 * This is the dedicated conformance spec for the 030 intended end-state. It is
 * authored RED-first (before the contract edits) so the failing assertions
 * prove the *intended* target, not the incidental breakage of older specs.
 *
 * What it asserts (per specs/030-auth-contract-cleanup/{spec,plan,tasks}.md):
 *
 * IMPORTANT — per-operation runtime confirmation (T2/T3, plan Phase 0, G-6):
 * the spec's pre-flight ANCHORS classified unknown-items `posCaptureItem` and
 * pos-audit-events `posAuditEventsSync` as `device`. Tracing the WIRED guards
 * (the additive guarantee — the new name must match the credential the runtime
 * verifies TODAY) refuted that for both, so they are reclassified DEFER:
 *   - read-down (`PosDeviceAuthGuard`) verifies an opaque DEVICE pairing token
 *     (NOT a JWT) → `device` is honest. CONFIRMED device.
 *   - unknown-items `posCaptureItem` (`PosOperatorAuthGuard`) requires a
 *     `pos_operator`-scoped OPAQUE OPERATOR-SESSION token — neither a device
 *     token nor a JWT, and entangled with the 028 D2 phantom-`pos_operator`
 *     drift → ambiguous → DEFER (keep `clerkJwt`).
 *   - pos-audit-events `posAuditEventsSync`: the OpenAPI `security` scheme
 *     models the `Authorization: Bearer` credential, and that bearer is
 *     verified by `ClerkVerifier`/JWKS = a genuine Clerk JWT (the device gate
 *     is the BODY `device_token_attestation`, which no security scheme
 *     represents). `clerkJwt` (bearerFormat: JWT) was already HONEST → renaming
 *     to a no-JWT `device` would be a DOC-3 violation → DEFER (keep `clerkJwt`).
 * The owner/orchestrator owns whether these two land a role-named scheme later
 * (with the D1/D2 work); 030 must not assert an unverified credential format.
 *
 *   T3/T4     device surface — catalog/read-down.yaml (2 ops) re-points its
 *             active `clerkJwt` reference to a role-named `device` scheme.
 *   T6        operator-identity surfaces — pos-operators.openapi.yaml (5 ops,
 *             Clerk-JWT-verified), pos-shifts.openapi.yaml (1 op,
 *             Clerk-JWT-verified), and the non-sale pos-payments/vouchers.yaml
 *             ops (3 ops + the document-level default; contract-only, declared
 *             `bearerFormat: JWT`, sibling of the JWT-verified surfaces)
 *             re-point to a role-named `operator-identity` scheme.
 *   T4        `device`  = http bearer, NO `bearerFormat: JWT`, opaque
 *             device-scoped token, never proves sale ownership alone.
 *   T6        `operator-identity` = http bearer, `bearerFormat: JWT`, identity
 *             proof / sign-in evidence only — NOT business authorization;
 *             provider (Clerk) named only in prose.
 *   T7        DEFER set — sales.yaml capture/void/refund/readSale (Option-Y),
 *             unknown-items `posCaptureItem` (D2 opaque operator token), and
 *             pos-audit-events `posAuditEventsSync` (genuine Clerk JWT) STAY on
 *             `clerkJwt` (negative fence), each carrying a deferral note.
 *   T8        connector/erpnext surfaces carry NO active `clerkJwt`, no `device`
 *             scheme, and no `service` scheme — they are already role-named
 *             (connectorBearer / cookieAuth) and unchanged.
 *   T9        `clerkJwt` securityScheme DEFINITION is retired only from the
 *             contracts whose every active ref is re-pointed (read-down,
 *             pos-operators, pos-shifts, vouchers); KEPT on sales.yaml,
 *             unknown-items.yaml, and pos-audit-events.openapi.yaml.
 *   T10       every edited doc parses; no `security:` entry references a removed
 *             scheme; exactly TWO new schemes (device + operator-identity);
 *             no third (`service`) scheme anywhere.
 *   T11       no-G3 / no-migration / connector-untouched negative tests via
 *             `git status --porcelain` (catches untracked files too).
 *
 * Pure load/parse + static-tree assertions — no app boot, no HTTP, no WSL.
 */
import "reflect-metadata";

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

import { loadOpenApiContracts } from "../../src/openapi/loader";

// ---------------------------------------------------------------------------
// Narrow OpenAPI view — the loader returns `unknown` documents.
// ---------------------------------------------------------------------------

interface OperationObject {
  operationId?: string;
  security?: Array<Record<string, unknown>>;
  description?: string;
}

type SecurityRequirement = Record<string, unknown>;

interface SecuritySchemeObject {
  type?: string;
  scheme?: string;
  bearerFormat?: string;
  description?: string;
  in?: string;
  name?: string;
}

interface OpenApiDocument {
  openapi?: string;
  info?: { title?: string; version?: string; description?: string };
  paths?: Record<string, Record<string, OperationObject>>;
  components?: {
    securitySchemes?: Record<string, SecuritySchemeObject>;
  };
  security?: SecurityRequirement[];
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(__dirname, "..", "..", "..", "..");

function openapiDir(...sub: string[]): string {
  return resolve(REPO_ROOT, "packages", "contracts", "openapi", ...sub);
}

/** Load a single contract by id from a given openapi sub-directory. */
function loadDoc(dirParts: string[], id: string): OpenApiDocument {
  const dir = openapiDir(...dirParts);
  const found = loadOpenApiContracts({ dir }).find((c) => c.id === id);
  if (!found) {
    throw new Error(`contract '${id}' not found under ${dir}`);
  }
  return found.document as OpenApiDocument;
}

function operations(doc: OpenApiDocument): OperationObject[] {
  const out: OperationObject[] = [];
  for (const item of Object.values(doc.paths ?? {})) {
    for (const op of Object.values(item)) {
      if (op && typeof op === "object") out.push(op);
    }
  }
  return out;
}

/** All security-requirement keys referenced anywhere (doc-level + per-op). */
function referencedSchemeNames(doc: OpenApiDocument): Set<string> {
  const names = new Set<string>();
  const collect = (reqs: SecurityRequirement[] | undefined): void => {
    for (const req of reqs ?? []) {
      for (const key of Object.keys(req)) names.add(key);
    }
  };
  collect(doc.security);
  for (const op of operations(doc)) collect(op.security);
  return names;
}

function definedSchemeNames(doc: OpenApiDocument): Set<string> {
  return new Set(Object.keys(doc.components?.securitySchemes ?? {}));
}

function findOp(doc: OpenApiDocument, operationId: string): OperationObject {
  const op = operations(doc).find((o) => o.operationId === operationId);
  if (!op) throw new Error(`operation '${operationId}' not found`);
  return op;
}

function refsScheme(op: OperationObject, scheme: string): boolean {
  return (op.security ?? []).some((req) =>
    Object.prototype.hasOwnProperty.call(req, scheme),
  );
}

// ---------------------------------------------------------------------------
// Surface inventory (per spec §4 scope fence, re-verified by grep this session)
// ---------------------------------------------------------------------------

const DEVICE_SCHEME = "device";
const OPERATOR_SCHEME = "operator-identity";

// device-classified operations (CONFIRMED `PosDeviceAuthGuard` = opaque device
// pairing token, NOT a JWT): [dir parts, contract id, operationId]
const DEVICE_OPS: Array<[string[], string, string]> = [
  [["catalog"], "read-down", "posGetCatalogSnapshot"],
  [["catalog"], "read-down", "posGetCatalogDeltas"],
];

// operator-identity-classified operations (CONFIRMED Clerk-JWT-verified, or —
// for the contract-only vouchers — declared `bearerFormat: JWT` and a sibling
// of the JWT-verified surfaces it cross-references):
const OPERATOR_OPS: Array<[string[], string, string]> = [
  [[], "pos-operators.openapi", "posOperatorSignIn"],
  [[], "pos-operators.openapi", "posOperatorSignOut"],
  [[], "pos-operators.openapi", "posOperatorRoster"],
  [[], "pos-operators.openapi", "posOperatorTakeoverConfirm"],
  [[], "pos-operators.openapi", "posOperatorActiveSession"],
  [[], "pos-shifts.openapi", "posShiftsGetStuck"],
  [["pos-payments"], "vouchers", "posValidateVoucher"],
  [["pos-payments"], "vouchers", "posRedeemVoucher"],
  [["pos-payments"], "vouchers", "posReverseVoucher"],
];

// Contracts whose clerkJwt scheme DEFINITION must be fully retired (T9) —
// only those whose every active ref is re-pointed.
const FULLY_MIGRATED_CONTRACTS: Array<[string[], string]> = [
  [["catalog"], "read-down"],
  [[], "pos-operators.openapi"],
  [[], "pos-shifts.openapi"],
  [["pos-payments"], "vouchers"],
];

// DEFER surfaces (T7) — STAY on `clerkJwt`, each with a deferral note.
// [dir parts, contract id, operationIds...]
const DEFER_SURFACES: Array<{
  dirParts: string[];
  id: string;
  ops: string[];
  reason: RegExp;
}> = [
  // NOTE: pos-sales/sales was a DEFER surface in 030 (sale-sync stayed on
  // `clerkJwt` pending the D1 operator-authorization envelope). Spec 031 (D1+D2)
  // LANDED that envelope — the sale routes now use `operatorAuthorization` — so
  // sales is no longer a clerkJwt DEFER surface and is removed from this fence.
  // Its post-031 scheme is asserted by
  // test/catalog/sales/contract/sales.contract.spec.ts. (DOC-3 co-travel: 031
  // resolves 030's deferral, so 031 updates 030's deferral fence.)
  // unknown-items posCaptureItem: opaque `pos_operator` operator-session token
  // (PosOperatorAuthGuard), 028 D2 phantom-scope drift — ambiguous, DEFER.
  {
    dirParts: ["catalog"],
    id: "unknown-items",
    ops: ["posCaptureItem"],
    reason: /d2|operator-session|pos_operator/,
  },
  // pos-audit-events posAuditEventsSync: the Authorization bearer is a genuine
  // Clerk JWT (ClerkVerifier/JWKS); the device gate is the body attestation.
  {
    dirParts: [],
    id: "pos-audit-events.openapi",
    ops: ["posAuditEventsSync"],
    reason: /clerk jwt|jwks|d1|deferral/,
  },
];

// Connector / erpnext surfaces (T8) — must stay untouched & service-free.
const CONNECTOR_CONTRACTS: Array<[string[], string]> = [
  [["catalog"], "erpnext-item-map"],
  [["catalog"], "erpnext-warehouse-map"],
  [["catalog"], "product-reconciliation"],
  [["connector"], "connector-admin"],
  [["erpnext-connector"], "posting-feed"],
  [["erpnext-connector"], "stock-view"],
  [["erpnext-reconciliation"], "reconciliation"],
  [["erpnext-sync-ops"], "console-sync-ops"],
];

// The 8 connector/erpnext file paths relative to repo root (for the git fence).
const CONNECTOR_FILE_PATHS = [
  "packages/contracts/openapi/catalog/erpnext-item-map.yaml",
  "packages/contracts/openapi/catalog/erpnext-warehouse-map.yaml",
  "packages/contracts/openapi/catalog/product-reconciliation.yaml",
  "packages/contracts/openapi/connector/connector-admin.yaml",
  "packages/contracts/openapi/erpnext-connector/posting-feed.yaml",
  "packages/contracts/openapi/erpnext-connector/stock-view.yaml",
  "packages/contracts/openapi/erpnext-reconciliation/reconciliation.yaml",
  "packages/contracts/openapi/erpnext-sync-ops/console-sync-ops.yaml",
];

// ===========================================================================
// T3/T4 — the confirmed device surface (read-down) uses the `device` scheme
// ===========================================================================
describe("030 — device-classified POS surface (read-down) uses the `device` scheme", () => {
  it.each(DEVICE_OPS)(
    "%s/%s#%s references `device` and not `clerkJwt`",
    (dirParts, id, opId) => {
      const doc = loadDoc(dirParts as string[], id as string);
      const op = findOp(doc, opId as string);
      expect(refsScheme(op, DEVICE_SCHEME)).toBe(true);
      expect(refsScheme(op, "clerkJwt")).toBe(false);
    },
  );

  it("the `device` scheme is http bearer with NO `bearerFormat: JWT` (opaque token)", () => {
    const doc = loadDoc(["catalog"], "read-down");
    const scheme = doc.components?.securitySchemes?.[DEVICE_SCHEME];
    expect(scheme).toBeDefined();
    expect(scheme?.type).toBe("http");
    expect(scheme?.scheme).toBe("bearer");
    expect(scheme?.bearerFormat).toBeUndefined();
  });

  it("the `device` scheme description names it device-scoped, never sale-ownership-proving", () => {
    const doc = loadDoc(["catalog"], "read-down");
    const desc = (
      doc.components?.securitySchemes?.[DEVICE_SCHEME]?.description ?? ""
    ).toLowerCase();
    expect(desc).toContain("device");
    // role-honesty: the credential never proves sale ownership alone (028 CM-2)
    expect(desc).toContain("never proves sale ownership alone");
  });

  it("read-down is the ONLY contract that defines the `device` scheme", () => {
    // The two reclassified-to-DEFER surfaces (unknown-items, pos-audit-events)
    // must NOT define a `device` scheme — their runtime credential is not an
    // opaque device token (operator-session token / Clerk JWT respectively).
    for (const [dirParts, id] of [
      [["catalog"], "unknown-items"],
      [[], "pos-audit-events.openapi"],
    ] as Array<[string[], string]>) {
      const doc = loadDoc(dirParts, id);
      expect(definedSchemeNames(doc).has(DEVICE_SCHEME)).toBe(false);
      expect(referencedSchemeNames(doc).has(DEVICE_SCHEME)).toBe(false);
    }
  });
});

// ===========================================================================
// T6 — operator-identity surfaces re-pointed to the `operator-identity` scheme
// ===========================================================================
describe("030 — operator-identity POS surfaces use the `operator-identity` scheme", () => {
  it.each(OPERATOR_OPS)(
    "%s/%s#%s references `operator-identity` and not `clerkJwt`",
    (dirParts, id, opId) => {
      const doc = loadDoc(dirParts as string[], id as string);
      const op = findOp(doc, opId as string);
      // An op may inherit the doc-level default (e.g. vouchers), so accept
      // EITHER an op-level ref OR a doc-level default — but never clerkJwt.
      const opOrDoc =
        refsScheme(op, OPERATOR_SCHEME) ||
        referencedSchemeNames(doc).has(OPERATOR_SCHEME);
      expect(opOrDoc).toBe(true);
      expect(refsScheme(op, "clerkJwt")).toBe(false);
    },
  );

  it("vouchers re-points its document-level default to `operator-identity` (not clerkJwt)", () => {
    const doc = loadDoc(["pos-payments"], "vouchers");
    const docLevel = doc.security ?? [];
    expect(
      docLevel.some((r) =>
        Object.prototype.hasOwnProperty.call(r, OPERATOR_SCHEME),
      ),
    ).toBe(true);
    expect(
      docLevel.some((r) => Object.prototype.hasOwnProperty.call(r, "clerkJwt")),
    ).toBe(false);
  });

  it("the `operator-identity` scheme is http bearer with `bearerFormat: JWT`", () => {
    for (const [dirParts, id] of [
      [[], "pos-operators.openapi"],
      [[], "pos-shifts.openapi"],
      [["pos-payments"], "vouchers"],
    ] as Array<[string[], string]>) {
      const doc = loadDoc(dirParts, id);
      const scheme = doc.components?.securitySchemes?.[OPERATOR_SCHEME];
      expect(scheme).toBeDefined();
      expect(scheme?.type).toBe("http");
      expect(scheme?.scheme).toBe("bearer");
      expect(scheme?.bearerFormat).toBe("JWT");
    }
  });

  it("the `operator-identity` description states identity-proof-only, not business authorization", () => {
    const doc = loadDoc([], "pos-operators.openapi");
    const desc = (
      doc.components?.securitySchemes?.[OPERATOR_SCHEME]?.description ?? ""
    ).toLowerCase();
    expect(desc).toContain("identity proof");
    expect(desc).toContain("not business authorization");
  });
});

// ===========================================================================
// T9 — clerkJwt scheme DEFINITION retired from every fully-migrated contract
// ===========================================================================
describe("030 — clerkJwt scheme retired from fully-migrated POS contracts (T9)", () => {
  it.each(FULLY_MIGRATED_CONTRACTS)(
    "%s/%s no longer defines or references the `clerkJwt` scheme",
    (dirParts, id) => {
      const doc = loadDoc(dirParts as string[], id as string);
      expect(definedSchemeNames(doc).has("clerkJwt")).toBe(false);
      expect(referencedSchemeNames(doc).has("clerkJwt")).toBe(false);
    },
  );

  it("read-down is fully migrated: defines `device`, not `clerkJwt`", () => {
    const doc = loadDoc(["catalog"], "read-down");
    expect(definedSchemeNames(doc).has(DEVICE_SCHEME)).toBe(true);
    expect(definedSchemeNames(doc).has("clerkJwt")).toBe(false);
  });
});

// ===========================================================================
// T7 — DEFER fence: unknown-items + audit-events stay on clerkJwt
// (sales migrated to operatorAuthorization in 031 — no longer a DEFER surface)
// ===========================================================================
describe("030 — DEFER surfaces stay on clerkJwt (T7 negative fence)", () => {
  it.each(
    DEFER_SURFACES.flatMap(({ dirParts, id, ops }) =>
      ops.map((op) => [dirParts, id, op] as [string[], string, string]),
    ),
  )(
    "%s/%s#%s still references `clerkJwt` (NOT device, NOT operator-identity)",
    (dirParts, id, opId) => {
      const doc = loadDoc(dirParts as string[], id as string);
      const op = findOp(doc, opId as string);
      expect(refsScheme(op, "clerkJwt")).toBe(true);
      expect(refsScheme(op, DEVICE_SCHEME)).toBe(false);
      expect(refsScheme(op, OPERATOR_SCHEME)).toBe(false);
    },
  );

  it.each(DEFER_SURFACES.map((s) => [s.dirParts, s.id] as [string[], string]))(
    "%s/%s still DEFINES `clerkJwt` and introduces NO role-named scheme",
    (dirParts, id) => {
      const defined = definedSchemeNames(loadDoc(dirParts as string[], id as string));
      expect(defined.has("clerkJwt")).toBe(true);
      expect(defined.has(DEVICE_SCHEME)).toBe(false);
      expect(defined.has(OPERATOR_SCHEME)).toBe(false);
    },
  );

  it.each(
    DEFER_SURFACES.map(
      (s) => [s.dirParts, s.id, s.reason] as [string[], string, RegExp],
    ),
  )(
    "%s/%s carries a deferral note explaining why it stays on clerkJwt",
    (dirParts, id, reason) => {
      const doc = loadDoc(dirParts as string[], id as string);
      const haystack = [
        doc.info?.description ?? "",
        doc.components?.securitySchemes?.["clerkJwt"]?.description ?? "",
      ]
        .join("\n")
        .toLowerCase();
      expect(haystack).toMatch(reason);
    },
  );

  it("sales.yaml resolved the D1 / 028 DOC-3 deferral — now on operatorAuthorization, NOT clerkJwt (031)", () => {
    // 030 originally asserted sales carried a DEFER handoff note (sale-sync
    // stays on clerkJwt pending D1). Spec 031 LANDED D1 — sale-sync now uses the
    // operator-authorization envelope. So the post-031 invariant is the inverse:
    // sales no longer defines clerkJwt, and defines operatorAuthorization.
    const doc = loadDoc(["pos-sales"], "sales");
    const defined = definedSchemeNames(doc);
    expect(defined.has("clerkJwt")).toBe(false);
    expect(defined.has("operatorAuthorization")).toBe(true);
    // The header prose records the resolution (DOC-3 co-travel), not a deferral.
    const desc = (doc.info?.description ?? "").toLowerCase();
    expect(desc).toContain("operatorauthorization");
    expect(desc).toMatch(/031|d1/);
  });

  it("unknown-items KEEPS both `clerkJwt` (posCaptureItem) and `cookieAuth` (dashboard ops)", () => {
    const doc = loadDoc(["catalog"], "unknown-items");
    const defined = definedSchemeNames(doc);
    const referenced = referencedSchemeNames(doc);
    expect(defined.has("clerkJwt")).toBe(true);
    expect(referenced.has("clerkJwt")).toBe(true);
    expect(defined.has("cookieAuth")).toBe(true);
    expect(referenced.has("cookieAuth")).toBe(true);
  });

  it("pos-audit-events KEEPS the optional `{}` alternative alongside `clerkJwt`", () => {
    const doc = loadDoc([], "pos-audit-events.openapi");
    const op = findOp(doc, "posAuditEventsSync");
    expect(refsScheme(op, "clerkJwt")).toBe(true);
    expect(
      (op.security ?? []).some((req) => Object.keys(req).length === 0),
    ).toBe(true);
  });
});

// ===========================================================================
// T8 — connector/erpnext surfaces: no clerkJwt, no device, no `service` (negative)
// ===========================================================================
describe("030 — connector/erpnext surfaces are already role-named (T8 negative fence)", () => {
  it.each(CONNECTOR_CONTRACTS)(
    "%s/%s carries no active clerkJwt, no device, and no service scheme",
    (dirParts, id) => {
      const doc = loadDoc(dirParts as string[], id as string);
      const referenced = referencedSchemeNames(doc);
      const defined = definedSchemeNames(doc);
      // No ACTIVE clerkJwt reference (prose mentions in description are fine).
      expect(referenced.has("clerkJwt")).toBe(false);
      // 030 introduces NO `service` and NO `device` rename on these surfaces.
      expect(referenced.has("service")).toBe(false);
      expect(defined.has("service")).toBe(false);
      expect(referenced.has(DEVICE_SCHEME)).toBe(false);
      expect(defined.has(DEVICE_SCHEME)).toBe(false);
      // They remain role-named with one of the existing machine/human schemes.
      const stillRoleNamed =
        referenced.has("connectorBearer") || referenced.has("cookieAuth");
      expect(stillRoleNamed).toBe(true);
    },
  );
});

// ===========================================================================
// T10 — exactly TWO new schemes; no dangling refs; no third scheme
// ===========================================================================
describe("030 — exactly two new role-named schemes, no orphan refs (T10)", () => {
  const POS_EDITED: Array<[string[], string]> = [
    [["catalog"], "read-down"],
    [["catalog"], "unknown-items"],
    [[], "pos-audit-events.openapi"],
    [[], "pos-operators.openapi"],
    [[], "pos-shifts.openapi"],
    [["pos-payments"], "vouchers"],
  ];

  it("every edited POS doc has no `security:` entry referencing an undefined scheme", () => {
    for (const [dirParts, id] of POS_EDITED) {
      const doc = loadDoc(dirParts, id);
      const defined = definedSchemeNames(doc);
      for (const referenced of referencedSchemeNames(doc)) {
        // The empty `{}` requirement has no key, so referencedSchemeNames
        // never yields one; every remaining name must resolve to a definition.
        expect(defined.has(referenced)).toBe(true);
      }
    }
  });

  it("the only NEW scheme names introduced across all POS contracts are device + operator-identity", () => {
    // Gather every scheme name defined across the edited POS contracts + sales.
    const ALL_POS: Array<[string[], string]> = [
      ...POS_EDITED,
      [["pos-sales"], "sales"],
      [[], "pos-terminal-pairing.openapi"],
    ];
    const allDefined = new Set<string>();
    for (const [dirParts, id] of ALL_POS) {
      for (const name of definedSchemeNames(loadDoc(dirParts, id))) {
        allDefined.add(name);
      }
    }
    // Pre-existing POS schemes 030 must NOT invent/remove wholesale:
    //   clerkJwt (kept on unknown-items + pos-audit-events, the remaining DEFER
    //   surfaces; sales migrated to operatorAuthorization in 031) and cookieAuth
    //   (kept on unknown-items dashboard ops).
    expect(allDefined.has("clerkJwt")).toBe(true);
    expect(allDefined.has("cookieAuth")).toBe(true);
    // The two role-named schemes 030 introduced:
    expect(allDefined.has(DEVICE_SCHEME)).toBe(true);
    expect(allDefined.has(OPERATOR_SCHEME)).toBe(true);
    // 031 (D1+D2) additionally introduced the sale-sync authorization envelope
    // scheme on pos-sales/sales — a real, expected scheme (NOT 030's, NOT
    // speculative). It is distinct from operator-identity (identity-proof-only).
    expect(allDefined.has("operatorAuthorization")).toBe(true);
    // No speculative `service` scheme (the one 030 explicitly refused):
    expect(allDefined.has("service")).toBe(false);
  });
});

// ===========================================================================
// T11 — no-G3 / no-migration / connector-untouched fences (git-backed)
// ===========================================================================
describe("030 — diff touches only contracts; no migration, no source, no connector (T11)", () => {
  function changedPaths(): string[] {
    // `git status --porcelain` lists tracked changes AND untracked files,
    // so a stray new `.sql` or `apps/api/src/**` file is caught even though
    // this slice commits nothing. Format: "XY <path>" (paths use `/`).
    const out = execFileSync("git", ["status", "--porcelain"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    return out
      .split("\n")
      .map((line) => line.replace(/[\r\n]+$/, ""))
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        // Drop the 2-char XY status prefix + following space(s); handle
        // renames "old -> new" by taking the destination path.
        const rest = line.slice(2).trimStart();
        const arrow = rest.split(" -> ");
        return (arrow[1] ?? arrow[0]!).replace(/^"|"$/g, "");
      });
  }

  it("introduces NO `.sql` migration file (no-G3 fence)", () => {
    const offenders = changedPaths().filter((p) => p.endsWith(".sql"));
    expect(offenders).toEqual([]);
  });

  it("changes NO guard/verifier source under apps/api/src/** (contract-only fence)", () => {
    const offenders = changedPaths().filter((p) =>
      p.startsWith("apps/api/src/"),
    );
    expect(offenders).toEqual([]);
  });

  it("changes NONE of the 8 connector/erpnext contract files (T8 byte-fence)", () => {
    const changed = new Set(changedPaths());
    const offenders = CONNECTOR_FILE_PATHS.filter((p) => changed.has(p));
    expect(offenders).toEqual([]);
  });

  it("changes ONLY OpenAPI YAML contracts + contract specs (no stray surface)", () => {
    const offenders = changedPaths().filter((p) => {
      const isContractYaml =
        p.startsWith("packages/contracts/openapi/") &&
        (p.endsWith(".yaml") || p.endsWith(".yml"));
      const isThisSliceTest = p.startsWith(
        "apps/api/test/auth-contract-cleanup/",
      );
      // Existing conformance specs updated to the new convention are allowed
      // (read-down / unknown-items / vouchers).
      const isContractSpec =
        p.startsWith("apps/api/test/") &&
        (p.endsWith("contract.spec.ts") ||
          p.endsWith("contract-wave2.spec.ts"));
      return !isContractYaml && !isThisSliceTest && !isContractSpec;
    });
    expect(offenders).toEqual([]);
  });
});
