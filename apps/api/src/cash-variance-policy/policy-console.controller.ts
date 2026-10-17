/**
 * CashVariancePolicyConsoleController — RT-387: the Console operations of
 * `cash-variance-policy.openapi.yaml` 1.0.0-draft.
 *
 *   GET  /api/v1/tenants/{tenant_id}/cash-variance-policy            consoleGetTenantCashVariancePolicy
 *   GET  /api/v1/tenants/{tenant_id}/cash-variance-policy/revisions  consoleListTenantCashVariancePolicyRevisions
 *   POST /api/v1/tenants/{tenant_id}/cash-variance-policy/revisions  consolePublishTenantCashVariancePolicy
 *   GET  /api/v1/stores/{store_id}/cash-variance-policy              consoleGetStoreCashVariancePolicy
 *   GET  /api/v1/stores/{store_id}/cash-variance-policy/revisions    consoleListStoreCashVariancePolicyRevisions
 *   POST /api/v1/stores/{store_id}/cash-variance-policy/revisions    consolePublishStoreCashVariancePolicyOverride
 *
 * Auth: the HUMAN `cookieAuth` session only → `SessionOnlyAdminGuard` (any
 * bearer is 401; a cookie POST without a trusted `Origin` is 403
 * `origin_rejected`, RT-430), then `TenantContextGuard`, then `RolesGuard`
 * (default deny → 404). Configuring is `owner` / `tenant_admin` (DR-10);
 * reading a store's effective policy is also open to `store_manager` for its
 * own stores. A `{tenant_id}` that is not the session's tenant is the same
 * non-disclosing 404 as a role or store refusal (§II, §XII).
 *
 * Writes are `@Idempotent("required")`. Their `cash_variance_policy.changed`
 * audit row is written by the service in the publish transaction (contract:
 * "in one transaction"), so the writes carry no `@Auditable`; the reads are
 * audited by the interceptor with their ids (`annotateAudit`).
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
import { Idempotent } from "../idempotency/idempotent.decorator";
import { PolicyPublishRefusedError, type PolicyRefusalCode } from "./policy-publish";
import {
  InvalidPolicyCursorError,
  type RevisionPage,
  type StorePolicyBody,
  type TenantPolicyBody,
} from "./policy.projections";
import {
  PAGE_SIZE_DEFAULT,
  PathIdSchema,
  PublishStoreOverrideSchema,
  PublishTenantPolicySchema,
  RevisionListQuerySchema,
  type PublishStoreOverrideBody,
  type PublishTenantPolicyBody,
  type RevisionListQuery,
} from "./policy.query";
import { ConcurrentPolicyChangeError } from "./policy.repository";
import {
  CashVariancePolicyService,
  PolicyStoreNotFoundError,
  type ConsoleInput,
  type PublishInput,
} from "./policy.service";

/** The one 404 body of this surface, equal to the `RolesGuard` refusal (FR-ISO-4). */
const NOT_FOUND = { code: "not_found", message: "Not Found" } as const;

const REFUSAL_MESSAGES: Readonly<Record<PolicyRefusalCode, string>> = {
  policy_currency_unsupported: "Only EGP is supported for a limit.",
  override_expiry_invalid: "effectiveUntil must be after the server time.",
  override_not_active: "The store has no active override to clear.",
  override_looser_than_tenant: "A store override may not be looser than the tenant default.",
  owner_approval_required: "A permanent override needs an owner.",
  cash_variance_policy_changed_concurrently: "The policy changed since it was read. Reload and retry.",
};

const TENANT = "api/v1/tenants/:tenant_id/cash-variance-policy";
const STORE = "api/v1/stores/:store_id/cash-variance-policy";

@Controller()
@UseGuards(SessionOnlyAdminGuard, TenantContextGuard)
export class CashVariancePolicyConsoleController {
  constructor(private readonly service: CashVariancePolicyService) {}

  @Get(TENANT)
  @UseGuards(RolesGuard)
  @Roles("owner", "tenant_admin")
  @Auditable("cash_variance_policy.tenant_read")
  tenantRead(@Req() request: TenantContextRequest, @Param("tenant_id") tenantId: string): Promise<TenantPolicyBody> {
    const input = sessionTenant(request, tenantId);
    annotateAudit(request, { tenant_id: input.tenantId });
    return this.service.tenantRead(input);
  }

  @Get(`${TENANT}/revisions`)
  @UseGuards(RolesGuard)
  @Roles("owner", "tenant_admin")
  @Auditable("cash_variance_policy.tenant_revisions_listed")
  tenantRevisions(
    @Req() request: TenantContextRequest,
    @Param("tenant_id") tenantId: string,
    @Query(new ZodValidationPipe(RevisionListQuerySchema)) query: RevisionListQuery,
  ): Promise<RevisionPage> {
    const input = sessionTenant(request, tenantId);
    annotateAudit(request, { tenant_id: input.tenantId });
    return mapErrors(() => this.service.tenantRevisions({ ...input, ...page(query) }));
  }

