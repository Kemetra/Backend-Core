/**
 * Shared Testcontainers harness for the RT-113 BC2 cashier-admissions
 * integration specs.
 *
 *   - Real PostgreSQL with every migration applied (0035 included).
 *   - The real CashierAdmissionsModule: the real PosDeviceAuthGuard +
 *     DeviceRepository (on the RLS-bypassing lookup pool, as in production)
 *     and the service on the NOBYPASSRLS `app_test` domain pool, so every
 *     admission query runs under the tenant GUC and the 0035 policies.
 *   - An in-memory RedisLike so the takeover rate limit is real (the
 *     production fallback without REDIS_URL always allows).
 *   - Response bodies are checked against the merged OpenAPI contract with
 *     AJV (the same loader the contract spec uses).
 */
import "reflect-metadata";

import { randomUUID } from "node:crypto";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { hashToken } from "@data-pulse-2/auth";
import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import { Pool } from "pg";
import request from "supertest";

import { AUTH_LOOKUP_POOL, PG_POOL, REDIS_CLIENT } from "../../../src/auth/auth.module";
import type { RedisLike } from "../../../src/auth/rate-limit";
import { GlobalExceptionFilter } from "../../../src/common/exception.filter";
import { RequestIdInterceptor } from "../../../src/common/request-id.interceptor";
import { ZodValidationPipe } from "../../../src/common/zod-validation.pipe";
import { loadOpenApiContracts } from "../../../src/openapi/loader";
import { CashierAdmissionsModule } from "../../../src/pos-cashier-admissions/cashier-admissions.module";
import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../_helpers/postgres-container";

// ---------------------------------------------------------------------------
// Domain aliases for the harness API (ids, keys and labels are not
// interchangeable strings at the call sites)
// ---------------------------------------------------------------------------
/** A UUID: a user, admission, tenant, store, device or request id. */
export type Uuid = string;
/** A 4-hex-digit fixture suffix, e.g. "0001". */
type FixtureSuffix = string;
/** A rate-limiter key. */
type RedisKey = string;
/** The spec name a skip warning is reported under. */
type SuiteLabel = string;
/** Extra (or overriding) admission request body fields. */
export type BodyFields = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Fixture identifiers (hex-only suffixes; UUID v4 shape)
// ---------------------------------------------------------------------------
export const TENANT_A = "0c000000-0000-4000-8000-0000000a0001";
export const TENANT_B = "0c000000-0000-4000-8000-0000000b0001";
export const STORE_A1 = "0c000000-0000-4000-8000-0000000a5001";
export const STORE_A2 = "0c000000-0000-4000-8000-0000000a5002";
export const STORE_A3 = "0c000000-0000-4000-8000-0000000a5003";
export const STORE_B1 = "0c000000-0000-4000-8000-0000000b5001";

const ROLE_A_STAFF = "0c000000-0000-4000-8000-0000000a7001";
const ROLE_A_MANAGER = "0c000000-0000-4000-8000-0000000a7002";
const ROLE_B_STAFF = "0c000000-0000-4000-8000-0000000b7001";

export interface FixtureUser {
  readonly id: Uuid;
  readonly clerk: string | null;
  readonly name: string | null;
  readonly membership: Uuid;
}

interface UserSpec {
  readonly suffix: FixtureSuffix;
  readonly clerk: string | null;
  readonly name: string | null;
}

function user(spec: UserSpec): FixtureUser {
  return {
    id: `0c000000-0000-4000-8000-0000000c${spec.suffix}`,
    clerk: spec.clerk,
    name: spec.name,
    membership: `0c000000-0000-4000-8000-0000000d${spec.suffix}`,
  };
}

