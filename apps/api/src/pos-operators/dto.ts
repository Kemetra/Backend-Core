/**
 * POS-Operators DTOs — Wave 1 sign-in + Wave 3 roster/takeover/active-session.
 *
 * Source of truth: `packages/contracts/openapi/pos-operators.openapi.yaml`.
 *
 * Wave 1 — sign-in body mirrors `PosOperatorSignInRequest`:
 *   - `kind` is a literal — only "manager_admin" is admitted in Wave 1.
 *   - `device_token_attestation` is a non-empty string (terminal-side proof
 *     of possession of the paired device token).
 *   - `branch_id` is **not** a body field — it is resolved server-side from
 *     the device-token claim. Including it would be an additional property
 *     and rejected by `additionalProperties: false`.
 *
 * Wave 3 GET endpoints gate via the identity token only; the contract preamble references
 * the device-token header inherited from 001/002 boilerplate, but the GET
 * parameter schemas carry no device attestation surface.
 *
 * Forbidden fields (`password`, `identifier`, `pin`, `cashier`,
 * `clerk_session_token`, `branch_id`) are not declared and are rejected
 * via Zod's `.strict()` (= OpenAPI `additionalProperties: false`).
 */
import { z } from "zod";

export const PosOperatorSignInSchema = z
  .object({
    kind: z.literal("manager_admin"),
    device_token_attestation: z.string().min(1),
  })
  .strict();

export type PosOperatorSignInInput = z.infer<typeof PosOperatorSignInSchema>;

/**
 * POS-facing operator role values. Mapped from the internal `roles.code`
 * vocabulary at the DTO/service boundary:
 *
 *   internal `owner`        → POS `admin`
 *   internal `tenant_admin` → POS `admin`
 *   internal `store_manager`→ POS `manager`
 *   internal `store_staff`  → INELIGIBLE for the `manager_admin` surface
 *
 * Internal vocabulary never appears in POS-facing payloads (FR-POS-AUTH-7
 * analogue for role names).
 */
export type PosOperatorRole = "manager" | "admin";

/** Conforms to OpenAPI `PosOperatorSummary`. */
export interface PosOperatorSummaryBody {
  /** The subject of the user's active identity link, NOT `users.id` (ADR D4). */
  id: string;
  /**
   * Provider-neutral identity key = `users.id` (028 §16). Distinct from `id`
   * (= `id`, the active link subject). Surfaced so POS can anchor local
   * operator-scoped records on a provider-independent identifier (033 / POS-017).
   */
  user_id: string;
  display_name: string;
  role: PosOperatorRole;
  /** Tenant UUID (server-internal IDs are visible here, but `branch_id` is the only POS-facing branch identifier). */
  tenant_id: string;
  /** Internal `store_id` surfaced as `branch_id` to POS callers (FR-POS-AUTH-7). */
  branch_id: string;
}

/** Conforms to OpenAPI `PosOperatorSessionSummary`. */
export interface PosOperatorSessionSummaryBody {
  id: string;
  issued_at: string;
  /**
   * The client-presentable operator-authorization ENVELOPE (031 D1, OQ-1 =
   * 1-A-i): the opaque `pos_operator` bearer the POS client presents on the
   * sale-sync routes; it resolves via the canonical `PosOperatorAuthGuard`.
   * Present on a fresh issue (sign-in + first takeover-confirm). **Null on an
   * idempotent takeover-confirm replay** — the raw token is hash-once and not
   * recoverable from the stored row, and a replay is the original client
   * retrying (it already holds the envelope from the first response).
   */
  envelope: string | null;
}

/** Conforms to OpenAPI `PosOperatorSignInSucceeded`. */
export interface PosOperatorSignInSucceededBody {
  kind: "signed_in";
  operator: PosOperatorSummaryBody;
  operator_session: PosOperatorSessionSummaryBody;
}

/** Conforms to OpenAPI `PosOperatorTakeoverRequired`. */
export interface PosOperatorTakeoverRequiredBody {
  kind: "takeover_required";
}

export type PosOperatorSignInResponseBody =
  | PosOperatorSignInSucceededBody
  | PosOperatorTakeoverRequiredBody;

/**
 * Sign-out request body. Source of truth:
 * `PosOperatorSignOutRequest` in `pos-operators.openapi.yaml`.
 *
 * The identity token is carried in `Authorization: Bearer <jwt>`, NOT in the
 * body. Forbidden fields (`password`, `pin`, `cashier`,
 * `clerk_session_token`, `device_token_attestation`, `branch_id`) are
 * rejected by `.strict()` (= OpenAPI `additionalProperties: false`).
 */
export const PosOperatorSignOutSchema = z
  .object({
    session_id: z.string().uuid(),
  })
  .strict();

export type PosOperatorSignOutInput = z.infer<typeof PosOperatorSignOutSchema>;

/** Conforms to OpenAPI `PosOperatorSignOutResponse`. */
export interface PosOperatorSignOutResponseBody {
  kind: "signed_out";
}

// ---------------------------------------------------------------------------
// Wave 3 — Roster
// ---------------------------------------------------------------------------

/**
 * Query params for GET /roster. `branch_id` is UUID-string; NestJS @Query()
 * delivers raw strings so UUID coercion is enforced at the service boundary.
 * Omitting branch_id causes the server to refuse (generic 401) because there
 * is no device attestation on GETs to resolve the branch independently.
 */
export const PosRosterQuerySchema = z
  .object({
    branch_id: z.string().uuid().optional(),
  })
  .strict();

export type PosRosterQueryInput = z.infer<typeof PosRosterQuerySchema>;

/** Conforms to OpenAPI `PosRosterCashierEntry`. */
export interface PosRosterCashierEntry {
  /** The subject of the user's active identity link. */
  id: string;
  /**
   * Provider-neutral identity key = `users.id` (028 §16). Distinct from `id`
   * (= `id`, the active link subject). Surfaced so POS can key local
   * cashier-scoped records (offline-PIN provisioning, POS-019/017) on a
   * provider-independent identifier.
   */
  user_id: string;
  display_name: string;
  role: "cashier";
}

/** Conforms to OpenAPI `PosRosterResponse`. */
export interface PosRosterResponseBody {
  cashiers: PosRosterCashierEntry[];
}

// ---------------------------------------------------------------------------
// Wave 3 — Takeover confirm
// ---------------------------------------------------------------------------

/**
 * Takeover confirmation body. Mirrors `PosTakeoverConfirmRequest`.
 * `event_id` is the client-side UUIDv4 dedup key.
 * Forbidden additional fields rejected by `.strict()`.
 */
export const PosTakeoverConfirmSchema = z
  .object({
    event_id: z.string().uuid(),
    operator_id: z.string().min(1),
    device_token_attestation: z.string().min(1),
  })
  .strict();

export type PosTakeoverConfirmInput = z.infer<typeof PosTakeoverConfirmSchema>;

// ---------------------------------------------------------------------------
// Wave 3 — Active session (minimum-disclosure)
// ---------------------------------------------------------------------------

/**
 * Query params for GET /active-session. `operator_id` is the active link subject
 * of the operator to check.
 */
export const PosActiveSessionQuerySchema = z
  .object({
    branch_id: z.string().uuid(),
    operator_id: z.string().min(1),
  })
  .strict();

export type PosActiveSessionQueryInput = z.infer<typeof PosActiveSessionQuerySchema>;

/** Conforms to OpenAPI `PosActiveSessionResponse`. */
export interface PosActiveSessionResponseBody {
  kind: "none" | "active";
}
