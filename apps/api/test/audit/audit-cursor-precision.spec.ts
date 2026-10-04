/**
 * RT-211 — the audit list cursor must not lose sub-millisecond precision.
 *
 * `audit_events.occurred_at` is a microsecond `timestamptz`, but node-postgres
 * hands it back as a JS `Date` (millisecond precision). The `next_cursor`
 * built from that `Date` sits BELOW the last row's real `occurred_at`, so an
 * older event in the same millisecond with larger microseconds fails the
 * keyset predicate `(occurred_at, id) < (cursorTs, cursorId)` and is silently
 * skipped on the next page. Same defect class as RT-210 (run-history cursor).
 *
 * Deterministic seed (INSERT only — audit_events is append-only, 0034): three
 * distinct microsecond instants in ONE millisecond (one of them a two-event
 * tie, to pin the `id DESC` tiebreak) plus one event in the previous
 * millisecond. Non-matching "noise" events (another actor / store / action,
 * and another tenant) sit in the same millisecond so the filtered walks and
 * the anchor scope have signal. Walking `limit` 1, 2 and 3 — unfiltered and
 * with each supported filter — must return every visible event exactly once,
 * in `occurred_at DESC, id DESC` order, and the cursor must keep its wire
 * shape (base64url of `YYYY-MM-DDTHH:mm:ss.sssZ|<uuid>`).
 *
 * Route: GET /api/v1/audit/events — real AuditController → AuditService →
 * DrizzleAuditRepository on the non-superuser `app_test` pool (RLS applies).
 * Testcontainers Postgres 16 (same harness as audit.repository.spec.ts).
 */
import "reflect-metadata";

import {
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
} from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { DashboardAuthGuard } from "../../src/auth/dashboard-auth.guard";
import { RolesGuard } from "../../src/auth/roles.guard";
import { GlobalExceptionFilter } from "../../src/common/exception.filter";
import { TenantContextGuard } from "../../src/context/tenant-context.guard";
import type { ResolvedContext } from "../../src/context/types";
import { AuditController } from "../../src/audit/audit.controller";
import { encodeCursor } from "../../src/audit/audit.query.schema";
import {
  AUDIT_REPOSITORY,
  DrizzleAuditRepository,
} from "../../src/audit/audit.repository";
import { AuditService } from "../../src/audit/audit.service";
import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../_helpers/postgres-container";

const TENANT_A = "0a000000-0000-7000-8000-0000000211a1";
const TENANT_B = "0b000000-0000-7000-8000-0000000211b1";
const ACTOR_1 = "0a000000-0000-7000-8000-0000000211f1";
const ACTOR_2 = "0a000000-0000-7000-8000-0000000211f2";
const STORE_1 = "0a000000-0000-7000-8000-0000000211d1";
const STORE_2 = "0a000000-0000-7000-8000-0000000211d2";
const BASE = "/api/v1/audit/events";

/** Decoded server-issued cursor keeps its existing `<ms ISO>|<uuid>` shape. */
const CURSOR_SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\|[0-9a-f-]{36}$/;

// Matching events (ACTOR_1 / STORE_1 / `precision.*`), in the expected
// `occurred_at DESC, id DESC` order. P1..P3 share the millisecond
// 12:00:00.123; P2_HI/P2_LO tie at the same microsecond; P4 is in the
// previous millisecond.
const P1 = "0a000000-0000-7000-8000-0000000211c1";
const P2_HI = "0a000000-0000-7000-8000-0000000211c3";
const P2_LO = "0a000000-0000-7000-8000-0000000211c2";
const P3 = "0a000000-0000-7000-8000-0000000211c4";
const P4 = "0a000000-0000-7000-8000-0000000211c5";
// Noise in the same millisecond: other actor + store + action (tenant A), and
// a tenant-B event (visible to a platform admin through the RLS OR-branch,
// never to a tenant-A list).
const N_A = "0a000000-0000-7000-8000-0000000211e1";
const N_B = "0b000000-0000-7000-8000-0000000211e2";

