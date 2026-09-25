/**
 * operator-context-resolver.ts — 008 Option Y.
 *
 * Reusable POS-operator identity + eligibility resolution. Given a Clerk JWT
 * and a device-token attestation, it runs the SAME derivation the operator
 * sign-in pipeline uses and returns a `ResolvedContext` scoped from the device
 * row + membership — or a typed refusal.
 *
 * This is the shared trust core for the POS sale-sync surface (Option Y,
 * owner-ratified 2026-06-10): the sale endpoints authenticate exactly like
 * `POST /api/pos/v1/operators/sign-in` — Clerk JWT in `Authorization` +
 * device attestation in the body — instead of requiring a server-internal
 * `pos_operator` bearer that sign-in never issues to clients.
 *
 * Derivation (mirrors PosOperatorsService.runPipeline steps 1–5):
 *   1. Verify the provider token at the trust boundary via
 *      `IdentityProviderPort.verifyIdentityToken` → a provider-NEUTRAL verified
 *      subject `{ providerKey, issuer, subject }` (029 D3 / PI-3). The concrete
 *      Clerk verification stays behind the adapter — this resolver never reads a
 *      Clerk-typed claim.
 *   2. Resolve the local user by JOINing the provider-neutral subject onto the
 *      `external_identity_links` ACTIVE link (NOT `users.clerk_user_id = sub` —
 *      029 D3 / G-3); reject if there is no active link (`user_unmapped`) or the
 *      user is soft-deleted (`user_disabled`).
 *   3. Resolve the device by attestation hash (active rows only); the device
 *      row carries the canonical `(tenant_id, store_id)`.
 *   4. Resolve the operator's membership in the device's tenant; role MUST be
 *      one of {owner, tenant_admin, store_manager}; reject revoked / deleted.
 *   5. Store eligibility: `all` → any store in tenant; `specific` → must be in
 *      the access set for the device's store.
 *
 * On success, publishes `(tenant_id, store_id)` FROM the device row (the
 * authority) and `user_id` from the local user — NEVER from any request body
 * (FR-061 mass-assignment ban). Every failure is a typed `refused` reason,
 * logged server-side by the caller and collapsed to a generic 401 at the
 * boundary (no factor disclosure).
 *
 * The provider token and device attestation are never logged, persisted, or
 * returned (FR-POS-AUTH-10 / ADR D3).
 *
 * 029 D3 NOTE: this resolver is the sale-sync identity trust core. It was
 * re-pointed (PI-3) from the direct Clerk verifier + `WHERE clerk_user_id = $1`
 * to the provider-neutral `IdentityProviderPort` + an `external_identity_links`
 * join. The operator/sale-sync CREDENTIAL (the Option Y envelope) and the
 * membership/store/eligibility logic are UNCHANGED — D3 re-anchors only "who the
 * human is" (N-2). The sign-in service path (`pos-operators.service.ts`) is a
 * SEPARATE slice and still joins `clerk_user_id`; after backfill both resolve the
 * same user.
 */
import { Injectable } from "@nestjs/common";
import type { Pool } from "pg";

import { runWithTenantContext } from "@data-pulse-2/db";

import { DeviceRepository } from "../pos-operators/device.repository";
import type { ResolvedContext } from "../context/types";
import type { IdentityProviderPort } from "./identity-provider.port";

/**
 * Internal roles eligible for the POS manager/admin surface. Mirrors
 * `ELIGIBLE_INTERNAL_ROLES` in PosOperatorsService — store_staff (cashier) is
 * NOT eligible to ring a manager/admin-authenticated sale via this path.
 */
const ELIGIBLE_INTERNAL_ROLES = new Set(["owner", "tenant_admin", "store_manager"]);

export type ResolveOperatorRefusalReason =
  | "clerk_jwt_invalid"
  | "user_unmapped"
  | "user_disabled"
  | "device_invalid"
  | "membership_missing"
  | "membership_revoked"
  | "role_ineligible"
  | "store_not_in_access_set";

export type ResolveOperatorResult =
  | { kind: "ok"; context: ResolvedContext; deviceId: string }
  | { kind: "refused"; reason: ResolveOperatorRefusalReason };

/**
 * Resolver seam. The guard depends on this interface; production wires
 * `PgOperatorContextResolver`, unit tests inject a fake.
 */
export interface OperatorContextResolver {
  resolve(rawJwt: string, rawAttestation: string): Promise<ResolveOperatorResult>;
}

/**
 * Live re-verification seam (031 G-4, Option B). The envelope sale guard
 * depends on this to re-evaluate the operator's LIVE eligibility per sale
 * request — the legs the canonical token check does NOT re-resolve. This is
 * why the envelope re-wire does not weaken the composed predicate vs Option-Y.
 *
 * Keyed by the resolved IDs the envelope principal already carries (userId,
 * storeId) plus the device_id recovered from the auth_tokens row — NOT by a
 * JWT/attestation (the envelope path has neither).
 */
