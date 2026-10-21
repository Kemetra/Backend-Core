/**
 * PlatformAdminGuard — RT-431 (`listPlatformAuditEvents`).
 *
 * Runs after `SessionOnlyAdminGuard` (human cookie session only, any bearer
 * is 401) and admits only a session user whose `users.is_platform_admin` is
 * true, read from the database (RT-132 D6). Everyone else, a tenant owner
 * included, gets 403 `forbidden`. As a guard it runs before the query pipe,
 * so a non-admin never learns which query parameters are valid.
 *
 * It does not resolve or require an active tenant, and it is not
 * `TenantContextGuard`, so RT-414 support-session enforcement does not cover
 * the route (see `support-session.coverage.ts`).
 */
import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";

import type { AuthedRequest } from "../auth/auth.guard";
import { MembershipRepository } from "../context/membership.repository";

@Injectable()
export class PlatformAdminGuard implements CanActivate {
  constructor(
    @Inject(MembershipRepository)
    private readonly memberships: MembershipRepository,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const principal = context.switchToHttp().getRequest<AuthedRequest>().principal;
    if (principal?.kind !== "session") throw new UnauthorizedException("Unauthorized");
    if (await this.memberships.isPlatformAdmin(principal.userId)) return true;
    throw new ForbiddenException({ code: "forbidden", message: "Platform admin required" });
  }
}
