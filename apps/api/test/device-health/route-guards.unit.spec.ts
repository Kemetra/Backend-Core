/**
 * RT-327: the guard chain of each controller, in order. The integration specs
 * fake the cookie guard with a session header, which also skips the real
 * `SessionOnlyAdminGuard` (a human cookie only, any bearer is 401, and an
 * unsafe cookie request needs a trusted `Origin`, RT-430). This pins that each
 * route still declares it, and the guards behind it, in the contract's order.
 */
import "reflect-metadata";

import { PlatformAdminGuard } from "../../src/audit/platform-admin.guard";
import { PosDeviceAuthGuard } from "../../src/auth/pos-device-auth.guard";
import { RolesGuard } from "../../src/auth/roles.guard";
import { ROLES_METADATA_KEY } from "../../src/auth/roles.decorator";
import { DEVICE_BEARER_KEY } from "../../src/auth/route-auth";
import { SessionOnlyAdminGuard } from "../../src/auth/session-only-admin.guard";
import { TenantContextGuard } from "../../src/context/tenant-context.guard";
import { DeviceHealthController } from "../../src/device-health/device-health.controller";
import { DeviceHeartbeatController } from "../../src/device-health/heartbeat.controller";
import { PosVersionPolicyController } from "../../src/device-health/version-policy.controller";

const guardsOf = (target: object): unknown[] => (Reflect.getMetadata("__guards__", target) ?? []) as unknown[];

describe("RT-327 guard chains", () => {
  it("authenticates the heartbeat with the device bearer only", () => {
    expect(guardsOf(DeviceHeartbeatController)).toEqual([PosDeviceAuthGuard]);
    expect(Reflect.getMetadata(DEVICE_BEARER_KEY, DeviceHeartbeatController)).toBe(true);
  });

  it("puts the console reads behind a human session, the tenant context and the roles", () => {
    expect(guardsOf(DeviceHealthController)).toEqual([SessionOnlyAdminGuard, TenantContextGuard]);
    for (const route of ["list", "get"] as const) {
      const handler = DeviceHealthController.prototype[route];
      expect(guardsOf(handler)).toEqual([RolesGuard]);
      // Default deny is a 404, never a 403 (the contract).
      expect(Reflect.getMetadata(ROLES_METADATA_KEY, handler)).toMatchObject({
        any: ["owner", "tenant_admin", "store_manager"],
        platformAdminOnly: false,
        denyAs: 404,
      });
    }
  });

  it("puts the platform policy behind a human session and a platform admin, never the tenant context", () => {
    expect(guardsOf(PosVersionPolicyController)).toEqual([SessionOnlyAdminGuard, PlatformAdminGuard]);
    expect(guardsOf(PosVersionPolicyController)).not.toContain(TenantContextGuard);
    for (const route of ["list", "set"] as const) expect(guardsOf(PosVersionPolicyController.prototype[route])).toEqual([]);
  });
});
