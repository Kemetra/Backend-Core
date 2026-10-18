/**
 * T463 — DB RLS-context-failure signal test.
 * T471 — DB signal definitions and label-policy validation.
 *
 * Asserts:
 *   1. Every DB metric in `docs/observability/signals.md` §2 is registered
 *      in `ALLOWED_METRIC_LABELS` via `DB_METRIC_NAMES`.
 *   2. Label policy is correct for each signal:
 *      - `db_rls_context_failure_total` has NO labels (alertable counter).
 *      - `db_slow_query_total` has `[query_class]` (never raw query text).
 *      - Pool/migration gauges have expected labels.
 *   3. Emission helpers are callable without a MetricReader.
 *   4. `TenantContextGuard.withBootstrapCtx` emits `db_rls_context_failure_total`
 *      when `runWithTenantContext` rejects with a non-HttpException (DB
 *      bootstrap failure), but NOT for NotFoundException (application-level).
 *
 * Scope: in-process, no Testcontainers, no live DB. DB bootstrap failures
 * are simulated by mocking `runWithTenantContext` from `@data-pulse-2/db`.
 * The OTel Meter is a no-op in this context.
 *
 * Constitution §VII / FR-B-002 / FR-B-006 / FR-B-009 / T463 / T471 / T476.
 */

// Mock @data-pulse-2/db before any imports that may load the module.
jest.mock("@data-pulse-2/db", () => ({
  runWithTenantContext: jest.fn(
    async (_pool: unknown, _ctx: unknown, fn: (client: unknown) => unknown) => fn({}),
  ),
}));

import "reflect-metadata";

import { NotFoundException } from "@nestjs/common";
import type { Pool } from "pg";
import { runWithTenantContext } from "@data-pulse-2/db";
import { ALLOWED_METRIC_LABELS, FORBIDDEN_METRIC_LABELS, validateMetricLabels } from "@data-pulse-2/shared";

import {
  DB_METRIC_NAMES,
  recordDbRlsContextFailure,
  recordDbSlowQuery,
} from "../../src/observability/metrics/db.metrics";
import * as dbMetrics from "../../src/observability/metrics/db.metrics";
import { TenantContextGuard } from "../../src/context/tenant-context.guard";
import type { SessionRepository } from "../../src/auth/session.repository";
import type { MembershipRepository } from "../../src/context/membership.repository";
import type { TenantContextRequest } from "../../src/context/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeExecCtx(request: Partial<TenantContextRequest>) {
  return {
    switchToHttp: () => ({
      getRequest: <T>() => request as unknown as T,
      getResponse: <T>() => ({}) as T,
      getNext: <T>() => ({}) as T,
    }),
    getHandler: () => () => undefined,
    getClass: () => class StubController {},
  };
}

/** Minimal session row shape needed by the guard. */
const fakeSession = {
  id: "session-a",
  userId: "user-a",
  activeTenantId: "11111111-0000-0000-0000-000000000000",
  activeStoreId: null,
  issuedAt: new Date(),
  lastSeenAt: new Date(),
  absoluteExpiresAt: new Date(Date.now() + 3_600_000),
  revokedAt: null,
  userAgent: null,
  ipAtIssue: null,
};

// ---------------------------------------------------------------------------
// 1. Signal-name registry
// ---------------------------------------------------------------------------

describe("T471 — DB_METRIC_NAMES: registry is complete and consistent", () => {
  it("contains exactly 5 DB signals", () => {
    expect(DB_METRIC_NAMES).toHaveLength(5);
  });

  it("contains db_pool_in_use", () => {
    expect(DB_METRIC_NAMES).toContain("db_pool_in_use");
  });

  it("contains db_pool_waiters", () => {
    expect(DB_METRIC_NAMES).toContain("db_pool_waiters");
  });

  it("contains db_slow_query_total", () => {
    expect(DB_METRIC_NAMES).toContain("db_slow_query_total");
  });

  it("contains db_rls_context_failure_total", () => {
    expect(DB_METRIC_NAMES).toContain("db_rls_context_failure_total");
  });

  it("contains db_migration_status", () => {
    expect(DB_METRIC_NAMES).toContain("db_migration_status");
  });
});

// ---------------------------------------------------------------------------
// 2. Signal presence — every DB metric is in ALLOWED_METRIC_LABELS
// ---------------------------------------------------------------------------

describe("T471 — signal presence: every DB metric is in ALLOWED_METRIC_LABELS", () => {
  for (const name of DB_METRIC_NAMES) {
    it(`registers "${name}" in ALLOWED_METRIC_LABELS`, () => {
      expect(ALLOWED_METRIC_LABELS[name]).toBeDefined();
    });
  }
});

