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
 * Test helpers take typed option objects (no positional primitive arguments).
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
import {
  deterministicId,
  IdempotencyKeyStore,
  newId,
  type RedisLike,
} from "@data-pulse-2/shared";

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
const RUN_SEQ = { runId: "0a000000-0000-7000-8000-00000e1751a1" };
const RUN_IDEM = { runId: "0a000000-0000-7000-8000-00000e1751a2" };
const RUN_XT = { runId: "0a000000-0000-7000-8000-00000e1751a3" };
const ABSENT_RUN = { runId: "no-such-run" };
const ATTEMPT = "0a000000-0000-4000-8000-0000000a1751";
const READ_AT = "2026-10-04T08:00:00.000Z";

/** Identifies one seeded reconciliation run. */
interface RunKey {
  readonly runId: string;
}

/** A connector bearer for one tenant, bound to one connector registration. */
interface ConnectorGrant {
  readonly tokens: AuthTokenRepository;
  readonly tenantId: string;
  readonly registrationId: string;
}

/** A report window body: `count` items named `${prefix}-0..`. */
interface WindowSpec {
  readonly prefix: string;
  readonly count: number;
  readonly seq: number;
  readonly isFinal: boolean;
}

/** One snapshot POST. `session` is the connector bearer (defaults to tenant A). */
interface PostSpec extends RunKey {
  readonly key: string;
  readonly body: object;
  readonly session?: string;
}

/** One `it.each` row of the 400 DTO table. */
interface DtoCase {
  readonly label: string;
  readonly body: object;
}

/** In-memory `RedisLike` (TTL-aware) for the idempotency key store. */
function memoryRedis(): RedisLike {
  const store = new Map<string, { value: string; expiresAt: number }>();
  return {
    get: async (key) => {
      const e = store.get(key);
      if (!e || Date.now() > e.expiresAt) return null;
      return e.value;
    },
    set: async (key, value, options) => {
      store.set(key, { value, expiresAt: Date.now() + options.px });
      return "OK";
    },
  };
}

/** The in-flight marker never blocks (single-request tests). */
const OPEN_MARKER = {
  trySet: async (): Promise<boolean> => true,
  del: async (): Promise<void> => undefined,
};

const snapshotPath = ({ runId }: RunKey): string =>
  `${FEED_PATH}/${deterministicId(BIN_VIEW_REQUEST_NS, `${runId}:0`)}/snapshot`;

let connectorToken = "";
let connectorTokenB = "";
let env: PgTestEnv | null = null;
let app: INestApplication | null = null;
let skip = false;

