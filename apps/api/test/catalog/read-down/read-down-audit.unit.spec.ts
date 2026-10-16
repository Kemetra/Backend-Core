/**
 * RT-365 (RT-138 L8): the read-down audits carry the reading device. The
 * `catalog.snapshot.read` / `catalog.deltas.read` rows are emitted by the
 * global AuditEmitterInterceptor from `request.auditMetadata`; the device
 * principal has no user, so without `device_id` the row cannot say which till
 * read the catalogue.
 */
import { ReadDownController } from "../../../src/catalog/read-down/read-down.controller";
import type { ReadDownService } from "../../../src/catalog/read-down/read-down.service";
import type { TenantContextRequest } from "../../../src/context/types";

const TENANT = "0a000000-0000-7000-8000-000003650001";
const STORE = "0a000000-0000-7000-8000-000003650002";
const DEVICE = "0a000000-0000-7000-8000-000003650003";

function deviceRequest(): TenantContextRequest {
  return {
    context: { userId: null, tenantId: TENANT, storeId: STORE, isPlatformAdmin: false, source: "token" },
    posDeviceId: DEVICE,
    headers: {},
  } as unknown as TenantContextRequest;
}

const page = { items: [] };
const service = {
  getSnapshot: jest.fn().mockResolvedValue(page),
  getDeltas: jest.fn().mockResolvedValue({ kind: "page", page }),
} as unknown as ReadDownService;

describe("read-down audits carry device_id (RT-138 L8)", () => {
  const controller = new ReadDownController(service);

  it("annotates a snapshot read with the device", async () => {
    const req = deviceRequest();
    await controller.getSnapshot(req, undefined, undefined, undefined);
    expect((req as { auditMetadata?: unknown }).auditMetadata).toEqual({ device_id: DEVICE });
  });

  it("annotates a delta read with the device", async () => {
    const req = deviceRequest();
    await controller.getDeltas(req, "c2luY2U", undefined, undefined);
    expect((req as { auditMetadata?: unknown }).auditMetadata).toEqual({ device_id: DEVICE });
  });
});
