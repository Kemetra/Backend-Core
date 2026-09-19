/**
 * PosOperatorsService — Wave 1 sign-in/sign-out + Wave 3 roster/takeover/active-session.
 *
 * Wave 1 pipeline (every step on failure → typed `refused` result, mapped at
 * the controller boundary to the same generic 401 envelope; ADR D10):
 *
 *   1. Verify the Clerk JWT (signature, iss, aud, exp, nbf, iat).
 *   2. Resolve the local user by `users.clerk_user_id = sub`.
 *      Reject if missing, soft-deleted, or the column is unset (no JIT).
 *   3. Resolve the device by `device_token_attestation` (hash lookup),
 *      filter out revoked rows. The device row carries the canonical
 *      `(tenant_id, store_id)` scope.
 *   4. Resolve the operator's membership in that tenant; the membership
 *      role MUST be one of {owner, tenant_admin, store_manager}. Soft-
 *      deleted or revoked memberships are rejected.
 *   5. Confirm store eligibility:
 *      - `store_access_kind = 'all'` → eligible for any store in the
 *        tenant (PR-3 schema does not gate this further);
 *      - `store_access_kind = 'specific'` → eligible only if `store_access`
 *        contains `(membership_id, store_id)`.
 *   6. (Wave 1) Detect existing active POS operator session for the
 *      same `(device, store)` and return `takeover_required` instead of
 *      issuing a new session.
 *   7. Otherwise issue a new `auth_tokens` row with scope `pos_operator`
 *      bound to `(user_id, device_id, tenant_id, store_id)` and return
 *      its `id` + `issued_at` as the operator session summary. The
 *      `token_hash` column is populated with a server-internal opaque
 *      value that is **never** returned to the POS client (ADR D8 final
 *      paragraph).
 *
 * Wave 3 endpoints gate via Clerk JWT only (no device attestation on GET
 * endpoints). Takeover confirm re-uses the device attestation body field.
 *
 * No log line, audit row, or error message ever contains the Clerk JWT,
 * the device token attestation, the user's password hash, or any internal
 * secret (FR-POS-AUTH-10, FR-POS-AUTH-8).
 */
import { Injectable } from "@nestjs/common";
import { newId } from "@data-pulse-2/shared";
import type { Logger } from "@data-pulse-2/shared";
import { generateRawToken, hashToken } from "@data-pulse-2/auth";
import { insertAuditEvent, runWithTenantContext } from "@data-pulse-2/db";
import type { Pool } from "pg";

import type { ClerkVerifier } from "./clerk-verifier";
import { DeviceRepository } from "./device.repository";
import type {
  PosActiveSessionQueryInput,
  PosActiveSessionResponseBody,
  PosOperatorRole,
  PosOperatorSessionSummaryBody,
  PosOperatorSignInInput,
  PosOperatorSignInResponseBody,
  PosOperatorSignOutInput,
  PosOperatorSignOutResponseBody,
  PosOperatorSummaryBody,
  PosRosterQueryInput,
  PosRosterResponseBody,
  PosTakeoverConfirmInput,
} from "./dto";

/**
 * Default operator-session TTL. Wave 1 operator sessions are
 * server-side state with a fixed expiry; they are not refreshable
 * (FR-POS-AUTH-5). 8 hours is a working-shift-aligned default; the
 * deployment configuration story is deferred (open question §9).
 */
const OPERATOR_SESSION_TTL_MS = 8 * 60 * 60 * 1000;

/**
 * Internal role codes that may sign in via the `manager_admin` surface.
 * Values map to the POS-facing `manager` / `admin` enum at the response
 * boundary.
 */
const ELIGIBLE_INTERNAL_ROLES = new Set([
  "owner",
  "tenant_admin",
  "store_manager",
]);

function mapInternalRoleToPos(internalCode: string): PosOperatorRole | null {
  if (internalCode === "owner" || internalCode === "tenant_admin") return "admin";
  if (internalCode === "store_manager") return "manager";
  return null;
}

/**
 * Refusals producible by pipeline steps 2–5 (user → device → membership →
 * role → store eligibility). A strict subset of both SignInRefusalReason
 * and TakeoverRefusalReason.
 */
type DeviceAuthzRefusalReason =
  | "user_unmapped"
  | "user_disabled"
  | "device_invalid"
  | "membership_missing"
  | "membership_revoked"
  | "role_ineligible"
  | "store_not_in_access_set";

type DeviceRow = NonNullable<Awaited<ReturnType<DeviceRepository["findActiveByAttestation"]>>>;

/** Successful device-scoped operator authorization (pipeline steps 2–5). */
interface DeviceOperatorAuthz {
  userRow: UserLookupRow;
  deviceRow: DeviceRow;
  membership: MembershipLookupRow;
  posRole: PosOperatorRole;
}

export type SignInResult =
  | {
      kind: "signed_in";
      operator: PosOperatorSummaryBody;
      operator_session: PosOperatorSessionSummaryBody;
    }
  | { kind: "takeover_required" }
  | { kind: "refused"; reason: SignInRefusalReason };

export type SignOutResult =
  | { kind: "signed_out" }
  | { kind: "refused"; reason: SignOutRefusalReason };