export interface OperatorReverifier {
  /**
   * Recover the operator session's bound `device_id` from its `auth_tokens`
   * row id (`principal.tokenId`). The canonical `Principal` does not expose
   * deviceId; the row does. Returns null if the row is gone / not pos_operator.
   */
  recoverDeviceId(tokenId: string): Promise<string | null>;
  /**
   * Re-evaluate membership-active + device-active + role-eligibility +
   * store-access LIVE for an already-authenticated operator session. Mirrors
   * `resolve` steps 3–5 but keyed by IDs.
   */
  reverify(
    userId: string,
    deviceId: string,
    storeId: string,
  ): Promise<{ kind: "ok" } | { kind: "refused"; reason: ResolveOperatorRefusalReason }>;
}

/** DI token for the resolver. */
export const OPERATOR_CONTEXT_RESOLVER = "OPERATOR_CONTEXT_RESOLVER";

interface UserLookupRow {
  id: string;
  deleted_at: Date | null;
}

interface MembershipLookupRow {
  id: string;
  store_access_kind: "all" | "specific";
  revoked_at: Date | null;
  deleted_at: Date | null;
  role_code: string;
}

/** Minimal structured-logger surface (pino-compatible); optional. */
export interface ResolverLogger {
  warn(obj: object, msg: string): void;
}

@Injectable()
export class PgOperatorContextResolver implements OperatorContextResolver {
  constructor(
    private readonly pool: Pool,
    private readonly identityProvider: IdentityProviderPort,
    private readonly deviceRepository: DeviceRepository,
    private readonly logger?: ResolverLogger,
    private readonly lookupPool: Pool = pool,
  ) {}

  async resolve(rawJwt: string, rawAttestation: string): Promise<ResolveOperatorResult> {
    // 1. Provider-neutral token verification at the trust boundary (PI-3).
    let verified;
    try {
      verified = await this.identityProvider.verifyIdentityToken(rawJwt);
    } catch (err) {
      // Collapse to a generic refusal at the boundary (no factor disclosure),
      // but record the underlying cause server-side so operators can debug
      // provider connectivity / config / outage. The raw token is NEVER logged
      // (FR-POS-AUTH-10) — only the error.
      this.logger?.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "operator-context-resolver: identity token verification failed",
      );
      return { kind: "refused", reason: "clerk_jwt_invalid" };
    }

    // 2. Map the provider-neutral verified subject → local user via the ACTIVE
    //    external_identity_links row (NOT clerk_user_id — 029 D3 / G-3).
    const userRow = await this.findUserByExternalIdentity(verified.providerKey, verified.subject);
    if (!userRow) return { kind: "refused", reason: "user_unmapped" };
    if (userRow.deleted_at !== null) return { kind: "refused", reason: "user_disabled" };

    // 3. Device — hash the attestation, look up the active row (carries scope).
    const deviceRow = await this.deviceRepository.findActiveByAttestation(rawAttestation);
    if (!deviceRow) return { kind: "refused", reason: "device_invalid" };

    // 4. Membership in the device's tenant + role eligibility.
    const membership = await this.findActiveMembership(deviceRow.tenantId, userRow.id);
    if (!membership) return { kind: "refused", reason: "membership_missing" };
    if (membership.revoked_at !== null || membership.deleted_at !== null) {
      return { kind: "refused", reason: "membership_revoked" };
    }
    if (!ELIGIBLE_INTERNAL_ROLES.has(membership.role_code)) {
      return { kind: "refused", reason: "role_ineligible" };
    }

    // 5. Store eligibility: 'all' → unconditional, 'specific' → must be in set.
    if (membership.store_access_kind === "specific") {
      const ok = await this.storeIsInAccessSet(
        deviceRow.tenantId,
        membership.id,
        deviceRow.storeId,
      );
      if (!ok) return { kind: "refused", reason: "store_not_in_access_set" };
    }