interface Seed {
  readonly id: string;
  readonly tenant: string;
  readonly actor: string;
  readonly store: string | null;
  readonly action: string;
  readonly at: string;
}
const SEEDED: readonly Seed[] = [
  { id: N_B, tenant: TENANT_B, actor: ACTOR_2, store: null, action: "precision.event", at: "2097-04-01T12:00:00.123900Z" },
  { id: P1, tenant: TENANT_A, actor: ACTOR_1, store: STORE_1, action: "precision.event", at: "2097-04-01T12:00:00.123700Z" },
  { id: N_A, tenant: TENANT_A, actor: ACTOR_2, store: STORE_2, action: "noise.event", at: "2097-04-01T12:00:00.123550Z" },
  { id: P2_HI, tenant: TENANT_A, actor: ACTOR_1, store: STORE_1, action: "precision.event", at: "2097-04-01T12:00:00.123400Z" },
  { id: P2_LO, tenant: TENANT_A, actor: ACTOR_1, store: STORE_1, action: "precision.event", at: "2097-04-01T12:00:00.123400Z" },
  { id: P3, tenant: TENANT_A, actor: ACTOR_1, store: STORE_1, action: "precision.event", at: "2097-04-01T12:00:00.123100Z" },
  { id: P4, tenant: TENANT_A, actor: ACTOR_1, store: STORE_1, action: "precision.event", at: "2097-04-01T12:00:00.122900Z" },
];
const MATCHING_ORDER = [P1, P2_HI, P2_LO, P3, P4];
const TENANT_A_ORDER = [P1, N_A, P2_HI, P2_LO, P3, P4];

/** Mutable caller context: the global guard below stamps it on each request. */
const caller: { isPlatformAdmin: boolean } = { isPlatformAdmin: false };

class FixedContextGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<{
      context?: ResolvedContext;
      principal?: { userId?: string };
    }>();
    req.context = {
      userId: ACTOR_1,
      tenantId: TENANT_A,
      storeId: null,
      isPlatformAdmin: caller.isPlatformAdmin,
      source: "session",
      storeAccess: { kind: "all" },
    };
    req.principal = { userId: ACTOR_1 };
    return true;
  }
}

let env: PgTestEnv | null = null;
let app: INestApplication | null = null;
let dockerSkipped = false;

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      dockerSkipped = true;
      // eslint-disable-next-line no-console
      console.warn(`\n[audit-cursor-precision.spec] Docker NOT AVAILABLE: ${msg}\n`);
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }

  await applyAllUpAndCreateAppRole(env);
  await env.admin.query(
    `INSERT INTO users (id, email, password_hash) VALUES
       ($1, 'rt211-a1@example.com', NULL), ($2, 'rt211-a2@example.com', NULL)`,
    [ACTOR_1, ACTOR_2],
  );
  await env.admin.query(
    `INSERT INTO tenants (id, slug, name) VALUES
       ($1, 'rt211-a', 'RT-211 A'), ($2, 'rt211-b', 'RT-211 B')`,
    [TENANT_A, TENANT_B],
  );
  await env.admin.query(
    `INSERT INTO stores (id, tenant_id, code, name) VALUES
       ($1, $3, 'rt211-s1', 'Store 1'), ($2, $3, 'rt211-s2', 'Store 2')`,
    [STORE_1, STORE_2, TENANT_A],
  );
  for (const s of SEEDED) {
    await env.admin.query(
      `INSERT INTO audit_events (id, occurred_at, actor_user_id, tenant_id, store_id, action, metadata)
       VALUES ($1, $2::timestamptz, $3, $4, $5, $6, '{}'::jsonb)`,
      [s.id, s.at, s.actor, s.tenant, s.store, s.action],
    );
  }

  const localEnv = env;
  const moduleRef = await Test.createTestingModule({
    controllers: [AuditController],
    providers: [
      AuditService,
      {
        provide: AUDIT_REPOSITORY,
        useFactory: (): DrizzleAuditRepository => new DrizzleAuditRepository(localEnv.app),
      },
    ],
  })
    .overrideGuard(DashboardAuthGuard)
    .useValue({ canActivate: () => true })
    .overrideGuard(TenantContextGuard)
    .useValue({ canActivate: () => true })
    .overrideGuard(RolesGuard)
    .useValue({ canActivate: () => true })
    .compile();

  app = moduleRef.createNestApplication({ bufferLogs: true });
  app.useGlobalFilters(new GlobalExceptionFilter());
  app.useGlobalGuards(new FixedContextGuard());
  await app.init();
}, 180_000);

afterAll(async () => {
  if (app) await app.close();
  if (env) await stopPgEnv(env);
}, 60_000);

beforeEach(() => {
  caller.isPlatformAdmin = false;
});

const skip = (): boolean => dockerSkipped;

function decoded(cursor: string): string {
  return Buffer.from(cursor, "base64url").toString("utf8");
}

