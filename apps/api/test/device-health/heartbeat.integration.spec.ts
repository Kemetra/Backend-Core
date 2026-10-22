/**
 * RT-327: `posReportDeviceHeartbeat` over HTTP against real Postgres
 * (Testcontainers, every migration, the NOBYPASSRLS `app_test` pool) and the
 * real `PosDeviceAuthGuard`.
 *
 * What this proves (RT-327 acceptance):
 *   - the guard is the only source of identity: a device bearer only, and a
 *     body that names a device, tenant, store or `last_seen_at` is a 400 with
 *     nothing stored;
 *   - the stored row is the guard's device and tenant, `last_seen_at` is the
 *     server clock, and RLS keeps one tenant's health rows from another;
 *   - at most one stored beat per device per 60 s, the reply always returned
 *     and computed from THIS request (not from the stored row), concurrent
 *     beats converging to one store;
 *   - a stored beat replaces every field (an omitted one becomes NULL);
 *   - a store that fails is counted `refused` and swallowed: still a 200;
 *   - the reply is `unknown` without a policy, `ok` / `below_minimum` with one,
 *     and always validates against the contract's `HeartbeatAck`;
 *   - one counter per beat by outcome; no audit row per beat.
 *
 * Docker policy: HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import "reflect-metadata";

jest.mock("../../src/observability/metrics/api.metrics", () => {
  const actual = jest.requireActual("../../src/observability/metrics/api.metrics");
  return { ...actual, recordPosDeviceHeartbeat: jest.fn() };
});

import { runWithTenantContext } from "@data-pulse-2/db";
import type { Pool } from "pg";
import type request from "supertest";

import type { Logger } from "@data-pulse-2/shared";

import { DeviceHealthModule } from "../../src/device-health/device-health.module";
import { DeviceHeartbeatService } from "../../src/device-health/heartbeat.service";
import { POS_CONTRACT_REVISION } from "../../src/device-health/pos-contract-revision";
import { recordPosDeviceHeartbeat } from "../../src/observability/metrics/api.metrics";
import { scopedHttpHarness } from "../_helpers/scoped-http-harness";
import {
  DEV_A1A,
  DEV_A1B,
  DEV_A2A,
  DEV_B1A,
  DEV_RETIRED,
  DEV_REVOKED,
  OWNER_A,
  STORE_A1,
  TENANT_A,
  TENANT_B,
  seedDeviceHealthFixture,
  setPolicy,
  type FixtureDevice,
} from "./__support__/device-health-fixture";

const PATH = "/api/pos/v1/terminals/heartbeat";
const metric = recordPosDeviceHeartbeat as jest.MockedFunction<typeof recordPosDeviceHeartbeat>;

const h = scopedHttpHarness({
  label: "RT-327 heartbeat",
  contractId: "pos-device-health.openapi",
  module: DeviceHealthModule,
  seed: seedDeviceHealthFixture,
});

const beat = (d: FixtureDevice, body: object = {}): request.Test => h.post(PATH, null, body).set("authorization", `Bearer ${d.token}`);

interface HealthRow {
  device_id: string;
  tenant_id: string;
  last_seen_at: Date;
  app_version: string | null;
  update_channel: string | null;
  update_state: string | null;
  pending_version: string | null;
  schema_head: string | null;
  source_clock_at: Date | null;
}

async function rows(admin: Pool, deviceId?: string): Promise<HealthRow[]> {
  const r = await admin.query<HealthRow>(
    `SELECT * FROM device_health WHERE ($1::uuid IS NULL OR device_id = $1::uuid) ORDER BY device_id`,
    [deviceId ?? null],
  );
  return r.rows;
}

/** Make the stored beat of `deviceId` older than the throttle window. */
async function age(admin: Pool, deviceId: string, seconds = 120): Promise<void> {
  await admin.query(`UPDATE device_health SET last_seen_at = now() - make_interval(secs => $2::int) WHERE device_id = $1`, [deviceId, seconds]);
}

async function resetHealth(admin: Pool): Promise<void> {
  await admin.query(`DELETE FROM device_health`);
  await admin.query(`DELETE FROM pos_version_policy`);
}

const outcomes = (): string[] => metric.mock.calls.map(([outcome]) => outcome);

const FULL = {
  app_version: "1.4.1",
  update_channel: "stable",
  update_state: "idle",
  pending_version: "1.4.2",
  schema_head: "0042_local_outbox",
  source_clock_at: "2026-10-21T10:00:00.000Z",
};