/** store_staff, access to every store of tenant A. */
export const CASHIER = user({ suffix: "0001", clerk: "user_rt113_cashier", name: "Mona A." });
/** store_staff, specific access to STORE_A1 only. */
export const CASHIER_SPECIFIC = user({ suffix: "0002", clerk: "user_rt113_specific", name: "Karim S." });
/** store_staff, specific access to STORE_A2 only (not A1). */
export const CASHIER_OTHER_STORE = user({ suffix: "0003", clerk: "user_rt113_other_store", name: "Other Store" });
/** store_manager: not a POS-eligible cashier role. */
export const MANAGER = user({ suffix: "0004", clerk: "user_rt113_manager", name: "Manager M." });
/** store_staff, soft-deleted user. */
export const DELETED = user({ suffix: "0005", clerk: "user_rt113_deleted", name: "Deleted D." });
/** store_staff, revoked membership. */
export const REVOKED = user({ suffix: "0006", clerk: "user_rt113_revoked", name: "Revoked R." });
/** store_staff without a provider subject (not in the roster). */
export const NO_CLERK = user({ suffix: "0007", clerk: null, name: "No Clerk" });
/** store_staff whose state individual tests mutate (reset after each test). */
export const MUTABLE = user({ suffix: "0008", clerk: "user_rt113_mutable", name: "Mutable M." });
/** store_staff with specific access to A1, used by the store-removed test. */
export const MUTABLE_SPECIFIC = user({ suffix: "0009", clerk: "user_rt113_mutable_specific", name: "Mutable S." });
/** store_staff in TENANT_B. */
export const CASHIER_B = user({ suffix: "000b", clerk: "user_rt113_cashier_b", name: "Tenant B Cashier" });

export interface FixtureDevice {
  readonly id: Uuid;
  readonly token: string;
}

function device(n: FixtureSuffix): FixtureDevice {
  return { id: `0c000000-0000-4000-8000-0000000e${n}`, token: `rt113-device-token-${n}-aaaaaaaaaaaaaaaa` };
}

export const DEV_A1 = device("0001");
export const DEV_A1_SECOND = device("0002");
/** Five more tills in STORE_A1 for the concurrency tests. */
export const DEV_A1_POOL = ["0003", "0004", "0005", "0006", "0007"].map(device);
export const DEV_A2 = device("0008");
export const DEV_A3 = device("0009");
export const DEV_REVOKED = device("000a");
export const DEV_B1 = device("000b");

export const ADMIT = "/api/pos/v1/cashier-admissions";
export const ROSTER = "/api/pos/v1/cashier-admissions/roster";
export const endPath = (admissionId: Uuid): string =>
  `/api/pos/v1/cashier-admissions/${admissionId}/end`;

