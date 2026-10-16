/**
 * sale-history.http.integration.spec.ts — RT-539 (RT-534 S3).
 *
 * The store-wide sale history runtime (`pos-sales/sale-history.yaml`
 * 1.0.0-draft) on the RT-538 schema, against real Postgres with tenant RLS:
 *
 *   - listSaleHistory, readSaleHistoryDetail and recordSaleReprint behind
 *     SaleHistoryAuthGuard: the manager/admin envelope sees every sale of its
 *     store; the device bearer + X-Cashier-Admission sees only the admitted
 *     cashier's own sales, from every terminal of the store (OD-534-1 A,
 *     OD-534-2 A). Another cashier's, store's or tenant's sale is the
 *     non-disclosing 404 and never appears in a list.
 *   - OD-534-4 bounds: both dates inclusive, at most 31 business days (a
 *     wider range is 400, never truncated), keyset pages stable while new
 *     sales arrive, a foreign or forged cursor is 400.
 *   - The detail (RT-537 D-4..D-6, OD-534-3/5/6/8): void and returns
 *     summaries, ERP state, legacy (pre-RT-77, tender-unknown, no snapshot)
 *     sales shown as not recorded, never guessed.
 *   - Capture (sales.yaml 1.9.0-draft): `receipt` is accepted, stored first
 *     write wins and kept out of payload_hash; lines keep their order as
 *     line_seq. A 23:30 UTC sale lands on the next Africa/Cairo business day.
 *   - Reprints (RT-537 D-7, Q-5/Q-6/Q-8) and their audit (OD-534-7).
 *
 * Wiring mirrors production (the device-operator-capture suite's model): the
 * real SalesModule, PosOperatorsModule and CashierAdmissionsModule;
 * AUTH_LOOKUP_POOL = the RLS-exempt admin pool, PG_POOL = the NOBYPASSRLS
 * `app_test` role; the GLOBAL FailClosedAuthGuard. Only the Clerk JWKS check
 * and the audit fan-out are substituted. No guard is overridden.
 *
 * NOTE: CI runs Testcontainers (ci.yml db-integration). Locally without
 * Docker this suite skips when MIGRATION_TEST_ALLOW_SKIP=1.
 */
import "reflect-metadata";

import { randomUUID } from "node:crypto";

import type { INestApplication } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { hashToken } from "@data-pulse-2/auth";
import cookieParser from "cookie-parser";
import request from "supertest";

import { AUDIT_JOB_ENQUEUER, type AuditJobEnqueuer } from "../../../../src/audit/audit-job.enqueuer";
import type { AuditJobPayload } from "../../../../src/audit/audit-job.types";
import { AUTH_LOOKUP_POOL, AuthModule, PG_POOL } from "../../../../src/auth/auth.module";
import { FailClosedAuthGuard } from "../../../../src/auth/fail-closed-auth.guard";
import { RateLimiter, type RateLimitDecision } from "../../../../src/auth/rate-limit";
import { sha256CanonicalHex } from "../../../../src/catalog/sales/payload-hash";
import { SalesModule } from "../../../../src/catalog/sales/sales.module";
import { GlobalExceptionFilter } from "../../../../src/common/exception.filter";
import { RequestIdInterceptor } from "../../../../src/common/request-id.interceptor";
import { ZodValidationPipe } from "../../../../src/common/zod-validation.pipe";
import { CashierAdmissionsModule } from "../../../../src/pos-cashier-admissions/cashier-admissions.module";
import { CLERK_VERIFIER, type ClerkVerifier } from "../../../../src/pos-operators/clerk-verifier";
import { PosOperatorsModule } from "../../../../src/pos-operators/pos-operators.module";
import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../../_helpers/postgres-container";

delete process.env["REDIS_URL"];

const TENANT = "0a539000-0000-4000-8000-000000000001";
const TENANT_OTHER = "0a539000-0000-4000-8000-000000000002";
const STORE = "0a539000-0000-4000-8000-0000000000a1";
const STORE_2 = "0a539000-0000-4000-8000-0000000000a2";
const STORE_OTHER = "0a539000-0000-4000-8000-0000000000a3";
const ROLE_STAFF = "0a539000-0000-4000-8000-0000000000b1";
const ROLE_MANAGER = "0a539000-0000-4000-8000-0000000000b2";
const ROLE_STAFF_OTHER = "0a539000-0000-4000-8000-0000000000b3";
const CASHIER = "0a539000-0000-4000-8000-0000000000c1";
const CASHIER_2 = "0a539000-0000-4000-8000-0000000000c2";
const MANAGER = "0a539000-0000-4000-8000-0000000000c3";
const CASHIER_OTHER = "0a539000-0000-4000-8000-0000000000c4";
const M_CASHIER = "0a539000-0000-4000-8000-0000000000d1";
const M_CASHIER_2 = "0a539000-0000-4000-8000-0000000000d2";
const M_MANAGER = "0a539000-0000-4000-8000-0000000000d3";
const M_CASHIER_OTHER = "0a539000-0000-4000-8000-0000000000d4";
const DEVICE = "0a539000-0000-4000-8000-0000000000e1";
const DEVICE_2 = "0a539000-0000-4000-8000-0000000000e2";
const DEVICE_S2 = "0a539000-0000-4000-8000-0000000000e3";
const DEVICE_OTHER = "0a539000-0000-4000-8000-0000000000e4";
const TOKEN = "rt539-device-token-store-till-1";
const TOKEN_2 = "rt539-device-token-store-till-2";
const TOKEN_S2 = "rt539-device-token-store2-till-1";
const TOKEN_OTHER = "rt539-device-token-other-tenant";
const MANAGER_SUB = "user_clerk_rt539_manager";
const MANAGER_JWT = "jwt-rt539-manager";

const HOUR = 3_600_000;
const fromNow = (offsetMs: number): string => new Date(Date.now() + offsetMs).toISOString();
const ZERO_HASH = "0".repeat(64);

class StubClerkVerifier implements ClerkVerifier {
  async verify(rawJwt: string): Promise<{ sub: string }> {
    if (rawJwt !== MANAGER_JWT) throw new Error("StubClerkVerifier: unknown jwt");
    return { sub: MANAGER_SUB };
  }
}

class SpyAuditEnqueuer implements AuditJobEnqueuer {
  readonly payloads: AuditJobPayload[] = [];
  async enqueue(payload: AuditJobPayload): Promise<void> {
    this.payloads.push(payload);
  }
}

/** The per-device limiter, recording every check; it denies `denyBucket` for `denyKey`. */
class SwitchRateLimiter {
  denyBucket: string | null = null;
  denyKey: string | null = null;
  readonly calls: Array<{ bucket: string; key: string }> = [];
  async check(bucket: string, key: string): Promise<RateLimitDecision> {
    this.calls.push({ bucket, key });
    const allowed = !(bucket === this.denyBucket && key === this.denyKey);
    return { allowed, count: 1, remaining: 0, resetMs: 30_000 };
  }
  async release(): Promise<void> {}
}

let env: PgTestEnv | null = null;
let app: INestApplication | null = null;
let dockerSkipped = false;
const audit = new SpyAuditEnqueuer();
const limiter = new SwitchRateLimiter();

