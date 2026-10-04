/**
 * RT-113 BC2 — Docker-free units of the cashier-admissions runtime:
 * server policy config, the eligibility classifier, the request
 * fingerprint, the pure admission decision, the takeover limiter's
 * fail-open posture and the DTO.
 */
import type { Logger } from "@data-pulse-2/shared";

import { RateLimiter, type RedisLike } from "../../src/auth/rate-limit";
import {
  admissionAction,
  keyDigest,
  requestFingerprint,
} from "../../src/pos-cashier-admissions/admission-request";
import {
  DEFAULT_ADMISSION_TTL_SECONDS,
  DEFAULT_OFFLINE_GRACE_SECONDS,
  DEFAULT_TAKEOVER_RATE_LIMIT,
  DEFAULT_TAKEOVER_LIMITER_TIMEOUT_MS,
  DEFAULT_TAKEOVER_RATE_WINDOW_SECONDS,
  readCashierAdmissionPolicy,
  readTakeoverLimiterTimeoutMs,
} from "../../src/pos-cashier-admissions/cashier-admissions.config";
import { classifyEligibility, type EligibilityRow } from "../../src/pos-cashier-admissions/cashier-eligibility";
import type { TenantContextRequest } from "../../src/context/types";
import { deviceScopeOf } from "../../src/pos-cashier-admissions/device-scope";
import { AdmissionIdSchema, AdmissionRequestSchema } from "../../src/pos-cashier-admissions/dto";
import { TakeoverRateLimit } from "../../src/pos-cashier-admissions/takeover-rate-limit";

const USER = "0190f5a2-3b4c-7d8e-9f01-23456789abcd";
const DEVICE = "0190f5a2-3b4c-7d8e-9f01-00000000d001";
const KEY = "pos-pulse:4f6f1c1e-8a52-4c1b-9a0e-6d1f2b3c4d5e";

// ===========================================================================
// Config
// ===========================================================================
describe("readCashierAdmissionPolicy", () => {
  it("defaults: TTL 12 h, offline grace 24 h, 10 takeovers per device per hour", () => {
    expect(DEFAULT_ADMISSION_TTL_SECONDS).toBe(43200);
    expect(DEFAULT_OFFLINE_GRACE_SECONDS).toBe(86400);
    expect(readCashierAdmissionPolicy({})).toEqual({
      admissionTtlSeconds: 43200,
      offlineGraceSeconds: 86400,
      takeoverLimit: {
        limit: DEFAULT_TAKEOVER_RATE_LIMIT,
        windowMs: DEFAULT_TAKEOVER_RATE_WINDOW_SECONDS * 1000,
      },
    });
    expect(DEFAULT_TAKEOVER_RATE_LIMIT).toBe(10);
    expect(DEFAULT_TAKEOVER_RATE_WINDOW_SECONDS).toBe(3600);
  });

  it("reads overrides from the environment", () => {
    expect(
      readCashierAdmissionPolicy({
        CASHIER_ADMISSION_TTL_SECONDS: "600",
        CASHIER_OFFLINE_GRACE_SECONDS: "0",
        CASHIER_TAKEOVER_RATE_LIMIT: "3",
        CASHIER_TAKEOVER_RATE_WINDOW_SECONDS: "60",
      }),
    ).toEqual({
      admissionTtlSeconds: 600,
      offlineGraceSeconds: 0,
      takeoverLimit: { limit: 3, windowMs: 60_000 },
    });
  });

  it.each(["", "abc", "-5", "1.5", "0x10", "1e3", " "])(
    "falls back to the default for an invalid value %p",
    (raw) => {
      const p = readCashierAdmissionPolicy({
        CASHIER_ADMISSION_TTL_SECONDS: raw,
        CASHIER_OFFLINE_GRACE_SECONDS: raw,
        CASHIER_TAKEOVER_RATE_LIMIT: raw,
        CASHIER_TAKEOVER_RATE_WINDOW_SECONDS: raw,
      });
      expect(p).toEqual(readCashierAdmissionPolicy({}));
    },
  );

  it("a TTL or rate window of 0 is invalid (minimum 1); a grace of 0 is valid", () => {
    const p = readCashierAdmissionPolicy({
      CASHIER_ADMISSION_TTL_SECONDS: "0",
      CASHIER_TAKEOVER_RATE_LIMIT: "0",
      CASHIER_TAKEOVER_RATE_WINDOW_SECONDS: "0",
      CASHIER_OFFLINE_GRACE_SECONDS: "0",
    });
    expect(p.admissionTtlSeconds).toBe(43200);
    expect(p.takeoverLimit).toEqual({ limit: 10, windowMs: 3_600_000 });
    expect(p.offlineGraceSeconds).toBe(0);
  });

  it("caps the TTL at 7 days so a typo cannot pin a cashier for months", () => {
    expect(readCashierAdmissionPolicy({ CASHIER_ADMISSION_TTL_SECONDS: "999999999" }).admissionTtlSeconds).toBe(
      43200,
    );
    expect(readCashierAdmissionPolicy({ CASHIER_ADMISSION_TTL_SECONDS: "604800" }).admissionTtlSeconds).toBe(604800);
  });
});

