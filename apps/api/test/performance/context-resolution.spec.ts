/**
 * T310 — SC-5 performance gate: context resolution p95 ≤ 200 ms.
 *
 * Measurement boundary
 * --------------------
 * We time `TenantContextGuard.resolve(sessionPrincipal)` directly —
 * the same code path that fires on every authenticated HTTP request,
 * covering:
 *   SessionRepository.findActiveById         (SQL: sessions)
 *   MembershipRepository.isPlatformAdmin     (SQL: users)
 *   runWithTenantContext + SET LOCAL GUCs     (DB middleware round-trip)
 *   MembershipRepository.findActiveMembership (SQL: memberships, RLS)
 *
 * HTTP stack (routing, body-parse, guard dispatch scaffolding) and
 * downstream business logic are excluded — they are orthogonal to SC-5
 * which specifies "resolves active tenant + active store + role +
 * permissions". The guard chain is the implementation of that sentence.
 *
 * A non-superuser `app_test` pool is passed so RLS predicates execute
 * for real; omitting the pool (unit-test style) would bypass RLS and
 * produce artificially fast numbers.
 *
 * Protocol
 * --------
 *   - 20 warmup iterations (JIT + connection-pool warm-up, discarded)
 *   - 200 measured iterations
 *   - wall-clock via `performance.now()` per call
 *   - p95 ≤ 200 ms hard assertion (SC-5)
 */

import { performance } from "perf_hooks";
import { Pool } from "pg";
import { newId } from "@data-pulse-2/shared";
import { SessionRepository } from "../../src/auth/session.repository";
import { MembershipRepository } from "../../src/context/membership.repository";
import { TenantContextGuard } from "../../src/context/tenant-context.guard";
import type { Principal } from "../../src/auth/auth.guard";
import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../_helpers/postgres-container";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WARMUP = 20;
const N = 200;
const P95_LIMIT_MS = 200;

// ---------------------------------------------------------------------------
// Test environment
// ---------------------------------------------------------------------------

let env: PgTestEnv | null = null;
let adminPool: Pool | null = null;
let guard: TenantContextGuard;
let sessionPrincipal: Extract<Principal, { kind: "session" }>;

// ---------------------------------------------------------------------------
// Fixture seeding (FK order: user → tenant → role → store → membership → session)
// ---------------------------------------------------------------------------

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);

    adminPool = new Pool({ connectionString: env.adminUri });

    const userId = newId();
    const tenantId = newId();
    const roleId = newId();
    const storeId = newId();
    const membershipId = newId();
    const sessionId = newId();

    await adminPool.query(
      `INSERT INTO users (id, email, password_hash, is_platform_admin)
       VALUES ($1, $2, $3, false)`,
      [userId, `perf-${userId}@example.com`, "phc-placeholder"],
    );
    await adminPool.query(
      `INSERT INTO tenants (id, slug, name) VALUES ($1, $2, $3)`,
      [tenantId, `perf-tenant-${tenantId.slice(0, 8)}`, "Perf Tenant"],
    );
    await adminPool.query(
      `INSERT INTO roles (id, tenant_id, code, name) VALUES ($1, $2, $3, $4)`,
      [roleId, tenantId, "perf_member", "Perf Member"],
    );
    await adminPool.query(
      `INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $2, $3, $4)`,
      [storeId, tenantId, "PERF-1", "Perf Store 1"],
    );
    await adminPool.query(
      `INSERT INTO memberships (id, tenant_id, user_id, role_id, store_access_kind)
       VALUES ($1, $2, $3, $4, $5)`,
      [membershipId, tenantId, userId, roleId, "all"],
    );
    await adminPool.query(
      `INSERT INTO sessions
         (id, user_id, active_tenant_id, active_store_id,
          issued_at, last_seen_at, absolute_expires_at, credential_hash)
       VALUES ($1, $2, $3, $4, now(), now(), now() + interval '1 hour',
               decode(md5($1::text), 'hex') || decode(md5($1::text || ':h'), 'hex'))`,
      [sessionId, userId, tenantId, null],
    );

    // Construct guard wired to the app (non-superuser) pool so RLS fires.
    const sessions = new SessionRepository(env.app);
    const memberships = new MembershipRepository(env.app);
    guard = new TenantContextGuard(sessions, memberships, env.app);

    sessionPrincipal = {
      kind: "session",
      sessionId,
      userId,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[context-resolution.spec] Docker NOT AVAILABLE: ${msg}\n`);
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }
}, 180_000);

afterAll(async () => {
  if (adminPool) await adminPool.end().catch(() => undefined);
  if (env) await stopPgEnv(env);
}, 60_000);

// ---------------------------------------------------------------------------
// Performance measurement
// ---------------------------------------------------------------------------

it(
  `SC-5: TenantContextGuard.resolve p95 ≤ ${P95_LIMIT_MS} ms (N=${N})`,
  async () => {
    if (!env) {
      // Docker was unavailable and we soft-skipped in beforeAll.
      console.warn("[SC-5] Skipped — Docker not available.");
      return;
    }

    // Warmup — discard results; lets PG planner cache query plans and
    // Node's JIT compile the hot path.
    for (let i = 0; i < WARMUP; i++) {
      await guard.resolve(sessionPrincipal);
    }

    // Measured iterations.
    const durations: number[] = [];
    for (let i = 0; i < N; i++) {
      const t0 = performance.now();
      await guard.resolve(sessionPrincipal);
      durations.push(performance.now() - t0);
    }

    durations.sort((a, b) => a - b);

    const p50 = durations[Math.ceil(N * 0.5) - 1]!;
    const p95 = durations[Math.ceil(N * 0.95) - 1]!;
    const max = durations[N - 1]!;

    // eslint-disable-next-line no-console
    console.log(
      `[SC-5] N=${N} p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms max=${max.toFixed(1)}ms`,
    );

    expect(p95).toBeLessThanOrEqual(P95_LIMIT_MS);
  },
  60_000,
);
