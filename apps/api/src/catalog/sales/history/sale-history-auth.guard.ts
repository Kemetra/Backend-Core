/**
 * SaleHistoryAuthGuard — the credential gate of the POS sale history
 * (Jira RT-539, RT-534 S3; contract `pos-sales/sale-history.yaml` 1.0.0-draft,
 * RT-537 D-2 / Q-2; owner decisions OD-534-1 A and OD-534-2 A).
 *
 * Two ALTERNATIVE credentials, the RT-224 captureSale model
 * (`SaleCaptureAuthGuard`), with the cashier selected by a header instead of
 * a body claim:
 *
 *   1. Envelope path: no `X-Cashier-Admission` header. The request goes to
 *      `PosOperatorEnvelopeSaleGuard` (canonical bearer auth plus the live
 *      owner / tenant_admin / store_manager re-check; the operator is the
 *      actor). The handler gives it every sale of the envelope's store.
 *
 *   2. Device path: the header is PRESENT (its presence selects this path,
 *      so an envelope that carries it fails device auth: the generic 401).
 *        a. `PosDeviceAuthGuard` resolves the bearer to an active device of
 *           an active tenant; tenant, store and device come from that row.
 *        b. The header must be a UUID (else 400). On the reprint route the
 *           strict body is parsed here too (400), for its mode and time.
 *        c. The admission is resolved BY ID inside the device's tenant, store
 *           and device; it must be live now, or for a `record` reprint cover
 *           `printedAt` under the captureSale window rules (RT-224/225), and
 *           its cashier must still be eligible (RT-113 rules, live).
 *        d. Only then is the ADMISSION's cashier published as the actor
 *           (principal scope `pos`), which the handler turns into own-sales
 *           visibility, the idempotency layer scopes the key to and the audit
 *           emitter records. The header only selects which admitted cashier
 *           is asking; the device token stays the credential.
 *
 * Refusals: a bad, revoked or missing credential on either path is the
 * generic 401. A valid device that is refused (no header, or an admission
 * that is not accepted) is the generic 403 `refused`, one body for every
 * cause: to the POS a device 401 means "device revoked". The missing-header
 * case is detected by probing device auth after the envelope's 401, so the
 * envelope path itself is unchanged. A refusal is logged once with
 * allowlisted fields and a fixed event name (never the admission id, the
 * token or the body), and on the reprint route it is audited as
 * `sale.receipt.reprinted` with outcome `refused` (OD-534-7).
 *
 * The routes carry `@DeviceBearer()`, so the global FailClosedAuthGuard
 * defers here; route-auth-markers.enforcement.spec.ts lists this guard as a
 * reviewed composite that runs PosDeviceAuthGuard.
 */
