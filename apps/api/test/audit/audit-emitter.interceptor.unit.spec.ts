/**
 * audit-emitter.interceptor.unit.spec.ts
 *
 * Docker-free unit coverage for AuditEmitterInterceptor.
 *
 * Strategy: construct the interceptor directly (no Nest module).
 * Reflector, AuditJobEnqueuer, and Logger are all hand-crafted jest mocks.
 * Observable helpers from rxjs used: of(), throwError(), firstValueFrom().
 *
 * Design notes:
 *   - The interceptor uses `.pipe(tap({ next: ... }))` to emit an audit event
 *     after a successful response. The `emitAsync` call is launched but NOT
 *     awaited inside the tap callback — it is fire-and-forget with an internal
 *     .catch(). Because of this, assertions on enqueuer calls must wait a
 *     microtask/setImmediate flush after the observable settles.
 *   - Errors thrown by the enqueuer are caught internally and logged — they
 *     must NOT surface as HTTP errors (the Observable must still emit normally).
 *   - The logger is @Optional() — tests without a logger must not throw on
 *     enqueue rejection.
 *   - On a downstream handler error, the observable propagates the error
 *     directly (tap has no error arm), and the enqueuer is never called.
 *
 * Tests:
 *   AEI1  — action absent: passthrough, enqueuer not called
 *   AEI2  — action absent: value passes through unchanged
 *   AEI3  — action present + context present: enqueuer called with correct payload
 *   AEI4  — action present + context present: tenant/store from request.context
 *   AEI5  — action present + context absent + ContextResponseBody in response: derives tenant/store from body
 *   AEI6  — action present + context absent + non-matching response body: tenant_id/store_id null
 *   AEI7  — action present: request_id forwarded from request.requestId
 *   AEI8  — action present: request_id null when requestId absent
 *   AEI9  — action present: actor_user_id from request.principal.userId
 *   AEI10 — action present: actor_user_id null when principal absent
 *   AEI11 — enqueue rejection: logger.error called, Observable still emits normally
 *   AEI12 — enqueue rejection without logger: does not throw
 *   AEI13 — downstream handler error: Observable errors, enqueuer not called
 *   AEI14 — response value passes through tap unchanged
 *   AEI15 — actor_label is always null (hardcoded — no PII in label yet)
 *   AEI16 — target_type, target_id, metadata are always null in base interceptor
 */
import "reflect-metadata";