// ---------------------------------------------------------------------------
// In-memory RedisLike (fixed window; enough for the takeover limit)
// ---------------------------------------------------------------------------
export class MemoryRedis implements RedisLike {
  private readonly counts = new Map<string, number>();
  async incr(key: RedisKey): Promise<number> {
    const next = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, next);
    return next;
  }
  async pexpireNx(): Promise<number> {
    return 1;
  }
  async pttl(key: RedisKey): Promise<number> {
    return this.counts.has(key) ? 60_000 : -2;
  }
  async decr(key: RedisKey): Promise<number> {
    const next = (this.counts.get(key) ?? 0) - 1;
    this.counts.set(key, next);
    return next;
  }
  async del(key: RedisKey): Promise<number> {
    return this.counts.delete(key) ? 1 : 0;
  }
  clear(): void {
    this.counts.clear();
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------
export interface Harness {
  env: PgTestEnv;
  admin: Pool;
  app: INestApplication;
  redis: MemoryRedis;
}

let harness: Harness | null = null;

export function h(): Harness {
  if (!harness) throw new Error("harness not started");
  return harness;
}

export function skipped(): boolean {
  if (harness) return false;
  // eslint-disable-next-line no-console
  console.warn("[cashier-admissions] skipping — Docker unavailable");
  return true;
}

export async function startHarness(label: SuiteLabel): Promise<void> {
  let env: PgTestEnv;
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[${label}] Docker NOT AVAILABLE — skipping: ${msg}\n`);
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }
  await applyAllUpAndCreateAppRole(env);
  const admin = new Pool({ connectionString: env.adminUri });
  await seed(admin);
  const redis = new MemoryRedis();

  const moduleRef = await Test.createTestingModule({ imports: [CashierAdmissionsModule] })
    .overrideProvider(PG_POOL)
    .useValue(env.app)
    .overrideProvider(AUTH_LOOKUP_POOL)
    .useValue(admin)
    .overrideProvider(REDIS_CLIENT)
    .useValue(redis)
    .compile();
  const app = moduleRef.createNestApplication({ bufferLogs: true, logger: false });
  app.useGlobalInterceptors(new RequestIdInterceptor());
  app.useGlobalFilters(new GlobalExceptionFilter());
  app.useGlobalPipes(new ZodValidationPipe());
  await app.init();
  harness = { env, admin, app, redis };
}

export async function stopHarness(): Promise<void> {
  if (!harness) return;
  await harness.app.close().catch(() => undefined);
  await harness.admin.end().catch(() => undefined);
  await stopPgEnv(harness.env);
  harness = null;
}

const POLICY_ENV = [
  "CASHIER_ADMISSION_TTL_SECONDS",
  "CASHIER_OFFLINE_GRACE_SECONDS",
  "CASHIER_TAKEOVER_RATE_LIMIT",
  "CASHIER_TAKEOVER_RATE_WINDOW_SECONDS",
] as const;

/** Clear admissions, the replay store, the rate limiter and mutated fixtures. */
export async function resetState(): Promise<void> {
  if (!harness) return;
  const { admin } = harness;
  await admin.query("DELETE FROM cashier_admission_requests");
  await admin.query("DELETE FROM cashier_admissions");
  await admin.query("UPDATE users SET deleted_at = NULL WHERE id = $1", [MUTABLE.id]);
  await admin.query(
    "UPDATE memberships SET revoked_at = NULL, role_id = $2 WHERE id = $1",
    [MUTABLE.membership, ROLE_A_STAFF],
  );
  await admin.query("UPDATE devices SET revoked_at = NULL WHERE id = $1", [DEV_A1_SECOND.id]);
  await admin.query("UPDATE stores SET deleted_at = NULL, is_active = true WHERE id = $1", [STORE_A3]);
  await admin.query(
    `INSERT INTO store_access (membership_id, store_id, tenant_id) VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING`,
    [MUTABLE_SPECIFIC.membership, STORE_A1, TENANT_A],
  );
  harness.redis.clear();
  for (const name of POLICY_ENV) delete process.env[name];
}

/** The role id a test can move MUTABLE's membership to (an ineligible role). */
export const MANAGER_ROLE_A = ROLE_A_MANAGER;

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------
async function seed(admin: Pool): Promise<void> {
  await admin.query(
    `INSERT INTO tenants (id, slug, name) VALUES ($1, 'rt113-a', 'RT-113 A'), ($2, 'rt113-b', 'RT-113 B')`,
    [TENANT_A, TENANT_B],
  );
  await admin.query(
    `INSERT INTO roles (id, tenant_id, code, name) VALUES
       ($1, $4, 'store_staff', 'Staff'),
       ($2, $4, 'store_manager', 'Manager'),
       ($3, $5, 'store_staff', 'Staff B')`,
    [ROLE_A_STAFF, ROLE_A_MANAGER, ROLE_B_STAFF, TENANT_A, TENANT_B],
  );
  await admin.query(
    `INSERT INTO stores (id, tenant_id, code, name) VALUES
       ($1, $5, 'A1', 'Store A1'), ($2, $5, 'A2', 'Store A2'),
       ($3, $5, 'A3', 'Store A3'), ($4, $6, 'B1', 'Store B1')`,
    [STORE_A1, STORE_A2, STORE_A3, STORE_B1, TENANT_A, TENANT_B],
  );
  const tenantA: Array<[FixtureUser, string, "all" | "specific"]> = [
    [CASHIER, ROLE_A_STAFF, "all"],
    [CASHIER_SPECIFIC, ROLE_A_STAFF, "specific"],
    [CASHIER_OTHER_STORE, ROLE_A_STAFF, "specific"],
    [MANAGER, ROLE_A_MANAGER, "all"],
    [DELETED, ROLE_A_STAFF, "all"],
    [REVOKED, ROLE_A_STAFF, "all"],
    [NO_CLERK, ROLE_A_STAFF, "all"],
    [MUTABLE, ROLE_A_STAFF, "all"],
    [MUTABLE_SPECIFIC, ROLE_A_STAFF, "specific"],
  ];
  for (const [u, roleId, access] of tenantA) {
    await seedMember(admin, { user: u, tenantId: TENANT_A, roleId, access });
  }
  await seedMember(admin, { user: CASHIER_B, tenantId: TENANT_B, roleId: ROLE_B_STAFF, access: "all" });
  await admin.query("UPDATE users SET deleted_at = now() WHERE id = $1", [DELETED.id]);
  await admin.query("UPDATE memberships SET revoked_at = now() WHERE id = $1", [REVOKED.membership]);
  await admin.query(
    `INSERT INTO store_access (membership_id, store_id, tenant_id) VALUES
       ($1, $3, $5), ($2, $4, $5)`,
    [CASHIER_SPECIFIC.membership, CASHIER_OTHER_STORE.membership, STORE_A1, STORE_A2, TENANT_A],
  );
  const devices: Array<[FixtureDevice, string, string]> = [
    [DEV_A1, TENANT_A, STORE_A1],
    [DEV_A1_SECOND, TENANT_A, STORE_A1],
    ...DEV_A1_POOL.map((d): [FixtureDevice, string, string] => [d, TENANT_A, STORE_A1]),
    [DEV_A2, TENANT_A, STORE_A2],
    [DEV_A3, TENANT_A, STORE_A3],
    [DEV_REVOKED, TENANT_A, STORE_A1],
    [DEV_B1, TENANT_B, STORE_B1],
  ];
  for (const [d, tenant, store] of devices) {
    await admin.query(
      `INSERT INTO devices (id, tenant_id, store_id, label, token_hash) VALUES ($1, $2, $3, 'till', $4)`,
      [d.id, tenant, store, hashToken(d.token)],
    );
  }
  await admin.query("UPDATE devices SET revoked_at = now() WHERE id = $1", [DEV_REVOKED.id]);
}

interface MemberSeed {
  readonly user: FixtureUser;
  readonly tenantId: Uuid;
  readonly roleId: Uuid;
  readonly access: "all" | "specific";
}

async function seedMember(admin: Pool, m: MemberSeed): Promise<void> {
  const u = m.user;
  await admin.query(
    `INSERT INTO users (id, email, display_name, clerk_user_id) VALUES ($1, $2, $3, $4)`,
    [u.id, `${u.id}@rt113.example`, u.name, u.clerk],
  );
  await admin.query(
    `INSERT INTO memberships (id, tenant_id, user_id, role_id, store_access_kind) VALUES ($1, $2, $3, $4, $5)`,
    [u.membership, m.tenantId, u.id, m.roleId, m.access],
  );
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
export function newKey(): string {
  return `rt113-test:${randomUUID()}`;
}

export function online(userId: Uuid, extra: BodyFields = {}): BodyFields {
  return { mode: "online", user_id: userId, idempotency_key: newKey(), ...extra };
}

export function reconcile(userId: Uuid, extra: BodyFields = {}): BodyFields {
  return {
    mode: "reconcile_offline",
    user_id: userId,
    offline_admitted_at: "2026-10-04T08:15:00Z",
    idempotency_key: newKey(),
    ...extra,
  };
}

export function http(): ReturnType<typeof request> {
  return request(h().app.getHttpServer());
}

export function admitAs(d: FixtureDevice, body: BodyFields, requestId: Uuid = randomUUID()) {
  return http()
    .post(ADMIT)
    .set("authorization", `Bearer ${d.token}`)
    .set("x-request-id", requestId)
    .send(body);
}

export function endAs(d: FixtureDevice, admissionId: Uuid, requestId: Uuid = randomUUID()) {
  return http()
    .post(endPath(admissionId))
    .set("authorization", `Bearer ${d.token}`)
    .set("x-request-id", requestId);
}

export function rosterAs(d: FixtureDevice) {
  return http().get(ROSTER).set("authorization", `Bearer ${d.token}`);
}

// ---------------------------------------------------------------------------
// DB probes (admin pool: superuser, bypasses RLS)
// ---------------------------------------------------------------------------
export interface AdmissionProbe {
  id: string;
  tenant_id: string;
  store_id: string;
  user_id: string;
  device_id: string;
  mode: string;
  offline_admitted_at: Date | null;
  takeover_of: string | null;
  expires_at: Date;
  ended_at: Date | null;
  end_reason: string | null;
}

export async function admissionsFor(userId: Uuid): Promise<AdmissionProbe[]> {
  const r = await h().admin.query<AdmissionProbe>(
    `SELECT id, tenant_id, store_id, user_id, device_id, mode, offline_admitted_at,
            takeover_of, expires_at, ended_at, end_reason
       FROM cashier_admissions WHERE user_id = $1 ORDER BY created_at, id`,
    [userId],
  );
  return r.rows;
}

export async function liveFor(userId: Uuid): Promise<AdmissionProbe[]> {
  return (await admissionsFor(userId)).filter((a) => a.ended_at === null);
}

export interface AuditProbe {
  action: string;
  actor_user_id: string | null;
  tenant_id: string | null;
  store_id: string | null;
  target_id: string | null;
  metadata: Record<string, unknown>;
}

export async function auditsFor(requestId: Uuid): Promise<AuditProbe[]> {
  const r = await h().admin.query<AuditProbe>(
    `SELECT action, actor_user_id, tenant_id, store_id, target_id, metadata
       FROM audit_events WHERE request_id = $1 ORDER BY occurred_at, id`,
    [requestId],
  );
  return r.rows;
}

// ---------------------------------------------------------------------------
// OpenAPI response validation
// ---------------------------------------------------------------------------
const CONTRACT_ID = "pos-cashier-admissions.openapi";
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

export type ContractSchema =
  | "PosCashierAdmissionResponse"
  | "PosCashierAdmissionEnded"
  | "PosCashierRosterResponse"
  | "RefusedError"
  | "Error";

export function expectSchema(schema: ContractSchema, body: unknown): void {
  const v: ValidateFunction | undefined = contractAjv().getSchema(
    `${CONTRACT_ID}#/components/schemas/${schema}`,
  );
  if (!v) throw new Error(`ajv cannot resolve ${schema}`);
  const ok = v(body);
  if (!ok) throw new Error(`${schema} mismatch: ${JSON.stringify(v.errors)} for ${JSON.stringify(body)}`);
}

/** A 403 is the generic `refused` envelope and nothing else. */
export function expectRefused(res: { status: number; body: unknown }): void {
  expect(res.status).toBe(403);
  expectSchema("RefusedError", res.body);
  expect((res.body as { error: { code: string } }).error.code).toBe("refused");
}

/** The body of a 200 `admitted`, validated. */
export function admitted(res: { status: number; body: unknown }): {
  kind: "admitted";
  admission_id: string;
  offline_grace_seconds: number;
  admission_ttl_seconds: number;
  server_time: string;
  display_name: string;
} {
  expect(res.status).toBe(200);
  expectSchema("PosCashierAdmissionResponse", res.body);
  const body = res.body as { kind: string };
  if (body.kind !== "admitted") throw new Error(`expected admitted, got ${JSON.stringify(res.body)}`);
  return res.body as ReturnType<typeof admitted>;
}

/** A 200 `active_elsewhere`: exactly `{ kind }`. */
export function expectActiveElsewhere(res: { status: number; body: unknown }): void {
  expect(res.status).toBe(200);
  expectSchema("PosCashierAdmissionResponse", res.body);
  expect(res.body).toEqual({ kind: "active_elsewhere" });
}
