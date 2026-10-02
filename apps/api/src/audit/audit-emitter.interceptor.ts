/**
 * AuditEmitterInterceptor — T231.
 *
 * Taps the response Observable of any route decorated with `@Auditable(action)`
 * and enqueues one `AuditJobPayload` per successful response via the injected
 * `AuditJobEnqueuer`.
 *
 * No-op fast path
 * ---------------
 * Routes without `@Auditable` pass through untouched — `Reflector.get` returns
 * `undefined` and we return `next.handle()` unchanged. This is intentional:
 * the majority of routes are not auditable, and the cost of a Reflector lookup
 * is negligible.
 *
 * Tenant / store derivation — response-body strategy
 * ---------------------------------------------------
 * `ContextController` endpoints deliberately do NOT mount `TenantContextGuard`
 * (chicken-and-egg: they establish the active tenant, so they cannot require
 * one). Consequently `request.context` is absent on those routes.
 *
 * For context-switch actions the interceptor therefore derives `tenant_id` and
 * `store_id` from the **response body** (`ContextResponseBody.active_tenant.id`,
 * `active_store.id`). This is more honest than the request body — the response
 * reflects what was actually applied to the session.
 *
 * Routes that DO mount `TenantContextGuard` can choose either strategy; the
 * `@Auditable` decorator opts a handler into audit emission and the interceptor
 * selects the body-based path when `request.context` is absent.
 *
 * Error isolation
 * ---------------
 * Enqueue errors are caught and logged; they MUST NOT surface as HTTP errors.
 * An audit emission failure is non-fatal — it is not preferable to reject the
 * original request over it.
 *
 * Global registration (T232/T233 — SHIPPED)
 * ------------------------------------------
 * This interceptor IS globally registered, via the `APP_INTERCEPTOR` DI token in
 * `AuditModule` (`audit.module.ts` → `auditInterceptorProvider`), and
 * `AuditModule` is imported by the root `AppModule`. It is NOT constructed in
 * `main.ts` `useGlobalInterceptors(...)` on purpose: the interceptor has a DI
 * dependency on `AUDIT_JOB_ENQUEUER`, and `APP_INTERCEPTOR` registration keeps it
 * DI-managed so integration tests can `overrideProvider(AUDIT_JOB_ENQUEUER)`
 * (manual `new X(...)` in `main.ts` would bypass the container and break that).
 * Therefore `@Auditable` decorators DO take effect at runtime.
 *
 * Durable emission is a separate, deployment-time concern: in non-production the
 * bound enqueuer is `NoOpAuditJobEnqueuer`, and in production durable fan-out
 * depends on the Scope-B audit-fanout worker being deployed (see
 * `audit.module.ts`). The decorator wiring is not the bottleneck — the worker
 * deployment is. Tests mount the interceptor on a fake controller directly.
 */
import {
  type CallHandler,
  type ExecutionContext,
  Inject,
  Injectable,
  Optional,
  type NestInterceptor,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Logger } from "@data-pulse-2/shared";
import type { Observable } from "rxjs";
import { tap } from "rxjs";
import { ROOT_LOGGER } from "../common/logging.interceptor";
import type { AuthedRequest } from "../auth/auth.guard";
import type { ContextResponseBody } from "../context/context.service";
import { AUDITABLE_KEY } from "./auditable.decorator";
import { AUDIT_JOB_ENQUEUER, type AuditJobEnqueuer } from "./audit-job.enqueuer";
import type { AuditJobPayload } from "./audit-job.types";

@Injectable()
export class AuditEmitterInterceptor implements NestInterceptor {
  constructor(
    @Inject(Reflector)
    private readonly reflector: Reflector,
    @Inject(AUDIT_JOB_ENQUEUER)
    private readonly enqueuer: AuditJobEnqueuer,
    @Optional() @Inject(ROOT_LOGGER)
    private readonly logger?: Logger,
  ) {}

  intercept(execCtx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const action = this.reflector.get<string | undefined>(
      AUDITABLE_KEY,
      execCtx.getHandler(),
    );

    if (!action) {
      return next.handle();
    }

    const request = execCtx.switchToHttp().getRequest<AuthedRequest & {
      context?: { tenantId: string | null; storeId: string | null };
    }>();

    return next.handle().pipe(
      tap({
        next: (responseBody: unknown) => {
          // Fire-and-forget: the HTTP outcome never depends on audit
          // delivery, but a failure must be visible (RT-124). Log the action
          // and error class only — never the payload (actor_label may be an
          // email) or a raw driver message.
          this.emitAsync(action, request, responseBody).catch((err: unknown) => {
            this.logger?.error(
              {
                component: "audit.emitter",
                action,
                request_id: request.requestId ?? null,
                err_class: err instanceof Error ? err.name : typeof err,
              },
              "AuditEmitter: enqueue failed",
            );
          });
        },
      }),
    );
  }

  private async emitAsync(
    action: string,
    request: AuthedRequest & { context?: { tenantId: string | null; storeId: string | null } },
    responseBody: unknown,
  ): Promise<void> {
    const principal = request.principal;
    const actorUserId = principal?.userId ?? null;
    const actorLabel: string | null = null;

    // Derive tenant/store from response body when request.context is absent
    // (ContextController routes — see module docstring above).
    let tenantId: string | null = request.context?.tenantId ?? null;
    let storeId: string | null = request.context?.storeId ?? null;

    if (tenantId === null && isContextResponseBody(responseBody)) {
      tenantId = responseBody.active_tenant?.id ?? null;
      storeId = responseBody.active_store?.id ?? null;
    }

    const payload: AuditJobPayload = {
      actor_user_id: actorUserId,
      actor_label: actorLabel,
      tenant_id: tenantId,
      store_id: storeId,
      action,
      target_type: null,
      target_id: null,
      request_id: request.requestId ?? null,
      metadata: null,
    };

    await this.enqueuer.enqueue(payload);
  }
}

function isContextResponseBody(
  value: unknown,
): value is Pick<ContextResponseBody, "active_tenant" | "active_store"> {
  if (typeof value !== "object" || value === null) return false;
  return "active_tenant" in value;
}