/** Walk every page at `limit`, returning ids in served order + every cursor seen. */
async function walk(
  limit: number,
  extra: Record<string, string> = {},
  startCursor: string | null = null,
): Promise<{ ids: string[]; cursors: string[] }> {
  const ids: string[] = [];
  const cursors: string[] = [];
  let cursor: string | null = startCursor;
  for (let i = 0; i < 50; i++) {
    const q: Record<string, string> = { ...extra, limit: String(limit) };
    if (cursor) q["cursor"] = cursor;
    const res = await request(app!.getHttpServer()).get(BASE).query(q).expect(200);
    for (const r of res.body.items as { id: string }[]) ids.push(r.id);
    cursor = res.body.next_cursor;
    if (!cursor) break;
    cursors.push(cursor);
  }
  return { ids, cursors };
}

describe("RT-211 — audit list cursor keeps sub-millisecond precision", () => {
  it("the seed really stores distinct microseconds inside one millisecond", async () => {
    if (skip()) return;
    const rows = await env!.admin.query<{ id: string; us: string }>(
      `SELECT id, to_char(occurred_at AT TIME ZONE 'UTC', 'HH24:MI:SS.US') AS us
         FROM audit_events WHERE tenant_id = $1
        ORDER BY occurred_at DESC, id DESC`,
      [TENANT_A],
    );
    expect(rows.rows.map((r) => r.id)).toEqual(TENANT_A_ORDER);
    expect(rows.rows.map((r) => r.us)).toEqual([
      "12:00:00.123700",
      "12:00:00.123550",
      "12:00:00.123400",
      "12:00:00.123400",
      "12:00:00.123100",
      "12:00:00.122900",
    ]);
  });

  it.each([1, 2, 3])(
    "limit=%i returns every tenant event exactly once, in occurred_at DESC, id DESC order",
    async (limit) => {
      if (skip()) return;
      const { ids, cursors } = await walk(limit);
      expect(ids).toEqual(TENANT_A_ORDER);
      expect(new Set(ids).size).toBe(ids.length);
      expect(cursors.length).toBeGreaterThan(0);
      for (const c of cursors) expect(decoded(c)).toMatch(CURSOR_SHAPE);
    },
  );

  it.each([1, 2, 3])(
    "limit=%i as a platform admin is gap-free and still tenant-scoped",
    async (limit) => {
      if (skip()) return;
      caller.isPlatformAdmin = true;
      const { ids } = await walk(limit);
      expect(ids).toEqual(TENANT_A_ORDER);
    },
  );

  const FILTERS: ReadonlyArray<readonly [string, Record<string, string>]> = [
    ["actor_user_id", { actor_user_id: ACTOR_1 }],
    ["store_id", { store_id: STORE_1 }],
    ["action prefix", { action: "precision." }],
    [
      "from/to",
      { from: "2097-04-01T12:00:00.000Z", to: "2097-04-01T12:00:01.000Z", actor_user_id: ACTOR_1 },
    ],
  ];
  for (const [name, filter] of FILTERS) {
    it.each([1, 2, 3])(`limit=%i with a ${name} filter is gap-free too`, async (limit) => {
      if (skip()) return;
      const { ids, cursors } = await walk(limit, filter);
      expect(ids).toEqual(MATCHING_ORDER);
      for (const c of cursors) expect(decoded(c)).toMatch(CURSOR_SHAPE);
    });
  }

  // The anchor only restores the sub-ms digits of a row THIS list could have
  // served. A cursor naming a row outside the caller's scope (another tenant,
  // or a row the active filter excludes) must not move the boundary: it falls
  // back to the cursor's own millisecond value.
  it("a cursor naming another tenant's row does not anchor on it (platform admin)", async () => {
    if (skip()) return;
    caller.isPlatformAdmin = true;
    const forged = encodeCursor(new Date("2097-04-01T12:00:00.123Z"), N_B);
    const { ids } = await walk(10, {}, forged);
    // Fallback boundary (…:00.123000, N_B): only P4 (…:00.122900) is older.
    expect(ids).toEqual([P4]);
  });

  it("a cursor naming a row the active filter excludes does not anchor on it", async () => {
    if (skip()) return;
    const forged = encodeCursor(new Date("2097-04-01T12:00:00.123Z"), N_A);
    const { ids } = await walk(10, { actor_user_id: ACTOR_1 }, forged);
    expect(ids).toEqual([P4]);
  });
});
