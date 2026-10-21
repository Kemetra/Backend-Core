/**
 * PlatformAuditController — `GET /api/v1/platform/audit/events` (RT-431).
 *
 * Conforms to `packages/contracts/openapi/audit.openapi.yaml`
 * (operationId `listPlatformAuditEvents`). Decisions D1–D5 (RT-431 comment
 * 13238):
 *
 *   - Rows stored with `tenant_id` NULL only; never a tenant's row.
 *   - `SessionOnlyAdminGuard` (cookie only; any bearer is 401), then
 *     `PlatformAdminGuard` (`users.is_platform_admin`; anyone else, a tenant
 *     owner included, is 403). No active tenant is needed.
 *   - Its own class, NOT behind `TenantContextGuard`: RT-414 support-session
 *     enforcement matches that guard by name, and this route is not
 *     tenant-scoped. No support session is required or used and no
 *     `platform.cross_tenant.accessed` row is written.
 *   - No `@Auditable`: reading audit is not itself audited.
 *   - `actor_label` masked by the service; no IP is stored or returned.
 */
import { Controller, Get, Inject, Query, UseGuards } from "@nestjs/common";

import { SessionOnlyAdminGuard } from "../auth/session-only-admin.guard";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { ConsoleRateLimit } from "../console-rate-limit/console-rate-limit.decorator";

import type { ListPlatformAuditEventsResponse } from "./audit.dto";
import { PlatformAdminGuard } from "./platform-admin.guard";
import {
  PlatformAuditQuerySchema,
  type PlatformAuditQueryParsed,
} from "./platform-audit.query.schema";
import { PlatformAuditService } from "./platform-audit.service";

@Controller("api/v1/platform/audit")
@UseGuards(SessionOnlyAdminGuard, PlatformAdminGuard)
export class PlatformAuditController {
  constructor(
    @Inject(PlatformAuditService)
    private readonly service: PlatformAuditService,
  ) {}

  @Get("events")
  // RT-431: same cost class as listAuditEvents (RT-619, RT-574 D3).
  @ConsoleRateLimit("expensiveRead")
  async listPlatformAuditEvents(
    @Query(new ZodValidationPipe(PlatformAuditQuerySchema)) query: PlatformAuditQueryParsed,
  ): Promise<ListPlatformAuditEventsResponse> {
    return this.service.list(query);
  }
}
