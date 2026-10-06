/**
 * Shared Testcontainers harness for the RT-17 slice 2b shift cash-up HTTP
 * suites ([GATED] approval: Jira RT-17 comments 10760 + 10919 + 10920).
 *
 * Wiring mirrors production, as the RT-224 captureSale device-path suite
 * does: the real PosShiftsModule (ShiftCashUpAuthGuard → the real
 * PosOperatorEnvelopeSaleGuard / PosDeviceAuthGuard + the real
 * PgOperatorAttributionVerifier, the real rate-limit guard, idempotency and
 * audit interceptors) and the real PosOperatorsModule for the manager
 * envelope sign-in; AUTH_LOOKUP_POOL = the RLS-exempt admin pool, PG_POOL =
 * the NOBYPASSRLS `app_test` role (every shift query runs under the tenant
 * GUC and the 0002 / 0036 policies); and the GLOBAL FailClosedAuthGuard, so
 * the routes' @DeviceBearer marker is exercised as the app runs it.
 * Substituted: the Clerk JWKS check, the audit fan-out (a spy), the
 * rate-limiter decision (a recording switch that denies one bucket and key,
 * to prove the 429 shape and the per-device key on both paths) and the log
 * destination (every logger of the graph, plus the production
 * LoggingInterceptor, writes to one in-memory capture, RT-17 10931).
 *
 * Response bodies are checked against `pos-shifts.openapi.yaml` with AJV.
 */
import "reflect-metadata";

import { randomUUID } from "node:crypto";

import type { INestApplication } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { hashToken } from "@data-pulse-2/auth";
import { createLogger, type Logger } from "@data-pulse-2/shared";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import cookieParser from "cookie-parser";
import type { Pool } from "pg";
import request from "supertest";

import { AUDIT_JOB_ENQUEUER, type AuditJobEnqueuer } from "../../../src/audit/audit-job.enqueuer";
import type { AuditJobPayload } from "../../../src/audit/audit-job.types";
import { AUTH_LOOKUP_POOL, AuthModule, PG_POOL } from "../../../src/auth/auth.module";
import { FailClosedAuthGuard } from "../../../src/auth/fail-closed-auth.guard";
import { RateLimiter, type RateLimitDecision } from "../../../src/auth/rate-limit";
import { GlobalExceptionFilter } from "../../../src/common/exception.filter";
import { LoggingInterceptor, ROOT_LOGGER } from "../../../src/common/logging.interceptor";
import { RootLoggerModule } from "../../../src/common/root-logger.module";
import { RequestIdInterceptor } from "../../../src/common/request-id.interceptor";
import { ZodValidationPipe } from "../../../src/common/zod-validation.pipe";
import { loadOpenApiContracts } from "../../../src/openapi/loader";
import { CLERK_VERIFIER, type ClerkVerifier } from "../../../src/pos-operators/clerk-verifier";
import { PosOperatorsModule } from "../../../src/pos-operators/pos-operators.module";
import { POS_SHIFTS_LOGGER, PosShiftsModule } from "../../../src/pos-shifts/pos-shifts.module";
import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../_helpers/postgres-container";

// No real Redis: the idempotency store reads through to its Postgres mirror.
delete process.env["REDIS_URL"];

// ---------------------------------------------------------------------------
// Fixtures (UUID v4 shape, hex-only suffixes)
// ---------------------------------------------------------------------------
export const TENANT_A = "0e170000-0000-4000-8000-0000000a0001";
export const TENANT_B = "0e170000-0000-4000-8000-0000000b0001";
export const STORE_A1 = "0e170000-0000-4000-8000-0000000a5001";
export const STORE_A2 = "0e170000-0000-4000-8000-0000000a5002";
export const STORE_B1 = "0e170000-0000-4000-8000-0000000b5001";
const ROLE_A_STAFF = "0e170000-0000-4000-8000-0000000a7001";
const ROLE_A_MANAGER = "0e170000-0000-4000-8000-0000000a7002";
const ROLE_B_STAFF = "0e170000-0000-4000-8000-0000000b7001";

/** A seeded user: its id, membership and tenant. */
export interface FixtureUser {
  readonly id: string;
  readonly membership: string;
  readonly tenant: string;
}

