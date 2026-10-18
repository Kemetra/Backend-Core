/**
 * AuditController — `GET /api/v1/audit/events` (T235).
 *
 * Conforms to `packages/contracts/openapi/audit.openapi.yaml`
 * (operationId `listAuditEvents`).
 *
 * Guard chain
 * -----------
 *   AuthGuard          — authenticate session/token (401 on failure).
 *   TenantContextGuard — resolve active tenant; throws 401 when the
 *                        caller has no active tenant set (the spec
 *                        treats "no active tenant" as 401, not 400).
 *   RolesGuard         — `@Roles("owner", "tenant_admin", { denyAs: 403 })`
 *                        — the caller is acting within their already-
 *                        resolved active tenant; insufficient role is a
 *                        403, NOT a 404. Platform admins bypass via
 *                        `RolesGuard.isPlatformAdmin`.
 *
 * Why no `@Auditable` on this handler
 * -----------------------------------
 * Reading audit MUST NOT itself emit an audit event. Audit-of-audit
 * creates unbounded log volume (every page-fetch produces another row
 * the dashboard will then page through), and the spec OpenAPI does not
 * list this action. The controller spec asserts `Reflector.get` returns
 * `undefined` for the `AUDITABLE_KEY` on `listAuditEvents` to pin this.
 *
 * Tenant scoping
 * --------------
 * The active tenant comes from `request.context.tenantId` (set by
 * `TenantContextGuard`). There is intentionally NO `tenant_id` query
 * param — platform-admin reads also run "as the active tenant". To
 * read another tenant's audit log, a platform admin uses
 * `POST /context/tenant` first.
 */
import {
  Controller,
  Get,
  Inject,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";

import { DashboardAuthGuard } from "../auth/dashboard-auth.guard";
import { Roles } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";
import { TenantContextGuard } from "../context/tenant-context.guard";
import type { TenantContextRequest } from "../context/types";
import { ZodValidationPipe } from "../common/zod-validation.pipe";

import { AuditService } from "./audit.service";
import {
  AuditQuerySchema,
  type AuditQueryParsed,
} from "./audit.query.schema";
import type { ListAuditEventsResponse } from "./audit.dto";

@Controller("api/v1/audit")
@UseGuards(DashboardAuthGuard, TenantContextGuard, RolesGuard)
export class AuditController {
  constructor(
    @Inject(AuditService)
    private readonly auditService: AuditService,
  ) {}

  @Get("events")
  @Roles("owner", "tenant_admin", { denyAs: 403 })
  async listAuditEvents(
    @Req() request: TenantContextRequest,
    @Query(new ZodValidationPipe(AuditQuerySchema)) query: AuditQueryParsed,
  ): Promise<ListAuditEventsResponse> {
    const ctx = request.context;
    if (!ctx) throw new UnauthorizedException("Unauthorized");
    // No active tenant → 401. TenantContextGuard already throws this, but
    // a defensive check here keeps the type-narrowing sound and covers
    // future guard-ordering changes.
    if (!ctx.tenantId) throw new UnauthorizedException("Unauthorized");

    return this.auditService.list({
      tenantId: ctx.tenantId,
      isPlatformAdmin: ctx.isPlatformAdmin,
      action: query.action,
      kind: query.kind,
      actor_user_id: query.actor_user_id,
      store_id: query.store_id,
      from: query.from,
      to: query.to,
      cursor: query.cursor,
      limit: query.limit,
    });
  }
}

