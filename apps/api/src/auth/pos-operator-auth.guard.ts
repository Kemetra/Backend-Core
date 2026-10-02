/**
 * PosOperatorAuthGuard — scope gate for POS-operator route families.
 *
 * Mirror of `DashboardAuthGuard`. Delegates to `AuthGuard` first (handles
 * bearer authentication and attaches `request.principal`), then enforces
 * that ONLY the internal `pos_operator`-scoped bearer token may enter
 * POS-operator routes:
 *
 *   - `principal.kind === "session"`                          → 401
 *     (dashboard cookie sessions never reach POS surfaces)
 *   - `principal.kind === "token"` + scope === "pos_operator" → allow
 *   - `principal.kind === "token"` + scope === "dashboard_api" → 401
 *   - `principal.kind === "token"` + scope === "pos"          → 401
 *     (POS service-account tokens are not operator-session state — see
 *     002 FR-POS-AUTH-4 and FR-POS-AUTH-5)
 *
 * Apply to: POS-operator-authenticated routes such as the unknown-items
 * POS capture (`POST /api/pos/v1/catalog/unknown-items`) and the sale read
 * (`GET /api/pos/v1/sales/:saleRef`).
 *
 * Live re-verification (RT-137): a valid `pos_operator` token is not enough
 * on its own. Like `PosOperatorEnvelopeSaleGuard` on the sale-write routes,
 * every request re-checks LIVE that the bound device is not revoked, the
 * operator's membership is active with an eligible role, and the token's
 * store is still in the membership's store access. Revoking any of them
 * takes effect on the next request instead of after the token's 8h expiry.
 * Any refusal is the same generic 401 (fail closed, no reason disclosed).
 *
 * Spec anchor: specs/002-pos-operator-identity FR-POS-AUTH-4 —
 *   "The internal POS operator session token has scope `pos_operator` and
 *    is rejected on non-POS routes by a scope guard. Conversely, dashboard
 *    cookies and non-POS bearer tokens are rejected on POS routes."
 */
import {
  type ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { AuthGuard } from "./auth.guard";
import type { AuthedRequest } from "./auth.guard";
import { AuthTokenRepository } from "./auth-token.repository";
import {
  OPERATOR_CONTEXT_RESOLVER,
  type OperatorReverifier,
} from "./operator-context-resolver";
import { SessionRepository } from "./session.repository";

@Injectable()
export class PosOperatorAuthGuard extends AuthGuard {
  constructor(
    sessions: SessionRepository,
    authTokens: AuthTokenRepository,
    @Inject(OPERATOR_CONTEXT_RESOLVER)
    private readonly reverifier: OperatorReverifier,
  ) {
    super(sessions, authTokens);
  }

  override async canActivate(context: ExecutionContext): Promise<boolean> {
    await super.canActivate(context);

    const request = context.switchToHttp().getRequest<AuthedRequest>();
    const principal = request.principal;

    if (
      !principal ||
      principal.kind !== "token" ||
      principal.scope !== "pos_operator" ||
      principal.userId === null ||
      principal.storeId === null
    ) {
      throw new UnauthorizedException("Unauthorized");
    }

    // RT-137: re-verify device / membership / role / store access LIVE.
    const deviceId = await this.reverifier.recoverDeviceId(principal.tokenId);
    if (deviceId === null) throw new UnauthorizedException("Unauthorized");

    const verdict = await this.reverifier.reverify(
      principal.userId,
      deviceId,
      principal.storeId,
    );
    if (verdict.kind !== "ok") throw new UnauthorizedException("Unauthorized");

    return true;
  }
}