// ===========================================================================
// Eligibility classifier (same set as the roster)
// ===========================================================================
describe("classifyEligibility", () => {
  const ok: EligibilityRow = {
    user_deleted: false,
    display_name: "Mona A.",
    operator_id: "user_2abc",
    role_eligible: true,
    store_active: true,
    store_accessible: true,
  };

  it("an eligible row yields the display name and operator id", () => {
    expect(classifyEligibility(ok)).toEqual({ eligible: true, displayName: "Mona A.", operatorId: "user_2abc" });
  });

  it.each<[string, EligibilityRow | undefined, string]>([
    ["no active membership in the tenant", undefined, "membership_inactive"],
    ["a deleted user", { ...ok, user_deleted: true }, "user_deleted"],
    ["an ineligible role", { ...ok, role_eligible: false }, "role_ineligible"],
    ["an inactive store", { ...ok, store_active: false }, "store_inactive"],
    ["no access to the store", { ...ok, store_accessible: false }, "store_not_accessible"],
    ["no provider subject", { ...ok, operator_id: null }, "profile_incomplete"],
    ["no display name", { ...ok, display_name: null }, "profile_incomplete"],
  ])("%s → refused (%s)", (_label, row, reason) => {
    expect(classifyEligibility(row)).toEqual({ eligible: false, reason });
  });

  it("checks in a fixed order: the user before the role before the store", () => {
    expect(
      classifyEligibility({ ...ok, user_deleted: true, role_eligible: false, store_accessible: false }),
    ).toEqual({ eligible: false, reason: "user_deleted" });
    expect(classifyEligibility({ ...ok, role_eligible: false, store_accessible: false })).toEqual({
      eligible: false,
      reason: "role_ineligible",
    });
  });
});

// ===========================================================================
// Request fingerprint and key digest
// ===========================================================================
describe("requestFingerprint / keyDigest", () => {
  const base = { mode: "online" as const, user_id: USER, idempotency_key: KEY };

  it("is a 32-byte digest that ignores the key itself", () => {
    const a = requestFingerprint(base);
    expect(a).toHaveLength(32);
    expect(requestFingerprint({ ...base, idempotency_key: "another-key-0123456789" }).equals(a)).toBe(true);
  });

  it("treats an omitted takeover as false", () => {
    expect(requestFingerprint({ ...base, takeover: false }).equals(requestFingerprint(base))).toBe(true);
    expect(requestFingerprint({ ...base, takeover: true }).equals(requestFingerprint(base))).toBe(false);
  });

  it("distinguishes the user, the mode and the offline time", () => {
    const reconcile = {
      mode: "reconcile_offline" as const,
      user_id: USER,
      offline_admitted_at: "2026-10-04T08:00:00Z",
      idempotency_key: KEY,
    };
    const fps = [
      requestFingerprint(base),
      requestFingerprint({ ...base, user_id: DEVICE }),
      requestFingerprint(reconcile),
      requestFingerprint({ ...reconcile, offline_admitted_at: "2026-10-04T09:00:00Z" }),
    ].map((b) => b.toString("hex"));
    expect(new Set(fps).size).toBe(4);
  });

  it("keyDigest is a 32-byte sha256 that never equals the raw key", () => {
    const d = keyDigest(KEY);
    expect(d).toHaveLength(32);
    expect(d.toString("utf8")).not.toContain(KEY);
    expect(keyDigest(KEY).equals(d)).toBe(true);
  });
});

