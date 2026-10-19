/**
 * AiOwnerMembershipGuard — RT-664 (AD-AI-ENT-001 D-5): the opt-out write is
 * the tenant OWNER's only.
 *
 * `@Roles("owner")` alone is not enough: `RolesGuard` admits a platform admin
 * on any `@Roles` route, and a platform write path would turn the
 * tenant-authored opt-out source into a grant path. This guard runs after
 * `RolesGuard` and requires an active `owner` membership of the session's
 * tenant, whatever the platform flag. It also refuses a `{tenant_id}` that is
 * a well-formed id of another tenant. Both refusals are the same
 * non-disclosing 404, raised before the idempotency interceptor stores a key
 * (contract check order step 1). A malformed `{tenant_id}` passes to the
 * handler's 400.
 */
import { CanActivate, ExecutionContext, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { runWithTenantContext } from "@data-pulse-2/db";
import type { Pool } from "pg";

import { PG_POOL } from "../auth/auth.module";
import { MembershipRepository } from "../context/membership.repository";
import type { ResolvedContext, TenantContextRequest } from "../context/types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOT_FOUND = { code: "not_found", message: "Not Found" } as const;

type GuardRequest = TenantContextRequest & { params?: Record<string, string> };

function refuse(): never {
  throw new NotFoundException(NOT_FOUND);
}

/** The session's user and tenant, or null for anything but a session member context. */
function sessionMember(ctx: ResolvedContext | undefined): { userId: string; tenantId: string } | null {
  if (ctx === undefined || ctx.source !== "session") return null;
  const { userId, tenantId } = ctx;
  return userId === null || tenantId === null ? null : { userId, tenantId };
}

/** A well-formed `{tenant_id}` of another tenant (a malformed one is the handler's 400). */
function namesAnotherTenant(request: GuardRequest, tenantId: string): boolean {
  const pathTenant = request.params?.["tenant_id"] ?? "";
  return UUID.test(pathTenant) && pathTenant.toLowerCase() !== tenantId.toLowerCase();
}

@Injectable()
export class AiOwnerMembershipGuard implements CanActivate {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(MembershipRepository) private readonly memberships: MembershipRepository,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<GuardRequest>();
    const member = sessionMember(request.context) ?? refuse();
    if (namesAnotherTenant(request, member.tenantId)) refuse();
    const role = await runWithTenantContext(this.pool, { tenantId: member.tenantId, isPlatformAdmin: false }, (client) =>
      this.memberships.findRoleCodeForUserInTenant(member.userId, member.tenantId, client),
    );
    if (role !== "owner") refuse();
    return true;
  }
}
