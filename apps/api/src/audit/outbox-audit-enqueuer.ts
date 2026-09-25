/**
 * T583 — OutboxAuditEnqueuer: replaces direct BullMQ enqueue with outbox emission.
 *
 * This is a drop-in replacement for `AuditQueueProducer` that satisfies
 * the `AuditJobEnqueuer` interface but writes to `outbox_events` instead
 * of enqueuing directly to BullMQ.
 *
 * Flow BEFORE T583:
 *   AuditEmitterInterceptor → AuditQueueProducer.enqueue() → BullMQ "audit" queue
 *
 * Flow AFTER T583:
 *   AuditEmitterInterceptor → OutboxAuditEnqueuer.enqueue()
 *     → outbox_events row (delivery_state='pending')
 *   DrainerProcessor polls → claims row → AuditEventCreatedConsumer.handle()
 *     → BullMQ "audit" queue → AuditFanoutProcessor persists audit_events row
 *
 * Atomicity note
 * --------------
 * `AuditEmitterInterceptor` fires POST-response (in a `tap()` RxJS operator),
 * so the audit emission is already not in the same transaction as the auditable
 * request handler. This enqueuer preserves that "best-effort post-response"
 * semantic — it emits in a fresh transaction (`emitInNewTransaction`).
 *
 * For true transactional atomicity (emit in the same tx as the business write),
 * the caller would need to pass a `PoolClient` to `emit()` directly. That
 * refactor is deferred to a future slice.
 *
 * Tenant-context derivation
 * -------------------------
 * `AuditJobPayload.tenant_id` may be null (platform-admin/anonymous-actor path).
 * The outbox row stores that null. It does not store the nil UUID: migration
 * 0031 references `tenants(id)` and rejects a tenant with the nil id.
 * `runWithTenantContext` still maps a null context tenant to the nil UUID
 * so the RLS `::uuid` cast succeeds, with `isPlatformAdmin: true`.
 * This matches `insertAuditEvent`, which stores SQL NULL and uses the nil
 * UUID only as the session GUC.
 *
 * NOTE: Null tenant_id in the audit payload means the event is platform-scoped.
 * The outbox RLS policy allows platform-admin context to INSERT. The drainer
 * claim query runs under platform-admin context and will see these rows.
 *
 * Payload shape
 * -------------
 * The `AuditJobPayload` is stored as the outbox event payload verbatim.
 * The `AuditEventCreatedConsumer` on the worker side parses and validates it
 * with the same Zod schema mirror before enqueuing to BullMQ.
 */
import { Injectable, Inject } from "@nestjs/common";
import type { Pool } from "pg";
import {
  emitInNewTransaction,
  OUTBOX_EVENT_TYPES,
} from "@data-pulse-2/db";
import { PG_POOL } from "../auth/auth.module";
import type { AuditJobEnqueuer } from "./audit-job.enqueuer";
import type { AuditJobPayload } from "./audit-job.types";

@Injectable()
export class OutboxAuditEnqueuer implements AuditJobEnqueuer {
  constructor(
    @Inject(PG_POOL)
    private readonly pool: Pool,
  ) {}

  async enqueue(payload: AuditJobPayload): Promise<void> {
    const tenantId = payload.tenant_id ?? null;
    const isPlatformAdmin = tenantId === null;

    await emitInNewTransaction(
      this.pool,
      { tenantId, isPlatformAdmin },
      {
        eventType: OUTBOX_EVENT_TYPES.AUDIT_EVENT_CREATED,
        tenantId,
        storeId: payload.store_id,
        payload: {
          actor_user_id: payload.actor_user_id,
          actor_label:   payload.actor_label,
          tenant_id:     payload.tenant_id,
          store_id:      payload.store_id,
          action:        payload.action,
          target_type:   payload.target_type,
          target_id:     payload.target_id,
          request_id:    payload.request_id,
          metadata:      payload.metadata,
        },
        correlationId: payload.request_id,
      },
    );
  }
}
