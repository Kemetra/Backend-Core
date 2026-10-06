/**
 * ShiftCashUpAuthGuard — the credential gate of the RT-17 cash-up writes
 * ([GATED] approval: Jira RT-17 comments 10760 + 10919 + 10920; contract
 * `pos-shifts.openapi.yaml` 1.1.0-draft, "Authentication").
 *
 * The same two ALTERNATIVE credentials as captureSale (RT-224 Option B,
 * `SaleCaptureAuthGuard`), reused rather than copied:
 *
 *   1. Envelope path: the body carries no `operatorUserId`. The request goes
 *      to `PosOperatorEnvelopeSaleGuard` and nothing else (canonical bearer
 *      auth plus the live operator re-check; the operator is the actor).
 *
 *   2. Device path: the body carries `operatorUserId` (its PRESENCE selects
 *      this path, so an envelope that carries it is the generic 401).
 *        a. `PosDeviceAuthGuard` resolves the bearer to an active device of
 *           an active tenant; scope comes from that row only.
 *        b. The route's strict body schema runs (a malformed body from an
 *           authenticated device is the usual 400).
 *        c. The route's stated user (`openingUserId`) must equal the claim
 *           (#711 review note 1).
 *        d. `PgOperatorAttributionVerifier` must accept the claim at the
 *           fact's own time (`openedAt` / `occurredAt`): a covering cashier
 *           admission of this device and store with the RT-224 tolerance and
 *           dating caps, plus the live cashier eligibility rules.
 *        e. Only then is the VERIFIED cashier published as the actor, which
 *           the service records, the idempotency layer scopes the key to and
 *           the audit emitter records.
 *
 * Refusals: a bad, revoked or missing credential on either path is the
 * generic 401; a refused claim from an AUTHENTICATED device is the generic
 * 403 `refused`, one body for every cause (to the POS a device 401 means
 * "device revoked"). A refusal is logged once with allowlisted fields and a
 * fixed event name; never the claimed user, the token, the body or a time.
 *
 * Per-route policy is route metadata (`@ShiftFactRoute`), read straight from
 * the handler: a class-referenced guard is one shared instance. The route
 * also carries `@DeviceBearer()`, so the global FailClosedAuthGuard defers
 * here; route-auth-markers.enforcement.spec.ts lists this guard as a
 * reviewed composite that runs PosDeviceAuthGuard.
 */
import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  Optional,
  SetMetadata,
  UnauthorizedException,
} from "@nestjs/common";
import type { Logger } from "@data-pulse-2/shared";
import type { ZodTypeAny } from "zod";

import { PosDeviceAuthGuard } from "../auth/pos-device-auth.guard";
import { PosOperatorEnvelopeSaleGuard } from "../auth/pos-operator-envelope-sale.guard";
import {
  OPERATOR_ATTRIBUTION_VERIFIER,
  type AttributionRefusal,
  type OperatorAttributionVerifier,
} from "../catalog/sales/operator-attribution";
import { selectsDevicePath } from "../catalog/sales/sale-capture-auth.guard";
import { ROOT_LOGGER } from "../common/logging.interceptor";
import type { TenantContextRequest } from "../context/types";
import { deviceScopeOf, type DeviceScope } from "../pos-cashier-admissions/device-scope";

/** How one cash-up route is verified on the device path. */
export interface ShiftFactRouteSpec {
  /** The route's strict body schema (the handler's pipe uses the same one). */
  readonly schema: ZodTypeAny;
  /** The body field holding the fact's POS-clock time: the attribution instant. */
  readonly timeField: string;
  /** The body field naming the stated user, which must equal the claim. */
  readonly actorField?: string;
}

export const SHIFT_FACT_ROUTE_KEY = "dp2:shift-cash-up:fact-route";

/** Route metadata for ShiftCashUpAuthGuard. */
export const ShiftFactRoute = (spec: ShiftFactRouteSpec) => SetMetadata(SHIFT_FACT_ROUTE_KEY, spec);

/** Why a device-path claim was refused. A closed set, logged and never returned. */
export type ShiftClaimRefusal = AttributionRefusal | "operator_missing" | "actor_mismatch";

/** The refusal log's fixed `event` for a cause. */
export function shiftRefusalEvent(cause: ShiftClaimRefusal): string {
  return `shift.cash_up.operator_refused.${cause}`;
}

type Gate = Pick<CanActivate, "canActivate">;
type FactBody = Record<string, unknown>;

@Injectable()
export class ShiftCashUpAuthGuard implements CanActivate {
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

    await this.device.canActivate(context);
    const scope = deviceScopeOf(request);
    const route = routeSpecOf(context);
    const body = route.schema.parse(request.body) as FactBody;

    const refusal = await this.refusalOf(scope, route, body);
    if (refusal !== null) {
      this.logger?.warn(
        {
          event: shiftRefusalEvent(refusal),
          request_id: request.requestId ?? null,
          tenant_id: scope.tenantId,
          store_id: scope.storeId,
          status: 403,
          outcome: "failure",
        },
        "shift cash-up: operator attribution refused",
      );
      throw new ForbiddenException({ code: "refused", message: "Forbidden" });
    }

    publishCashier(request, scope, body["operatorUserId"] as string);
    return true;
  }

  /** The first refusal cause of a device-path claim, or null when it is accepted. */
  private async refusalOf(
    scope: DeviceScope,
    route: ShiftFactRouteSpec,
    body: FactBody,
  ): Promise<ShiftClaimRefusal | null> {
    const userId = body["operatorUserId"];
    if (typeof userId !== "string") return "operator_missing";
    if (route.actorField !== undefined && body[route.actorField] !== userId) return "actor_mismatch";
    const verdict = await this.attribution.verify({
      ...scope,
      userId,
      occurredAt: String(body[route.timeField]),
    });
    return verdict.ok ? null : verdict.cause;
  }
}

/** The route's spec; a route without one fails closed (generic 401). */
function routeSpecOf(context: ExecutionContext): ShiftFactRouteSpec {
  const spec = Reflect.getMetadata(SHIFT_FACT_ROUTE_KEY, context.getHandler()) as
    | ShiftFactRouteSpec
    | undefined;
  if (spec === undefined) throw new UnauthorizedException("Unauthorized");
  return spec;
}

/** The verified cashier becomes the actor; scope stays the device's. */
function publishCashier(request: TenantContextRequest, scope: DeviceScope, userId: string): void {
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
}