async function issueConnectorToken({ tokens, tenantId, registrationId }: ConnectorGrant): Promise<string> {
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

async function seed(e: PgTestEnv): Promise<void> {
  const a = e.admin;
  await a.query(
    `INSERT INTO users (id, email, password_hash) VALUES ($1, 'binview175@svc.invalid', NULL)
     ON CONFLICT (id) DO NOTHING`,
    [ACTOR_USER],
  );
  for (const { runId } of [RUN_SEQ, RUN_IDEM, RUN_XT]) {
    await a.query(
      `INSERT INTO erpnext_reconciliation_run
         (id, tenant_id, store_id, kind, trigger, status, actor_user_id)
       VALUES ($1, $2, $3, 'stock', 'on_demand', 'running', $4)
       ON CONFLICT (id) DO NOTHING`,
      [runId, TENANT_A, STORE_A_X, ACTOR_A],
    );
  }
  const grants = [
    { tenantId: TENANT_A, registrationId: "01900000-0000-7000-8000-0000000be17a" },
    { tenantId: TENANT_B, registrationId: "01900000-0000-7000-8000-0000000be17b" },
  ];
  for (const g of grants) {
    await a.query(
      `INSERT INTO connector_registration
         (id, tenant_id, display_name, erpnext_site_ref, environment, created_by)
       VALUES ($1, $2, 'BinView 175 Conn', 'erp-binview-175.example', 'pilot', $3)
       ON CONFLICT (id) DO NOTHING`,
      [g.registrationId, g.tenantId, ACTOR_USER],
    );
  }
  const tokens = new AuthTokenRepository(e.admin);
  connectorToken = await issueConnectorToken({ tokens, ...grants[0]! });
  connectorTokenB = await issueConnectorToken({ tokens, ...grants[1]! });
}

async function buildApp(e: PgTestEnv): Promise<INestApplication> {
  const store = new IdempotencyKeyStore({
    redis: memoryRedis(),
    pgWriter: { insert: async (): Promise<void> => undefined },
    pgReader: { find: async (): Promise<null> => null },
    defaultTtlMs: 72 * 60 * 60 * 1000,
  });
  const moduleRef = await Test.createTestingModule({
    controllers: [ErpnextBinViewController],
    providers: [
      Reflector,
      { provide: PG_POOL, useFactory: (): Pool => e.app },
      ErpnextBinViewService,
      { provide: SessionRepository, useValue: new SessionRepository(e.admin) },
      { provide: AuthTokenRepository, useValue: new AuthTokenRepository(e.admin) },
      AuthGuard,
      ConnectorAuthGuard,
      { provide: IDEMPOTENCY_KEY_STORE, useValue: store },
      { provide: INFLIGHT_REDIS, useValue: memoryRedis() },
      { provide: InProgressMarker, useValue: OPEN_MARKER },
      { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
    ],
  }).compile();
  const nest = moduleRef.createNestApplication({ bufferLogs: true });
  nest.useGlobalFilters(new GlobalExceptionFilter());
  await nest.init();
  return nest;
}

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    await seedReconciliationFixture(env);
    await seed(env);
    app = await buildApp(env);
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

function windowBody({ prefix, count, seq, isFinal }: WindowSpec) {
  const entries = Array.from({ length: count }, (_, i) => ({
    erpnextItemRef: { doctype: "Item", name: `${prefix}-${i}` },
    quantity: "1.000000",
    stockUom: "Nos",
  }));
  return { entries, window: { attemptRef: ATTEMPT, windowSeq: seq, isFinal }, readAt: READ_AT };
}

function post({ runId, key, body, session = connectorToken }: PostSpec) {
  return http()
    .post(snapshotPath({ runId }))
    .set("Authorization", `Bearer ${session}`)
    .set("Idempotency-Key", key)
    .send(body);
}

const freshKey = (): string => `rt175-${newId()}`;

async function eventCount({ runId }: RunKey): Promise<number> {
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
    const req = res.body.items.find((i: { runRef: string }) => i.runRef === RUN_SEQ.runId);
    expect(req.itemWindow).toEqual({
      windowSeq: 0,
      maxItems: 500,
      maxWindows: 20,
      fromItemRef: null,
      toItemRef: null,
    });
  });
});

const DTO_CASES: DtoCase[] = [
  {
    label: "unknown key in window",
    body: {
      ...windowBody({ prefix: "V-UK", count: 1, seq: 0, isFinal: true }),
      window: { attemptRef: ATTEMPT, windowSeq: 0, isFinal: true, extra: 1 },
    },
  },
  { label: "non-final window with 0 entries", body: windowBody({ prefix: "V-E0", count: 0, seq: 0, isFinal: false }) },
  { label: "windowSeq > 0 final window with 0 entries", body: windowBody({ prefix: "V-E1", count: 0, seq: 1, isFinal: true }) },
  { label: "windowSeq ≥ maxWindows (20)", body: windowBody({ prefix: "V-MW", count: 1, seq: 20, isFinal: true }) },
  { label: "negative windowSeq", body: windowBody({ prefix: "V-NEG", count: 1, seq: -1, isFinal: true }) },
  {
    label: "non-uuid attemptRef",
    body: {
      ...windowBody({ prefix: "V-AR", count: 1, seq: 0, isFinal: true }),
      window: { attemptRef: "nope", windowSeq: 0, isFinal: true },
    },
  },
  {
    label: "more than maxItems (500) entries in a window",
    body: windowBody({ prefix: "V-MAX", count: 501, seq: 0, isFinal: false }),
  },
];

describe("RT-175 binViewReportSnapshot — window DTO (400 validation_error)", () => {
  it.each(DTO_CASES)("$label → 400", async ({ body }) => {
    if (skip) return;
    const res = await post({ ...RUN_SEQ, key: `rt175-dto-${newId()}`, body }).expect(400);
    expect(res.body.error.code).toBe("validation_error");
  });
});

