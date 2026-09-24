import "reflect-metadata";

import { type CallHandler, type ExecutionContext } from "@nestjs/common";
import { APP_INTERCEPTOR, Reflector } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { firstValueFrom, of } from "rxjs";

import { IdempotencyKeyStore, type Logger } from "@data-pulse-2/shared";

import { AUDIT_JOB_ENQUEUER, type AuditJobEnqueuer } from "../../src/audit/audit-job.enqueuer";
import { PG_POOL, REDIS_CLIENT } from "../../src/auth/auth.module";
import { ROOT_LOGGER } from "../../src/common/logging.interceptor";
import { IDEMPOTENT_POLICY_KEY } from "../../src/idempotency/idempotent.decorator";
import { IdempotencyInterceptor, IDEMPOTENCY_KEY_STORE } from "../../src/idempotency/idempotency.interceptor";
import { IdempotencyModule } from "../../src/idempotency/idempotency.module";
import { InProgressMarker } from "../../src/idempotency/in-progress-marker";

const KEY = "secret-idempotency-key-123456";
const PATH = "/api/pos/v1/catalog/unknown-items";
const handler = () => undefined;
Reflect.defineMetadata(IDEMPOTENT_POLICY_KEY, "required", handler);

type InterceptorProvider = {
  provide: unknown;
  inject: unknown[];
  useFactory: (
    reflector: Reflector,
    store: IdempotencyKeyStore,
    marker: InProgressMarker,
    auditEnqueuer: AuditJobEnqueuer,
    logger: Logger,
  ) => IdempotencyInterceptor;
};

function productionProvider(): InterceptorProvider {
  const providers = Reflect.getMetadata("providers", IdempotencyModule) as InterceptorProvider[];
  const provider = providers.find((item) => item.provide === APP_INTERCEPTOR);
  if (!provider) throw new Error("IdempotencyModule has no APP_INTERCEPTOR");
  return provider;
}

function context() {
  const req = {
    method: "POST",
    route: { path: PATH },
    url: PATH,
    headers: { "idempotency-key": KEY },
    body: { identifier_type: "barcode", identifier_value: "X" },
    principal: { userId: "user-1" },
    context: { tenantId: "tenant-1", storeId: "store-1" },
    requestId: "request-1",
  };
  const res = { statusCode: 201 };
  return {
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
    getHandler: () => handler,
  } as unknown as ExecutionContext;
}

describe("production idempotency interceptor wiring", () => {
  const marker = {
    trySet: jest.fn(async () => true),
    del: jest.fn(async () => undefined),
  } as unknown as InProgressMarker;
  const enqueue = jest.fn(async () => undefined);
  const enqueuer = { enqueue } as AuditJobEnqueuer;
  const warn = jest.fn();
  const logger = { warn, error: jest.fn() } as unknown as Logger;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("injects the audit enqueuer and logger through the production factory", () => {
    expect(productionProvider().inject).toEqual([
      Reflector, IDEMPOTENCY_KEY_STORE, InProgressMarker, AUDIT_JOB_ENQUEUER, ROOT_LOGGER,
    ]);
  });

  it("resolves the production dependency graph", async () => {
    const redis = { get: jest.fn(async () => null), set: jest.fn(async () => "OK"), del: jest.fn(async () => 1) };
    const moduleRef = await Test.createTestingModule({ imports: [IdempotencyModule] })
      .overrideProvider(PG_POOL).useValue({})
      .overrideProvider(REDIS_CLIENT).useValue(redis)
      .overrideProvider(AUDIT_JOB_ENQUEUER).useValue(enqueuer)
      .compile();
    await moduleRef.close();
  });

  it("enqueues the capture collision audit through the production factory", async () => {
    const store = { findOrCreate: jest.fn(async () => ({ hit: "collision" })) } as unknown as IdempotencyKeyStore;
    const interceptor = productionProvider().useFactory(new Reflector(), store, marker, enqueuer, logger);
    await expect(firstValueFrom(interceptor.intercept(context(), { handle: () => of({}) } as CallHandler)))
      .rejects.toMatchObject({ status: 409 });
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
      action: "unknown_item.idempotency_mismatch_rejected",
      tenant_id: "tenant-1",
      store_id: "store-1",
    }));
  });

  it("warns on replay-save failure without logging the raw key", async () => {
    const store = {
      findOrCreate: jest.fn(async () => ({ hit: false })),
      save: jest.fn(async () => { throw new Error("redis unavailable"); }),
    } as unknown as IdempotencyKeyStore;
    const interceptor = productionProvider().useFactory(new Reflector(), store, marker, enqueuer, logger);
    await firstValueFrom(interceptor.intercept(context(), { handle: () => of({ ok: true }) } as CallHandler));
    for (let i = 0; i < 20 && warn.mock.calls.length === 0; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(KEY);
  });
});
