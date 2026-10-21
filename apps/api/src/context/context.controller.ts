/**
 * ContextController — slice 11 (T153).
 *
 * Implements the four endpoints in
 * `specs/001-foundation-auth-tenant-store/contracts/context.openapi.yaml`:
 *
 *     GET    /api/v1/context/me        getActiveContext
 *     POST   /api/v1/context/tenant    switchActiveTenant
 *     POST   /api/v1/context/store     switchActiveStore
 *     DELETE /api/v1/context/store     clearActiveStore
 *
 * Why this controller is NOT guarded by `TenantContextGuard`
 * ---------------------------------------------------------
 * `TenantContextGuard` (PR #19) requires an active tenant on the
 * principal. The whole purpose of these endpoints is to *establish*
 * or *change* that active tenant — running the guard would create a
 * chicken-and-egg loop where the user can't switch tenant without
 * already having a valid tenant. `AuthGuard` is sufficient: every
 * route requires an authenticated principal, and `ContextService`
 * runs the membership / store-access checks itself before mutating
 * the session.
 *
 * Cross-cutting policies (consistent with AuthController)
 * ------------------------------------------------------
 *   - Bodies validated by `ZodValidationPipe`. Bad bodies bubble as
 *     `ZodError` and the global filter renders them as 400
 *     `validation_error` envelopes.
 *   - All thrown exceptions (`UnauthorizedException`,
 *     `NotFoundException`, `ConflictException`, `BadRequestException`)
 *     pass through `GlobalExceptionFilter` to the canonical envelope.
 *   - Response bodies are the snake-case `ContextResponse` shape
 *     returned by `ContextService`; the controller hands them back
 *     verbatim.
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import type { AuthedRequest } from "../auth/auth.guard";
import { DashboardAuthGuard } from "../auth/dashboard-auth.guard";
import { Auditable } from "../audit/auditable.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import {
  ContextService,
  type ContextResponseBody,
} from "./context.service";
import {
  SwitchStoreSchema,
  SwitchTenantSchema,
  type SwitchStoreInput,
  type SwitchTenantInput,
} from "./dto";

@Controller("api/v1/context")
@UseGuards(DashboardAuthGuard)
export class ContextController {
  constructor(private readonly contextService: ContextService) {}

  @Get("me")
  async me(@Req() request: AuthedRequest): Promise<ContextResponseBody> {
    const principal = request.principal;
    if (!principal) throw new UnauthorizedException("Unauthorized");
    return this.contextService.getActiveContext(principal);
  }

  @Auditable("context.switch.tenant")
  @Post("tenant")
  @HttpCode(HttpStatus.OK)
  async switchTenant(
    @Req() request: AuthedRequest,
    @Body(new ZodValidationPipe(SwitchTenantSchema)) body: SwitchTenantInput,
  ): Promise<ContextResponseBody> {
    const principal = request.principal;
    if (!principal) throw new UnauthorizedException("Unauthorized");
    return this.contextService.switchTenant(
      principal,
      body.tenant_id,
      request.requestId ?? null,
    );
  }

  @Auditable("context.switch.store")
  @Post("store")
  @HttpCode(HttpStatus.OK)
  async switchStore(
    @Req() request: AuthedRequest,
    @Body(new ZodValidationPipe(SwitchStoreSchema)) body: SwitchStoreInput,
  ): Promise<ContextResponseBody> {
    const principal = request.principal;
    if (!principal) throw new UnauthorizedException("Unauthorized");
    return this.contextService.switchStore(
      principal,
      body.store_id,
      request.requestId ?? null,
    );
  }

  @Auditable("context.clear.store")
  @Delete("store")
  @HttpCode(HttpStatus.OK)
  async clearStore(
    @Req() request: AuthedRequest,
  ): Promise<ContextResponseBody> {
    const principal = request.principal;
    if (!principal) throw new UnauthorizedException("Unauthorized");
    return this.contextService.clearStore(principal);
  }
}
