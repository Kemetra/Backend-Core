/**
 * AuthModule — slice 3c.
 *
 * Wires AuthController and its dependency graph:
 *
 *   AuthController
 *     ├─ AuthService
 *     │    ├─ Pool          (PG_POOL token)
 *     │    ├─ SessionRepository
 *     │    ├─ AuthTokenRepository
 *     │    └─ EmailJobEnqueuer (NoOpEmailJobEnqueuer until T112/T113)
 *     ├─ AuthGuard
 *     │    ├─ SessionRepository
 *     │    └─ AuthTokenRepository
 *     └─ RateLimiter
 *          └─ RedisLike      (REDIS_CLIENT — see notes below)
 *
 * Production wiring per slice (current state):
 *
 *   - REDIS_CLIENT — still defaults to `AlwaysAllowRedis`, an in-process
 *     stub whose `incr` always returns 1; rate limits NEVER trigger
 *     until a later slice provides an ioredis-backed implementation.
 *     The class name is deliberately blunt so anyone reading the wiring
 *     graph in code review will catch that production needs an override.
 *
 *   - EMAIL_JOB_ENQUEUER — slice 4 (T112/T113) wires the BullMQ-backed
 *     `EmailQueueProducer` when `REDIS_URL` is set. In production with
 *     `REDIS_URL` missing the factory throws (silently swallowing
 *     password-reset / email-verify jobs is a safety hazard); in dev /
 *     test it falls back to `NoOpEmailJobEnqueuer` so machines without
 *     Redis still boot. The matching email worker / processor lives in
 *     `apps/worker` and lands in T114/T115.
 *
 * Tests substitute working fakes for both seams via
 * `Test.createTestingModule(...).overrideProvider(...)`.
 */
import { Module } from "@nestjs/common";
import { Queue, type JobsOptions } from "bullmq";
import { Pool } from "pg";
import Redis from "ioredis";

import {
  AUTH_LOOKUP_POOL,
  DatabasePoolBoundaryVerifier,
  DatabasePoolLifecycle,
  PG_POOL,
  authLookupPoolFactory,
  domainPoolFactory,
} from "./database-pools";

import { DEFAULT_JOB_OPTIONS } from "@data-pulse-2/shared/queues/queue-config";

import { AuditEnqueuerModule } from "../audit/audit-enqueuer.module";
import {
  AUDIT_JOB_ENQUEUER,
  type AuditJobEnqueuer,
} from "../audit/audit-job.enqueuer";

import { AuthController } from "./auth.controller";
import { AuthGuard } from "./auth.guard";
import { DashboardAuthGuard } from "./dashboard-auth.guard";
import { PosOperatorAuthGuard } from "./pos-operator-auth.guard";
import { AuthService } from "./auth.service";
import { AuthTokenRepository } from "./auth-token.repository";
import {
  EMAIL_JOB_ENQUEUER,
  type EmailJobEnqueuer,
  NoOpEmailJobEnqueuer,
} from "./email-job.enqueuer";
import { EmailQueueProducer } from "./email-queue.producer";
import { IoredisIdempotencyAdapter } from "./ioredis-idempotency-adapter";
import { RateLimiter, type RedisLike } from "./rate-limit";
import { SessionRepository } from "./session.repository";

/** Name of the BullMQ queue both the producer and the (future) worker bind to. */
export const EMAIL_QUEUE_NAME = "email";

/**
 * Factory for the `REDIS_CLIENT` provider. Extracted so a focused unit test
 * can verify the factory returns an `IoredisIdempotencyAdapter` when
 * `REDIS_URL` is set, mirroring the symmetric extraction of
 * `emailJobEnqueuerFactory` for BullMQ wiring verification.
 *
 * Production wiring policy:
 *   - `REDIS_URL` missing → return `AlwaysAllowRedis` stub (no-op; rate
 *     limits never trigger; idempotency storage disabled).
 *   - `REDIS_URL` set → wrap a real ioredis client in
 *     `IoredisIdempotencyAdapter` so that the options-object set() calls
 *     used by IdempotencyModule and the pexpireNx() call used by
 *     RateLimiter are translated to ioredis's variadic-string form.
 */