import { type CallHandler, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { of, throwError, firstValueFrom } from "rxjs";

import { AuditEmitterInterceptor } from "../../src/audit/audit-emitter.interceptor";
import { AUDITABLE_KEY } from "../../src/audit/auditable.decorator";
import { AUDIT_JOB_ENQUEUER, type AuditJobEnqueuer } from "../../src/audit/audit-job.enqueuer";
import type { AuditJobPayload } from "../../src/audit/audit-job.types";

// ---------------------------------------------------------------------------
// Fixed IDs
// ---------------------------------------------------------------------------

const TENANT_ID   = "0f000000-0000-7000-8000-000000000001";
const STORE_ID    = "0f000000-0000-7000-8000-000000000002";
const USER_ID     = "0f000000-0000-7000-8000-000000000003";
const REQUEST_ID  = "0f000000-0000-7000-8000-000000000004";
const ACTION      = "context.switch.tenant";

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

/**
 * Build an ExecutionContext that returns the given request from getRequest().
 */
function makeExecCtx(req: Record<string, unknown>, handler?: object): ExecutionContext {
  return {
    getHandler: () => handler ?? function namedHandler() { return; },
    switchToHttp: () => ({
      getRequest: <T>() => req as unknown as T,
    }),
  } as unknown as ExecutionContext;
}

function makeNext(value: unknown): CallHandler {
  return { handle: () => of(value) } as CallHandler;
}

function makeThrowingNext(err: unknown): CallHandler {
  return { handle: () => throwError(() => err) } as CallHandler;
}

/**
 * Build an interceptor with the given Reflector return value for AUDITABLE_KEY.
 * The enqueuer and optional logger can be provided; they default to jest.fn() stubs.
 */
function makeInterceptor(opts: {
  reflectorValue?: string | undefined;
  enqueuer?: AuditJobEnqueuer;
  logger?: { info: jest.Mock; error: jest.Mock };
  handlerRef?: object;
}): {
  interceptor: AuditEmitterInterceptor;
  reflector: Reflector;
  enqueuer: AuditJobEnqueuer & { enqueue: jest.Mock };
  logger?: { info: jest.Mock; error: jest.Mock } | undefined;
  handlerRef: object;
} {
  const handlerRef = opts.handlerRef ?? function namedHandler() { return; };
  const reflector = {
    get: jest.fn().mockReturnValue(opts.reflectorValue),
  } as unknown as Reflector;

  const enqueuer = (opts.enqueuer ?? {
    enqueue: jest.fn().mockResolvedValue(undefined),
  }) as AuditJobEnqueuer & { enqueue: jest.Mock };

  const logger = opts.logger;

  const interceptor = new AuditEmitterInterceptor(
    reflector,
    enqueuer,
    logger as never,
  );

  return { interceptor, reflector, enqueuer: enqueuer as AuditJobEnqueuer & { enqueue: jest.Mock }, logger, handlerRef };
}

/** Flush pending microtasks + setImmediate so async tap callbacks settle. */
async function flushAsync(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

// ---------------------------------------------------------------------------
// AEI1 — action absent: passthrough, enqueuer not called
// ---------------------------------------------------------------------------

describe("AEI1 — action absent: passthrough, enqueuer not called", () => {
  it("returns next.handle() directly and does not call enqueuer", async () => {
    const { interceptor, enqueuer, handlerRef } = makeInterceptor({ reflectorValue: undefined });
    const req = { principal: { kind: "session", userId: USER_ID } };
    const execCtx = makeExecCtx(req, handlerRef);
    const next = makeNext("some-value");

    const obs = interceptor.intercept(execCtx, next);
    await firstValueFrom(obs);
    await flushAsync();

    expect(enqueuer.enqueue).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// AEI2 — action absent: value passes through unchanged
// ---------------------------------------------------------------------------

describe("AEI2 — action absent: value passes through unchanged", () => {
  it("emits the upstream value without modification", async () => {
    const { interceptor, handlerRef } = makeInterceptor({ reflectorValue: undefined });
    const req = {};
    const execCtx = makeExecCtx(req, handlerRef);
    const payload = { tenant_id: TENANT_ID, active: true };
    const next = makeNext(payload);

    const result = await firstValueFrom(interceptor.intercept(execCtx, next));

    expect(result).toBe(payload);
  });
});

// ---------------------------------------------------------------------------
// AEI3 — action present + context present: enqueuer called
// ---------------------------------------------------------------------------

describe("AEI3 — action set + context present: enqueuer.enqueue called", () => {
  it("calls enqueuer.enqueue exactly once after successful response", async () => {
    const { interceptor, enqueuer, handlerRef } = makeInterceptor({ reflectorValue: ACTION });
    const req = {
      principal: { kind: "session", userId: USER_ID },
      context: { tenantId: TENANT_ID, storeId: STORE_ID },
      requestId: REQUEST_ID,
    };
    const execCtx = makeExecCtx(req, handlerRef);
    const next = makeNext({ success: true });

    await firstValueFrom(interceptor.intercept(execCtx, next));
    await flushAsync();

    expect(enqueuer.enqueue).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// AEI4 — action present + context present: tenant/store from request.context
// ---------------------------------------------------------------------------

describe("AEI4 — context present: tenant/store derived from request.context", () => {
  it("payload carries tenantId and storeId from request.context", async () => {
    const { interceptor, enqueuer, handlerRef } = makeInterceptor({ reflectorValue: ACTION });
    const req = {
      principal: { kind: "session", userId: USER_ID },
      context: { tenantId: TENANT_ID, storeId: STORE_ID },
      requestId: REQUEST_ID,
    };
    const execCtx = makeExecCtx(req, handlerRef);
    const next = makeNext({ ok: true });

    await firstValueFrom(interceptor.intercept(execCtx, next));
    await flushAsync();

    const payload = (enqueuer.enqueue as jest.Mock).mock.calls[0]![0] as AuditJobPayload;
    expect(payload.tenant_id).toBe(TENANT_ID);
    expect(payload.store_id).toBe(STORE_ID);
    expect(payload.action).toBe(ACTION);
  });
});

// ---------------------------------------------------------------------------
// AEI5 — context absent + ContextResponseBody: derives tenant/store from body
// ---------------------------------------------------------------------------

describe("AEI5 — context absent + ContextResponseBody response: tenant/store from body", () => {
  it("derives tenant_id and store_id from active_tenant/active_store in response body", async () => {
    const { interceptor, enqueuer, handlerRef } = makeInterceptor({ reflectorValue: ACTION });
    const req = {
      principal: { kind: "session", userId: USER_ID },
      // No request.context
      requestId: REQUEST_ID,
    };
    const execCtx = makeExecCtx(req, handlerRef);
    // Simulate a ContextController response body
    const responseBody = {
      active_tenant: { id: TENANT_ID },
      active_store: { id: STORE_ID },
    };
    const next = makeNext(responseBody);

    await firstValueFrom(interceptor.intercept(execCtx, next));
    await flushAsync();

    const payload = (enqueuer.enqueue as jest.Mock).mock.calls[0]![0] as AuditJobPayload;
    expect(payload.tenant_id).toBe(TENANT_ID);
    expect(payload.store_id).toBe(STORE_ID);
  });

  it("sets store_id null when active_store is absent from body", async () => {
    const { interceptor, enqueuer, handlerRef } = makeInterceptor({ reflectorValue: ACTION });
    const req = {
      principal: { kind: "session", userId: USER_ID },
      requestId: REQUEST_ID,
    };
    const execCtx = makeExecCtx(req, handlerRef);
    const responseBody = {
      active_tenant: { id: TENANT_ID },
      // no active_store
    };
    const next = makeNext(responseBody);

    await firstValueFrom(interceptor.intercept(execCtx, next));
    await flushAsync();

    const payload = (enqueuer.enqueue as jest.Mock).mock.calls[0]![0] as AuditJobPayload;
    expect(payload.tenant_id).toBe(TENANT_ID);
    expect(payload.store_id).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AEI6 — context absent + non-matching response body: tenant_id/store_id null
// ---------------------------------------------------------------------------

describe("AEI6 — context absent + non-ContextResponseBody: tenant/store are null", () => {
  it("sets tenant_id and store_id null when body is a plain object without active_tenant", async () => {
    const { interceptor, enqueuer, handlerRef } = makeInterceptor({ reflectorValue: ACTION });
    const req = {
      principal: { kind: "session", userId: USER_ID },
    };
    const execCtx = makeExecCtx(req, handlerRef);
    const next = makeNext({ some: "other", data: 123 });

    await firstValueFrom(interceptor.intercept(execCtx, next));
    await flushAsync();

    const payload = (enqueuer.enqueue as jest.Mock).mock.calls[0]![0] as AuditJobPayload;
    expect(payload.tenant_id).toBeNull();
    expect(payload.store_id).toBeNull();
  });

  it("sets tenant_id and store_id null when response body is null", async () => {
    const { interceptor, enqueuer, handlerRef } = makeInterceptor({ reflectorValue: ACTION });
    const req = {
      principal: { kind: "session", userId: USER_ID },
    };
    const execCtx = makeExecCtx(req, handlerRef);
    const next = makeNext(null);

    await firstValueFrom(interceptor.intercept(execCtx, next));
    await flushAsync();

    const payload = (enqueuer.enqueue as jest.Mock).mock.calls[0]![0] as AuditJobPayload;
    expect(payload.tenant_id).toBeNull();
    expect(payload.store_id).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AEI7 — action present: request_id forwarded from request.requestId
// ---------------------------------------------------------------------------

describe("AEI7 — request_id forwarded from request.requestId", () => {
  it("payload.request_id equals request.requestId", async () => {
    const { interceptor, enqueuer, handlerRef } = makeInterceptor({ reflectorValue: ACTION });
    const req = {
      principal: { kind: "session", userId: USER_ID },
      context: { tenantId: TENANT_ID, storeId: null },
      requestId: REQUEST_ID,
    };
    const execCtx = makeExecCtx(req, handlerRef);
    const next = makeNext({});

    await firstValueFrom(interceptor.intercept(execCtx, next));
    await flushAsync();

    const payload = (enqueuer.enqueue as jest.Mock).mock.calls[0]![0] as AuditJobPayload;
    expect(payload.request_id).toBe(REQUEST_ID);
  });
});

// ---------------------------------------------------------------------------
// AEI8 — action present: request_id null when requestId absent
// ---------------------------------------------------------------------------

describe("AEI8 — request_id null when request.requestId absent", () => {
  it("payload.request_id is null when requestId not on request", async () => {
    const { interceptor, enqueuer, handlerRef } = makeInterceptor({ reflectorValue: ACTION });
    const req = {
      principal: { kind: "session", userId: USER_ID },
      context: { tenantId: TENANT_ID, storeId: null },
      // no requestId
    };
    const execCtx = makeExecCtx(req, handlerRef);
    const next = makeNext({});

    await firstValueFrom(interceptor.intercept(execCtx, next));
    await flushAsync();

    const payload = (enqueuer.enqueue as jest.Mock).mock.calls[0]![0] as AuditJobPayload;
    expect(payload.request_id).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AEI9 — actor_user_id from request.principal.userId
// ---------------------------------------------------------------------------

describe("AEI9 — actor_user_id from request.principal.userId", () => {
  it("payload.actor_user_id equals principal.userId", async () => {
    const { interceptor, enqueuer, handlerRef } = makeInterceptor({ reflectorValue: ACTION });
    const req = {
      principal: { kind: "session", userId: USER_ID },
      context: { tenantId: TENANT_ID, storeId: null },
    };
    const execCtx = makeExecCtx(req, handlerRef);
    const next = makeNext({});

    await firstValueFrom(interceptor.intercept(execCtx, next));
    await flushAsync();

    const payload = (enqueuer.enqueue as jest.Mock).mock.calls[0]![0] as AuditJobPayload;
    expect(payload.actor_user_id).toBe(USER_ID);
  });
});

// ---------------------------------------------------------------------------
// AEI10 — actor_user_id null when principal absent
// ---------------------------------------------------------------------------

describe("AEI10 — actor_user_id null when principal absent", () => {
  it("payload.actor_user_id is null when request has no principal", async () => {
    const { interceptor, enqueuer, handlerRef } = makeInterceptor({ reflectorValue: ACTION });
    const req = {
      // no principal
      context: { tenantId: TENANT_ID, storeId: null },
    };
    const execCtx = makeExecCtx(req, handlerRef);
    const next = makeNext({});

    await firstValueFrom(interceptor.intercept(execCtx, next));
    await flushAsync();

    const payload = (enqueuer.enqueue as jest.Mock).mock.calls[0]![0] as AuditJobPayload;
    expect(payload.actor_user_id).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AEI11 — enqueue rejection: logger.error called, Observable emits normally
// ---------------------------------------------------------------------------

describe("AEI11 — enqueue rejection: logger.error called, Observable still emits", () => {
  it("emits the response value even when enqueuer throws, and logs the error", async () => {
    const enqueueError = new Error("queue full");
    const failingEnqueuer: AuditJobEnqueuer & { enqueue: jest.Mock } = {
      enqueue: jest.fn().mockRejectedValue(enqueueError),
    };
    const logger = { info: jest.fn(), error: jest.fn() };
    const { interceptor, handlerRef } = makeInterceptor({
      reflectorValue: ACTION,
      enqueuer: failingEnqueuer,
      logger,
    });
    const req = {
      principal: { kind: "session", userId: USER_ID },
      context: { tenantId: TENANT_ID, storeId: null },
    };
    const execCtx = makeExecCtx(req, handlerRef);
    const responseValue = { data: "ok" };
    const next = makeNext(responseValue);

    // Observable MUST emit successfully even though enqueuer rejected
    const result = await firstValueFrom(interceptor.intercept(execCtx, next));
    await flushAsync();

    expect(result).toBe(responseValue);
    expect(logger.error).toHaveBeenCalledTimes(1);
    const [logObj, msg] = logger.error.mock.calls[0] as [Record<string, unknown>, string];
    expect(msg).toBe("AuditEmitter: enqueue failed");
    // RT-124: action + error class only — no raw error, no payload fields.
    expect(logObj).toEqual({
      component: "audit.emitter",
      action: ACTION,
      request_id: null,
      err_class: "Error",
    });
    expect(JSON.stringify(logObj)).not.toContain(USER_ID);
    expect(JSON.stringify(logObj)).not.toContain("queue full");
  });
});

// ---------------------------------------------------------------------------
// AEI12 — enqueue rejection without logger: does not throw
// ---------------------------------------------------------------------------

describe("AEI12 — enqueue rejection without logger: no throw", () => {
  it("swallows the rejection silently when no logger is injected", async () => {
    const failingEnqueuer: AuditJobEnqueuer & { enqueue: jest.Mock } = {
      enqueue: jest.fn().mockRejectedValue(new Error("network timeout")),
    };
    const { interceptor, handlerRef } = makeInterceptor({
      reflectorValue: ACTION,
      enqueuer: failingEnqueuer,
      // no logger
    });
    const req = {
      principal: { kind: "session", userId: USER_ID },
      context: { tenantId: TENANT_ID, storeId: null },
    };
    const execCtx = makeExecCtx(req, handlerRef);
    const next = makeNext({ ok: true });

    // Must not throw
    await expect(
      firstValueFrom(interceptor.intercept(execCtx, next)).then(flushAsync),
    ).resolves.not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// AEI13 — downstream handler error: Observable errors, enqueuer not called
// ---------------------------------------------------------------------------

describe("AEI13 — downstream handler error: propagates, enqueuer not called", () => {
  it("re-emits the handler error and does not call enqueuer", async () => {
    const { interceptor, enqueuer, handlerRef } = makeInterceptor({ reflectorValue: ACTION });
    const handlerError = new Error("handler exploded");
    const req = {
      principal: { kind: "session", userId: USER_ID },
      context: { tenantId: TENANT_ID, storeId: null },
    };
    const execCtx = makeExecCtx(req, handlerRef);
    const next = makeThrowingNext(handlerError);

    await expect(firstValueFrom(interceptor.intercept(execCtx, next))).rejects.toBe(handlerError);
    await flushAsync();

    expect(enqueuer.enqueue).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// AEI14 — response value passes through tap unchanged
// ---------------------------------------------------------------------------

describe("AEI14 — response value passes through tap unchanged", () => {
  it("emits exactly the same object returned by next.handle()", async () => {
    const { interceptor, handlerRef } = makeInterceptor({ reflectorValue: ACTION });
    const req = {
      principal: { kind: "session", userId: USER_ID },
      context: { tenantId: TENANT_ID, storeId: null },
    };
    const execCtx = makeExecCtx(req, handlerRef);
    const originalResponse = { items: [{ id: "1" }], next_cursor: null };
    const next = makeNext(originalResponse);

    const result = await firstValueFrom(interceptor.intercept(execCtx, next));

    expect(result).toBe(originalResponse);
  });
});

// ---------------------------------------------------------------------------
// AEI15 — actor_label is always null
// ---------------------------------------------------------------------------

describe("AEI15 — actor_label is always null", () => {
  it("payload.actor_label is null (no PII label in base interceptor)", async () => {
    const { interceptor, enqueuer, handlerRef } = makeInterceptor({ reflectorValue: ACTION });
    const req = {
      principal: { kind: "session", userId: USER_ID },
      context: { tenantId: TENANT_ID, storeId: null },
    };
    const execCtx = makeExecCtx(req, handlerRef);
    const next = makeNext({});

    await firstValueFrom(interceptor.intercept(execCtx, next));
    await flushAsync();

    const payload = (enqueuer.enqueue as jest.Mock).mock.calls[0]![0] as AuditJobPayload;
    expect(payload.actor_label).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AEI16 — target_type, target_id, metadata are always null
// ---------------------------------------------------------------------------

describe("AEI16 — target_type, target_id, metadata always null in base interceptor", () => {
  it("payload carries null for target_type, target_id, and metadata", async () => {
    const { interceptor, enqueuer, handlerRef } = makeInterceptor({ reflectorValue: ACTION });
    const req = {
      principal: { kind: "session", userId: USER_ID },
      context: { tenantId: TENANT_ID, storeId: null },
    };
    const execCtx = makeExecCtx(req, handlerRef);
    const next = makeNext({ result: "ok" });

    await firstValueFrom(interceptor.intercept(execCtx, next));
    await flushAsync();

    const payload = (enqueuer.enqueue as jest.Mock).mock.calls[0]![0] as AuditJobPayload;
    expect(payload.target_type).toBeNull();
    expect(payload.target_id).toBeNull();
    expect(payload.metadata).toBeNull();
  });
});
