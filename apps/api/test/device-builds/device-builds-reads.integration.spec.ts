/**
 * RT-719: the Console reads of the POS build identity over HTTP against real
 * Postgres (Testcontainers, every migration, the NOBYPASSRLS `app_test` pool)
 * and the real module graph (`TenantContextGuard`, `RolesGuard`,
 * `MembershipRepository`). Only cookie authentication is faked: a header names
 * the session (the RT-192 pattern).
 *
 *   GET /api/v1/device-builds/baseline    consoleGetFleetBaseline
 *   GET /api/v1/devices[, /{deviceId}]    `buildIdentity` on DeviceSummary / DeviceDetail
 *
 * What this proves (RT-719 acceptance):
 *   - who may read: owner / tenant_admin / store_manager inside the operator
 *     store scope; every refusal (role, other tenant, store outside the scope,
 *     absent store) is the same non-disclosing 404, never a 403; a bearer is 401;
 *   - the baseline counts the ACTIVE devices only (a revoked or retired device
 *     is not a compatibility risk), one entry per distinct identity with the
 *     oldest and latest report, an explicit unknown count that is never folded
 *     into a build, and an order independent of the database locale;
 *   - a device that never reported, or whose report was unknown, reads null:
 *     unknown is never a build, "current" or "latest";
 *   - `buildIdentity` is on the list and the detail, kept on a revoked device;
 *   - a tenant never reads another tenant's identity (RLS);
 *   - bodies validate against the contracts; a malformed query is a 400.
 *
 * Docker policy: HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1. Only one
 * request is in flight at a time (supertest on the shared server).
 */
import "reflect-metadata";

import type { Pool } from "pg";

import { DevicesModule } from "../../src/devices/devices.module";
import { schemaChecker, scopedHttpHarness } from "../_helpers/scoped-http-harness";
import {
  DEV_A1A,
  DEV_A1B,
  DEV_A2A,
  DEV_B1A,
  DEV_RETIRED,
  DEV_REVOKED,
  MANAGER_A1,
  MANAGER_A2,
  OWNER_A,
  OWNER_B,
  PLATFORM_ADMIN,
  STAFF_A,
  STORE_A1,
  STORE_A2,
  STORE_B1,
  seedDeviceHealthFixture,
} from "../device-health/__support__/device-health-fixture";

const BASELINE = "/api/v1/device-builds/baseline";
const DEVICES = "/api/v1/devices";

const h = scopedHttpHarness({
  label: "RT-719 device builds reads",
  contractId: "console-device-builds.openapi",
  module: DevicesModule,
  seed: seedDeviceHealthFixture,
});
const conformsDevices = schemaChecker("devices.openapi");

const C1 = "1111111111111111111111111111111111111111";
const C2 = "2222222222222222222222222222222222222222";
const C3 = "3333333333333333333333333333333333333333";
const P1 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

interface Identity {
  readonly commit: string | null;
  readonly version?: string | null;
  readonly pin?: string | null;
  readonly agoSeconds?: number;
}

async function report(admin: Pool, deviceId: string, identity: Identity): Promise<void> {
  await admin.query(
    `UPDATE devices SET reported_build_commit = $2, reported_app_version = $3, reported_contract_pin = $4,
            build_reported_at = CASE WHEN $2::text IS NULL THEN NULL ELSE now() - make_interval(secs => $5::int) END
      WHERE id = $1`,
    [deviceId, identity.commit, identity.version ?? null, identity.pin ?? null, identity.agoSeconds ?? 0],
  );
}

beforeEach(async () => {
  if (h.skipped()) return;
  await h.env().admin.query(
    `UPDATE devices SET reported_build_commit = NULL, reported_app_version = NULL, reported_contract_pin = NULL, build_reported_at = NULL`,
  );
});

interface Baseline {
  scope: string;
  storeRef: string | null;
  basis: string;
  generatedAt: string;
  deviceCount: number;
  reportingDeviceCount: number;
  unknownDeviceCount: number;
  installed: Array<Record<string, unknown>>;
}

async function baseline(session: string, query: Record<string, string> = {}): Promise<Baseline> {
  const res = await h.get(BASELINE, session, query).expect(200);
  h.conforms("FleetBaseline", res.body);
  expect(res.headers["cache-control"]).toBe("no-store");
  return res.body as Baseline;
}