// ===========================================================================
// Pure admission decision
// ===========================================================================
describe("admissionAction", () => {
  it.each<[string, { id: string; deviceId: string } | null, boolean, string]>([
    ["no live admission", null, false, "create"],
    ["no live admission, takeover", null, true, "create"],
    ["live on this device", { id: "a", deviceId: DEVICE }, false, "renew"],
    ["live on this device, takeover", { id: "a", deviceId: DEVICE }, true, "renew"],
    ["live elsewhere", { id: "a", deviceId: "other" }, false, "active_elsewhere"],
    ["live elsewhere, takeover", { id: "a", deviceId: "other" }, true, "takeover"],
  ])("%s → %s", (_label, live, takeover, action) => {
    expect(admissionAction(live, DEVICE, takeover)).toBe(action);
  });
});

// ===========================================================================
// Takeover limiter
// ===========================================================================
describe("TakeoverRateLimit", () => {
  function redis(overrides: Partial<RedisLike> = {}): RedisLike {
    const counts = new Map<string, number>();
    return {
      incr: async (k) => {
        const n = (counts.get(k) ?? 0) + 1;
        counts.set(k, n);
        return n;
      },
      pexpireNx: async () => 1,
      pttl: async () => 1000,
      decr: async () => 0,
      del: async () => 1,
      ...overrides,
    };
  }
  const bucket = { limit: 2, windowMs: 60_000 };

  it("allows up to the limit per device, then refuses; devices are independent", async () => {
    const limit = new TakeoverRateLimit(new RateLimiter(redis()));
    expect(await limit.allow(DEVICE, bucket)).toBe(true);
    expect(await limit.allow(DEVICE, bucket)).toBe(true);
    expect(await limit.allow(DEVICE, bucket)).toBe(false);
    expect(await limit.allow("other-device", bucket)).toBe(true);
  });

  it("fails open with a warning when the limiter's store is unavailable (ADR 0009 D3)", async () => {
    const warn = jest.fn();
    const limit = new TakeoverRateLimit(
      new RateLimiter(redis({ incr: async () => Promise.reject(new Error("redis down")) })),
      { warn } as unknown as Logger,
    );
    expect(await limit.allow(DEVICE, bucket)).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ device_id: DEVICE }),
      expect.stringContaining("failing open"),
    );
  });

  it("a limiter that never answers yields a decision (allow) within the timeout", async () => {
    const warn = jest.fn();
    const hung = { check: () => new Promise<never>(() => undefined) } as unknown as RateLimiter;
    const limit = new TakeoverRateLimit(hung, { warn } as unknown as Logger, { timeoutMs: 50 });
    const started = Date.now();
    expect(await limit.allow(DEVICE, bucket)).toBe(true);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ device_id: DEVICE, err_class: "TakeoverLimiterTimeout" }),
      expect.stringContaining("failing open"),
    );
  });

  it("a limiter that answers in time is not affected by the timeout", async () => {
    const limit = new TakeoverRateLimit(new RateLimiter(redis()), undefined, { timeoutMs: 1000 });
    expect(await limit.allow(DEVICE, { limit: 1, windowMs: 60_000 })).toBe(true);
    expect(await limit.allow(DEVICE, { limit: 1, windowMs: 60_000 })).toBe(false);
  });

  it("the limiter timeout defaults to 250 ms and is configurable", () => {
    expect(DEFAULT_TAKEOVER_LIMITER_TIMEOUT_MS).toBe(250);
    expect(readTakeoverLimiterTimeoutMs({})).toBe(250);
    expect(readTakeoverLimiterTimeoutMs({ CASHIER_TAKEOVER_LIMITER_TIMEOUT_MS: "100" })).toBe(100);
    expect(readTakeoverLimiterTimeoutMs({ CASHIER_TAKEOVER_LIMITER_TIMEOUT_MS: "0" })).toBe(250);
    expect(readTakeoverLimiterTimeoutMs({ CASHIER_TAKEOVER_LIMITER_TIMEOUT_MS: "999999" })).toBe(250);
  });

  it("fails open without a logger too", async () => {
    const limit = new TakeoverRateLimit(
      new RateLimiter(redis({ incr: async () => Promise.reject(new Error("redis down")) })),
    );
    expect(await limit.allow(DEVICE, bucket)).toBe(true);
  });
});

