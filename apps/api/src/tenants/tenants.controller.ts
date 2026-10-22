/**
 * TenantsController — slice 12 (T131).
 *
 * Implements all six tenant endpoints in
 * `specs/001-foundation-auth-tenant-store/contracts/tenants.openapi.yaml`:
 *
 *     GET    /api/v1/tenants              listTenants
 *     POST   /api/v1/tenants              createTenant      [platform-admin]
 *     GET    /api/v1/tenants/:id          readTenant
 *     PATCH  /api/v1/tenants/:id          updateTenant
 *     DELETE /api/v1/tenants/:id          softDeleteTenant  [platform-admin]
 *     GET    /api/v1/tenants/:id/members  listMembers
 *
 * Why this controller is NOT guarded by `TenantContextGuard`
 * ---------------------------------------------------------
 * Tenant ID for `:id`-routes comes from the URL **path**, NOT from
 * `request.context.tenantId`. The TenantContextGuard / ALS pipeline
 * (PRs #19/#20) is for store-scoped and active-tenant-scoped
 * operations; tenant-admin work on a specific tenant ID is
 * fundamentally different — the path IS the context. The service
 * therefore calls `runWithTenantContext` directly with the path
 * tenant id, NOT `runRequestScopedTenantContext`.
 *
 * Authorization
 * -------------
 * Class-level `@UseGuards(AuthGuard)` authenticates every request.
 * Role-based authorization is per-method via `RolesGuard` + the
 * `@Roles` / `@RolesFromParam` / `@PlatformAdminOnly` decorator
 * family from `../auth/roles.decorator`:
 *
 *   POST   /tenants       → @PlatformAdminOnly()                (403 on deny)
 *   PATCH  /tenants/:id   → @RolesFromParam("id", "owner",
 *                                                 "tenant_admin")  (404 on deny — FR-ISO-4)
 *   DELETE /tenants/:id   → @PlatformAdminOnly()                (403 on deny)
 *
 * GET routes intentionally have no role decorator — visibility is a
 * data-policy decision (member vs platform-admin sees different rows)
 * handled inside `TenantsService`, not an allow/deny gate. Mounting
 * `RolesGuard` class-wide would default-deny those routes.
 *
 * Cross-cutting policies (consistent with prior controllers)
 * ---------------------------------------------------------
 *   - Bodies validated by `ZodValidationPipe`. Bad bodies bubble as
 *     `ZodError` and the global filter renders them as 400
 *     `validation_error` envelopes.
 *   - All thrown exceptions (`UnauthorizedException`,
 *     `NotFoundException`, `ForbiddenException`, `ConflictException`)
 *     pass through `GlobalExceptionFilter` to the canonical envelope.
 *   - 403 vs 404 split documented in TenantsService header.
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import type { AuthedRequest } from "../auth/auth.guard";
import { DashboardAuthGuard } from "../auth/dashboard-auth.guard";
import {
  PlatformAdminOnly,
  RolesFromParam,
} from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";
import { PathTenantSupportSessionGuard } from "../platform-support-sessions/path-tenant-support-session.guard";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import {
  TenantCreateSchema,
  TenantUpdateSchema,
  type TenantCreateInput,
  type TenantUpdateInput,
} from "./dto";
import { TenantsService } from "./tenants.service";
import type { TenantRecord } from "./tenants.repository";
import type { MembershipDetail } from "../context/membership.repository";
import { ConsoleRateLimit } from "../console-rate-limit/console-rate-limit.decorator";

/**
 * Wire-shape for a single membership. Matches `MembershipDetail` from
 * the OpenAPI contract (snake_case over the wire).
 */
interface MembershipDetailBody {
  membership_id: string;
  user: {
    id: string;
    email: string;
    display_name: string | null;
  };
  role_code: string;
  store_access_kind: string;
  accessible_store_ids: string[];
  revoked_at: string | null;
}

/**
 * Wire-shape (snake_case) for the tenant summary response. Matches
 * `TenantSummary` from the OpenAPI contract.
 */
interface TenantSummaryBody {
  id: string;
  slug: string;
  name: string;
}

/**
 * Wire-shape for the full tenant response. Matches `Tenant` from the
 * OpenAPI contract.
 */