describe("RT-719 fleet baseline: who may read", () => {
  it("answers 401 without a session and for a bearer", async () => {
    if (h.skipped()) return;
    await h.get(BASELINE, null).expect(401);
    const bearer = await h.get(BASELINE, null).set("authorization", "Bearer some-machine-token-aaaaaaaaaaaaaaaaaaa");
    expect(bearer.status).toBe(401);
  });

  it("answers the same non-disclosing 404 to a role outside the list and to a store out of scope", async () => {
    if (h.skipped()) return;
    const bodies: unknown[] = [];
    for (const [session, query] of [
      [STAFF_A.session, {}],
      [MANAGER_A1.session, { store_id: STORE_A2 }],
      [OWNER_A.session, { store_id: STORE_B1 }],
      [OWNER_A.session, { store_id: "03270000-0000-4000-8000-00000000ffff" }],
    ] as const) {
      const res = await h.get(BASELINE, session, query);
      expect(res.status).toBe(404);
      h.conforms("Error", res.body);
      const { request_id: _id, ...rest } = (res.body as { error: Record<string, unknown> }).error;
      bodies.push(rest);
    }
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
  });

  it("refuses a platform admin with no active tenant (a tenant surface)", async () => {
    if (h.skipped()) return;
    expect((await h.get(BASELINE, PLATFORM_ADMIN.session)).status).toBe(401);
  });

  it("scopes a store_manager to its stores", async () => {
    if (h.skipped()) return;
    expect((await baseline(MANAGER_A1.session)).deviceCount).toBe(2);
    expect((await baseline(MANAGER_A2.session)).deviceCount).toBe(1);
  });

  it("never crosses tenants", async () => {
    if (h.skipped()) return;
    const admin = h.env().admin;
    await report(admin, DEV_B1A.id, { commit: C3, version: "9.9.9" });
    await report(admin, DEV_A1A.id, { commit: C1 });
    const mine = await baseline(OWNER_A.session);
    expect(mine.installed.map((e) => e["buildId"])).toEqual([C1]);
    const theirs = await baseline(OWNER_B.session);
    expect(theirs).toMatchObject({ deviceCount: 1, reportingDeviceCount: 1, unknownDeviceCount: 0 });
    expect(theirs.installed.map((e) => e["buildId"])).toEqual([C3]);
  });
});

describe("RT-719 fleet baseline: the counts", () => {
  it("counts every active device as unknown when none has reported, never as zero builds", async () => {
    if (h.skipped()) return;
    const body = await baseline(OWNER_A.session);
    expect(body).toMatchObject({
      scope: "all_in_scope",
      storeRef: null,
      basis: "terminal_reported",
      // Active only: the revoked and the retired device are not counted.
      deviceCount: 3,
      reportingDeviceCount: 0,
      unknownDeviceCount: 3,
      installed: [],
    });
    expect(Number.isNaN(Date.parse(body.generatedAt))).toBe(false);
  });

  it("groups distinct identities, bounds each by its oldest and latest report, and excludes revoked and retired devices", async () => {
    if (h.skipped()) return;
    const admin = h.env().admin;
    await report(admin, DEV_A1A.id, { commit: C1, version: "1.4.0", pin: P1, agoSeconds: 600 });
    await report(admin, DEV_A1B.id, { commit: C1, version: "1.4.0", pin: P1, agoSeconds: 60 });
    await report(admin, DEV_A2A.id, { commit: C2 });
    await report(admin, DEV_REVOKED.id, { commit: C3, version: "0.1.0" });
    await report(admin, DEV_RETIRED.id, { commit: C3 });
    const body = await baseline(OWNER_A.session);
    expect(body).toMatchObject({ deviceCount: 3, reportingDeviceCount: 3, unknownDeviceCount: 0 });
    expect(body.installed).toHaveLength(2);
    expect(body.installed[0]).toMatchObject({ kind: "release", posVersion: "1.4.0", buildId: C1, contractPinCommit: P1, deviceCount: 2 });
    expect(body.installed[1]).toMatchObject({ kind: "build", posVersion: null, buildId: C2, contractPinCommit: null, deviceCount: 1 });
    const entry = body.installed[0] as { oldestReportedAt: string; latestReportedAt: string };
    expect(Date.parse(entry.latestReportedAt) - Date.parse(entry.oldestReportedAt)).toBeGreaterThan(500_000);
    expect(JSON.stringify(body)).not.toContain(C3);
  });

  it("counts a device whose report was unknown (cleared) as unknown, and never folds it into a build", async () => {
    if (h.skipped()) return;
    const admin = h.env().admin;
    await report(admin, DEV_A1A.id, { commit: C1 });
    await report(admin, DEV_A1B.id, { commit: null });
    const body = await baseline(OWNER_A.session);
    expect(body).toMatchObject({ deviceCount: 3, reportingDeviceCount: 1, unknownDeviceCount: 2 });
    expect(body.installed).toHaveLength(1);
  });

  it("narrows to one store, with the store reference in lower case", async () => {
    if (h.skipped()) return;
    const admin = h.env().admin;
    await report(admin, DEV_A1A.id, { commit: C1 });
    await report(admin, DEV_A2A.id, { commit: C2 });
    const body = await baseline(OWNER_A.session, { store_id: STORE_A2.toUpperCase() });
    expect(body).toMatchObject({ scope: "store", storeRef: STORE_A2, deviceCount: 1, reportingDeviceCount: 1, unknownDeviceCount: 0 });
    expect(body.installed.map((e) => e["buildId"])).toEqual([C2]);
  });

  it("orders by commit, version and pin in plain code-unit order, nulls last", async () => {
    if (h.skipped()) return;
    const admin = h.env().admin;
    await report(admin, DEV_A1A.id, { commit: C1 });
    await report(admin, DEV_A1B.id, { commit: C1, version: "1.9.0" });
    await report(admin, DEV_A2A.id, { commit: C1, version: "1.10.0" });
    const body = await baseline(OWNER_A.session);
    expect(body.installed.map((e) => e["posVersion"])).toEqual(["1.10.0", "1.9.0", null]);
  });

  it("refuses a malformed, repeated or unknown query value with a 400 before any read", async () => {
    if (h.skipped()) return;
    for (const query of [{ store_id: "not-a-uuid" }, { unknown: "x" }, { store_id: [STORE_A1, STORE_A2] }]) {
      const res = await h.get(BASELINE, OWNER_A.session, query as unknown as Record<string, string>);
      expect({ query, status: res.status }).toEqual({ query, status: 400 });
      h.conforms("Error", res.body);
    }
  });
});

