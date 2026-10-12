/**
 * ShiftClosesController — RT-383 (AD-CASH-001 follow-up 4): the admin read of
 * recorded RT-17 shift closes (`shift-closes.openapi.yaml`) for Admin-Console
 * RT-18.
 *
 *   GET /api/v1/shift-closes            consoleListShiftCloses
 *   GET /api/v1/shift-closes/{shiftId}  consoleGetShiftClose
 *
 * Auth: the HUMAN `cookieAuth` session only → `SessionOnlyAdminGuard` (any
 * bearer, `dashboard_api` included, is 401: the contract accepts the session
 * cookie alone), then `TenantContextGuard` (publishes `request.context`), then
 * `RolesGuard` + `@Roles("owner", "tenant_admin", "store_manager")` (default
 * deny → 404). The tenant is the session's, never
 * the request's (§XII); the store scope is the operator-surface rule, applied
 * by the service.
 *
 * Refusals: a malformed path, query or cursor is 400 `validation_error`; every
 * scope refusal (role, other tenant, store outside the scope, open / legacy /
 * absent shift) is the same non-disclosing 404. No write, no POS-facing change.
 */
import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";

import { Auditable } from "../audit/auditable.decorator";
import { Roles } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";
import { SessionOnlyAdminGuard } from "../auth/session-only-admin.guard";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { TenantContextGuard } from "../context/tenant-context.guard";
import type { TenantContextRequest } from "../context/types";
import {
  InvalidShiftCloseCursorError,
  type ShiftCloseDetail,
  type ShiftClosePage,
} from "./shift-closes.projections";
import {
  PAGE_SIZE_DEFAULT,
  ShiftCloseListQuerySchema,
  ShiftIdParamSchema,
  type ShiftCloseListQuery,
} from "./shift-closes.query";
import {
  ShiftCloseNotFoundError,
  ShiftClosesReadService,
  StoreNotInScopeError,
  type ScopedReadInput,
} from "./shift-closes.service";

/**
 * The one 404 body of this surface: the same `{ code, message }` as the
 * `RolesGuard` role refusal, so a role, tenant, store or shift refusal cannot be
 * told apart by its body (FR-ISO-4).
 */
const NOT_FOUND = { code: "not_found", message: "Not Found" } as const;

@Controller()
@UseGuards(SessionOnlyAdminGuard, TenantContextGuard)
export class ShiftClosesController {
  constructor(private readonly service: ShiftClosesReadService) {}

  /** GET — recorded closes, newest first, keyset paginated. */
  @Get("api/v1/shift-closes")
  @UseGuards(RolesGuard)
  @Roles("owner", "tenant_admin", "store_manager")
  @Auditable("shift_closes.listed")
  async list(
    @Req() request: TenantContextRequest,
    @Query(new ZodValidationPipe(ShiftCloseListQuerySchema)) query: ShiftCloseListQuery,
  ): Promise<ShiftClosePage> {
    const scoped = requireTenant(request);
    try {
      return await this.service.list({
        ...scoped,
        cursor: query.cursor ?? null,
        limit: query.page_size ?? PAGE_SIZE_DEFAULT,
        filters: {
          ...(query.store_id !== undefined ? { storeId: query.store_id } : {}),
          ...(query.closed_from !== undefined ? { closedFrom: query.closed_from } : {}),
          ...(query.closed_to !== undefined ? { closedTo: query.closed_to } : {}),
          ...(query.close_kind !== undefined ? { closeKind: query.close_kind } : {}),
          ...(query.min_abs_variance !== undefined ? { minAbsVariance: query.min_abs_variance } : {}),
          ...(query.currency_code !== undefined ? { currencyCode: query.currency_code } : {}),
          ...(query.approval !== undefined ? { approval: query.approval } : {}),
        },
      });
    } catch (err) {
      if (err instanceof InvalidShiftCloseCursorError) {
        throw new BadRequestException({ code: "validation_error", message: "cursor is not valid." });
      }
      if (err instanceof StoreNotInScopeError) throw new NotFoundException(NOT_FOUND);
      throw err;
    }
  }

  /** GET — one recorded close with its opening, movements and claimed returns. */
  @Get("api/v1/shift-closes/:shiftId")
  @UseGuards(RolesGuard)
  @Roles("owner", "tenant_admin", "store_manager")
  @Auditable("shift_closes.read")
  async get(@Req() request: TenantContextRequest, @Param("shiftId") shiftId: string): Promise<ShiftCloseDetail> {
    const scoped = requireTenant(request);
    const parsed = ShiftIdParamSchema.safeParse(shiftId);
    if (!parsed.success) {
      // A request-shape error, checked before any read: it discloses nothing.
      throw new BadRequestException({ code: "validation_error", message: "shiftId must be a valid UUID." });
    }
    try {
      return await this.service.get(scoped, parsed.data);
    } catch (err) {
      if (err instanceof ShiftCloseNotFoundError) throw new NotFoundException(NOT_FOUND);
      throw err;
    }
  }
}

/** The session tenant + the context whose store scope bounds the read. */
function requireTenant(request: TenantContextRequest): ScopedReadInput {
  const ctx = request.context;
  if (!ctx || ctx.tenantId === null) throw new UnauthorizedException("Unauthorized");
  return { tenantId: ctx.tenantId, context: ctx };
}
