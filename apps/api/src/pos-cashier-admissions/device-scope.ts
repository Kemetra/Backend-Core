/**
 * The authenticated device's scope (RT-113 BC2).
 *
 * `PosDeviceAuthGuard` resolves the bearer to a non-revoked `devices` row and
 * publishes `req.posDeviceId` plus `req.context` (tenant, store) taken from
 * that row. This is the ONLY source of tenant, store and device for the
 * cashier-admissions routes: no request field carries scope (Constitution
 * §II, §XII).
 */
import { UnauthorizedException } from "@nestjs/common";

import type { TenantContextRequest } from "../context/types";

export interface DeviceScope {
  readonly deviceId: string;
  readonly tenantId: string;
  readonly storeId: string;
}

/** Fail closed (generic 401) if the guard did not publish a full device scope. */
export function deviceScopeOf(request: TenantContextRequest): DeviceScope {
  const deviceId = request.posDeviceId;
  const tenantId = request.context?.tenantId;
  const storeId = request.context?.storeId;
  if (!deviceId || !tenantId || !storeId) {
    throw new UnauthorizedException("Unauthorized");
  }
  return { deviceId, tenantId, storeId };
}
