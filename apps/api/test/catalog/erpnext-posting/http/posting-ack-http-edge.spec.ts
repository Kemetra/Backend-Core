/**
 * 015-US2-ACK T042/T043 — HTTP-edge spec for connectorAckOutcome.
 *
 * Drives the REAL HTTP surface — ErpnextPostingController behind the REAL
 * ConnectorAuthGuard + the REAL IdempotencyInterceptor (APP_INTERCEPTOR) + real
 * `auth_tokens` — so the contract's auth / idempotency / strict-DTO / §XII
 * behaviors are actually proven (the service-level transitions + O-3 echo are
 * proven in ../ack/posting-ack.spec.ts):
 *
 *   - 401 wrong scope (dashboard_api REJECTED; only `connector`) — 012 connectorBearer;
 *   - 400 missing Idempotency-Key (x-idempotency: required);
 *   - 400 strict DTO (posted without documentRef; body-supplied tenant_id; unknown key);
 *   - 201 first record (posted) → 200 same-key replay (Idempotent-Replayed: true)
 *     → 409 same-key/different-body (idempotency_key_conflict);
 *   - 404 not_found on a cross-tenant workItemRef (non-disclosing).
 *
 * Idempotency stack uses FakeRedis/FakeMarker (no real Redis), mirroring the 009
 * __movement-harness. Bearer auth repos run on env.admin (RLS-bypass) — the token
 * lookup is a no-GUC read past FORCE-RLS (same as the US1 http-edge spec). Docker
 * policy: HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import "reflect-metadata";

import { type INestApplication, type Provider } from "@nestjs/common";
import { APP_INTERCEPTOR, Reflector } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import type { Pool } from "pg";
import request from "supertest";

import { generateRawToken } from "@data-pulse-2/auth";
import { newId } from "@data-pulse-2/shared";
import { IdempotencyKeyStore } from "@data-pulse-2/shared";

import { GlobalExceptionFilter } from "../../../../src/common/exception.filter";
import { PG_POOL } from "../../../../src/auth/auth.module";
import { AuthGuard } from "../../../../src/auth/auth.guard";
import { AuthTokenRepository } from "../../../../src/auth/auth-token.repository";
import { ConnectorAuthGuard } from "../../../../src/auth/connector-auth.guard";
import { SessionRepository } from "../../../../src/auth/session.repository";
import {
  IDEMPOTENCY_KEY_STORE,
  IdempotencyInterceptor,
} from "../../../../src/idempotency/idempotency.interceptor";
import {
  INFLIGHT_REDIS,
  InProgressMarker,
} from "../../../../src/idempotency/in-progress-marker";
import { ErpnextPostingController } from "../../../../src/catalog/erpnext-posting/erpnext-posting.controller";
import { ErpnextPostingService } from "../../../../src/catalog/erpnext-posting/erpnext-posting.service";
import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../../_helpers/postgres-container";
import { TENANT_A } from "../../__support__/isolation-harness";
import {
  POST_A_PENDING,
  POST_B_POSTED,
  seedPostingStatusFixture,
} from "../__support__/seed-posting-status";

const ACTOR_USER = "01900000-0000-7000-8000-0000000a7c01";
const ackPath = (ref: string) =>
  `/api/connector/v1/erpnext/postings/${ref}/outcome`;
const DOC = { doctype: "Sales Invoice", name: "ACC-SINV-A-9001" };

let connectorToken = "";
let dashboardToken = "";
let env: PgTestEnv | null = null;
let app: INestApplication | null = null;
let skip = false;

/** A fresh 32-char ASCII idempotency key per call site. */
function idemp(suffix: string): string {
  return (suffix + "0".repeat(32)).slice(0, 32).replace(/[^a-z0-9]/g, "0");
}

