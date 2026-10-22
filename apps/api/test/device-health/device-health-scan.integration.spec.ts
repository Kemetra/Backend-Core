/**
 * RT-327: the derived-filter scan of `consoleListDeviceHealth` is bounded.
 *
 * `liveness` and `compliance` are derived in code, so a filtered list reads
 * batches of devices. One request must not read a tenant's whole fleet when
 * the filter is selective: after `maxScanned` devices it stops and returns a
 * cursor at the last SCANNED device (the page may be short or empty), and the
 * client resumes from it. This drives the service directly with small limits
 * so the multi-batch and the capped paths both run on real Postgres.
 *
 * Docker policy: HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import "reflect-metadata";

import type { Pool } from "pg";

import { MembershipRepository } from "../../src/context/membership.repository";
import type { ResolvedContext } from "../../src/context/types";
import { DeviceHealthService } from "../../src/device-health/device-health.service";
import { DeviceHealthModule } from "../../src/device-health/device-health.module";
import { scopedHttpHarness } from "../_helpers/scoped-http-harness";
import {
  DEV_A1A,
  DEV_A1B,
  DEV_A2A,
  DEV_REVOKED,
  OWNER_A,
  TENANT_A,
  seedDeviceHealthFixture,
} from "./__support__/device-health-fixture";

const h = scopedHttpHarness({
  label: "RT-327 device health scan",
  contractId: "pos-device-health.openapi",
  module: DeviceHealthModule,
  seed: seedDeviceHealthFixture,
});

const CONTEXT: ResolvedContext = {
  userId: OWNER_A.id,
  tenantId: TENANT_A,
  storeId: null,
  isPlatformAdmin: false,
  source: "session",
  storeAccess: { kind: "all" },
};

function service(limits?: { batchSize: number; maxScanned: number }): DeviceHealthService {
  const pool: Pool = h.env().app;
  return new DeviceHealthService(pool, new MembershipRepository(pool), limits);
}

/** Every page of a walk: its device ids and whether it came back with a cursor. */
async function pages(svc: DeviceHealthService, filter: { liveness?: "online" | "unknown" }, limit = 50) {
  const out: Array<{ ids: string[]; hasCursor: boolean }> = [];
  let cursor: string | null = null;
  for (let n = 1; n <= 20; n += 1) {
    const page: { items: Array<{ deviceId: string }>; nextCursor: string | null } = await svc.list({
      tenantId: TENANT_A,
      context: CONTEXT,
      ...filter,
      cursor,
      limit,
    });
    out.push({ ids: page.items.map((i) => i.deviceId), hasCursor: page.nextCursor !== null });
    cursor = page.nextCursor;
    if (cursor === null) return out;
  }
  throw new Error("walk did not end");
}

beforeEach(async () => {
  if (h.skipped()) return;
  const admin = h.env().admin;
  await admin.query(`DELETE FROM device_health`);
  // Only the last device in id order is online: a selective filter.
  await admin.query(`INSERT INTO device_health (device_id, tenant_id, last_seen_at) VALUES ($1, $2, now() - interval '1 minute')`, [DEV_REVOKED.id, TENANT_A]);
});

describe("RT-327 device health list: the bounded derived-filter scan", () => {
  it("finds a match past several batches in one request when the cap allows it", async () => {
    if (h.skipped()) return;
    const result = await pages(service({ batchSize: 1, maxScanned: 100 }), { liveness: "online" });
    expect(result).toEqual([{ ids: [DEV_REVOKED.id], hasCursor: false }]);
  });

  it("stops at the cap with a short page and a cursor at the last scanned device, then resumes", async () => {
    if (h.skipped()) return;
    const result = await pages(service({ batchSize: 1, maxScanned: 2 }), { liveness: "online" });
    // 4 devices in scope, 2 scanned per request: the first request scans A1A and A1B, matches nothing.
    expect(result[0]).toEqual({ ids: [], hasCursor: true });
    expect(result.flatMap((p) => p.ids)).toEqual([DEV_REVOKED.id]);
    expect(result.length).toBeGreaterThanOrEqual(2);
    expect(result.at(-1)?.hasCursor).toBe(false);
  });

  it("never skips or repeats a device across capped pages", async () => {
    if (h.skipped()) return;
    const result = await pages(service({ batchSize: 1, maxScanned: 1 }), { liveness: "unknown" });
    expect(result.flatMap((p) => p.ids)).toEqual([DEV_A1A.id, DEV_A1B.id, DEV_A2A.id]);
  });

  it("does not cap an unfiltered list: the page is read in one statement", async () => {
    if (h.skipped()) return;
    const result = await pages(service({ batchSize: 1, maxScanned: 1 }), {}, 50);
    expect(result).toEqual([{ ids: [DEV_A1A.id, DEV_A1B.id, DEV_A2A.id, DEV_REVOKED.id], hasCursor: false }]);
  });
});
