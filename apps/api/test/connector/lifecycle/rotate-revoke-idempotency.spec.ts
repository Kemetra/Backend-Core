/**
 * rotate-revoke-idempotency.spec.ts — Jira RT-155 AC2, AC6, AC7 (RT-82 K1–K3).
 *
 * Boots the connector admin controller behind the real IdempotencyInterceptor
 * and the REAL Postgres idempotency mirror (`PgIdempotencyMirror` on the RLS
 * app pool), with a retaining FakeRedis as the fast path, so the stored
 * `idempotency_keys` row and the Redis value are both inspected.
 *
 *   AC2 — the same key on another instance really rotates it (fresh secret,
 *         its old credential revoked); the same key on another credential
 *         really revokes it.
 *   AC6 — a rotate retry with the same key answers 409 without rotating, and
 *         no secret is in the `idempotency_keys` row or the Redis value.
 *   AC7 — a legacy (template-only) key row answers 409 on rotate, and nothing
 *         is rotated.
 *
 * Secret checks are booleans so a failure never prints a secret into CI logs.
 * Docker-gated.
 */
import "reflect-metadata";

import {
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
} from "@nestjs/common";
import { APP_INTERCEPTOR, Reflector } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import type { Pool } from "pg";
import request from "supertest";

import { IdempotencyKeyStore, newId } from "@data-pulse-2/shared";

import { PG_POOL } from "../../../src/auth/auth.module";
import { RolesGuard } from "../../../src/auth/roles.guard";
import { SessionOnlyAdminGuard } from "../../../src/auth/session-only-admin.guard";
import { GlobalExceptionFilter } from "../../../src/common/exception.filter";
import { ConnectorRegistrationController } from "../../../src/connector/connector-registration.controller";
import { ConnectorRegistrationService } from "../../../src/connector/connector-registration.service";
import { TenantContextGuard } from "../../../src/context/tenant-context.guard";
import type { ResolvedContext } from "../../../src/context/types";
import {
  IDEMPOTENCY_KEY_STORE,
  IdempotencyInterceptor,
  bodyFingerprint,
} from "../../../src/idempotency/idempotency.interceptor";
import { InProgressMarker } from "../../../src/idempotency/in-progress-marker";
import { PgIdempotencyMirror } from "../../../src/idempotency/pg-mirror";
import { composeStoreKey } from "../../../src/idempotency/store-key";

import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../_helpers/postgres-container";
import { assertIdempotencyRedisRetains } from "../../idempotency/require-retaining-redis";
import {
  CONNECTOR_FIXTURE_IDS,
  REGISTRATION_B,
  seedConnectorFixture,
} from "../__support__/seed-connector";

const TENANT_A = CONNECTOR_FIXTURE_IDS.tenantA;
const ACTOR_A = "0a000000-0000-7000-8000-0000000000ac";
const BASE = "/api/v1/connector/instances";
const ROTATE_TEMPLATE = "/api/v1/connector/instances/:id/credentials/rotate";

class FakeRedis {
  private readonly map = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.map.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<unknown> {
    this.map.set(key, value);
    return "OK";
  }
  values(): string[] {
    return [...this.map.values()];
  }
  clear(): void {
    this.map.clear();
  }
}

class FakeMarker {
  async trySet(): Promise<boolean> {
    return true;
  }
  async del(): Promise<void> {}
}

class ContextGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<{ context?: ResolvedContext; principal?: { userId?: string } }>();
    req.context = { userId: ACTOR_A, tenantId: TENANT_A, storeId: null, isPlatformAdmin: false, source: "session" };
    req.principal = { userId: ACTOR_A };
    return true;
  }
}

