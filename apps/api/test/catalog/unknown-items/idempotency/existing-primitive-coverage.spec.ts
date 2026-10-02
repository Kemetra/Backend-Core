/**
 * T505 — 005-WAVE1-IDEMP-VERIFY.
 *
 * Verification spec: proves the EXISTING `IdempotencyInterceptor` (001-owned,
 * `apps/api/src/idempotency/idempotency.interceptor.ts`) already satisfies
 * Wave 1's idempotency functional requirements for the POS capture path,
 * without any modification to the interceptor itself.
 *
 * If any of the four cases below required a change to the interceptor, that
 * would be a 001 defect — not work for this slice. Stop and report instead.
 *
 * Acceptance (slice 005-WAVE1-IDEMP-VERIFY validation contract):
 *   GREEN 4/4 — existing IdempotencyInterceptor satisfies
 *     FR-021  (identical retry → replay, exactly one handler invocation)
 *     FR-021a (per-device scoping via clientId segment of dedup tuple)
 *     FR-021b (replay-TTL default ≥ 24h)
 *     FR-021c (payload mismatch → 409 with canonical conflict envelope)
 *   against a fake POS-principal context.
 *
 * Drift notes (raised in the verification report, not bugs in this test):
 *   - tasks.md §5.2 references a `DEFAULT_REPLAY_TTL_SEC` constant. No such
 *     export exists — the 72h default is inlined at interceptor.ts:226. This
 *     spec therefore proves FR-021b *behaviorally*: it captures the
 *     `expiresAt` Date the interceptor hands to `store.save` and asserts
 *     `expiresAt - now >= 24h` (FR-021b floor) AND falls inside a 71h–73h
 *     window (documented 72h default).
 *   - tasks.md §5.2 says the 409 body carries `error.code = "idempotency_key_conflict"`.
 *     Post-PR #360: this is now the actual wire shape. The
 *     `IdempotencyInterceptor` throws ConflictException with a structured
 *     payload `{ code: "idempotency_key_conflict", message: ... }`, and
 *     `GlobalExceptionFilter` honors that user-supplied fine-grained code
 *     (Constitution §IV — OpenAPI contract-of-record specifies the codes;
 *     the filter must surface them, not silently overwrite with the
 *     status-derived canonical). The earlier note that the inner code was
 *     being dropped reflected a filter bug (every HttpException's code
 *     was being rewritten to `statusToCode(status)`); that bug was fixed
 *     in PR #360 by extracting the `code` field from the response payload
 *     and only falling back to `statusToCode` when the caller did not
 *     supply one.
 *   - Slice brief lists `docker_required: true`. The four assertions are
 *     pure interceptor behavior over fake Redis + fake in-progress marker
 *     (same Docker-free pattern as every existing 001 idempotency spec).
 *     No container is needed. Flagged in the verification report.
 *
 * Test strategy mirrors 001's existing specs
 * (apps/api/test/idempotency/{replay,conflict,cross-tenant}.spec.ts):
 *   - In-memory FakeRedis implementing the small RedisLike surface used by
 *     IdempotencyKeyStore.
 *   - FakeMarker that always wins (no in-progress contention is tested here).
 *   - Minimal test-local controller carrying `@Idempotent('required')` —
 *     decoupled from any membership/catalog business code.
 *   - ConfigurableGuard sets `req.context.userId` (the POS device identity
 *     per interceptor.ts:88) and `req.context.tenantId` per request.
 */
import "reflect-metadata";
import {
  Body,
  Controller,
  HttpStatus,
  Post,
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
} from "@nestjs/common";
import { APP_INTERCEPTOR, Reflector } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { GlobalExceptionFilter } from "../../../../src/common/exception.filter";
import {
  IDEMPOTENCY_KEY_STORE,
  IdempotencyInterceptor,
} from "../../../../src/idempotency/idempotency.interceptor";
import { Idempotent } from "../../../../src/idempotency/idempotent.decorator";
import {
  INFLIGHT_REDIS,
  InProgressMarker,
} from "../../../../src/idempotency/in-progress-marker";
import type { ResolvedContext } from "../../../../src/context/types";
import { DashboardAuthGuard } from "../../../../src/auth/dashboard-auth.guard";
import { PosOperatorAuthGuard } from "../../../../src/auth/pos-operator-auth.guard";
import { RolesGuard } from "../../../../src/auth/roles.guard";
import { TenantContextGuard } from "../../../../src/context/tenant-context.guard";
import { IdempotencyKeyStore } from "@data-pulse-2/shared";