/** A fixture user: a 4-hex-digit suffix for its user and membership ids, and its tenant. */
const fixtureUser = (spec: { suffix: string; tenant: string }): FixtureUser => ({
  id: `0e170000-0000-4000-8000-0000000c${spec.suffix}`,
  membership: `0e170000-0000-4000-8000-0000000d${spec.suffix}`,
  tenant: spec.tenant,
});

/** Tenant A cashier, access to every store; admitted on every tenant A till. */
export const CASHIER = fixtureUser({ suffix: "0001", tenant: TENANT_A });
/** Tenant A cashier with NO admission anywhere. */
export const CASHIER_UNADMITTED = fixtureUser({ suffix: "0002", tenant: TENANT_A });
/** Tenant A manager with access to store A1 (the envelope operator). */
export const MANAGER = fixtureUser({ suffix: "0003", tenant: TENANT_A });
/** Tenant A cashier with access to store A2 only. */
export const CASHIER_A2_ONLY = fixtureUser({ suffix: "0004", tenant: TENANT_A });
/** Tenant B cashier, admitted on the tenant B till. */
export const CASHIER_B = fixtureUser({ suffix: "0005", tenant: TENANT_B });

/** A seeded till: its id, bearer token and scope. */
export interface FixtureDevice {
  readonly id: string;
  readonly token: string;
  readonly tenant: string;
  readonly store: string;
}

/** A fixture till: a 4-hex-digit suffix for its id and token, and its scope. */
const device = (spec: { suffix: string; tenant: string; store: string }): FixtureDevice => ({
  id: `0e170000-0000-4000-8000-0000000e${spec.suffix}`,
  token: `rt17-s2b-device-token-${spec.suffix}`,
  tenant: spec.tenant,
  store: spec.store,
});

export const DEV_A1 = device({ suffix: "0001", tenant: TENANT_A, store: STORE_A1 });
export const DEV_A1_SECOND = device({ suffix: "0002", tenant: TENANT_A, store: STORE_A1 });
export const DEV_A2 = device({ suffix: "0003", tenant: TENANT_A, store: STORE_A2 });
export const DEV_B1 = device({ suffix: "0004", tenant: TENANT_B, store: STORE_B1 });
const ALL_DEVICES = [DEV_A1, DEV_A1_SECOND, DEV_A2, DEV_B1];

const MANAGER_SUB = "user_clerk_rt17_s2b_manager";
const MANAGER_JWT = "jwt-rt17-s2b-manager";

export const OPEN_PATH = "/api/pos/v1/shifts";
export const movementPath = (shiftId: string): string => `/api/pos/v1/shifts/${shiftId}/cash-movements`;
export const closePath = (shiftId: string): string => `/api/pos/v1/shifts/${shiftId}/close`;

/** An instant `minutesAgo` minutes before now (inside every seeded admission window). */
export const minutesAgo = (minutes: number): string => new Date(Date.now() - minutes * 60_000).toISOString();

/** The same instant as `instant` (a `Z` timestamp), written at a whole-hour UTC offset ("+02:00", "-05:00"). */
export function atOffset(instant: string, hours: number): string {
  const local = new Date(Date.parse(instant) + hours * 3_600_000).toISOString().slice(0, -1);
  const sign = hours < 0 ? "-" : "+";
  return `${local}${sign}${String(Math.abs(hours)).padStart(2, "0")}:00`;
}

// ---------------------------------------------------------------------------
// Substitutes
// ---------------------------------------------------------------------------
class StubClerkVerifier implements ClerkVerifier {
  async verify(rawJwt: string): Promise<{ sub: string }> {
    if (rawJwt !== MANAGER_JWT) throw new Error("StubClerkVerifier: unknown jwt");
    return { sub: MANAGER_SUB };
  }
}

export class SpyAuditEnqueuer implements AuditJobEnqueuer {
  readonly payloads: AuditJobPayload[] = [];
  async enqueue(payload: AuditJobPayload): Promise<void> {
    this.payloads.push(payload);
  }
}

/** One limiter check: the bucket and the key it was asked about. */
export interface LimiterCall {
  readonly bucket: string;
  readonly key: string;
}

/**
 * The per-device limiter, recording every check. It denies exactly the
 * `posWriteShift` bucket for `denyKey` (null: allow everything), so a 429
 * proves the guard asked about the right bucket AND the right device.
 */
