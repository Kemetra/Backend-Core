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
import type { TenantContextRequest } from "../context/types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOT_FOUND = { code: "not_found", message: "Not Found" } as const;

@Injectable()
export class AiOwnerMembershipGuard implements CanActivate {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(MembershipRepository) private readonly memberships: MembershipRepository,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<TenantContextRequest & { params?: Record<string, string> }>();
    const ctx = request.context;
    if (ctx === undefined || ctx.source !== "session" || ctx.userId === null || ctx.tenantId === null) {
      throw new NotFoundException(NOT_FOUND);
    }
    const pathTenant = request.params?.["tenant_id"] ?? "";
    if (UUID.test(pathTenant) && pathTenant.toLowerCase() !== ctx.tenantId.toLowerCase()) throw new NotFoundException(NOT_FOUND);
    const { userId, tenantId } = ctx;
    const role = await runWithTenantContext(this.pool, { tenantId, isPlatformAdmin: false }, (client) =>
      this.memberships.findRoleCodeForUserInTenant(userId, tenantId, client),
    );
    if (role !== "owner") throw new NotFoundException(NOT_FOUND);
    return true;
  }
}
