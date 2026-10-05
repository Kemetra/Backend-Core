/**
 * PosDeviceAuthGuard — device-principal authentication for the POS routes a
 * paired terminal calls with its device token alone: the 010 read-down
 * catalogue routes (issue #488, Option B-prime), since RT-113 BC2 the
 * cashier-admissions routes, and since RT-224 one composite: captureSale.
 *
 * Why this exists
 * ---------------
 * The read-down snapshot/delta API (`/api/pos/v1/catalog/snapshot|deltas`)
 * must authenticate a POS terminal by its `devices` PAIRING TOKEN alone — with
 * NO operator session — because POS-Pulse triggers the read-down as a
 * paired-terminal background sync (no cashier signed in). The shared
 * `PosOperatorAuthGuard` requires `scope === "pos_operator"`, a credential that
 * only exists AFTER an operator sign-in; it correctly rejects a bare device
 * principal. Rather than broaden that guard (it also protects `posCaptureItem`
 * and the 008 sales routes — 002 FR-POS-AUTH-4/5), this is a SEPARATE guard
 * scoped to the read-down routes only.
 *
 * What it does
 * ------------
 * 1. Reads the device pairing token from `Authorization: Bearer <token>` (the
 *    same transport `AuthGuard` uses; the backend has no `X-Terminal-Token`
 *    seam — POS sends the device token in the Authorization header for this
 *    read-only surface).
 * 2. Resolves it via `DeviceRepository.findActiveByAttestation` — a stateless
 *    SHA-256 hash → UNIQUE-index probe on `devices.token_hash`, returning the
 *    store-bound `DeviceRow` iff `revoked_at IS NULL` AND the device's tenant
 *    is active (`status = 'active'`, `deleted_at IS NULL`; RT-213). It is the
 *    same lookup POS operator sign-in uses; it needs no established tenant
 *    context.
 * 3. On success, publishes a device principal context onto `request.context`:
 *    `(tenant_id, store_id)` come from the device ROW — the authority — never
 *    from the request body/query (FR-002) — and the device id onto
 *    `request.posDeviceId`. The read-down controller's existing
 *    `store_context_required` / non-disclosing `branch_id`-mismatch logic then
 *    runs unchanged.
 *
 * Failure posture (FR-001, non-disclosing)
 * ----------------------------------------
 * Missing/malformed Authorization header, an unknown/revoked device token, a
 * device of a suspended, pending or soft-deleted tenant (RT-213), or any
 * non-device credential (a dashboard cookie session, a non-Bearer scheme)
 * all collapse to the SAME generic `UnauthorizedException` (401) — no signal
 * about why. Dashboard cookies are ignored entirely: this guard only ever
 * trusts a Bearer device token.
 *
 * Where it may be used (widened deliberately by RT-113 BC2)
 * -----------------------------------------------------------
 * ONLY on routes whose contract declares the role-named `device` security
 * scheme and nothing else, marked `@DeviceBearer()`:
 *
 *   - the 010 read-down routes (`/api/pos/v1/catalog/snapshot|deltas`);
 *   - the RT-113 cashier-admissions routes (`/api/pos/v1/cashier-admissions`,
 *     `…/{admission_id}/end`, `…/roster`; Jira RT-113 comments 10763 D2/D11,
 *     10826, `[GATED]` approval 10832).
 *
 * Why the cashier routes need it: a cashier signs in with a PIN verified on
 * the terminal and holds no provider JWT, so the cashier path cannot use the
 * operator-identity routes (RT-150, RT-182). The device is the only
 * credential there, and its row is the only source of tenant and store.
 *
 * The one reviewed composite (RT-224 Option B; [GATED] approval Jira RT-224
 * comment 10889): `captureSale` (`POST /api/pos/v1/sales`) declares `device`
 * as an ALTERNATIVE to `operatorAuthorization`. There this guard never runs
 * alone: `SaleCaptureAuthGuard` runs it only when the body carries
 * `operatorUserId`, and then requires the attribution verifier to accept that
 * cashier claim (a covering cashier admission of this device and store, plus
 * the live cashier eligibility rules) before any actor is published. The
 * device token alone never authors a sale. This guard's own failures stay the
 * generic 401; a refused claim is the composite's generic 403 `refused`.
 *
 * Do NOT register it globally, and do NOT use it on operator routes
 * (`/api/pos/v1/operators/*`) or on any route that needs a person's
 * credential: it proves only which paired terminal is calling. Any other use
 * next to a person's claim needs its own reviewed composite.
 * `route-auth-markers.enforcement.spec.ts` pins the list of routes using it
 * and the composites that run it.
 */
import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";

import { DeviceRepository } from "../pos-operators/device.repository";
import type { Principal } from "./auth.guard";
import type { ResolvedContext, TenantContextRequest } from "../context/types";

const BEARER_PREFIX = "bearer ";

@Injectable()
export class PosDeviceAuthGuard implements CanActivate {
  constructor(private readonly devices: DeviceRepository) {}

  async canActivate(execCtx: ExecutionContext): Promise<boolean> {
    const request = execCtx.switchToHttp().getRequest<TenantContextRequest>();

    const rawToken = readBearerToken(request);
    if (rawToken === null) throw unauthorized();

    const device = await this.devices.findActiveByAttestation(rawToken);
    if (!device) throw unauthorized();

    // Publish a device PRINCIPAL (mirrors the `pos`-scope token principal
    // shape) so the global AuditEmitterInterceptor records a faithful
    // read-access actor (FR-080): there is NO operator user on a background
    // device read-down, so `userId` is null (a person did not act — the
    // terminal did); the device IS the token, so `tokenId` is the device id.
    const principal: Principal = {
      kind: "token",
      tokenId: device.id,
      tenantId: device.tenantId,
      userId: null,
      storeId: device.storeId,
      scope: "pos",
    };
    request.principal = principal;

    // Scope is taken from the authenticated device ROW only (FR-002). The
    // device principal carries no operator identity, so userId is null.
    const context: ResolvedContext = {
      userId: null,
      tenantId: device.tenantId,
      storeId: device.storeId,
      isPlatformAdmin: false,
      source: "token",
    };
    request.context = context;
    // The authenticated device itself, for routes that act per device (the
    // RT-113 cashier admissions: admission ownership, the idempotency scope,
    // the takeover rate limit). Never taken from the request.
    request.posDeviceId = device.id;
    return true;
  }
}

/**
 * Extract the raw bearer token from the `Authorization` header. Mirrors
 * `auth.guard.ts`'s `readBearerToken` (case-insensitive prefix, trimmed,
 * non-empty) so the device token is accepted exactly as other bearers are.
 * Returns null for a missing, non-Bearer, or empty header.
 */
function readBearerToken(request: TenantContextRequest): string | null {
  const header = request.headers["authorization"];
  if (typeof header !== "string") return null;
  if (header.length < BEARER_PREFIX.length) return null;
  if (header.slice(0, BEARER_PREFIX.length).toLowerCase() !== BEARER_PREFIX) {
    return null;
  }
  const raw = header.slice(BEARER_PREFIX.length).trim();
  return raw.length > 0 ? raw : null;
}

function unauthorized(): UnauthorizedException {
  return new UnauthorizedException("Unauthorized");
}
