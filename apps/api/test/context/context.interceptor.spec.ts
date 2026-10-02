/**
 * T155 — ContextInterceptor spec.
 *
 * Pure unit-level. The interceptor's job is to bridge `request.context`
 * (populated by `TenantContextGuard`, PR #19) into the ALS scope so
 * deep code paths can read it via `getResolvedContext()`.
 *
 * No Postgres, no Redis, no Nest DI; we instantiate the interceptor
 * directly and feed it fake `ExecutionContext` / `CallHandler` shims
 * (same pattern as PR #19's `tenant-context.guard.spec.ts`).
 *
 * Coverage:
 *   - request with `context` populated → ALS entered → handler reads
 *     the same ctx via `getResolvedContext`
 *   - request without `context` → no-op pass-through; handler reads
 *     `undefined`
 *   - errors thrown by the handler propagate; ALS tears down
 *   - asynchronous errors (rejected Promise) propagate; ALS tears
 *     down
 *   - concurrent intercepts with different contexts are isolated
 *   - the interceptor invokes `next.handle()` exactly once
 */
import {
  type CallHandler,
  type ExecutionContext,
} from "@nestjs/common";
import { firstValueFrom, of, throwError, defer } from "rxjs";
import type { Observable } from "rxjs";
import { ContextInterceptor } from "../../src/context/context.interceptor";
import {
  getResolvedContext,
} from "../../src/context/context.als";
import type {
  ResolvedContext,
  TenantContextRequest,
} from "../../src/context/types";

const CTX_A: ResolvedContext = {
  userId: "00000000-0000-7000-8000-00000000aa01",
  tenantId: "00000000-0000-7000-8000-0000000ten01",
  storeId: null,
  isPlatformAdmin: false,
  source: "session",
};

const CTX_B: ResolvedContext = {
  userId: "00000000-0000-7000-8000-00000000bb02",
  tenantId: "00000000-0000-7000-8000-0000000ten02",
  storeId: "00000000-0000-7000-8000-0000000sto02",
  isPlatformAdmin: false,
  source: "token",
};

function makeRequest(ctx: ResolvedContext | undefined): TenantContextRequest {
  const r: Partial<TenantContextRequest> = {};
  if (ctx) r.context = ctx;
  return r as TenantContextRequest;
}

function makeExecCtx(request: TenantContextRequest): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: <T>() => request as unknown as T,
      getResponse: <T>() => ({}) as T,
      getNext: <T>() => ({}) as T,
    }),
  } as unknown as ExecutionContext;
}

function makeNext(handler: () => Observable<unknown>): CallHandler {
  let calls = 0;
  return {
    handle(): Observable<unknown> {
      calls += 1;
      // Expose call count via a side-channel on the function.
      // Tests read it through `(next as any).__calls`.
      return handler();
    },
    get __calls(): number {
      return calls;
    },
  } as CallHandler & { readonly __calls: number };
}

let interceptor: ContextInterceptor;

beforeEach(() => {
  interceptor = new ContextInterceptor();
});

afterEach(() => {
  // Verify no test leaked an ALS scope across the suite boundary.
  expect(getResolvedContext()).toBeUndefined();
});

