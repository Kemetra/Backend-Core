/**
 * IdempotencyModule — T520/T522/T525.
 *
 * Registers the idempotency stack as a DI-managed global interceptor:
 *
 *   1. IDEMPOTENCY_KEY_STORE — IdempotencyKeyStore with 72h TTL override.
 *      Backed by REDIS_CLIENT from AuthModule (single Redis connection).
 *      Postgres mirror: null no-op in this slice; a future slice wires
 *      the Drizzle writer.
 *
 *   2. InProgressMarker — Redis-backed SET NX EX 60 in-flight marker.
 *      Also backed by REDIS_CLIENT from AuthModule.
 *
 *   3. IdempotencyInterceptor — registered via APP_INTERCEPTOR (global,
 *      DI-managed). This mirrors AuditModule's APP_INTERCEPTOR pattern:
 *        - The interceptor has DI dependencies (Reflector, key store, marker).
 *        - Integration tests can override providers via overrideProvider —
 *          that only functions when the interceptor is DI-managed.
 *        - @UseInterceptors(ClassName) on the controller would bind the token
 *          to the controller's DI context and cascade into every test module
 *          that mounts InvitationsController — causing test failures in modules
 *          that do not provide IdempotencyInterceptor's dependencies.
 *
 * Redis:
 *   AuthModule now exports REDIS_CLIENT. When REDIS_URL is set, REDIS_CLIENT
 *   is a real ioredis instance with get/set/del. When absent, it falls back to
 *   AlwaysAllowRedis (no-op stubs) so dev / CI machines without Redis still boot.
 *   IdempotencyModule imports AuthModule and injects REDIS_CLIENT for both
 *   IDEMPOTENCY_KEY_STORE and InProgressMarker — one connection, no second client.
 *
 * TTL (T525): 72h override on IdempotencyKeyStore.defaultTtlMs.
 *   No schema change — only a runtime config change.
 */
import { Module, type Provider } from "@nestjs/common";
import { APP_INTERCEPTOR, Reflector } from "@nestjs/core";

import { createLogger, IdempotencyKeyStore, type Logger } from "@data-pulse-2/shared";
import type {
  PgMirrorReader,
  PgMirrorWriter,
  RedisLike as StoreRedisLike,
} from "@data-pulse-2/shared";

import { AUDIT_JOB_ENQUEUER, type AuditJobEnqueuer } from "../audit/audit-job.enqueuer";
import { OutboxAuditEnqueuerModule } from "../audit/outbox-audit-enqueuer.module";
import { AuthModule, REDIS_CLIENT } from "../auth/auth.module";
import { ROOT_LOGGER } from "../common/logging.interceptor";
import { INFLIGHT_REDIS, InProgressMarker, type InflightRedis } from "./in-progress-marker";
import {
  IDEMPOTENCY_KEY_STORE,
  IdempotencyInterceptor,
} from "./idempotency.interceptor";

// ---------------------------------------------------------------------------
// Null Postgres mirror — no-op for this slice
// ---------------------------------------------------------------------------
class NullPgMirrorWriter implements PgMirrorWriter {
  async insert(): Promise<void> { /* no-op */ }
}

class NullPgMirrorReader implements PgMirrorReader {
  async find(): Promise<null> { return null; }
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

const inflightRedisProvider: Provider = {
  provide: INFLIGHT_REDIS,
  // Reuse REDIS_CLIENT from AuthModule — single ioredis connection.
  // The ioredis client satisfies both InflightRedis (set NX EX, del) and
  // StoreRedisLike (get, set PX) surfaces.
  useFactory: (redis: InflightRedis): InflightRedis => redis,
  inject: [REDIS_CLIENT],
};

const idempotencyKeyStoreProvider: Provider = {
  provide: IDEMPOTENCY_KEY_STORE,
  useFactory: (redis: StoreRedisLike): IdempotencyKeyStore =>
    new IdempotencyKeyStore({
      redis,
      pgWriter: new NullPgMirrorWriter(),
      pgReader: new NullPgMirrorReader(),
      defaultTtlMs: 72 * 60 * 60 * 1000, // 72h override (T525)
    }),
  inject: [REDIS_CLIENT],
};

const inProgressMarkerProvider: Provider = {
  provide: InProgressMarker,
  useFactory: (redis: InflightRedis): InProgressMarker =>
    new InProgressMarker(redis),
  inject: [INFLIGHT_REDIS],
};

/**
 * APP_INTERCEPTOR — global, DI-managed (mirrors AuditModule pattern).
 * The interceptor is inactive on routes that lack @Idempotent metadata —
 * it short-circuits via Reflector.get() and calls next.handle() immediately.
 */
const idempotencyInterceptorProvider: Provider = {
  provide: APP_INTERCEPTOR,
  useFactory: (
    reflector: Reflector,
    store: IdempotencyKeyStore,
    marker: InProgressMarker,
    auditEnqueuer: AuditJobEnqueuer,
    logger: Logger,
  ): IdempotencyInterceptor =>
    new IdempotencyInterceptor(reflector, store, marker, auditEnqueuer, logger),
  inject: [Reflector, IDEMPOTENCY_KEY_STORE, InProgressMarker, AUDIT_JOB_ENQUEUER, ROOT_LOGGER],
};

@Module({
  imports: [AuthModule, OutboxAuditEnqueuerModule],
  providers: [
    {
      provide: ROOT_LOGGER,
      useFactory: (): Logger => createLogger({
        service: "api.idempotency",
        level: process.env["LOG_LEVEL"] ?? "info",
      }),
    },
    inflightRedisProvider,
    idempotencyKeyStoreProvider,
    inProgressMarkerProvider,
    idempotencyInterceptorProvider,
  ],
  exports: [
    InProgressMarker,
    IDEMPOTENCY_KEY_STORE,
    INFLIGHT_REDIS,
  ],
})
export class IdempotencyModule {}