/**
 * Internal sign-out refusal taxonomy. Logged server-side keyed by
 * `request_id` (ADR D10). Never returned to the client — every refusal
 * cause produces the same generic 401 envelope (FR-POS-AUTH-6). Adding
 * a value here is a server-side observability change, not a contract
 * change.
 */
export type SignOutRefusalReason =
  | "clerk_jwt_invalid"
  | "user_unmapped"
  | "user_disabled"
  | "session_unknown"
  | "session_user_mismatch"
  | "session_scope_mismatch"
  | "session_revoked"
  | "session_expired"
  | "session_revoke_race";

export type RosterResult =
  | { kind: "ok"; cashiers: PosRosterResponseBody["cashiers"] }
  | { kind: "refused"; reason: RosterRefusalReason };

export type RosterRefusalReason =
  | "clerk_jwt_invalid"
  | "user_unmapped"
  | "user_disabled"
  | "membership_missing"
  | "branch_id_required"
  | "branch_mismatch"
  | "store_not_accessible";

export type TakeoverConfirmResult =
  | PosOperatorSignInResponseBody
  | { kind: "refused"; reason: TakeoverRefusalReason };

export type TakeoverRefusalReason =
  | "clerk_jwt_invalid"
  | "user_unmapped"
  | "user_disabled"
  | "device_invalid"
  | "membership_missing"
  | "membership_revoked"
  | "role_ineligible"
  | "store_not_in_access_set"
  | "operator_id_mismatch"
  | "event_id_operator_conflict"
  | "no_active_session_to_supersede";

export type ActiveSessionResult =
  | PosActiveSessionResponseBody
  | { kind: "refused"; reason: ActiveSessionRefusalReason };

export type ActiveSessionRefusalReason =
  | "clerk_jwt_invalid"
  | "user_unmapped"
  | "user_disabled"
  | "membership_missing"
  | "store_not_accessible";

/**
 * Internal refusal taxonomy. The reason is logged server-side keyed by
 * `request_id` (ADR D10) but is never enumerated in the response body.
 * Adding a value here is a server-side observability change, not a
 * contract change.
 */
export type SignInRefusalReason =
  | "clerk_jwt_invalid"
  | "user_unmapped"
  | "user_disabled"
  | "device_invalid"
  | "membership_missing"
  | "membership_revoked"
  | "role_ineligible"
  | "store_not_in_access_set"
  | "tenant_mismatch";

@Injectable()
export class PosOperatorsService {
  constructor(
    private readonly pool: Pool,
    private readonly clerkVerifier: ClerkVerifier,
    private readonly deviceRepository: DeviceRepository,
    private readonly logger: Logger,
    private readonly lookupPool: Pool = pool,
  ) {}

  /**
   * Run the sign-in pipeline. The caller (controller) is responsible for
   * mapping any non-`signed_in` / non-`takeover_required` result to the
   * uniform 401. The shape of `requestId` is part of the structured-log
   * key under which the actual cause is recorded.
   */
  async signIn(
    rawJwt: string,
    body: PosOperatorSignInInput,
    requestId: string,
  ): Promise<PosOperatorSignInResponseBody | { kind: "refused" }> {
    const result = await this.runPipeline(rawJwt, body);
    if (result.kind === "refused") {
      // Server-side cause record — keyed by request_id, never returned
      // to the client. The Clerk JWT and the device attestation are
      // intentionally excluded from this log line (FR-POS-AUTH-10,
      // FR-POS-AUTH-2).
      this.logger.warn(
        { request_id: requestId, refusal: result.reason },
        "pos-operator sign-in refused",
      );
      return { kind: "refused" };
    }
    return result;
  }

  /**
   * Run the sign-out pipeline. The caller (controller) maps any
   * non-`signed_out` result to the uniform 401 envelope. The body
   * carries only `session_id` — the device / store / tenant binding is
   * recorded on the session row at sign-in time and is not re-validated
   * against client input here (the OpenAPI request body has no device
   * surface; expanding it would change the contract).
   *
   * "Idempotent in effect" means re-revoking a session must NOT echo
   * `signed_out` — that would let a caller probe whether a `session_id`
   * ever existed. Already-revoked / expired / unknown / wrong-user /
   * wrong-scope sessions all collapse to the same generic refusal.
   */
  async signOut(
    rawJwt: string,
    body: PosOperatorSignOutInput,
    requestId: string,
  ): Promise<PosOperatorSignOutResponseBody | { kind: "refused" }> {
    const result = await this.runSignOutPipeline(rawJwt, body);
    if (result.kind === "refused") {
      // Server-side cause record — keyed by request_id. The Clerk JWT
      // is intentionally excluded (FR-POS-AUTH-10). The session_id is
      // intentionally NOT logged at WARN level on Clerk-JWT failure, so
      // a probing client can't correlate guesses against server logs.
      this.logger.warn(
        { request_id: requestId, refusal: result.reason },
        "pos-operator sign-out refused",
      );
      return { kind: "refused" };
    }
    return result;
  }

