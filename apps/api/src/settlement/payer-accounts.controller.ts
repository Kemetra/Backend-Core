/**
 * PayerAccountsController — RT-418: the two operations `settlement/settlement.yaml`
 * 2.0.0 keeps (RT-417):
 *
 *   POST /api/v1/settlement/payer-accounts  consoleCreatePayerAccount
 *   GET  /api/v1/settlement/payer-accounts  consoleListPayerAccounts
 *
 * AUTH: the human cookie stack (`DashboardAuthGuard` + `TenantContextGuard`)
 * and `RolesGuard` with owner / tenant_admin. An insufficient role is a 403
 * (the contract's `Forbidden`): the caller acts inside an already-resolved
 * tenant, so the refusal discloses nothing. The guard also enforces the
 * RT-430 Origin check on the cookie-authenticated POST.
 *
 * Create is `@Idempotent("required")` (the shared IdempotencyInterceptor):
 * the same key and body replay the stored 201, the key with another body is
 * 409 `idempotency_key_conflict`. `tenant_id` and store scope come from
 * `request.context`, never the body (§XII). Every response is the
 * `toPayerAccount` projection (§IV).
 */
import {
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";

import { Auditable } from "../audit/auditable.decorator";
import { DashboardAuthGuard } from "../auth/dashboard-auth.guard";
import { Roles } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { TenantContextGuard } from "../context/tenant-context.guard";
import type { TenantContextRequest } from "../context/types";
import { Idempotent } from "../idempotency/idempotent.decorator";
import {
  PAYER_PAGE_SIZE_DEFAULT,
  PayerAccountCreateSchema,
  PayerAccountListQuerySchema,
  PayerAccountUpdateSchema,
  PayerRefParamSchema,
  toPayerAccount,
  type PayerAccountBody,
  type PayerAccountCreateDto,
  type PayerAccountListQuery,
  type PayerAccountUpdateDto,
} from "./dto/payer-account.dto";
import {
  PayerAccountsService,
  PayerNotFoundError,
  PayerScopeInsufficientError,
  PayerStoreNotInScopeError,
  PayerVersionConflictError,
  type PayerScopedInput,
} from "./payer-accounts.service";

interface PayerAccountPageBody {
  readonly items: PayerAccountBody[];
  readonly nextCursor: string | null;
}

const NOT_FOUND = { code: "not_found", message: "Not found." } as const;

@Controller()
@UseGuards(DashboardAuthGuard, TenantContextGuard, RolesGuard)
export class PayerAccountsController {
  constructor(private readonly service: PayerAccountsService) {}

  @Post("api/v1/settlement/payer-accounts")
  @Roles("owner", "tenant_admin", { denyAs: 403 })
  @Idempotent("required")
  @Auditable("settlement.payer_account.created")
  async create(
    @Req() request: TenantContextRequest,
    @Body(new ZodValidationPipe(PayerAccountCreateSchema)) body: PayerAccountCreateDto,
  ): Promise<PayerAccountBody> {
    try {
      return toPayerAccount(await this.service.create({ ...scopeOf(request), body }));
    } catch (err) {
      if (err instanceof PayerStoreNotInScopeError) throw new NotFoundException(NOT_FOUND);
      throw err;
    }
  }

  /**
   * RT-572 `consoleUpdatePayerAccount`. No `@Auditable`: the service writes
   * `settlement.payer_account.updated` in the update's transaction (and none on
   * a no-op), which the per-request interceptor cannot do. `payerRef` is
   * validated as a uuid by the param pipe before any SQL cast (400, never a
   * Postgres 22P02). Refusals, in order: 400, role 403, 404, tenant-wide scope
   * 403 `payer_scope_insufficient`, version 409 `payer_version_conflict`.
   */
  @Patch("api/v1/settlement/payer-accounts/:payerRef")
  @Roles("owner", "tenant_admin", { denyAs: 403 })
  @Idempotent("required")
  async update(
    @Req() request: TenantContextRequest,
    @Param("payerRef", new ZodValidationPipe(PayerRefParamSchema)) payerRef: string,
    @Body(new ZodValidationPipe(PayerAccountUpdateSchema)) body: PayerAccountUpdateDto,
  ): Promise<PayerAccountBody> {
    const scope = scopeOf(request);
    try {
      const row = await this.service.update({
        ...scope,
        payerRef,
        actorUserId: scope.context.userId,
        requestId: request.requestId ?? null,
        body,
      });
      return toPayerAccount(row);
    } catch (err) {
      if (err instanceof PayerNotFoundError) throw new NotFoundException(NOT_FOUND);
      if (err instanceof PayerScopeInsufficientError) {
        throw new ForbiddenException({
          code: "payer_scope_insufficient",
          message: "Changing a tenant-wide payer's status or ERPNext link needs access to all stores.",
        });
      }
      if (err instanceof PayerVersionConflictError) {
        throw new ConflictException({
          code: "payer_version_conflict",
          message: "The payer changed since it was read. Reload it and retry with its current version.",
        });
      }
      throw err;
    }
  }

  @Get("api/v1/settlement/payer-accounts")
  @Roles("owner", "tenant_admin", { denyAs: 403 })
  @Auditable("settlement.payer_account.listed")
  async list(
    @Req() request: TenantContextRequest,
    @Query(new ZodValidationPipe(PayerAccountListQuerySchema)) query: PayerAccountListQuery,
  ): Promise<PayerAccountPageBody> {
    const page = await this.service.list({
      ...scopeOf(request),
      ...(query.category !== undefined ? { category: query.category } : {}),
      cursor: query.cursor ?? null,
      limit: query.page_size ?? PAYER_PAGE_SIZE_DEFAULT,
    });
    return { items: page.items.map(toPayerAccount), nextCursor: page.nextCursor };
  }
}

/** The session's tenant and the context whose store access bounds the call. */
function scopeOf(request: TenantContextRequest): PayerScopedInput {
  const ctx = request.context;
  if (!ctx || ctx.tenantId === null) throw new UnauthorizedException("Unauthorized");
  return { tenantId: ctx.tenantId, context: ctx };
}
