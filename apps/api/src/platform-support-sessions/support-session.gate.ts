/**
 * SupportSessionGate — the RT-414 cross-cutting enforcement point.
 *
 * A platform admin acting in a tenant they are NOT an active member of is
 * admitted to a covered route only when their auth session has an `active`
 * support session for exactly that tenant (platform-support-sessions.openapi.yaml,
 * `x-support-session-enforcement`). Callers check membership first; this gate
 * runs only for the non-member case.
 *
 * Decision, in the contract's order:
 *   1. no live support session, it is for another tenant, or the tenant is
 *      gone                                    → 403 `support_session_required`
 *   2. `expires_at` has passed                 → 403 `support_session_expired`
 *   3. the tenant is suspended and the method is unsafe (owner decision
 *      2026-10-12, RT-414 comment 11737: a suspended tenant's support session
 *      is read-only), unless the route is exempt (`updateTenant` with a
 *      status-only body, so the platform can reactivate it;
 *      `switchActiveStore`, navigation only)
 *                                              → 403 `support_session_read_only`
 *   4. otherwise admitted.
 *
 * Every decision writes exactly one `platform.cross_tenant.accessed` row, in
 * its own transaction that commits BEFORE a refusal is thrown. A failure to
 * write it fails the request (500): no covered request runs unaudited.
 * Passive expiry writes nothing else (it is computed from `expires_at`).
 *
 * RLS: the lookups and the audit insert run under the platform-admin GUC
 * (the bootstrap context every guard uses for membership reads). The route
 * handler still runs with `isPlatformAdmin: false` inside the tenant (RT-142),
 * which this gate does not touch.
 */
import { ForbiddenException } from "@nestjs/common";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool, PoolClient } from "pg";

import { hasLiveMembership } from "../context/membership.repository";

import { withSupportSessionCtx } from "./support-session.lifecycle";
import {
  findLiveSupportSession,
  recordCrossTenantAccess,
  type CrossTenantRefusal,
  type SupportSessionRecord,
} from "./support-session.store";

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

const REFUSAL_MESSAGES: Readonly<Record<CrossTenantRefusal, string>> = {
  support_session_required: "An active support session for this tenant is required",
  support_session_expired: "The support session has expired; open a new one",
  support_session_read_only: "The support session is read-only for this tenant",
  origin_rejected: "Request origin is not allowed",
};

export function supportSessionRefusal(reason: CrossTenantRefusal): ForbiddenException {
  return new ForbiddenException({ code: reason, message: REFUSAL_MESSAGES[reason] });
}

export interface TenantState {
  readonly exists: boolean;
  readonly suspended: boolean;
}

/** Pure decision (steps 1-3 above); `undefined` means admitted. */
export function decideSupportSession(input: {
  readonly session: SupportSessionRecord | null;
  readonly tenantId: string;
  readonly tenant: TenantState;
  readonly method: string;
  readonly readOnlyExempt: boolean;
}): CrossTenantRefusal | undefined {
  if (!sessionCoversTenant(input)) return "support_session_required";
  if (input.session.status !== "active") return "support_session_expired";
  if (isReadOnlyRefusal(input)) return "support_session_read_only";
  return undefined;
}

function sessionCoversTenant(input: {
  readonly session: SupportSessionRecord | null;
  readonly tenantId: string;
  readonly tenant: TenantState;
}): input is typeof input & { readonly session: SupportSessionRecord } {
  return input.tenant.exists && input.session?.tenantId === input.tenantId;
}

/** A suspended tenant's support session admits only safe methods, unless exempt. */
function isReadOnlyRefusal(input: {
  readonly tenant: TenantState;
  readonly method: string;
  readonly readOnlyExempt: boolean;
}): boolean {
  if (!input.tenant.suspended || input.readOnlyExempt) return false;
  return UNSAFE_METHODS.has(input.method.toUpperCase());
}

export interface GateRequest {
  readonly authSessionId: string;
  readonly userId: string;
  readonly method: string;
  /** Route template, never the concrete path. */
  readonly route: string;
  readonly requestId: string | null;
  /** Unsafe methods stay admitted on a suspended tenant (see header). */
  readonly readOnlyExempt?: boolean;
}

