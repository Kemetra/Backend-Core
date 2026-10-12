/**
 * Spec 038 / RT-401 — store time zone, end-to-end.
 *
 * Real Postgres (every migration) through the Nest HTTP pipeline, on the
 * non-superuser app role so RLS is in force. Same bootstrap as
 * `stores.controller.spec.ts`, including its soft skip when Docker is
 * unavailable (`MIGRATION_TEST_ALLOW_SKIP=1`).
 *
 * What this spec proves
 * ---------------------
 *   - create with and without `timezone`; malformed (400 validation_error)
 *     and unknown (400 invalid_timezone) zones
 *   - the preview's fields against PostgreSQL, its open-shift blocker, and
 *     that it writes nothing
 *   - a PATCH change commits with one `store.timezone.changed` audit row
 *   - stale expected zone 409, unknown zone 400, open shift 409: nothing
 *     written, no audit row
 *   - role and tenant isolation (404) on PATCH and the preview
 *   - FR-009: a closed shift's persisted business date survives a change
 *   - FR-007: a shift open and a zone change cannot interleave, in either
 *     order (the store row is locked FOR UPDATE / FOR SHARE)
 */
import "reflect-metadata";

import { createHash, randomUUID } from "node:crypto";

import { hashPassword } from "@data-pulse-2/auth";
import { createLogger } from "@data-pulse-2/shared";
import { runWithTenantContext } from "@data-pulse-2/db";
import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import cookieParser from "cookie-parser";
import type { Pool, PoolClient } from "pg";
import request from "supertest";

import { AuthModule, PG_POOL, REDIS_CLIENT } from "../../src/auth/auth.module";
import {
  EMAIL_JOB_ENQUEUER,
  NoOpEmailJobEnqueuer,
} from "../../src/auth/email-job.enqueuer";
import type { RedisLike } from "../../src/auth/rate-limit";
import { GlobalExceptionFilter } from "../../src/common/exception.filter";
import { LoggingInterceptor } from "../../src/common/logging.interceptor";
import { RequestIdInterceptor } from "../../src/common/request-id.interceptor";
import { ZodValidationPipe } from "../../src/common/zod-validation.pipe";
import { ContextInterceptor } from "../../src/context/context.interceptor";
import { ContextModule } from "../../src/context/context.module";
import type { DeviceScope } from "../../src/pos-cashier-admissions/device-scope";
import {
  ShiftCashUpRepository,
  type CashUpShiftRow,
  type NewCashUpShift,
} from "../../src/pos-shifts/shift-cash-up.repository";
import { StoresModule } from "../../src/stores/stores.module";
import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../_helpers/postgres-container";

class AlwaysAllowRedis implements RedisLike {
  async incr(): Promise<number> { return 1; }
  async pexpireNx(): Promise<number> { return 1; }
  async pttl(): Promise<number> { return -1; }
  async decr(): Promise<number> { return 0; }
  async del(): Promise<number> { return 0; }
}

// ---- Fixture IDs ---------------------------------------------------------

interface Credentials {
  readonly email: string;
  readonly password: string;
}

const BOB_ID = "22222222-2222-4222-8222-222222222222"; // tenant_admin of acme
const BOB: Credentials = { email: "bob@example.com", password: "Bob-Password-123!" };
const CAROL_ID = "33333333-3333-4333-8333-333333333333"; // store_staff of acme
const CAROL: Credentials = { email: "carol@example.com", password: "Carol-Password-123!" };

const ACME_ID = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const GLOBEX_ID = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const ROLE_TENANT_ADMIN_ACME = "cccccccc-1111-4111-8111-cccccccccccc";
const ROLE_STORE_STAFF_ACME = "dddddddd-1111-4111-8111-dddddddddddd";