beforeEach(async () => {
  if (h.skipped()) return;
  await resetHealth(h.env().admin);
  metric.mockClear();
});

describe("RT-327 heartbeat: authentication (the guard is the only identity)", () => {
  it("refuses a missing, unknown, revoked or non-device credential with the generic 401 and stores nothing", async () => {
    if (h.skipped()) return;
    // One request at a time: supertest closes the (shared, not yet listening) server
    // when a request ends, which resets requests still in flight (ECONNRESET in CI).
    const cases: Array<() => request.Test> = [
      () => h.post(PATH, null, {}),
      () => h.post(PATH, null, {}).set("authorization", "Bearer not-a-device-token-aaaaaaaaaaaaaaaaaa"),
      () => beat(DEV_REVOKED),
      () => beat(DEV_RETIRED),
      () => h.post(PATH, OWNER_A.session, {}),
      () => h.post(PATH, null, {}).set("authorization", `Basic ${DEV_A1A.token}`),
    ];
    for (const send of cases) {
      const res = await send();
      expect(res.status).toBe(401);
      h.conforms("Error", res.body);
    }
    expect(await rows(h.env().admin)).toEqual([]);
    expect(metric).not.toHaveBeenCalled();
  });

  it.each(["device_id", "tenant_id", "store_id", "last_seen_at", "hostname"])("refuses a body that carries %s with a 400 and stores nothing", async (key) => {
    if (h.skipped()) return;
    const res = await beat(DEV_A1A, { ...FULL, [key]: DEV_A2A.id });
    expect(res.status).toBe(400);
    expect((res.body as { error: { code: string } }).error.code).toBe("validation_error");
    h.conforms("Error", res.body);
    expect(await rows(h.env().admin)).toEqual([]);
  });

  it("stores the row of the authenticated device and its tenant, never of another", async () => {
    if (h.skipped()) return;
    await beat(DEV_A1A, FULL).expect(200);
    await beat(DEV_B1A, FULL).expect(200);
    const stored = await rows(h.env().admin);
    expect(stored.map((r) => [r.device_id, r.tenant_id])).toEqual(
      [
        [DEV_A1A.id, TENANT_A],
        [DEV_B1A.id, TENANT_B],
      ].sort((a, b) => (a[0] as string).localeCompare(b[0] as string)),
    );
  });
});

describe("RT-327 heartbeat: bounds (a 400 stores nothing)", () => {
  it.each([
    ["app_version", "1.4"],
    ["app_version", "1.4.0+build.5"],
    ["update_channel", "beta"],
    ["update_state", "sleeping"],
    ["pending_version", "latest"],
    ["schema_head", "../etc/passwd"],
    ["source_clock_at", "yesterday"],
  ])("refuses %s = %j", async (key, value) => {
    if (h.skipped()) return;
    const res = await beat(DEV_A1A, { ...FULL, [key]: value });
    expect(res.status).toBe(400);
    expect(await rows(h.env().admin)).toEqual([]);
  });

  it("accepts an empty body (liveness only) and answers a full ack", async () => {
    if (h.skipped()) return;
    const res = await beat(DEV_A1A).expect(200);
    h.conforms("HeartbeatAck", res.body);
    const [row] = await rows(h.env().admin);
    expect(row).toMatchObject({ app_version: null, update_channel: null, update_state: null, pending_version: null, schema_head: null, source_clock_at: null });
  });
});