export class SwitchRateLimiter {
  denyKey: string | null = null;
  readonly calls: LimiterCall[] = [];
  async check(bucket: string, key: string): Promise<RateLimitDecision> {
    this.calls.push({ bucket, key });
    const allowed = !(bucket === "posWriteShift" && key === this.denyKey);
    return { allowed, count: 1, remaining: 0, resetMs: 30_000 };
  }
  async release(): Promise<void> {}
}

/** Every log line any logger of the app wrote, as raw JSON text. */
export class LogCapture {
  readonly lines: string[] = [];
  readonly logger: Logger = createLogger({
    service: "api",
    level: "trace",
    destination: { write: (line: string) => void this.lines.push(line) },
  });
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------
export interface Harness {
  readonly env: PgTestEnv;
  readonly app: INestApplication;
  readonly audit: SpyAuditEnqueuer;
  readonly limiter: SwitchRateLimiter;
  readonly logs: LogCapture;
}

/** The test doubles the app is built with. */
interface Doubles {
  readonly audit: SpyAuditEnqueuer;
  readonly limiter: SwitchRateLimiter;
  readonly logs: LogCapture;
}

let harness: Harness | null = null;

export function h(): Harness {
  if (!harness) throw new Error("harness not started");
  return harness;
}

/** True (and warns) when Docker was unavailable and the suite is skipping. */
export function skipped(): boolean {
  return harness === null;
}

export function admin(): Pool {
  return h().env.admin;
}

export function http(): ReturnType<typeof request> {
  return request(h().app.getHttpServer());
}

async function seedPeople(a: Pool): Promise<void> {
  await a.query(
    `INSERT INTO tenants (id, slug, name) VALUES ($1, 'rt17-s2b-a', 'RT-17 A'), ($2, 'rt17-s2b-b', 'RT-17 B')`,
    [TENANT_A, TENANT_B],
  );
  await a.query(
    `INSERT INTO roles (id, tenant_id, code, name) VALUES
       ($1, $4, 'store_staff', 'Cashier'), ($2, $4, 'store_manager', 'Manager'),
       ($3, $5, 'store_staff', 'Cashier')`,
    [ROLE_A_STAFF, ROLE_A_MANAGER, ROLE_B_STAFF, TENANT_A, TENANT_B],
  );
  await a.query(
    `INSERT INTO stores (id, tenant_id, code, name, timezone) VALUES
       ($1, $4, 'A1', 'Store A1', 'Africa/Cairo'), ($2, $4, 'A2', 'Store A2', 'UTC'),
       ($3, $5, 'B1', 'Store B1', 'UTC')`,
    [STORE_A1, STORE_A2, STORE_B1, TENANT_A, TENANT_B],
  );
  const users: Array<[FixtureUser, string, string, string]> = [
    [CASHIER, "cashier", ROLE_A_STAFF, "all"],
    [CASHIER_UNADMITTED, "unadmitted", ROLE_A_STAFF, "all"],
    [MANAGER, "manager", ROLE_A_MANAGER, "specific"],
    [CASHIER_A2_ONLY, "a2only", ROLE_A_STAFF, "specific"],
    [CASHIER_B, "cashierb", ROLE_B_STAFF, "all"],
  ];
  for (const [user, label, role, access] of users) {
    const clerk = user === MANAGER ? MANAGER_SUB : `user_clerk_rt17_s2b_${label}`;
    await a.query(
      `INSERT INTO users (id, email, display_name, clerk_user_id) VALUES ($1, $2, $3, $4)`,
      [user.id, `${label}@rt17-s2b.example`, label, clerk],
    );
    await a.query(
      `INSERT INTO memberships (id, tenant_id, user_id, role_id, store_access_kind) VALUES ($1, $2, $3, $4, $5)`,
      [user.membership, user.tenant, user.id, role, access],
    );
  }
  await a.query(
    `INSERT INTO store_access (membership_id, store_id, tenant_id) VALUES ($1, $3, $5), ($2, $4, $5)`,
    [MANAGER.membership, CASHIER_A2_ONLY.membership, STORE_A1, STORE_A2, TENANT_A],
  );
}

async function seedDevices(a: Pool): Promise<void> {
  for (const d of ALL_DEVICES) {
    await a.query(
      `INSERT INTO devices (id, tenant_id, store_id, label, token_hash) VALUES ($1, $2, $3, $4, $5)`,
      [d.id, d.tenant, d.store, `till-${d.id.slice(-4)}`, hashToken(d.token)],
    );
  }
  // Admission windows (created 24 h ago, until 48 h from now) covering every
  // fact time these suites use: CASHIER on each tenant A till, CASHIER_B on
  // B1. A user holds one LIVE admission per store, so each row is stored
  // already ended at its expiry: the verifier reads ended rows by window.
  const admitted: Array<[FixtureUser, FixtureDevice]> = [
    ...[DEV_A1, DEV_A1_SECOND, DEV_A2].map((d): [FixtureUser, FixtureDevice] => [CASHIER, d]),
    [CASHIER_B, DEV_B1],
  ];
  for (const [user, d] of admitted) {
    await a.query(
      `INSERT INTO cashier_admissions
         (id, tenant_id, store_id, user_id, device_id, mode, created_at, renewed_at, expires_at,
          ended_at, end_reason)
       VALUES ($1, $2, $3, $4, $5, 'online', now() - interval '24 hours', now() - interval '24 hours',
               now() + interval '48 hours', now() + interval '48 hours', 'device_end')`,
      [randomUUID(), d.tenant, d.store, user.id, d.id],
    );
  }
}

async function buildApp(env: PgTestEnv, doubles: Doubles): Promise<INestApplication> {
  const { audit, limiter, logs } = doubles;
  const moduleRef = await Test.createTestingModule({
    imports: [RootLoggerModule, AuthModule, PosOperatorsModule, PosShiftsModule],
    providers: [{ provide: APP_GUARD, useClass: FailClosedAuthGuard }],
  })
    .overrideProvider(PG_POOL)
    .useValue(env.app)
    .overrideProvider(AUTH_LOOKUP_POOL)
    .useValue(env.admin)
    .overrideProvider(CLERK_VERIFIER)
    .useValue(new StubClerkVerifier())
    .overrideProvider(AUDIT_JOB_ENQUEUER)
    .useValue(audit)
    .overrideProvider(RateLimiter)
    .useValue(limiter)
    .overrideProvider(ROOT_LOGGER)
    .useValue(logs.logger)
    .overrideProvider(POS_SHIFTS_LOGGER)
    .useValue(logs.logger)
    .compile();
  const app = moduleRef.createNestApplication({ bufferLogs: true, logger: false });
  app.use(cookieParser());
  app.useGlobalInterceptors(new RequestIdInterceptor(), new LoggingInterceptor(logs.logger));
  app.useGlobalFilters(new GlobalExceptionFilter());
  app.useGlobalPipes(new ZodValidationPipe());
  await app.init();
  return app;
}

export async function startHarness(label: string): Promise<void> {
  let env: PgTestEnv;
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[${label}] Docker NOT AVAILABLE — skipping: ${String(err)}\n`);
      return;
    }
    throw err;
  }
  await applyAllUpAndCreateAppRole(env);
  await seedPeople(env.admin);
  await seedDevices(env.admin);
  const doubles: Doubles = { audit: new SpyAuditEnqueuer(), limiter: new SwitchRateLimiter(), logs: new LogCapture() };
  harness = { env, app: await buildApp(env, doubles), ...doubles };
}

export async function stopHarness(): Promise<void> {
  if (!harness) return;
  await harness.app.close().catch(() => undefined);
  await stopPgEnv(harness.env);
  harness = null;
}

/**
 * Between tests: every open cash-up shift is closed (a cash-up shift can
 * never be deleted, and a device holds one open shift at most), legacy rows
 * are removed, envelopes are revoked, revoked memberships are restored, the
 * limiter allows and forgets, and the audit spy and the log capture are
 * emptied.
 */
export async function resetState(): Promise<void> {
  if (!harness) return;
  await closeOpenShifts();
  await admin().query(`DELETE FROM shifts WHERE source = 'legacy'`);
  await admin().query(`DELETE FROM auth_tokens WHERE scope = 'pos_operator'`);
  await admin().query(`UPDATE memberships SET revoked_at = NULL WHERE revoked_at IS NOT NULL`);
  harness.limiter.denyKey = null;
  harness.limiter.calls.length = 0;
  harness.audit.payloads.length = 0;
  harness.logs.lines.length = 0;
}

/** Closes every open cash-up shift with a zero-movement, zero-variance close. */
export async function closeOpenShifts(): Promise<void> {
  await admin().query(
    `INSERT INTO shift_closes
       (shift_id, tenant_id, store_id, device_id, currency_code, closed_at, closing_user_id,
        close_kind, opening_float, cash_sales_total, cash_refunds_total, pay_in_total,
        pay_out_total, expected_cash, counted_cash, variance, sale_count, recorded_by_user_id,
        payload_hash)
     SELECT shift_id, tenant_id, store_id, opening_device_id, currency_code, now(),
            opening_cashier_user_id, 'normal', opening_float, 0, 0, 0, 0, opening_float,
            opening_float, 0, 0, recorded_by_user_id, decode(repeat('ab', 32), 'hex')
       FROM shifts WHERE source = 'cash_up' AND lifecycle_state = 'open'`,
  );
  await admin().query(
    `UPDATE shifts SET lifecycle_state = 'closed' WHERE source = 'cash_up' AND lifecycle_state = 'open'`,
  );
}

/** A manager envelope bound to `d` (sign-in through the real operators route). */
export async function managerEnvelope(d: FixtureDevice = DEV_A1): Promise<string> {
  const res = await http()
    .post("/api/pos/v1/operators/sign-in")
    .set("Authorization", `Bearer ${MANAGER_JWT}`)
    .send({ kind: "manager_admin", device_token_attestation: d.token });
  if (res.status !== 200) throw new Error(`manager sign-in failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.operator_session.envelope as string;
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------
/** One cash-up POST: path, bearer (null = none), body and Idempotency-Key (null = none). */
export interface ShiftCall {
  readonly path: string;
  readonly bearer: string | null;
  readonly body: Record<string, unknown>;
  readonly key?: string | null | undefined;
}

export const newKey = (): string => randomUUID().replace(/-/g, "");

export function post(call: ShiftCall): request.Test {
  const req = http().post(call.path);
  const key = call.key === undefined ? newKey() : call.key;
  if (key !== null) req.set("Idempotency-Key", key);
  if (call.bearer !== null) req.set("Authorization", `Bearer ${call.bearer}`);
  return req.send(call.body);
}

/** A device-path open body for `user` (default CASHIER), EGP 500.00, opened 60 min ago. */
export function openBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    shiftId: randomUUID(),
    openedAt: minutesAgo(60),
    openingUserId: CASHIER.id,
    currencyCode: "EGP",
    openingFloat: "500.00",
    operatorUserId: CASHIER.id,
    ...overrides,
  };
}

