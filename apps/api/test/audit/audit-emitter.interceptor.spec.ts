/**
 * T230 — AuditEmitterInterceptor spec.
 *
 * Pure unit-level: no Redis, no Docker, no Testcontainers, no BullMQ Queue.
 * The interceptor is instantiated directly with a Jest-spy enqueuer and a
 * real `Reflector` instance — the same pattern used in
 * `test/context/context.interceptor.spec.ts`.
 *
 * KNOWN INTENTIONAL GAP: The real `ContextController` is NOT decorated with
 * `@Auditable` in this slice. That wiring is deferred to T232/T233 when
 * `AuditModule` is registered and the interceptor is added to the global chain
 * in `main.ts`. These tests validate the interceptor's behaviour using a fake
 * controller that carries `@Auditable` — they are unaffected by the real
 * controller's undecorated state.
 *
 * Coverage:
 *   - context-switch actions (fully implemented in this slice)
 *   - no-op paths (routes without @Auditable)
 *   - it.todo stubs for the four remaining T230 categories
 */
import "reflect-metadata";
import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  type INestApplication,
  Module,
  Post,
} from "@nestjs/common";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { Reflector } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { Auditable } from "../../src/audit/auditable.decorator";
import { AUDIT_JOB_ENQUEUER, type AuditJobEnqueuer } from "../../src/audit/audit-job.enqueuer";
import { AuditEmitterInterceptor } from "../../src/audit/audit-emitter.interceptor";
import type { AuditJobPayload } from "../../src/audit/audit-job.types";
import type { ContextResponseBody } from "../../src/context/context.service";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const USER_ID = "0a000000-0000-7000-8000-00000000aa01";
const TENANT_ID = "0a000000-0000-7000-8000-0000000a1001";
const STORE_ID = "0a000000-0000-7000-8000-0000000c5001";
const REQUEST_ID = "req-test-001";

const CONTEXT_RESPONSE: ContextResponseBody = {
  user: {
    id: USER_ID,
    email: "alice@example.com",
    display_name: "Alice",
    is_platform_admin: false,
  },
  active_tenant: { id: TENANT_ID, slug: "acme", name: "Acme" },
  active_store: null,
  active_role_code: "tenant_admin",
  memberships: [],
  support_session: null,
};

const CONTEXT_RESPONSE_WITH_STORE: ContextResponseBody = {
  ...CONTEXT_RESPONSE,
  active_store: { id: STORE_ID, code: "S01", name: "Main St" },
};

// ---------------------------------------------------------------------------
// Fake controller — carries @Auditable; does NOT modify context.controller.ts
// ---------------------------------------------------------------------------

@Controller("test")
class FakeContextController {
  @Auditable("context.switch.tenant")
  @Post("tenant")
  @HttpCode(HttpStatus.OK)
  switchTenant(): ContextResponseBody {
    return CONTEXT_RESPONSE;
  }

  @Auditable("context.switch.store")
  @Post("store")
  @HttpCode(HttpStatus.OK)
  switchStore(): ContextResponseBody {
    return CONTEXT_RESPONSE_WITH_STORE;
  }

  @Auditable("context.clear.store")
  @Post("clear-store")
  @HttpCode(HttpStatus.OK)
  clearStore(): ContextResponseBody {
    return CONTEXT_RESPONSE; // active_store: null
  }

