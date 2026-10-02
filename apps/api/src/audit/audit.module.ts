/**
 * AuditModule — Scope A (write-side) + read-side query API wiring.
 *
 * Write side (Scope A — pre-existing)
 * -----------------------------------
 * Registers `AuditEmitterInterceptor` as a global interceptor via the
 * `APP_INTERCEPTOR` DI token. The `AUDIT_JOB_ENQUEUER` provider itself is
 * imported from `AuditEnqueuerModule` (a leaf module shared with `AuthModule`
 * to avoid the `AuthModule → AuditModule → AuthModule` cycle that would arise
 * from T238's auth-failure audit emission).
 *
 * Read side (T235)
 * ----------------
 * Registers `AuditController` (`GET /api/v1/audit/events`), `AuditService`,
 * and the `AUDIT_REPOSITORY` token bound to `DrizzleAuditRepository`.
 * Imports `AuthModule` + `ContextModule` so the controller's guard chain
 * (`AuthGuard` → `TenantContextGuard` → `RolesGuard`) and the
 * repository's `PG_POOL` injection resolve through normal NestJS module
 * imports — same pattern as `StoresModule` / `MembershipsModule`.
 *
 * `audit.module.spec.ts` overrides `PG_POOL` (and the other AuthModule
 * boot-time providers) before `.compile()` so its standalone
 * AuditModule build still works with no `DATABASE_URL` set.
 *
 * APP_INTERCEPTOR vs useGlobalInterceptors
 * ----------------------------------------
 * `AuditEmitterInterceptor` is registered through `APP_INTERCEPTOR` (not via
 * `app.useGlobalInterceptors(new X(...))` in `main.ts`) because:
 *   1. The interceptor has a DI dependency on `AUDIT_JOB_ENQUEUER`.
 *   2. Integration tests need `overrideProvider(AUDIT_JOB_ENQUEUER)` to
 *      work — that only functions when the interceptor is DI-managed.
 *   Manual construction bypasses the DI container and breaks overrideProvider.
 *
 * Operational note
 * ----------------
 * If `REDIS_URL` is set but the audit fan-out worker (Scope B) is not yet
 * deployed, every `@Auditable` request enqueues a BullMQ job that accumulates
 * in Redis. Jobs drain normally once the worker starts — no data loss. However,
 * flushing Redis before deploying the worker loses those audit records permanently.
 * Deploy the audit-fanout worker (Scope B) or keep `NODE_ENV` non-production to
 * use `NoOpAuditJobEnqueuer` until the worker is ready.
 */
import { Module, type Provider } from "@nestjs/common";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { Reflector } from "@nestjs/core";

import { AuthModule } from "../auth/auth.module";
import { ContextModule } from "../context/context.module";
import { RolesGuard } from "../auth/roles.guard";

import { AuditController } from "./audit.controller";
import { AuditEmitterInterceptor } from "./audit-emitter.interceptor";
import { AuditEnqueuerModule } from "./audit-enqueuer.module";
import { OutboxAuditEnqueuerModule } from "./outbox-audit-enqueuer.module";
import {
  AUDIT_JOB_ENQUEUER,
  type AuditJobEnqueuer,
} from "./audit-job.enqueuer";
import {
  AUDIT_REPOSITORY,
  DrizzleAuditRepository,
} from "./audit.repository";
import { AuditService } from "./audit.service";
import { ROOT_LOGGER } from "../common/logging.interceptor";
import type { Logger } from "@data-pulse-2/shared";

const auditInterceptorProvider: Provider = {
  provide: APP_INTERCEPTOR,
  // ROOT_LOGGER (RootLoggerModule, RT-124) so a failed enqueue is logged
  // instead of vanishing. Optional only for standalone test modules.
  useFactory: (reflector: Reflector, enqueuer: AuditJobEnqueuer, logger?: Logger) =>
    new AuditEmitterInterceptor(reflector, enqueuer, logger),
  inject: [Reflector, AUDIT_JOB_ENQUEUER, { token: ROOT_LOGGER, optional: true }],
};

const auditRepositoryProvider: Provider = {
  provide: AUDIT_REPOSITORY,
  useClass: DrizzleAuditRepository,
};

@Module({
  // Import order matters: `OutboxAuditEnqueuerModule` is listed AFTER
  // `AuditEnqueuerModule` so Nest's last-import-wins semantics give the
  // request-graph AUDIT_JOB_ENQUEUER consumers the outbox-aware factory
  // (slice 1C-B2, T583). `AuditEnqueuerModule` stays imported because
  // (a) other modules reference it directly (AuthModule, audit-queue
  // tests), and (b) the type-export contract documented below still
  // resolves through it. `outbox-audit-enqueuer.module.spec.ts` pins
  // this resolution order with a Nest test module.
  imports: [
    AuditEnqueuerModule,
    OutboxAuditEnqueuerModule,
    AuthModule,
    ContextModule,
  ],
  controllers: [AuditController],
  providers: [
    auditInterceptorProvider,
    auditRepositoryProvider,
    AuditService,
    RolesGuard,
  ],
  // Re-export both enqueuer modules so downstream consumers of
  // `AuditModule` see `AUDIT_JOB_ENQUEUER` exactly as before. The
  // OutboxAuditEnqueuerModule export wins for resolution order, but
  // re-exporting AuditEnqueuerModule preserves the existing test
  // surface (`audit.module.spec.ts`) and downstream modules that
  // expect the legacy token-export chain.
  //
  // Nest forbids listing a token directly in `exports` when its
  // provider lives in an imported module — re-exporting the modules
  // is the supported mechanism (and is functionally equivalent).
  exports: [AuditEnqueuerModule, OutboxAuditEnqueuerModule],
})
export class AuditModule {}
