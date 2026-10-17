/**
 * DevicesController — RT-365 (RT-287 F2): the Console device registry
 * (`devices.openapi.yaml`) for Admin-Console RT-371 / RT-372.
 *
 *   GET  /api/v1/devices                    consoleListDevices
 *   GET  /api/v1/devices/{deviceId}         consoleGetDevice
 *   POST /api/v1/devices/{deviceId}/revoke  consoleRevokeDevice
 *   GET  /api/v1/devices/{deviceId}/impact  consoleGetDeviceImpact (RT-366)
 *
 * Auth: the HUMAN `cookieAuth` session only → `SessionOnlyAdminGuard` (any
 * bearer is 401; a cookie POST without a trusted `Origin` is 403
 * `origin_rejected`, RT-430), then `TenantContextGuard` (publishes
 * `request.context`), then `RolesGuard` + `@Roles("owner", "tenant_admin",
 * "store_manager")` (default deny → 404). The tenant is the session's, never
 * the request's (§XII); the store scope is the operator-surface rule, applied
 * by the service.
 *
 * Refusals: a malformed path, query, body or cursor is 400
 * `validation_error`; every scope refusal (role, other tenant, store outside
 * the scope, absent device) is the same non-disclosing 404; the Cash Session
 * rule refuses with 403 / 409 / 422 and its stable code, and a 409 carries the
 * refused revoke's impact preview as `error.details` (RT-366).
 */
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";

import { annotateAudit, Auditable } from "../audit/auditable.decorator";
import { Roles } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";
import { SessionOnlyAdminGuard } from "../auth/session-only-admin.guard";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { TenantContextGuard } from "../context/tenant-context.guard";
import type { TenantContextRequest } from "../context/types";
import {
  InvalidDeviceCursorError,
  type DeviceDetail,
  type DevicePage,
  type DeviceRevokeResult,
} from "./devices.projections";
import type { DeviceImpactPreview } from "./device-impact.projections";
import {
  DeviceIdParamSchema,
  DeviceImpactQuerySchema,
  DeviceListQuerySchema,
  DeviceRevokeBodySchema,
  PAGE_SIZE_DEFAULT,
  type DeviceImpactQuery,
  type DeviceListQuery,
  type DeviceRevokeBody,
} from "./devices.query";
import {
  DeviceNotFoundError,
  DeviceRevokeRefusedError,
  DevicesService,
  DeviceStoreNotInScopeError,
  type ScopedInput,
} from "./devices.service";

/**
 * The one 404 body of this surface: the same `{ code, message }` as the
 * `RolesGuard` role refusal, so a role, tenant, store or device refusal cannot
 * be told apart by its body (FR-ISO-4).
 */
const NOT_FOUND = { code: "not_found", message: "Not Found" } as const;

const REFUSAL_MESSAGES: Readonly<Record<DeviceRevokeRefusedError["code"], string>> = {
  recovery_revoke_forbidden: "A recovery revoke needs an owner or tenant admin.",
  recovery_note_required: "A recovery revoke needs a note.",
  custody_exception_not_acknowledged: "A recovery revoke needs the custody exception acknowledged.",
  unresolved_cash_session: "The device has an open shift. Close it and let it sync first.",
  unresolved_custody_exception: "The device's custody exception is unresolved.",
  device_retired: "The device is retired.",
};

@Controller()
@UseGuards(SessionOnlyAdminGuard, TenantContextGuard)
export class DevicesController {
  constructor(private readonly service: DevicesService) {}

  /** GET — devices in scope, exception-first, keyset paginated. */
  @Get("api/v1/devices")
  @UseGuards(RolesGuard)
  @Roles("owner", "tenant_admin", "store_manager")
  @Auditable("devices.listed")
  async list(
    @Req() request: TenantContextRequest,
    @Query(new ZodValidationPipe(DeviceListQuerySchema)) query: DeviceListQuery,
  ): Promise<DevicePage> {
    try {
      return await this.service.list({
        ...requireTenant(request),
        ...(query.store_id !== undefined ? { storeId: query.store_id } : {}),
        ...(query.trust_state !== undefined ? { trustState: query.trust_state } : {}),
        cursor: query.cursor ?? null,
        limit: query.page_size ?? PAGE_SIZE_DEFAULT,
      });
    } catch (err) {
      if (err instanceof InvalidDeviceCursorError) {
        throw new BadRequestException({ code: "validation_error", message: "cursor is not valid." });
      }
      if (err instanceof DeviceStoreNotInScopeError) throw new NotFoundException(NOT_FOUND);
      throw err;
    }
  }