// ---------------------------------------------------------------------------
// Constants — a fake POS-principal context. `userId` is the device identity.
// ---------------------------------------------------------------------------
const TENANT_ID = "0d000000-0000-7000-8000-000000000005";
const DEVICE_A  = "0d000000-0000-7000-8000-0000000005a1"; // device principal A (POS terminal A)
const DEVICE_B  = "0d000000-0000-7000-8000-0000000005b1"; // device principal B (POS terminal B)
const IDEMP_KEY = "abcdef1234567890abcdef1234567890"; // 32 chars — passes KEY_REGEX

const BODY_A = { identifier_type: "barcode", value: "012345678901", source_system: "pos-v1" };
const BODY_B = { identifier_type: "barcode", value: "999999999999", source_system: "pos-v1" }; // different payload

// FR-021b floor: 24h (interceptor's documented default is 72h)
const FR_021B_FLOOR_MS = 24 * 60 * 60 * 1000;
const FR_021B_DOCUMENTED_DEFAULT_MS = 72 * 60 * 60 * 1000;
const FR_021B_DEFAULT_TOLERANCE_MS = 60 * 60 * 1000; // ±1h around 72h

// ---------------------------------------------------------------------------
// In-memory FakeRedis — matches the RedisLike surface used by
// IdempotencyKeyStore (px-based set + get; the marker uses NX/EX but we
// stub the marker entirely below so its NX path is never invoked).
// ---------------------------------------------------------------------------
class FakeRedis {
  private readonly store = new Map<string, { value: string; expiresAt: number }>();

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(
    key: string,
    value: string,
    options: { px: number },
  ): Promise<unknown> {
    this.store.set(key, { value, expiresAt: Date.now() + options.px });
    return "OK";
  }

  clear(): void {
    this.store.clear();
  }
}

// ---------------------------------------------------------------------------
// FakeMarker — always returns true (marker owned). The slice scope is
// post-marker behavior (replay / conflict / per-device / TTL); in-progress
// contention is covered by 001's existing `in-progress.spec.ts`.
// ---------------------------------------------------------------------------
class FakeMarker {
  async trySet(_tuple: string, _ttl?: number): Promise<boolean> {
    return true;
  }
  async del(_tuple: string): Promise<void> {
    /* no-op */
  }
}

// ---------------------------------------------------------------------------
// Test-local controller — minimal POS-capture stand-in carrying the existing
// `@Idempotent('required')` decorator from 001. NOT the real
// `UnknownItemsController` (which doesn't exist yet — that's T512).
// ---------------------------------------------------------------------------
class HandlerInvocationCounter {
  public calls = 0;
  public lastBody: unknown = null;
  public lastDevice: string | null = null;
}

const HANDLER_COUNTER = new HandlerInvocationCounter();

@Controller("/api/v1/test/idemp-verify")
class IdempVerifyController {
  @Post("capture")
  @Idempotent("required") // No replayTtlSec override → exercises the default path
  capture(@Body() body: unknown): { ok: true; echoed: unknown } {
    HANDLER_COUNTER.calls += 1;
    HANDLER_COUNTER.lastBody = body;
    return { ok: true, echoed: body };
  }
}