export interface GateVerdict {
  readonly session: SupportSessionRecord | null;
  readonly reason: CrossTenantRefusal | undefined;
}

export class SupportSessionGate {
  constructor(private readonly pool: Pool) {}

  /**
   * Admit or refuse a non-member platform admin in `tenantId`. Returns the
   * admitting support session; throws 403 after recording a refusal.
   */
  async enforce(tenantId: string, request: GateRequest): Promise<SupportSessionRecord> {
    const verdict = await this.withPlatformCtx(async (client) => {
      const decided = await this.decide(client, tenantId, request);
      await recordCrossTenantAccess(client, {
        tenantId,
        actorUserId: request.userId,
        requestId: request.requestId,
        method: request.method,
        route: request.route,
        session: decided.session,
        ...(decided.reason === undefined ? {} : { reason: decided.reason }),
      });
      return decided;
    });
    if (verdict.reason !== undefined || verdict.session === null) {
      throw supportSessionRefusal(verdict.reason ?? "support_session_required");
    }
    return verdict.session;
  }

  /**
   * A path tenant that is not a UUID or names no tenant (`listMembers`,
   * `updateTenant`): refused exactly like an existing non-member tenant
   * (FR-ISO-4), with its row platform-scoped (`tenant_id` null).
   */
  async refuseUnresolvable(request: GateRequest): Promise<never> {
    await this.withPlatformCtx((client) =>
      recordCrossTenantAccess(client, {
        tenantId: null,
        actorUserId: request.userId,
        requestId: request.requestId,
        method: request.method,
        route: request.route,
        session: null,
        reason: "support_session_required",
      }),
    );
    throw supportSessionRefusal("support_session_required");
  }

  /**
   * RT-430 refused an unsafe request's `Origin` before any tenant logic ran.
   * Record the row the contract's order would have produced: the support-session
   * refusal when the session does not admit the request, else `origin_rejected`.
   * Returns the refusal the caller should throw.
   */
  async recordOriginRefusal(tenantId: string, request: GateRequest): Promise<ForbiddenException> {
    const reason = await this.withPlatformCtx(async (client) => {
      const decided = await this.decide(client, tenantId, request);
      const refusal = decided.reason ?? "origin_rejected";
      await recordCrossTenantAccess(client, {
        tenantId,
        actorUserId: request.userId,
        requestId: request.requestId,
        method: request.method,
        route: request.route,
        session: decided.session,
        reason: refusal,
      });
      return refusal;
    });
    return supportSessionRefusal(reason);
  }

  /** Whether `userId` has a live membership in `tenantId`, whatever the tenant status. */
  async isMember(member: { readonly userId: string; readonly tenantId: string }): Promise<boolean> {
    return this.withPlatformCtx((client) => hasLiveMembership(drizzle(client), member));
  }

  /**
   * Whether `tenantId` is a UUID naming a tenant row, soft-deleted or not
   * (the `audit_events.tenant_id` FK target). False means the path tenant is
   * unresolvable and its row must be platform-scoped.
   */
  async tenantRowExists(tenantId: string): Promise<boolean> {
    if (!UUID_RE.test(tenantId)) return false;
    return this.withPlatformCtx(async (client) => {
      const { rows } = await client.query(`SELECT 1 FROM tenants WHERE id = $1`, [tenantId]);
      return rows.length > 0;
    });
  }

  private async decide(
    client: PoolClient,
    tenantId: string,
    request: GateRequest,
  ): Promise<GateVerdict> {
    const session = await findLiveSupportSession(client, request.authSessionId);
    const tenant = await readTenant(client, tenantId);
    const reason = decideSupportSession({
      session,
      tenantId,
      tenant,
      method: request.method,
      readOnlyExempt: request.readOnlyExempt === true,
    });
    return { session, reason };
  }

  private withPlatformCtx<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    return withSupportSessionCtx(this.pool, work);
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function readTenant(client: PoolClient, tenantId: string): Promise<TenantState> {
  if (!UUID_RE.test(tenantId)) return { exists: false, suspended: false };
  const { rows } = await client.query<{ status: string }>(
    `SELECT status FROM tenants WHERE id = $1 AND deleted_at IS NULL`,
    [tenantId],
  );
  const row = rows[0];
  return { exists: row !== undefined, suspended: row?.status === "suspended" };
}
