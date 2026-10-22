/**
 * DeviceBuildsController: RT-719 runtime of `consoleGetFleetBaseline`
 * (`packages/contracts/openapi/console-device-builds.openapi.yaml`):
 *
 *   GET /api/v1/device-builds/baseline
 *
 * Auth: the HUMAN `cookieAuth` session only: `SessionOnlyAdminGuard` (any
 * bearer is 401), then `TenantContextGuard`, then `RolesGuard` +
 * `@Roles("owner", "tenant_admin", "store_manager")` (default deny → 404), exactly
 * as the devices surface. The tenant is the session's, never the request's
 * (§XII); the store scope is applied by the service. A read, so no `Origin`
 * check applies.
 *
 * Refusals: a malformed or repeated `store_id`, or an unknown query key, is 400
 * `validation_error` before any read; a role outside the list, a `store_id`
 * outside the scope, of another tenant or absent is the same non-disclosing
 * 404 (the `{ code, message }` of the `RolesGuard` refusal). Every 200 is
 * `Cache-Control: no-store`.
 *
 * Audit: one `devices.fleet_baseline_read` event per authorised 200 (`@Auditable`
 * runs on success only): the scope mode, the `store_id` (null for all in scope)
 * and the entry count, never a commit, version or any other value of the
 * identity.
 */
import {
  Controller,
  Get,
  Header,
  NotFoundException,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";

import { annotateAudit, Auditable } from "../audit/auditable.decorator";
import { Roles } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";
import { SessionOnlyAdminGuard } from "../auth/session-only-admin.guard";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { ConsoleRateLimit } from "../console-rate-limit/console-rate-limit.decorator";
import { TenantContextGuard } from "../context/tenant-context.guard";
import type { TenantContextRequest } from "../context/types";
import { DeviceBuildsService } from "./device-builds.service";
import type { FleetBaseline } from "./device-builds.projections";
import { DeviceStoreNotInScopeError, type ScopedInput } from "./devices.service";

/** `store_id`: a UUID, normalised to lower case (the contract's "case insensitive"); an unknown key is a 400. */
export const FleetBaselineQuerySchema = z
  .object({
    store_id: z
      .string()
      .uuid()
      .transform((id) => id.toLowerCase())
      .optional(),
  })
  .strict();

export type FleetBaselineQuery = z.infer<typeof FleetBaselineQuerySchema>;

/** The one 404 body of this surface: the same `{ code, message }` as the `RolesGuard` refusal. */
const NOT_FOUND = { code: "not_found", message: "Not Found" } as const;

@Controller()
@UseGuards(SessionOnlyAdminGuard, TenantContextGuard)
export class DeviceBuildsController {
  constructor(private readonly service: DeviceBuildsService) {}

  /** GET: the distinct POS builds installed on the active devices in scope. */
  @Get("api/v1/device-builds/baseline")
  @UseGuards(RolesGuard)
  @Roles("owner", "tenant_admin", "store_manager")
  @Auditable("devices.fleet_baseline_read")
  // RT-719: consoleGetFleetBaseline is an aggregate over every active device in scope.
  @ConsoleRateLimit("expensiveRead")
  @Header("Cache-Control", "no-store")
  async baseline(
    @Req() request: TenantContextRequest,
    @Query(new ZodValidationPipe(FleetBaselineQuerySchema)) query: FleetBaselineQuery,
  ): Promise<FleetBaseline> {
    const scoped = requireTenant(request);
    try {
      const baseline = await this.service.baseline({ ...scoped, ...(query.store_id !== undefined ? { storeId: query.store_id } : {}) });
      annotateAudit(request, { scope: baseline.scope, store_id: baseline.storeRef, entries: baseline.installed.length });
      return baseline;
    } catch (err) {
      if (err instanceof DeviceStoreNotInScopeError) throw new NotFoundException(NOT_FOUND);
      throw err;
    }
  }
}

/** The session tenant + the context whose role and store scope bound the call. */
function requireTenant(request: TenantContextRequest): ScopedInput {
  const ctx = request.context;
  if (!ctx || ctx.tenantId === null) throw new UnauthorizedException("Unauthorized");
  return { tenantId: ctx.tenantId, context: ctx };
}
