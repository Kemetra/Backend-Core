/**
 * DeviceHealthController: RT-327 runtime of the Console reads
 * `consoleListDeviceHealth` and `consoleGetDeviceHealth`
 * (`packages/contracts/openapi/pos-device-health.openapi.yaml`):
 *
 *   GET /api/v1/device-health
 *   GET /api/v1/device-health/{deviceId}
 *
 * Auth: the HUMAN `cookieAuth` session only: `SessionOnlyAdminGuard` (any
 * bearer is 401), then `TenantContextGuard` (publishes `request.context`),
 * then `RolesGuard` + `@Roles("owner", "tenant_admin", "store_manager")`
 * (default deny → 404), exactly as the devices surface. The tenant is the
 * session's, never the request's (§XII); the store scope is applied by the
 * service.
 *
 * Refusals: a malformed path, query or cursor is 400 `validation_error`,
 * raised before any read; every scope refusal (role, other tenant, store
 * outside the scope, absent device) is the same non-disclosing 404, with the
 * `{ code, message }` body of the `RolesGuard` refusal. No `@Auditable`: a
 * read is not audited (the contract).
 */
import {
  BadRequestException,
  Controller,
  Get,
  Header,
  NotFoundException,
  Param,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";

import { Roles } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";
import { SessionOnlyAdminGuard } from "../auth/session-only-admin.guard";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { ConsoleRateLimit } from "../console-rate-limit/console-rate-limit.decorator";
import { TenantContextGuard } from "../context/tenant-context.guard";
import type { TenantContextRequest } from "../context/types";
import { InvalidDeviceHealthCursorError, type DeviceHealthPage, type DeviceHealthViewBody } from "./device-health.projections";
import {
  DeviceHealthListQuerySchema,
  DeviceIdParamSchema,
  PAGE_SIZE_DEFAULT,
  type DeviceHealthListQuery,
} from "./device-health.query";
import {
  DeviceHealthNotFoundError,
  DeviceHealthService,
  DeviceHealthStoreNotInScopeError,
  type ScopedInput,
} from "./device-health.service";

/** The one 404 body of this surface: the same as the `RolesGuard` refusal. */
const NOT_FOUND = { code: "not_found", message: "Not Found" } as const;

@Controller()
@UseGuards(SessionOnlyAdminGuard, TenantContextGuard)
export class DeviceHealthController {
  constructor(private readonly service: DeviceHealthService) {}

  /** GET: the health of the devices in scope, by device id, keyset paginated. */
  @Get("api/v1/device-health")
  @UseGuards(RolesGuard)
  @Roles("owner", "tenant_admin", "store_manager")
  // RT-327: consoleListDeviceHealth, like consoleListDevices.
  @ConsoleRateLimit("cheapRead")
  @Header("Cache-Control", "no-store")
  async list(
    @Req() request: TenantContextRequest,
    @Query(new ZodValidationPipe(DeviceHealthListQuerySchema)) query: DeviceHealthListQuery,
  ): Promise<DeviceHealthPage> {
    try {
      return await this.service.list({
        ...requireTenant(request),
        ...(query.store_id !== undefined ? { storeId: query.store_id } : {}),
        ...(query.trust_state !== undefined ? { trustState: query.trust_state } : {}),
        ...(query.app_version !== undefined ? { appVersion: query.app_version } : {}),
        ...(query.update_channel !== undefined ? { updateChannel: query.update_channel } : {}),
        ...(query.compliance !== undefined ? { compliance: query.compliance } : {}),
        ...(query.liveness !== undefined ? { liveness: query.liveness } : {}),
        cursor: query.cursor ?? null,
        limit: query.page_size ?? PAGE_SIZE_DEFAULT,
      });
    } catch (err) {
      if (err instanceof InvalidDeviceHealthCursorError) {
        throw new BadRequestException({ code: "validation_error", message: "cursor is not valid." });
      }
      if (err instanceof DeviceHealthStoreNotInScopeError) throw new NotFoundException(NOT_FOUND);
      throw err;
    }
  }

  /** GET: one device's health, whatever its trust state. */
  @Get("api/v1/device-health/:deviceId")
  @UseGuards(RolesGuard)
  @Roles("owner", "tenant_admin", "store_manager")
  // RT-327: consoleGetDeviceHealth, like consoleGetDevice.
  @ConsoleRateLimit("cheapRead")
  @Header("Cache-Control", "no-store")
  async get(@Req() request: TenantContextRequest, @Param("deviceId") deviceId: string): Promise<DeviceHealthViewBody> {
    const scoped = requireTenant(request);
    const id = parseDeviceId(deviceId);
    try {
      return await this.service.get(scoped, id);
    } catch (err) {
      if (err instanceof DeviceHealthNotFoundError) throw new NotFoundException(NOT_FOUND);
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