  /**
   * Wave 3 — cashier roster for a branch.
   *
   * Requires `branch_id` query param because there is no device attestation
   * on GET endpoints to resolve the branch independently. When `branch_id` is
   * absent, refuses with generic 401 (branch_id_required reason).
   *
   * Returns all `store_staff` members of the branch. Per FR-015 role-visibility
   * matrix, `store_staff` maps to the POS `cashier` role in roster responses.
   */
  async roster(
    rawJwt: string,
    query: PosRosterQueryInput,
    requestId: string,
  ): Promise<PosRosterResponseBody | { kind: "refused" }> {
    const result = await this.runRosterPipeline(rawJwt, query);
    if (result.kind === "refused") {
      this.logger.warn(
        { request_id: requestId, refusal: result.reason },
        "pos-operator roster refused",
      );
      return { kind: "refused" };
    }
    return { cashiers: result.cashiers };
  }

  /**
   * Wave 3 — confirm a POS operator takeover.
   *
   * Idempotency via `event_id`: stored in `idempotency_keys` with
   * `client_id = NULL`, keyed on `(tenant_id, store_id, NULL, event_id)`.
   * Collision with the same `operator_id` → return the original signed-in
   * envelope. Collision with a different `operator_id` → generic 401.
   * Emits `operator.session.takeover` audit event on the first successful confirm.
   */
  async takeoverConfirm(
    rawJwt: string,
    body: PosTakeoverConfirmInput,
    requestId: string,
  ): Promise<PosOperatorSignInResponseBody | { kind: "refused" }> {
    const result = await this.runTakeoverConfirmPipeline(rawJwt, body, requestId);
    if (result.kind === "refused") {
      this.logger.warn(
        { request_id: requestId, refusal: result.reason },
        "pos-operator takeover confirm refused",
      );
      return { kind: "refused" };
    }
    return result;
  }

  /**
   * Wave 3 — minimum-disclosure active session check.
   *
   * Returns `{ kind: "none" | "active" }` — no session id, no timestamps,
   * no operator identity. Refuses on invalid JWT or unmapped/disabled user.
   * The caller (controller) maps any refused result to 401.
   */
  async activeSession(
    rawJwt: string,
    query: PosActiveSessionQueryInput,
    requestId: string,
  ): Promise<PosActiveSessionResponseBody | { kind: "refused" }> {
    const result = await this.runActiveSessionPipeline(rawJwt, query);
    if (result.kind === "refused") {
      this.logger.warn(
        { request_id: requestId, refusal: result.reason },
        "pos-operator active-session refused",
      );
      return { kind: "refused" };
    }
    return result;
  }

  /**
   * Pipeline steps 2–5 shared by sign-in and takeover-confirm: resolve the
   * local user, the attested device, the membership in the device's tenant,
   * role eligibility, and store eligibility. Step order is behavior — each
   * step's refusal reason is logged server-side keyed by request_id (ADR D10).
   */
  private async authorizeOperatorOnDevice(
    sub: string,
    deviceTokenAttestation: string,
  ): Promise<
    { kind: "refused"; reason: DeviceAuthzRefusalReason } | ({ kind: "ok" } & DeviceOperatorAuthz)
  > {
    // 2. Map Clerk subject → local user.
    const userRow = await this.findUserByClerkSubject(sub);
    if (!userRow) return { kind: "refused", reason: "user_unmapped" };
    if (userRow.deleted_at !== null) {
      return { kind: "refused", reason: "user_disabled" };
    }

    // 3. Device — hash the attestation, look up active row.
    const deviceRow = await this.deviceRepository.findActiveByAttestation(
      deviceTokenAttestation,
    );
    if (!deviceRow) return { kind: "refused", reason: "device_invalid" };

    // 4. Membership in the device's tenant + role eligibility.
    const membership = await this.findActiveMembership(
      deviceRow.tenantId,
      userRow.id,
    );
    if (!membership) return { kind: "refused", reason: "membership_missing" };
    if (membership.revoked_at !== null || membership.deleted_at !== null) {
      return { kind: "refused", reason: "membership_revoked" };
    }
    if (!ELIGIBLE_INTERNAL_ROLES.has(membership.role_code)) {
      return { kind: "refused", reason: "role_ineligible" };
    }
    const posRole = mapInternalRoleToPos(membership.role_code);
    if (posRole === null) return { kind: "refused", reason: "role_ineligible" };

    // 5. Store eligibility: 'all' → unconditional, 'specific' → must be in access set.
    if (membership.store_access_kind === "specific") {
      const ok = await this.storeIsInAccessSet(
        deviceRow.tenantId,
        membership.id,
        deviceRow.storeId,
      );
      if (!ok) return { kind: "refused", reason: "store_not_in_access_set" };
    }

    return { kind: "ok", userRow, deviceRow, membership, posRole };
  }

