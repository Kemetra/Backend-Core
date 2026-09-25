/**
 * PosOperatorEnvelopeSaleGuard — 031 (D1+D2, Option B) sale-sync gate.
 *
 * Replaces the Option-Y `PosOperatorSaleAuthGuard` on the sale-write routes
 * (captureSale / recordVoid / recordRefund). Two layers:
 *
 *   1. Canonical operator-authorization (inherited from `PosOperatorAuthGuard`):
 *      the client presents the operator-authorization ENVELOPE as
 *      `Authorization: Bearer <envelope>`; `AuthGuard.findActiveByRawToken`
 *      resolves it to a `{ kind:"token", scope:"pos_operator" }` principal
 *      (token valid, not revoked, not expired) and rejects everything else
 *      with a generic 401. This closes the D2 phantom — the canonical guard's
 *      demanded credential is now obtainable.
 *
 *   2. Live predicate re-verification (031 G-4, Option B): the canonical token
 *      check does NOT re-resolve membership-active / device-active /
 *      store-access — those were checked once, at sign-in. Under Option-Y the
 *      sale path re-resolved them per request. To NOT weaken the composed
 *      predicate (G-4), this guard recovers the bound `device_id` from the
 *      `auth_tokens` row and calls `OperatorReverifier.reverify(...)` to
 *      re-evaluate them LIVE on every sale. A mid-session revocation (pulled
 *      membership, revoked device, removed store-access) therefore stops the
 *      next sale immediately — not after the 8h TTL.
 *
 * Every refusal (missing/invalid/revoked/expired envelope OR a failed live
 * re-verification) collapses to the SAME generic `UnauthorizedException` (401):
 * no factor disclosure (028 SR-6).
 *
 * Provenance (G-5) is unchanged: the canonical principal carries the real
 * `userId`, which the AuditEmitterInterceptor records as `actor_user_id`.
 */
import {
  type ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";

import { AuthGuard } from "./auth.guard";
import { SessionRepository } from "./session.repository";
import { AuthTokenRepository } from "./auth-token.repository";
import {
  OPERATOR_CONTEXT_RESOLVER,
  type OperatorReverifier,
} from "./operator-context-resolver";
import type { TenantContextRequest } from "../context/types";

@Injectable()
export class PosOperatorEnvelopeSaleGuard extends AuthGuard {
  constructor(
    sessions: SessionRepository,
    authTokens: AuthTokenRepository,
    @Inject(OPERATOR_CONTEXT_RESOLVER)
    private readonly reverifier: OperatorReverifier,
  ) {
    super(sessions, authTokens);
  }

  override async canActivate(context: ExecutionContext): Promise<boolean> {
    // Layer 1 — canonical bearer auth (attaches request.principal).
    await super.canActivate(context);

    const request = context.switchToHttp().getRequest<TenantContextRequest>();
    const principal = request.principal;

    // Only an internal pos_operator token principal may enter the sale path.
    if (
      !principal ||
      principal.kind !== "token" ||
      principal.scope !== "pos_operator" ||
      principal.userId === null ||
      principal.storeId === null
    ) {
      throw new UnauthorizedException("Unauthorized");
    }

    // Layer 2 — live predicate (G-4). Recover the bound device, then re-verify
    // membership / device / store-access LIVE. Any refusal → generic 401.
    const deviceId = await this.reverifier.recoverDeviceId(principal.tokenId);
    if (deviceId === null) throw new UnauthorizedException("Unauthorized");

    const verdict = await this.reverifier.reverify(
      principal.userId,
      deviceId,
      principal.storeId,
    );
    if (verdict.kind !== "ok") throw new UnauthorizedException("Unauthorized");

    // Publish the resolved scope onto request.context — behavioural parity with
    // the retired Option-Y guard (which set request.context = result.context).
    // The sale controllers read request.context for (tenant_id, store_id,
    // actor) and 401 if it is absent; this guard runs WITHOUT TenantContextGuard
    // (it is a single guard on the write routes), so it must populate context
    // itself. Scope comes from the envelope principal's server-side binding,
    // NEVER from the request body (mass-assignment ban).
    request.context = {
      userId: principal.userId,
      tenantId: principal.tenantId,
      storeId: principal.storeId,
      isPlatformAdmin: false,
      source: "token",
    };
    request.posDeviceId = deviceId;

    return true;
  }
}