describe("RT-327 heartbeat: storage, throttle and last-write-wins", () => {
  it("stores the self-reported fields and stamps the server clock", async () => {
    if (h.skipped()) return;
    const before = Date.now();
    await beat(DEV_A1A, FULL).expect(200);
    const [row] = await rows(h.env().admin, DEV_A1A.id);
    expect(row).toMatchObject({
      app_version: "1.4.1",
      update_channel: "stable",
      update_state: "idle",
      pending_version: "1.4.2",
      schema_head: "0042_local_outbox",
    });
    expect(row?.source_clock_at?.toISOString()).toBe("2026-10-21T10:00:00.000Z");
    // The server clock, not the terminal's (which says 2026-10-21).
    expect(row!.last_seen_at.getTime()).toBeGreaterThanOrEqual(before - 5_000);
    expect(outcomes()).toEqual(["stored"]);
  });

  it("stores at most one beat per 60 s but always replies, computed from THIS request", async () => {
    if (h.skipped()) return;
    await setPolicy(h.env().admin, "stable", { latest: "1.5.0", recommended: "1.4.2", min: "1.4.0" });
    const first = await beat(DEV_A1A, { ...FULL, app_version: "1.4.1" }).expect(200);
    const storedAt = (await rows(h.env().admin, DEV_A1A.id))[0]!.last_seen_at;
    const second = await beat(DEV_A1A, { ...FULL, app_version: "1.3.0", update_state: "error" }).expect(200);
    h.conforms("HeartbeatAck", second.body);
    expect((first.body as { compliance: string }).compliance).toBe("ok");
    // The throttled beat is still answered from its own body.
    expect((second.body as { compliance: string }).compliance).toBe("below_minimum");
    const [row] = await rows(h.env().admin, DEV_A1A.id);
    expect(row).toMatchObject({ app_version: "1.4.1", update_state: "idle" });
    expect(row!.last_seen_at.getTime()).toBe(storedAt.getTime());
    expect(outcomes()).toEqual(["stored", "throttled"]);
  });

  it("stores again after the window and replaces every field (an omitted one becomes NULL)", async () => {
    if (h.skipped()) return;
    await beat(DEV_A1A, FULL).expect(200);
    await age(h.env().admin, DEV_A1A.id, 61);
    await beat(DEV_A1A, { app_version: "1.4.3" }).expect(200);
    const [row] = await rows(h.env().admin, DEV_A1A.id);
    expect(row).toMatchObject({
      app_version: "1.4.3",
      update_channel: null,
      update_state: null,
      pending_version: null,
      schema_head: null,
      source_clock_at: null,
    });
    expect(outcomes()).toEqual(["stored", "stored"]);
  });

  it("does not store a beat 59 s after the last one", async () => {
    if (h.skipped()) return;
    await beat(DEV_A1A, FULL).expect(200);
    await age(h.env().admin, DEV_A1A.id, 59);
    await beat(DEV_A1A, { app_version: "9.9.9" }).expect(200);
    expect((await rows(h.env().admin, DEV_A1A.id))[0]!.app_version).toBe("1.4.1");
  });

  it("converges concurrent beats of one device to one stored beat", async () => {
    if (h.skipped()) return;
    // The service, not HTTP: parallel supertest requests share one server and reset each other.
    const silent = { warn: () => undefined, info: () => undefined, error: () => undefined, debug: () => undefined } as unknown as Logger;
    const service = new DeviceHeartbeatService(h.env().app, silent);
    const scope = { deviceId: DEV_A1A.id, tenantId: TENANT_A, storeId: STORE_A1 };
    const acks = await Promise.all(Array.from({ length: 6 }, (_, i) => service.report(scope, { app_version: `1.4.${i}` })));
    for (const ack of acks) h.conforms("HeartbeatAck", ack);
    expect(await rows(h.env().admin, DEV_A1A.id)).toHaveLength(1);
    expect(outcomes().filter((o) => o === "stored")).toHaveLength(1);
    expect(outcomes().filter((o) => o === "throttled")).toHaveLength(5);
  });

  it("keeps devices independent: a throttled device does not throttle another", async () => {
    if (h.skipped()) return;
    await beat(DEV_A1A, FULL).expect(200);
    await beat(DEV_A1B, FULL).expect(200);
    expect(await rows(h.env().admin)).toHaveLength(2);
  });

  it("writes no audit row per beat", async () => {
    if (h.skipped()) return;
    const before = await h.env().admin.query<{ n: string }>(`SELECT count(*)::text AS n FROM audit_events`);
    await beat(DEV_A1A, FULL).expect(200);
    await age(h.env().admin, DEV_A1A.id);
    await beat(DEV_A1A, FULL).expect(200);
    const after = await h.env().admin.query<{ n: string }>(`SELECT count(*)::text AS n FROM audit_events`);
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
  });
});

