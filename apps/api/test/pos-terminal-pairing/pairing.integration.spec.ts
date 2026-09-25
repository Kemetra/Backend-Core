/**
 * pairing.integration.spec.ts — 027 POS Terminal-Pairing CONSUME, end-to-end.
 *
 * Boots the REAL PairingController + PairingService against a Testcontainers
 * Postgres with every migration applied (incl. 0024). Seeds a tenant + store +
 * a `pending` pairing_codes row through the admin pool (the same authorized seed
 * lane the pilot smoke uses), then drives the consume over HTTP and asserts:
 *
 *   - happy path → 200 with the full 11-field binding + a device_token;
 *   - the returned device_token AUTHENTICATES via the REAL PosDeviceAuthGuard
 *     path (DeviceRepository.findActiveByAttestation) — i.e. read-down would
 *     accept it;
 *   - replay of the same code → 410 EXPIRED_CODE (pending → used burn);
 *   - unknown code → 404 INVALID_CODE;
 *   - expired code → 410; cancelled code → 410;
 *   - already-paired same branch → 409 ALREADY_PAIRED;
 *   - already-paired different branch → 409 BRANCH_MISMATCH (prior pairing kept);
 *   - malformed body → 400 validation_failure;
 *   - over-budget attempts → 429 RATE_LIMITED + Retry-After.
 *
 * Docker policy mirrors the read-down device-principal spec: HARD failure unless
 * MIGRATION_TEST_ALLOW_SKIP=1 (CI MUST NOT set it). WSL-only / Testcontainers.
 */
import "reflect-metadata";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { Pool } from "pg";
import request from "supertest";
import { hashToken } from "@data-pulse-2/auth";

import { GlobalExceptionFilter } from "../../src/common/exception.filter";
import {
  AlwaysAllowRedis,
  AUTH_LOOKUP_POOL,
  PG_POOL,
} from "../../src/auth/auth.module";
import { RateLimiter } from "../../src/auth/rate-limit";
import { PosDeviceAuthGuard } from "../../src/auth/pos-device-auth.guard";
import { DeviceRepository } from "../../src/pos-operators/device.repository";
import { PairingController } from "../../src/pos-terminal-pairing/pairing.controller";
import { PairingService } from "../../src/pos-terminal-pairing/pairing.service";
import { MAX_ATTEMPTS_PER_CODE } from "../../src/pos-terminal-pairing/pairing.service";

import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../_helpers/postgres-container";

const TENANT = "0e000000-0000-7000-8000-00000000ee01";
const STORE_X = "0e000000-0000-7000-8000-00000000e5a1";
const STORE_Y = "0e000000-0000-7000-8000-00000000e5a2";

// Each code row pins its own terminal_id; the device minted on the burn gets
// id = terminal_id.
const TERMINAL_HAPPY = "0e000000-0000-7000-8000-0000000071a1";
const TERMINAL_PAIRED = "0e000000-0000-7000-8000-0000000071a2";
const TERMINAL_RATE = "0e000000-0000-7000-8000-0000000071a3";

const RAW_HAPPY = "HAPPY-CODE-0001";
const RAW_EXPIRED = "EXPIRED-CODE-01";
const RAW_CANCELLED = "CANCELLED-CD-01";
const RAW_SAMEBRANCH = "SAMEBRANCH-0001";
const RAW_DIFFBRANCH = "DIFFBRANCH-0001";
const RAW_RATE = "RATELIMIT-00001";

let env: PgTestEnv | null = null;
let app: INestApplication | null = null;

interface SeedCodeOpts {
  rawCode: string;
  storeId: string;
  terminalId: string;
  status?: "pending" | "used" | "cancelled";
  expiresInMs?: number;
  comPort?: string | null;
}