class FakeRedis {
  private readonly store = new Map<string, { value: string; expiresAt: number }>();
  async get(key: string): Promise<string | null> {
    const e = this.store.get(key);
    if (!e) return null;
    if (Date.now() > e.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return e.value;
  }
  async set(key: string, value: string, options: { px: number }): Promise<unknown> {
    this.store.set(key, { value, expiresAt: Date.now() + options.px });
    return "OK";
  }
  clear(): void {
    this.store.clear();
  }
}
class FakeMarker {
  async trySet(): Promise<boolean> {
    return true;
  }
  async del(): Promise<void> {}
}

async function issueToken(
  tokens: AuthTokenRepository,
  scope: string,
  connectorRegistrationId?: string,
): Promise<string> {
  const raw = generateRawToken();
  await tokens.issue(raw, {
    id: newId(),
    tenantId: TENANT_A,
    userId: ACTOR_USER,
    deviceId: null,
    scope,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    // 018-US4: a connector token MUST link to a non-disabled registration.
    connectorRegistrationId: connectorRegistrationId ?? null,
  } as Parameters<AuthTokenRepository["issue"]>[1]);
  return raw;
}

// RT-152: the connector feed is gated on DEPLOYMENT_ENVIRONMENT; the registration
// seeded below is 'pilot', so this deployment must declare the same environment.
const savedDeploymentEnv = process.env["DEPLOYMENT_ENVIRONMENT"];
beforeAll(() => {
  process.env["DEPLOYMENT_ENVIRONMENT"] = "pilot";
});
afterAll(() => {
  if (savedDeploymentEnv === undefined) delete process.env["DEPLOYMENT_ENVIRONMENT"];
  else process.env["DEPLOYMENT_ENVIRONMENT"] = savedDeploymentEnv;
});

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    await seedPostingStatusFixture(env);
    const a = env.admin;
    await a.query(
      `INSERT INTO users (id, email, password_hash) VALUES ($1, 'connector-ack@svc.invalid', NULL)
       ON CONFLICT (id) DO NOTHING`,
      [ACTOR_USER],
    );

    // 018-US4: register a connector instance to link the connector token.
    const CONNECTOR_REG = "01900000-0000-7000-8000-0000000a7e0a";
    await a.query(
      `INSERT INTO connector_registration
         (id, tenant_id, display_name, erpnext_site_ref, environment, created_by)
       VALUES ($1, $2, 'Ack HTTP Conn', 'erp-ack-http.example', 'pilot', $3)
       ON CONFLICT (id) DO NOTHING`,
      [CONNECTOR_REG, TENANT_A, ACTOR_USER],
    );

    const tokens = new AuthTokenRepository(env.admin);
    connectorToken = await issueToken(tokens, "connector", CONNECTOR_REG);
    dashboardToken = await issueToken(tokens, "dashboard_api");

    const fakeRedis = new FakeRedis();
    const fakeMarker = new FakeMarker();
    const idempStore = new IdempotencyKeyStore({
      redis: fakeRedis,
      pgWriter: { async insert(): Promise<void> {} },
      pgReader: {
        async find(): Promise<null> {
          return null;
        },
      },
      defaultTtlMs: 72 * 60 * 60 * 1000,
    });
    const idempInterceptor = new IdempotencyInterceptor(
      new Reflector(),
      idempStore,
      fakeMarker as unknown as InProgressMarker,
    );

    const providers: Provider[] = [
      { provide: PG_POOL, useFactory: (): Pool => env!.app },
      ErpnextPostingService,
      { provide: SessionRepository, useValue: new SessionRepository(env.admin) },
      { provide: AuthTokenRepository, useValue: new AuthTokenRepository(env.admin) },
      AuthGuard,
      ConnectorAuthGuard,
      { provide: IDEMPOTENCY_KEY_STORE, useValue: idempStore },
      { provide: INFLIGHT_REDIS, useValue: fakeRedis },
      { provide: InProgressMarker, useValue: fakeMarker },
      { provide: APP_INTERCEPTOR, useValue: idempInterceptor },
    ];

    const moduleRef = await Test.createTestingModule({
      controllers: [ErpnextPostingController],
      providers,
    }).compile();

    app = moduleRef.createNestApplication({ bufferLogs: true });
    app.useGlobalFilters(new GlobalExceptionFilter());
    await app.init();
  } catch (err) {
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      skip = true;
      // eslint-disable-next-line no-console
      console.warn(`[posting-ack-http-edge.spec] Docker unavailable: ${String(err)}`);
      return;
    }
    throw err;
  }
}, 180_000);

afterAll(async () => {
  if (app) await app.close();
  if (env) await stopPgEnv(env);
}, 60_000);

/** Reset POST_A_PENDING to pristine pending before a fresh-transition test. */
async function resetPending(): Promise<void> {
  await env!.admin.query(
    `UPDATE erpnext_posting_status
        SET status='pending', document_ref=NULL, rejection_category=NULL, retry_count=0
      WHERE id=$1`,
    [POST_A_PENDING],
  );
}

const http = () => request(app!.getHttpServer());