  private async runPipeline(
    rawJwt: string,
    body: PosOperatorSignInInput,
  ): Promise<SignInResult> {
    // 1. Clerk JWT verification.
    let claims;
    try {
      claims = await this.clerkVerifier.verify(rawJwt);
    } catch {
      return { kind: "refused", reason: "clerk_jwt_invalid" };
    }

    // 2–5. Shared device-scoped authorization.
    const authz = await this.authorizeOperatorOnDevice(claims.sub, body.device_token_attestation);
    if (authz.kind === "refused") return authz;
    const { userRow, deviceRow, posRole } = authz;

    // 6. Active operator session check → takeover_required (minimum disclosure).
    const hasActiveSession = await this.activeOperatorSessionExists(
      deviceRow.tenantId,
      deviceRow.id,
      deviceRow.storeId,
    );
    if (hasActiveSession) return { kind: "takeover_required" };

    // 7. Issue server-side operator session row.
    const session = await this.issueOperatorSessionRow({
      tenantId: deviceRow.tenantId,
      storeId: deviceRow.storeId,
      userId: userRow.id,
      deviceId: deviceRow.id,
    });

    return {
      kind: "signed_in",
      operator: {
        id: userRow.clerk_user_id ?? "",
        // 033: provider-neutral identity key (users.id), surfaced alongside the
        // clerk_user_id bridge. Already loaded on userRow; no new query.
        user_id: userRow.id,
        display_name: userRow.display_name ?? userRow.email,
        role: posRole,
        tenant_id: deviceRow.tenantId,
        // FR-POS-AUTH-7: internal `store_id` is surfaced as `branch_id`.
        branch_id: deviceRow.storeId,
      },
      operator_session: {
        id: session.id,
        issued_at: session.issuedAt.toISOString(),
        envelope: session.envelope,
      },
    };
  }

  private async runRosterPipeline(
    rawJwt: string,
    query: PosRosterQueryInput,
  ): Promise<RosterResult> {
    let claims;
    try {
      claims = await this.clerkVerifier.verify(rawJwt);
    } catch {
      return { kind: "refused", reason: "clerk_jwt_invalid" };
    }

    const userRow = await this.findUserByClerkSubject(claims.sub);
    if (!userRow) return { kind: "refused", reason: "user_unmapped" };
    if (userRow.deleted_at !== null) return { kind: "refused", reason: "user_disabled" };

    // branch_id is required on GETs — no device attestation to resolve it from.
    if (!query.branch_id) return { kind: "refused", reason: "branch_id_required" };

    // Confirm user has a membership in the tenant that owns this branch.
    const membership = await this.findActiveMembershipByStore(query.branch_id, userRow.id);
    if (!membership) return { kind: "refused", reason: "membership_missing" };

    // Verify the caller has access to this specific store.
    if (membership.store_access_kind === "specific") {
      const ok = await this.storeIsInAccessSet(
        membership.tenant_id,
        membership.id,
        query.branch_id,
      );
      if (!ok) return { kind: "refused", reason: "store_not_accessible" };
    }

    const cashiers = await this.findCashiersByStore(query.branch_id, membership.tenant_id);
    return { kind: "ok" as const, cashiers };
  }

  private async runTakeoverConfirmPipeline(
    rawJwt: string,
    body: PosTakeoverConfirmInput,
    requestId: string,
  ): Promise<TakeoverConfirmResult> {
    let claims;
    try {
      claims = await this.clerkVerifier.verify(rawJwt);
    } catch {
      return { kind: "refused", reason: "clerk_jwt_invalid" };
    }

    // JWT sub must match the operator_id in the body (prevents identity substitution).
    if (claims.sub !== body.operator_id) {
      return { kind: "refused", reason: "operator_id_mismatch" };
    }

    const authz = await this.authorizeOperatorOnDevice(claims.sub, body.device_token_attestation);
    if (authz.kind === "refused") return authz;
    const { deviceRow } = authz;

    // Idempotency check via idempotency_keys. client_id = NULL, key = event_id.
    // UNIQUE on (tenant_id, store_id, client_id, key) NULLS NOT DISTINCT guarantees
    // collision on the same event_id within the same (tenant, store).
    const idempotencyCheck = await this.upsertTakeoverIdempotencyKey(
      body.event_id,
      body.operator_id,
      deviceRow.tenantId,
      deviceRow.storeId,
    );
    if (idempotencyCheck.type === "conflict") {
      // Same event_id, different operator_id → refuse (prevents probing).
      return { kind: "refused", reason: "event_id_operator_conflict" };
    }

    if (idempotencyCheck.type === "duplicate") {
      return this.replayTakeoverConfirm(idempotencyCheck.sessionId, authz);
    }

    return this.confirmTakeoverFirstTime(body, requestId, authz);
  }

  /**
   * Exact replay of a confirmed takeover (same event_id + operator): return
   * the original session row if it is still live.
   */
  private async replayTakeoverConfirm(
    sessionId: string,
    authz: DeviceOperatorAuthz,
  ): Promise<TakeoverConfirmResult> {
    const { userRow, deviceRow, posRole } = authz;

    const session = await this.findOperatorSessionById(sessionId);
    if (!session || session.revoked_at !== null || session.expires_at.getTime() <= Date.now()) {
      // Session was revoked or expired after idempotency key was stored.
      return { kind: "refused", reason: "no_active_session_to_supersede" };
    }
    return {
      kind: "signed_in",
      operator: {
        id: userRow.clerk_user_id ?? "",
        // 033: provider-neutral identity key (users.id). Present even on an
        // idempotent replay (envelope is null here, but user_id is identity,
        // not a hash-once secret) — SC-033-2 path 4.
        user_id: userRow.id,
        display_name: userRow.display_name ?? userRow.email,
        role: posRole,
        tenant_id: deviceRow.tenantId,
        branch_id: deviceRow.storeId,
      },
      operator_session: {
        id: session.id,
        issued_at: session.issued_at.toISOString(),
        // Idempotent replay: the raw envelope is hash-once and not
        // recoverable from the stored row. The original confirm returned it
        // to this same client; a replay does not re-mint (would break the
        // hash-once invariant). Null signals "use the envelope you already
        // hold from the first confirm."
        envelope: null,
      },
    };
  }

