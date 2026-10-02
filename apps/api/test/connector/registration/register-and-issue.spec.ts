/**
 * 018-US1-REGISTER-ISSUE (T040) 🎯 MVP — register → list → issue end-to-end.
 *
 * Exercises the connector boundary admin surface against a Testcontainers
 * Postgres 16, mirroring the 014 set-retire harness (ConfigurableContextGuard +
 * overridden production guards + RLS-active PG_POOL bound to env.app). The
 * SessionOnlyAdminGuard's kind-check (FR-005c) is bypassed by the guard override
 * here and is proven separately in `session-only-admin.guard.spec.ts`.
 *
 * Routes under test (packages/contracts/openapi/connector/connector-admin.yaml):
 *   POST /api/v1/connector/instances                      (register, 201)
 *   GET  /api/v1/connector/instances                      (list,     200)
 *   POST /api/v1/connector/instances/:id/credentials      (issue,    201)
 *
 * Sub-cases:
 *   §1 register happy path — lands environment + display_name; §IV projection
 *      (no raw entity); no active_credential yet.
 *   §2 mass-assignment ban — smuggled tenant_id/id/created_by → 400 (strict §XII).
 *   §3 duplicate (env, site_ref) for the tenant → 409 conflict (FR-005a).
 *   §4 issue happy path — raw secret returned ONCE; bounded expiry default 90d.
 *   §5 the list projection shows the active-credential STATUS but NEVER a secret/hash.
 *   §6 issue for a cross-tenant / absent instance → non-disclosing 404.
 *   §7 register + issue each write exactly one in-tx audit_events row (FR-020).
 */
import "reflect-metadata";

import {
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import type { Pool } from "pg";
import request from "supertest";

import { PG_POOL } from "../../../src/auth/auth.module";
import { RolesGuard } from "../../../src/auth/roles.guard";
import { SessionOnlyAdminGuard } from "../../../src/auth/session-only-admin.guard";
import { GlobalExceptionFilter } from "../../../src/common/exception.filter";
import { TenantContextGuard } from "../../../src/context/tenant-context.guard";
import type { ResolvedContext } from "../../../src/context/types";
import { ConnectorRegistrationController } from "../../../src/connector/connector-registration.controller";
import { ConnectorRegistrationService } from "../../../src/connector/connector-registration.service";

import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../_helpers/postgres-container";
import {
  CONNECTOR_FIXTURE_IDS,
  REGISTRATION_B,
  seedConnectorFixture,
} from "../__support__/seed-connector";

const TENANT_A = CONNECTOR_FIXTURE_IDS.tenantA;
const ACTOR_A = "0a000000-0000-7000-8000-0000000000ac";

const BASE = "/api/v1/connector/instances";

class ConfigurableContextGuard implements CanActivate {
  public tenantId: string = TENANT_A;
  public userId: string = ACTOR_A;

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<{
      context?: ResolvedContext;
      principal?: { userId?: string };
    }>();
    req.context = {
      userId: this.userId,
      tenantId: this.tenantId,
      storeId: null,
      isPlatformAdmin: false,
      source: "session",
    };
    req.principal = { userId: this.userId };
    return true;
  }
}

