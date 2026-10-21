/**
 * PosShiftsService — Wave 4.1b stuck-shift discovery.
 *
 * Auth pipeline:
 *   1. Verify the operator identity token.
 *   2. Resolve the verified identity → users.id through its ACTIVE identity link.
 *   3. Find active membership for caller on the requested branch.
 *   4. Confirm role is manager/admin (owner, tenant_admin, store_manager).
 *   5. Confirm branch access when store_access_kind = 'specific'.
 *
 * Stuck-shift predicate:
 *   lifecycle_state = 'open'
 *   AND opened_at < now() - stuckThresholdMinutes
 *   AND no active pos_operator auth_token for the opening cashier on that branch.
 *
 * Membership and access checks use a transaction-local bootstrap RLS
 * context; the shifts query uses the resolved tenant context.
 * users/devices have no RLS, so the JOIN works without extra context.
 */
import { Injectable } from "@nestjs/common";
import type { Logger } from "@data-pulse-2/shared";
import { runWithTenantContext } from "@data-pulse-2/db";
import type { Pool } from "pg";

import { findUserByActiveLink } from "../auth/identity-link-lookup";
import type { OperatorTokenClaims, OperatorTokenVerifier } from "../auth/operator-token-verifier";
import type { StuckShiftItem, StuckShiftsResponseBody } from "./dto";

const ELIGIBLE_INTERNAL_ROLES = new Set([
  "owner",
  "tenant_admin",
  "store_manager",
]);

interface MembershipRow {
  id: string;
  tenant_id: string;
  store_access_kind: string;
  role_code: string;
}

interface ShiftRow {
  shift_id: string;
  display_name: string;
  label: string;
  opened_at: Date;
}

export type StuckShiftsResult =
  | { kind: "ok"; body: StuckShiftsResponseBody }
  | { kind: "refused" };

@Injectable()
export class PosShiftsService {
  constructor(
    private readonly pool: Pool,
    private readonly operatorTokenVerifier: OperatorTokenVerifier,
    private readonly logger: Logger,
    private readonly stuckThresholdMinutes: number = 15,
    /** Reads `external_identity_links`; the lookup role is the one documented to. */
    private readonly lookupPool: Pool = pool,
  ) {}

  async getStuck(
    rawJwt: string,
    branchId: string,
    requestId: string | null,
  ): Promise<StuckShiftsResult> {
    // 1. Verify the identity token.
    let claims: OperatorTokenClaims;
    try {
      claims = await this.operatorTokenVerifier.verify(rawJwt);
    } catch {
      this.logger.warn({ request_id: requestId }, "pos-shifts: identity token invalid");
      return { kind: "refused" };
    }

    // 2. Resolve the verified identity → users.id through the ACTIVE link. The
    // subject is never logged: it is a provider identifier of a person.
    const user = await findUserByActiveLink(this.lookupPool, {
      providerKey: claims.providerKey,
      subject: claims.sub,
    });
    if (!user || user.deleted_at !== null) {
      this.logger.warn({ request_id: requestId }, "pos-shifts: user unmapped");
      return { kind: "refused" };
    }
    const userId = user.id;

    // 3. Find an active membership on the requested branch. The verified
    // user and branch IDs constrain this bootstrap read before authorization.
    const membership = await runWithTenantContext(
      this.pool,
      { tenantId: null, isPlatformAdmin: true },
      async (client) => {
        const membershipRow = await client.query<MembershipRow>(
          `SELECT m.id, m.tenant_id, m.store_access_kind, r.code AS role_code
             FROM memberships m
             JOIN roles r ON r.id = m.role_id
             JOIN stores s ON s.tenant_id = m.tenant_id AND s.id = $1
            WHERE m.user_id = $2
              AND m.revoked_at IS NULL
              AND m.deleted_at IS NULL
            LIMIT 1`,
          [branchId, userId],
        );
        const row = membershipRow.rows[0];
        if (!row || !ELIGIBLE_INTERNAL_ROLES.has(row.role_code)) {
          return row ?? null;
        }
        if (row.store_access_kind === "specific") {
          const accessRow = await client.query<{ one: number }>(
            `SELECT 1 AS one FROM store_access WHERE membership_id = $1 AND store_id = $2 LIMIT 1`,
            [row.id, branchId],
          );
          if (!accessRow.rows[0]) return null;
        }
        return row;
      },
    );
    if (!membership) {
      this.logger.warn({ request_id: requestId, userId, branchId }, "pos-shifts: no membership");
      return { kind: "refused" };
    }

    // 4. Role eligibility check.
    if (!ELIGIBLE_INTERNAL_ROLES.has(membership.role_code)) {
      this.logger.warn(
        { request_id: requestId, userId, role: membership.role_code },
        "pos-shifts: role ineligible",
      );
      return { kind: "refused" };
    }

    // 5. Query stuck shifts (inside tenant RLS context).
    const shifts = await runWithTenantContext(
      this.pool,
      { tenantId: membership.tenant_id, isPlatformAdmin: false },
      async (client) => {
        const r = await client.query<ShiftRow>(
          `SELECT s.shift_id, u.display_name, d.label, s.opened_at
             FROM shifts s
             JOIN users u ON u.id = s.opening_cashier_user_id
             JOIN devices d ON d.id = s.opening_device_id
             LEFT JOIN auth_tokens t
               ON  t.scope     = 'pos_operator'
               AND t.user_id   = s.opening_cashier_user_id
               AND t.store_id  = s.store_id
               AND t.revoked_at IS NULL
               AND t.expires_at > now()
            WHERE s.tenant_id       = $1
              AND s.store_id        = $2
              AND s.lifecycle_state = 'open'
              AND s.opened_at       < now() - ($3::int * INTERVAL '1 minute')
              AND t.id IS NULL
              AND u.display_name IS NOT NULL
            ORDER BY s.opened_at`,
          [membership.tenant_id, branchId, this.stuckThresholdMinutes],
        );
        return r.rows;
      },
    );

    const now = Date.now();
    const items: StuckShiftItem[] = shifts
      .map((row) => ({
        shift_id: row.shift_id,
        cashier_display_name: row.display_name,
        terminal_label: row.label,
        opened_at: row.opened_at.toISOString(),
        duration_minutes: Math.floor((now - row.opened_at.getTime()) / 60_000),
      }));

    return { kind: "ok", body: { kind: "ok", shifts: items } };
  }
}