  /**
   * First-time confirm: revoke the existing session for this (device, store),
   * issue the incoming operator's session, persist the session id on the
   * idempotency key, and emit the takeover audit event.
   */
  private async confirmTakeoverFirstTime(
    body: PosTakeoverConfirmInput,
    requestId: string,
    authz: DeviceOperatorAuthz,
  ): Promise<TakeoverConfirmResult> {
    const { userRow, deviceRow, posRole } = authz;

    // Revoke the existing session for this (device, store).
    const revokedSessionId = await this.revokeActiveOperatorSession(
      deviceRow.tenantId,
      deviceRow.id,
      deviceRow.storeId,
    );
    if (!revokedSessionId) {
      // No active session to take over.
      return { kind: "refused", reason: "no_active_session_to_supersede" };
    }

    // Issue new session row for incoming operator.
    const session = await this.issueOperatorSessionRow({
      tenantId: deviceRow.tenantId,
      storeId: deviceRow.storeId,
      userId: userRow.id,
      deviceId: deviceRow.id,
    });

    // Store the new session id in the idempotency key so replays return the right row.
    await this.updateIdempotencyKeyWithSession(
      body.event_id,
      deviceRow.tenantId,
      deviceRow.storeId,
      session.id,
    );

    // Emit audit event.
    const actorUserId = userRow.id;
    await insertAuditEvent(this.pool, {
      id: newId(),
      actor_user_id: actorUserId,
      actor_label: null,
      tenant_id: deviceRow.tenantId,
      store_id: deviceRow.storeId,
      action: "operator.session.takeover",
      target_type: "auth_tokens",
      target_id: session.id,
      request_id: requestId,
      metadata: {
        superseded_session_id: revokedSessionId,
        new_session_id: session.id,
      },
    }).catch((err: unknown) => {
      // Non-fatal: audit failure does not roll back a successful takeover.
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn({ request_id: requestId, err: msg }, "pos-operator takeover: audit emit failed");
    });

    return {
      kind: "signed_in",
      operator: {
        id: userRow.clerk_user_id ?? "",
        // 033: provider-neutral identity key (users.id), surfaced alongside the
        // clerk_user_id bridge. Already loaded on userRow; no new query.
        user_id: userRow.id,
        display_name: userRow.display_name ?? userRow.email,
        role: posRole,
        tenant_id: deviceRow.tenantId,
        branch_id: deviceRow.storeId,
      },
      operator_session: {
        id: session.id,
        issued_at: session.issuedAt.toISOString(),
        envelope: session.envelope,
      },
    };
  }

  private async runActiveSessionPipeline(
    rawJwt: string,
    query: PosActiveSessionQueryInput,
  ): Promise<ActiveSessionResult> {
    let claims;
    try {
      claims = await this.clerkVerifier.verify(rawJwt);
    } catch {
      return { kind: "refused", reason: "clerk_jwt_invalid" };
    }

    // Gate the requester: they must be a valid, non-deleted user.
    const requesterRow = await this.findUserByClerkSubject(claims.sub);
    if (!requesterRow) return { kind: "refused", reason: "user_unmapped" };
    if (requesterRow.deleted_at !== null) return { kind: "refused", reason: "user_disabled" };

    // Validate requester has an active membership in the branch's tenant.
    // Uses the same JOIN-via-stores pattern as roster to enforce cross-tenant protection.
    const membership = await this.findActiveMembershipByStore(query.branch_id, requesterRow.id);
    if (!membership) return { kind: "refused", reason: "membership_missing" };

    // If store-specific access, confirm the caller has the branch in their access set.
    if (membership.store_access_kind === "specific") {
      const ok = await this.storeIsInAccessSet(
        membership.tenant_id,
        membership.id,
        query.branch_id,
      );
      if (!ok) return { kind: "refused", reason: "store_not_accessible" };
    }

    // Resolve the target operator AFTER branch authorization succeeds (minimum disclosure).
    const targetRow = await this.findUserByClerkSubject(query.operator_id);
    if (!targetRow || targetRow.deleted_at !== null) {
      // Non-existent or disabled target → "none" (minimum disclosure, not 401).
      return { kind: "none" };
    }

    const hasActive = await this.anyActiveOperatorSessionInStore(
      membership.tenant_id,
      targetRow.id,
      query.branch_id,
    );
    return { kind: hasActive ? "active" : "none" };
  }