/** A device-path pay-out body by CASHIER, EGP 120.00, 30 min ago. */
export function movementBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    movementId: randomUUID(),
    kind: "pay_out",
    amount: "120.00",
    reasonCode: "petty_expense",
    note: "Cleaning supplies",
    occurredAt: minutesAgo(30),
    operatorUserId: CASHIER.id,
    ...overrides,
  };
}

/** Opens a shift on `d` through the device path and returns its id (asserts 201). */
export async function openOn(d: FixtureDevice, overrides: Record<string, unknown> = {}): Promise<string> {
  const user = d.tenant === TENANT_B ? CASHIER_B.id : CASHIER.id;
  const body = openBody({ openingUserId: user, operatorUserId: user, ...overrides });
  const res = await post({ path: OPEN_PATH, bearer: d.token, body });
  if (res.status !== 201) throw new Error(`open failed: ${res.status} ${JSON.stringify(res.body)}`);
  return body["shiftId"] as string;
}

/**
 * A device-path normal close by CASHIER of a shift opened with EGP 500.00,
 * 5 minutes ago, arithmetically consistent: 500 + 2450 − 75 + 0 − 120 =
 * 2755 expected, 2750 counted, −5 variance.
 */
export function closeBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    closedAt: minutesAgo(5),
    closingUserId: CASHIER.id,
    closeKind: "normal",
    openingFloat: "500.00",
    cashSalesTotal: "2450.00",
    cashRefundsTotal: "75.00",
    payInTotal: "0.00",
    payOutTotal: "120.00",
    expectedCash: "2755.00",
    countedCash: "2750.00",
    variance: "-5.00",
    saleCount: 37,
    cashRefundReturnRefs: [],
    operatorUserId: CASHIER.id,
    ...overrides,
  };
}