let env: PgTestEnv | null = null;
let app: INestApplication | null = null;
let redis: FakeRedis;
let dockerSkipped = false;

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      dockerSkipped = true;
      // eslint-disable-next-line no-console
      console.warn(`\n[rotate-revoke-idempotency.spec] Docker NOT AVAILABLE: ${msg}\n`);
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }
  await applyAllUpAndCreateAppRole(env);
  await seedConnectorFixture(env);

  const localEnv = env;
  redis = new FakeRedis();
  await assertIdempotencyRedisRetains(redis, "rotate-revoke-idempotency");
  const mirror = new PgIdempotencyMirror(localEnv.app as unknown as Pool);
  const store = new IdempotencyKeyStore({
    redis,
    pgWriter: mirror,
    pgReader: mirror,
    defaultTtlMs: 72 * 60 * 60 * 1000,
  });
  const interceptor = new IdempotencyInterceptor(
    new Reflector(),
    store,
    new FakeMarker() as unknown as InProgressMarker,
  );

  const moduleRef = await Test.createTestingModule({
    controllers: [ConnectorRegistrationController],
    providers: [
      { provide: PG_POOL, useFactory: (): Pool => localEnv.app },
      ConnectorRegistrationService,
      { provide: IDEMPOTENCY_KEY_STORE, useValue: store },
      { provide: APP_INTERCEPTOR, useValue: interceptor },
    ],
  })
    .overrideGuard(SessionOnlyAdminGuard)
    .useValue({ canActivate: () => true })
    .overrideGuard(TenantContextGuard)
    .useValue({ canActivate: () => true })
    .overrideGuard(RolesGuard)
    .useValue({ canActivate: () => true })
    .compile();

  app = moduleRef.createNestApplication({ bufferLogs: true });
  app.useGlobalFilters(new GlobalExceptionFilter());
  app.useGlobalGuards(new ContextGuard());
  await app.init();
}, 180_000);

afterAll(async () => {
  if (app) await app.close();
  if (env) await stopPgEnv(env);
}, 60_000);

afterEach(async () => {
  if (dockerSkipped || !env) return;
  redis.clear();
  await env.admin.query(`DELETE FROM idempotency_keys WHERE tenant_id = $1`, [TENANT_A]);
  await env.admin.query(
    `DELETE FROM auth_tokens WHERE scope = 'connector' AND connector_registration_id NOT IN ($1, $2)`,
    [CONNECTOR_FIXTURE_IDS.registrationA, REGISTRATION_B],
  );
  await env.admin.query(`DELETE FROM connector_registration WHERE id NOT IN ($1, $2)`, [
    CONNECTOR_FIXTURE_IDS.registrationA,
    REGISTRATION_B,
  ]);
});

function skip(): boolean {
  return dockerSkipped || !app;
}

function http() {
  return request(app!.getHttpServer());
}

/** Register an instance and issue its first credential; return both ids. */
async function instanceWithCredential(siteRef: string): Promise<{ id: string; credentialId: string }> {
  const reg = await http()
    .post(BASE)
    .send({ display_name: "RT-155", erpnext_site_ref: siteRef, environment: "pilot" })
    .expect(201);
  const issued = await http().post(`${BASE}/${reg.body.id}/credentials`).send({}).expect(201);
  return { id: reg.body.id as string, credentialId: issued.body.credential_id as string };
}

async function isRevoked(credentialId: string): Promise<boolean> {
  const r = await env!.admin.query<{ revoked: boolean }>(
    `SELECT revoked_at IS NOT NULL AS revoked FROM auth_tokens WHERE id = $1`,
    [credentialId],
  );
  return r.rows[0]!.revoked;
}

async function storedRowsText(): Promise<string> {
  const r = await env!.admin.query<{ body: string }>(
    `SELECT response_body::text AS body FROM idempotency_keys WHERE tenant_id = $1`,
    [TENANT_A],
  );
  return r.rows.map((row) => row.body).join("\n");
}