  // -----------------------------------------------------------------------
  // Direct SQL — kept inline rather than spreading across micro-repos.
  // Each query has a single caller in this service.
  // -----------------------------------------------------------------------

  private async findUserByClerkSubject(sub: string): Promise<UserLookupRow | null> {
    const r = await this.lookupPool.query<UserLookupRow>(
      `SELECT id, email, display_name, clerk_user_id, deleted_at
         FROM users
        WHERE clerk_user_id = $1
        LIMIT 1`,
      [sub],
    );
    return r.rows[0] ?? null;
  }

  private async findActiveMembership(
    tenantId: string,
    userId: string,
  ): Promise<MembershipLookupRow | null> {
    return runWithTenantContext(
      this.pool,
      { tenantId, isPlatformAdmin: false },
      async (client) => {
        const r = await client.query<MembershipLookupRow>(
          `SELECT m.id, m.tenant_id, m.user_id, m.role_id,
                  m.store_access_kind, m.revoked_at, m.deleted_at,
                  r.code AS role_code
             FROM memberships m
             JOIN roles r ON r.id = m.role_id
            WHERE m.tenant_id = $1
              AND m.user_id = $2
            LIMIT 1`,
          [tenantId, userId],
        );
        return r.rows[0] ?? null;
      },
    );
  }

  private async storeIsInAccessSet(
    tenantId: string,
    membershipId: string,
    storeId: string,
  ): Promise<boolean> {
    return runWithTenantContext(
      this.pool,
      { tenantId, isPlatformAdmin: false },
      async (client) => {
        const r = await client.query<{ one: number }>(
          `SELECT 1 AS one
             FROM store_access
            WHERE membership_id = $1
              AND store_id = $2
            LIMIT 1`,
          [membershipId, storeId],
        );
        return r.rows.length > 0;
      },
    );
  }

  private async activeOperatorSessionExists(
    tenantId: string,
    deviceId: string,
    storeId: string,
  ): Promise<boolean> {
    return runWithTenantContext(
      this.pool,
      { tenantId, isPlatformAdmin: false },
      async (client) => {
        const r = await client.query<{ one: number }>(
          `SELECT 1 AS one
             FROM auth_tokens
            WHERE scope = 'pos_operator'
              AND device_id = $1
              AND store_id = $2
              AND revoked_at IS NULL
              AND expires_at > now()
            LIMIT 1`,
          [deviceId, storeId],
        );
        return r.rows.length > 0;
      },
    );
  }

  private async runSignOutPipeline(
    rawJwt: string,
    body: PosOperatorSignOutInput,
  ): Promise<SignOutResult> {
    // 1. Clerk JWT verification.
    let claims;
    try {
      claims = await this.clerkVerifier.verify(rawJwt);
    } catch {
      return { kind: "refused", reason: "clerk_jwt_invalid" };
    }

    // 2. Map Clerk subject → local user.
    const userRow = await this.findUserByClerkSubject(claims.sub);
    if (!userRow) return { kind: "refused", reason: "user_unmapped" };
    if (userRow.deleted_at !== null) {
      return { kind: "refused", reason: "user_disabled" };
    }

    // 3. Load the session row by id. SELECT-then-conditional-UPDATE so
    //    each refusal cause is distinguishable in the server-side log
    //    (without ever appearing in the client response).
    const session = await this.findOperatorSessionById(body.session_id);
    if (!session) return { kind: "refused", reason: "session_unknown" };
    if (session.user_id !== userRow.id) {
      return { kind: "refused", reason: "session_user_mismatch" };
    }
    if (session.scope !== "pos_operator") {
      return { kind: "refused", reason: "session_scope_mismatch" };
    }
    if (session.revoked_at !== null) {
      return { kind: "refused", reason: "session_revoked" };
    }
    if (session.expires_at.getTime() <= Date.now()) {
      return { kind: "refused", reason: "session_expired" };
    }

    // 4. Conditional UPDATE — guarded against concurrent revoke and (defense-
    //    in-depth) the same ownership check the SELECT already enforced. The
    //    user_id clause ensures no UPDATE ever fires for a row that belongs to a
    //    different user even if the application-layer check above is bypassed.
    const revoked = await this.markSessionRevoked(body.session_id, userRow.id);
    if (!revoked) return { kind: "refused", reason: "session_revoke_race" };

    return { kind: "signed_out" };
  }

  private async findOperatorSessionById(
    sessionId: string,
  ): Promise<OperatorSessionWithIssuedAtRow | null> {
    const r = await this.lookupPool.query<OperatorSessionWithIssuedAtRow>(
      `SELECT id, user_id, scope, revoked_at, expires_at, issued_at
         FROM auth_tokens
        WHERE id = $1
        LIMIT 1`,
      [sessionId],
    );
    return r.rows[0] ?? null;
  }

  /**
   * Finds the active membership for a user scoped to the store's tenant.
   * Used by roster (resolves tenant from store_id).
   */
  private async findActiveMembershipByStore(
    storeId: string,
    userId: string,
  ): Promise<MembershipLookupRow | null> {
    const store = await this.lookupPool.query<{ tenant_id: string }>(
      `SELECT tenant_id FROM stores WHERE id = $1 LIMIT 1`,
      [storeId],
    );
    const tenantId = store.rows[0]?.tenant_id;
    if (!tenantId) return null;
    return this.findActiveMembership(tenantId, userId);
  }