interface TenantBody extends TenantSummaryBody {
  status: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

function toMembershipDetailBody(d: MembershipDetail): MembershipDetailBody {
  return {
    membership_id: d.membershipId,
    user: {
      id: d.user.id,
      email: d.user.email,
      display_name: d.user.displayName,
    },
    role_code: d.roleCode,
    store_access_kind: d.storeAccessKind,
    accessible_store_ids: [...d.accessibleStoreIds],
    revoked_at: d.revokedAt ? d.revokedAt.toISOString() : null,
  };
}

function toSummaryBody(record: TenantRecord): TenantSummaryBody {
  return { id: record.id, slug: record.slug, name: record.name };
}

function toFullBody(record: TenantRecord): TenantBody {
  return {
    id: record.id,
    slug: record.slug,
    name: record.name,
    status: record.status,
    created_at: record.createdAt.toISOString(),
    updated_at: record.updatedAt.toISOString(),
    deleted_at: record.deletedAt ? record.deletedAt.toISOString() : null,
  };
}

@Controller("api/v1/tenants")
@UseGuards(DashboardAuthGuard)
export class TenantsController {
  constructor(private readonly tenantsService: TenantsService) {}

  @Get()
  async list(@Req() request: AuthedRequest): Promise<TenantSummaryBody[]> {
    const principal = request.principal;
    if (!principal) throw new UnauthorizedException("Unauthorized");
    const records = await this.tenantsService.list(principal);
    return records.map(toSummaryBody);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(RolesGuard)
  @PlatformAdminOnly()
  // RT-619 (RT-574 D3): createTenant.
  @ConsoleRateLimit("onboarding")
  async create(
    @Req() request: AuthedRequest,
    @Body(new ZodValidationPipe(TenantCreateSchema)) body: TenantCreateInput,
  ): Promise<TenantBody> {
    const principal = request.principal;
    if (!principal) throw new UnauthorizedException("Unauthorized");
    const record = await this.tenantsService.create(principal, body);
    return toFullBody(record);
  }

  @Get(":id/members")
  // RT-414: a non-member platform admin needs a support session for {id}.
  @UseGuards(PathTenantSupportSessionGuard, RolesGuard)
  @RolesFromParam("id", "owner", "tenant_admin")
  async listMembers(
    @Req() request: AuthedRequest,
    @Param("id", new ParseUUIDPipe()) tenantId: string,
  ): Promise<MembershipDetailBody[]> {
    const principal = request.principal;
    if (!principal) throw new UnauthorizedException("Unauthorized");
    const details = await this.tenantsService.listMembers(principal, tenantId);
    return details.map(toMembershipDetailBody);
  }

  @Get(":id")
  async read(
    @Req() request: AuthedRequest,
    @Param("id", new ParseUUIDPipe()) tenantId: string,
  ): Promise<TenantBody> {
    const principal = request.principal;
    if (!principal) throw new UnauthorizedException("Unauthorized");
    const record = await this.tenantsService.read(principal, tenantId);
    return toFullBody(record);
  }

  @Patch(":id")
  // RT-414: a non-member platform admin needs a support session for {id}.
  @UseGuards(PathTenantSupportSessionGuard, RolesGuard)
  @RolesFromParam("id", "owner", "tenant_admin")
  async update(
    @Req() request: AuthedRequest,
    @Param("id", new ParseUUIDPipe()) tenantId: string,
    @Body(new ZodValidationPipe(TenantUpdateSchema)) body: TenantUpdateInput,
  ): Promise<TenantBody> {
    const principal = request.principal;
    if (!principal) throw new UnauthorizedException("Unauthorized");
    const record = await this.tenantsService.update(principal, tenantId, body);
    return toFullBody(record);
  }

  @Delete(":id")
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(RolesGuard)
  @PlatformAdminOnly()
  async softDelete(
    @Req() request: AuthedRequest,
    @Param("id", new ParseUUIDPipe()) tenantId: string,
  ): Promise<void> {
    const principal = request.principal;
    if (!principal) throw new UnauthorizedException("Unauthorized");
    await this.tenantsService.softDelete(principal, tenantId);
  }
}