async function seedTenantAndStores(pool: Pool): Promise<void> {
  await pool.query(
    `INSERT INTO tenants (id, slug, name) VALUES ($1, 'pairing-tenant', 'Pairing Tenant')
     ON CONFLICT (id) DO NOTHING`,
    [TENANT],
  );
  await pool.query(
    `INSERT INTO stores (id, tenant_id, code, name) VALUES
       ($1, $3, 'BR-X', 'Maadi Branch X'),
       ($2, $3, 'BR-Y', 'Maadi Branch Y')
     ON CONFLICT (id) DO NOTHING`,
    [STORE_X, STORE_Y, TENANT],
  );
}

async function seedCode(pool: Pool, opts: SeedCodeOpts): Promise<void> {
  const expiresAt = new Date(Date.now() + (opts.expiresInMs ?? 600_000));
  await pool.query(
    `INSERT INTO pairing_codes
       (tenant_id, store_id, code_hash, terminal_id, terminal_label, branch_name,
        branch_address, tenant_tax_registration_id, printer_vendor_id,
        printer_product_id, printer_com_port, status, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      TENANT,
      opts.storeId,
      hashToken(opts.rawCode),
      opts.terminalId,
      "Counter 1",
      "Maadi Pharmacy Branch X",
      "12 Road 9, Maadi, Cairo",
      "123456789",
      "0x04B8",
      "0x0202",
      opts.comPort === undefined ? null : opts.comPort,
      opts.status ?? "pending",
      expiresAt.toISOString(),
    ],
  );
}

/** Insert a live device at a terminal id (simulates a prior pairing). */
async function seedExistingDevice(
  pool: Pool,
  terminalId: string,
  storeId: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO devices (id, tenant_id, store_id, label, token_hash)
     VALUES ($1, $2, $3, 'pre-existing', $4)
     ON CONFLICT (id) DO NOTHING`,
    [terminalId, TENANT, storeId, hashToken(`pre-${terminalId}`)],
  );
}

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[pairing.integration.spec] skipping — Docker unavailable: ${msg}\n`);
      env = null;
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }

  await applyAllUpAndCreateAppRole(env);
  await seedTenantAndStores(env.admin);

  // Codes for each scenario.
  await seedCode(env.admin, { rawCode: RAW_HAPPY, storeId: STORE_X, terminalId: TERMINAL_HAPPY });
  await seedCode(env.admin, { rawCode: RAW_EXPIRED, storeId: STORE_X, terminalId: "0e000000-0000-7000-8000-0000000071b1", expiresInMs: -60_000 });
  await seedCode(env.admin, { rawCode: RAW_CANCELLED, storeId: STORE_X, terminalId: "0e000000-0000-7000-8000-0000000071b2", status: "cancelled" });
  await seedCode(env.admin, { rawCode: RAW_SAMEBRANCH, storeId: STORE_X, terminalId: TERMINAL_PAIRED });
  await seedCode(env.admin, { rawCode: RAW_DIFFBRANCH, storeId: STORE_Y, terminalId: TERMINAL_PAIRED });
  await seedCode(env.admin, { rawCode: RAW_RATE, storeId: STORE_X, terminalId: TERMINAL_RATE });

  // A pre-existing device at TERMINAL_PAIRED under STORE_X → drives the
  // already-paired (same branch) and branch-mismatch (different branch) checks.
  await seedExistingDevice(env.admin, TERMINAL_PAIRED, STORE_X);

  const theEnv = env;
  const moduleRef = await Test.createTestingModule({
    controllers: [PairingController],
    providers: [
      // The service's writes run via runWithTenantContext under RLS, so the
      // app (non-superuser) pool is correct — but findByCode is a NO-GUC probe
      // that must see the row regardless of tenant context (the code IS the
      // source of context, exactly like DeviceRepository at sign-in). Keep the
      // bootstrap lookup pool distinct from the RLS-enforced domain pool, as in
      // the production module.
      { provide: PG_POOL, useFactory: (): Pool => theEnv.app },
      { provide: AUTH_LOOKUP_POOL, useFactory: (): Pool => theEnv.admin },
      {
        provide: RateLimiter,
        useValue: new RateLimiter(new AlwaysAllowRedis()),
      },
      PairingService,
      // For the device_token-authenticates assertion: the REAL guard path.
      { provide: DeviceRepository, useValue: new DeviceRepository(theEnv.admin) },
      PosDeviceAuthGuard,
    ],
  }).compile();

  app = moduleRef.createNestApplication({ bufferLogs: true });
  app.useGlobalFilters(new GlobalExceptionFilter());
  await app.init();
}, 180_000);

afterAll(async () => {
  if (app) await app.close();
  if (env) await stopPgEnv(env);
}, 60_000);

function skip(): boolean {
  if (!env || !app) {
    // eslint-disable-next-line no-console
    console.warn("[pairing.integration.spec] skipping — Docker unavailable");
    return true;
  }
  return false;
}

const http = () => request(app!.getHttpServer());
const PAIR = "/api/pos/v1/terminals/pair";

describe("posPairTerminal — happy path + device_token credential", () => {
  it("seeded pending code → 200 with the full 11-field binding + device_token", async () => {
    if (skip()) return;
    const res = await http().post(PAIR).send({ pairing_code: RAW_HAPPY });
    expect(res.status).toBe(200);
    const b = res.body;
    expect(typeof b.device_token).toBe("string");
    expect(b.device_token.length).toBeGreaterThanOrEqual(32);
    expect(b.tenant_id).toBe(TENANT);
    expect(b.branch_id).toBe(STORE_X);
    expect(b.terminal_id).toBe(TERMINAL_HAPPY);
    expect(b.terminal_label).toBe("Counter 1");
    expect(b.branch_name).toBe("Maadi Pharmacy Branch X");
    expect(b.branch_address).toBe("12 Road 9, Maadi, Cairo");
    expect(b.tenant_tax_registration_id).toBe("123456789");
    expect(b.printer_vendor_id).toBe("0x04B8");
    expect(b.printer_product_id).toBe("0x0202");
    expect(b.printer_com_port).toBeNull();
  });

  it("the returned device_token authenticates via PosDeviceAuthGuard (read-down would accept it)", async () => {
    if (skip()) return;
    // Re-issue is impossible (code is burned); re-derive the token from a fresh
    // pair on a separate code, then prove the DeviceRepository lookup resolves it.
    const freshCode = "FRESH-TOKEN-001";
    await seedCode(env!.admin, {
      rawCode: freshCode,
      storeId: STORE_X,
      terminalId: "0e000000-0000-7000-8000-0000000071c1",
    });
    const res = await http().post(PAIR).send({ pairing_code: freshCode });
    expect(res.status).toBe(200);
    const token: string = res.body.device_token;

    const repo = new DeviceRepository(env!.admin);
    const device = await repo.findActiveByAttestation(token);
    expect(device).not.toBeNull();
    expect(device?.tenantId).toBe(TENANT);
    expect(device?.storeId).toBe(STORE_X);
  });

  it("replay of a burned code → 410 EXPIRED_CODE", async () => {
    if (skip()) return;
    const res = await http().post(PAIR).send({ pairing_code: RAW_HAPPY });
    expect(res.status).toBe(410);
    expect(res.body.error.code).toBe("EXPIRED_CODE");
  });
});

describe("posPairTerminal — closed error set", () => {
  it("unknown code → 404 INVALID_CODE", async () => {
    if (skip()) return;
    const res = await http().post(PAIR).send({ pairing_code: "NOPE-NOPE-01" });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("INVALID_CODE");
  });

  it("expired code → 410 EXPIRED_CODE", async () => {
    if (skip()) return;
    const res = await http().post(PAIR).send({ pairing_code: RAW_EXPIRED });
    expect(res.status).toBe(410);
    expect(res.body.error.code).toBe("EXPIRED_CODE");
  });

  it("cancelled code → 410 EXPIRED_CODE", async () => {
    if (skip()) return;
    const res = await http().post(PAIR).send({ pairing_code: RAW_CANCELLED });
    expect(res.status).toBe(410);
    expect(res.body.error.code).toBe("EXPIRED_CODE");
  });

  it("already paired, SAME branch → 409 ALREADY_PAIRED", async () => {
    if (skip()) return;
    const res = await http().post(PAIR).send({ pairing_code: RAW_SAMEBRANCH });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("ALREADY_PAIRED");
  });

  it("already paired, DIFFERENT branch → 409 BRANCH_MISMATCH (prior pairing untouched)", async () => {
    if (skip()) return;
    const res = await http().post(PAIR).send({ pairing_code: RAW_DIFFBRANCH });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("BRANCH_MISMATCH");
    // The pre-existing device under STORE_X is still there + unrevoked.
    const dev = await env!.admin.query<{ store_id: string; revoked_at: Date | null }>(
      `SELECT store_id, revoked_at FROM devices WHERE id = $1`,
      [TERMINAL_PAIRED],
    );
    expect(dev.rows[0]?.store_id).toBe(STORE_X);
    expect(dev.rows[0]?.revoked_at).toBeNull();
  });

  it("malformed body → 400 validation_failure", async () => {
    if (skip()) return;
    const tooShort = await http().post(PAIR).send({ pairing_code: "abc" });
    expect(tooShort.status).toBe(400);
    expect(tooShort.body.error.code).toBe("validation_failure");

    const missing = await http().post(PAIR).send({});
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe("validation_failure");

    const extra = await http()
      .post(PAIR)
      .send({ pairing_code: "valid-code-123", device_fingerprint: "x" });
    expect(extra.status).toBe(400);
    expect(extra.body.error.code).toBe("validation_failure");
  });

  it("over-budget attempts → 429 RATE_LIMITED + Retry-After", async () => {
    if (skip()) return;
    // The rate code is pending; each attempt increments attempt_count. The first
    // MAX_ATTEMPTS_PER_CODE attempts proceed (and, being a valid pending code,
    // the FIRST one actually pairs → 200). To isolate the limiter, exhaust the
    // budget on a code that fails the spent-check first is awkward; instead burn
    // the budget by repeatedly hitting an EXPIRED code (which still records an
    // attempt before the expired-check), then assert the (budget+1)th → 429.
    const rl = "RL-EXPIRED-0001";
    await seedCode(env!.admin, {
      rawCode: rl,
      storeId: STORE_X,
      terminalId: "0e000000-0000-7000-8000-0000000071d1",
      expiresInMs: -60_000,
    });
    let last = await http().post(PAIR).send({ pairing_code: rl });
    for (let i = 0; i < MAX_ATTEMPTS_PER_CODE + 1; i++) {
      last = await http().post(PAIR).send({ pairing_code: rl });
    }
    expect(last.status).toBe(429);
    expect(last.body.error.code).toBe("RATE_LIMITED");
    expect(Number(last.headers["retry-after"])).toBeGreaterThanOrEqual(1);
    expect(Number(last.headers["retry-after"])).toBeLessThanOrEqual(300);
  });
});

describe("posPairTerminal — RLS fail-closed on pairing_codes", () => {
  it("a code under TENANT is invisible to a different tenant GUC (app pool)", async () => {
    if (skip()) return;
    const client = await env!.app.connect();
    try {
      await client.query(`SET app.current_tenant = '0f000000-0000-7000-8000-00000000ff01'`);
      const wrong = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM pairing_codes WHERE tenant_id = $1`,
        [TENANT],
      );
      expect(wrong.rows[0]?.count).toBe("0");
      await client.query(`SET app.current_tenant = '${TENANT}'`);
      const right = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM pairing_codes WHERE tenant_id = $1`,
        [TENANT],
      );
      expect(Number(right.rows[0]?.count)).toBeGreaterThanOrEqual(1);
    } finally {
      client.release();
    }
  });

  it("empty GUC fails closed (zero rows, no 22P02)", async () => {
    if (skip()) return;
    const client = await env!.app.connect();
    try {
      await client.query(`RESET app.current_tenant`);
      const r = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM pairing_codes`,
      );
      expect(r.rows[0]?.count).toBe("0");
    } finally {
      client.release();
    }
  });
});