export function redisClientFactory(): RedisLike {
  const url = process.env["REDIS_URL"];
  if (!url) {
    if (process.env["NODE_ENV"] === "production") {
      throw new Error(
        "AuthModule: REDIS_URL is required in production " +
          "(rate limiting + idempotency disabled without it).",
      );
    }
    return new AlwaysAllowRedis();
  }
  // Wrap the real ioredis client in IoredisIdempotencyAdapter, which
  // translates the options-object set() and pexpireNx() calls used by
  // IdempotencyModule and RateLimiter into ioredis's variadic-string form.
  const client = new Redis(url);
  return new IoredisIdempotencyAdapter(client);
}

export { AUTH_LOOKUP_POOL, PG_POOL } from "./database-pools";
export const REDIS_CLIENT = "REDIS_CLIENT";

/**
 * Factory for the `EMAIL_JOB_ENQUEUER` provider. Extracted so a
 * focused unit test can verify the BullMQ `Queue` is constructed with
 * `defaultJobOptions: DEFAULT_JOB_OPTIONS` (T301-partial wiring),
 * mirroring the symmetric extraction `workerFactoryProviderFactory`
 * on the worker side.
 *
 * Lazy-init contract
 * ------------------
 * The factory returns the producer WITHOUT constructing the underlying
 * BullMQ `Queue`. Construction happens on first `enqueuePasswordReset` /
 * `enqueueEmailVerification` / `enqueueInvitation` call (see
 * `EmailQueueProducer`'s lazy-mode constructor + `ensureQueue()`).
 * This means an `overrideProvider(EMAIL_JOB_ENQUEUER).useValue(spy)`
 * orphans the factory-returned producer cleanly -- with eager
 * construction the orphaned producer kept its BullMQ Queue alive and
 * Jest reported "worker process has failed to exit gracefully" at
 * suite teardown (PR #240 db-integration leak). See the full rationale
 * on `auditJobEnqueuerFactory` in `audit-enqueuer.module.ts`.
 *
 * Production wiring policy:
 *   - `NODE_ENV=production` + `REDIS_URL` missing → throw at boot.
 *     Silently dropping password-reset / email-verify jobs is a
 *     safety hazard.
 *   - non-production + `REDIS_URL` missing → fall back to
 *     `NoOpEmailJobEnqueuer` so dev / CI machines without Redis still
 *     boot.
 *   - `REDIS_URL` set → return an `EmailQueueProducer` whose lazy
 *     thunk will build the `Queue` with the shared default job
 *     options on first enqueue.
 */
export function emailJobEnqueuerFactory(): EmailJobEnqueuer {
  const url = process.env["REDIS_URL"];
  if (!url) {
    if (process.env["NODE_ENV"] === "production") {
      throw new Error(
        "AuthModule: REDIS_URL is required in production " +
          "(EmailQueueProducer cannot be wired without it).",
      );
    }
    return new NoOpEmailJobEnqueuer();
  }
  // Defer Queue construction to first use. The thunk captures `url`
  // so production wiring is preserved at steady state.
  const provider = () =>
    new Queue(EMAIL_QUEUE_NAME, {
      connection: { url },
      defaultJobOptions: DEFAULT_JOB_OPTIONS as JobsOptions,
    });
  return new EmailQueueProducer(provider);
}

/**
 * Stub Redis used when `REDIS_URL` is absent (local dev / CI without Redis).
 *
 * Rate-limit surface: `incr` always returns 1 so limits never trigger.
 *
 * Idempotency surface: `get` always returns null (no stored replay), `set`
 * returns "OK" for NX calls (in-progress marker succeeds — the request
 * proceeds) and "OK" for PX calls (replay store writes succeed silently).
 * `del` is a no-op. Without Redis no replay is possible, so every request
 * is executed fresh — better to re-execute than to reject with 425.
 *
 * Production MUST override this with a real ioredis client; the class name is
 * intentionally loud.
 */
