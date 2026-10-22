/**
 * RT-719: recording the POS build identity on the device-token routes, against
 * real Postgres (Testcontainers, every migration, the NOBYPASSRLS `app_test`
 * pool) behind the REAL `PosDeviceAuthGuard`, `DeviceRepository` and activity
 * recorder. Two probe routes stand in for the thirteen operations: one marked
 * `@ReportsBuildIdentity()` (a reporting operation) and one that is not (any
 * other device-token route). The marked handlers of the real controllers are
 * pinned by `build-identity-markers.spec.ts`.
 *
 * What this proves (`pos-terminal-pairing.openapi.yaml`, "Build identity
 * report"):
 *   - a reporting request stores the identity with the server clock, in the
 *     same throttled write as `last_seen_at`: a report inside the window is not
 *     stored, one after it is;
 *   - unknown is never a default and never kept: a reporting request without a
 *     valid commit CLEARS the stored identity; an invalid version or pin is
 *     null with a valid commit;
 *   - a request is never refused, slowed or changed for a header, however
 *     malformed;
 *   - a non-reporting route can neither record nor clear it, though it still
 *     feeds `last_seen_at`;
 *   - a refused request (401: unknown token, revoked device) records nothing;
 *   - one counter per store by outcome (`recorded` / `unknown` / `failed`) and
 *     never a value in a label.
 *
 * Docker policy: HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import "reflect-metadata";

jest.mock("../../src/observability/metrics/api.metrics", () => {
  const actual = jest.requireActual("../../src/observability/metrics/api.metrics");
  return { ...actual, recordPosBuildIdentityReport: jest.fn() };
});

import { Controller, Get, Module } from "@nestjs/common";
import type { INestApplication } from "@nestjs/common";
import { UseGuards } from "@nestjs/common";
import { hashToken } from "@data-pulse-2/auth";
import { Pool } from "pg";
import request from "supertest";

import { AUTH_LOOKUP_POOL, AuthModule, PG_POOL } from "../../src/auth/auth.module";
import { PosDeviceAuthGuard } from "../../src/auth/pos-device-auth.guard";
import { DeviceBearer, ReportsBuildIdentity } from "../../src/auth/route-auth";
import { recordPosBuildIdentityReport } from "../../src/observability/metrics/api.metrics";
import { deviceActivity } from "../../src/pos-operators/device-activity";
import { DeviceRepository } from "../../src/pos-operators/device.repository";
import { bootDeviceModuleApp, startPgEnvOrSkip } from "../_helpers/device-module-app";
import { stopPgEnv, type PgTestEnv } from "../_helpers/postgres-container";

@Controller("api/pos/v1/rt719-probe")
@DeviceBearer()
@UseGuards(PosDeviceAuthGuard)
class ProbeController {
  @Get("reporting")
  @ReportsBuildIdentity()
  reporting(): { ok: true } {
    return { ok: true };
  }

  @Get("plain")
  plain(): { ok: true } {
    return { ok: true };
  }
}

@Module({
  imports: [AuthModule],
  controllers: [ProbeController],
  providers: [
    {
      provide: DeviceRepository,
      useFactory: (lookup: Pool, domain: Pool): DeviceRepository => new DeviceRepository(lookup, domain),
      inject: [AUTH_LOOKUP_POOL, PG_POOL],
    },
    PosDeviceAuthGuard,
  ],
})
class ProbeModule {}

const TENANT_A = "07190000-0000-4000-8000-0000000a0001";
const TENANT_B = "07190000-0000-4000-8000-0000000b0001";
const STORE_A = "07190000-0000-4000-8000-0000000a5001";
const STORE_B = "07190000-0000-4000-8000-0000000b5001";
const device = (n: string): { id: string; token: string } => ({ id: `07190000-0000-4000-8000-0000000e${n}`, token: `rt719-device-token-${n}-aaaaaaaaaaaaaaaa` });
const DEV_A = device("0001");
const DEV_B = device("0002");
const DEV_REVOKED = device("0003");

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const COMMIT_2 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PIN = "fedcba9876543210fedcba9876543210fedcba98";

const metric = recordPosBuildIdentityReport as jest.MockedFunction<typeof recordPosBuildIdentityReport>;

let env: PgTestEnv | null = null;
let admin: Pool;
let app: INestApplication;

beforeAll(async () => {
  env = await startPgEnvOrSkip("RT-719 build identity record");
  if (env === null) return;
  admin = new Pool({ connectionString: env.adminUri });
  await admin.query(`INSERT INTO tenants (id, slug, name) VALUES ($1, 'rt719-a', 'RT-719 A'), ($2, 'rt719-b', 'RT-719 B')`, [TENANT_A, TENANT_B]);
  await admin.query(`INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $3, 'A', 'A'), ($2, $4, 'B', 'B')`, [STORE_A, STORE_B, TENANT_A, TENANT_B]);
  for (const [d, tenant, store] of [
    [DEV_A, TENANT_A, STORE_A],
    [DEV_B, TENANT_B, STORE_B],
    [DEV_REVOKED, TENANT_A, STORE_A],
  ] as const) {
    await admin.query(`INSERT INTO devices (id, tenant_id, store_id, token_hash) VALUES ($1, $2, $3, $4)`, [d.id, tenant, store, hashToken(d.token)]);
  }
  await admin.query(`UPDATE devices SET revoked_at = now() WHERE id = $1`, [DEV_REVOKED.id]);
  app = await bootDeviceModuleApp(ProbeModule, { domain: env.app, lookup: admin });
}, 240_000);

afterAll(async () => {
  if (app) await app.close().catch(() => undefined);
  if (admin) await admin.end().catch(() => undefined);
  if (env) await stopPgEnv(env);
}, 60_000);

const skipped = (): boolean => env === null;

type Row = {
  reported_build_commit: string | null;
  reported_app_version: string | null;
  reported_contract_pin: string | null;
  build_reported_at: Date | null;
  last_seen_at: Date | null;
};

async function row(id: string): Promise<Row> {
  const r = await admin.query<Row>(
    `SELECT reported_build_commit, reported_app_version, reported_contract_pin, build_reported_at, last_seen_at FROM devices WHERE id = $1`,
    [id],
  );
  return r.rows[0] as Row;
}

/** Send one request and wait for the best-effort activity write it triggered. */
async function call(
  path: "reporting" | "plain",
  d: { token: string },
  headers: Record<string, string> = {},
): Promise<request.Response> {
  let req = request(app.getHttpServer()).get(`/api/pos/v1/rt719-probe/${path}`).set("authorization", `Bearer ${d.token}`);
  for (const [k, v] of Object.entries(headers)) req = req.set(k, v);
  const res = await req;
  await deviceActivity.flush();
  return res;
}