// One store per scenario, so the scenarios never share zone or shift state.
const STORE_CHANGE = "10000000-aaaa-4aaa-8aaa-000000000001";
const STORE_STALE = "10000000-aaaa-4aaa-8aaa-000000000002";
const STORE_OPEN_SHIFT = "10000000-aaaa-4aaa-8aaa-000000000003";
const STORE_CLOSED_SHIFT = "10000000-aaaa-4aaa-8aaa-000000000004";
const STORE_RACE_SHIFT_FIRST = "10000000-aaaa-4aaa-8aaa-000000000005";
const STORE_RACE_CHANGE_FIRST = "10000000-aaaa-4aaa-8aaa-000000000006";
const STORE_MISC = "10000000-aaaa-4aaa-8aaa-000000000007";
const STORE_GLOBEX = "20000000-bbbb-4bbb-8bbb-000000000001";

const DEVICE = {
  openShift: "30000000-aaaa-4aaa-8aaa-000000000003",
  closedShift: "30000000-aaaa-4aaa-8aaa-000000000004",
  raceShiftFirst: "30000000-aaaa-4aaa-8aaa-000000000005",
  raceChangeFirst: "30000000-aaaa-4aaa-8aaa-000000000006",
};

/** Every scenario store starts on UTC, so a change previews from it. */
const REVIEWED_FROM_UTC = { expected_current_timezone: "UTC", timezone_impact_reviewed: true };
const CHANGE_TO_CAIRO = { timezone: "Africa/Cairo", ...REVIEWED_FROM_UTC };
const CHANGE_TO_TOKYO = { timezone: "Asia/Tokyo", ...REVIEWED_FROM_UTC };
const CHANGE_TO_UNKNOWN = { timezone: "Mars/Olympus_Mons", ...REVIEWED_FROM_UTC };

/** The device scope each shift-bearing store opens its shifts under. */
const SCOPE: Record<"openShift" | "closedShift" | "raceShiftFirst" | "raceChangeFirst", DeviceScope> = {
  openShift: { tenantId: ACME_ID, storeId: STORE_OPEN_SHIFT, deviceId: DEVICE.openShift },
  closedShift: { tenantId: ACME_ID, storeId: STORE_CLOSED_SHIFT, deviceId: DEVICE.closedShift },
  raceShiftFirst: { tenantId: ACME_ID, storeId: STORE_RACE_SHIFT_FIRST, deviceId: DEVICE.raceShiftFirst },
  raceChangeFirst: { tenantId: ACME_ID, storeId: STORE_RACE_CHANGE_FIRST, deviceId: DEVICE.raceChangeFirst },
};

/** 22:30 UTC on 5 Oct is already 6 Oct in Tokyo (UTC+9, no DST). */
const LATE_EVENING_UTC = new Date("2026-10-05T22:30:00Z");

// ---- Bootstrap -----------------------------------------------------------

let env: PgTestEnv | null = null;
let app: INestApplication | null = null;
let dockerSkipped = false;
const shifts = new ShiftCashUpRepository();

function admin(): Pool {
  if (!env) throw new Error("env not initialized");
  return env.admin;
}