  /**
   * Returns all cashiers (store_staff role) for a branch.
   * `store_staff` maps to the POS `cashier` role (FR-015 role-visibility matrix).
   */
  private async findCashiersByStore(
    storeId: string,
    tenantId: string,
  ): Promise<
    Array<{ id: string; user_id: string; display_name: string; role: "cashier" }>
  > {
    return runWithTenantContext(
      this.pool,
      { tenantId, isPlatformAdmin: false },
      async (client) => {
        const r = await client.query<{
          id: string;
          clerk_user_id: string;
          display_name: string;
        }>(
      // 034: also project u.id (the provider-neutral users.id, §16) so the
      // roster entry can carry user_id alongside the clerk_user_id bridge.
      // u.id is already the JOIN key — no new join, no new query.
      `SELECT u.id, u.clerk_user_id, u.display_name
         FROM memberships m
         JOIN roles r ON r.id = m.role_id
         JOIN users u ON u.id = m.user_id
        WHERE m.tenant_id = $1
          AND r.code = 'store_staff'
          AND m.revoked_at IS NULL
          AND m.deleted_at IS NULL
          AND u.deleted_at IS NULL
          AND u.clerk_user_id IS NOT NULL
          AND u.display_name IS NOT NULL
          AND (
            m.store_access_kind = 'all'
            OR EXISTS (
              SELECT 1 FROM store_access sa
               WHERE sa.membership_id = m.id AND sa.store_id = $2
            )
          )
        ORDER BY u.display_name`,
          [tenantId, storeId],
        );
        return r.rows.map((row) => ({
          id: row.clerk_user_id,
          user_id: row.id,
          display_name: row.display_name,
          role: "cashier" as const,
        }));
      },
    );
  }

  /**
   * Upserts an idempotency key for a takeover event_id.
   *
   * Uses `idempotency_keys` with `client_id = 'pos_takeover'` (sentinel)
   * because the column is TEXT NOT NULL. The UNIQUE constraint
   * `(tenant_id, store_id, client_id, key)` ensures collision detection.
   *
   * `request_hash` is a SHA-256 Buffer of operatorId (BYTEA NOT NULL).
   * Comparison uses Buffer.equals() since node-pg deserialises BYTEA → Buffer.
   *
   * Returns:
   *   - `{ type: "fresh" }` → first submission; caller should proceed.
   *   - `{ type: "duplicate", sessionId }` → exact replay; sessionId is the
   *     stored session id from the prior confirmation.
   *   - `{ type: "conflict" }` → same event_id, different operator_id.
   */
  private async upsertTakeoverIdempotencyKey(
    eventId: string,
    operatorId: string,
    tenantId: string,
    storeId: string,
  ): Promise<
    | { type: "fresh" }
    | { type: "duplicate"; sessionId: string }
    | { type: "conflict" }
  > {
    const expiresAt = new Date(Date.now() + OPERATOR_SESSION_TTL_MS);
    const requestHashBuf = hashToken(operatorId);
    return runWithTenantContext(
      this.pool,
      { tenantId, isPlatformAdmin: false },
      async (client): Promise<
        | { type: "fresh" }
        | { type: "duplicate"; sessionId: string }
        | { type: "conflict" }
      > => {
        // Attempt insert; on conflict read back the existing row.
        const insertResult = await client.query<{
          id: string;
          response_body: string | null;
        }>(
          `INSERT INTO idempotency_keys
             (id, tenant_id, store_id, client_id, key, request_hash,
              response_status, response_body, expires_at)
           VALUES
             ($1, $2, $3, 'pos_takeover', $4, $5, 200, $6::jsonb, $7)
           ON CONFLICT (tenant_id, store_id, client_id, key) DO NOTHING
           RETURNING id, response_body`,
          [
            newId(),
            tenantId,
            storeId,
            eventId,
            requestHashBuf,
            JSON.stringify({ operator_id: operatorId, session_id: null }),
            expiresAt,
          ],
        );

        if (insertResult.rows.length > 0) {
          return { type: "fresh" };
        }

        // Collision: read the existing row.
        const existingResult = await client.query<{
          request_hash: Buffer;
          response_body: { session_id?: string | null } | null;
        }>(
          `SELECT request_hash, response_body
             FROM idempotency_keys
            WHERE tenant_id = $1
              AND store_id = $2
              AND client_id = 'pos_takeover'
              AND key = $3
            LIMIT 1`,
          [tenantId, storeId, eventId],
        );

        const existing = existingResult.rows[0];
        if (!existing) {
          // Race: row was deleted between insert conflict and this read.
          return { type: "fresh" };
        }

        if (!existing.request_hash.equals(requestHashBuf)) {
          // Different operator_id for the same event_id.
          return { type: "conflict" };
        }

        // node-pg deserialises JSONB → JS object automatically; no JSON.parse needed.
        const sessionId = existing.response_body?.session_id ?? null;
        if (!sessionId) {
          // Idempotency key was inserted but session_id not yet written (concurrent).
          return { type: "fresh" };
        }

        return { type: "duplicate", sessionId };
      },
    );
  }

