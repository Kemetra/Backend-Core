/**
 * SaleCaptureAuthGuard — captureSale's credential gate (RT-224 Option B;
 * [GATED] approval: Jira RT-224 comment 10889).
 *
 * captureSale accepts two ALTERNATIVE credentials (sales.yaml 1.5.0-draft):
 *
 *   1. Envelope path (unchanged, 031): the body carries no `operatorUserId`.
 *      The request goes to PosOperatorEnvelopeSaleGuard and to nothing else,
 *      so a manager/admin sale behaves exactly as before: canonical bearer
 *      auth, live re-verification, the operator as actor.
 *
 *   2. Device path: the body carries `operatorUserId` (its PRESENCE selects
 *      this path; an envelope request that carries it is therefore refused).
 *        a. PosDeviceAuthGuard resolves the bearer to an active device of an
 *           active tenant (RT-213) and publishes its tenant, store and
 *           device. Never the request's.
 *        b. The body is validated with the captureSale pipe, so a malformed
 *           body from an AUTHENTICATED device is the usual 400 (the pipe runs
 *           again in the handler; it is pure). An unauthenticated device
 *           never reaches this step: authentication comes first.
 *        c. The attribution verifier must accept (device scope, claimed user,
 *           occurredAt): a covering cashier admission of this device and
 *           store, plus the live cashier eligibility rules.
 *        d. Only then is the VERIFIED user published as the actor
 *           (`request.context.userId`, `request.principal.userId`), which is
 *           what the controller records as `created_by`, the idempotency
 *           layer scopes the key to, and the audit emitter records as actor.
 *
 * Every refusal on either path is the same generic 401 (no factor
 * disclosure). A refusal of the claimed cashier is logged once with
 * allowlisted fields only (signals.md §4 / redaction matrix §3.4): never the
 * claimed user, the token, the body or occurredAt.
 *
 * The route carries @DeviceBearer() so the global FailClosedAuthGuard defers
 * to this guard (its opaque-token lookup would reject a device token). Both
 * paths authenticate here; route-auth-markers.enforcement.spec.ts lists this
 * guard as a reviewed composite that runs PosDeviceAuthGuard.
 */
import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  Optional,
  UnauthorizedException,
} from "@nestjs/common";
import type { Logger } from "@data-pulse-2/shared";

import { PosDeviceAuthGuard } from "../../auth/pos-device-auth.guard";
import { PosOperatorEnvelopeSaleGuard } from "../../auth/pos-operator-envelope-sale.guard";
import { ROOT_LOGGER } from "../../common/logging.interceptor";
import type { TenantContextRequest } from "../../context/types";
import { deviceScopeOf } from "../../pos-cashier-admissions/device-scope";
import { CaptureSaleRequestPipe } from "./dto/capture-sale-request.pipe";
import {
  ATTRIBUTION_REFUSAL_EVENTS,
  OPERATOR_ATTRIBUTION_VERIFIER,
  type OperatorAttributionVerifier,
} from "./operator-attribution";

/** The body field whose presence selects the device path (sales.yaml). */
export const OPERATOR_USER_ID_FIELD = "operatorUserId";

/** True when the JSON body object carries `operatorUserId` (any value). */
export function selectsDevicePath(body: unknown): boolean {
  return (
    typeof body === "object" &&
    body !== null &&
    !Array.isArray(body) &&
    Object.prototype.hasOwnProperty.call(body, OPERATOR_USER_ID_FIELD)
  );
}

type Gate = Pick<CanActivate, "canActivate">;

@Injectable()
export class SaleCaptureAuthGuard implements CanActivate {
  private readonly bodyPipe = new CaptureSaleRequestPipe();

  // A class-referenced @UseGuards enhancer is reflection-instantiated, so
  // every dependency is an explicit, module-resolvable token (SalesModule
  // provides all four; ROOT_LOGGER is app-wide and optional).
  constructor(
    @Inject(PosOperatorEnvelopeSaleGuard) private readonly envelope: Gate,
    @Inject(PosDeviceAuthGuard) private readonly device: Gate,
    @Inject(OPERATOR_ATTRIBUTION_VERIFIER) private readonly attribution: OperatorAttributionVerifier,
    @Optional() @Inject(ROOT_LOGGER) private readonly logger?: Pick<Logger, "warn">,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<TenantContextRequest>();
    if (!selectsDevicePath(request.body)) {
      return (await this.envelope.canActivate(context)) as boolean;
    }

    // a. The device (generic 401 on any failure).
    await this.device.canActivate(context);
    const scope = deviceScopeOf(request);

    // b. The body (400 on a malformed body, as the handler's pipe would).
    const body = this.bodyPipe.transform(request.body, { type: "body" });
    const userId = body.operatorUserId;
    if (userId === undefined) throw unauthorized();

    // c. The claimed cashier.
    const verdict = await this.attribution.verify({
      tenantId: scope.tenantId,
      storeId: scope.storeId,
      deviceId: scope.deviceId,
      userId,
      occurredAt: body.occurredAt,
    });
    if (!verdict.ok) {
      this.logger?.warn(
        {
          event: ATTRIBUTION_REFUSAL_EVENTS[verdict.cause],
          request_id: request.requestId ?? null,
          tenant_id: scope.tenantId,
          store_id: scope.storeId,
          outcome: "failure",
        },
        "captureSale: operator attribution refused",
      );
      throw unauthorized();
    }

    // d. The verified cashier is the actor. Scope stays the device's.
    request.context = {
      userId,
      tenantId: scope.tenantId,
      storeId: scope.storeId,
      isPlatformAdmin: false,
      source: "token",
    };
    request.principal = {
      kind: "token",
      tokenId: scope.deviceId,
      tenantId: scope.tenantId,
      userId,
      storeId: scope.storeId,
      scope: "pos",
    };
    return true;
  }
}

function unauthorized(): UnauthorizedException {
  return new UnauthorizedException("Unauthorized");
}
