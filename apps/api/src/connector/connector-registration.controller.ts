/**
 * ConnectorRegistrationController — 018-US1 (T044).
 *
 * The human-operator connector boundary admin surface. Authorization is TWO
 * orthogonal guards (FR-005b + FR-005c):
 *   - `SessionOnlyAdminGuard` — human cookie session ONLY (rejects any bearer,
 *     incl. dashboard_api); the KIND check.
 *   - `RolesGuard` `@Roles("owner","tenant_admin")` — the ROLE check.
 * Plus `TenantContextGuard` to publish `request.context`. NOT `DashboardAuthGuard`
 * (it allows dashboard_api bearers — forbidden here).
 *
 * Tenant + actor are resolved server-side from the session (§XII), never the
 * body. Cross-tenant / disabled / absent addresses are non-disclosing 404s.
 * US2 (rotate/revoke) + US3 (disable) add routes to this controller.
 */
import {
  Body,
  ConflictException,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";

import { Roles } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";
import { SessionOnlyAdminGuard } from "../auth/session-only-admin.guard";
import { Idempotent } from "../idempotency/idempotent.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { TenantContextGuard } from "../context/tenant-context.guard";
import type { TenantContextRequest } from "../context/types";
import {
  type ConnectorInstanceBody,
  IssueCredentialRequestSchema,
  type IssueCredentialRequestDto,
  type IssuedCredentialBody,
  RegisterConnectorInstanceRequestSchema,
  type RegisterConnectorInstanceRequestDto,
} from "./dto/register-connector.dto";
import { ConnectorRegistrationService } from "./connector-registration.service";

@Controller()
@UseGuards(SessionOnlyAdminGuard, TenantContextGuard)
export class ConnectorRegistrationController {
  constructor(private readonly service: ConnectorRegistrationService) {}

  private requireContext(request: TenantContextRequest): {
    tenantId: string;
    userId: string;
  } {
    const ctx = request.context;
    if (!ctx || ctx.tenantId === null || ctx.userId === null) {
      throw new UnauthorizedException("Unauthorized");
    }
    return { tenantId: ctx.tenantId, userId: ctx.userId };
  }

  /** GET — list the tenant's connector instances (status only, never a secret). */
  @Get("api/v1/connector/instances")
  @UseGuards(RolesGuard)
  @Roles("owner", "tenant_admin")
  async list(
    @Req() request: TenantContextRequest,
  ): Promise<{ items: ConnectorInstanceBody[] }> {
    const { tenantId } = this.requireContext(request);
    const items = await this.service.list({ tenantId });
    return { items };
  }

  /** POST — register a connector instance. Duplicate (env, site_ref) → 409. */
  @Post("api/v1/connector/instances")
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(RolesGuard)
  @Roles("owner", "tenant_admin")
  async register(
    @Req() request: TenantContextRequest,
    @Body(new ZodValidationPipe(RegisterConnectorInstanceRequestSchema))
    body: RegisterConnectorInstanceRequestDto,
  ): Promise<ConnectorInstanceBody> {
    const { tenantId, userId } = this.requireContext(request);
    const result = await this.service.register({
      tenantId,
      actorUserId: userId,
      displayName: body.display_name,
      erpnextSiteRef: body.erpnext_site_ref,
      environment: body.environment,
    });
    if (result.kind === "ok") return result.instance;
    throw new ConflictException({
      code: "conflict",
      message:
        "An active connector instance already exists for this environment and ERPNext site.",
    });
  }

  /** POST :id/credentials — issue a credential. Raw secret in the body ONCE. */
  @Post("api/v1/connector/instances/:id/credentials")
  @HttpCode(HttpStatus.CREATED)
  @Header("Cache-Control", "no-store")
  @UseGuards(RolesGuard)
  @Roles("owner", "tenant_admin")
  async issue(
    @Req() request: TenantContextRequest,
    @Param("id", new ZodValidationPipe(z.string().uuid())) id: string,
    @Body(new ZodValidationPipe(IssueCredentialRequestSchema))
    body: IssueCredentialRequestDto,
  ): Promise<IssuedCredentialBody> {
    const { tenantId, userId } = this.requireContext(request);
    const result = await this.service.issue({
      tenantId,
      actorUserId: userId,
      instanceId: id,
      ...(body.expires_in_days !== undefined
        ? { expiresInDays: body.expires_in_days }
        : {}),
    });
    if (result.kind === "ok") return result.credential;
    if (result.kind === "conflict") {
      // RT-62: one active credential per instance; rotation replaces it.
      throw new ConflictException({
        code: "conflict",
        message: "This connector instance already has an active credential. Rotate it instead.",
      });
    }
    // Non-disclosing 404 — absent / cross-tenant / disabled instance (§II/§XII).
    throw new NotFoundException("Not Found");
  }

  /** POST :id/disable — logically disable an instance (US3). Idempotent. */
  @Post("api/v1/connector/instances/:id/disable")
  @HttpCode(HttpStatus.OK)
  @UseGuards(RolesGuard)
  @Roles("owner", "tenant_admin")
  async disable(
    @Req() request: TenantContextRequest,
    @Param("id", new ZodValidationPipe(z.string().uuid())) id: string,
  ): Promise<ConnectorInstanceBody> {
    const { tenantId, userId } = this.requireContext(request);
    const result = await this.service.disable({
      tenantId,
      actorUserId: userId,
      instanceId: id,
    });
    if (result.kind === "ok") return result.instance;
    throw new NotFoundException("Not Found");
  }

  /** POST :id/credentials/rotate — atomic immediate-revoke rotation (US2). */
  @Post("api/v1/connector/instances/:id/credentials/rotate")
  @HttpCode(HttpStatus.CREATED)
  @Header("Cache-Control", "no-store")
  @UseGuards(RolesGuard)
  @Roles("owner", "tenant_admin")
  // RT-82 K3: the body carries the raw secret, so it is never stored or
  // replayed; only `credential_id` is kept. A same-key retry answers 409.
  @Idempotent("required", { replay: "forbid", replayMarkerFields: ["credential_id"] })
  async rotate(
    @Req() request: TenantContextRequest,
    @Param("id", new ZodValidationPipe(z.string().uuid())) id: string,
  ): Promise<IssuedCredentialBody> {
    const { tenantId, userId } = this.requireContext(request);
    const result = await this.service.rotate({
      tenantId,
      actorUserId: userId,
      instanceId: id,
    });
    if (result.kind === "ok") return result.credential;
    throw new NotFoundException("Not Found");
  }

  /** POST /credentials/:credentialId/revoke — revoke one credential (US2). */
  @Post("api/v1/connector/credentials/:credentialId/revoke")
  @HttpCode(HttpStatus.OK)
  @UseGuards(RolesGuard)
  @Roles("owner", "tenant_admin")
  @Idempotent("required")
  async revoke(
    @Req() request: TenantContextRequest,
    @Param("credentialId", new ZodValidationPipe(z.string().uuid()))
    credentialId: string,
  ): Promise<{ ok: true }> {
    const { tenantId, userId } = this.requireContext(request);
    const result = await this.service.revoke({
      tenantId,
      actorUserId: userId,
      credentialId,
    });
    if (result.kind === "ok") return { ok: true };
    throw new NotFoundException("Not Found");
  }
}
