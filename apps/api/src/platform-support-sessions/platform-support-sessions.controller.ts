/**
 * PlatformSupportSessionsController — RT-414 (platform-support-sessions.openapi.yaml):
 *
 *     POST /api/v1/platform/support-sessions                openSupportSession
 *     GET  /api/v1/platform/support-sessions/current        getCurrentSupportSession
 *     POST /api/v1/platform/support-sessions/current/renew  renewSupportSession
 *     POST /api/v1/platform/support-sessions/current/end    endSupportSession
 *
 * `SessionOnlyAdminGuard`: a human cookie session only; any bearer token is
 * 401. Every POST passes the RT-430 `Origin` check in `AuthGuard` (RT-414
 * decision 5): a missing or foreign `Origin` is 403 `origin_rejected`. The
 * platform-admin check is the service's. Not mounted behind
 * `TenantContextGuard`: these routes enter and leave a tenant, and none of
 * them writes a `platform.cross_tenant.accessed` row.
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";

import type { AuthedRequest } from "../auth/auth.guard";
import { SessionOnlyAdminGuard } from "../auth/session-only-admin.guard";
import { ConsoleRateLimit } from "../console-rate-limit/console-rate-limit.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { OpenSupportSessionSchema, type OpenSupportSessionInput } from "./dto";
import {
  PlatformSupportSessionsService,
  type CurrentSupportSessionBody,
} from "./platform-support-sessions.service";
import type { SupportSessionBody } from "./support-session.store";

@Controller("api/v1/platform/support-sessions")
@UseGuards(SessionOnlyAdminGuard)
export class PlatformSupportSessionsController {
  constructor(private readonly service: PlatformSupportSessionsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  // RT-619 (RT-574 D3): entering a tenant is an onboarding-class action.
  @ConsoleRateLimit("onboarding")
  async open(
    @Req() request: AuthedRequest,
    @Body(new ZodValidationPipe(OpenSupportSessionSchema)) body: OpenSupportSessionInput,
  ): Promise<SupportSessionBody> {
    return this.service.open(request.principal, body, request.requestId ?? null);
  }

  @Get("current")
  async current(@Req() request: AuthedRequest): Promise<CurrentSupportSessionBody> {
    return this.service.current(request.principal);
  }

  @Post("current/renew")
  @HttpCode(HttpStatus.OK)
  async renew(@Req() request: AuthedRequest): Promise<SupportSessionBody> {
    return this.service.renew(request.principal, request.requestId ?? null);
  }

  @Post("current/end")
  @HttpCode(HttpStatus.OK)
  // RT-619 (RT-574 D3): leaving must not starve behind ordinary writes.
  @ConsoleRateLimit("incidentControl")
  async end(@Req() request: AuthedRequest): Promise<SupportSessionBody> {
    return this.service.end(request.principal, request.requestId ?? null);
  }
}
