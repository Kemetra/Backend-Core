/**
 * PairingCodesController — RT-367 (RT-287 F4): the Console pairing codes
 * (`devices.openapi.yaml`) for Admin-Console RT-372.
 *
 *   POST /api/v1/pairing-codes                         consoleIssuePairingCode
 *   GET  /api/v1/pairing-codes                         consoleListPairingCodes
 *   POST /api/v1/pairing-codes/{pairingCodeId}/cancel  consoleCancelPairingCode
 *
 * Auth: the guard chain of the device registry (`DevicesController`): the
 * HUMAN `cookieAuth` session only (`SessionOnlyAdminGuard`: any bearer is
 * 401; a cookie POST without a trusted `Origin` is 403 `origin_rejected`),
 * `TenantContextGuard`, then `RolesGuard` + owner / tenant_admin /
 * store_manager (default deny → 404). The store scope is the service's.
 *
 * The issue is `@Idempotent("required", { replay: "forbid" })` (RT-82 K3): the
 * response carries the one-time code, so it is never stored or replayed; a
 * same-key retry is 409 `idempotency_key_conflict`. Only `pairingCodeId`
 * stays in the stored marker. The issue and the cancel write their own audit
 * rows in their transactions; the list is `@Auditable("pairing_codes.listed")`.
 */
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
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

import { Auditable } from "../audit/auditable.decorator";
import { Roles } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";
import { SessionOnlyAdminGuard } from "../auth/session-only-admin.guard";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { TenantContextGuard } from "../context/tenant-context.guard";
import type { TenantContextRequest } from "../context/types";
import { Idempotent } from "../idempotency/idempotent.decorator";
import type { ScopedInput } from "./device-caller";
import {
  InvalidPairingCodeCursorError,
  type PairingCodeCancelResult,
  type PairingCodeIssued,
  type PairingCodePage,
} from "./pairing-codes.projections";
import {
  PairingCodeIdParamSchema,
  PairingCodeIssueBodySchema,
  PairingCodeListQuerySchema,
  type PairingCodeIssueBody,
  type PairingCodeListQuery,
} from "./pairing-codes.query";
import {
  PairingCodeIssueRefusedError,
  PairingCodeNotFoundError,
  PairingCodeReplacementExistsError,
  PairingCodesService,
  PairingCodeUsedError,
} from "./pairing-codes.service";

/** The one 404 body of the registry (the `RolesGuard` role refusal's), FR-ISO-4. */
const NOT_FOUND = { code: "not_found", message: "Not Found" } as const;

const PAGE_SIZE_DEFAULT = 50;

const BLOCK_MESSAGES: Readonly<Record<PairingCodeIssueRefusedError["code"], string>> = {
  unresolved_cash_session: "The device has an open shift. Close it and let it sync first.",
  unresolved_custody_exception: "The device's custody exception is unresolved.",
  device_retired: "A retired device cannot be replaced or moved.",
};

const REPLACEMENT_EXISTS_MESSAGES: Readonly<Record<PairingCodeReplacementExistsError["code"], string>> = {
  replacement_already_pending: "A live pairing code already replaces this device. Cancel it first.",
  device_already_replaced: "This device was already replaced.",
};

@Controller()
@UseGuards(SessionOnlyAdminGuard, TenantContextGuard)
export class PairingCodesController {
  constructor(private readonly service: PairingCodesService) {}

  /** POST — issue a code (returned once), optionally replacing or moving a device. */
  @Post("api/v1/pairing-codes")
  @HttpCode(201)
  // The body carries the one-time code: never cached (security review MEDIUM-1).
  @Header("Cache-Control", "no-store")
  @UseGuards(RolesGuard)
  @Roles("owner", "tenant_admin", "store_manager")
  @Idempotent("required", { replay: "forbid", replayMarkerFields: ["pairingCodeId"] })
  async issue(
    @Req() request: TenantContextRequest,
    @Body(new ZodValidationPipe(PairingCodeIssueBodySchema)) body: PairingCodeIssueBody,
  ): Promise<PairingCodeIssued> {
    const scoped = requireTenant(request);
    const actorUserId = requireUser(scoped);
    try {
      return await this.service.issue({ ...scoped, actorUserId, body });
    } catch (err) {
      if (err instanceof PairingCodeNotFoundError) throw new NotFoundException(NOT_FOUND);
      if (err instanceof PairingCodeIssueRefusedError) {
        throw new HttpException({ code: err.code, message: BLOCK_MESSAGES[err.code], details: err.impact }, 409);
      }
      if (err instanceof PairingCodeReplacementExistsError) {
        throw new HttpException({ code: err.code, message: REPLACEMENT_EXISTS_MESSAGES[err.code] }, 409);
      }
      throw err;
    }
  }

  /** GET — the live pending codes in scope, newest first. */
  @Get("api/v1/pairing-codes")
  @UseGuards(RolesGuard)
  @Roles("owner", "tenant_admin", "store_manager")
  @Auditable("pairing_codes.listed")
  async list(
    @Req() request: TenantContextRequest,
    @Query(new ZodValidationPipe(PairingCodeListQuerySchema)) query: PairingCodeListQuery,
  ): Promise<PairingCodePage> {
    try {
      return await this.service.list({
        ...requireTenant(request),
        ...(query.store_id !== undefined ? { storeId: query.store_id } : {}),
        cursor: query.cursor ?? null,
        limit: query.page_size ?? PAGE_SIZE_DEFAULT,
      });
    } catch (err) {
      if (err instanceof InvalidPairingCodeCursorError) {
        throw new BadRequestException({ code: "validation_error", message: "cursor is not valid." });
      }
      if (err instanceof PairingCodeNotFoundError) throw new NotFoundException(NOT_FOUND);
      throw err;
    }
  }

  /** POST — cancel a pending code (idempotent). */
  @Post("api/v1/pairing-codes/:pairingCodeId/cancel")
  @HttpCode(200)
  @UseGuards(RolesGuard)
  @Roles("owner", "tenant_admin", "store_manager")
  async cancel(
    @Req() request: TenantContextRequest,
    @Param("pairingCodeId") pairingCodeId: string,
  ): Promise<PairingCodeCancelResult> {
    const scoped = requireTenant(request);
    const actorUserId = requireUser(scoped);
    const parsed = PairingCodeIdParamSchema.safeParse(pairingCodeId);
    if (!parsed.success) {
      throw new BadRequestException({ code: "validation_error", message: "pairingCodeId must be a valid UUID." });
    }
    try {
      return await this.service.cancel({ ...scoped, actorUserId, pairingCodeId: parsed.data });
    } catch (err) {
      if (err instanceof PairingCodeNotFoundError) throw new NotFoundException(NOT_FOUND);
      if (err instanceof PairingCodeUsedError) {
        throw new HttpException({ code: "pairing_code_used", message: "The code was already redeemed." }, 409);
      }
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

function requireUser(scoped: ScopedInput): string {
  const userId = scoped.context.userId;
  if (userId === null) throw new UnauthorizedException("Unauthorized");
  return userId;
}
