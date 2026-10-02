/**
 * T464 — Cross-tenant rejection signal test.
 * T475 — cross_tenant_rejection_total emission from TenantContextGuard.
 *
 * Asserts:
 *   1. `cross_tenant_rejection_total` is in `ALLOWED_METRIC_LABELS` with
 *      `[route]` and validates cleanly against the cardinality guard.
 *   2. `route` is not a forbidden label; `tenant_id`, `store_id`, `path`,
 *      `user_id` are all rejected.
 *   3. `recordCrossTenantRejection` is callable without a MetricReader.
 *   4. `TenantContextGuard.canActivate` emits `recordCrossTenantRejection`
 *      AND `recordTenantContextFailure{reason:"cross_tenant"}` when
 *      `resolve()` throws NotFoundException (cross-tenant or cross-store
 *      rejection). Both signals increment together per signals.md §1.
 *   5. The guard does NOT emit either signal for UnauthorizedException (a
 *      different failure kind — missing principal or missing active tenant).
 *   6. The NotFoundException is re-thrown unchanged — existing authorization
 *      behavior is preserved (no status-code or body change).
 *
 * Scope: in-process, no Testcontainers, no live DB. Cross-tenant rejections
 * are simulated by mocking `runWithTenantContext` from `@data-pulse-2/db`
 * to execute the work function, with `findActiveMembership` returning null.
 * The OTel Meter is a no-op in this context.
 *
 * Constitution §II / §VII / FR-B-006 / FR-B-008 / FR-ISO-4 / T464 / T475.
 */

// Mock @data-pulse-2/db before any imports that may load the module.
jest.mock("@data-pulse-2/db", () => ({
  runWithTenantContext: jest.fn(
    async (_pool: unknown, _ctx: unknown, fn: (client: unknown) => unknown) => fn({}),
  ),
}));

import "reflect-metadata";

import { NotFoundException, UnauthorizedException } from "@nestjs/common";
import type { Pool } from "pg";
import { runWithTenantContext } from "@data-pulse-2/db";
import { ALLOWED_METRIC_LABELS, FORBIDDEN_METRIC_LABELS, validateMetricLabels } from "@data-pulse-2/shared";

import {
  recordCrossTenantRejection,
  recordTenantContextFailure,
} from "../../src/observability/metrics/api.metrics";
import * as apiMetrics from "../../src/observability/metrics/api.metrics";
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

/** Minimal session row that satisfies the guard's session check. */
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
// 1. Signal policy — cross_tenant_rejection_total label-policy
// ---------------------------------------------------------------------------