describe("ContextInterceptor — request with context populated", () => {
  it("makes the ctx visible inside the handler via getResolvedContext()", async () => {
    const request = makeRequest(CTX_A);
    const next = makeNext(() => defer(() => of(getResolvedContext())));

    const result = await firstValueFrom(
      interceptor.intercept(makeExecCtx(request), next),
    );

    expect(result).toBe(CTX_A);
  });

  it("propagates the handler's value through the Observable", async () => {
    const request = makeRequest(CTX_A);
    const next = makeNext(() => of("payload"));
    const out = await firstValueFrom(
      interceptor.intercept(makeExecCtx(request), next),
    );
    expect(out).toBe("payload");
  });

  it("invokes next.handle() exactly once", async () => {
    const request = makeRequest(CTX_A);
    const next = makeNext(() => of("ok"));
    await firstValueFrom(interceptor.intercept(makeExecCtx(request), next));
    expect((next as unknown as { __calls: number }).__calls).toBe(1);
  });

  it("preserves the ctx across awaits inside the handler", async () => {
    const request = makeRequest(CTX_A);
    const next = makeNext(() =>
      defer(async () => {
        const before = getResolvedContext();
        await new Promise((r) => setImmediate(r));
        const after = getResolvedContext();
        return { before, after };
      }),
    );

    const result = (await firstValueFrom(
      interceptor.intercept(makeExecCtx(request), next),
    )) as { before: ResolvedContext; after: ResolvedContext };

    expect(result.before).toBe(CTX_A);
    expect(result.after).toBe(CTX_A);
  });

  it("tears the ALS scope down after the handler resolves", async () => {
    const request = makeRequest(CTX_A);
    const next = makeNext(() => of("ok"));
    await firstValueFrom(interceptor.intercept(makeExecCtx(request), next));
    expect(getResolvedContext()).toBeUndefined();
  });
});

describe("ContextInterceptor — request without context", () => {
  it("does NOT enter an ALS scope (handler sees undefined)", async () => {
    const request = makeRequest(undefined);
    const next = makeNext(() => of(getResolvedContext()));

    const result = await firstValueFrom(
      interceptor.intercept(makeExecCtx(request), next),
    );

    expect(result).toBeUndefined();
  });

  it("passes the handler's Observable through unchanged", async () => {
    const request = makeRequest(undefined);
    const next = makeNext(() => of("untouched"));
    const out = await firstValueFrom(
      interceptor.intercept(makeExecCtx(request), next),
    );
    expect(out).toBe("untouched");
  });
});

describe("ContextInterceptor — error propagation", () => {
  it("propagates synchronous handler errors and tears down the ALS scope", async () => {
    const request = makeRequest(CTX_A);
    const next = makeNext(() => throwError(() => new Error("sync-boom")));

    await expect(
      firstValueFrom(interceptor.intercept(makeExecCtx(request), next)),
    ).rejects.toThrow("sync-boom");
    expect(getResolvedContext()).toBeUndefined();
  });

  it("propagates asynchronous handler errors and tears down the ALS scope", async () => {
    const request = makeRequest(CTX_A);
    const next = makeNext(() =>
      defer(async () => {
        await Promise.resolve();
        throw new Error("async-boom");
      }),
    );

    await expect(
      firstValueFrom(interceptor.intercept(makeExecCtx(request), next)),
    ).rejects.toThrow("async-boom");
    expect(getResolvedContext()).toBeUndefined();
  });
});

describe("ContextInterceptor — concurrent isolation", () => {
  it("two concurrent intercepts never see each other's ctx", async () => {
    const seenA: Array<ResolvedContext | undefined> = [];
    const seenB: Array<ResolvedContext | undefined> = [];

    const requestA = makeRequest(CTX_A);
    const requestB = makeRequest(CTX_B);

    const nextA = makeNext(() =>
      defer(async () => {
        seenA.push(getResolvedContext());
        await new Promise((r) => setImmediate(r));
        seenA.push(getResolvedContext());
        return "A";
      }),
    );
    const nextB = makeNext(() =>
      defer(async () => {
        await new Promise((r) => setImmediate(r));
        seenB.push(getResolvedContext());
        await Promise.resolve();
        seenB.push(getResolvedContext());
        return "B";
      }),
    );

    const [a, b] = await Promise.all([
      firstValueFrom(interceptor.intercept(makeExecCtx(requestA), nextA)),
      firstValueFrom(interceptor.intercept(makeExecCtx(requestB), nextB)),
    ]);

    expect(a).toBe("A");
    expect(b).toBe("B");
    expect(seenA.every((c) => c === CTX_A)).toBe(true);
    expect(seenB.every((c) => c === CTX_B)).toBe(true);
    expect(seenA).toHaveLength(2);
    expect(seenB).toHaveLength(2);
  });
});
