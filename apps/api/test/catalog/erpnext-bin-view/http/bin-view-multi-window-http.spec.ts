/**
 * RT-175 — HTTP-edge spec for the stock-view 1.2 multi-window bin-view report.
 *
 * Drives the REAL HTTP surface (ErpnextBinViewController behind the real
 * ConnectorAuthGuard + ConnectorEnvironmentGuard against real `auth_tokens` +
 * `connector_registration` rows) WITH the real `IdempotencyInterceptor`
 * (in-memory key store), proving:
 *   - the feed advertises `itemWindow.maxWindows = 20` on a paged request
 *     (windowSeq 0, null bounds);
 *   - strict `window` DTO → 400 validation_error (unknown key, empty non-final
 *     window, windowSeq ≥ maxWindows, > maxItems entries);
 *   - an out-of-sequence window → 409 `window_sequence_conflict`;
 *   - the response carries windowSeq / windowsRecorded / complete;
 *   - idempotency: same key + identical body replays (`Idempotent-Replayed`);
 *     same key + ANY body difference (here `isFinal`) → 409
 *     `idempotency_key_conflict`; a fresh key re-reporting a recorded window
 *     → 200 `Idempotent-Replayed: true`, or 409 `idempotency_key_conflict` when
 *     its entries differ;
 *   - a cross-tenant requestRef → the same non-disclosing 404 as an absent one,
 *     on every window.
 *
 * Docker policy: HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import "reflect-metadata";

import { type INestApplication } from "@nestjs/common";
import { APP_INTERCEPTOR, Reflector } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import type { Pool } from "pg";
import request from "supertest";

import { generateRawToken } from "@data-pulse-2/auth";
import { deterministicId, IdempotencyKeyStore, newId } from "@data-pulse-2/shared";

import { GlobalExceptionFilter } from "../../../../src/common/exception.filter";
import { PG_POOL } from "../../../../src/auth/auth.module";
import { AuthGuard } from "../../../../src/auth/auth.guard";
import { AuthTokenRepository } from "../../../../src/auth/auth-token.repository";
import { ConnectorAuthGuard } from "../../../../src/auth/connector-auth.guard";
import { SessionRepository } from "../../../../src/auth/session.repository";
import { ErpnextBinViewController } from "../../../../src/catalog/erpnext-bin-view/erpnext-bin-view.controller";
import { ErpnextBinViewService } from "../../../../src/catalog/erpnext-bin-view/erpnext-bin-view.service";
import {
  IDEMPOTENCY_KEY_STORE,
  IdempotencyInterceptor,
} from "../../../../src/idempotency/idempotency.interceptor";
import {
  INFLIGHT_REDIS,
  InProgressMarker,
} from "../../../../src/idempotency/in-progress-marker";
import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../../_helpers/postgres-container";
import { ACTOR_A, STORE_A_X, TENANT_A, TENANT_B } from "../../__support__/isolation-harness";
import { seedReconciliationFixture } from "../../erpnext-reconciliation/__support__/seed-reconciliation";

const FEED_PATH = "/api/connector/v1/erpnext/bin-view-requests";
const ACTOR_USER = "01900000-0000-7000-8000-0000000be175";
const BIN_VIEW_REQUEST_NS = "0190b1de-0000-7000-8000-0000000be019";
const RUN_SEQ = "0a000000-0000-7000-8000-00000e1751a1";
const RUN_IDEM = "0a000000-0000-7000-8000-00000e1751a2";
const RUN_XT = "0a000000-0000-7000-8000-00000e1751a3";
const ATTEMPT = "0a000000-0000-4000-8000-0000000a1751";
const READ_AT = "2026-10-04T08:00:00.000Z";

const snapshotPath = (runId: string): string =>
  `${FEED_PATH}/${deterministicId(BIN_VIEW_REQUEST_NS, `${runId}:0`)}/snapshot`;

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
}

class FakeMarker {
  async trySet(): Promise<boolean> {
    return true;
  }
  async del(): Promise<void> {}
}

let connectorToken = "";
let connectorTokenB = "";
let env: PgTestEnv | null = null;
let app: INestApplication | null = null;
let skip = false;

async function issueConnectorToken(
  tokens: AuthTokenRepository,
  tenantId: string,
  registrationId: string,
): Promise<string> {
  const raw = generateRawToken();
  await tokens.issue(raw, {
    id: newId(),
    tenantId,
    userId: ACTOR_USER,
    deviceId: null,
    scope: "connector",
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    connectorRegistrationId: registrationId,
  } as Parameters<AuthTokenRepository["issue"]>[1]);
  return raw;
}

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
      `INSERT INTO users (id, email, password_hash) VALUES ($1, 'binview175@svc.invalid', NULL)
       ON CONFLICT (id) DO NOTHING`,
      [ACTOR_USER],
    );
    for (const id of [RUN_SEQ, RUN_IDEM, RUN_XT]) {
      await a.query(
        `INSERT INTO erpnext_reconciliation_run
           (id, tenant_id, store_id, kind, trigger, status, actor_user_id)
         VALUES ($1, $2, $3, 'stock', 'on_demand', 'running', $4)
         ON CONFLICT (id) DO NOTHING`,
        [id, TENANT_A, STORE_A_X, ACTOR_A],
      );
    }
    const REG_A = "01900000-0000-7000-8000-0000000be17a";
    const REG_B = "01900000-0000-7000-8000-0000000be17b";
    for (const [reg, tenant] of [[REG_A, TENANT_A], [REG_B, TENANT_B]] as const) {
      await a.query(
        `INSERT INTO connector_registration
           (id, tenant_id, display_name, erpnext_site_ref, environment, created_by)
         VALUES ($1, $2, 'BinView 175 Conn', 'erp-binview-175.example', 'pilot', $3)
         ON CONFLICT (id) DO NOTHING`,
        [reg, tenant, ACTOR_USER],
      );
    }
    const tokens = new AuthTokenRepository(env.admin);
    connectorToken = await issueConnectorToken(tokens, TENANT_A, REG_A);
    connectorTokenB = await issueConnectorToken(tokens, TENANT_B, REG_B);

    const store = new IdempotencyKeyStore({
      redis: new FakeRedis(),
      pgWriter: { async insert(): Promise<void> {} },
      pgReader: { async find(): Promise<null> { return null; } },
      defaultTtlMs: 72 * 60 * 60 * 1000,
    });
    const moduleRef = await Test.createTestingModule({
      controllers: [ErpnextBinViewController],
      providers: [
        Reflector,
        { provide: PG_POOL, useFactory: (): Pool => env!.app },
        ErpnextBinViewService,
        { provide: SessionRepository, useValue: new SessionRepository(env.admin) },
        { provide: AuthTokenRepository, useValue: new AuthTokenRepository(env.admin) },
        AuthGuard,
        ConnectorAuthGuard,
        { provide: IDEMPOTENCY_KEY_STORE, useValue: store },
        { provide: INFLIGHT_REDIS, useValue: new FakeRedis() },
        { provide: InProgressMarker, useFactory: () => new FakeMarker() },
        { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
      ],
    }).compile();

    app = moduleRef.createNestApplication({ bufferLogs: true });
    app.useGlobalFilters(new GlobalExceptionFilter());
    await app.init();
  } catch (err) {
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      skip = true;
      // eslint-disable-next-line no-console
      console.warn(`[bin-view-multi-window-http.spec] Docker unavailable: ${String(err)}`);
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

function entries(prefix: string, n: number) {
  return Array.from({ length: n }, (_, i) => ({
    erpnextItemRef: { doctype: "Item", name: `${prefix}-${i}` },
    quantity: "1.000000",
    stockUom: "Nos",
  }));
}

function windowBody(prefix: string, n: number, windowSeq: number, isFinal: boolean) {
  return { entries: entries(prefix, n), window: { attemptRef: ATTEMPT, windowSeq, isFinal }, readAt: READ_AT };
}

function post(runId: string, key: string, body: unknown, token: string = connectorToken) {
  return http()
    .post(snapshotPath(runId))
    .set("Authorization", `Bearer ${token}`)
    .set("Idempotency-Key", key)
    .send(body as object);
}

async function eventCount(runId: string): Promise<number> {
  const r = await env!.admin.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM outbox_events
      WHERE event_type = 'erpnext.reconciliation.requested' AND payload->>'run_id' = $1`,
    [runId],
  );
  return Number(r.rows[0]!.count);
}

describe("RT-175 binViewPullRequests — maxWindows advertised", () => {
  it("each request is a connector-paged request: windowSeq 0, maxItems 500, maxWindows 20, null bounds", async () => {
    if (skip) return;
    const res = await http().get(FEED_PATH).set("Authorization", `Bearer ${connectorToken}`).expect(200);
    const req = res.body.items.find((i: { runRef: string }) => i.runRef === RUN_SEQ);
    expect(req.itemWindow).toEqual({
      windowSeq: 0,
      maxItems: 500,
      maxWindows: 20,
      fromItemRef: null,
      toItemRef: null,
    });
  });
});

describe("RT-175 binViewReportSnapshot — window DTO (400 validation_error)", () => {
  const cases: Array<[string, unknown]> = [
    ["unknown key in window", { ...windowBody("V-UK", 1, 0, true), window: { attemptRef: ATTEMPT, windowSeq: 0, isFinal: true, extra: 1 } }],
    ["non-final window with 0 entries", windowBody("V-E0", 0, 0, false)],
    ["windowSeq > 0 final window with 0 entries", windowBody("V-E1", 0, 1, true)],
    ["windowSeq ≥ maxWindows (20)", windowBody("V-MW", 1, 20, true)],
    ["negative windowSeq", windowBody("V-NEG", 1, -1, true)],
    ["non-uuid attemptRef", { ...windowBody("V-AR", 1, 0, true), window: { attemptRef: "nope", windowSeq: 0, isFinal: true } }],
    ["more than maxItems (500) entries in a window", windowBody("V-MAX", 501, 0, false)],
  ];
  it.each(cases)("%s → 400", async (_label, body) => {
    if (skip) return;
    const res = await post(RUN_SEQ, `rt175-dto-${newId()}`, body).expect(400);
    expect(res.body.error.code).toBe("validation_error");
  });
});

describe("RT-175 binViewReportSnapshot — sequencing + idempotency over HTTP", () => {
  it("window 1 before window 0 → 409 window_sequence_conflict; then 0, 1(final) → 201s with window fields, one event", async () => {
    if (skip) return;
    const early = await post(RUN_SEQ, `rt175-seq-${newId()}`, windowBody("S1", 2, 1, true)).expect(409);
    expect(early.body.error.code).toBe("window_sequence_conflict");

    const w0 = await post(RUN_SEQ, `rt175-seq-${newId()}`, windowBody("S0", 3, 0, false)).expect(201);
    expect(w0.body).toMatchObject({ acceptedEntryCount: 3, windowSeq: 0, windowsRecorded: 1, complete: false });
    expect(await eventCount(RUN_SEQ)).toBe(0);

    const w1 = await post(RUN_SEQ, `rt175-seq-${newId()}`, windowBody("S1", 2, 1, true)).expect(201);
    expect(w1.body).toMatchObject({ acceptedEntryCount: 2, windowSeq: 1, windowsRecorded: 2, complete: true });
    expect(await eventCount(RUN_SEQ)).toBe(1);

    const after = await post(RUN_SEQ, `rt175-seq-${newId()}`, windowBody("S2", 1, 2, true)).expect(409);
    expect(after.body.error.code).toBe("window_sequence_conflict");
    expect(await eventCount(RUN_SEQ)).toBe(1);
  });

  it("same key: identical body replays; changed isFinal → 409 idempotency_key_conflict; fresh key: echo 200 or conflict", async () => {
    if (skip) return;
    const key = "binview-rt175-idem-w0-0000";
    const body = windowBody("I0", 2, 0, false);
    const first = await post(RUN_IDEM, key, body).expect(201);

    const sameKey = await post(RUN_IDEM, key, body);
    expect(sameKey.headers["idempotent-replayed"]).toBe("true");
    expect(sameKey.body).toEqual(first.body);

    const flipped = await post(RUN_IDEM, key, windowBody("I0", 2, 0, true)).expect(409);
    expect(flipped.body.error.code).toBe("idempotency_key_conflict");

    const echo = await post(RUN_IDEM, `rt175-idem-${newId()}`, body).expect(200);
    expect(echo.headers["idempotent-replayed"]).toBe("true");
    expect(echo.body).toEqual(first.body);

    const diff = await post(RUN_IDEM, `rt175-idem-${newId()}`, windowBody("I0-DIFF", 2, 0, false)).expect(409);
    expect(diff.body.error.code).toBe("idempotency_key_conflict");
    expect(await eventCount(RUN_IDEM)).toBe(0);
  });

  it("cross-tenant requestRef → the same non-disclosing 404 as an absent ref, on every window", async () => {
    if (skip) return;
    await post(RUN_XT, `rt175-xt-${newId()}`, windowBody("X0", 1, 0, false)).expect(201);
    const absentPath = `${FEED_PATH}/${deterministicId(BIN_VIEW_REQUEST_NS, "no-such-run:0")}/snapshot`;
    const absent = await http()
      .post(absentPath)
      .set("Authorization", `Bearer ${connectorTokenB}`)
      .set("Idempotency-Key", `rt175-xt-${newId()}`)
      .send(windowBody("X0", 1, 0, false))
      .expect(404);
    for (const [seq, isFinal] of [[0, false], [1, false], [2, true]] as const) {
      const res = await post(RUN_XT, `rt175-xt-${newId()}`, windowBody(`XB${seq}`, 1, seq, isFinal), connectorTokenB).expect(404);
      expect(res.body.error.code).toBe("not_found");
      expect(res.body.error.message).toBe(absent.body.error.message);
      expect(Object.keys(res.body.error).sort()).toEqual(Object.keys(absent.body.error).sort());
    }
    expect(await eventCount(RUN_XT)).toBe(0);
  });
});