function E(): PgTestEnv {
  if (!env) throw new Error("env not initialized");
  return env;
}
function http(): ReturnType<typeof request> {
  if (!app) throw new Error("app not initialized");
  return request(app.getHttpServer());
}
const skip = (): boolean => dockerSkipped;

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

interface SeedSale {
  tenant?: string;
  store?: string;
  createdBy?: string;
  device?: string | null;
  businessDate: string;
  occurredAt: string;
  /** Write a receipt snapshot (the RT-539 capture shape). */
  snapshot?: boolean;
  /** Write line_seq on every line. */
  lineSeq?: boolean;
  /** Tenders written (tender_count follows); none = tender-unknown. */
  tenders?: ReadonlyArray<{ method: "cash" | "card_external"; amount: string; sequence?: number }>;
  syncStatus?: string;
  saleNumber?: string;
}

interface SeededSale {
  id: string;
  lines: [string, string];
}

let seq = 0;

async function seedSale(s: SeedSale): Promise<SeededSale> {
  seq += 1;
  const id = randomUUID();
  const tenant = s.tenant ?? TENANT;
  const store = s.store ?? STORE;
  const tenders = s.tenders ?? [{ method: "cash", amount: "12.50" }];
  const snap = s.snapshot === true;
  await E().admin.query(
    `INSERT INTO sales
       (id, tenant_id, store_id, currency_code, pos_total, occurred_at, business_date,
        source_system, external_id, payload_hash, mismatch_flag, created_by, sync_status,
        device_id, tender_count,
        receipt_sale_number, receipt_terminal_label, receipt_operator_display_name,
        receipt_settled_at, receipt_branch_name, receipt_branch_address, receipt_tax_registration_id)
     VALUES ($1, $2, $3, 'EGP', 12.50, $4::timestamptz, $5::date, 'rt539-seed', $6, $7, false, $8, $9,
             $10, $11, $12, $13, $14, $15::timestamptz, $16, $17, $18)`,
    [
      id,
      tenant,
      store,
      s.occurredAt,
      s.businessDate,
      `seed-${seq}-${id.slice(0, 8)}`,
      ZERO_HASH,
      s.createdBy ?? CASHIER,
      s.syncStatus ?? "synced",
      s.device === undefined ? DEVICE : s.device,
      tenders.length,
      snap ? (s.saleNumber ?? `till-1-${s.businessDate}-${String(seq).padStart(6, "0")}`) : null,
      snap ? "till-1 (printed)" : null,
      snap ? "Cashier One (printed)" : null,
      snap ? s.occurredAt : null,
      snap ? "Nile Branch" : null,
      snap ? "1 Nile St, Cairo" : null,
      snap ? "123-456-789" : null,
    ],
  );
  const lines: [string, string] = [randomUUID(), randomUUID()];
  await E().admin.query(
    `INSERT INTO sale_lines
       (id, sale_id, tenant_id, store_id, line_name, unit_price, currency_code, quantity,
        line_amount, unit, line_seq)
     VALUES ($1, $3, $4, $5, 'Widget', 5.00, 'EGP', 1, 5.00, 'unit', $6),
            ($2, $3, $4, $5, 'Gadget', 7.50, 'EGP', 1, 7.50, 'unit', $7)`,
    [lines[0], lines[1], id, tenant, store, s.lineSeq === true ? 1 : null, s.lineSeq === true ? 2 : null],
  );
  for (const t of tenders) {
    await E().admin.query(
      `INSERT INTO sale_tenders (id, sale_id, tenant_id, store_id, method, amount, currency_code, sequence)
       VALUES ($1, $2, $3, $4, $5, $6::numeric, 'EGP', $7)`,
      [randomUUID(), id, tenant, store, t.method, t.amount, t.sequence ?? null],
    );
  }
  return { id, lines };
}

/** A complete sale: snapshot, sequenced lines, one tender (the duplicate-eligible shape). */
function seedCompleteSale(extra: Partial<SeedSale> = {}): Promise<SeededSale> {
  return seedSale({ businessDate: "2026-10-15", occurredAt: "2026-10-15T09:00:00.000Z", snapshot: true, lineSeq: true, ...extra });
}

async function seedApprovedVoid(saleId: string, reversal?: { status: string; documentRef: string | null }): Promise<string> {
  const voidId = randomUUID();
  await E().admin.query(
    `INSERT INTO sale_voids
       (id, sale_id, tenant_id, store_id, business_date, source_system, external_id, payload_hash,
        created_by, approval_id, approved_by_user_id, requested_by_user_id, approval_policy_version,
        approved_at, void_business_date)
     VALUES ($1, $2, $3, $4, '2026-10-15', 'rt539-seed', $5, $6, $7, $8, $9, $7, 'rt530-v1', now(), '2026-10-15')`,
    [voidId, saleId, TENANT, STORE, `void-${voidId}`, ZERO_HASH, CASHIER, randomUUID(), MANAGER],
  );
  if (reversal) await seedPosting(saleId, "reversal", voidId, reversal.status, reversal.documentRef);
  return voidId;
}

async function seedPartialReturn(sale: SeededSale): Promise<string> {
  const returnId = randomUUID();
  await E().admin.query(
    `INSERT INTO sale_returns
       (id, sale_id, tenant_id, store_id, return_seq, business_date, currency_code, return_total,
        source_system, external_id, payload_hash, created_by)
     VALUES ($1, $2, $3, $4, 1, '2026-10-15', 'EGP', 7.50, 'rt539-seed', $5, $6, $7)`,
    [returnId, sale.id, TENANT, STORE, `ret-${returnId}`, ZERO_HASH, MANAGER],
  );
  await E().admin.query(
    `INSERT INTO sale_return_lines
       (id, return_id, sale_line_id, tenant_id, store_id, quantity, line_amount, returned_quantity_after)
     VALUES ($1, $2, $3, $4, $5, 1, 7.50, 1)`,
    [randomUUID(), returnId, sale.lines[1], TENANT, STORE],
  );
  return returnId;
}

async function seedPosting(
  saleId: string,
  kind: "sale_post" | "reversal",
  sourceRefId: string,
  status: string,
  documentRef: string | null,
): Promise<void> {
  await E().admin.query(
    `INSERT INTO erpnext_posting_status
       (id, tenant_id, store_id, sale_id, kind, source_ref_id, source_system, external_id,
        payload_hash, status, document_ref)
     VALUES ($1, $2, $3, $4, $5, $6, 'rt539-seed', $7, $8, $9, $10)`,
    [randomUUID(), TENANT, STORE, saleId, kind, sourceRefId, `post-${sourceRefId}`, ZERO_HASH, status, documentRef],
  );
}

async function admission(opts: {
  user?: string;
  device?: string;
  store?: string;
  tenant?: string;
  createdAt?: string;
  expiresAt?: string;
  endedAt?: string;
}): Promise<string> {
  const id = randomUUID();
  await E().admin.query(
    `INSERT INTO cashier_admissions
       (id, tenant_id, store_id, user_id, device_id, mode,
        created_at, renewed_at, expires_at, ended_at, end_reason)
     VALUES ($1, $2, $3, $4, $5, 'online', $6::timestamptz, $6::timestamptz, $7::timestamptz, $8::timestamptz, $9)`,
    [
      id,
      opts.tenant ?? TENANT,
      opts.store ?? STORE,
      opts.user ?? CASHIER,
      opts.device ?? DEVICE,
      opts.createdAt ?? fromNow(-HOUR),
      opts.expiresAt ?? fromNow(HOUR),
      opts.endedAt ?? null,
      opts.endedAt ? "device_end" : null,
    ],
  );
  return id;
}