  // Route WITHOUT @Auditable — interceptor must not call enqueuer here.
  @Get("public")
  publicRoute(): { ok: boolean } {
    return { ok: true };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildFakeEnqueuer(): AuditJobEnqueuer & {
  enqueue: jest.MockedFunction<AuditJobEnqueuer["enqueue"]>;
  capturedPayloads: AuditJobPayload[];
} {
  const capturedPayloads: AuditJobPayload[] = [];
  const enqueue = jest.fn(async (payload: AuditJobPayload) => {
    capturedPayloads.push(payload);
  });
  return { enqueue, capturedPayloads };
}

async function buildApp(
  enqueuer: AuditJobEnqueuer,
): Promise<INestApplication> {
  @Module({
    controllers: [FakeContextController],
    providers: [
      { provide: AUDIT_JOB_ENQUEUER, useValue: enqueuer },
      {
        provide: APP_INTERCEPTOR,
        useFactory: (reflector: Reflector) =>
          new AuditEmitterInterceptor(reflector, enqueuer),
        inject: [Reflector],
      },
    ],
  })
  class TestModule {}

  const moduleRef = await Test.createTestingModule({
    imports: [TestModule],
  }).compile();

  const app = moduleRef.createNestApplication();
  // Simulate what RequestIdInterceptor does — attach requestId to each request.
  app.use((_req: { requestId?: string }, _res: unknown, next: () => void) => {
    _req.requestId = REQUEST_ID;
    next();
  });
  // Simulate what AuthGuard does — attach principal.
  app.use(
    (
      _req: { principal?: { kind: string; userId: string; sessionId: string } },
      _res: unknown,
      next: () => void,
    ) => {
      _req.principal = {
        kind: "session",
        userId: USER_ID,
        sessionId: "sess-001",
      };
      next();
    },
  );
  await app.init();
  return app;
}

// ---------------------------------------------------------------------------
// Helper: flush the microtask queue so fire-and-forget enqueue calls settle
// ---------------------------------------------------------------------------
async function flushAsync(): Promise<void> {
  // Two ticks: one for the tap callback, one for the enqueuer Promise.
  await new Promise<void>((r) => setImmediate(r));
  await new Promise<void>((r) => setImmediate(r));
}

// ---------------------------------------------------------------------------
// Tests — context-switch actions
// ---------------------------------------------------------------------------

describe("AuditEmitterInterceptor — context switch actions", () => {
  let app: INestApplication;
  let fakeEnqueuer: ReturnType<typeof buildFakeEnqueuer>;

  beforeEach(async () => {
    fakeEnqueuer = buildFakeEnqueuer();
    app = await buildApp(fakeEnqueuer);
  });

  afterEach(async () => {
    await app.close();
  });

  it("enqueues a job with the correct action on POST /test/tenant", async () => {
    await request(app.getHttpServer()).post("/test/tenant").expect(200);
    await flushAsync();

    expect(fakeEnqueuer.enqueue).toHaveBeenCalledTimes(1);
    const payload = fakeEnqueuer.capturedPayloads[0];
    expect(payload).toBeDefined();
    expect(payload!.action).toBe("context.switch.tenant");
  });

  it("derives tenant_id from response body when request.context is absent", async () => {
    await request(app.getHttpServer()).post("/test/tenant").expect(200);
    await flushAsync();

    const payload = fakeEnqueuer.capturedPayloads[0];
    expect(payload!.tenant_id).toBe(TENANT_ID);
  });

  it("derives store_id as null when active_store is null in response body", async () => {
    await request(app.getHttpServer()).post("/test/tenant").expect(200);
    await flushAsync();

    const payload = fakeEnqueuer.capturedPayloads[0];
    expect(payload!.store_id).toBeNull();
  });

  it("derives store_id from response body when active_store is present", async () => {
    await request(app.getHttpServer()).post("/test/store").expect(200);
    await flushAsync();

    const payload = fakeEnqueuer.capturedPayloads[0];
    expect(payload!.store_id).toBe(STORE_ID);
  });

  it("context.clear.store: action correct, tenant_id from body, store_id null", async () => {
    await request(app.getHttpServer()).post("/test/clear-store").expect(200);
    await flushAsync();

    expect(fakeEnqueuer.enqueue).toHaveBeenCalledTimes(1);
    const payload = fakeEnqueuer.capturedPayloads[0];
    expect(payload!.action).toBe("context.clear.store");
    expect(payload!.tenant_id).toBe(TENANT_ID);
    expect(payload!.store_id).toBeNull();
  });

  it("derives actor_user_id from request.principal.userId", async () => {
    await request(app.getHttpServer()).post("/test/tenant").expect(200);
    await flushAsync();

    const payload = fakeEnqueuer.capturedPayloads[0];
    expect(payload!.actor_user_id).toBe(USER_ID);
  });

  it("includes request_id in payload when set by upstream middleware", async () => {
    await request(app.getHttpServer()).post("/test/tenant").expect(200);
    await flushAsync();

    const payload = fakeEnqueuer.capturedPayloads[0];
    expect(payload!.request_id).toBe(REQUEST_ID);
  });

  it("does not throw when enqueuer.enqueue rejects", async () => {
    fakeEnqueuer.enqueue.mockRejectedValueOnce(new Error("queue down"));

    await expect(
      request(app.getHttpServer()).post("/test/tenant"),
    ).resolves.toMatchObject({ status: 200 });
    await flushAsync();
  });
});

// ---------------------------------------------------------------------------
// Tests — request.context present (TenantContextGuard ran upstream)
// ---------------------------------------------------------------------------

describe("AuditEmitterInterceptor — request.context present", () => {
  let app: INestApplication;
  let fakeEnqueuer: ReturnType<typeof buildFakeEnqueuer>;

  beforeEach(async () => {
    fakeEnqueuer = buildFakeEnqueuer();

    // Build a module whose middleware attaches BOTH principal AND context,
    // simulating a route that mounts TenantContextGuard.
    @Module({
      controllers: [FakeContextController],
      providers: [
        { provide: AUDIT_JOB_ENQUEUER, useValue: fakeEnqueuer },
        {
          provide: APP_INTERCEPTOR,
          useFactory: (reflector: Reflector) =>
            new AuditEmitterInterceptor(reflector, fakeEnqueuer),
          inject: [Reflector],
        },
      ],
    })
    class ContextModule {}

    const moduleRef = await Test.createTestingModule({
      imports: [ContextModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.use((_req: { requestId?: string }, _res: unknown, next: () => void) => {
      _req.requestId = REQUEST_ID;
      next();
    });
    app.use(
      (
        _req: {
          principal?: { kind: string; userId: string; sessionId: string };
          context?: { tenantId: string | null; storeId: string | null };
        },
        _res: unknown,
        next: () => void,
      ) => {
        _req.principal = { kind: "session", userId: USER_ID, sessionId: "sess-002" };
        // Simulate TenantContextGuard having run — context differs from response body.
        _req.context = { tenantId: "ctx-tenant-from-guard", storeId: "ctx-store-from-guard" };
        next();
      },
    );
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it("takes tenant_id and store_id from request.context when present, not response body", async () => {
    await request(app.getHttpServer()).post("/test/tenant").expect(200);
    await flushAsync();

    const payload = fakeEnqueuer.capturedPayloads[0];
    expect(payload!.tenant_id).toBe("ctx-tenant-from-guard");
    expect(payload!.store_id).toBe("ctx-store-from-guard");
    // Confirms response body (TENANT_ID / null) was NOT used.
    expect(payload!.tenant_id).not.toBe(TENANT_ID);
  });
});

// ---------------------------------------------------------------------------
// Tests — no-op paths
// ---------------------------------------------------------------------------

describe("AuditEmitterInterceptor — no-op paths", () => {
  let app: INestApplication;
  let fakeEnqueuer: ReturnType<typeof buildFakeEnqueuer>;

  beforeEach(async () => {
    fakeEnqueuer = buildFakeEnqueuer();
    app = await buildApp(fakeEnqueuer);
  });

  afterEach(async () => {
    await app.close();
  });

  it("does not call enqueuer on a route without @Auditable", async () => {
    await request(app.getHttpServer()).get("/test/public").expect(200);
    await flushAsync();

    expect(fakeEnqueuer.enqueue).not.toHaveBeenCalled();
  });

  it("returns the response body unmodified on a bare route", async () => {
    const res = await request(app.getHttpServer())
      .get("/test/public")
      .expect(200);

    expect(res.body).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// Stubs for remaining T230 categories (out of scope for this slice)
// ---------------------------------------------------------------------------

describe("AuditEmitterInterceptor — remaining T230 categories (stubs)", () => {
  it.todo(
    "auth.signin.ok — enqueues a job with action auth.signin.ok on successful authentication",
  );
  it.todo(
    "auth.signin.failed — enqueues a job with action auth.signin.failed on failed authentication",
  );
  it.todo(
    "role/access changes — enqueues a job on role assignment or membership status change",
  );
  it.todo(
    "soft-delete — enqueues a job on tenant, store, or user soft-delete",
  );
  it.todo(
    "platform-admin cross-tenant — enqueues a job when a platform admin operates outside their own tenant",
  );
});