let env: PgTestEnv | null = null;
let app: INestApplication | null = null;
let contextGuard: ConfigurableContextGuard;
let dockerSkipped = false;

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      dockerSkipped = true;
      // eslint-disable-next-line no-console
      console.warn(`\n[register-and-issue.spec] Docker NOT AVAILABLE: ${msg}\n`);
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }

  await applyAllUpAndCreateAppRole(env);
  await seedConnectorFixture(env);

  const localEnv = env;
  contextGuard = new ConfigurableContextGuard();

  const moduleRef = await Test.createTestingModule({
    controllers: [ConnectorRegistrationController],
    providers: [
      { provide: PG_POOL, useFactory: (): Pool => localEnv.app },
      ConnectorRegistrationService,
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
  app.useGlobalGuards(contextGuard);
  await app.init();
  // The Reflector import keeps the guard-metadata machinery in the bundle.
  void Reflector;
}, 180_000);

afterAll(async () => {
  if (app) await app.close();
  if (env) await stopPgEnv(env);
}, 60_000);

beforeEach(() => {
  if (dockerSkipped) return;
  contextGuard.tenantId = TENANT_A;
  contextGuard.userId = ACTOR_A;
});

afterEach(async () => {
  if (dockerSkipped || !env) return;
  // Keep sub-cases independent: drop any instance created in this test (and its
  // credentials via the FK), except the seeded REGISTRATION_A/B.
  await env.admin.query(
    `DELETE FROM auth_tokens
      WHERE scope = 'connector'
        AND connector_registration_id NOT IN ($1, $2)`,
    [CONNECTOR_FIXTURE_IDS.registrationA, REGISTRATION_B],
  );
  await env.admin.query(
    `DELETE FROM connector_registration
      WHERE id NOT IN ($1, $2)`,
    [CONNECTOR_FIXTURE_IDS.registrationA, REGISTRATION_B],
  );
  // audit_events rows are not cleaned up: the table is append-only (RT-133),
  // and every audit assertion here is scoped to its own target_id.
});

function maybeSkip(): boolean {
  if (dockerSkipped) {
    // eslint-disable-next-line no-console
    console.warn("[register-and-issue.spec] skipping — Docker unavailable");
    return true;
  }
  return false;
}

function http() {
  if (!app) throw new Error("app not initialised");
  return request(app.getHttpServer());
}

async function auditCount(action: string, targetId: string): Promise<number> {
  const r = await env!.admin.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM audit_events WHERE action = $1 AND target_id = $2`,
    [action, targetId],
  );
  return Number(r.rows[0]!.n);
}

describe("018-US1 — register", () => {
  it("§1 register happy path — projects identity, no secret, no active credential", async () => {
    if (maybeSkip()) return;
    const res = await http()
      .post(BASE)
      .send({ display_name: "Pilot Conn", erpnext_site_ref: "erp-x.example", environment: "pilot" })
      .expect(201);
    expect(res.body.id).toEqual(expect.any(String));
    expect(res.body.display_name).toBe("Pilot Conn");
    expect(res.body.environment).toBe("pilot");
    expect(res.body.active_credential).toBeNull();
    expect(res.body.secret).toBeUndefined();
    expect(res.body.token_hash).toBeUndefined();
  });

  it("§2 mass-assignment ban — smuggled server-resolved fields → 400", async () => {
    if (maybeSkip()) return;
    await http()
      .post(BASE)
      .send({
        display_name: "X",
        erpnext_site_ref: "erp-y.example",
        environment: "pilot",
        tenant_id: "0b000000-0000-7000-8000-00000000bdb1",
        id: "0f000000-0000-7000-8000-00000000dead",
        created_by: "0f000000-0000-7000-8000-00000000dead",
      })
      .expect(400);
  });

  it("§3 duplicate (environment, site_ref) for the tenant → 409 conflict", async () => {
    if (maybeSkip()) return;
    const body = { display_name: "Dup", erpnext_site_ref: "erp-dup.example", environment: "staging" };
    await http().post(BASE).send(body).expect(201);
    const res = await http().post(BASE).send(body).expect(409);
    expect(res.body.error.code).toBe("conflict");
  });

  it("§7 register writes exactly one in-tx audit row", async () => {
    if (maybeSkip()) return;
    const res = await http()
      .post(BASE)
      .send({ display_name: "Aud", erpnext_site_ref: "erp-aud.example", environment: "dev" })
      .expect(201);
    expect(await auditCount("connector.registration.created", res.body.id)).toBe(1);
  });
});

describe("018-US1 — issue", () => {
  it("§4 issue happy path — raw secret returned ONCE, bounded expiry ~90d", async () => {
    if (maybeSkip()) return;
    const reg = await http()
      .post(BASE)
      .send({ display_name: "Iss", erpnext_site_ref: "erp-iss.example", environment: "pilot" })
      .expect(201);
    const res = await http().post(`${BASE}/${reg.body.id}/credentials`).send({}).expect(201);
    expect(res.body.secret).toEqual(expect.any(String));
    expect(res.body.secret.length).toBeGreaterThan(16);
    expect(res.body.credential_id).toEqual(expect.any(String));
    const expDays = (new Date(res.body.expires_at).getTime() - new Date(res.body.issued_at).getTime()) / 86_400_000;
    expect(expDays).toBeGreaterThan(89);
    expect(expDays).toBeLessThan(91);
    expect(await auditCount("connector.credential.issued", reg.body.id)).toBe(1);
  });

  it("§5 list shows active-credential STATUS but never a secret/hash", async () => {
    if (maybeSkip()) return;
    const reg = await http()
      .post(BASE)
      .send({ display_name: "Lst", erpnext_site_ref: "erp-lst.example", environment: "pilot" })
      .expect(201);
    await http().post(`${BASE}/${reg.body.id}/credentials`).send({}).expect(201);
    const res = await http().get(BASE).expect(200);
    const found = res.body.items.find((i: { id: string }) => i.id === reg.body.id);
    expect(found.active_credential).not.toBeNull();
    expect(found.active_credential.credential_id).toEqual(expect.any(String));
    expect(found.active_credential.secret).toBeUndefined();
    expect(found.active_credential.token_hash).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toMatch(/secret|token_hash/i);
  });

  it("RT-62 a second issue while a credential is active → 409 conflict, first credential untouched", async () => {
    if (maybeSkip()) return;
    const reg = await http()
      .post(BASE)
      .send({ display_name: "Dup", erpnext_site_ref: "erp-dup.example", environment: "pilot" })
      .expect(201);
    const first = await http().post(`${BASE}/${reg.body.id}/credentials`).send({}).expect(201);
    const second = await http().post(`${BASE}/${reg.body.id}/credentials`).send({});
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("conflict");
    expect(JSON.stringify(second.body)).not.toMatch(/secret|token_hash|uq_auth_tokens/i);
    // The active credential is still the first one; nothing else was written.
    const list = await http().get(BASE).expect(200);
    const found = list.body.items.find((i: { id: string }) => i.id === reg.body.id);
    expect(found.active_credential.credential_id).toBe(first.body.credential_id);
    expect(await auditCount("connector.credential.issued", reg.body.id)).toBe(1);
    // Rotation stays the way to replace it.
    await http().post(`${BASE}/${reg.body.id}/credentials/rotate`).send({}).expect(201);
  });

  it("RT-62 concurrent issues for one instance → exactly one 201, the rest 409 (never 5xx)", async () => {
    if (maybeSkip()) return;
    const reg = await http()
      .post(BASE)
      .send({ display_name: "Race", erpnext_site_ref: "erp-race.example", environment: "pilot" })
      .expect(201);
    const results = await Promise.all(
      Array.from({ length: 4 }, () => http().post(`${BASE}/${reg.body.id}/credentials`).send({})),
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 409, 409, 409]);
    expect(await auditCount("connector.credential.issued", reg.body.id)).toBe(1);
  });

  it("§6 issue for an absent / cross-tenant instance → non-disclosing 404", async () => {
    if (maybeSkip()) return;
    // REGISTRATION_B belongs to tenant B; tenant-A context cannot see it (RLS) → 404.
    await http().post(`${BASE}/${REGISTRATION_B}/credentials`).send({}).expect(404);
  });
});
