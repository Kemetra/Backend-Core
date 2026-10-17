/**
 * The real `IdempotencyInterceptor` over an in-memory Redis stand-in, for HTTP
 * specs that exercise `@Idempotent("required")` routes (the RT-418 pattern).
 *
 * `.ts` (not `.spec.ts`) so Jest does not collect it.
 */
import type { Provider } from "@nestjs/common";
import { APP_INTERCEPTOR, Reflector } from "@nestjs/core";

import { IdempotencyKeyStore } from "@data-pulse-2/shared";

import { IDEMPOTENCY_KEY_STORE, IdempotencyInterceptor } from "../../src/idempotency/idempotency.interceptor";
import type { InProgressMarker } from "../../src/idempotency/in-progress-marker";

class FakeRedis {
  private readonly store = new Map<string, { value: string; expiresAt: number }>();
  get(key: string): Promise<string | null> {
    const e = this.store.get(key);
    return Promise.resolve(!e || Date.now() > e.expiresAt ? null : e.value);
  }
  set(key: string, value: string, options: { px: number }): Promise<unknown> {
    this.store.set(key, { value, expiresAt: Date.now() + options.px });
    return Promise.resolve("OK");
  }
}

class FakeMarker {
  trySet(): Promise<boolean> {
    return Promise.resolve(true);
  }
  async del(): Promise<void> {
    /* no-op */
  }
}

export function idempotencyProviders(): Provider[] {
  const store = new IdempotencyKeyStore({
    redis: new FakeRedis(),
    pgWriter: { async insert() {} },
    pgReader: {
      find: () => Promise.resolve(null),
    },
    defaultTtlMs: 72 * 60 * 60 * 1000,
  });
  const interceptor = new IdempotencyInterceptor(new Reflector(), store, new FakeMarker() as unknown as InProgressMarker);
  return [
    { provide: IDEMPOTENCY_KEY_STORE, useValue: store },
    { provide: APP_INTERCEPTOR, useValue: interceptor },
  ];
}