// ---------------------------------------------------------------------------
// ConfigurableGuard — sets `req.context.{tenantId, userId}` from runtime
// fields. `userId` is the POS device identity for clientId extraction.
// ---------------------------------------------------------------------------
class ConfigurableContextGuard implements CanActivate {
  public tenantId: string = TENANT_ID;
  public deviceId: string = DEVICE_A;

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx
      .switchToHttp()
      .getRequest<{ context?: ResolvedContext; principal?: { userId?: string } }>();
    req.context = {
      userId: this.deviceId,
      tenantId: this.tenantId,
      storeId: null,
      isPlatformAdmin: false,
      source: "session", // shape parity with 001 specs; not asserted by interceptor
    };
    req.principal = { userId: this.deviceId };
    return true;
  }
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------
let app: INestApplication;
let fakeRedis: FakeRedis;
let contextGuard: ConfigurableContextGuard;
let store: IdempotencyKeyStore;
let saveSpy: jest.SpyInstance;

beforeAll(async () => {
  fakeRedis = new FakeRedis();
  contextGuard = new ConfigurableContextGuard();
  const fakeMarker = new FakeMarker();

  store = new IdempotencyKeyStore({
    redis: fakeRedis,
    pgWriter: { async insert() {} },
    pgReader: { async find() { return null; } },
    defaultTtlMs: 72 * 60 * 60 * 1000,
  });
  // Spy on save() — used to capture the `expiresAt` the interceptor computes
  // for the FR-021b TTL assertion. The spy still delegates to the real impl
  // so the rest of the suite (replay path) keeps working.
  saveSpy = jest.spyOn(store, "save");

  const reflector = new Reflector();
  const interceptor = new IdempotencyInterceptor(
    reflector,
    store,
    fakeMarker as unknown as InProgressMarker,
  );

  // Single guard for the test controller — bind by class so Nest applies it
  // globally for the testing module.
  const moduleRef = await Test.createTestingModule({
    controllers: [IdempVerifyController],
    providers: [
      { provide: IDEMPOTENCY_KEY_STORE, useValue: store },
      { provide: INFLIGHT_REDIS, useValue: fakeRedis },
      { provide: InProgressMarker, useValue: fakeMarker },
      { provide: APP_INTERCEPTOR, useValue: interceptor },
    ],
  })
    // Real DashboardAuthGuard + TenantContextGuard + RolesGuard are wired
    // method-level on LIST + dismiss as of the auth-guard wiring slice.
    // Even tests that only hit the POS capture route must override these
    // because NestJS resolves all controller-declared guards at compile time.
    // Override with no-op pass-throughs so the test harness compiles and
    // the global ConfigurableContextGuard's context survives to the handler.
    .overrideGuard(DashboardAuthGuard).useValue({ canActivate: () => true })
    .overrideGuard(PosOperatorAuthGuard).useValue({ canActivate: () => true })
    .overrideGuard(TenantContextGuard).useValue({ canActivate: () => true })
    .overrideGuard(RolesGuard).useValue({ canActivate: () => true })
    .compile();

  app = moduleRef.createNestApplication({ bufferLogs: true });
  app.useGlobalFilters(new GlobalExceptionFilter());
  // Apply the configurable guard at the app level so every test request
  // gets a context. The guard itself reads runtime fields (tenantId, deviceId).
  app.useGlobalGuards(contextGuard);
  await app.init();
});

afterAll(async () => {
  if (app) await app.close();
});

beforeEach(() => {
  HANDLER_COUNTER.calls = 0;
  HANDLER_COUNTER.lastBody = null;
  HANDLER_COUNTER.lastDevice = null;
  fakeRedis.clear();
  contextGuard.tenantId = TENANT_ID;
  contextGuard.deviceId = DEVICE_A;
  // Jest's `restoreMocks: true` (apps/api/jest.config.cjs) un-attaches every
  // `jest.spyOn` between tests, so we re-spy here. Spy still delegates to the
  // real implementation so replay paths in other cases keep working.
  saveSpy = jest.spyOn(store, "save");
});

function http() {
  return request(app.getHttpServer());
}