async function seed(): Promise<void> {
  const pg = admin();
  await pg.query(
    `INSERT INTO users (id, email, password_hash, is_platform_admin)
     VALUES ($1, $2, $3, false), ($4, $5, $6, false)`,
    [
      BOB_ID, BOB.email, await hashPassword(BOB.password),
      CAROL_ID, CAROL.email, await hashPassword(CAROL.password),
    ],
  );
  await pg.query(
    `INSERT INTO tenants (id, slug, name) VALUES ($1, 'acme', 'Acme'), ($2, 'globex', 'Globex')`,
    [ACME_ID, GLOBEX_ID],
  );
  await pg.query(
    `INSERT INTO roles (id, tenant_id, code, name) VALUES
       ($1, $2, 'tenant_admin', 'Tenant Admin'),
       ($3, $2, 'store_staff', 'Store Staff')`,
    [ROLE_TENANT_ADMIN_ACME, ACME_ID, ROLE_STORE_STAFF_ACME],
  );
  await pg.query(
    `INSERT INTO memberships (id, tenant_id, user_id, role_id, store_access_kind) VALUES
       ($1, $2, $3, $4, 'all'),
       ($5, $2, $6, $7, 'all')`,
    [
      randomUUID(), ACME_ID, BOB_ID, ROLE_TENANT_ADMIN_ACME,
      randomUUID(), CAROL_ID, ROLE_STORE_STAFF_ACME,
    ],
  );
  const acmeStores = [
    STORE_CHANGE, STORE_STALE, STORE_OPEN_SHIFT, STORE_CLOSED_SHIFT,
    STORE_RACE_SHIFT_FIRST, STORE_RACE_CHANGE_FIRST, STORE_MISC,
  ];
  for (const [i, id] of acmeStores.entries()) {
    await pg.query(
      `INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $2, $3, $3)`,
      [id, ACME_ID, `TZ-${i}`],
    );
  }
  await pg.query(
    `INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $2, 'G-1', 'Globex 1')`,
    [STORE_GLOBEX, GLOBEX_ID],
  );
  const deviceStores: Array<[string, string]> = [
    [DEVICE.openShift, STORE_OPEN_SHIFT],
    [DEVICE.closedShift, STORE_CLOSED_SHIFT],
    [DEVICE.raceShiftFirst, STORE_RACE_SHIFT_FIRST],
    [DEVICE.raceChangeFirst, STORE_RACE_CHANGE_FIRST],
  ];
  for (const [i, [deviceId, storeId]] of deviceStores.entries()) {
    await pg.query(
      `INSERT INTO devices (id, tenant_id, store_id, token_hash)
       VALUES ($1, $2, $3, decode(repeat($4, 32), 'hex'))`,
      [deviceId, ACME_ID, storeId, `c${i}`],
    );
  }
}

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    await seed();
    const moduleRef = await Test.createTestingModule({
      imports: [AuthModule, ContextModule, StoresModule],
    })
      .overrideProvider(PG_POOL)
      .useValue(env.app)
      .overrideProvider(REDIS_CLIENT)
      .useValue(new AlwaysAllowRedis())
      .overrideProvider(EMAIL_JOB_ENQUEUER)
      .useValue(new NoOpEmailJobEnqueuer())
      .compile();
    app = moduleRef.createNestApplication({ bufferLogs: true });
    app.use(cookieParser());
    app.useGlobalInterceptors(
      new RequestIdInterceptor(),
      new LoggingInterceptor(createLogger({ service: "api-test", level: "silent" })),
      new ContextInterceptor(),
    );
    app.useGlobalFilters(new GlobalExceptionFilter());
    app.useGlobalPipes(new ZodValidationPipe());
    await app.init();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[stores.timezone] Docker NOT AVAILABLE: ${msg}\n`);
      dockerSkipped = true;
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }
}, 180_000);

afterAll(async () => {
  if (app) await app.close().catch(() => undefined);
  if (env) await stopPgEnv(env);
}, 60_000);

function maybeSkip(): boolean {
  if (dockerSkipped) {
    // eslint-disable-next-line no-console
    console.warn("[stores.timezone] skipping (Docker unavailable)");
    return true;
  }
  return false;
}

function http() {
  if (!app) throw new Error("app not initialized");
  return request(app.getHttpServer());
}

const cookies = new Map<string, string>();

/** Sign in and select acme; cached per user. */
async function cookieFor(user: Credentials): Promise<string> {
  const { email, password } = user;
  const cached = cookies.get(email);
  if (cached) return cached;
  const res = await http().post("/api/v1/auth/signin").send({ email, password }).expect(200);
  const setCookie = res.headers["set-cookie"];
  const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const cookie = list.find((c: string) => c.startsWith("dp2_session="))?.split(";")[0];
  if (!cookie) throw new Error(`signIn(${email}): no session cookie`);
  await http()
    .post("/api/v1/context/tenant")
    .set("Cookie", cookie)
    .send({ tenant_id: ACME_ID })
    .expect(200);
  cookies.set(email, cookie);
  return cookie;
}

const bob = () => cookieFor(BOB);
const carol = () => cookieFor(CAROL);

async function storeZone(storeId: string): Promise<string> {
  const r = await admin().query<{ timezone: string }>(
    `SELECT timezone FROM stores WHERE id = $1`,
    [storeId],
  );
  return r.rows[0]!.timezone;
}

async function zoneAudits(storeId: string): Promise<Array<{ metadata: unknown; actor_user_id: string; request_id: string | null }>> {
  const r = await admin().query(
    `SELECT metadata, actor_user_id, request_id FROM audit_events
      WHERE action = 'store.timezone.changed' AND store_id = $1`,
    [storeId],
  );
  return r.rows;
}

function inAcme<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  return runWithTenantContext(env!.app, { tenantId: ACME_ID, isPlatformAdmin: false }, work);
}

function newShift(openedAt: Date): NewCashUpShift {
  const shiftId = randomUUID();
  return {
    shiftId,
    openedAt: openedAt.toISOString(),
    openingUserId: BOB_ID,
    currencyCode: "EGP",
    openingFloat: "0.00",
    recordedByUserId: BOB_ID,
    payloadHash: createHash("sha256").update(`open:${shiftId}`).digest(),
  };
}

async function openShift(
  client: PoolClient,
  s: DeviceScope,
  openedAt = new Date("2026-10-05T08:00:00Z"),
): Promise<CashUpShiftRow> {
  const outcome = await shifts.insertShift(client, s, newShift(openedAt));
  if (outcome.kind !== "inserted") throw new Error(`open failed: ${outcome.kind}`);
  return outcome.shift;
}

/** A promise and the function that resolves it. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open: () => void = () => undefined;
  const wait = new Promise<void>((resolve) => { open = resolve; });
  return { wait, open };
}

/** True when `p` has not settled within `ms`. */
async function stillPending(p: Promise<unknown>, ms = 400): Promise<boolean> {
  const marker = Symbol("pending");
  const winner = await Promise.race([
    p.then(() => null, () => null),
    new Promise((r) => setTimeout(() => r(marker), ms)),
  ]);
  return winner === marker;
}

// ===== Create ===============================================================

describe("POST /api/v1/stores with timezone", () => {
  it("201 stores the supplied zone and returns it", async () => {
    if (maybeSkip()) return;
    const res = await http()
      .post("/api/v1/stores")
      .set("Cookie", await bob())
      .send({ code: "NEW-TZ", name: "New TZ", timezone: "Africa/Cairo" })
      .expect(201);
    expect(res.body.timezone).toBe("Africa/Cairo");
    expect(await storeZone(res.body.id)).toBe("Africa/Cairo");
  });

  it("201 without timezone defaults to UTC (decision 213)", async () => {
    if (maybeSkip()) return;
    const res = await http()
      .post("/api/v1/stores")
      .set("Cookie", await bob())
      .send({ code: "NEW-UTC", name: "New UTC" })
      .expect(201);
    expect(res.body.timezone).toBe("UTC");
  });

  it("400 validation_error for a malformed zone; 400 invalid_timezone for an unknown one", async () => {
    if (maybeSkip()) return;
    const malformed = await http()
      .post("/api/v1/stores")
      .set("Cookie", await bob())
      .send({ code: "BAD-1", name: "Bad", timezone: "UTC+2" })
      .expect(400);
    expect(malformed.body.error.code).toBe("validation_error");
    const unknown = await http()
      .post("/api/v1/stores")
      .set("Cookie", await bob())
      .send({ code: "BAD-2", name: "Bad", timezone: "Mars/Olympus_Mons" })
      .expect(400);
    expect(unknown.body.error.code).toBe("invalid_timezone");
    const r = await admin().query(`SELECT 1 FROM stores WHERE code IN ('BAD-1', 'BAD-2')`);
    expect(r.rowCount).toBe(0);
  });
});

// ===== Read =================================================================

describe("GET /api/v1/stores exposes timezone", () => {
  it("list and read carry the zone", async () => {
    if (maybeSkip()) return;
    const list = await http().get("/api/v1/stores").set("Cookie", await bob()).expect(200);
    const misc = list.body.find((s: { id: string }) => s.id === STORE_MISC);
    expect(misc.timezone).toBe("UTC");
    const read = await http().get(`/api/v1/stores/${STORE_MISC}`).set("Cookie", await bob()).expect(200);
    expect(read.body.timezone).toBe("UTC");
  });
});

// ===== Preview ==============================================================

describe("GET /api/v1/stores/:store_id/timezone-change-preview", () => {
  const url = (target: { storeId: string; zone: string }) =>
    `/api/v1/stores/${target.storeId}/timezone-change-preview?timezone=${encodeURIComponent(target.zone)}`;

  it("200 reports both zones as PostgreSQL computes them, and writes nothing", async () => {
    if (maybeSkip()) return;
    // Pacific/Kiritimati is UTC+14 with no DST, so its offset is fixed.
    const res = await http().get(url({ storeId: STORE_MISC, zone: "Pacific/Kiritimati" })).set("Cookie", await bob()).expect(200);
    const expected = await admin().query<{ utc: string; kiri: string }>(
      `SELECT ($1::timestamptz AT TIME ZONE 'UTC')::date::text AS utc,
              ($1::timestamptz AT TIME ZONE 'Pacific/Kiritimati')::date::text AS kiri`,
      [res.body.now],
    );
    expect(res.body).toEqual({
      store_id: STORE_MISC,
      current_timezone: "UTC",
      proposed_timezone: "Pacific/Kiritimati",
      no_op: false,
      now: expect.any(String),
      utc_offset_minutes_current: 0,
      utc_offset_minutes_proposed: 840,
      business_date_current: expected.rows[0]!.utc,
      business_date_proposed: expected.rows[0]!.kiri,
      business_date_changes_now: expected.rows[0]!.utc !== expected.rows[0]!.kiri,
      open_shift_count: 0,
      blockers: [],
      can_apply: true,
      caveats: ["offline_shifts_not_visible", "uncaptured_sales_use_new_zone"],
    });
    expect(await storeZone(STORE_MISC)).toBe("UTC");
    expect(await zoneAudits(STORE_MISC)).toHaveLength(0);
  });

  it("the current zone is a no-op", async () => {
    if (maybeSkip()) return;
    const res = await http().get(url({ storeId: STORE_MISC, zone: "UTC" })).set("Cookie", await bob()).expect(200);
    expect(res.body.no_op).toBe(true);
    expect(res.body.can_apply).toBe(false);
  });

  it("400 for a malformed or unknown zone", async () => {
    if (maybeSkip()) return;
    const malformed = await http().get(url({ storeId: STORE_MISC, zone: "EET" })).set("Cookie", await bob()).expect(400);
    expect(malformed.body.error.code).toBe("validation_error");
    const unknown = await http().get(url({ storeId: STORE_MISC, zone: "Mars/Olympus_Mons" })).set("Cookie", await bob()).expect(400);
    expect(unknown.body.error.code).toBe("invalid_timezone");
  });

  it("404 for store_staff, another tenant's store, or an unknown store", async () => {
    if (maybeSkip()) return;
    await http().get(url({ storeId: STORE_MISC, zone: "Africa/Cairo" })).set("Cookie", await carol()).expect(404);
    await http().get(url({ storeId: STORE_GLOBEX, zone: "Africa/Cairo" })).set("Cookie", await bob()).expect(404);
    await http().get(url({ storeId: randomUUID(), zone: "Africa/Cairo" })).set("Cookie", await bob()).expect(404);
  });
});

// ===== Change ===============================================================

describe("PATCH /api/v1/stores/:store_id timezone change", () => {
  it("200 commits the change with one store.timezone.changed audit row", async () => {
    if (maybeSkip()) return;
    const requestId = randomUUID();
    const res = await http()
      .patch(`/api/v1/stores/${STORE_CHANGE}`)
      .set("Cookie", await bob())
      .set("X-Request-Id", requestId)
      .send(CHANGE_TO_CAIRO)
      .expect(200);
    expect(res.body.timezone).toBe("Africa/Cairo");
    expect(await storeZone(STORE_CHANGE)).toBe("Africa/Cairo");
    expect(await zoneAudits(STORE_CHANGE)).toEqual([
      {
        metadata: { store_id: STORE_CHANGE, from: "UTC", to: "Africa/Cairo" },
        actor_user_id: BOB_ID,
        request_id: requestId,
      },
    ]);
  });

  it("setting the current zone again is a no-op: 200, no audit row", async () => {
    if (maybeSkip()) return;
    await http()
      .patch(`/api/v1/stores/${STORE_CHANGE}`)
      .set("Cookie", await bob())
      .send({
        timezone: "Africa/Cairo",
        expected_current_timezone: "Africa/Cairo",
        timezone_impact_reviewed: true,
      })
      .expect(200);
    expect(await zoneAudits(STORE_CHANGE)).toHaveLength(1);
  });

  it("409 timezone_changed_concurrently for a stale expected zone; nothing written", async () => {
    if (maybeSkip()) return;
    await admin().query(`UPDATE stores SET timezone = 'Europe/London' WHERE id = $1`, [STORE_STALE]);
    const res = await http()
      .patch(`/api/v1/stores/${STORE_STALE}`)
      .set("Cookie", await bob())
      .send({ ...CHANGE_TO_CAIRO, name: "Renamed" })
      .expect(409);
    expect(res.body.error.code).toBe("timezone_changed_concurrently");
    expect(await storeZone(STORE_STALE)).toBe("Europe/London");
    const r = await admin().query(`SELECT name FROM stores WHERE id = $1`, [STORE_STALE]);
    expect(r.rows[0].name).not.toBe("Renamed");
    expect(await zoneAudits(STORE_STALE)).toHaveLength(0);
  });

  it("400 invalid_timezone for an unknown zone; nothing written", async () => {
    if (maybeSkip()) return;
    const res = await http()
      .patch(`/api/v1/stores/${STORE_MISC}`)
      .set("Cookie", await bob())
      .send(CHANGE_TO_UNKNOWN)
      .expect(400);
    expect(res.body.error.code).toBe("invalid_timezone");
    expect(await storeZone(STORE_MISC)).toBe("UTC");
  });

  it("400 when timezone travels without its companions", async () => {
    if (maybeSkip()) return;
    const res = await http()
      .patch(`/api/v1/stores/${STORE_MISC}`)
      .set("Cookie", await bob())
      .send({ timezone: "Africa/Cairo" })
      .expect(400);
    expect(res.body.error.code).toBe("validation_error");
  });

  it("409 store_has_open_shift while a shift is open; the preview shows the blocker", async () => {
    if (maybeSkip()) return;
    await inAcme((c) => openShift(c, SCOPE.openShift));

    const preview = await http()
      .get(`/api/v1/stores/${STORE_OPEN_SHIFT}/timezone-change-preview?timezone=Africa%2FCairo`)
      .set("Cookie", await bob())
      .expect(200);
    expect(preview.body.open_shift_count).toBe(1);
    expect(preview.body.blockers).toEqual([{ code: "store_has_open_shift", count: 1 }]);
    expect(preview.body.can_apply).toBe(false);

    const res = await http()
      .patch(`/api/v1/stores/${STORE_OPEN_SHIFT}`)
      .set("Cookie", await bob())
      .send(CHANGE_TO_CAIRO)
      .expect(409);
    expect(res.body.error.code).toBe("store_has_open_shift");
    expect(await storeZone(STORE_OPEN_SHIFT)).toBe("UTC");
    expect(await zoneAudits(STORE_OPEN_SHIFT)).toHaveLength(0);
  });

  it("404 for store_staff and for another tenant's store", async () => {
    if (maybeSkip()) return;
    await http()
      .patch(`/api/v1/stores/${STORE_MISC}`)
      .set("Cookie", await carol())
      .send(CHANGE_TO_CAIRO)
      .expect(404);
    await http()
      .patch(`/api/v1/stores/${STORE_GLOBEX}`)
      .set("Cookie", await bob())
      .send(CHANGE_TO_CAIRO)
      .expect(404);
    expect(await storeZone(STORE_MISC)).toBe("UTC");
    expect(await storeZone(STORE_GLOBEX)).toBe("UTC");
  });
});

// ===== FR-009: persisted business dates are not rewritten ===================

describe("FR-009 / decision 215", () => {
  it("a closed shift keeps the business date it was opened under", async () => {
    if (maybeSkip()) return;
    const shift = await inAcme((c) => openShift(c, SCOPE.closedShift, LATE_EVENING_UTC));
    expect(shift.businessDate).toBe("2026-10-05");
    await inAcme((c) =>
      shifts.insertClose(c, shift, {
        closedAt: "2026-10-05T23:00:00Z",
        closingUserId: BOB_ID,
        closeKind: "normal",
        forcedReason: null,
        openingFloat: "0.00",
        cashSalesTotal: "0.00",
        cashRefundsTotal: "0.00",
        payInTotal: "0.00",
        payOutTotal: "0.00",
        expectedCash: "0.00",
        countedCash: "0.00",
        variance: "0.00",
        saleCount: 0,
        cashRefundReturnRefs: [],
        varianceApprovedByUserId: null,
        recordedByUserId: BOB_ID,
        payloadHash: createHash("sha256").update(`close:${shift.shiftId}`).digest(),
      }),
    );

    await http()
      .patch(`/api/v1/stores/${STORE_CLOSED_SHIFT}`)
      .set("Cookie", await bob())
      .send(CHANGE_TO_TOKYO)
      .expect(200);

    const r = await admin().query<{ business_date: string; lifecycle_state: string }>(
      `SELECT business_date::text AS business_date, lifecycle_state FROM shifts WHERE shift_id = $1`,
      [shift.shiftId],
    );
    expect(r.rows[0]).toEqual({ business_date: "2026-10-05", lifecycle_state: "closed" });
  });
});

// ===== FR-007: shift open and zone change cannot interleave =================

describe("FR-007 — the store row lock", () => {
  it("a change that races an uncommitted shift open waits for it, then refuses", async () => {
    if (maybeSkip()) return;
    const opened = gate();
    const release = gate();
    const shiftTx = inAcme(async (c) => {
      await openShift(c, SCOPE.raceShiftFirst);
      opened.open();
      await release.wait; // hold the shift open, uncommitted, with FOR SHARE on the store
    });
    await opened.wait;

    const patch = http()
      .patch(`/api/v1/stores/${STORE_RACE_SHIFT_FIRST}`)
      .set("Cookie", await bob())
      .send(CHANGE_TO_TOKYO)
      .then((res) => res);
    expect(await stillPending(patch)).toBe(true);

    release.open();
    await shiftTx;
    const res = await patch;
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("store_has_open_shift");
    expect(await storeZone(STORE_RACE_SHIFT_FIRST)).toBe("UTC");
  });

  it("a shift open that races an uncommitted change waits for it, then takes the new zone", async () => {
    if (maybeSkip()) return;
    const locked = gate();
    const release = gate();
    // Stand-in for the change transaction: the row lock and write it takes.
    const changeTx = inAcme(async (c) => {
      await c.query(`SELECT 1 FROM stores WHERE id = $1 FOR UPDATE`, [STORE_RACE_CHANGE_FIRST]);
      await c.query(`UPDATE stores SET timezone = 'Asia/Tokyo' WHERE id = $1`, [STORE_RACE_CHANGE_FIRST]);
      locked.open();
      await release.wait;
    });
    await locked.wait;

    const shiftOpen = inAcme((c) => openShift(c, SCOPE.raceChangeFirst, LATE_EVENING_UTC));
    expect(await stillPending(shiftOpen)).toBe(true);

    release.open();
    await changeTx;
    const shift = await shiftOpen;
    expect(shift.businessDate).toBe("2026-10-06");
  });
});