describe("connectorAckOutcome — auth + idempotency-required (012)", () => {
  it("dashboard_api-scope token → 401 (wrong scope)", async () => {
    if (skip) return;
    await http()
      .post(ackPath(POST_A_PENDING))
      .set("authorization", `Bearer ${dashboardToken}`)
      .set("idempotency-key", idemp("a"))
      .send({ outcome: "failed_transient" })
      .expect(401);
  });

  it("missing Idempotency-Key → 400 (x-idempotency: required)", async () => {
    if (skip) return;
    await http()
      .post(ackPath(POST_A_PENDING))
      .set("authorization", `Bearer ${connectorToken}`)
      .send({ outcome: "failed_transient" })
      .expect(400);
  });
});

describe("connectorAckOutcome — strict DTO (400)", () => {
  it("posted without documentRef → 400", async () => {
    if (skip) return;
    await http()
      .post(ackPath(POST_A_PENDING))
      .set("authorization", `Bearer ${connectorToken}`)
      .set("idempotency-key", idemp("b"))
      .send({ outcome: "posted" })
      .expect(400);
  });

  it("body-supplied tenant_id → 400 (strict; §XII)", async () => {
    if (skip) return;
    await http()
      .post(ackPath(POST_A_PENDING))
      .set("authorization", `Bearer ${connectorToken}`)
      .set("idempotency-key", idemp("c"))
      .send({ outcome: "failed_transient", tenant_id: TENANT_A })
      .expect(400);
  });

  it("reason on a non-rejected outcome → 400 (biconditional)", async () => {
    if (skip) return;
    await http()
      .post(ackPath(POST_A_PENDING))
      .set("authorization", `Bearer ${connectorToken}`)
      .set("idempotency-key", idemp("c2"))
      .send({
        outcome: "failed_transient",
        reason: { category: "validation", message: "x" },
      })
      .expect(400);
  });
});

describe("connectorAckOutcome — idempotency lifecycle (interceptor)", () => {
  it("201 first record → 200 same-key replay → 409 same-key/different-body", async () => {
    if (skip) return;
    await resetPending();
    const key = idemp("d");

    const first = await http()
      .post(ackPath(POST_A_PENDING))
      .set("authorization", `Bearer ${connectorToken}`)
      .set("idempotency-key", key)
      .send({ outcome: "posted", documentRef: DOC })
      .expect(201);
    expect(first.body.outcome).toBe("posted");

    // Same key + same body → interceptor replay. The interceptor short-circuits
    // BEFORE the handler and echoes the STORED status (201) + body + the
    // `Idempotent-Replayed: true` header — the header is the contract's replay
    // marker (mirrors posCaptureItem). No second transition occurs.
    const replay = await http()
      .post(ackPath(POST_A_PENDING))
      .set("authorization", `Bearer ${connectorToken}`)
      .set("idempotency-key", key)
      .send({ outcome: "posted", documentRef: DOC })
      .expect(201);
    expect(replay.headers["idempotent-replayed"]).toBe("true");

    // Same key + DIFFERENT body → 409 idempotency_key_conflict.
    await http()
      .post(ackPath(POST_A_PENDING))
      .set("authorization", `Bearer ${connectorToken}`)
      .set("idempotency-key", key)
      .send({ outcome: "failed_transient" })
      .expect(409);
  });

  it("service-level O-3 echo: a FRESH key re-acking the already-posted row → 200 + Idempotent-Replayed", async () => {
    if (skip) return;
    await resetPending();
    // First post under one key.
    await http()
      .post(ackPath(POST_A_PENDING))
      .set("authorization", `Bearer ${connectorToken}`)
      .set("idempotency-key", idemp("f1"))
      .send({ outcome: "posted", documentRef: DOC })
      .expect(201);
    // A DIFFERENT key reaches the handler (interceptor can't dedupe a fresh key);
    // the service sees an already-posted row with the same doc → echoes 200.
    const echo = await http()
      .post(ackPath(POST_A_PENDING))
      .set("authorization", `Bearer ${connectorToken}`)
      .set("idempotency-key", idemp("f2"))
      .send({ outcome: "posted", documentRef: DOC })
      .expect(200);
    expect(echo.headers["idempotent-replayed"]).toBe("true");
    expect(echo.body.documentRef).toEqual(DOC);
  });
});

describe("connectorAckOutcome — §XII non-disclosure (404)", () => {
  it("a cross-tenant workItemRef → 404 not_found", async () => {
    if (skip) return;
    await http()
      .post(ackPath(POST_B_POSTED)) // tenant B's row
      .set("authorization", `Bearer ${connectorToken}`)
      .set("idempotency-key", idemp("e"))
      .send({ outcome: "posted", documentRef: DOC })
      .expect(404);
  });
});