export class AlwaysAllowRedis implements RedisLike {
  async incr(_key: string): Promise<number> {
    return 1;
  }
  async pexpireNx(_key: string, _ttlMs: number): Promise<number> {
    return 1;
  }
  async pttl(_key: string): Promise<number> {
    return -1;
  }
  async get(_key: string): Promise<string | null> {
    return null;
  }
  async set(_key: string, _value: string, _opts: { px: number } | { nx: true; ex: number }): Promise<"OK" | null> {
    return "OK";
  }
  async del(_key: string): Promise<number> {
    return 0;
  }
}

@Module({
  imports: [AuditEnqueuerModule],
  controllers: [AuthController],
  providers: [
    {
      provide: PG_POOL,
      useFactory: domainPoolFactory,
    },
    {
      provide: AUTH_LOOKUP_POOL,
      useFactory: authLookupPoolFactory,
      inject: [PG_POOL],
    },
    {
      provide: REDIS_CLIENT,
      useFactory: redisClientFactory,
    },
    {
      provide: EMAIL_JOB_ENQUEUER,
      useFactory: emailJobEnqueuerFactory,
    },
    {
      provide: SessionRepository,
      useFactory: (pool: Pool): SessionRepository => new SessionRepository(pool),
      inject: [AUTH_LOOKUP_POOL],
    },
    {
      provide: AuthTokenRepository,
      useFactory: (pool: Pool): AuthTokenRepository =>
        new AuthTokenRepository(pool),
      inject: [AUTH_LOOKUP_POOL],
    },
    {
      provide: RateLimiter,
      useFactory: (redis: RedisLike): RateLimiter => new RateLimiter(redis),
      inject: [REDIS_CLIENT],
    },
    AuthGuard,
    DashboardAuthGuard,
    PosOperatorAuthGuard,
    {
      provide: AuthService,
      useFactory: (
        pool: Pool,
        sessions: SessionRepository,
        authTokens: AuthTokenRepository,
        emailJobs: EmailJobEnqueuer,
        auditEnqueuer: AuditJobEnqueuer,
      ): AuthService =>
        new AuthService(pool, sessions, authTokens, emailJobs, {
          auditEnqueuer,
        }),
      inject: [
        AUTH_LOOKUP_POOL,
        SessionRepository,
        AuthTokenRepository,
        EMAIL_JOB_ENQUEUER,
        AUDIT_JOB_ENQUEUER,
      ],
    },
    DatabasePoolBoundaryVerifier,
    DatabasePoolLifecycle,
  ],
  exports: [
    AuthService,
    AuthGuard,
    DashboardAuthGuard,
    PosOperatorAuthGuard,
    SessionRepository,
    AuthTokenRepository,
    // PG_POOL is exported so downstream modules (ContextModule, future
    // tenant/store modules) can share the single connection pool
    // rather than provisioning their own.
    PG_POOL,
    AUTH_LOOKUP_POOL,
    // EMAIL_JOB_ENQUEUER is exported so downstream modules (MembershipsModule)
    // can inject the enqueuer for invitation jobs without re-wiring it.
    EMAIL_JOB_ENQUEUER,
    // REDIS_CLIENT is exported so IdempotencyModule can reuse the single Redis
    // client (real ioredis when REDIS_URL is set, AlwaysAllowRedis stub otherwise)
    // rather than creating a second connection.
    REDIS_CLIENT,
    // RateLimiter is exported (ADR 0009) so downstream modules (SalesModule,
    // SettlementModule) can wire PosWriteRateLimitGuard over the SAME single
    // Redis-backed limiter rather than re-provisioning a second client — keeps
    // the rate-limit policy in one place (rate-limit.ts).
    RateLimiter,
  ],
})
export class AuthModule {}
