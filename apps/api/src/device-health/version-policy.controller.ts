/**
 * PosVersionPolicyController: RT-327 runtime of `platformGetPosVersionPolicy`
 * and `platformSetPosVersionPolicy`
 * (`packages/contracts/openapi/pos-device-health.openapi.yaml`):
 *
 *   GET /api/v1/platform/pos-version-policy
 *   PUT /api/v1/platform/pos-version-policy/{channel}
 *
 * Auth (as `listPlatformAuditEvents`, RT-431): `SessionOnlyAdminGuard` (the
 * human cookie session only; any bearer, device token or operator envelope is
 * 401, and an unsafe cookie request needs a trusted `Origin`, RT-430), then
 * `PlatformAdminGuard` (`users.is_platform_admin`, read from the database;
 * every other signed-in user, a tenant owner included, is 403 `forbidden`).
 *
 * This is its own class and is NOT behind `TenantContextGuard`: RT-414
 * support-session enforcement matches that guard by name, and these routes
 * are platform scope. No active tenant is needed, no support session is
 * required and no `platform.cross_tenant.accessed` row is written. No
 * `@Auditable`: the read is not audited, and the change writes its own
 * platform-scoped `pos.release_policy.changed` row in its transaction.
 *
 * Refusals: a bad channel, body or key is 400 `validation_error`; 409
 * `policy_revision_conflict` for a stale `expectedRevision`; 422
 * `version_order_invalid` for out-of-order versions.
 */
import { Body, Controller, Get, Header, HttpException, Inject, Param, Put, Req, UnauthorizedException, UseGuards } from "@nestjs/common";

import { PlatformAdminGuard } from "../audit/platform-admin.guard";
import type { AuthedRequest } from "../auth/auth.guard";
import { SessionOnlyAdminGuard } from "../auth/session-only-admin.guard";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { ConsoleRateLimit } from "../console-rate-limit/console-rate-limit.decorator";
import {
  ChannelParamSchema,
  PosVersionPolicyChangeSchema,
  type PosVersionPolicyChange,
  type UpdateChannel,
} from "./dto";
import {
  PolicyRevisionConflictError,
  PosVersionPolicyService,
  VersionOrderInvalidError,
  type PosVersionPolicyEntryBody,
} from "./version-policy.service";

@Controller("api/v1/platform/pos-version-policy")
@UseGuards(SessionOnlyAdminGuard, PlatformAdminGuard)
export class PosVersionPolicyController {
  constructor(@Inject(PosVersionPolicyService) private readonly service: PosVersionPolicyService) {}

  /** GET: every channel's policy, in the order lab, canary, stable. */
  @Get()
  // RT-327: platformGetPosVersionPolicy (three rows).
  @ConsoleRateLimit("cheapRead")
  @Header("Cache-Control", "no-store")
  async list(): Promise<{ items: PosVersionPolicyEntryBody[] }> {
    return this.service.list();
  }

  /** PUT: replace one channel's policy (compare-and-set on `expectedRevision`). */
  @Put(":channel")
  // RT-327: platformSetPosVersionPolicy (audited change).
  @ConsoleRateLimit("write")
  @Header("Cache-Control", "no-store")
  async set(
    @Req() request: AuthedRequest,
    @Param("channel", new ZodValidationPipe(ChannelParamSchema)) channel: UpdateChannel,
    @Body(new ZodValidationPipe(PosVersionPolicyChangeSchema)) body: PosVersionPolicyChange,
  ): Promise<PosVersionPolicyEntryBody> {
    const principal = request.principal;
    if (principal?.kind !== "session") throw new UnauthorizedException("Unauthorized");
    try {
      return await this.service.set({
        channel,
        change: body,
        actorUserId: principal.userId,
        requestId: request.requestId ?? null,
      });
    } catch (err) {
      if (err instanceof PolicyRevisionConflictError) {
        throw new HttpException({ code: "policy_revision_conflict", message: "The policy changed. Read it again and retry." }, 409);
      }
      if (err instanceof VersionOrderInvalidError) {
        throw new HttpException(
          { code: "version_order_invalid", message: "Versions must satisfy minSupportedVersion <= recommendedVersion <= latestVersion." },
          422,
        );
      }
      throw err;
    }
  }
}