// ===========================================================================
// DTO
// ===========================================================================
describe("AdmissionRequestSchema / AdmissionIdSchema", () => {
  it("accepts both variants and rejects unknown fields per variant", () => {
    expect(AdmissionRequestSchema.safeParse({ mode: "online", user_id: USER, idempotency_key: KEY }).success).toBe(true);
    expect(
      AdmissionRequestSchema.safeParse({
        mode: "reconcile_offline",
        user_id: USER,
        offline_admitted_at: "2026-10-04T08:00:00+02:00",
        idempotency_key: KEY,
      }).success,
    ).toBe(true);
    expect(
      AdmissionRequestSchema.safeParse({ mode: "online", user_id: USER, idempotency_key: KEY, store_id: USER }).success,
    ).toBe(false);
    expect(
      AdmissionRequestSchema.safeParse({
        mode: "reconcile_offline",
        user_id: USER,
        offline_admitted_at: "yesterday",
        idempotency_key: KEY,
      }).success,
    ).toBe(false);
    expect(
      AdmissionRequestSchema.safeParse({ mode: "online", user_id: USER, idempotency_key: `${KEY} with space` }).success,
    ).toBe(false);
    expect(
      AdmissionRequestSchema.safeParse({ mode: "online", user_id: USER, idempotency_key: "x".repeat(129) }).success,
    ).toBe(false);
  });

  it("the path id must be a uuid", () => {
    expect(AdmissionIdSchema.safeParse(USER).success).toBe(true);
    expect(AdmissionIdSchema.safeParse("not-a-uuid").success).toBe(false);
  });
});

// ===========================================================================
// Device scope (fail closed)
// ===========================================================================
describe("deviceScopeOf", () => {
  const context = {
    userId: null,
    tenantId: "0190f5a2-3b4c-7d8e-9f01-00000000a001",
    storeId: "0190f5a2-3b4c-7d8e-9f01-00000000b001",
    isPlatformAdmin: false,
    source: "token" as const,
  };

  it("returns the device, tenant and store the guard published", () => {
    const req = { posDeviceId: DEVICE, context } as unknown as TenantContextRequest;
    expect(deviceScopeOf(req)).toEqual({ deviceId: DEVICE, tenantId: context.tenantId, storeId: context.storeId });
  });

  it.each<[string, Partial<TenantContextRequest>]>([
    ["no device id", { context }],
    ["no context", { posDeviceId: DEVICE }],
    ["no store", { posDeviceId: DEVICE, context: { ...context, storeId: null } }],
    ["no tenant", { posDeviceId: DEVICE, context: { ...context, tenantId: null } }],
  ])("throws a generic 401 with %s", (_label, req) => {
    expect(() => deviceScopeOf(req as TenantContextRequest)).toThrow("Unauthorized");
  });
});
