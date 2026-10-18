/**
 * StoresController — slice US2 (T134).
 *
 * Implements the five endpoints in
 * `specs/001-foundation-auth-tenant-store/contracts/stores.openapi.yaml`:
 *
 *     GET    /api/v1/stores              listStores
 *     POST   /api/v1/stores              createStore       [owner|tenant_admin]
 *     GET    /api/v1/stores/{store_id}   readStore         (per access policy)
 *     PATCH  /api/v1/stores/{store_id}   updateStore       [owner|tenant_admin]
 *     DELETE /api/v1/stores/{store_id}   softDeleteStore   [owner|tenant_admin]
 *     GET    /api/v1/stores/{store_id}/timezone-change-preview
 *                                         previewStoreTimezoneChange [owner|tenant_admin]
 *
 * The time zone fields and the preview route are spec 038 / RT-401 and
 * live in `packages/contracts/openapi/stores.openapi.yaml`.
 *
 * Why this controller IS guarded by `TenantContextGuard`
 * ------------------------------------------------------
 * Every store route is scoped to an **active tenant** (the contract's
 * "Active tenant must be set on the session/token; otherwise 401").
 * The TenantContextGuard:
 *
 *   1. Resolves the active tenant from the principal's session or
 *      token binding.
 *   2. Validates the caller still has an active membership in that
 *      tenant (or is a platform admin).
 *   3. Publishes the resolved context as `request.context`.
 *
 * Compare with `TenantsController`, which is path-as-context (`/:id`
 * IS the tenant) and intentionally does NOT mount this guard.
 *
 * Authorization
 * -------------
 * Class-level guards authenticate every request. Per-method
 * `RolesGuard` + `@Roles` decorators gate write operations:
 *
 *   - POST  → @Roles("owner","tenant_admin", { denyAs: 403 })
 *             insufficient role within an already-resolved active
 *             tenant is NOT a secret — 403 is the right shape.
 *
 *   - PATCH → @Roles("owner","tenant_admin")  // default denyAs: 404
 *   - DELETE → @Roles("owner","tenant_admin")  // default denyAs: 404
 *             For these, FR-ISO-4 says a wrong-role caller must NOT be
 *             able to distinguish "you exist but lack permission" from
 *             "the store doesn't exist" — both rejected paths look
 *             like 404 from outside.
 *
 * GET routes carry no role decorator. Visibility is data-shaped:
 * `list` shows every store in the active tenant; `read` further
 * applies the `kind='specific'` store-access policy via
 * `MembershipRepository.canAccessStore` inside `StoresService`.
 *
 * Cross-cutting policies (consistent with prior controllers)
 * ---------------------------------------------------------
 *   - Bodies validated by `ZodValidationPipe`. `.strict()` rejects
 *     unknown keys (FR-STORE-4: `tenant_id` on PATCH → 400).
 *   - Exceptions pass through `GlobalExceptionFilter` to the canonical
 *     envelope.
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
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";

import { DashboardAuthGuard } from "../auth/dashboard-auth.guard";
import { Roles } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { TenantContextGuard } from "../context/tenant-context.guard";
import type { TenantContextRequest } from "../context/types";
import {
  StoreCreateSchema,
  StoreUpdateSchema,
  TimezonePreviewQuerySchema,
  type StoreCreateInput,
  type StoreUpdateInput,
  type TimezonePreviewQuery,
} from "./dto";
import type { StoreRecord } from "./stores.repository";
import {
  StoresService,
  type TimezoneChange,
  type TimezoneChangePreview,
} from "./stores.service";
import { ConsoleRateLimit } from "../console-rate-limit/console-rate-limit.decorator";

/** Snake-case wire-shape matching the OpenAPI `Store` schema. */
interface StoreBody {
  id: string;
  tenant_id: string;
  code: string;
  name: string;
  timezone: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

function toBody(record: StoreRecord): StoreBody {
  return {
    id: record.id,
    tenant_id: record.tenantId,
    code: record.code,
    name: record.name,
    timezone: record.timezone,
    is_active: record.isActive,
    created_at: record.createdAt.toISOString(),
    updated_at: record.updatedAt.toISOString(),
    deleted_at: record.deletedAt ? record.deletedAt.toISOString() : null,
  };
}

/** Snake-case wire-shape matching the OpenAPI `StoreTimezoneChangePreview`. */
interface TimezonePreviewBody {
  store_id: string;
  current_timezone: string;
  proposed_timezone: string;
  no_op: boolean;
  now: string;
  utc_offset_minutes_current: number;
  utc_offset_minutes_proposed: number;
  business_date_current: string;
  business_date_proposed: string;
  business_date_changes_now: boolean;
  open_shift_count: number;
  blockers: Array<{ code: string; count: number }>;
  can_apply: boolean;
  caveats: string[];
}

function toPreviewBody(preview: TimezoneChangePreview): TimezonePreviewBody {
  return {
    store_id: preview.storeId,
    current_timezone: preview.currentTimezone,
    proposed_timezone: preview.proposedTimezone,
    no_op: preview.noOp,
    now: preview.now.toISOString(),
    utc_offset_minutes_current: preview.utcOffsetMinutesCurrent,
    utc_offset_minutes_proposed: preview.utcOffsetMinutesProposed,
    business_date_current: preview.businessDateCurrent,
    business_date_proposed: preview.businessDateProposed,
    business_date_changes_now: preview.businessDateChangesNow,
    open_shift_count: preview.openShiftCount,
    blockers: preview.blockers.map((b) => ({ code: b.code, count: b.count })),
    can_apply: preview.canApply,
    caveats: [...preview.caveats],
  };
}

/** The zone change a validated PATCH body carries, if any. */
function timezoneChangeOf(body: StoreUpdateInput): TimezoneChange | undefined {
  if (body.timezone === undefined || body.expected_current_timezone === undefined) {
    return undefined;
  }
  return {
    timezone: body.timezone,
    expectedCurrentTimezone: body.expected_current_timezone,
  };
}

@Controller("api/v1/stores")
@UseGuards(DashboardAuthGuard, TenantContextGuard)
export class StoresController {
  constructor(private readonly storesService: StoresService) {}