// ---------------------------------------------------------------------------
// 3. Label policy — db_rls_context_failure_total (no labels, alertable)
// ---------------------------------------------------------------------------

describe("T471 — label policy: db_rls_context_failure_total (no labels — alertable)", () => {
  it("is registered with an empty label set", () => {
    expect(ALLOWED_METRIC_LABELS["db_rls_context_failure_total"]).toEqual([]);
  });

  it("validateMetricLabels passes with empty label set", () => {
    expect(validateMetricLabels("db_rls_context_failure_total", [])).toBeNull();
  });

  it("validateMetricLabels rejects tenant_id — forbidden_label (FR-B-006)", () => {
    const err = validateMetricLabels("db_rls_context_failure_total", ["tenant_id"]);
    expect(err?.kind).toBe("forbidden_label");
    expect(err).toMatchObject({ label: "tenant_id" });
  });

  it("validateMetricLabels rejects store_id — forbidden_label", () => {
    const err = validateMetricLabels("db_rls_context_failure_total", ["store_id"]);
    expect(err?.kind).toBe("forbidden_label");
  });

  it("validateMetricLabels rejects query_class — unallowed_label", () => {
    const err = validateMetricLabels("db_rls_context_failure_total", ["query_class"]);
    expect(err?.kind).toBe("unallowed_label");
  });

  it("tenant_id is in FORBIDDEN_METRIC_LABELS (FR-B-006 tripwire)", () => {
    expect(FORBIDDEN_METRIC_LABELS.has("tenant_id")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. Label policy — db_slow_query_total (query_class, never raw query text)
// ---------------------------------------------------------------------------

describe("T471 — label policy: db_slow_query_total (query_class)", () => {
  it("is registered with label set [query_class]", () => {
    expect(ALLOWED_METRIC_LABELS["db_slow_query_total"]).toEqual(["query_class"]);
  });

  it("validateMetricLabels passes with [query_class]", () => {
    expect(validateMetricLabels("db_slow_query_total", ["query_class"])).toBeNull();
  });

  it("validateMetricLabels passes with [] (empty subset always valid)", () => {
    expect(validateMetricLabels("db_slow_query_total", [])).toBeNull();
  });

  it.each([
    ["tenant_id", "FR-B-006"],
    // query_text is in FORBIDDEN_METRIC_LABELS — rendered SQL may contain
    // parameter values which are PII-suspect (redaction matrix §3.3).
    ["query_text", "raw query is PII-suspect"],
    ["query", "raw SQL identifier"],
  ])("validateMetricLabels rejects %s — forbidden_label (%s)", (label) => {
    const err = validateMetricLabels("db_slow_query_total", [label]);
    expect(err?.kind).toBe("forbidden_label");
  });

  it("validateMetricLabels rejects region — unallowed_label (not in allowlist)", () => {
    const err = validateMetricLabels("db_slow_query_total", ["region"]);
    expect(err?.kind).toBe("unallowed_label");
    expect(err).toMatchObject({ allowed: ["query_class"] });
  });
});

// ---------------------------------------------------------------------------
// 5. Label policy — pool gauges and migration status
// ---------------------------------------------------------------------------

describe("T471 — label policy: pool gauges (no labels)", () => {
  it("db_pool_in_use has no labels", () => {
    expect(ALLOWED_METRIC_LABELS["db_pool_in_use"]).toEqual([]);
    expect(validateMetricLabels("db_pool_in_use", [])).toBeNull();
  });

  it("db_pool_waiters has no labels", () => {
    expect(ALLOWED_METRIC_LABELS["db_pool_waiters"]).toEqual([]);
    expect(validateMetricLabels("db_pool_waiters", [])).toBeNull();
  });

  it("db_migration_status has label [state]", () => {
    expect(ALLOWED_METRIC_LABELS["db_migration_status"]).toEqual(["state"]);
    expect(validateMetricLabels("db_migration_status", ["state"])).toBeNull();
  });

  it("db_migration_status rejects tenant_id — forbidden_label", () => {
    const err = validateMetricLabels("db_migration_status", ["tenant_id"]);
    expect(err?.kind).toBe("forbidden_label");
  });
});

// ---------------------------------------------------------------------------
// 6. Helpers callable without MetricReader
// ---------------------------------------------------------------------------

describe("T471 — DB emission helpers callable without MetricReader", () => {
  it("recordDbRlsContextFailure() does not throw", () => {
    expect(() => recordDbRlsContextFailure()).not.toThrow();
  });

  it("recordDbSlowQuery({ query_class }) does not throw", () => {
    expect(() => recordDbSlowQuery({ query_class: "a1b2c3d4" })).not.toThrow();
  });

  it("recordDbRlsContextFailure() is callable multiple times without throwing", () => {
    expect(() => {
      recordDbRlsContextFailure();
      recordDbRlsContextFailure();
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 7. T476 — guard emits db_rls_context_failure_total on DB bootstrap error
// ---------------------------------------------------------------------------

describe("T476 — TenantContextGuard emits db_rls_context_failure_total on DB error", () => {
  let recordSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    recordSpy = jest.spyOn(dbMetrics, "recordDbRlsContextFailure");
    // Default mock: runWithTenantContext calls the work function (normal path).
    (runWithTenantContext as jest.Mock).mockImplementation(
      async (_pool: unknown, _ctx: unknown, fn: (client: unknown) => unknown) => fn({}),
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("emits db_rls_context_failure_total when runWithTenantContext rejects with a plain Error", async () => {
    // Simulate a DB bootstrap failure (e.g., connection refused, GUC cast error).
    (runWithTenantContext as jest.Mock).mockRejectedValueOnce(
      new Error("FATAL: connection refused"),
    );

    const fakeSessions = {
      findActiveById: jest.fn().mockResolvedValue(fakeSession),
    } as unknown as SessionRepository;

    const fakeMemberships = {
      isPlatformAdmin: jest.fn().mockResolvedValue(false),
      findActiveMembership: jest.fn().mockResolvedValue({ membershipId: "m1", storeAccessKind: "all" }),
    } as unknown as MembershipRepository;

    const guard = new TenantContextGuard(fakeSessions, fakeMemberships, {} as Pool);

    const request: Partial<TenantContextRequest> = {
      principal: { kind: "session", sessionId: "session-a", userId: "user-a" },
    };

    await expect(
      guard.canActivate(makeExecCtx(request) as never),
    ).rejects.toThrow("FATAL: connection refused");

    expect(recordSpy).toHaveBeenCalledTimes(1);
  });

  it("does NOT emit db_rls_context_failure_total for NotFoundException (application-level)", async () => {
    // NotFoundException from the work function (e.g., membership not found)
    // is an application-level rejection, NOT a DB bootstrap failure.
    (runWithTenantContext as jest.Mock).mockRejectedValueOnce(new NotFoundException("Not Found"));

    const fakeSessions = {
      findActiveById: jest.fn().mockResolvedValue(fakeSession),
    } as unknown as SessionRepository;

    const fakeMemberships = {
      isPlatformAdmin: jest.fn().mockResolvedValue(false),
    } as unknown as MembershipRepository;

    const guard = new TenantContextGuard(fakeSessions, fakeMemberships, {} as Pool);

    const request: Partial<TenantContextRequest> = {
      principal: { kind: "session", sessionId: "session-a", userId: "user-a" },
    };

    await expect(
      guard.canActivate(makeExecCtx(request) as never),
    ).rejects.toThrow(NotFoundException);

    // Must not count a NotFoundException as a DB/RLS bootstrap failure.
    expect(recordSpy).not.toHaveBeenCalled();
  });

  it("does NOT emit db_rls_context_failure_total when pool is absent (unit-test path)", async () => {
    // When pool is undefined, withBootstrapCtx calls work(undefined) directly.
    // No runWithTenantContext involved → no DB failure possible.
    const fakeSessions = {
      findActiveById: jest.fn().mockResolvedValue(fakeSession),
    } as unknown as SessionRepository;

    const fakeMemberships = {
      isPlatformAdmin: jest.fn().mockResolvedValue(false),
      findActiveMembership: jest.fn().mockResolvedValue({ membershipId: "m1", storeAccessKind: "all" }),
    } as unknown as MembershipRepository;

    // No pool — should fall back to work(undefined) path.
    const guard = new TenantContextGuard(fakeSessions, fakeMemberships);

    const request: Partial<TenantContextRequest> = {
      principal: { kind: "session", sessionId: "session-a", userId: "user-a" },
    };

    await guard.canActivate(makeExecCtx(request) as never);
    expect(recordSpy).not.toHaveBeenCalled();
  });

  it("re-throws the original error so the guard pipeline still rejects", async () => {
    const dbError = new Error("db_rls_context: GUC cast failed");
    (runWithTenantContext as jest.Mock).mockRejectedValueOnce(dbError);

    const fakeSessions = {
      findActiveById: jest.fn().mockResolvedValue(fakeSession),
    } as unknown as SessionRepository;
    const fakeMemberships = {
      isPlatformAdmin: jest.fn().mockResolvedValue(false),
    } as unknown as MembershipRepository;

    const guard = new TenantContextGuard(fakeSessions, fakeMemberships, {} as Pool);
    const request: Partial<TenantContextRequest> = {
      principal: { kind: "session", sessionId: "session-a", userId: "user-a" },
    };

    await expect(
      guard.canActivate(makeExecCtx(request) as never),
    ).rejects.toBe(dbError);
  });
});
