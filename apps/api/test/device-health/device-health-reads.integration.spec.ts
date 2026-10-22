/**
 * RT-327: the Console device health reads over HTTP against real Postgres
 * (Testcontainers, every migration, the NOBYPASSRLS `app_test` pool) and the
 * real module graph (`TenantContextGuard`, `RolesGuard`,
 * `MembershipRepository`). Only cookie authentication is faked: a header names
 * the session (the RT-192 pattern).
 *
 *   GET /api/v1/device-health                 consoleListDeviceHealth
 *   GET /api/v1/device-health/{deviceId}      consoleGetDeviceHealth
 *
 * What this proves (RT-327 acceptance):
 *   - who may read: owner / tenant_admin / store_manager of the session's
 *     tenant, inside the operator store scope; every refusal (role, other
 *     tenant, store outside the scope, absent id) is the same non-disclosing
 *     404, never a 403; a bearer is 401;
 *   - one row per device, including devices that never sent a heartbeat
 *     (liveness `unknown`, compliance `unknown`);
 *   - liveness is derived at read from the heartbeat clock only, compliance
 *     against the CURRENT policy, and both filters match the derived values;
 *   - D-5: `lastSeenAt` is the more recent of the heartbeat and the activity
 *     clock, labelled, and never drives liveness;
 *   - keyset paging by device id, with and without a derived filter; a foreign
 *     cursor is a 400;
 *   - reads write nothing and audit nothing; every body validates against the
 *     contract.
 *
 * Docker policy: HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import "reflect-metadata";

import type { Pool } from "pg";

import { DeviceHealthModule } from "../../src/device-health/device-health.module";
import { scopedHttpHarness } from "../_helpers/scoped-http-harness";
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
  TENANT_A_DEFAULT_ORDER,
  seedDeviceHealthFixture,
  setPolicy,
} from "./__support__/device-health-fixture";

const LIST = "/api/v1/device-health";
const one = (deviceId: string): string => `${LIST}/${deviceId}`;

const h = scopedHttpHarness({
  label: "RT-327 device health reads",
  contractId: "pos-device-health.openapi",
  module: DeviceHealthModule,
  seed: seedDeviceHealthFixture,
});

interface Beat {
  readonly deviceId: string;
  readonly tenantId: string;
  readonly agoSeconds: number;
  readonly appVersion?: string | null;
  readonly channel?: string | null;
  readonly state?: string | null;
}

async function putBeat(admin: Pool, beat: Beat): Promise<void> {
  await admin.query(
    `INSERT INTO device_health (device_id, tenant_id, last_seen_at, app_version, update_channel, update_state, source_clock_at)
     VALUES ($1, $2, now() - make_interval(secs => $3::int), $4, $5, $6, now() - interval '1 day')`,
    [beat.deviceId, beat.tenantId, beat.agoSeconds, beat.appVersion ?? null, beat.channel ?? null, beat.state ?? null],
  );
}

const TENANT_A_ID = "03270000-0000-4000-8000-0a0100000001";

async function reset(admin: Pool): Promise<void> {
  await admin.query(`DELETE FROM device_health`);
  await admin.query(`DELETE FROM pos_version_policy`);
  await admin.query(`UPDATE devices SET last_seen_at = NULL`);
}

type Item = Record<string, unknown> & { deviceId: string };

async function page(session: string, query: Record<string, string | number> = {}): Promise<{ items: Item[]; nextCursor: string | null }> {
  const res = await h.get(LIST, session, query).expect(200);
  h.conforms("DeviceHealthPage", res.body);
  return res.body as { items: Item[]; nextCursor: string | null };
}

async function ids(session: string, query: Record<string, string | number> = {}): Promise<string[]> {
  const body = await page(session, { page_size: 200, ...query });
  expect(body.nextCursor).toBeNull();
  return body.items.map((i) => i.deviceId);
}

async function walk(session: string, pageSize: number, query: Record<string, string | number> = {}): Promise<string[]> {
  const seen: string[] = [];
  let cursor: string | null = null;
  for (let pages = 1; pages <= 50; pages += 1) {
    const body = await page(session, { page_size: pageSize, ...query, ...(cursor ? { cursor } : {}) });
    seen.push(...body.items.map((i) => i.deviceId));
    cursor = body.nextCursor;
    if (cursor === null) return seen;
  }
  throw new Error("walk did not end");
}

beforeEach(async () => {
  if (h.skipped()) return;
  await reset(h.env().admin);
});

describe("RT-327 device health reads: who may read", () => {
  it("answers 401 without a session and for a bearer", async () => {
    if (h.skipped()) return;
    await h.get(LIST, null).expect(401);
    await h.get(one(DEV_A1A.id), null).expect(401);
    const bearer = await h.get(LIST, null).set("authorization", `Bearer ${DEV_A1A.token}`);
    expect(bearer.status).toBe(401);
  });

  it("answers the same non-disclosing 404 to a role outside the list", async () => {
    if (h.skipped()) return;
    const list = await h.get(LIST, STAFF_A.session);
    const get = await h.get(one(DEV_A1A.id), STAFF_A.session);
    const absent = await h.get(one("03270000-0000-4000-8000-00000000ffff"), OWNER_A.session);
    for (const res of [list, get, absent]) {
      expect(res.status).toBe(404);
      h.conforms("Error", res.body);
    }
    const shape = (body: unknown): unknown => {
      const { request_id: _id, ...rest } = (body as { error: Record<string, unknown> }).error;
      return rest;
    };
    expect(shape(get.body)).toEqual(shape(absent.body));
  });

  it("refuses a platform admin with no active tenant (a tenant surface: 401)", async () => {
    if (h.skipped()) return;
    expect((await h.get(LIST, PLATFORM_ADMIN.session)).status).toBe(401);
  });

  it("scopes a store_manager to the stores it can access", async () => {
    if (h.skipped()) return;
    expect(await ids(MANAGER_A1.session)).toEqual([DEV_A1A.id, DEV_A1B.id, DEV_REVOKED.id]);
    expect(await ids(MANAGER_A2.session)).toEqual([DEV_A2A.id]);
    await h.get(one(DEV_A1A.id), MANAGER_A2.session).expect(404);
    await h.get(LIST, MANAGER_A1.session, { store_id: STORE_A2 }).expect(404);
    await h.get(one(DEV_A2A.id), MANAGER_A1.session).expect(404);
  });

  it("never crosses tenants: reads, filters and ids of another tenant are 404 or absent", async () => {
    if (h.skipped()) return;
    expect(await ids(OWNER_B.session)).toEqual([DEV_B1A.id]);
    await h.get(one(DEV_A1A.id), OWNER_B.session).expect(404);
    await h.get(one(DEV_B1A.id), OWNER_A.session).expect(404);
    await h.get(LIST, OWNER_A.session, { store_id: STORE_B1 }).expect(404);
  });
});

describe("RT-327 device health reads: the list", () => {
  it("lists every device in scope by id, including devices that never sent a heartbeat", async () => {
    if (h.skipped()) return;
    const body = await page(OWNER_A.session);
    expect(body.items.map((i) => i.deviceId)).toEqual(TENANT_A_DEFAULT_ORDER);
    for (const item of body.items) {
      expect(item).toMatchObject({
        appVersion: null,
        updateChannel: null,
        heartbeatAt: null,
        secondsSinceHeartbeat: null,
        liveness: "unknown",
        compliance: "unknown",
        minSupportedVersion: null,
        minSupportedGraceUntil: null,
        lastSeenAt: null,
        lastSeenSource: null,
      });
    }
    expect(body.items.find((i) => i.deviceId === DEV_A1A.id)).toMatchObject({ label: "till a1a", storeId: STORE_A1, trustState: "active" });
  });

  it("filters by trust state: retired devices are left out unless asked for", async () => {
    if (h.skipped()) return;
    expect(await ids(OWNER_A.session, { trust_state: "retired" })).toEqual([DEV_RETIRED.id]);
    expect(await ids(OWNER_A.session, { trust_state: "revoked" })).toEqual([DEV_REVOKED.id]);
    expect(await ids(OWNER_A.session, { trust_state: "active" })).toEqual([DEV_A1A.id, DEV_A1B.id, DEV_A2A.id]);
  });

  it("filters by store", async () => {
    if (h.skipped()) return;
    expect(await ids(OWNER_A.session, { store_id: STORE_A2 })).toEqual([DEV_A2A.id]);
    expect(await ids(OWNER_A.session, { store_id: STORE_A1.toUpperCase() })).toEqual([DEV_A1A.id, DEV_A1B.id, DEV_REVOKED.id]);
  });

  it("derives liveness at read from the heartbeat clock, compliance from the current policy", async () => {
    if (h.skipped()) return;
    const admin = h.env().admin;
    await setPolicy(admin, "stable", { latest: "1.5.0", recommended: "1.4.2", min: "1.4.0" }, "2026-12-01T00:00:00.000Z");
    await putBeat(admin, { deviceId: DEV_A1A.id, tenantId: TENANT_A_ID, agoSeconds: 300, appVersion: "1.4.1", channel: "stable", state: "idle" });
    await putBeat(admin, { deviceId: DEV_A1B.id, tenantId: TENANT_A_ID, agoSeconds: 2 * 3600, appVersion: "1.3.0", channel: "stable" });
    await putBeat(admin, { deviceId: DEV_A2A.id, tenantId: TENANT_A_ID, agoSeconds: 3 * 86400 });
    await putBeat(admin, { deviceId: DEV_REVOKED.id, tenantId: TENANT_A_ID, agoSeconds: 60, appVersion: "1.4.0-rc.1", channel: "lab" });
    const byId = new Map((await page(OWNER_A.session)).items.map((i) => [i.deviceId, i] as const));
    expect(byId.get(DEV_A1A.id)).toMatchObject({
      liveness: "online",
      compliance: "ok",
      appVersion: "1.4.1",
      updateChannel: "stable",
      updateState: "idle",
      minSupportedVersion: "1.4.0",
      minSupportedGraceUntil: "2026-12-01T00:00:00.000Z",
    });
    expect(byId.get(DEV_A1A.id)!.secondsSinceHeartbeat).toBeGreaterThanOrEqual(300);
    expect(byId.get(DEV_A1B.id)).toMatchObject({ liveness: "stale", compliance: "below_minimum" });
    expect(byId.get(DEV_A2A.id)).toMatchObject({ liveness: "offline", compliance: "unknown", minSupportedVersion: null });
    // A channel with no policy is unknown, never ok.
    expect(byId.get(DEV_REVOKED.id)).toMatchObject({ liveness: "online", compliance: "unknown", minSupportedVersion: null });
  });

  it("matches the liveness, compliance, version and channel filters against the derived values", async () => {
    if (h.skipped()) return;
    const admin = h.env().admin;
    await setPolicy(admin, "stable", { latest: "1.5.0", recommended: "1.4.2", min: "1.4.0" });
    await putBeat(admin, { deviceId: DEV_A1A.id, tenantId: TENANT_A_ID, agoSeconds: 300, appVersion: "1.4.1", channel: "stable" });
    await putBeat(admin, { deviceId: DEV_A1B.id, tenantId: TENANT_A_ID, agoSeconds: 2 * 3600, appVersion: "1.3.0", channel: "stable" });
    await putBeat(admin, { deviceId: DEV_A2A.id, tenantId: TENANT_A_ID, agoSeconds: 3 * 86400 });
    expect(await ids(OWNER_A.session, { liveness: "online" })).toEqual([DEV_A1A.id]);
    expect(await ids(OWNER_A.session, { liveness: "stale" })).toEqual([DEV_A1B.id]);
    expect(await ids(OWNER_A.session, { liveness: "offline" })).toEqual([DEV_A2A.id]);
    expect(await ids(OWNER_A.session, { liveness: "unknown" })).toEqual([DEV_REVOKED.id]);
    expect(await ids(OWNER_A.session, { compliance: "ok" })).toEqual([DEV_A1A.id]);
    expect(await ids(OWNER_A.session, { compliance: "below_minimum" })).toEqual([DEV_A1B.id]);
    expect(await ids(OWNER_A.session, { compliance: "unknown" })).toEqual([DEV_A2A.id, DEV_REVOKED.id]);
    expect(await ids(OWNER_A.session, { app_version: "1.3.0" })).toEqual([DEV_A1B.id]);
    expect(await ids(OWNER_A.session, { update_channel: "stable" })).toEqual([DEV_A1A.id, DEV_A1B.id]);
    expect(await ids(OWNER_A.session, { update_channel: "lab" })).toEqual([]);
    expect(await ids(OWNER_A.session, { liveness: "stale", compliance: "below_minimum", store_id: STORE_A1 })).toEqual([DEV_A1B.id]);
  });

  it("re-derives compliance when the policy changes: nothing derived is stored", async () => {
    if (h.skipped()) return;
    const admin = h.env().admin;
    await setPolicy(admin, "stable", { latest: "1.5.0", recommended: "1.4.2", min: "1.4.0" });
    await putBeat(admin, { deviceId: DEV_A1A.id, tenantId: TENANT_A_ID, agoSeconds: 60, appVersion: "1.4.1", channel: "stable" });
    expect(await ids(OWNER_A.session, { compliance: "ok" })).toEqual([DEV_A1A.id]);
    await setPolicy(admin, "stable", { latest: "1.6.0", recommended: "1.5.5", min: "1.5.0" });
    expect(await ids(OWNER_A.session, { compliance: "below_minimum" })).toEqual([DEV_A1A.id]);
  });
});

describe("RT-327 device health reads: D-5 last seen", () => {
  it("labels the more recent of the heartbeat and the activity clock and never lets it drive liveness", async () => {
    if (h.skipped()) return;
    const admin = h.env().admin;
    await putBeat(admin, { deviceId: DEV_A1A.id, tenantId: TENANT_A_ID, agoSeconds: 300, appVersion: "1.4.1", channel: "stable" });
    await putBeat(admin, { deviceId: DEV_A1B.id, tenantId: TENANT_A_ID, agoSeconds: 2 * 3600, appVersion: "1.4.1", channel: "stable" });
    await admin.query(`UPDATE devices SET last_seen_at = now() - interval '1 minute' WHERE id = $1`, [DEV_A1B.id]);
    await admin.query(`UPDATE devices SET last_seen_at = now() - interval '30 minutes' WHERE id = $1`, [DEV_A2A.id]);
    const byId = new Map((await page(OWNER_A.session)).items.map((i) => [i.deviceId, i] as const));
    // Heartbeat is newer than the (absent) activity.
    expect(byId.get(DEV_A1A.id)).toMatchObject({ lastSeenSource: "heartbeat", activityLastSeenAt: null });
    expect(byId.get(DEV_A1A.id)!.lastSeenAt).toBe(byId.get(DEV_A1A.id)!.heartbeatAt);
    // Activity is newer than a 2-hour-old heartbeat, yet liveness stays stale.
    expect(byId.get(DEV_A1B.id)).toMatchObject({ lastSeenSource: "activity", liveness: "stale" });
    expect(byId.get(DEV_A1B.id)!.lastSeenAt).toBe(byId.get(DEV_A1B.id)!.activityLastSeenAt);
    // Activity only: no heartbeat, liveness unknown, last seen from activity.
    expect(byId.get(DEV_A2A.id)).toMatchObject({ lastSeenSource: "activity", liveness: "unknown", heartbeatAt: null });
  });
});

describe("RT-327 device health reads: paging and validation", () => {
  it("walks every device once by id, at any page size", async () => {
    if (h.skipped()) return;
    for (const size of [1, 2, 3]) expect(await walk(OWNER_A.session, size)).toEqual(TENANT_A_DEFAULT_ORDER);
  });

  it("pages a derived filter without skipping or repeating a device", async () => {
    if (h.skipped()) return;
    const admin = h.env().admin;
    await setPolicy(admin, "stable", { latest: "1.5.0", recommended: "1.4.2", min: "1.4.0" });
    await putBeat(admin, { deviceId: DEV_A1B.id, tenantId: TENANT_A_ID, agoSeconds: 60, appVersion: "1.4.1", channel: "stable" });
    expect(await walk(OWNER_A.session, 1, { compliance: "unknown" })).toEqual([DEV_A1A.id, DEV_A2A.id, DEV_REVOKED.id]);
    expect(await walk(OWNER_A.session, 2, { liveness: "unknown" })).toEqual([DEV_A1A.id, DEV_A2A.id, DEV_REVOKED.id]);
  });

  it("answers an empty page with nextCursor null", async () => {
    if (h.skipped()) return;
    const body = await page(OWNER_A.session, { update_channel: "canary" });
    expect(body).toEqual({ items: [], nextCursor: null });
  });

  it("refuses a malformed query, path or cursor with a 400 before any read", async () => {
    if (h.skipped()) return;
    const bad: Array<Record<string, string | number | string[]>> = [
      { unknown_key: "x" },
      { page_size: 0 },
      { page_size: 201 },
      { liveness: "healthy" },
      { compliance: "fine" },
      { trust_state: "gone" },
      { update_channel: "beta" },
      { app_version: "1.4" },
      { store_id: "not-a-uuid" },
      { liveness: ["online", "stale"] },
      { cursor: "***" },
      { cursor: Buffer.from("{}").toString("base64url") },
    ];
    for (const query of bad) {
      const res = await h.get(LIST, OWNER_A.session, query as Record<string, string | number>);
      expect({ query, status: res.status }).toEqual({ query, status: 400 });
      h.conforms("Error", res.body);
    }
    await h.get(one("not-a-uuid"), OWNER_A.session).expect(400);
  });

  it("refuses a cursor issued for another tenant", async () => {
    if (h.skipped()) return;
    const foreign = Buffer.from(JSON.stringify({ k: "device_health", t: "03270000-0000-4000-8000-0b0100000001", d: DEV_A1A.id })).toString("base64url");
    const res = await h.get(LIST, OWNER_A.session, { cursor: foreign });
    expect(res.status).toBe(400);
    expect((res.body as { error: { code: string } }).error.code).toBe("validation_error");
  });
});

describe("RT-327 device health reads: one device", () => {
  it("answers a device that never sent a heartbeat with liveness unknown", async () => {
    if (h.skipped()) return;
    const res = await h.get(one(DEV_A1A.id), OWNER_A.session).expect(200);
    h.conforms("DeviceHealthView", res.body);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).toMatchObject({ deviceId: DEV_A1A.id, liveness: "unknown", compliance: "unknown", heartbeatAt: null });
  });

  it("answers a device whatever its trust state, with its case-insensitive id", async () => {
    if (h.skipped()) return;
    for (const [d, trustState] of [
      [DEV_REVOKED, "revoked"],
      [DEV_RETIRED, "retired"],
    ] as const) {
      const res = await h.get(one(d.id.toUpperCase()), OWNER_A.session).expect(200);
      expect(res.body).toMatchObject({ deviceId: d.id, trustState });
    }
  });

  it("answers the stored beat with the derived verdicts", async () => {
    if (h.skipped()) return;
    const admin = h.env().admin;
    await setPolicy(admin, "stable", { latest: "1.5.0", recommended: "1.4.2", min: "1.4.0" });
    await putBeat(admin, { deviceId: DEV_A1A.id, tenantId: TENANT_A_ID, agoSeconds: 90, appVersion: "1.3.5", channel: "stable", state: "downloading" });
    const res = await h.get(one(DEV_A1A.id), MANAGER_A1.session).expect(200);
    h.conforms("DeviceHealthView", res.body);
    expect(res.body).toMatchObject({
      appVersion: "1.3.5",
      updateState: "downloading",
      liveness: "online",
      compliance: "below_minimum",
      lastSeenSource: "heartbeat",
    });
  });
});

describe("RT-327 device health reads: no side effects", () => {
  it("writes and audits nothing", async () => {
    if (h.skipped()) return;
    const admin = h.env().admin;
    await putBeat(admin, { deviceId: DEV_A1A.id, tenantId: TENANT_A_ID, agoSeconds: 60, appVersion: "1.4.1", channel: "stable" });
    const count = async (sql: string): Promise<string> => (await admin.query<{ n: string }>(sql)).rows[0]!.n;
    const audit = await count(`SELECT count(*)::text AS n FROM audit_events`);
    const health = await count(`SELECT md5(string_agg(device_health::text, ',' ORDER BY device_id)) AS n FROM device_health`);
    await page(OWNER_A.session);
    await h.get(one(DEV_A1A.id), OWNER_A.session).expect(200);
    expect(await count(`SELECT count(*)::text AS n FROM audit_events`)).toBe(audit);
    expect(await count(`SELECT md5(string_agg(device_health::text, ',' ORDER BY device_id)) AS n FROM device_health`)).toBe(health);
  });
});