/** Make the throttle window of `id` over, in the database and in the process. */
async function openWindow(id: string): Promise<void> {
  await admin.query(`UPDATE devices SET last_seen_at = now() - interval '10 minutes' WHERE id = $1`, [id]);
  deviceActivity.reset();
}

const FULL = { "x-pos-build-commit": COMMIT, "x-pos-app-version": "1.4.0-rc.1", "x-pos-contract-pin": PIN };

beforeEach(async () => {
  if (skipped()) return;
  await admin.query(
    `UPDATE devices SET last_seen_at = NULL, reported_build_commit = NULL, reported_app_version = NULL, reported_contract_pin = NULL, build_reported_at = NULL`,
  );
  deviceActivity.reset();
  metric.mockClear();
});

describe("RT-719 build identity: a reporting request", () => {
  it("stores the identity with the server clock and answers as before", async () => {
    if (skipped()) return;
    const before = Date.now();
    const res = await call("reporting", DEV_A, FULL);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    const r = await row(DEV_A.id);
    expect(r).toMatchObject({ reported_build_commit: COMMIT, reported_app_version: "1.4.0-rc.1", reported_contract_pin: PIN });
    expect(r.build_reported_at!.getTime()).toBeGreaterThanOrEqual(before - 5_000);
    expect(r.last_seen_at).not.toBeNull();
    expect(metric.mock.calls).toEqual([["recorded"]]);
  });

  it("keeps a commit alone with a null version and pin", async () => {
    if (skipped()) return;
    await call("reporting", DEV_A, { "x-pos-build-commit": COMMIT });
    expect(await row(DEV_A.id)).toMatchObject({ reported_build_commit: COMMIT, reported_app_version: null, reported_contract_pin: null });
  });

  it("stores at most once per throttle window, with the same write as last_seen_at", async () => {
    if (skipped()) return;
    await call("reporting", DEV_A, FULL);
    const first = await row(DEV_A.id);
    // Inside the window (database and process): the second report is not stored.
    deviceActivity.reset();
    await call("reporting", DEV_A, { "x-pos-build-commit": COMMIT_2 });
    expect(await row(DEV_A.id)).toEqual(first);
    expect(metric).toHaveBeenCalledTimes(1);
    // After the window it is.
    await openWindow(DEV_A.id);
    await call("reporting", DEV_A, { "x-pos-build-commit": COMMIT_2 });
    const later = await row(DEV_A.id);
    expect(later).toMatchObject({ reported_build_commit: COMMIT_2, reported_app_version: null, reported_contract_pin: null });
    expect(later.build_reported_at!.getTime()).toBeGreaterThan(first.build_reported_at!.getTime());
  });
});

