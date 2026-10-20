/**
 * PlatformSupportSessionsService — the four RT-414 operations
 * (platform-support-sessions.openapi.yaml): open, read current, renew, end.
 *
 * Every operation is platform-admin only (`users.is_platform_admin`, RT-132
 * D6) on a cookie session; the controller's guard refuses bearer tokens.
 *
 * State and audit: each change to `platform_support_sessions` and its
 * `platform.support_session.*` row are written in one transaction on the
 * domain pool under the platform-admin GUC, serialized per auth session by a
 * transaction advisory lock. The auth session's active tenant lives in
 * `sessions`, which only the auth lookup role may write (RT-143), so it is
 * updated in a second step AFTER the support-session transaction commits. A
 * failure between the two steps is safe in either direction: an opened
 * session whose tenant was not made active is "for another tenant" and admits
 * nothing, and an ended session whose tenant is still active is refused as
 * `support_session_required`.
 *
 * Tenant states (owner decision 2026-10-12, RT-414 comment 11737): active,
 * pending and suspended tenants can be entered (a suspended tenant's session
 * is read-only, enforced by `SupportSessionGate`); a soft-deleted or unknown
 * tenant is the one non-disclosing 404 (FR-ISO-4).
 */
import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import type { Pool, PoolClient } from "pg";

import type { Principal } from "../auth/auth.guard";
import type { SessionRepository } from "../auth/session.repository";
import type { MembershipRepository } from "../context/membership.repository";
import type { OpenSupportSessionInput } from "./dto";
import { endSupportSessions, withSupportSessionCtx } from "./support-session.lifecycle";
import {
  SUPPORT_SESSION_ENDED,
  SUPPORT_SESSION_OPENED,
  SUPPORT_SESSION_RENEWED,
  endSupportSessionRow,
  findLiveSupportSession,
  insertSupportSession,
  recordSupportSessionChange,
  renewSupportSession,
  toSupportSessionBody,
  type SupportSessionBody,
} from "./support-session.store";

type SessionPrincipal = Extract<Principal, { kind: "session" }>;

export interface CurrentSupportSessionBody {
  readonly support_session: SupportSessionBody | null;
}

export class PlatformSupportSessionsService {
  constructor(
    /** The domain pool (NOBYPASSRLS); 0062's policy admits the platform-admin GUC. */
    private readonly pool: Pool,
    private readonly sessions: SessionRepository,
    private readonly memberships: MembershipRepository,
  ) {}

  async open(
    principal: Principal | undefined,
    input: OpenSupportSessionInput,
    requestId: string | null,
  ): Promise<SupportSessionBody> {
    const caller = await this.requirePlatformAdmin(principal);
    const auth = await this.requireAuthSession(caller);

    const opened = await this.inAuthSessionTx(caller, async (client) => {
      await assertEnterableNonMember(client, caller.userId, input.tenant_id);
      const live = await findLiveSupportSession(client, caller.sessionId, { forUpdate: true });
      if (live) {
        const replaced = await endSupportSessionRow(client, live.id, "replaced");
        if (replaced) {
          await recordSupportSessionChange(client, SUPPORT_SESSION_ENDED, replaced, requestId);
        }
      }
      const record = await insertSupportSession(client, {
        authSessionId: caller.sessionId,
        userId: caller.userId,
        tenantId: input.tenant_id,
        purpose: input.purpose,
        ticketRef: input.ticket_ref ?? null,
        authAbsoluteExpiresAt: auth.absoluteExpiresAt,
      });
      await recordSupportSessionChange(client, SUPPORT_SESSION_OPENED, record, requestId);
      return record;
    });

    const updated = await this.sessions.updateActiveContext(caller.sessionId, {
      activeTenantId: input.tenant_id,
      activeStoreId: null,
    });
    if (!updated) {
      // The auth session was revoked meanwhile: close what we just opened.
      await endSupportSessions(this.pool, { authSessionId: caller.sessionId }, "signed_out", requestId);
      throw unauthorized();
    }
    return toSupportSessionBody(opened);
  }

