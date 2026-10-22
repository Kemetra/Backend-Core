/**
 * RT-719: `consoleGetFleetBaseline` is audited as `devices.fleet_baseline_read`,
 * once per authorised 200, with the scope mode, the `store_id` (null for all in
 * scope) and the entry count, never a commit, version or any other value of the
 * identity (`console-device-builds.openapi.yaml`, "Audit"). `@Auditable` makes
 * the interceptor emit on a successful handler only, so a refusal (400 / 401 /
 * 404 / 429) is never audited.
 */
import "reflect-metadata";

import { NotFoundException } from "@nestjs/common";

import { AUDITABLE_KEY, type AuditAnnotatedRequest } from "../../src/audit/auditable.decorator";
import { kindOf } from "../../src/audit/audit-action-kinds";
import { DeviceBuildsController } from "../../src/devices/device-builds.controller";
import type { FleetBaseline } from "../../src/devices/device-builds.projections";
import type { DeviceBuildsService } from "../../src/devices/device-builds.service";
import { DeviceStoreNotInScopeError } from "../../src/devices/devices.service";
import type { TenantContextRequest } from "../../src/context/types";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const STORE = "07190000-0000-4000-8000-0000000a5001";

const BASELINE: FleetBaseline = {
  scope: "store",
  storeRef: STORE,
  basis: "terminal_reported",
  generatedAt: "2026-10-22T12:00:00.000Z",
  deviceCount: 2,
  reportingDeviceCount: 2,
  unknownDeviceCount: 0,
  installed: [
    {
      kind: "release",
      posVersion: "1.4.0",
      buildId: COMMIT,
      contractPinCommit: COMMIT,
      deviceCount: 2,
      oldestReportedAt: "2026-10-22T10:00:00.000Z",
      latestReportedAt: "2026-10-22T11:00:00.000Z",
    },
  ],
};

function request(): TenantContextRequest & AuditAnnotatedRequest {
  return {
    context: { userId: "u", tenantId: "07190000-0000-4000-8000-0000000a0001", storeId: null, isPlatformAdmin: false, source: "session" },
  } as unknown as TenantContextRequest & AuditAnnotatedRequest;
}

const handler = DeviceBuildsController.prototype.baseline;

describe("consoleGetFleetBaseline audit", () => {
  it("is the registered read action devices.fleet_baseline_read", () => {
    expect(Reflect.getMetadata(AUDITABLE_KEY, handler)).toBe("devices.fleet_baseline_read");
    expect(kindOf("devices.fleet_baseline_read")).toBe("read");
  });

  it("annotates the scope, the store and the entry count, and no value of the identity", async () => {
    const service = { baseline: jest.fn().mockResolvedValue(BASELINE) } as unknown as DeviceBuildsService;
    const req = request();
    const body = await new DeviceBuildsController(service).baseline(req, { store_id: STORE });
    expect(body).toBe(BASELINE);
    expect(req.auditMetadata).toEqual({ scope: "store", store_id: STORE, entries: 1 });
    expect(JSON.stringify(req.auditMetadata)).not.toContain(COMMIT);
    expect(JSON.stringify(req.auditMetadata)).not.toContain("1.4.0");
  });

  it("annotates a null store for the all-in-scope read", async () => {
    const service = { baseline: jest.fn().mockResolvedValue({ ...BASELINE, scope: "all_in_scope", storeRef: null, installed: [] }) } as unknown as DeviceBuildsService;
    const req = request();
    await new DeviceBuildsController(service).baseline(req, {});
    expect(req.auditMetadata).toEqual({ scope: "all_in_scope", store_id: null, entries: 0 });
  });

  it("annotates nothing on a refusal: a store out of scope is the non-disclosing 404", async () => {
    const service = { baseline: jest.fn().mockRejectedValue(new DeviceStoreNotInScopeError()) } as unknown as DeviceBuildsService;
    const req = request();
    await expect(new DeviceBuildsController(service).baseline(req, { store_id: STORE })).rejects.toBeInstanceOf(NotFoundException);
    expect(req.auditMetadata).toBeUndefined();
  });
});