  @Post(`${TENANT}/revisions`)
  @HttpCode(201)
  @UseGuards(RolesGuard)
  @Roles("owner", "tenant_admin")
  @Idempotent("required")
  tenantPublish(
    @Req() request: TenantContextRequest,
    @Param("tenant_id") tenantId: string,
    @Body(new ZodValidationPipe(PublishTenantPolicySchema)) body: PublishTenantPolicyBody,
  ): Promise<TenantPolicyBody> {
    const input = publisher(request, sessionTenant(request, tenantId));
    return mapErrors(() => this.service.tenantPublish(input, body));
  }

  @Get(STORE)
  @UseGuards(RolesGuard)
  @Roles("owner", "tenant_admin", "store_manager")
  @Auditable("cash_variance_policy.store_read")
  storeRead(@Req() request: TenantContextRequest, @Param("store_id") storeId: string): Promise<StorePolicyBody> {
    const input = session(request);
    const id = parseId(storeId, "store_id");
    annotateAudit(request, { store_id: id });
    return mapErrors(() => this.service.storeRead(input, id));
  }

  @Get(`${STORE}/revisions`)
  @UseGuards(RolesGuard)
  @Roles("owner", "tenant_admin")
  @Auditable("cash_variance_policy.store_revisions_listed")
  storeRevisions(
    @Req() request: TenantContextRequest,
    @Param("store_id") storeId: string,
    @Query(new ZodValidationPipe(RevisionListQuerySchema)) query: RevisionListQuery,
  ): Promise<RevisionPage> {
    const input = session(request);
    const id = parseId(storeId, "store_id");
    annotateAudit(request, { store_id: id });
    return mapErrors(() => this.service.storeRevisions({ ...input, ...page(query) }, id));
  }

  @Post(`${STORE}/revisions`)
  @HttpCode(201)
  @UseGuards(RolesGuard)
  @Roles("owner", "tenant_admin")
  @Idempotent("required")
  storePublish(
    @Req() request: TenantContextRequest,
    @Param("store_id") storeId: string,
    @Body(new ZodValidationPipe(PublishStoreOverrideSchema)) body: PublishStoreOverrideBody,
  ): Promise<StorePolicyBody> {
    const input = publisher(request, session(request));
    const id = parseId(storeId, "store_id");
    return mapErrors(() =>
      this.service.storePublish(input, {
        storeId: id,
        expectedRevisionId: body.expectedRevisionId,
        kind: body.kind,
        reason: body.reason,
        ...(body.policyValue !== undefined ? { policyValue: body.policyValue } : {}),
        ...(body.effectiveUntil !== undefined ? { effectiveUntil: body.effectiveUntil } : {}),
      }),
    );
  }
}

function page(query: RevisionListQuery): { cursor: string | null; limit: number } {
  return { cursor: query.cursor ?? null, limit: query.page_size ?? PAGE_SIZE_DEFAULT };
}

/** A request-shape error, checked before any read: it discloses nothing. */
function parseId(value: string, name: string): string {
  const parsed = PathIdSchema.safeParse(value);
  if (!parsed.success) throw new BadRequestException({ code: "validation_error", message: `${name} must be a valid UUID.` });
  return parsed.data;
}

/** The session tenant and the context whose role and store scope bound the call. */
function session(request: TenantContextRequest): ConsoleInput {
  const ctx = request.context;
  if (!ctx || ctx.tenantId === null) throw new UnauthorizedException("Unauthorized");
  return { tenantId: ctx.tenantId, context: ctx };
}

/** The session, when `{tenant_id}` names the session's own tenant; any other tenant is the 404. */
function sessionTenant(request: TenantContextRequest, tenantId: string): ConsoleInput {
  const input = session(request);
  if (parseId(tenantId, "tenant_id") !== input.tenantId.toLowerCase()) throw new NotFoundException(NOT_FOUND);
  return input;
}

function publisher(request: TenantContextRequest, input: ConsoleInput): PublishInput {
  const actorUserId = input.context.userId;
  if (actorUserId === null) throw new UnauthorizedException("Unauthorized");
  return { ...input, actorUserId, requestId: request.requestId ?? null };
}

/**
 * A lost chain race in the database (the 0050 chain index / guard behind the
 * advisory lock) is the same 409 as a stale `expectedRevisionId`.
 */
function asRefusal(err: unknown): unknown {
  return err instanceof ConcurrentPolicyChangeError
    ? new PolicyPublishRefusedError("cash_variance_policy_changed_concurrently")
    : err;
}

/** The contract's 4xx for a service refusal, or null for anything else (a 500). */
function toHttpError(thrown: unknown): HttpException | null {
  const err = asRefusal(thrown);
  if (err instanceof InvalidPolicyCursorError) {
    return new BadRequestException({ code: "validation_error", message: "cursor is not valid." });
  }
  if (err instanceof PolicyStoreNotFoundError) return new NotFoundException(NOT_FOUND);
  if (err instanceof PolicyPublishRefusedError) {
    return new HttpException({ code: err.code, message: REFUSAL_MESSAGES[err.code] }, err.status);
  }
  return null;
}

/** Maps the service's refusals to the contract's 4xx; anything else propagates (500). */
async function mapErrors<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    throw toHttpError(err) ?? err;
  }
}