describe("T464 — cross_tenant_rejection_total: signal policy", () => {
  it("is registered in ALLOWED_METRIC_LABELS with label [route]", () => {
    expect(ALLOWED_METRIC_LABELS["cross_tenant_rejection_total"]).toEqual(["route"]);
  });

  it("validateMetricLabels passes with [route]", () => {
    expect(validateMetricLabels("cross_tenant_rejection_total", ["route"])).toBeNull();
  });

  it("validateMetricLabels passes with [] (empty subset is always valid)", () => {
    expect(validateMetricLabels("cross_tenant_rejection_total", [])).toBeNull();
  });

  it("rejects tenant_id — forbidden_label (FR-B-006: unbounded cardinality)", () => {
    const err = validateMetricLabels("cross_tenant_rejection_total", ["tenant_id"]);
    expect(err?.kind).toBe("forbidden_label");
    expect(err).toMatchObject({ label: "tenant_id" });
  });

  it("rejects store_id — forbidden_label (FR-B-006)", () => {
    const err = validateMetricLabels("cross_tenant_rejection_total", ["store_id"]);
    expect(err?.kind).toBe("forbidden_label");
    expect(err).toMatchObject({ label: "store_id" });
  });

  it("rejects user_id — forbidden_label (FR-B-006: PII-adjacent)", () => {
    const err = validateMetricLabels("cross_tenant_rejection_total", ["user_id"]);
    expect(err?.kind).toBe("forbidden_label");
  });

  it("rejects path — forbidden_label (rendered URL carries tenant IDs)", () => {
    // `path` is in FORBIDDEN_METRIC_LABELS: rendered URLs contain tenant/store
    // UUIDs (e.g., /api/v1/tenants/uuid/members) — use `route` template instead.
    const err = validateMetricLabels("cross_tenant_rejection_total", ["path"]);
    expect(err?.kind).toBe("forbidden_label");
  });

  it("rejects url — forbidden_label (same rationale as path)", () => {
    const err = validateMetricLabels("cross_tenant_rejection_total", ["url"]);
    expect(err?.kind).toBe("forbidden_label");
  });

  it("rejects region — unallowed_label (safe but not declared)", () => {
    const err = validateMetricLabels("cross_tenant_rejection_total", ["region"]);
    expect(err?.kind).toBe("unallowed_label");
    expect(err).toMatchObject({ allowed: ["route"] });
  });

  it("tenant_id is in FORBIDDEN_METRIC_LABELS (FR-B-006 tripwire)", () => {
    expect(FORBIDDEN_METRIC_LABELS.has("tenant_id")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Helper callable without MetricReader
// ---------------------------------------------------------------------------

describe("T464 — recordCrossTenantRejection callable without MetricReader", () => {
  it("does not throw for a route-template value", () => {
    expect(() =>
      recordCrossTenantRejection({ route: "/api/v1/tenants/:id/members" }),
    ).not.toThrow();
  });

  it("does not throw for 'unknown' route (guard fallback when metadata absent)", () => {
    expect(() => recordCrossTenantRejection({ route: "unknown" })).not.toThrow();
  });

  it("recordTenantContextFailure with reason cross_tenant does not throw", () => {
    expect(() => recordTenantContextFailure({ reason: "cross_tenant" })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 3. T475 — TenantContextGuard emits on cross-tenant NotFoundException
// ---------------------------------------------------------------------------

describe("T475 — TenantContextGuard emits cross_tenant_rejection_total on NotFoundException", () => {
  let crossTenantSpy: jest.SpyInstance;
  let tenantContextSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    crossTenantSpy = jest.spyOn(apiMetrics, "recordCrossTenantRejection");
    tenantContextSpy = jest.spyOn(apiMetrics, "recordTenantContextFailure");
    // Default: runWithTenantContext calls the work function (normal path).
    (runWithTenantContext as jest.Mock).mockImplementation(
      async (_pool: unknown, _ctx: unknown, fn: (client: unknown) => unknown) => fn({}),
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("emits recordCrossTenantRejection when membership is not found (cross-tenant path)", async () => {
    const fakeSessions = {
      findActiveById: jest.fn().mockResolvedValue(fakeSession),
    } as unknown as SessionRepository;

    const fakeMemberships = {
      isPlatformAdmin: jest.fn().mockResolvedValue(false),
      // Returning null simulates no active membership in the session's active tenant.
      // This is the cross-tenant rejection path in resolveSession.
      findActiveMembership: jest.fn().mockResolvedValue(null),
    } as unknown as MembershipRepository;

    const guard = new TenantContextGuard(fakeSessions, fakeMemberships, {} as Pool);

    const request: Partial<TenantContextRequest> = {
      principal: { kind: "session", sessionId: "session-a", userId: "user-a" },
    };

    await expect(
      guard.canActivate(makeExecCtx(request) as never),
    ).rejects.toThrow(NotFoundException);

    expect(crossTenantSpy).toHaveBeenCalledTimes(1);
    expect(crossTenantSpy).toHaveBeenCalledWith(
      expect.objectContaining({ route: expect.any(String) }),
    );
  });

  it("emits recordTenantContextFailure{reason:cross_tenant} alongside cross_tenant_rejection_total", async () => {
    const fakeSessions = {
      findActiveById: jest.fn().mockResolvedValue(fakeSession),
    } as unknown as SessionRepository;
    const fakeMemberships = {
      isPlatformAdmin: jest.fn().mockResolvedValue(false),
      findActiveMembership: jest.fn().mockResolvedValue(null),
    } as unknown as MembershipRepository;

    const guard = new TenantContextGuard(fakeSessions, fakeMemberships, {} as Pool);
    const request: Partial<TenantContextRequest> = {
      principal: { kind: "session", sessionId: "session-a", userId: "user-a" },
    };

    await expect(
      guard.canActivate(makeExecCtx(request) as never),
    ).rejects.toThrow(NotFoundException);

    // Both signals must increment together per signals.md §1.
    expect(tenantContextSpy).toHaveBeenCalledTimes(1);
    expect(tenantContextSpy).toHaveBeenCalledWith({ reason: "cross_tenant" });
  });

  it("does NOT emit either signal for UnauthorizedException (missing principal)", async () => {
    const fakeSessions = {
      findActiveById: jest.fn().mockResolvedValue(fakeSession),
    } as unknown as SessionRepository;
    const fakeMemberships = {
      isPlatformAdmin: jest.fn().mockResolvedValue(false),
    } as unknown as MembershipRepository;

    const guard = new TenantContextGuard(fakeSessions, fakeMemberships, {} as Pool);

    // No principal in request → throws UnauthorizedException (not NotFoundException).
    const request: Partial<TenantContextRequest> = {
      // no `principal` field
    };

    await expect(
      guard.canActivate(makeExecCtx(request) as never),
    ).rejects.toThrow(UnauthorizedException);

    expect(crossTenantSpy).not.toHaveBeenCalled();
    expect(tenantContextSpy).not.toHaveBeenCalled();
  });

  it("does NOT emit either signal when there is no active tenant (UnauthorizedException)", async () => {
    // Session exists but has no activeTenantId → UnauthorizedException.
    const sessionWithoutTenant = { ...fakeSession, activeTenantId: null };
    const fakeSessions = {
      findActiveById: jest.fn().mockResolvedValue(sessionWithoutTenant),
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
    ).rejects.toThrow(UnauthorizedException);

    expect(crossTenantSpy).not.toHaveBeenCalled();
    expect(tenantContextSpy).not.toHaveBeenCalled();
  });

  it("re-throws the NotFoundException unchanged (behavior preserved per FR-ISO-4)", async () => {
    const fakeSessions = {
      findActiveById: jest.fn().mockResolvedValue(fakeSession),
    } as unknown as SessionRepository;
    const fakeMemberships = {
      isPlatformAdmin: jest.fn().mockResolvedValue(false),
      findActiveMembership: jest.fn().mockResolvedValue(null),
    } as unknown as MembershipRepository;

    const guard = new TenantContextGuard(fakeSessions, fakeMemberships, {} as Pool);
    const request: Partial<TenantContextRequest> = {
      principal: { kind: "session", sessionId: "session-a", userId: "user-a" },
    };

    // The exception type and status code must be unchanged (FR-ISO-4:
    // cross-tenant probes return 404, indistinguishable from "not found").
    const thrown = await guard
      .canActivate(makeExecCtx(request) as never)
      .catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(NotFoundException);
    expect((thrown as NotFoundException).getStatus()).toBe(404);
  });

  it("token principals resolve without emitting (token path never throws NotFoundException)", async () => {
    // Token principals resolve tenantId from the token itself — resolveToken
    // never throws NotFoundException, so no metric should emit.
    const fakeSessions = {
      findActiveById: jest.fn().mockResolvedValue(fakeSession),
    } as unknown as SessionRepository;
    const fakeMemberships = {
      isPlatformAdmin: jest.fn().mockResolvedValue(false),
    } as unknown as MembershipRepository;

    const guard = new TenantContextGuard(fakeSessions, fakeMemberships);

    const request: Partial<TenantContextRequest> = {
      principal: {
        kind: "token",
        userId: "user-a",
        storeId: null,
        tenantId: "tenant-a",
      } as NonNullable<TenantContextRequest["principal"]>,
    };

    // resolveToken always succeeds (no membership lookup, no NotFoundException).
    await guard.canActivate(makeExecCtx(request) as never);
    expect(crossTenantSpy).not.toHaveBeenCalled();
    expect(tenantContextSpy).not.toHaveBeenCalled();
  });
});