  /** GET — one device with its revoke note and retire attribution. */
  @Get("api/v1/devices/:deviceId")
  @UseGuards(RolesGuard)
  @Roles("owner", "tenant_admin", "store_manager")
  @Auditable("devices.read")
  async get(@Req() request: TenantContextRequest, @Param("deviceId") deviceId: string): Promise<DeviceDetail> {
    const scoped = requireTenant(request);
    const id = parseDeviceId(deviceId);
    annotateAudit(request, { device_id: id });
    try {
      return await this.service.get(scoped, id);
    } catch (err) {
      if (err instanceof DeviceNotFoundError) throw new NotFoundException(NOT_FOUND);
      throw err;
    }
  }

  /** POST — revoke with a structured reason, cascade and the Cash Session rule. */
  @Post("api/v1/devices/:deviceId/revoke")
  @HttpCode(200)
  @UseGuards(RolesGuard)
  @Roles("owner", "tenant_admin", "store_manager")
  async revoke(
    @Req() request: TenantContextRequest,
    @Param("deviceId") deviceId: string,
    @Body(new ZodValidationPipe(DeviceRevokeBodySchema)) body: DeviceRevokeBody,
  ): Promise<DeviceRevokeResult> {
    const scoped = requireTenant(request);
    const actorUserId = scoped.context.userId;
    if (actorUserId === null) throw new UnauthorizedException("Unauthorized");
    const id = parseDeviceId(deviceId);
    try {
      return await this.service.revoke({
        ...scoped,
        actorUserId,
        deviceId: id,
        reason: body.reason,
        ...(body.note !== undefined ? { note: body.note } : {}),
        ...(body.acknowledgeCustodyException !== undefined
          ? { acknowledgeCustodyException: body.acknowledgeCustodyException }
          : {}),
      });
    } catch (err) {
      if (err instanceof DeviceNotFoundError) throw new NotFoundException(NOT_FOUND);
      if (err instanceof DeviceRevokeRefusedError) {
        const body = { code: err.code, message: REFUSAL_MESSAGES[err.code] };
        throw new HttpException(err.impact !== undefined ? { ...body, details: err.impact } : body, err.status);
      }
      throw err;
    }
  }

  /** GET — the read-only impact preview of one lifecycle action (RT-366). */
  @Get("api/v1/devices/:deviceId/impact")
  @UseGuards(RolesGuard)
  @Roles("owner", "tenant_admin", "store_manager")
  @Auditable("devices.impact_read")
  async impact(
    @Req() request: TenantContextRequest,
    @Param("deviceId") deviceId: string,
    @Query(new ZodValidationPipe(DeviceImpactQuerySchema)) query: DeviceImpactQuery,
  ): Promise<DeviceImpactPreview> {
    const scoped = requireTenant(request);
    const id = parseDeviceId(deviceId);
    annotateAudit(request, { device_id: id, action: query.action });
    try {
      return await this.service.impact({
        ...scoped,
        deviceId: id,
        action: query.action,
        ...(query.reason !== undefined ? { reason: query.reason } : {}),
      });
    } catch (err) {
      if (err instanceof DeviceNotFoundError) throw new NotFoundException(NOT_FOUND);
      throw err;
    }
  }
}

/** A request-shape error, checked before any read: it discloses nothing. */
function parseDeviceId(deviceId: string): string {
  const parsed = DeviceIdParamSchema.safeParse(deviceId);
  if (!parsed.success) {
    throw new BadRequestException({ code: "validation_error", message: "deviceId must be a valid UUID." });
  }
  return parsed.data;
}

/** The session tenant + the context whose role and store scope bound the call. */
function requireTenant(request: TenantContextRequest): ScopedInput {
  const ctx = request.context;
  if (!ctx || ctx.tenantId === null) throw new UnauthorizedException("Unauthorized");
  return { tenantId: ctx.tenantId, context: ctx };
}