describe("RT-175 binViewReportSnapshot — sequencing + idempotency over HTTP", () => {
  it("window 1 before window 0 → 409 window_sequence_conflict; then 0, 1(final) → 201s with window fields, one event", async () => {
    if (skip) return;
    const seq1 = windowBody({ prefix: "S1", count: 2, seq: 1, isFinal: true });
    const early = await post({ ...RUN_SEQ, key: freshKey(), body: seq1 }).expect(409);
    expect(early.body.error.code).toBe("window_sequence_conflict");

    const w0 = await post({
      ...RUN_SEQ,
      key: freshKey(),
      body: windowBody({ prefix: "S0", count: 3, seq: 0, isFinal: false }),
    }).expect(201);
    expect(w0.body).toMatchObject({ acceptedEntryCount: 3, windowSeq: 0, windowsRecorded: 1, complete: false });
    expect(await eventCount(RUN_SEQ)).toBe(0);

    const w1 = await post({ ...RUN_SEQ, key: freshKey(), body: seq1 }).expect(201);
    expect(w1.body).toMatchObject({ acceptedEntryCount: 2, windowSeq: 1, windowsRecorded: 2, complete: true });
    expect(await eventCount(RUN_SEQ)).toBe(1);

    const after = await post({
      ...RUN_SEQ,
      key: freshKey(),
      body: windowBody({ prefix: "S2", count: 1, seq: 2, isFinal: true }),
    }).expect(409);
    expect(after.body.error.code).toBe("window_sequence_conflict");
    expect(await eventCount(RUN_SEQ)).toBe(1);
  });

  it("same key: identical body replays; changed isFinal → 409 idempotency_key_conflict; fresh key: echo 200 or conflict", async () => {
    if (skip) return;
    const key = "binview-rt175-idem-w0-0000";
    const body = windowBody({ prefix: "I0", count: 2, seq: 0, isFinal: false });
    const first = await post({ ...RUN_IDEM, key, body }).expect(201);

    const sameKey = await post({ ...RUN_IDEM, key, body });
    expect(sameKey.headers["idempotent-replayed"]).toBe("true");
    expect(sameKey.body).toEqual(first.body);

    const flipped = await post({
      ...RUN_IDEM,
      key,
      body: windowBody({ prefix: "I0", count: 2, seq: 0, isFinal: true }),
    }).expect(409);
    expect(flipped.body.error.code).toBe("idempotency_key_conflict");

    const echo = await post({ ...RUN_IDEM, key: freshKey(), body }).expect(200);
    expect(echo.headers["idempotent-replayed"]).toBe("true");
    expect(echo.body).toEqual(first.body);

    const diff = await post({
      ...RUN_IDEM,
      key: freshKey(),
      body: windowBody({ prefix: "I0-DIFF", count: 2, seq: 0, isFinal: false }),
    }).expect(409);
    expect(diff.body.error.code).toBe("idempotency_key_conflict");
    expect(await eventCount(RUN_IDEM)).toBe(0);
  });

  it("cross-tenant requestRef → the same non-disclosing 404 as an absent ref, on every window", async () => {
    if (skip) return;
    const x0 = windowBody({ prefix: "X0", count: 1, seq: 0, isFinal: false });
    await post({ ...RUN_XT, key: freshKey(), body: x0 }).expect(201);
    const absent = await post({ ...ABSENT_RUN, key: freshKey(), body: x0, session: connectorTokenB }).expect(404);
    const windows: WindowSpec[] = [
      { prefix: "XB0", count: 1, seq: 0, isFinal: false },
      { prefix: "XB1", count: 1, seq: 1, isFinal: false },
      { prefix: "XB2", count: 1, seq: 2, isFinal: true },
    ];
    for (const w of windows) {
      const res = await post({ ...RUN_XT, key: freshKey(), body: windowBody(w), session: connectorTokenB }).expect(404);
      expect(res.body.error.code).toBe("not_found");
      expect(res.body.error.message).toBe(absent.body.error.message);
      expect(Object.keys(res.body.error).sort()).toEqual(Object.keys(absent.body.error).sort());
    }
    expect(await eventCount(RUN_XT)).toBe(0);
  });
});