// ---------------------------------------------------------------------------
// FR-021 — identical retry replays after first compute.
// ---------------------------------------------------------------------------
describe("FR-021 identical retry — same (tenant, device, key, payload) replays once computed", () => {
  it("retries 5x with identical payload produce 1 handler call; calls 2-5 carry Idempotent-Replayed: true", async () => {
    const responses: Array<{ status: number; replayed: string | undefined; body: unknown }> = [];

    for (let i = 0; i < 5; i += 1) {
      const res = await http()
        .post("/api/v1/test/idemp-verify/capture")
        .set("Idempotency-Key", IDEMP_KEY)
        .send(BODY_A);
      responses.push({
        status: res.status,
        replayed: res.headers["idempotent-replayed"],
        body: res.body,
      });
    }

    // Exactly one underlying handler invocation across 5 retries.
    expect(HANDLER_COUNTER.calls).toBe(1);

    // All five responses succeed with the same body.
    for (const r of responses) {
      expect(r.status).toBe(HttpStatus.CREATED);
      expect(r.body).toEqual({ ok: true, echoed: BODY_A });
    }

    // Calls 2-5 are replays; call 1 is the original compute.
    expect(responses[0]!.replayed).toBeUndefined();
    for (let i = 1; i < 5; i += 1) {
      expect(responses[i]!.replayed).toBe("true");
    }
  });
});

// ---------------------------------------------------------------------------
// FR-021c — mismatched payload → 409 Conflict (fails closed).
// ---------------------------------------------------------------------------
describe("FR-021c mismatched payload — same (tenant, device, key) + different payload → 409", () => {
  it("second request with different body returns 409 and the original is preserved", async () => {
    // First call computes and stores
    const first = await http()
      .post("/api/v1/test/idemp-verify/capture")
      .set("Idempotency-Key", IDEMP_KEY)
      .send(BODY_A);
    expect(first.status).toBe(HttpStatus.CREATED);
    expect(HANDLER_COUNTER.calls).toBe(1);

    // Second call: same key, DIFFERENT body
    const conflict = await http()
      .post("/api/v1/test/idemp-verify/capture")
      .set("Idempotency-Key", IDEMP_KEY)
      .send(BODY_B);

    expect(conflict.status).toBe(HttpStatus.CONFLICT);

    // Wire envelope: GlobalExceptionFilter honors the user-supplied
    // fine-grained code from IdempotencyInterceptor (Constitution §IV).
    // Post-PR #360, `error.code: "idempotency_key_conflict"` flows
    // straight through from the throwing site to the wire envelope.
    expect(conflict.body).toMatchObject({
      error: {
        code: "idempotency_key_conflict",
        message: expect.any(String),
      },
    });

    // Original mutation preserved — service NOT re-invoked on conflict.
    expect(HANDLER_COUNTER.calls).toBe(1);

    // Conflict envelope must not leak payload-distinguishing values.
    const bodyStr = JSON.stringify(conflict.body);
    expect(bodyStr).not.toContain(BODY_A.value);
    expect(bodyStr).not.toContain(BODY_B.value);
  });
});