/** A return to seed: the till whose tenant and store it belongs to, its currency and tender. */
export interface ReturnSeed {
  readonly at: FixtureDevice;
  readonly currency?: string;
  readonly cashTender?: boolean;
}

/** Seeds a sale and one return of it (EGP, cash-refunded unless told otherwise); returns the return id. */
export async function seedReturn(seed: ReturnSeed): Promise<string> {
  const [saleId, returnId] = [randomUUID(), randomUUID()];
  const creator = seed.at.tenant === TENANT_B ? CASHIER_B.id : CASHIER.id;
  const currency = seed.currency ?? "EGP";
  await admin().query(
    `INSERT INTO sales
       (id, tenant_id, store_id, currency_code, pos_total, occurred_at, business_date,
        source_system, external_id, payload_hash, created_by, device_id)
     VALUES ($1, $2, $3, $4, 100, now(), current_date, 'pos', $5, $6, $7, NULL)`,
    [saleId, seed.at.tenant, seed.at.store, currency, `sale-${saleId}`, "b".repeat(64), creator],
  );
  await admin().query(
    `INSERT INTO sale_returns
       (id, sale_id, tenant_id, store_id, return_seq, business_date, currency_code, return_total,
        source_system, external_id, payload_hash, created_by)
     VALUES ($1, $2, $3, $4, 1, current_date, $5, 25, 'pos', $6, $7, $8)`,
    [returnId, saleId, seed.at.tenant, seed.at.store, currency, `return-${returnId}`, "c".repeat(64), creator],
  );
  if (seed.cashTender ?? true) {
    await admin().query(
      `INSERT INTO sale_return_tenders (return_id, tenant_id, store_id, ordinal, method, amount)
       VALUES ($1, $2, $3, 0, 'cash', 25)`,
      [returnId, seed.at.tenant, seed.at.store],
    );
  }
  return returnId;
}