describe("RT-327 heartbeat: a failed store is counted and swallowed", () => {
  it("answers 200 and counts `refused` when the device's row is locked past the lock timeout", async () => {
    if (h.skipped()) return;
    await beat(DEV_A1A, FULL).expect(200);
    await age(h.env().admin, DEV_A1A.id);
    metric.mockClear();
    const holder = await h.env().admin.connect();
    try {
      await holder.query("BEGIN");
      await holder.query(`SELECT 1 FROM device_health WHERE device_id = $1 FOR UPDATE`, [DEV_A1A.id]);
      const res = await beat(DEV_A1A, { app_version: "1.4.9" }).expect(200);
      h.conforms("HeartbeatAck", res.body);
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
    expect(outcomes()).toEqual(["refused"]);
    expect((await rows(h.env().admin, DEV_A1A.id))[0]!.app_version).toBe("1.4.1");
  }, 30_000);
});

describe("RT-327 heartbeat: the reply", () => {
  it("is unknown with a null policy and null grace when no policy exists", async () => {
    if (h.skipped()) return;
    const res = await beat(DEV_A1A, FULL).expect(200);
    h.conforms("HeartbeatAck", res.body);
    expect(res.body).toMatchObject({
      pos_contract_revision: POS_CONTRACT_REVISION,
      policy: null,
      min_supported_grace_until: null,
      compliance: "unknown",
    });
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("carries the channel's policy, the grace instant and the verdict", async () => {
    if (h.skipped()) return;
    await setPolicy(h.env().admin, "stable", { latest: "1.5.0", recommended: "1.4.2", min: "1.4.0" }, "2026-12-01T00:00:00.000Z");
    await setPolicy(h.env().admin, "lab", { latest: "2.0.0", recommended: "2.0.0", min: "1.9.0" });
    const ok = await beat(DEV_A1A, FULL).expect(200);
    h.conforms("HeartbeatAck", ok.body);
    expect(ok.body).toMatchObject({
      policy: { channel: "stable", latest_version: "1.5.0", recommended_version: "1.4.2", min_supported_version: "1.4.0", policy_revision: 1 },
      min_supported_grace_until: "2026-12-01T00:00:00.000Z",
      compliance: "ok",
    });
    const below = await beat(DEV_A1B, { ...FULL, app_version: "1.3.9" }).expect(200);
    expect(below.body).toMatchObject({ compliance: "below_minimum" });
    const preRelease = await beat(DEV_A2A, { ...FULL, app_version: "1.4.0-rc.1" }).expect(200);
    expect(preRelease.body).toMatchObject({ compliance: "below_minimum" });
  });

  it("is unknown, never ok, when the beat has no version or no channel", async () => {
    if (h.skipped()) return;
    await setPolicy(h.env().admin, "stable", { latest: "1.5.0", recommended: "1.4.2", min: "1.4.0" });
    const noVersion = await beat(DEV_A1A, { update_channel: "stable" }).expect(200);
    expect(noVersion.body).toMatchObject({ compliance: "unknown" });
    expect((noVersion.body as { policy: unknown }).policy).not.toBeNull();
    const noChannel = await beat(DEV_A1B, { app_version: "1.4.1" }).expect(200);
    expect(noChannel.body).toMatchObject({ policy: null, min_supported_grace_until: null, compliance: "unknown" });
    h.conforms("HeartbeatAck", noChannel.body);
  });

  it("never reads the RT-719 build identity headers: they neither fail the beat nor change the row", async () => {
    if (h.skipped()) return;
    const res = await beat(DEV_A1A, FULL)
      .set("x-pos-app-version", "9.9.9")
      .set("x-pos-build-commit", "a".repeat(40))
      .set("x-pos-contract-pin", "b".repeat(16))
      .expect(200);
    h.conforms("HeartbeatAck", res.body);
    expect((await rows(h.env().admin, DEV_A1A.id))[0]!.app_version).toBe("1.4.1");
  });
});

describe("RT-327 device_health: tenant isolation (RLS)", () => {
  it("never shows another tenant's health row, and refuses to write one", async () => {
    if (h.skipped()) return;
    await beat(DEV_A1A, FULL).expect(200);
    const pool = h.env().app;
    const asB = <T>(work: Parameters<typeof runWithTenantContext<T>>[2]) => runWithTenantContext(pool, { tenantId: TENANT_B, isPlatformAdmin: false }, work);
    const seen = await asB((client) => client.query(`SELECT device_id FROM device_health`));
    expect(seen.rows).toEqual([]);
    await expect(
      asB((client) => client.query(`INSERT INTO device_health (device_id, tenant_id, last_seen_at) VALUES ($1, $2, now())`, [DEV_A1B.id, TENANT_A])),
    ).rejects.toThrow();
    await expect(asB((client) => client.query(`UPDATE device_health SET app_version = '6.6.6' WHERE device_id = $1`, [DEV_A1A.id]))).resolves.toMatchObject({ rowCount: 0 });
    expect((await rows(h.env().admin, DEV_A1A.id))[0]!.app_version).toBe("1.4.1");
  });
});