describe("RT-719 buildIdentity on the devices reads", () => {
  it("is null for a device that never reported and the identity for one that did, on the list and the detail", async () => {
    if (h.skipped()) return;
    const admin = h.env().admin;
    await report(admin, DEV_A1A.id, { commit: C1, version: "1.4.0-rc.1", pin: P1 });
    const list = await h.get(DEVICES, OWNER_A.session, { page_size: 200 }).expect(200);
    conformsDevices("DevicePage", list.body);
    const items = new Map((list.body as { items: Array<Record<string, unknown>> }).items.map((i) => [i["deviceId"], i] as const));
    expect(items.get(DEV_A1A.id)?.["buildIdentity"]).toMatchObject({ buildCommit: C1, appVersion: "1.4.0-rc.1", contractPinCommit: P1 });
    expect(Number.isNaN(Date.parse((items.get(DEV_A1A.id)?.["buildIdentity"] as { reportedAt: string }).reportedAt))).toBe(false);
    expect(items.get(DEV_A1B.id)?.["buildIdentity"]).toBeNull();
    const detail = await h.get(`${DEVICES}/${DEV_A1A.id}`, OWNER_A.session).expect(200);
    conformsDevices("DeviceDetail", detail.body);
    expect((detail.body as Record<string, unknown>)["buildIdentity"]).toEqual(items.get(DEV_A1A.id)?.["buildIdentity"]);
  });

  it("keeps the identity readable on a revoked device without changing its trust state or last seen", async () => {
    if (h.skipped()) return;
    await report(h.env().admin, DEV_REVOKED.id, { commit: C3, version: "0.9.0" });
    const detail = await h.get(`${DEVICES}/${DEV_REVOKED.id}`, OWNER_A.session).expect(200);
    conformsDevices("DeviceDetail", detail.body);
    expect(detail.body).toMatchObject({ trustState: "revoked", buildIdentity: { buildCommit: C3, appVersion: "0.9.0" } });
  });

  it("never reads another tenant's identity", async () => {
    if (h.skipped()) return;
    await report(h.env().admin, DEV_B1A.id, { commit: C3 });
    const res = await h.get(`${DEVICES}/${DEV_B1A.id}`, OWNER_A.session);
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain(C3);
  });
});
