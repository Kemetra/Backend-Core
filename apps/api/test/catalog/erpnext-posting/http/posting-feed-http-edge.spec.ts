/**
 * 015-US1-FEED T034 — HTTP-edge + auth-scope spec for connectorPullPostings.
 *
 * The MVP feed spec drives ErpnextPostingService directly; this spec drives the
 * REAL HTTP surface — ErpnextPostingController behind the REAL ConnectorAuthGuard
 * (+ base AuthGuard + AuthTokenRepository), against real `auth_tokens` rows — so
 * the auth/DTO/edge behaviors the contract specifies are actually proven:
 *
 *   - 401 unauthenticated (no/!Bearer) and wrong-scope (dashboard_api / pos /
 *     pos_operator tokens REJECTED; only `connector` is accepted) — the 012
 *     connectorBearer machine gate;
 *   - 400 strict DTO (bad `since`, out-of-range `limit`, unknown query key);
 *   - 200 happy path (connector token → the tenant's pending feed);
 *   - 200 empty on a caught-up cursor (`since == max`) — NOT a 409.
 *
 * Deliberately NOT tested here (verified out of scope, advisor-confirmed):
 *   - `snapshot_required` (409): 015 does NOT prune `erpnext_posting_status`, so
 *     every cursor <= max is fully servable and a caught-up cursor is an empty
 *     200. There is no stale-horizon trigger (unlike 010, which prunes its
 *     change-log). Reserved for a future retention model (017).
 *   - non-disclosing 404: the pull has NO `workItemRef` path param and the cursor
 *     is a bare global `sequence` bigint (no embedded scope) — RLS scopes the
 *     rows, so there is no foreign-ref to reject. The 404/`not_found` path
 *     belongs to `connectorAckOutcome` (US2-ACK).
 *
 * Docker policy: HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import "reflect-metadata";

import { type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { Pool } from "pg";
import request from "supertest";

import { generateRawToken } from "@data-pulse-2/auth";
import { newId } from "@data-pulse-2/shared";

import { GlobalExceptionFilter } from "../../../../src/common/exception.filter";
import { PG_POOL } from "../../../../src/auth/auth.module";
import { AuthGuard } from "../../../../src/auth/auth.guard";
import { AuthTokenRepository } from "../../../../src/auth/auth-token.repository";
import { ConnectorAuthGuard } from "../../../../src/auth/connector-auth.guard";
import { SessionRepository } from "../../../../src/auth/session.repository";
import { ErpnextPostingController } from "../../../../src/catalog/erpnext-posting/erpnext-posting.controller";
import { ErpnextPostingService } from "../../../../src/catalog/erpnext-posting/erpnext-posting.service";
import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../../_helpers/postgres-container";
import { TENANT_A } from "../../__support__/isolation-harness";
import { SALE_A_X } from "../../sales/__support__/seed-sales";
import {
  POST_A_PENDING,
  seedPostingStatusFixture,
} from "../__support__/seed-posting-status";

const FEED_PATH = "/api/connector/v1/erpnext/postings";
const ACTOR_USER = "01900000-0000-7000-8000-0000000a7c01";

// Raw bearer tokens minted in beforeAll (one per scope).
let connectorToken = "";
let dashboardToken = "";
let posToken = "";

let env: PgTestEnv | null = null;
let app: INestApplication | null = null;
let skip = false;

async function issueToken(
  tokens: AuthTokenRepository,
  scope: string,
  connectorRegistrationId?: string,
): Promise<string> {
  const raw = generateRawToken();
  await tokens.issue(raw, {
    id: newId(), // auth_tokens.id is a PK with no DB default — caller-supplied.
    tenantId: TENANT_A,
    userId: ACTOR_USER, // CHECK: exactly one of user_id/device_id — machine tokens use a service-account user.
    deviceId: null,
    scope,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    // 018-US4: a connector token MUST link to a non-disabled connector_registration
    // in its tenant, else ConnectorAuthGuard rejects it (FR-015).
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
    // A service-account user for the machine tokens (auth_tokens CHECK needs a
    // user_id XOR device_id). Make SALE_A_X resolvable so the happy path offers it.
    const a = env.admin;
    await a.query(
      `INSERT INTO users (id, email, password_hash) VALUES ($1, 'connector@svc.invalid', NULL)
       ON CONFLICT (id) DO NOTHING`,
      [ACTOR_USER],
    );
    const TPROD = "01900000-0000-7000-8000-0000000a7e02";
    await a.query(
      `INSERT INTO tenant_products (id, tenant_id, name, tax_category, created_by, updated_by)
       VALUES ($1, $2, 'HTTP Widget', 'standard', $3, $3) ON CONFLICT (id) DO NOTHING`,
      [TPROD, TENANT_A, ACTOR_USER],
    );
    await a.query(`UPDATE sale_lines SET tenant_product_ref = $1 WHERE sale_id = $2`, [TPROD, SALE_A_X]);
    await a.query(
      `INSERT INTO erpnext_item_map (id, tenant_id, tenant_product_id, erpnext_item_ref, state, suggestion_source, confirmed_by, confirmed_at)
       VALUES (gen_random_uuid(), $1, $2, 'ERP-HTTP-1', 'confirmed', 'manual', $3, now()) ON CONFLICT DO NOTHING`,
      [TENANT_A, TPROD, ACTOR_USER],
    );
    await a.query(
      `INSERT INTO erpnext_warehouse_map (id, tenant_id, store_id, purpose, erpnext_warehouse_ref, set_by, version)
       SELECT gen_random_uuid(), $1, store_id, 'stock', 'ERP-WH-HTTP', $2, 1 FROM sales WHERE id = $3
       ON CONFLICT DO NOTHING`,
      [TENANT_A, ACTOR_USER, SALE_A_X],
    );

    // 018-US4: register a connector instance so the connector token links to a
    // non-disabled registration (ConnectorAuthGuard now requires the link).
    const CONNECTOR_REG = "01900000-0000-7000-8000-0000000a7e09";
    await a.query(
      `INSERT INTO connector_registration
         (id, tenant_id, display_name, erpnext_site_ref, environment, created_by)
       VALUES ($1, $2, 'Feed HTTP Conn', 'erp-feed-http.example', 'pilot', $3)
       ON CONFLICT (id) DO NOTHING`,
      [CONNECTOR_REG, TENANT_A, ACTOR_USER],
    );

    const tokens = new AuthTokenRepository(env.admin);
    connectorToken = await issueToken(tokens, "connector", CONNECTOR_REG);
    dashboardToken = await issueToken(tokens, "dashboard_api");
    posToken = await issueToken(tokens, "pos");

    // PG_POOL → env.app: the FEED query (ErpnextPostingService) runs under real
    // RLS via runWithTenantContext — tenant scoping is genuinely exercised.
    //
    // AuthTokenRepository → env.admin (RLS-BYPASS): the bearer-token lookup is a
    // NO-GUC read at auth time (the tenant is not known until the token resolves)
    // and `auth_tokens` is FORCE ROW LEVEL SECURITY, so the non-superuser app role
    // would see zero rows → spurious 401. The admin pool mirrors the production
    // PG_POOL, which is the privileged app pool that already performs this exact
    // lookup. (Same pattern as read-down's device-principal-auth.spec.) Session
    // repo is provided to satisfy AuthGuard's constructor (cookie path unused here).
    const moduleRef = await Test.createTestingModule({
      controllers: [ErpnextPostingController],
      providers: [
        { provide: PG_POOL, useFactory: (): Pool => env!.app },
        ErpnextPostingService,
        { provide: SessionRepository, useValue: new SessionRepository(env.admin) },
        { provide: AuthTokenRepository, useValue: new AuthTokenRepository(env.admin) },
        AuthGuard,
        ConnectorAuthGuard,
      ],
    }).compile();

    app = moduleRef.createNestApplication({ bufferLogs: true });
    app.useGlobalFilters(new GlobalExceptionFilter());
    await app.init();
  } catch (err) {
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      skip = true;
      // eslint-disable-next-line no-console
      console.warn(`[posting-feed-http-edge.spec] Docker unavailable: ${String(err)}`);
      return;
    }
    throw err;
  }
}, 180_000);

afterAll(async () => {
  if (app) await app.close();
  if (env) await stopPgEnv(env);
}, 60_000);

const http = () => request(app!.getHttpServer());

describe("connectorPullPostings — auth scope gate (012 connectorBearer)", () => {
  it("no Authorization header → 401", async () => {
    if (skip) return;
    await http().get(FEED_PATH).expect(401);
  });

  it("non-Bearer Authorization → 401", async () => {
    if (skip) return;
    await http().get(FEED_PATH).set("authorization", "Basic Zm9vOmJhcg==").expect(401);
  });

  it("unknown bearer token → 401", async () => {
    if (skip) return;
    await http().get(FEED_PATH).set("authorization", `Bearer ${generateRawToken()}`).expect(401);
  });

  it("dashboard_api-scope token → 401 (wrong scope; machine surface)", async () => {
    if (skip) return;
    await http().get(FEED_PATH).set("authorization", `Bearer ${dashboardToken}`).expect(401);
  });

  it("pos-scope token → 401 (wrong scope)", async () => {
    if (skip) return;
    await http().get(FEED_PATH).set("authorization", `Bearer ${posToken}`).expect(401);
  });

  it("connector-scope token → 200 (accepted)", async () => {
    if (skip) return;
    await http().get(FEED_PATH).set("authorization", `Bearer ${connectorToken}`).expect(200);
  });
});

describe("connectorPullPostings — strict DTO (400)", () => {
  it("non-numeric `since` → 400", async () => {
    if (skip) return;
    await http().get(FEED_PATH).query({ since: "abc" }).set("authorization", `Bearer ${connectorToken}`).expect(400);
  });

  it("over-range `limit` (501) → 400", async () => {
    if (skip) return;
    await http().get(FEED_PATH).query({ limit: 501 }).set("authorization", `Bearer ${connectorToken}`).expect(400);
  });

  it("unknown query key → 400 (strict)", async () => {
    if (skip) return;
    await http().get(FEED_PATH).query({ bogus: "x" }).set("authorization", `Bearer ${connectorToken}`).expect(400);
  });
});

describe("connectorPullPostings — feed behavior", () => {
  it("connector token returns the tenant's pending feed (the resolvable sale_post)", async () => {
    if (skip) return;
    const res = await http()
      .get(FEED_PATH)
      .set("authorization", `Bearer ${connectorToken}`)
      .expect(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(typeof res.body.cursor).toBe("string");
    const refs = res.body.items.map((i: { workItemRef: string }) => i.workItemRef);
    expect(refs).toContain(POST_A_PENDING);
  });

  it("a caught-up cursor (since == max) → empty 200, NOT 409 (015 does not prune)", async () => {
    if (skip) return;
    const first = await http().get(FEED_PATH).set("authorization", `Bearer ${connectorToken}`).expect(200);
    const maxCursor: string = first.body.cursor;
    const tail = await http()
      .get(FEED_PATH)
      .query({ since: maxCursor })
      .set("authorization", `Bearer ${connectorToken}`)
      .expect(200);
    expect(tail.body.items).toHaveLength(0);
  });
});