    // Scope FROM the device row + local user — never from request input.
    const context: ResolvedContext = {
      userId: userRow.id,
      tenantId: deviceRow.tenantId,
      storeId: deviceRow.storeId,
      isPlatformAdmin: false,
      source: "token",
    };
    // deviceId is returned so the guard can populate `request.principal`
    // (the audit interceptor reads `principal.userId` for actor_user_id, and
    // a token principal carries the device id as `tokenId` — mirrors the
    // read-down device principal).
    return { kind: "ok", context, deviceId: deviceRow.id };
  }

  /**
   * Resolve the local user by JOINing the provider-neutral verified subject onto
   * the ACTIVE external_identity_links row (029 D3 / G-3). The join keys on
   * (provider_key, subject) for the active link — NOT issuer: v1 has a single
   * issuer, and keying on issuer would couple the runtime path to the
   * backfill-vs-adapter issuer-string contract (a mismatch would fail-close every
   * operator). issuer is stored + unique on the link for forward-compat
   * (multi-issuer dual-link), not used as the runtime join key.
   *
   * This is the PI-3 re-point: the resolver no longer reads `users.clerk_user_id`
   * as the join key. A verified subject with no ACTIVE link returns null → the
   * caller refuses `user_unmapped` (the same fail-closed, non-enumerating
   * refusal mig 0001 ADR D4 mandates).
   */
  private async findUserByExternalIdentity(
    providerKey: string,
    subject: string,
  ): Promise<UserLookupRow | null> {
    const r = await this.lookupPool.query<UserLookupRow>(
      `SELECT u.id, u.deleted_at
         FROM external_identity_links l
         JOIN users u ON u.id = l.user_id
        WHERE l.provider_key = $1
          AND l.subject = $2
          AND l.status = 'active'
        LIMIT 1`,
      [providerKey, subject],
    );
    return r.rows[0] ?? null;
  }

  private async findActiveMembership(
    tenantId: string,
    userId: string,
  ): Promise<MembershipLookupRow | null> {
    // The partial unique index `memberships_tenant_user_active_uidx` is scoped
    // `WHERE deleted_at IS NULL`, so a user may legitimately have ONE active row
    // plus one or more soft-deleted rows for the same (tenant_id, user_id). A bare
    // `LIMIT 1` with no `ORDER BY` lets Postgres return ANY of them in heap order —
    // a re-added user could intermittently get a stale revoked/deleted row, and the
    // caller would refuse them with `membership_revoked`. Order so the ACTIVE grant
    // (revoked_at / deleted_at both NULL) sorts first; the caller still inspects
    // revoked_at/deleted_at, so a genuinely revoked-only user is unchanged.
    return runWithTenantContext(
      this.pool,
      { tenantId, isPlatformAdmin: false },
      async (client) => {
        const r = await client.query<MembershipLookupRow>(
          `SELECT m.id, m.store_access_kind, m.revoked_at, m.deleted_at,
                  r.code AS role_code
             FROM memberships m
             JOIN roles r ON r.id = m.role_id
            WHERE m.tenant_id = $1
              AND m.user_id = $2
            ORDER BY m.revoked_at NULLS FIRST, m.deleted_at NULLS FIRST
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
          `SELECT 1 AS one FROM store_access
            WHERE membership_id = $1 AND store_id = $2 LIMIT 1`,
          [membershipId, storeId],
        );
        return r.rows.length > 0;
      },
    );
  }

  // -------------------------------------------------------------------------
  // 031 G-4 (Option B) — live re-verification for the envelope sale path.
  // Reuses the steps-3–5 checks above, keyed by IDs instead of JWT/attestation.
  // -------------------------------------------------------------------------

  async recoverDeviceId(tokenId: string): Promise<string | null> {
    // The envelope's auth_tokens row carries the bound device_id (the
    // pos_operator invariant guarantees it is non-null). Re-read it by the
    // token row id the canonical principal exposes as `tokenId`.
    const r = await this.lookupPool.query<{ device_id: string | null }>(
      `SELECT device_id FROM auth_tokens
        WHERE id = $1 AND scope = 'pos_operator' LIMIT 1`,
      [tokenId],
    );
    return r.rows[0]?.device_id ?? null;
  }

  async reverify(
    userId: string,
    deviceId: string,
    storeId: string,
  ): Promise<{ kind: "ok" } | { kind: "refused"; reason: ResolveOperatorRefusalReason }> {
    // Device still active? (revoked devices are excluded.)
    const device = await this.findActiveDeviceById(deviceId);
    if (!device) return { kind: "refused", reason: "device_invalid" };

    // Membership in the device's tenant still active + role still eligible?
    const membership = await this.findActiveMembership(device.tenantId, userId);
    if (!membership) return { kind: "refused", reason: "membership_missing" };
    if (membership.revoked_at !== null || membership.deleted_at !== null) {
      return { kind: "refused", reason: "membership_revoked" };
    }
    if (!ELIGIBLE_INTERNAL_ROLES.has(membership.role_code)) {
      return { kind: "refused", reason: "role_ineligible" };
    }

    // Store access still granted? ('all' → unconditional; 'specific' → in set.)
    if (membership.store_access_kind === "specific") {
      const ok = await this.storeIsInAccessSet(device.tenantId, membership.id, storeId);
      if (!ok) return { kind: "refused", reason: "store_not_in_access_set" };
    }

    return { kind: "ok" };
  }

  private async findActiveDeviceById(
    deviceId: string,
  ): Promise<{ id: string; tenantId: string } | null> {
    const r = await this.lookupPool.query<{ id: string; tenant_id: string }>(
      `SELECT id, tenant_id FROM devices
        WHERE id = $1 AND revoked_at IS NULL LIMIT 1`,
      [deviceId],
    );
    const row = r.rows[0];
    return row ? { id: row.id, tenantId: row.tenant_id } : null;
  }
}