/**
 * Holds the shift's row lock on an admin connection (another transaction in
 * flight), so the next close of that shift waits. `release` rolls back.
 */
export async function holdShiftLock(shiftId: string): Promise<{ release: () => Promise<void> }> {
  const client = await admin().connect();
  await client.query("BEGIN");
  await client.query(`SELECT 1 FROM shifts WHERE shift_id = $1 FOR UPDATE`, [shiftId]);
  return {
    release: async () => {
      await client.query("ROLLBACK");
      client.release();
    },
  };
}

const LOCK_WAIT_TIMEOUT_MS = 10_000;

/** Polls until `count` backends wait on a lock (a two-connection barrier). */
export async function waitForLockWaiters(count = 1): Promise<void> {
  const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const r = await admin().query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted`);
    if ((r.rows[0]?.n ?? 0) >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`fewer than ${count} backends started waiting on a lock`);
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------
const CONTRACT_ID = "pos-shifts.openapi";
let ajv: Ajv | null = null;

function contractAjv(): Ajv {
  if (ajv) return ajv;
  const contract = loadOpenApiContracts().find((c) => c.id === CONTRACT_ID);
  if (!contract) throw new Error(`${CONTRACT_ID} not found`);
  ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);
  ajv.addSchema(contract.document as object, CONTRACT_ID);
  return ajv;
}

export type ContractSchema = "Shift" | "CashMovement" | "ApiError" | "IdempotencyInProgressBody";

/** The body satisfies the named contract schema. */
export function expectSchema(schema: ContractSchema, body: unknown): void {
  const v = contractAjv().getSchema(`${CONTRACT_ID}#/components/schemas/${schema}`);
  if (!v) throw new Error(`ajv cannot resolve ${schema}`);
  if (!v(body)) throw new Error(`${schema} mismatch: ${JSON.stringify(v.errors)} for ${JSON.stringify(body)}`);
}

/** A contract error: the status, the `ApiError` envelope and its code. */
export function expectError(res: request.Response, expected: { status: number; code: string }): void {
  expect({ status: res.status, code: res.body?.error?.code }).toEqual(expected);
  expectSchema("ApiError", res.body);
}

/** A natural-key replay: 200, `Idempotent-Replayed: true`. */
export function expectReplay(res: request.Response): void {
  expect({ status: res.status, replayed: res.headers["idempotent-replayed"] }).toEqual({
    status: 200,
    replayed: "true",
  });
}

/** The audit payloads of one action. */
export function auditsOf(action: string): AuditJobPayload[] {
  return h().audit.payloads.filter((p) => p.action === action);
}
