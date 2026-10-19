/**
 * AiEntitlementsController — RT-664: the Console operations of
 * `ai-entitlements.openapi.yaml` (RT-662).
 *
 *   GET /api/v1/tenants/{tenant_id}/ai/entitlements                          consoleGetTenantAiEntitlements
 *   PUT /api/v1/tenants/{tenant_id}/ai/entitlements/opt-outs/{feature_id}    consolePutTenantAiFeatureOptOut
 *
 * Auth: the HUMAN `cookieAuth` session only → `SessionOnlyAdminGuard` (any
 * bearer is 401; a cookie write without a trusted `Origin` is 403
 * `origin_rejected`), then `TenantContextGuard`, then `RolesGuard` (default
 * deny → 404). The read is `owner` / `tenant_admin` / `store_manager` (and a
 * platform admin through the `RolesGuard` pass); the view follows the role
 * (D-6). The write is `owner` only: `AiOwnerMembershipGuard` refuses a
 * platform admin and every other role with the same 404 (D-5). Guards run
 * before validation and before any entitlement read (layer 3 before 6).
 *
 * The write's `ai_entitlement.opt_out_changed` audit row is written by the
 * service in the write transaction, so neither route carries `@Auditable`
 * (the read writes no audit event, per the contract).
 */
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  HttpException,
  NotFoundException,
  Param,
  Put,
  Query,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";

import { Roles } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";
import { SessionOnlyAdminGuard } from "../auth/session-only-admin.guard";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { TenantContextGuard } from "../context/tenant-context.guard";
import type { ResolvedContext, TenantContextRequest } from "../context/types";
import { Idempotent } from "../idempotency/idempotent.decorator";
import {
  AiEntitlementsService,
  EntitlementUnavailableError,
  OptInExceedsPlanError,
  OptOutConflictError,
  UnknownAiFeatureError,
} from "./ai-entitlements.service";
import { AI_FEATURE_ID_PATTERN } from "./entitlement-checker";
import type { FullViewBody, MinimalViewBody } from "./entitlement-view";
import { AiOwnerMembershipGuard } from "./owner-membership.guard";

const NOT_FOUND = { code: "not_found", message: "Not Found" } as const;
const PATH = "api/v1/tenants/:tenant_id/ai/entitlements";

const UuidSchema = z.string().uuid();
const FeatureIdSchema = z.string().min(4).max(64).regex(AI_FEATURE_ID_PATTERN);
const NoQuerySchema = z.object({}).strict();
const OptOutBodySchema = z
  .object({
    expectedOptOutVersion: z.number().int().min(0),
    optedOut: z.boolean(),
    reason: z.string().min(1).max(500),
  })
  .strict();
type OptOutBody = z.infer<typeof OptOutBodySchema>;

const FULL_VIEW_ROLES: ReadonlySet<string> = new Set(["owner", "tenant_admin"]);

function validation(message: string): BadRequestException {
  return new BadRequestException({ code: "validation_error", message });
}

function sessionOf(request: TenantContextRequest): ResolvedContext & { tenantId: string; userId: string } {
  const ctx = request.context;
  if (!ctx || ctx.tenantId === null || ctx.userId === null) throw new UnauthorizedException("Unauthorized");
  return ctx as ResolvedContext & { tenantId: string; userId: string };
}

/** `{tenant_id}` must be the session's tenant: malformed → 400, any other tenant → the 404. */
function sessionTenant(request: TenantContextRequest, tenantId: string): ResolvedContext & { tenantId: string; userId: string } {
  const ctx = sessionOf(request);
  if (!UuidSchema.safeParse(tenantId).success) throw validation("tenant_id must be a valid UUID.");
  if (tenantId.toLowerCase() !== ctx.tenantId.toLowerCase()) throw new NotFoundException(NOT_FOUND);
  return ctx;
}

function toHttpError(err: unknown): HttpException | null {
  if (err instanceof EntitlementUnavailableError) {
    return new ServiceUnavailableException({ code: "entitlement_unavailable", message: "AI entitlements are temporarily unavailable." });
  }
  if (err instanceof UnknownAiFeatureError) return new NotFoundException(NOT_FOUND);
  if (err instanceof OptOutConflictError) {
    return new HttpException({ code: "ai_opt_out_changed_concurrently", message: "The opt-outs changed since they were read. Reload and retry." }, 409);
  }
  if (err instanceof OptInExceedsPlanError) {
    return new HttpException({ code: "not_entitled", message: "The plan does not include this feature." }, 422);
  }
  return null;
}

async function mapErrors<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    throw toHttpError(err) ?? err;
  }
}

@Controller()
@UseGuards(SessionOnlyAdminGuard, TenantContextGuard)
export class AiEntitlementsController {
  constructor(private readonly service: AiEntitlementsService) {}

  @Get(PATH)
  @UseGuards(RolesGuard)
  @Roles("owner", "tenant_admin", "store_manager")
  @Header("Cache-Control", "no-store")
  async read(
    @Req() request: TenantContextRequest,
    @Param("tenant_id") tenantId: string,
    @Query() query: unknown,
  ): Promise<FullViewBody | MinimalViewBody> {
    const ctx = sessionTenant(request, tenantId);
    if (!NoQuerySchema.safeParse(query ?? {}).success) throw validation("No query parameter is accepted.");
    return mapErrors(async () => this.service.read(ctx.tenantId, await this.viewFor(ctx)));
  }

  @Put(`${PATH}/opt-outs/:feature_id`)
  @UseGuards(RolesGuard, AiOwnerMembershipGuard)
  @Roles("owner")
  @Idempotent("required")
  @Header("Cache-Control", "no-store")
  optOut(
    @Req() request: TenantContextRequest,
    @Param("tenant_id") tenantId: string,
    @Param("feature_id") featureId: string,
    @Body(new ZodValidationPipe(OptOutBodySchema)) body: OptOutBody,
  ): Promise<FullViewBody> {
    const ctx = sessionTenant(request, tenantId);
    if (!FeatureIdSchema.safeParse(featureId).success) throw validation("feature_id is not a valid AI feature id.");
    return mapErrors(() =>
      this.service.optOut({
        tenantId: ctx.tenantId,
        actorUserId: ctx.userId,
        requestId: request.requestId ?? null,
        featureId,
        expectedOptOutVersion: body.expectedOptOutVersion,
        optedOut: body.optedOut,
        reason: body.reason,
      }),
    );
  }

  /** D-6: owner / tenant_admin / platform admin → full; store_manager → minimal. */
  private async viewFor(ctx: ResolvedContext & { tenantId: string; userId: string }): Promise<"full" | "minimal"> {
    if (ctx.isPlatformAdmin) return "full";
    const role = await this.service.roleOf(ctx.userId, ctx.tenantId);
    if (role !== null && FULL_VIEW_ROLES.has(role)) return "full";
    if (role === "store_manager") return "minimal";
    throw new NotFoundException(NOT_FOUND);
  }
}