  async current(principal: Principal | undefined): Promise<CurrentSupportSessionBody> {
    const caller = await this.requirePlatformAdmin(principal);
    const live = await withSupportSessionCtx(this.pool, (client) =>
      findLiveSupportSession(client, caller.sessionId),
    );
    return { support_session: live ? toSupportSessionBody(live) : null };
  }

  async renew(principal: Principal | undefined, requestId: string | null): Promise<SupportSessionBody> {
    const caller = await this.requirePlatformAdmin(principal);
    const auth = await this.requireAuthSession(caller);

    const renewed = await this.inAuthSessionTx(caller, async (client) => {
      const live = await findLiveSupportSession(client, caller.sessionId, { forUpdate: true });
      if (!live) throw conflict("support_session_absent", "There is no support session to renew");
      if (live.status !== "active") {
        throw conflict("support_session_expired", "The support session has expired; open a new one");
      }
      const record = await renewSupportSession(client, live.id, auth.absoluteExpiresAt);
      if (!record) {
        throw conflict(
          "support_session_renewal_cap_reached",
          "The support session cannot be renewed further; open a new one",
        );
      }
      await recordSupportSessionChange(client, SUPPORT_SESSION_RENEWED, record, requestId);
      return record;
    });
    return toSupportSessionBody(renewed);
  }

  async end(principal: Principal | undefined, requestId: string | null): Promise<SupportSessionBody> {
    const caller = await this.requirePlatformAdmin(principal);

    const ended = await this.inAuthSessionTx(caller, async (client) => {
      const live = await findLiveSupportSession(client, caller.sessionId, { forUpdate: true });
      const record = live ? await endSupportSessionRow(client, live.id, "operator") : null;
      if (!record) throw conflict("support_session_absent", "There is no support session to end");
      await recordSupportSessionChange(client, SUPPORT_SESSION_ENDED, record, requestId);
      return record;
    });

    // Clear only the ended session's tenant: a tenant switch that raced in
    // (another tab) keeps the tenant it selected.
    const cleared = await this.sessions.clearActiveTenantIf(caller.sessionId, ended.tenantId);
    if (!cleared && !(await this.sessions.findActiveById(caller.sessionId))) throw unauthorized();
    return toSupportSessionBody(ended);
  }

  // ----- internals ---------------------------------------------------------

  private async requirePlatformAdmin(principal: Principal | undefined): Promise<SessionPrincipal> {
    if (principal?.kind !== "session") throw unauthorized();
    if (!(await this.memberships.isPlatformAdmin(principal.userId))) {
      throw new ForbiddenException({ code: "forbidden", message: "Platform admin required" });
    }
    return principal;
  }

  private async requireAuthSession(caller: SessionPrincipal): Promise<{ absoluteExpiresAt: Date }> {
    const session = await this.sessions.findActiveById(caller.sessionId);
    if (!session) throw unauthorized();
    return { absoluteExpiresAt: session.absoluteExpiresAt };
  }

  /** One transaction, serialized per auth session (no two live rows race in). */
  private inAuthSessionTx<T>(
    caller: SessionPrincipal,
    work: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    return withSupportSessionCtx(this.pool, async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('platform_support_session:' || $1, 0))`, [
        caller.sessionId,
      ]);
      return work(client);
    });
  }
}

/** 404 for an unknown or soft-deleted tenant; 409 `already_member` for a member. */
async function assertEnterableNonMember(
  client: PoolClient,
  userId: string,
  tenantId: string,
): Promise<void> {
  const tenant = await client.query(
    `SELECT 1 FROM tenants WHERE id = $1 AND deleted_at IS NULL`,
    [tenantId],
  );
  if (tenant.rows.length === 0) throw new NotFoundException("Not Found");
  const membership = await client.query(
    `SELECT 1 FROM memberships
      WHERE user_id = $1 AND tenant_id = $2 AND revoked_at IS NULL AND deleted_at IS NULL
      LIMIT 1`,
    [userId, tenantId],
  );
  if (membership.rows.length > 0) {
    throw conflict("already_member", "You are a member of this tenant; switch to it instead");
  }
}

function conflict(code: string, message: string): ConflictException {
  return new ConflictException({ code, message });
}

function unauthorized(): UnauthorizedException {
  return new UnauthorizedException("Unauthorized");
}
