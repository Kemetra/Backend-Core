/**
 * DeviceRotationAuthGuard — RT-369: device authentication for
 * `posRotateTerminalToken` (POST /api/pos/v1/terminals/rotate) only.
 *
 * Why not PosDeviceAuthGuard: rotation has its own credential rules
 * (pos-terminal-pairing.openapi.yaml, "Credential rotation"). It accepts an
 * EXPIRED but unrevoked device for 7 days after `expires_at` (the rotate-only
 * grace), and it must tell an unknown token from a known one it refuses, to
 * write `pos.device.rotation_rejected`. PosDeviceAuthGuard ignores expiry and
 * answers every refusal alike, which is right for every other device route.
 *
 * What it does, before the idempotency interceptor (so 401 precedes 400 /
 * 409):
 *   1. reads `Authorization: Bearer <device_token>` (cookies are ignored);
 *   2. resolves the device whose current or previous hash matches
 *      (`DeviceRepository.findForRotation`, lookup pool, tenant active);
 *   3. classifies it with `decideRotation` (retired, revoked, superseded,
 *      grace elapsed, else allowed);
 *   4. refused with a known device → `pos.device.rotation_rejected`, then the
 *      generic 401; unknown token, inactive tenant, no bearer → the generic
 *      401 with no audit row (no tenant to record under);
 *   5. allowed → publishes the device principal and scope exactly as
 *      PosDeviceAuthGuard does (tenant, store and device from the ROW), plus
 *      the presented hash for the service's locked re-check.
 *
 * Every 401 is the same body (non-disclosing; RT-138 L6). The raw token is
 * never stored on the request, logged or audited; only its SHA-256 is kept.
 *
 * Reviewed composite: `route-auth-markers.enforcement.spec.ts` lists it next
 * to the guards that run PosDeviceAuthGuard. Use it on the rotate route only.
 */
import { type CanActivate, type ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { hashToken } from "@data-pulse-2/auth";

import type { Principal } from "../auth/auth.guard";
import { readBearerHeader } from "../auth/route-auth";
import type { ResolvedContext, TenantContextRequest } from "../context/types";
import { DeviceRepository } from "../pos-operators/device.repository";
import { decideRotation } from "./rotation-decision";
import { RotationService } from "./rotation.service";

/** The rotate route's request: the hash of the bearer that authenticated. */
export type RotationRequest = TenantContextRequest & { rotationPresentedHash?: Buffer };

@Injectable()
export class DeviceRotationAuthGuard implements CanActivate {
  constructor(
    private readonly devices: DeviceRepository,
    private readonly rotation: RotationService,
  ) {}

  async canActivate(execCtx: ExecutionContext): Promise<boolean> {
    const request = execCtx.switchToHttp().getRequest<RotationRequest>();
    const header = request.headers["authorization"];
    const rawToken = readBearerHeader(typeof header === "string" ? header : undefined);
    if (rawToken === null) throw unauthorized();

    const device = await this.devices.findForRotation(rawToken);
    if (device === null) throw unauthorized();

    const presentedHash = hashToken(rawToken);
    const target = { tenantId: device.tenantId, storeId: device.storeId, deviceId: device.id };
    const decision = decideRotation(device.state, presentedHash);
    if (decision.kind === "rejected") {
      await this.rotation.recordRejection(target, decision.reason);
      throw unauthorized();
    }

    const principal: Principal = {
      kind: "token",
      tokenId: device.id,
      tenantId: device.tenantId,
      userId: null,
      storeId: device.storeId,
      scope: "pos",
    };
    request.principal = principal;
    const context: ResolvedContext = {
      userId: null,
      tenantId: device.tenantId,
      storeId: device.storeId,
      isPlatformAdmin: false,
      source: "token",
    };
    request.context = context;
    request.posDeviceId = device.id;
    request.rotationPresentedHash = presentedHash;
    return true;
  }
}

function unauthorized(): UnauthorizedException {
  return new UnauthorizedException("Unauthorized");
}