describe("RT-719 build identity: unknown is never a default and never kept", () => {
  it("clears the stored identity when a later reporting request carries no header", async () => {
    if (skipped()) return;
    await call("reporting", DEV_A, FULL);
    await openWindow(DEV_A.id);
    await call("reporting", DEV_A);
    expect(await row(DEV_A.id)).toMatchObject({
      reported_build_commit: null,
      reported_app_version: null,
      reported_contract_pin: null,
      build_reported_at: null,
    });
    expect(metric.mock.calls.map(([o]) => o)).toEqual(["recorded", "unknown"]);
  });

  it.each([
    ["an invalid commit", { "x-pos-build-commit": COMMIT.toUpperCase(), "x-pos-app-version": "1.4.0", "x-pos-contract-pin": PIN }],
    ["a version and a pin without a commit", { "x-pos-app-version": "1.4.0", "x-pos-contract-pin": PIN }],
    ["an abbreviated commit", { "x-pos-build-commit": COMMIT.slice(0, 7) }],
  ])("records unknown for %s, and ignores the version and the pin", async (_why, headers) => {
    if (skipped()) return;
    await call("reporting", DEV_A, FULL);
    await openWindow(DEV_A.id);
    await call("reporting", DEV_A, headers);
    expect(await row(DEV_A.id)).toMatchObject({ reported_build_commit: null, reported_app_version: null, reported_contract_pin: null, build_reported_at: null });
  });

  it("records an invalid version or pin as null with a valid commit", async () => {
    if (skipped()) return;
    await call("reporting", DEV_A, { "x-pos-build-commit": COMMIT, "x-pos-app-version": "1.4.0+build.5", "x-pos-contract-pin": "short" });
    expect(await row(DEV_A.id)).toMatchObject({ reported_build_commit: COMMIT, reported_app_version: null, reported_contract_pin: null });
  });

  it("never refuses or changes the answer for a malformed, repeated or oversized header", async () => {
    if (skipped()) return;
    const plain = await call("reporting", DEV_A);
    for (const headers of [
      { "x-pos-build-commit": "nope" },
      { "x-pos-build-commit": `${COMMIT}, ${COMMIT}` },
      { "x-pos-build-commit": COMMIT, "x-pos-app-version": "v".repeat(500) },
      { "x-pos-contract-pin": "éé" },
    ]) {
      const res = await call("reporting", DEV_A, headers);
      expect({ status: res.status, body: res.body }).toEqual({ status: plain.status, body: plain.body });
    }
  });
});

describe("RT-719 build identity: a route that does not report", () => {
  it("can neither record nor clear it, though it still feeds last_seen_at", async () => {
    if (skipped()) return;
    await call("reporting", DEV_A, FULL);
    const stored = await row(DEV_A.id);
    await openWindow(DEV_A.id);
    await call("plain", DEV_A, { "x-pos-build-commit": COMMIT_2 });
    const after = await row(DEV_A.id);
    expect(after).toMatchObject({ reported_build_commit: COMMIT, reported_app_version: "1.4.0-rc.1", reported_contract_pin: PIN });
    expect(after.build_reported_at).toEqual(stored.build_reported_at);
    expect(after.last_seen_at!.getTime()).toBeGreaterThan(Date.now() - 60_000);
    // And it never records one that was never reported.
    await call("plain", DEV_B, { "x-pos-build-commit": COMMIT });
    expect(await row(DEV_B.id)).toMatchObject({ reported_build_commit: null, build_reported_at: null });
    expect(metric).toHaveBeenCalledTimes(1);
  });

  // The contract's "Throttled like the last-seen write": one window per device, shared by every
  // device-token route, and the server MAY defer a changed identity to the next window. So a
  // route that does not report (the RT-327 heartbeat) can win a window and defer an upgrade's
  // first report; the identity is stale for that window, never lost, never cleared.
  it("can win the window: a changed identity reported inside it is deferred to the next window", async () => {
    if (skipped()) return;
    await call("reporting", DEV_A, FULL);
    await openWindow(DEV_A.id);
    await call("plain", DEV_A);
    await call("reporting", DEV_A, { "x-pos-build-commit": COMMIT_2 });
    expect(await row(DEV_A.id)).toMatchObject({ reported_build_commit: COMMIT, reported_app_version: "1.4.0-rc.1" });
    await openWindow(DEV_A.id);
    await call("reporting", DEV_A, { "x-pos-build-commit": COMMIT_2 });
    expect(await row(DEV_A.id)).toMatchObject({ reported_build_commit: COMMIT_2, reported_app_version: null });
  });
});

describe("RT-719 build identity: a refused request records nothing", () => {
  it("is a 401 for an unknown token and for a revoked device, with the identity untouched", async () => {
    if (skipped()) return;
    const unknown = await call("reporting", { token: "not-a-device-token-aaaaaaaaaaaaaaaaaaaa" }, FULL);
    expect(unknown.status).toBe(401);
    const revoked = await call("reporting", DEV_REVOKED, FULL);
    expect(revoked.status).toBe(401);
    expect(await row(DEV_REVOKED.id)).toMatchObject({ reported_build_commit: null, build_reported_at: null, last_seen_at: null });
    expect(metric).not.toHaveBeenCalled();
  });

  it("never writes another tenant's device (RLS): each device keeps its own identity", async () => {
    if (skipped()) return;
    await call("reporting", DEV_A, FULL);
    await call("reporting", DEV_B, { "x-pos-build-commit": COMMIT_2 });
    expect((await row(DEV_A.id)).reported_build_commit).toBe(COMMIT);
    expect((await row(DEV_B.id)).reported_build_commit).toBe(COMMIT_2);
  });
});