async function signInManager(deviceToken: string = TOKEN): Promise<string> {
  const res = await http()
    .post("/api/pos/v1/operators/sign-in")
    .set("Authorization", `Bearer ${MANAGER_JWT}`)
    .send({ kind: "manager_admin", device_token_attestation: deviceToken });
  expect(res.status).toBe(200);
  return res.body.operator_session.envelope as string;
}

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

interface Credential {
  bearer: string | null;
  admission?: string;
}

function withCredential(req: request.Test, cred: Credential): request.Test {
  if (cred.bearer !== null) req.set("Authorization", `Bearer ${cred.bearer}`);
  if (cred.admission !== undefined) req.set("X-Cashier-Admission", cred.admission);
  return req;
}

function list(cred: Credential, query: Record<string, string | number>): request.Test {
  return withCredential(http().get("/api/pos/v1/sale-history").query(query), cred);
}

function detail(cred: Credential, saleRef: string): request.Test {
  return withCredential(http().get(`/api/pos/v1/sale-history/${saleRef}`), cred);
}

function reprint(cred: Credential, saleRef: string, body: Record<string, unknown>, key?: string): request.Test {
  return withCredential(
    http()
      .post(`/api/pos/v1/sale-history/${saleRef}/reprints`)
      .set("Idempotency-Key", key ?? `rt539-${randomUUID()}`),
    cred,
  ).send(body);
}

const RANGE = { from: "2026-10-01", to: "2026-10-31" };

function refs(res: request.Response): string[] {
  return (res.body.items as Array<{ saleRef: string }>).map((i) => i.saleRef);
}

async function reprintAudits(saleRef: string): Promise<Array<{ actor_user_id: string | null; metadata: Record<string, unknown> }>> {
  const r = await E().admin.query(
    `SELECT actor_user_id, metadata FROM audit_events
      WHERE action = 'sale.receipt.reprinted' AND metadata->>'sale_ref' = $1 ORDER BY occurred_at, id`,
    [saleRef],
  );
  return r.rows;
}

