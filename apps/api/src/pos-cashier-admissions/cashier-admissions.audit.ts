/**
 * Server-side audit of cashier admissions (RT-113 BC2; contract **Audit**).
 *
 * Written into `audit_events` on the caller's tenant-scoped transaction, the
 * same in-transaction pattern as the POS operator takeover
 * (`operator.session.takeover`) and settlement (`insertSettlementAudit`): the
 * admission change and its audit fact commit or roll back together. The
 * request-graph `@Auditable` interceptor is not used because it is
 * fire-and-forget, carries no metadata and would also fire for
 * `active_elsewhere` and replays, which record nothing.
 *
 * Payloads carry identifiers and categories only: no PIN, grant body, token,
 * name or contact detail (Constitution §XIII, §XIV).
 */
import { newId } from "@data-pulse-2/shared";
import type { PoolClient } from "pg";

import type { DeviceScope } from "./device-scope";

export const ADMISSION_AUDIT_ACTIONS = {
  admitted: "pos.cashier_admission.admitted",
  renewed: "pos.cashier_admission.renewed",
  takeover: "pos.cashier_admission.takeover",
  expired: "pos.cashier_admission.expired",
  ended: "pos.cashier_admission.ended",
  refused: "pos.cashier_admission.refused",
} as const;

export type AdmissionAuditAction = (typeof ADMISSION_AUDIT_ACTIONS)[keyof typeof ADMISSION_AUDIT_ACTIONS];

export interface AdmissionAuditEvent {
  readonly scope: DeviceScope;
  readonly action: AdmissionAuditAction;
  /** The cashier, when known to exist in this tenant; null otherwise. */
  readonly actorUserId: string | null;
  /** The admission the event is about, when there is one. */
  readonly targetId: string | null;
  readonly requestId: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface AdmissionAuditWriter {
  record(client: PoolClient, event: AdmissionAuditEvent): Promise<void>;
}

export class AdmissionAuditRepository implements AdmissionAuditWriter {
  async record(client: PoolClient, event: AdmissionAuditEvent): Promise<void> {
    await client.query(
      `INSERT INTO audit_events
         (id, actor_user_id, actor_label, tenant_id, store_id, action,
          target_type, target_id, request_id, metadata)
       VALUES ($1, $2, NULL, $3, $4, $5, 'cashier_admission', $6, $7, $8::jsonb)`,
      [
        newId(),
        event.actorUserId,
        event.scope.tenantId,
        event.scope.storeId,
        event.action,
        event.targetId,
        // A UUID: RequestIdInterceptor assigns one to every request.
        event.requestId,
        JSON.stringify(event.metadata),
      ],
    );
  }
}