  /** Updates the idempotency key row to record the new session id. */
  private async updateIdempotencyKeyWithSession(
    eventId: string,
    tenantId: string,
    storeId: string,
    sessionId: string,
  ): Promise<void> {
    await runWithTenantContext(
      this.pool,
      { tenantId, isPlatformAdmin: false },
      (client) =>
        client.query(
          `UPDATE idempotency_keys
              SET response_body = jsonb_set(
                COALESCE(response_body, '{}'::jsonb),
                '{session_id}',
                to_jsonb($1::text)
              )
            WHERE tenant_id = $2
              AND store_id = $3
              AND client_id = 'pos_takeover'
              AND key = $4`,
          [sessionId, tenantId, storeId, eventId],
        ),
    );
  }

  /**
   * Revokes the active operator session for a (device, store) pair
   * and returns the revoked session id. Returns null if no active session.
   */
  private async revokeActiveOperatorSession(
    tenantId: string,
    deviceId: string,
    storeId: string,
  ): Promise<string | null> {
    return runWithTenantContext(
      this.pool,
      { tenantId, isPlatformAdmin: false },
      async (client) => {
        const r = await client.query<{ id: string }>(
          `UPDATE auth_tokens
              SET revoked_at = now()
            WHERE scope = 'pos_operator'
              AND device_id = $1
              AND store_id = $2
              AND revoked_at IS NULL
              AND expires_at > now()
            RETURNING id`,
          [deviceId, storeId],
        );
        return r.rows[0]?.id ?? null;
      },
    );
  }

  /**
   * Checks whether a user has an active pos_operator session in the given store.
   * Used by active-session endpoint after branch authorization is confirmed.
   */
  private async anyActiveOperatorSessionInStore(
    tenantId: string,
    userId: string,
    storeId: string,
  ): Promise<boolean> {
    return runWithTenantContext(
      this.pool,
      { tenantId, isPlatformAdmin: false },
      async (client) => {
        const r = await client.query<{ one: number }>(
          `SELECT 1 AS one
             FROM auth_tokens
            WHERE scope = 'pos_operator'
              AND user_id = $1
              AND store_id = $2
              AND revoked_at IS NULL
              AND expires_at > now()
            LIMIT 1`,
          [userId, storeId],
        );
        return r.rows.length > 0;
      },
    );
  }

  private async markSessionRevoked(sessionId: string, userId: string): Promise<boolean> {
    const r = await this.lookupPool.query<{ id: string }>(
      `UPDATE auth_tokens
          SET revoked_at = now()
        WHERE id = $1
          AND user_id = $2
          AND revoked_at IS NULL
        RETURNING id`,
      [sessionId, userId],
    );
    return r.rows.length > 0;
  }

  private async issueOperatorSessionRow(input: {
    tenantId: string;
    storeId: string;
    userId: string;
    deviceId: string;
  }): Promise<{ id: string; issuedAt: Date; envelope: string }> {
    const id = newId();
    // The token_hash column is NOT NULL UNIQUE. We generate an opaque raw
    // token, store ONLY its hash here, and return the raw as the client-
    // presentable operator-authorization ENVELOPE (031 D1, OQ-1 = 1-A-i;
    // supersedes the ADR-D8 "never returned" posture). The hash/`revoked_at`
    // model is unchanged: the envelope resolves back via the canonical
    // `AuthGuard.findActiveByRawToken` hash lookup, and sign-out / takeover
    // revocation invalidate it exactly as before. The raw is never logged.
    const opaqueRaw = generateRawToken();
    const tokenHash = hashToken(opaqueRaw);
    const expiresAt = new Date(Date.now() + OPERATOR_SESSION_TTL_MS);
    const row = await runWithTenantContext(
      this.pool,
      { tenantId: input.tenantId, isPlatformAdmin: false },
      async (client) => {
        const r = await client.query<{ id: string; issued_at: Date }>(
          `INSERT INTO auth_tokens
             (id, token_hash, tenant_id, user_id, device_id, store_id,
              scope, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, 'pos_operator', $7)
           RETURNING id, issued_at`,
          [id, tokenHash, input.tenantId, input.userId, input.deviceId, input.storeId, expiresAt],
        );
        return r.rows[0];
      },
    );
    if (!row) throw new Error("PosOperatorsService.issueOperatorSessionRow: insert returned no row");
    return { id: row.id, issuedAt: row.issued_at, envelope: opaqueRaw };
  }
}

interface UserLookupRow {
  id: string;
  email: string;
  display_name: string | null;
  clerk_user_id: string | null;
  deleted_at: Date | null;
}

interface MembershipLookupRow {
  id: string;
  tenant_id: string;
  user_id: string;
  role_id: string;
  store_access_kind: "all" | "specific";
  revoked_at: Date | null;
  deleted_at: Date | null;
  role_code: string;
}

interface OperatorSessionWithIssuedAtRow {
  id: string;
  user_id: string;
  scope: string;
  revoked_at: Date | null;
  expires_at: Date;
  issued_at: Date;
}