async function reprintRows(saleRef: string): Promise<Array<Record<string, unknown>>> {
  const r = await E().admin.query(
    `SELECT mode, kind, marked_voided, marked_returned, copy_number, created_by, device_id
       FROM sale_reprints WHERE sale_id = $1 ORDER BY recorded_at, id`,
    [saleRef],
  );
  return r.rows;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[sale-history] Docker NOT AVAILABLE: ${msg}\n`);
      dockerSkipped = true;
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }

  await applyAllUpAndCreateAppRole(env);
  const a = env.admin;
  await a.query(
    `INSERT INTO tenants (id, slug, name) VALUES ($1, 'rt539-tenant', 'RT-539'), ($2, 'rt539-other', 'RT-539 Other')`,
    [TENANT, TENANT_OTHER],
  );
  await a.query(
    `INSERT INTO roles (id, tenant_id, code, name) VALUES
       ($1, $4, 'store_staff', 'Cashier'), ($2, $4, 'store_manager', 'Manager'), ($3, $5, 'store_staff', 'Cashier')`,
    [ROLE_STAFF, ROLE_MANAGER, ROLE_STAFF_OTHER, TENANT, TENANT_OTHER],
  );
  await a.query(
    `INSERT INTO stores (id, tenant_id, code, name, timezone) VALUES
       ($1, $4, 'S1', 'Store 1', 'Africa/Cairo'), ($2, $4, 'S2', 'Store 2', 'Africa/Cairo'),
       ($3, $5, 'SO', 'Other Store', 'Africa/Cairo')`,
    [STORE, STORE_2, STORE_OTHER, TENANT, TENANT_OTHER],
  );
  await a.query(
    `INSERT INTO users (id, email, display_name, clerk_user_id) VALUES
       ($1, 'cashier@rt539.example', 'Cashier One', 'user_clerk_rt539_c1'),
       ($2, 'cashier2@rt539.example', 'Cashier Two', 'user_clerk_rt539_c2'),
       ($3, 'manager@rt539.example', 'Manager', $5),
       ($4, 'cashierx@rt539.example', 'Other Cashier', 'user_clerk_rt539_cx')`,
    [CASHIER, CASHIER_2, MANAGER, CASHIER_OTHER, MANAGER_SUB],
  );
  await a.query(
    `INSERT INTO memberships (id, tenant_id, user_id, role_id, store_access_kind) VALUES
       ($1, $5, $6, $9, 'all'), ($2, $5, $7, $9, 'all'), ($3, $5, $8, $10, 'specific'), ($4, $11, $12, $13, 'all')`,
    [
      M_CASHIER, M_CASHIER_2, M_MANAGER, M_CASHIER_OTHER,
      TENANT, CASHIER, CASHIER_2, MANAGER, ROLE_STAFF, ROLE_MANAGER,
      TENANT_OTHER, CASHIER_OTHER, ROLE_STAFF_OTHER,
    ],
  );
  await a.query(`INSERT INTO store_access (membership_id, store_id, tenant_id) VALUES ($1, $2, $3)`, [
    M_MANAGER,
    STORE,
    TENANT,
  ]);
  await a.query(
    `INSERT INTO devices (id, tenant_id, store_id, label, token_hash) VALUES
       ($1, $5, $6, 'till-1', $9), ($2, $5, $6, 'till-2', $10), ($3, $5, $7, 's2-till', $11), ($4, $8, $12, 'other', $13)`,
    [
      DEVICE, DEVICE_2, DEVICE_S2, DEVICE_OTHER,
      TENANT, STORE, STORE_2, TENANT_OTHER,
      hashToken(TOKEN), hashToken(TOKEN_2), hashToken(TOKEN_S2), STORE_OTHER, hashToken(TOKEN_OTHER),
    ],
  );

  const moduleRef = await Test.createTestingModule({
    imports: [AuthModule, PosOperatorsModule, CashierAdmissionsModule, SalesModule],
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
    .compile();

  app = moduleRef.createNestApplication({ bufferLogs: true, logger: false });
  app.use(cookieParser());
  app.useGlobalInterceptors(new RequestIdInterceptor());
  app.useGlobalFilters(new GlobalExceptionFilter());
  app.useGlobalPipes(new ZodValidationPipe());
  await app.init();
}, 240_000);

afterAll(async () => {
  if (app) await app.close().catch(() => undefined);
  if (env) await stopPgEnv(env);
}, 60_000);

afterEach(async () => {
  if (!env) return;
  const a = env.admin;
  for (const table of [
    "sale_reprints",
    "erpnext_posting_status",
    "sale_return_lines",
    "sale_returns",
    "sale_voids",
    "sale_tenders",
    "sale_lines",
    "outbox_events",
    "sales",
    "cashier_admissions",
  ]) {
    await a.query(`DELETE FROM ${table}`);
  }
  await a.query(`DELETE FROM auth_tokens WHERE scope = 'pos_operator'`);
  await a.query(`UPDATE memberships SET revoked_at = NULL`);
  audit.payloads.length = 0;
  limiter.denyBucket = null;
  limiter.denyKey = null;
  limiter.calls.length = 0;
});

// ---------------------------------------------------------------------------
// Visibility and the role matrix (OD-534-1)
// ---------------------------------------------------------------------------

describe("RT-539 — who sees which sales (OD-534-1 A)", () => {
  it("no credential is the generic 401 on every route", async () => {
    if (skip()) return;
    const sale = await seedCompleteSale();
    expect((await list({ bearer: null }, RANGE)).status).toBe(401);
    expect((await detail({ bearer: null }, sale.id)).status).toBe(401);
    expect((await reprint({ bearer: null }, sale.id, { mode: "authorize", kind: "sale_record", printedAt: fromNow(0) })).status).toBe(401);
  });

  it("the manager envelope sees every sale of its store, from every till, and no other store or tenant", async () => {
    if (skip()) return;
    const own = await seedCompleteSale();
    const otherTill = await seedCompleteSale({ device: DEVICE_2, createdBy: CASHIER_2 });
    await seedCompleteSale({ store: STORE_2, device: DEVICE_S2 });
    await seedCompleteSale({ tenant: TENANT_OTHER, store: STORE_OTHER, device: DEVICE_OTHER, createdBy: CASHIER_OTHER });
    const envelope = await signInManager();

    const res = await list({ bearer: envelope }, RANGE);
    expect(res.status).toBe(200);
    expect(res.body.visibility).toBe("store");
    expect(refs(res).sort()).toEqual([own.id, otherTill.id].sort());
    expect(res.body.storeTimezone).toBe("Africa/Cairo");
    expect(res.body.from).toBe(RANGE.from);
    expect(res.body.to).toBe(RANGE.to);
    expect(Number.isNaN(Date.parse(res.body.asOf as string))).toBe(false);
  });

  it("an envelope that carries X-Cashier-Admission is the generic 401", async () => {
    if (skip()) return;
    const envelope = await signInManager();
    const adm = await admission({});
    expect((await list({ bearer: envelope, admission: adm }, RANGE)).status).toBe(401);
  });

  it("a cashier sees their own sales from EVERY till of the store, never another cashier's", async () => {
    if (skip()) return;
    const mine = await seedCompleteSale();
    const mineOnTill2 = await seedCompleteSale({ device: DEVICE_2 });
    const theirs = await seedCompleteSale({ createdBy: CASHIER_2 });
    const adm = await admission({});

    const res = await list({ bearer: TOKEN, admission: adm }, RANGE);
    expect(res.status).toBe(200);
    expect(res.body.visibility).toBe("own_sales");
    expect(refs(res).sort()).toEqual([mine.id, mineOnTill2.id].sort());

    expect((await detail({ bearer: TOKEN, admission: adm }, theirs.id)).status).toBe(404);
    expect((await detail({ bearer: TOKEN, admission: adm }, mineOnTill2.id)).status).toBe(200);
  });

  it("a cashier filtering by operator is a 400 (envelope-only filter)", async () => {
    if (skip()) return;
    const adm = await admission({});
    const res = await list({ bearer: TOKEN, admission: adm }, { ...RANGE, operator_user_id: CASHIER_2 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
  });

  it("a valid device without the header is the generic 403 refused", async () => {
    if (skip()) return;
    const res = await list({ bearer: TOKEN }, RANGE);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("refused");
  });

  it.each([
    ["another device's admission", { device: DEVICE_2 }],
    ["an ended admission", { endedAt: fromNow(-5 * 60_000) }],
    ["an expired admission", { createdAt: fromNow(-3 * HOUR), expiresAt: fromNow(-HOUR) }],
  ])("%s is the generic 403 refused", async (_label, opts) => {
    if (skip()) return;
    const adm = await admission(opts);
    const res = await list({ bearer: TOKEN, admission: adm }, RANGE);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("refused");
  });

  it("an unknown admission id and an ineligible cashier are the same 403 refused", async () => {
    if (skip()) return;
    expect((await list({ bearer: TOKEN, admission: randomUUID() }, RANGE)).status).toBe(403);
    const adm = await admission({});
    await E().admin.query(`UPDATE memberships SET revoked_at = now() WHERE id = $1`, [M_CASHIER]);
    const res = await list({ bearer: TOKEN, admission: adm }, RANGE);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("refused");
  });

  it("a malformed admission id is a 400; a revoked device is the generic 401", async () => {
    if (skip()) return;
    expect((await list({ bearer: TOKEN, admission: "adm-1" }, RANGE)).status).toBe(400);
    expect((await list({ bearer: "not-a-device-token", admission: randomUUID() }, RANGE)).status).toBe(401);
  });

  it("another tenant's device never sees this tenant's sales (cross-tenant)", async () => {
    if (skip()) return;
    const sale = await seedCompleteSale();
    const adm = await admission({ tenant: TENANT_OTHER, store: STORE_OTHER, device: DEVICE_OTHER, user: CASHIER_OTHER });
    const res = await list({ bearer: TOKEN_OTHER, admission: adm }, RANGE);
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
    expect((await detail({ bearer: TOKEN_OTHER, admission: adm }, sale.id)).status).toBe(404);
  });

  it("another store's sale is a non-disclosing 404, the same as an absent or malformed ref", async () => {
    if (skip()) return;
    const otherStore = await seedCompleteSale({ store: STORE_2, device: DEVICE_S2 });
    const envelope = await signInManager();
    const crossStore = await detail({ bearer: envelope }, otherStore.id);
    const absent = await detail({ bearer: envelope }, randomUUID());
    const malformed = await detail({ bearer: envelope }, "not-a-uuid");
    for (const res of [crossStore, absent, malformed]) {
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe(absent.body.error.code);
    }
  });
});

// ---------------------------------------------------------------------------
// Bounds and paging (OD-534-4)
// ---------------------------------------------------------------------------

describe("RT-539 — business-date range and keyset paging (OD-534-4)", () => {
  it("both bounds are inclusive; the days outside are excluded", async () => {
    if (skip()) return;
    const before = await seedSale({ businessDate: "2026-10-09", occurredAt: "2026-10-09T10:00:00Z" });
    const first = await seedSale({ businessDate: "2026-10-10", occurredAt: "2026-10-10T10:00:00Z" });
    const last = await seedSale({ businessDate: "2026-10-12", occurredAt: "2026-10-12T10:00:00Z" });
    const after = await seedSale({ businessDate: "2026-10-13", occurredAt: "2026-10-13T10:00:00Z" });
    const envelope = await signInManager();
    const res = await list({ bearer: envelope }, { from: "2026-10-10", to: "2026-10-12" });
    expect(refs(res)).toEqual([last.id, first.id]);
    expect(refs(res)).not.toContain(before.id);
    expect(refs(res)).not.toContain(after.id);
  });

  it("31 business days is accepted; 32 is a 400, never truncated", async () => {
    if (skip()) return;
    const envelope = await signInManager();
    expect((await list({ bearer: envelope }, { from: "2026-10-01", to: "2026-10-31" })).status).toBe(200);
    const wide = await list({ bearer: envelope }, { from: "2026-10-01", to: "2026-11-01" });
    expect(wide.status).toBe(400);
    expect(wide.body.error.code).toBe("validation_error");
    expect((await list({ bearer: envelope }, { from: "2026-10-02", to: "2026-10-01" })).status).toBe(400);
    expect((await list({ bearer: envelope }, { from: "2026-02-30", to: "2026-03-01" })).status).toBe(400);
    expect((await list({ bearer: envelope }, { to: "2026-03-01" })).status).toBe(400);
    expect((await list({ bearer: envelope }, { ...RANGE, store_id: STORE_2 })).status).toBe(400);
  });

  it("orders businessDate, occurredAt, saleRef DESC and pages without a skip or a repeat while sales arrive", async () => {
    if (skip()) return;
    const seeded: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      seeded.push((await seedSale({ businessDate: "2026-10-14", occurredAt: `2026-10-14T0${i}:00:00.123456Z` })).id);
    }
    // Two sales sharing an instant: ordered by id DESC.
    const tieA = await seedSale({ businessDate: "2026-10-13", occurredAt: "2026-10-13T08:00:00Z" });
    const tieB = await seedSale({ businessDate: "2026-10-13", occurredAt: "2026-10-13T08:00:00Z" });
    const ties = [tieA.id, tieB.id].sort().reverse();
    const expected = [...seeded].reverse().concat(ties);

    const envelope = await signInManager();
    const page1 = await list({ bearer: envelope }, { ...RANGE, page_size: 3 });
    expect(page1.status).toBe(200);
    expect(refs(page1)).toEqual(expected.slice(0, 3));
    expect(page1.body.nextCursor).toEqual(expect.any(String));

    // A newer sale arrives between pages: it never shifts the walk.
    await seedSale({ businessDate: "2026-10-15", occurredAt: "2026-10-15T09:00:00Z" });

    const page2 = await list({ bearer: envelope }, { ...RANGE, page_size: 3, cursor: page1.body.nextCursor });
    expect(refs(page2)).toEqual(expected.slice(3, 6));
    const page3 = await list({ bearer: envelope }, { ...RANGE, page_size: 3, cursor: page2.body.nextCursor });
    expect(refs(page3)).toEqual(expected.slice(6));
    expect(page3.body.nextCursor).toBeNull();
  });

  it("a cursor reused with other filters, forged or garbage is a 400", async () => {
    if (skip()) return;
    await seedSale({ businessDate: "2026-10-14", occurredAt: "2026-10-14T01:00:00Z" });
    await seedSale({ businessDate: "2026-10-14", occurredAt: "2026-10-14T02:00:00Z" });
    const envelope = await signInManager();
    const page1 = await list({ bearer: envelope }, { ...RANGE, page_size: 1 });
    const cursor = page1.body.nextCursor as string;
    expect((await list({ bearer: envelope }, { ...RANGE, to: "2026-10-30", page_size: 1, cursor })).status).toBe(400);
    expect((await list({ bearer: envelope }, { ...RANGE, device_ref: DEVICE, page_size: 1, cursor })).status).toBe(400);
    expect((await list({ bearer: envelope }, { ...RANGE, cursor: "garbage" })).status).toBe(400);
  });

  it("an empty page is a 200 with no cursor", async () => {
    if (skip()) return;
    const envelope = await signInManager();
    const res = await list({ bearer: envelope }, RANGE);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ items: [], nextCursor: null });
  });

  it("filters by device, by operator (envelope) and by exact sale number", async () => {
    if (skip()) return;
    const till1 = await seedCompleteSale({ saleNumber: "till-1-2026-10-15-000042" });
    const till2 = await seedCompleteSale({ device: DEVICE_2, createdBy: CASHIER_2 });
    const envelope = await signInManager();
    expect(refs(await list({ bearer: envelope }, { ...RANGE, device_ref: DEVICE_2 }))).toEqual([till2.id]);
    expect(refs(await list({ bearer: envelope }, { ...RANGE, device_ref: DEVICE_S2 }))).toEqual([]);
    expect(refs(await list({ bearer: envelope }, { ...RANGE, operator_user_id: CASHIER_2 }))).toEqual([till2.id]);
    expect(refs(await list({ bearer: envelope }, { ...RANGE, sale_number: "till-1-2026-10-15-000042" }))).toEqual([
      till1.id,
    ]);
  });

  it("audits one sale_history.listed per request, with the filters and the count, never the row ids", async () => {
    if (skip()) return;
    const sale = await seedCompleteSale();
    const adm = await admission({});
    await list({ bearer: TOKEN, admission: adm }, { ...RANGE, device_ref: DEVICE });
    const listed = audit.payloads.filter((p) => p.action === "sale_history.listed");
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ actor_user_id: CASHIER, tenant_id: TENANT, store_id: STORE });
    expect(listed[0]?.metadata).toEqual({
      visibility: "own_sales",
      device_id: DEVICE,
      from: RANGE.from,
      to: RANGE.to,
      device_ref: DEVICE,
      operator_user_id: null,
      sale_number_filtered: false,
      page_size: 50,
      continued: false,
      item_count: 1,
    });
    expect(JSON.stringify(listed[0])).not.toContain(sale.id);
  });
});

// ---------------------------------------------------------------------------
// The detail (RT-537 D-4..D-6)
// ---------------------------------------------------------------------------

describe("RT-539 — the recorded detail of one sale", () => {
  it("a complete sale: snapshot facts, receipt order, ERP posted with its document, a duplicate allowed", async () => {
    if (skip()) return;
    const sale = await seedCompleteSale();
    await seedPosting(sale.id, "sale_post", sale.id, "posted", "ACC-SINV-2026-00001");
    const envelope = await signInManager();
    const res = await detail({ bearer: envelope }, sale.id);
    expect(res.status).toBe(200);
    expect(res.body.summary).toMatchObject({
      saleRef: sale.id,
      businessDate: "2026-10-15",
      device: { deviceRef: DEVICE, label: "till-1 (printed)", labelSource: "snapshot" },
      operator: { userRef: CASHIER, displayName: "Cashier One (printed)", nameSource: "snapshot" },
      erpPostingState: "posted",
      voided: false,
      returnState: "none",
    });
    expect(res.body.lines.map((l: { sequence: number }) => l.sequence)).toEqual([1, 2]);
    expect(res.body).toMatchObject({
      lineOrder: "recorded",
      tenderState: "recorded",
      changeGiven: "0",
      receiptHeader: { branchName: "Nile Branch", branchAddress: "1 Nile St, Cairo", taxRegistrationId: "123-456-789" },
      void: null,
      returns: [],
      erpPosting: { sale: "posted", saleDocumentRef: "ACC-SINV-2026-00001", reversal: null, reversalDocumentRef: null },
      receiptFacts: "complete",
      reprint: { duplicate: "allowed", saleRecord: "allowed", marks: [] },
    });
  });

  it("an RT-530 approved void shows its summary (role only), the reversal state and only a marked sale record", async () => {
    if (skip()) return;
    const sale = await seedCompleteSale();
    await seedApprovedVoid(sale.id, { status: "pending", documentRef: null });
    const envelope = await signInManager();
    const res = await detail({ bearer: envelope }, sale.id);
    expect(res.status).toBe(200);
    expect(res.body.void).toMatchObject({ approved: true, approverRole: "store_manager", voidBusinessDate: "2026-10-15" });
    expect(JSON.stringify(res.body.void)).not.toContain(MANAGER);
    expect(res.body.summary.voided).toBe(true);
    expect(res.body.erpPosting).toMatchObject({ sale: "unknown", reversal: "pending" });
    expect(res.body.reprint).toEqual({ duplicate: "unavailable_voided", saleRecord: "allowed", marks: ["voided"] });
  });

  it("a partial return shows its returns summary and marks the slip returned", async () => {
    if (skip()) return;
    const sale = await seedCompleteSale();
    const returnId = await seedPartialReturn(sale);
    const envelope = await signInManager();
    const res = await detail({ bearer: envelope }, sale.id);
    expect(res.body.summary.returnState).toBe("partial");
    expect(res.body.returns).toEqual([
      {
        returnRef: returnId,
        recordedAt: expect.any(String),
        businessDate: "2026-10-15",
        returnTotal: "7.5000",
        lines: [{ lineRef: sale.lines[1], quantity: "1.000000", lineAmount: "7.5000" }],
      },
    ]);
    expect(res.body.reprint.marks).toEqual(["returned"]);
  });

  it("a legacy sale (pre-RT-77, tender-unknown, no snapshot) is shown as not recorded, never guessed", async () => {
    if (skip()) return;
    const sale = await seedSale({ businessDate: "2026-10-15", occurredAt: "2026-10-15T09:00:00Z", device: null, tenders: [] });
    const envelope = await signInManager();
    const res = await detail({ bearer: envelope }, sale.id);
    expect(res.status).toBe(200);
    expect(res.body.summary.device).toEqual({ deviceRef: null, label: null, labelSource: "unavailable" });
    expect(res.body.summary.operator).toEqual({ userRef: CASHIER, displayName: "Cashier One", nameSource: "current" });
    expect(res.body).toMatchObject({
      lineOrder: "not_recorded",
      tenderState: "unknown",
      tenders: [],
      changeGiven: null,
      settledAt: null,
      receiptNumber: null,
      receiptHeader: null,
      receiptFacts: "partial",
      reprint: { duplicate: "unavailable_incomplete", saleRecord: "allowed", marks: [] },
    });
    expect(res.body.summary.saleNumber).toBeNull();
    expect(JSON.stringify(res.body)).not.toContain("@rt539.example");
  });

  it("a failed-needs-repair sale with no posting row shows its status and ERP unknown", async () => {
    if (skip()) return;
    const sale = await seedCompleteSale({ syncStatus: "failed-needs-repair" });
    const envelope = await signInManager();
    const res = await detail({ bearer: envelope }, sale.id);
    expect(res.body.summary).toMatchObject({ syncStatus: "failed-needs-repair", erpPostingState: "unknown" });
    expect(res.body.erpPosting).toEqual({ sale: "unknown", saleDocumentRef: null, reversal: null, reversalDocumentRef: null });
  });

  it("a permanently rejected posting is failed, with no document", async () => {
    if (skip()) return;
    const sale = await seedCompleteSale();
    await seedPosting(sale.id, "sale_post", sale.id, "permanently_rejected", null);
    const envelope = await signInManager();
    const res = await detail({ bearer: envelope }, sale.id);
    expect(res.body.erpPosting).toMatchObject({ sale: "failed", saleDocumentRef: null });
  });

  it("audits each authorized open (sale_history.detail_read) with the saleRef; a 404 is not audited", async () => {
    if (skip()) return;
    const sale = await seedCompleteSale();
    const adm = await admission({});
    await detail({ bearer: TOKEN, admission: adm }, sale.id);
    await detail({ bearer: TOKEN, admission: adm }, randomUUID());
    const reads = audit.payloads.filter((p) => p.action === "sale_history.detail_read");
    expect(reads).toHaveLength(1);
    expect(reads[0]).toMatchObject({ actor_user_id: CASHIER, tenant_id: TENANT, store_id: STORE });
    expect(reads[0]?.metadata).toEqual({ sale_ref: sale.id, visibility: "own_sales", device_id: DEVICE });
  });

  it("an unknown query key on the detail is a 400", async () => {
    if (skip()) return;
    const sale = await seedCompleteSale();
    const envelope = await signInManager();
    const res = await withCredential(http().get(`/api/pos/v1/sale-history/${sale.id}`).query({ store_id: STORE }), {
      bearer: envelope,
    });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Capture: the receipt snapshot and line order (sales.yaml 1.9.0-draft)
// ---------------------------------------------------------------------------

function captureBody(opts: { externalId: string; occurredAt: string; receipt?: Record<string, unknown> }): Record<string, unknown> {
  return {
    sourceSystem: "pos-pulse",
    externalId: opts.externalId,
    currencyCode: "EGP",
    posTotal: "12.50",
    occurredAt: opts.occurredAt,
    operatorUserId: CASHIER,
    // Receipt order: Widget is printed AFTER Gadget.
    lines: [
      { lineName: "Gadget", unitPrice: "7.50", currencyCode: "EGP", quantity: "1", lineAmount: "7.50", unit: "unit" },
      { lineName: "Widget", unitPrice: "5.00", currencyCode: "EGP", quantity: "1", lineAmount: "5.00", unit: "unit" },
    ],
    ...(opts.receipt === undefined ? {} : { receipt: opts.receipt }),
  };
}

const RECEIPT = {
  saleNumber: "till-1-2026-10-16-000001",
  terminalLabel: "till-1",
  operatorDisplayName: "Cashier One",
  settledAt: "2026-10-15T23:30:04.000Z",
  branchName: "Nile Branch",
  branchAddress: "1 Nile St, Cairo",
  taxRegistrationId: "123-456-789",
  changeGiven: "7.50",
};

function capture(body: Record<string, unknown>, key?: string): request.Test {
  return http()
    .post("/api/pos/v1/sales")
    .set("Authorization", `Bearer ${TOKEN}`)
    .set("Idempotency-Key", key ?? `rt539-cap-${randomUUID()}`)
    .send(body);
}

describe("RT-539 — capture stores the receipt snapshot and the line order", () => {
  it("a 23:30 UTC sale lands on the next Cairo business date, with its snapshot and receipt line order", async () => {
    if (skip()) return;
    // The latest 23:30 UTC at least an hour ago (the capture caps compare with the real clock).
    const sold = new Date();
    sold.setUTCHours(23, 30, 0, 0);
    if (sold.getTime() > Date.now() - HOUR) sold.setUTCDate(sold.getUTCDate() - 1);
    const occurredAt = sold.toISOString();
    const nextDay = new Date(sold.getTime() + 24 * HOUR).toISOString().slice(0, 10);
    await admission({ createdAt: new Date(sold.getTime() - 3 * HOUR).toISOString(), expiresAt: fromNow(HOUR) });
    const res = await capture(captureBody({ externalId: `rt539-${randomUUID()}`, occurredAt, receipt: RECEIPT }));
    expect(res.status).toBe(201);
    expect(res.body.businessDate).toBe(nextDay);
    expect(res.body).not.toHaveProperty("receipt");

    const envelope = await signInManager();
    const page = await list({ bearer: envelope }, { from: nextDay, to: nextDay });
    expect(refs(page)).toEqual([res.body.saleRef]);
    expect(page.body.items[0].saleNumber).toBe(RECEIPT.saleNumber);

    const d = await detail({ bearer: envelope }, res.body.saleRef as string);
    expect(d.body.lines.map((l: { lineName: string; sequence: number }) => [l.sequence, l.lineName])).toEqual([
      [1, "Gadget"],
      [2, "Widget"],
    ]);
    expect(d.body).toMatchObject({
      lineOrder: "recorded",
      changeGiven: "7.5000",
      settledAt: RECEIPT.settledAt,
      receiptNumber: RECEIPT.saleNumber,
      receiptHeader: { branchName: RECEIPT.branchName, branchAddress: RECEIPT.branchAddress, taxRegistrationId: RECEIPT.taxRegistrationId },
      // Tenders are off by default (POS_SALE_TENDERS_ENABLED): tender-unknown.
      tenderState: "unknown",
      receiptFacts: "partial",
    });
    expect(d.body.summary.operator).toEqual({ userRef: CASHIER, displayName: "Cashier One", nameSource: "snapshot" });
  });

  it("the receipt is kept out of payload_hash, and a replay never rewrites the stored snapshot", async () => {
    if (skip()) return;
    await admission({ createdAt: fromNow(-2 * HOUR) });
    const externalId = `rt539-${randomUUID()}`;
    const occurredAt = fromNow(-30 * 60_000);
    const body = captureBody({ externalId, occurredAt, receipt: RECEIPT });
    const first = await capture(body);
    expect(first.status).toBe(201);

    const { operatorUserId: _claim, receipt: _receipt, ...saleFacts } = body;
    const stored = await E().admin.query<{ payload_hash: string; receipt_sale_number: string }>(
      `SELECT payload_hash, receipt_sale_number FROM sales WHERE id = $1`,
      [first.body.saleRef],
    );
    expect(stored.rows[0]?.payload_hash).toBe(sha256CanonicalHex(saleFacts));

    // Same provenance, another key, another snapshot: a provenance replay (200), first write wins.
    const replay = await capture({ ...body, receipt: { ...RECEIPT, saleNumber: "rewritten" } });
    expect(replay.status).toBe(200);
    expect(replay.body.saleRef).toBe(first.body.saleRef);
    const after = await E().admin.query<{ receipt_sale_number: string }>(
      `SELECT receipt_sale_number FROM sales WHERE id = $1`,
      [first.body.saleRef],
    );
    expect(after.rows[0]?.receipt_sale_number).toBe(RECEIPT.saleNumber);
  });

  it("a sale captured without a receipt has no snapshot but keeps its line order", async () => {
    if (skip()) return;
    await admission({ createdAt: fromNow(-2 * HOUR) });
    const res = await capture(captureBody({ externalId: `rt539-${randomUUID()}`, occurredAt: fromNow(-30 * 60_000) }));
    expect(res.status).toBe(201);
    const rows = await E().admin.query<{ line_name: string; line_seq: number }>(
      `SELECT line_name, line_seq FROM sale_lines WHERE sale_id = $1 ORDER BY line_seq`,
      [res.body.saleRef],
    );
    expect(rows.rows).toEqual([
      { line_name: "Gadget", line_seq: 1 },
      { line_name: "Widget", line_seq: 2 },
    ]);
    const sale = await E().admin.query(`SELECT receipt_sale_number FROM sales WHERE id = $1`, [res.body.saleRef]);
    expect(sale.rows[0]?.receipt_sale_number).toBeNull();
  });

  it.each([
    ["an unknown receipt field", { ...RECEIPT, storeId: STORE }],
    ["a missing header field", { ...RECEIPT, taxRegistrationId: undefined }],
    ["a 65-character terminal label", { ...RECEIPT, terminalLabel: "t".repeat(65) }],
    ["a negative change", { ...RECEIPT, changeGiven: "-1.00" }],
    ["a year-0000 settled time", { ...RECEIPT, settledAt: "0000-10-16T09:00:00Z" }],
  ])("%s is a 400 and records nothing", async (_label, receipt) => {
    if (skip()) return;
    await admission({ createdAt: fromNow(-2 * HOUR) });
    const res = await capture(captureBody({ externalId: `rt539-${randomUUID()}`, occurredAt: fromNow(-30 * 60_000), receipt }));
    expect(res.status).toBe(400);
    const n = await E().admin.query(`SELECT count(*)::int AS n FROM sales`);
    expect(n.rows[0]?.n).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Reprints (RT-537 D-7) and their audit (OD-534-7)
// ---------------------------------------------------------------------------

describe("RT-539 — receipt reprints", () => {
  it("authorize: a manager on ANOTHER till gets the server's next copy number for a duplicate", async () => {
    if (skip()) return;
    const sale = await seedCompleteSale();
    const envelope = await signInManager(TOKEN_2);
    const body = { mode: "authorize", kind: "duplicate", printedAt: fromNow(0) };
    const first = await reprint({ bearer: envelope }, sale.id, body);
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ saleRef: sale.id, mode: "authorize", kind: "duplicate", marks: [], copyNumber: 1 });
    const second = await reprint({ bearer: envelope }, sale.id, { ...body, printedAt: fromNow(0) });
    expect(second.body.copyNumber).toBe(2);
    expect(await reprintRows(sale.id)).toEqual([
      expect.objectContaining({ copy_number: 1, created_by: MANAGER, device_id: DEVICE_2, kind: "duplicate" }),
      expect.objectContaining({ copy_number: 2 }),
    ]);
    const audits = await reprintAudits(sale.id);
    expect(audits).toHaveLength(2);
    expect(audits[0]).toMatchObject({
      actor_user_id: MANAGER,
      metadata: { outcome: "recorded", mode: "authorize", kind: "duplicate", copy_number: 1, marks: [], device_id: DEVICE_2 },
    });
  });

  it("authorize a duplicate of an incomplete or voided sale: 422, audited refused, nothing recorded", async () => {
    if (skip()) return;
    const legacy = await seedSale({ businessDate: "2026-10-15", occurredAt: "2026-10-15T09:00:00Z" });
    const voided = await seedCompleteSale();
    await seedApprovedVoid(voided.id);
    const envelope = await signInManager();
    for (const saleRef of [legacy.id, voided.id]) {
      const res = await reprint({ bearer: envelope }, saleRef, { mode: "authorize", kind: "duplicate", printedAt: fromNow(0) });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe("reprint_duplicate_unavailable");
      expect(await reprintRows(saleRef)).toEqual([]);
      expect(await reprintAudits(saleRef)).toEqual([
        expect.objectContaining({ metadata: expect.objectContaining({ outcome: "refused", reason: "duplicate_unavailable" }) }),
      ]);
    }
  });

  it("a voided sale's sale record is allowed and marked voided", async () => {
    if (skip()) return;
    const sale = await seedCompleteSale();
    await seedApprovedVoid(sale.id);
    const envelope = await signInManager();
    const res = await reprint({ bearer: envelope }, sale.id, { mode: "authorize", kind: "sale_record", printedAt: fromNow(0) });
    expect(res.status).toBe(201);
    expect(res.body.marks).toEqual(["voided"]);
    expect(await reprintRows(sale.id)).toEqual([expect.objectContaining({ marked_voided: true, marked_returned: false })]);
  });

  it("a cashier authorizes a reprint of their own sale on another till, never another cashier's (404)", async () => {
    if (skip()) return;
    const mine = await seedCompleteSale();
    const theirs = await seedCompleteSale({ createdBy: CASHIER_2 });
    const adm = await admission({ device: DEVICE_2 });
    const body = { mode: "authorize", kind: "duplicate", printedAt: fromNow(0) };
    const ok = await reprint({ bearer: TOKEN_2, admission: adm }, mine.id, body);
    expect(ok.status).toBe(201);
    expect(await reprintRows(mine.id)).toEqual([expect.objectContaining({ created_by: CASHIER, device_id: DEVICE_2 })]);
    const res = await reprint({ bearer: TOKEN_2, admission: adm }, theirs.id, body);
    expect(res.status).toBe(404);
    expect(await reprintRows(theirs.id)).toEqual([]);
  });

  it("record: the capturing till reports its own copy number, even for an incomplete or voided sale", async () => {
    if (skip()) return;
    const sale = await seedSale({ businessDate: "2026-10-15", occurredAt: "2026-10-15T09:00:00Z" });
    await seedApprovedVoid(sale.id);
    const adm = await admission({});
    const res = await reprint({ bearer: TOKEN, admission: adm }, sale.id, {
      mode: "record",
      kind: "duplicate",
      printedAt: fromNow(-60_000),
      localCopyNumber: 4,
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ mode: "record", copyNumber: 4, marks: ["voided"] });
  });

  it("record from a device other than the capturing one is a 403 refused, audited", async () => {
    if (skip()) return;
    const sale = await seedCompleteSale();
    const adm = await admission({ device: DEVICE_2 });
    const res = await reprint({ bearer: TOKEN_2, admission: adm }, sale.id, {
      mode: "record",
      kind: "duplicate",
      printedAt: fromNow(-60_000),
      localCopyNumber: 1,
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("refused");
    expect(await reprintRows(sale.id)).toEqual([]);
    expect(await reprintAudits(sale.id)).toEqual([
      expect.objectContaining({
        actor_user_id: CASHIER,
        metadata: expect.objectContaining({ outcome: "refused", reason: "not_capturing_device", mode: "record" }),
      }),
    ]);
  });

  it("an offline record replays after sign-out: the admission is checked at printedAt, not now", async () => {
    if (skip()) return;
    const sale = await seedCompleteSale();
    const adm = await admission({ createdAt: fromNow(-3 * HOUR), endedAt: fromNow(-HOUR) });
    const recorded = await reprint({ bearer: TOKEN, admission: adm }, sale.id, {
      mode: "record",
      kind: "duplicate",
      printedAt: fromNow(-2 * HOUR),
      localCopyNumber: 1,
    });
    expect(recorded.status).toBe(201);
    // The same ended admission cannot AUTHORIZE (live now) nor record outside its window.
    const authorize = await reprint({ bearer: TOKEN, admission: adm }, sale.id, {
      mode: "authorize",
      kind: "duplicate",
      printedAt: fromNow(0),
    });
    expect(authorize.status).toBe(403);
    const late = await reprint({ bearer: TOKEN, admission: adm }, sale.id, {
      mode: "record",
      kind: "duplicate",
      printedAt: fromNow(-10 * 60_000),
      localCopyNumber: 2,
    });
    expect(late.status).toBe(403);
    const refused = (await reprintAudits(sale.id)).filter((a) => a.metadata["outcome"] === "refused");
    expect(refused.map((a) => a.metadata["reason"])).toEqual(["admission_not_live", "admission_not_covering"]);
  });

  it("an identical retry replays the stored 201 (Idempotent-Replayed) and records once", async () => {
    if (skip()) return;
    const sale = await seedCompleteSale();
    const adm = await admission({});
    const body = { mode: "record", kind: "duplicate", printedAt: fromNow(-60_000), localCopyNumber: 2 };
    const key = `rt539-print-event-${randomUUID()}`;
    const first = await reprint({ bearer: TOKEN, admission: adm }, sale.id, body, key);
    const retry = await reprint({ bearer: TOKEN, admission: adm }, sale.id, body, key);
    expect(first.status).toBe(201);
    expect(retry.status).toBe(201);
    expect(retry.headers["idempotent-replayed"]).toBe("true");
    expect(retry.body).toEqual(first.body);
    expect(await reprintRows(sale.id)).toHaveLength(1);
    const conflict = await reprint({ bearer: TOKEN, admission: adm }, sale.id, { ...body, localCopyNumber: 3 }, key);
    expect(conflict.status).toBe(409);
  });

  it("a malformed reprint body is a 400; another store's sale is a 404", async () => {
    if (skip()) return;
    const otherStore = await seedCompleteSale({ store: STORE_2, device: DEVICE_S2 });
    const envelope = await signInManager();
    const bad = await reprint({ bearer: envelope }, otherStore.id, { mode: "record", kind: "duplicate", printedAt: fromNow(0) });
    expect(bad.status).toBe(400);
    const res = await reprint({ bearer: envelope }, otherStore.id, { mode: "authorize", kind: "sale_record", printedAt: fromNow(0) });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Per-device rate limits (ADR 0009) and copy-number safety
// ---------------------------------------------------------------------------

describe("RT-539 — rate limits and copy numbers", () => {
  it("the reads share the posReadSaleHistory bucket of the device; over it is a 429 with Retry-After", async () => {
    if (skip()) return;
    const sale = await seedCompleteSale();
    const adm = await admission({});
    expect((await detail({ bearer: TOKEN, admission: adm }, sale.id)).status).toBe(200);
    expect(limiter.calls).toContainEqual({ bucket: "posReadSaleHistory", key: DEVICE });

    limiter.denyBucket = "posReadSaleHistory";
    limiter.denyKey = DEVICE;
    const res = await list({ bearer: TOKEN, admission: adm }, RANGE);
    expect(res.status).toBe(429);
    expect(res.headers["retry-after"]).toBe("30");
    // Another till of the store has its own budget.
    const adm2 = await admission({ user: CASHIER_2, device: DEVICE_2 });
    expect((await list({ bearer: TOKEN_2, admission: adm2 }, RANGE)).status).toBe(200);
  });

  it("the envelope's reprint uses the posWriteSaleReprint bucket of its bound device", async () => {
    if (skip()) return;
    const sale = await seedCompleteSale();
    const envelope = await signInManager(TOKEN_2);
    limiter.denyBucket = "posWriteSaleReprint";
    limiter.denyKey = DEVICE_2;
    const res = await reprint({ bearer: envelope }, sale.id, { mode: "authorize", kind: "sale_record", printedAt: fromNow(0) });
    expect(res.status).toBe(429);
    expect(await reprintRows(sale.id)).toEqual([]);
    expect(limiter.calls).toContainEqual({ bucket: "posWriteSaleReprint", key: DEVICE_2 });
  });

  it("a terminal-reported copy number can never push the server's sequence out of range", async () => {
    if (skip()) return;
    const sale = await seedCompleteSale();
    const adm = await admission({});
    const recorded = await reprint({ bearer: TOKEN, admission: adm }, sale.id, {
      mode: "record",
      kind: "duplicate",
      printedAt: fromNow(-60_000),
      localCopyNumber: 2147483647,
    });
    expect(recorded.status).toBe(201);
    const authorized = await reprint({ bearer: TOKEN, admission: adm }, sale.id, {
      mode: "authorize",
      kind: "duplicate",
      printedAt: fromNow(0),
    });
    expect(authorized.status).toBe(201);
    expect(authorized.body.copyNumber).toBe(1);
  });
});