import {
  BadRequestException,
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

import { PosDeviceAuthGuard } from "../../../auth/pos-device-auth.guard";
import { PosOperatorEnvelopeSaleGuard } from "../../../auth/pos-operator-envelope-sale.guard";
import { ROOT_LOGGER } from "../../../common/logging.interceptor";
import type { TenantContextRequest } from "../../../context/types";
import type { RefusalReason } from "../../../pos-cashier-admissions/cashier-eligibility";
import { deviceScopeOf, type DeviceScope } from "../../../pos-cashier-admissions/device-scope";
import { SaleReprintRequestSchema, UUID_RE, type SaleReprintRequestDto } from "./sale-history.query";

/** The header naming the admitted cashier on the device path. */
export const CASHIER_ADMISSION_HEADER = "x-cashier-admission";

export const SALE_REPRINT_ROUTE_KEY = "dp2:sale-history:reprint-route";

/** Marks the reprint route: its body selects the admission instant and its refusals are audited. */
export const SaleReprintRoute = () => SetMetadata(SALE_REPRINT_ROUTE_KEY, true);

/** Why an admission was not accepted. A closed set, logged and never returned. */
export type AdmissionRefusal =
  | "admission_unknown"
  | "admission_not_live"
  | "admission_not_covering"
  | RefusalReason;

export type CashierAdmissionVerdict =
  | { readonly ok: true; readonly userId: string }
  | { readonly ok: false; readonly cause: AdmissionRefusal; readonly userId: string | null };

export interface CashierAdmissionInput extends DeviceScope {
  readonly admissionId: string;
  /** null: the admission must be live now. Else: its window must cover this instant (a `record`). */
  readonly checkAt: string | null;
}

export interface CashierAdmissionSelector {
  resolve(input: CashierAdmissionInput): Promise<CashierAdmissionVerdict>;
}

export const CASHIER_ADMISSION_SELECTOR = Symbol.for("api.sales.history.cashierAdmissionSelector");

export type SaleHistoryRefusalReason = AdmissionRefusal | "admission_missing";

/** A refused reprint request, for its `sale.receipt.reprinted` audit. */
export interface SaleHistoryRefusal {
  readonly scope: DeviceScope;
  /** The admission's cashier when the admission resolved in this device's scope; else null. */
  readonly actorUserId: string | null;
  readonly saleRef: string | null;
  readonly mode: SaleReprintRequestDto["mode"] | null;
  readonly kind: SaleReprintRequestDto["kind"] | null;
  readonly reason: SaleHistoryRefusalReason;
  readonly requestId: string | null;
}

export interface SaleHistoryRefusalAudit {
  recordRefusal(refusal: SaleHistoryRefusal): Promise<void>;
}

export const SALE_HISTORY_REFUSAL_AUDIT = Symbol.for("api.sales.history.refusalAudit");

type Gate = Pick<CanActivate, "canActivate">;

@Injectable()
export class SaleHistoryAuthGuard implements CanActivate {
  // Class-referenced on the routes, so reflection-instantiated: every
  // dependency is an explicit token that SalesModule provides.
  constructor(
    @Inject(PosOperatorEnvelopeSaleGuard) private readonly envelope: Gate,
    @Inject(PosDeviceAuthGuard) private readonly device: Gate,
    @Inject(CASHIER_ADMISSION_SELECTOR) private readonly admissions: CashierAdmissionSelector,
    @Inject(SALE_HISTORY_REFUSAL_AUDIT) private readonly audit: SaleHistoryRefusalAudit,
    @Optional() @Inject(ROOT_LOGGER) private readonly logger?: Pick<Logger, "warn">,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<TenantContextRequest>();
    const reprint = isReprintRoute(context);
    if (!Object.hasOwn(request.headers, CASHIER_ADMISSION_HEADER)) {
      return this.envelopeOrRefuse(context, request, reprint);
    }

    // a. The device (generic 401 on any failure), before any validation.
    await this.device.canActivate(context);
    const scope = deviceScopeOf(request);

    // b. The selector and, on the reprint route, the body (400 when malformed).
    const admissionId = admissionIdOf(request);
    const body = reprint ? SaleReprintRequestSchema.parse(request.body) : null;

    // c. The admission and its cashier.
    const verdict = await this.admissions.resolve({ ...scope, admissionId, checkAt: checkAtOf(body) });
    if (!verdict.ok) {
      return this.refuse(request, scope, { reprint, reason: verdict.cause, actorUserId: verdict.userId, body });
    }

    // d. The admission's cashier is the actor. Scope stays the device's.
    publishCashier(request, scope, verdict.userId);
    return true;
  }

  /** No header: the envelope; a valid DEVICE without the header is the 403, anything else the 401. */
  private async envelopeOrRefuse(
    context: ExecutionContext,
    request: TenantContextRequest,
    reprint: boolean,
  ): Promise<boolean> {
    try {
      return (await this.envelope.canActivate(context)) as boolean;
    } catch (err) {
      if (!(await this.isValidDeviceAfter(err, context))) throw err;
    }
    const scope = deviceScopeOf(request);
    const body = reprint ? lenientReprintBody(request) : null;
    return this.refuse(request, scope, { reprint, reason: "admission_missing", actorUserId: null, body });
  }

  /**
   * After the envelope refused: true when that refusal was the generic 401
   * AND the bearer is a valid device token. Any other envelope error, or a
   * non-401 device failure, propagates.
   */
  private async isValidDeviceAfter(envelopeError: unknown, context: ExecutionContext): Promise<boolean> {
    if (!(envelopeError instanceof UnauthorizedException)) return false;
    try {
      await this.device.canActivate(context);
      return true;
    } catch (err) {
      if (err instanceof UnauthorizedException) return false;
      throw err;
    }
  }

  /** Log (and on the reprint route audit) a refusal, then throw the generic 403. */
  private async refuse(
    request: TenantContextRequest,
    scope: DeviceScope,
    refusal: {
      readonly reprint: boolean;
      readonly reason: SaleHistoryRefusalReason;
      readonly actorUserId: string | null;
      readonly body: SaleReprintRequestDto | null;
    },
  ): Promise<never> {
    const requestId = request.requestId ?? null;
    const { mode, kind } = refusal.body ?? NO_BODY;
    this.logger?.warn(
      {
        event: `sale_history.cashier_refused.${refusal.reason}`,
        request_id: requestId,
        tenant_id: scope.tenantId,
        store_id: scope.storeId,
        status: 403,
        outcome: "failure",
      },
      "sale history: cashier admission refused",
    );
    if (refusal.reprint) {
      await this.audit.recordRefusal({
        scope,
        actorUserId: refusal.actorUserId,
        saleRef: saleRefParam(request),
        mode,
        kind,
        reason: refusal.reason,
        requestId,
      });
    }
    throw new ForbiddenException({ code: "refused", message: "Forbidden" });
  }
}

const NO_BODY = { mode: null, kind: null } as const;

function isReprintRoute(context: ExecutionContext): boolean {
  return Reflect.getMetadata(SALE_REPRINT_ROUTE_KEY, context.getHandler()) === true;
}

/** The admission instant: a `record` reprint's printedAt; otherwise null (live now). */
function checkAtOf(body: SaleReprintRequestDto | null): string | null {
  return body !== null && body.mode === "record" ? body.printedAt : null;
}

/** The reprint body for a refusal's audit when it parses; null otherwise. */
function lenientReprintBody(request: TenantContextRequest): SaleReprintRequestDto | null {
  const parsed = SaleReprintRequestSchema.safeParse(request.body);
  return parsed.success ? parsed.data : null;
}

/** The route's saleRef when it is a UUID (for the refusal audit), else null. */
function saleRefParam(request: TenantContextRequest): string | null {
  const saleRef: unknown = (request.params as Record<string, unknown> | undefined)?.["saleRef"];
  return typeof saleRef === "string" && UUID_RE.test(saleRef) ? saleRef.toLowerCase() : null;
}

/** The header's admission id, lower-cased; a value that is not one UUID is a 400. */
function admissionIdOf(request: TenantContextRequest): string {
  const raw = request.headers[CASHIER_ADMISSION_HEADER];
  if (typeof raw !== "string" || !UUID_RE.test(raw)) {
    throw new BadRequestException({ code: "validation_error", message: "X-Cashier-Admission must be a uuid" });
  }
  return raw.toLowerCase();
}

/** The admission's cashier becomes the actor; scope stays the device's. */
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