  @Get()
  async list(@Req() request: TenantContextRequest): Promise<StoreBody[]> {
    const ctx = request.context;
    if (!ctx) throw new UnauthorizedException("Unauthorized");
    const records = await this.storesService.list(ctx);
    return records.map(toBody);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(RolesGuard)
  @Roles("owner", "tenant_admin", { denyAs: 403 })
  async create(
    @Req() request: TenantContextRequest,
    @Body(new ZodValidationPipe(StoreCreateSchema)) body: StoreCreateInput,
  ): Promise<StoreBody> {
    const ctx = request.context;
    if (!ctx) throw new UnauthorizedException("Unauthorized");
    const record = await this.storesService.create(ctx, body);
    return toBody(record);
  }

  @Get(":store_id")
  async read(
    @Req() request: TenantContextRequest,
    @Param("store_id", new ParseUUIDPipe()) storeId: string,
  ): Promise<StoreBody> {
    const ctx = request.context;
    if (!ctx) throw new UnauthorizedException("Unauthorized");
    const record = await this.storesService.read(ctx, storeId);
    return toBody(record);
  }

  @Patch(":store_id")
  @UseGuards(RolesGuard)
  @Roles("owner", "tenant_admin")
  async update(
    @Req() request: TenantContextRequest,
    @Param("store_id", new ParseUUIDPipe()) storeId: string,
    @Body(new ZodValidationPipe(StoreUpdateSchema)) body: StoreUpdateInput,
  ): Promise<StoreBody> {
    const ctx = request.context;
    if (!ctx) throw new UnauthorizedException("Unauthorized");
    const record = await this.storesService.update(
      ctx,
      storeId,
      { name: body.name, is_active: body.is_active },
      timezoneChangeOf(body),
      { requestId: request.requestId ?? null },
    );
    return toBody(record);
  }

  @Get(":store_id/timezone-change-preview")
  @UseGuards(RolesGuard)
  @Roles("owner", "tenant_admin")
  // RT-619 (RT-574 D3): previewStoreTimezoneChange.
  @ConsoleRateLimit("jobOrPreview")
  async previewTimezoneChange(
    @Req() request: TenantContextRequest,
    @Param("store_id", new ParseUUIDPipe()) storeId: string,
    @Query(new ZodValidationPipe(TimezonePreviewQuerySchema))
    query: TimezonePreviewQuery,
  ): Promise<TimezonePreviewBody> {
    const ctx = request.context;
    if (!ctx) throw new UnauthorizedException("Unauthorized");
    const preview = await this.storesService.previewTimezoneChange(
      ctx,
      storeId,
      query.timezone,
    );
    return toPreviewBody(preview);
  }

  @Delete(":store_id")
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(RolesGuard)
  @Roles("owner", "tenant_admin")
  async softDelete(
    @Req() request: TenantContextRequest,
    @Param("store_id", new ParseUUIDPipe()) storeId: string,
  ): Promise<void> {
    const ctx = request.context;
    if (!ctx) throw new UnauthorizedException("Unauthorized");
    await this.storesService.softDelete(ctx, storeId);
  }
}
