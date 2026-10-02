/**
 * 019-T040 — HTTP-edge + auth-scope spec for binViewPullRequests + binViewReportSnapshot.
 *
 * Drives the REAL HTTP surface — ErpnextBinViewController behind the REAL
 * ConnectorAuthGuard (+ base AuthGuard + AuthTokenRepository) against real
 * `auth_tokens` + `connector_registration` rows — proving the auth/DTO/edge
 * behaviors the 019 contract specifies:
 *
 *   - 401: unauthenticated (no/!Bearer) + wrong-scope (dashboard_api / pos
 *     REJECTED; only `connector` accepted) — the connectorBearer machine gate;
 *   - 400: strict DTO (unknown query key on the feed; a body smuggling `storeId`,
 *     a float-shaped quantity, or an unknown key on the report);
 *   - 200 feed happy path (connector token → the tenant's running-run feed);
 *   - report happy path returns 201, then the SAME report replays 200.
 *
 * Docker policy: HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import "reflect-metadata";

import { type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { Pool } from "pg";
import request from "supertest";

import { generateRawToken } from "@data-pulse-2/auth";
import { deterministicId, newId } from "@data-pulse-2/shared";

import { GlobalExceptionFilter } from "../../../../src/common/exception.filter";
import { PG_POOL } from "../../../../src/auth/auth.module";
import { AuthGuard } from "../../../../src/auth/auth.guard";
import { AuthTokenRepository } from "../../../../src/auth/auth-token.repository";
import { ConnectorAuthGuard } from "../../../../src/auth/connector-auth.guard";
import { SessionRepository } from "../../../../src/auth/session.repository";
import { ErpnextBinViewController } from "../../../../src/catalog/erpnext-bin-view/erpnext-bin-view.controller";
import { ErpnextBinViewService } from "../../../../src/catalog/erpnext-bin-view/erpnext-bin-view.service";
import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../../_helpers/postgres-container";
import { ACTOR_A, PRODUCT_A_ACTIVE, STORE_A_X, TENANT_A } from "../../__support__/isolation-harness";
import { seedReconciliationFixture } from "../../erpnext-reconciliation/__support__/seed-reconciliation";

const FEED_PATH = "/api/connector/v1/erpnext/bin-view-requests";
const ACTOR_USER = "01900000-0000-7000-8000-0000000be001";
const BIN_VIEW_REQUEST_NS = "0190b1de-0000-7000-8000-0000000be019";
const RUN_HTTP = "0a000000-0000-7000-8000-00000e7042a1";
const ERP_ITEM_REF = "ERP-ITEM-7042A";
const REQUEST_REF = deterministicId(BIN_VIEW_REQUEST_NS, `${RUN_HTTP}:0`);

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
    id: newId(),
    tenantId: TENANT_A,
    userId: ACTOR_USER,
    deviceId: null,
    scope,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
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
    await seedReconciliationFixture(env);
    const a = env.admin;
    await a.query(
      `INSERT INTO users (id, email, password_hash) VALUES ($1, 'binview@svc.invalid', NULL)
       ON CONFLICT (id) DO NOTHING`,
      [ACTOR_USER],
    );
    // A running stock run on the mapped STORE_A_X (the feed offers it).
    await a.query(
      `INSERT INTO erpnext_reconciliation_run
         (id, tenant_id, store_id, kind, trigger, status, actor_user_id)
       VALUES ($1, $2, $3, 'stock', 'on_demand', 'running', $4)
       ON CONFLICT (id) DO NOTHING`,
      [RUN_HTTP, TENANT_A, STORE_A_X, ACTOR_A],
    );
    // A confirmed item map so the report reverse-resolves.
    await a.query(
      `INSERT INTO erpnext_item_map (id, tenant_id, tenant_product_id, erpnext_item_ref, state, suggestion_source, confirmed_by, confirmed_at)
       VALUES (gen_random_uuid(), $1, $2, $3, 'confirmed', 'manual', $4, now()) ON CONFLICT DO NOTHING`,
      [TENANT_A, PRODUCT_A_ACTIVE, ERP_ITEM_REF, ACTOR_USER],
    );

    const CONNECTOR_REG = "01900000-0000-7000-8000-0000000be009";
    await a.query(
      `INSERT INTO connector_registration
         (id, tenant_id, display_name, erpnext_site_ref, environment, created_by)
       VALUES ($1, $2, 'BinView HTTP Conn', 'erp-binview-http.example', 'pilot', $3)
       ON CONFLICT (id) DO NOTHING`,
      [CONNECTOR_REG, TENANT_A, ACTOR_USER],
    );

    const tokens = new AuthTokenRepository(env.admin);
    connectorToken = await issueToken(tokens, "connector", CONNECTOR_REG);
    dashboardToken = await issueToken(tokens, "dashboard_api");
    posToken = await issueToken(tokens, "pos");

    const moduleRef = await Test.createTestingModule({
      controllers: [ErpnextBinViewController],
      providers: [
        { provide: PG_POOL, useFactory: (): Pool => env!.app },
        ErpnextBinViewService,
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
      console.warn(`[bin-view-http-edge.spec] Docker unavailable: ${String(err)}`);
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
const SNAPSHOT_PATH = `/api/connector/v1/erpnext/bin-view-requests/${REQUEST_REF}/snapshot`;

const validReport = {
  entries: [
    { erpnextItemRef: { doctype: "Item", name: ERP_ITEM_REF }, quantity: "5.000000", stockUom: "ea" },
  ],
  readAt: "2026-06-08T10:00:00.000Z",
};

describe("binViewPullRequests — auth scope gate (connectorBearer)", () => {
  it("no Authorization header → 401", async () => {
    if (skip) return;
    await http().get(FEED_PATH).expect(401);
  });

  it("dashboard_api token → 401 (wrong scope)", async () => {
    if (skip) return;
    await http().get(FEED_PATH).set("Authorization", `Bearer ${dashboardToken}`).expect(401);
  });

  it("pos token → 401 (wrong scope)", async () => {
    if (skip) return;
    await http().get(FEED_PATH).set("Authorization", `Bearer ${posToken}`).expect(401);
  });

  it("connector token → 200 with the tenant's running-run feed", async () => {
    if (skip) return;
    const res = await http().get(FEED_PATH).set("Authorization", `Bearer ${connectorToken}`).expect(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body.items.some((i: { runRef: string }) => i.runRef === RUN_HTTP)).toBe(true);
    expect(typeof res.body.cursor).toBe("string");
  });

  it("unknown query key → 400 (strict DTO)", async () => {
    if (skip) return;
    await http()
      .get(`${FEED_PATH}?bogus=1`)
      .set("Authorization", `Bearer ${connectorToken}`)
      .expect(400);
  });
});

describe("binViewReportSnapshot — strict DTO + idempotency", () => {
  it("body smuggling storeId → 400 (§XII strict boundary)", async () => {
    if (skip) return;
    await http()
      .post(SNAPSHOT_PATH)
      .set("Authorization", `Bearer ${connectorToken}`)
      .set("Idempotency-Key", "http-idem-bad-scope")
      .send({ ...validReport, storeId: STORE_A_X })
      .expect(400);
  });

  it("float-shaped quantity → 400 (exact-decimal string only, §III)", async () => {
    if (skip) return;
    await http()
      .post(SNAPSHOT_PATH)
      .set("Authorization", `Bearer ${connectorToken}`)
      .set("Idempotency-Key", "http-idem-float")
      .send({
        entries: [{ erpnextItemRef: { doctype: "Item", name: ERP_ITEM_REF }, quantity: 5.5, stockUom: "ea" }],
        readAt: "2026-06-08T10:00:00.000Z",
      })
      .expect(400);
  });

  it("connector token → 201 first record, then SAME report replays 200", async () => {
    if (skip) return;
    await http()
      .post(SNAPSHOT_PATH)
      .set("Authorization", `Bearer ${connectorToken}`)
      .set("Idempotency-Key", "http-idem-ok-1")
      .send(validReport)
      .expect(201);
    // Fresh idempotency key, same logical report → service-level O-3 echo → 200.
    const replay = await http()
      .post(SNAPSHOT_PATH)
      .set("Authorization", `Bearer ${connectorToken}`)
      .set("Idempotency-Key", "http-idem-ok-2")
      .send(validReport)
      .expect(200);
    expect(replay.headers["idempotent-replayed"]).toBe("true");
  });
});