// ---------------------------------------------------------------------------
// FR-021a — per-device scoping via clientId segment of the dedup tuple.
// ---------------------------------------------------------------------------
describe("FR-021a per-device scoping — two devices, same Idempotency-Key string → independent requests", () => {
  it("device A and device B with same key and different bodies both succeed independently", async () => {
    // Device A submits with BODY_A
    contextGuard.deviceId = DEVICE_A;
    const resA = await http()
      .post("/api/v1/test/idemp-verify/capture")
      .set("Idempotency-Key", IDEMP_KEY)
      .send(BODY_A);
    expect(resA.status).toBe(HttpStatus.CREATED);
    expect(resA.headers["idempotent-replayed"]).toBeUndefined();
    expect(resA.body).toEqual({ ok: true, echoed: BODY_A });
    const callsAfterA = HANDLER_COUNTER.calls;
    expect(callsAfterA).toBe(1);

    // Device B submits with the SAME Idempotency-Key but a DIFFERENT body.
    // If device-scoping is wrong this would trigger 409. Correct behavior:
    // each device occupies its own slot of the dedup tuple
    // (`${method}:${route}:${clientId}:${key}` — interceptor.ts:117).
    contextGuard.deviceId = DEVICE_B;
    const resB = await http()
      .post("/api/v1/test/idemp-verify/capture")
      .set("Idempotency-Key", IDEMP_KEY)
      .send(BODY_B);

    expect(resB.status).toBe(HttpStatus.CREATED);
    expect(resB.headers["idempotent-replayed"]).toBeUndefined();
    expect(resB.body).toEqual({ ok: true, echoed: BODY_B });

    // Both devices got their own compute — handler invoked exactly twice.
    expect(HANDLER_COUNTER.calls).toBe(callsAfterA + 1);
  });

  it("device A retry replays without affecting device B's prior result", async () => {
    // Device A: initial
    contextGuard.deviceId = DEVICE_A;
    await http()
      .post("/api/v1/test/idemp-verify/capture")
      .set("Idempotency-Key", IDEMP_KEY)
      .send(BODY_A);
    // Device B: separate slot, different body
    contextGuard.deviceId = DEVICE_B;
    await http()
      .post("/api/v1/test/idemp-verify/capture")
      .set("Idempotency-Key", IDEMP_KEY)
      .send(BODY_B);
    const callsAfterBoth = HANDLER_COUNTER.calls;
    expect(callsAfterBoth).toBe(2);

    // Device A retry → replays A, NOT B
    contextGuard.deviceId = DEVICE_A;
    const replayA = await http()
      .post("/api/v1/test/idemp-verify/capture")
      .set("Idempotency-Key", IDEMP_KEY)
      .send(BODY_A);
    expect(replayA.status).toBe(HttpStatus.CREATED);
    expect(replayA.headers["idempotent-replayed"]).toBe("true");
    expect(replayA.body).toEqual({ ok: true, echoed: BODY_A });
    expect(HANDLER_COUNTER.calls).toBe(callsAfterBoth); // no additional invocation
  });
});

// ---------------------------------------------------------------------------
// FR-021b — Replay-TTL default ≥ 24h. Behavioral assertion (no exported
// constant exists; drift flagged in header).
// ---------------------------------------------------------------------------
describe("FR-021b TTL default — interceptor's replay retention is ≥ 24h with no override", () => {
  it("expiresAt passed to store.save is ≥ 24h ahead (FR-021b floor) and around the documented 72h default", async () => {
    const beforeMs = Date.now();

    const res = await http()
      .post("/api/v1/test/idemp-verify/capture")
      .set("Idempotency-Key", IDEMP_KEY)
      .send(BODY_A);
    expect(res.status).toBe(HttpStatus.CREATED);

    // The interceptor calls `store.save(...)` inside an async `tap.next`
    // callback (interceptor.ts:269-285) — RxJS does not await the returned
    // promise, so the HTTP response can resolve BEFORE save() is invoked.
    // Wait briefly for the microtask queue to drain so the spy registers
    // the call. Mirrors the fire-and-forget pattern of best-effort caching.
    for (let i = 0; i < 50 && saveSpy.mock.calls.length === 0; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    // The interceptor calls `store.save(tId, null, cId, tuple, fp, result, expiresAt)`
    // exactly once on the success path (interceptor.ts:269-285).
    expect(saveSpy).toHaveBeenCalledTimes(1);

    // 7th positional arg is expiresAt (Date).
    const callArgs = saveSpy.mock.calls[0];
    const expiresAt = callArgs[6] as Date;
    expect(expiresAt).toBeInstanceOf(Date);

    const ttlMs = expiresAt.getTime() - beforeMs;

    // FR-021b floor: at least 24h of replay retention.
    expect(ttlMs).toBeGreaterThanOrEqual(FR_021B_FLOOR_MS);

    // Documented default: 72h ± 1h tolerance (interceptor.ts:226).
    expect(ttlMs).toBeGreaterThanOrEqual(
      FR_021B_DOCUMENTED_DEFAULT_MS - FR_021B_DEFAULT_TOLERANCE_MS,
    );
    expect(ttlMs).toBeLessThanOrEqual(
      FR_021B_DOCUMENTED_DEFAULT_MS + FR_021B_DEFAULT_TOLERANCE_MS,
    );
  });
});