describe("RT-155 — rotate is keyed per instance and never replayed", () => {
  it("AC2: the same key on another instance rotates it and returns its own fresh secret", async () => {
    if (skip()) return;
    const a = await instanceWithCredential("erp-rt155-a.example");
    const b = await instanceWithCredential("erp-rt155-b.example");
    const key = "rt155-rotate-key-0000000000000001";

    const onA = await http().post(`${BASE}/${a.id}/credentials/rotate`).set("Idempotency-Key", key).send({}).expect(201);
    const onB = await http().post(`${BASE}/${b.id}/credentials/rotate`).set("Idempotency-Key", key).send({}).expect(201);

    expect(onB.headers["idempotent-replayed"]).toBeUndefined();
    expect(onB.body.instance_id).toBe(b.id);
    expect(onB.body.credential_id).not.toBe(onA.body.credential_id);
    expect(onB.body.secret === onA.body.secret).toBe(false);
    expect(await isRevoked(b.credentialId)).toBe(true);
    expect(await isRevoked(onB.body.credential_id as string)).toBe(false);
  });

  it("AC6: a same-key retry → 409, no second rotation, and no secret in the row or Redis", async () => {
    if (skip()) return;
    const a = await instanceWithCredential("erp-rt155-c.example");
    const key = "rt155-rotate-key-0000000000000002";

    const first = await http().post(`${BASE}/${a.id}/credentials/rotate`).set("Idempotency-Key", key).send({}).expect(201);
    const secret = first.body.secret as string;
    const retry = await http().post(`${BASE}/${a.id}/credentials/rotate`).set("Idempotency-Key", key).send({}).expect(409);

    expect(retry.body.error.code).toBe("idempotency_key_conflict");
    expect(JSON.stringify(retry.body).includes(secret)).toBe(false);
    // The credential from the first rotation is still the active one.
    expect(await isRevoked(first.body.credential_id as string)).toBe(false);

    const rows = await storedRowsText();
    expect(rows.includes(first.body.credential_id as string)).toBe(true);
    expect(rows.includes(secret)).toBe(false);
    expect(redis.values().some((v) => v.includes(secret))).toBe(false);
  });

  it("AC6: the durable row alone (Redis lost) still answers 409", async () => {
    if (skip()) return;
    const a = await instanceWithCredential("erp-rt155-d.example");
    const key = "rt155-rotate-key-0000000000000003";
    const first = await http().post(`${BASE}/${a.id}/credentials/rotate`).set("Idempotency-Key", key).send({}).expect(201);
    redis.clear();
    await http().post(`${BASE}/${a.id}/credentials/rotate`).set("Idempotency-Key", key).send({}).expect(409);
    expect(await isRevoked(first.body.credential_id as string)).toBe(false);
  });

  it("AC7: a legacy template-only row → 409, and the instance is not rotated", async () => {
    if (skip()) return;
    const a = await instanceWithCredential("erp-rt155-e.example");
    const key = "rt155-rotate-key-0000000000000004";
    const legacyKey = composeStoreKey("POST", ROTATE_TEMPLATE, ACTOR_A, key);
    await env!.admin.query(
      `INSERT INTO idempotency_keys
         (id, tenant_id, store_id, client_id, key, request_hash, response_status, response_body, expires_at)
       VALUES ($1, $2, NULL, $3, $4, $5, 201, $6::jsonb, now() + interval '1 hour')`,
      [newId(), TENANT_A, ACTOR_A, legacyKey, bodyFingerprint({}), JSON.stringify({ credential_id: "legacy" })],
    );

    const res = await http().post(`${BASE}/${a.id}/credentials/rotate`).set("Idempotency-Key", key).send({}).expect(409);
    expect(res.body.error.code).toBe("idempotency_key_conflict");
    expect(await isRevoked(a.credentialId)).toBe(false);
  });
});

describe("RT-155 — revoke is keyed per credential", () => {
  it("AC2: the same key on another credential really revokes it", async () => {
    if (skip()) return;
    const x = await instanceWithCredential("erp-rt155-x.example");
    const y = await instanceWithCredential("erp-rt155-y.example");
    const key = "rt155-revoke-key-0000000000000001";

    await http().post(`/api/v1/connector/credentials/${x.credentialId}/revoke`).set("Idempotency-Key", key).send({}).expect(200);
    const onY = await http()
      .post(`/api/v1/connector/credentials/${y.credentialId}/revoke`)
      .set("Idempotency-Key", key)
      .send({})
      .expect(200);

    expect(onY.headers["idempotent-replayed"]).toBeUndefined();
    expect(await isRevoked(x.credentialId)).toBe(true);
    expect(await isRevoked(y.credentialId)).toBe(true);
  });
});
