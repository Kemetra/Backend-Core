/**
 * Server-side audit of receipt reprints (Jira RT-539; contract
 * `recordSaleReprint`, `x-audit-action: sale.receipt.reprinted`; OD-534-7).
 *
 * Every reprint call that reaches a decision writes ONE `audit_events` row:
 * a recorded reprint in the same tenant-scoped transaction as its
 * `sale_reprints` row (they commit or roll back together), and a refusal
 * (403 / 404 / 422) in a transaction that records nothing else. The
 * request-graph `@Auditable` interceptor is not used here: it is
 * fire-and-forget and runs only on success, and the contract requires the
 * refusals audited too (the cashier-admissions precedent).
 *
 * Payloads carry identifiers and categories only: no receipt content, name,
 * token or PIN (Constitution §XIII, §XIV). `actor_user_id` is the envelope
 * user or the admitted cashier; the calling device is in the metadata.
 */
import { runWithTenantContext } from "@data-pulse-2/db";
import { newId } from "@data-pulse-2/shared";
import type { Pool, PoolClient } from "pg";

import type { DeviceScope } from "../../../pos-cashier-admissions/device-scope";
import type { SaleHistoryRefusal, SaleHistoryRefusalAudit } from "./sale-history-auth.guard";

export const REPRINT_AUDIT_ACTION = "sale.receipt.reprinted";

export interface ReprintAuditEvent {
  readonly tenantId: string;
  readonly storeId: string;
  readonly actorUserId: string | null;
  readonly requestId: string | null;
  readonly metadata: {
    readonly sale_ref: string | null;
    readonly outcome: "recorded" | "refused";
    readonly mode: string | null;
    readonly kind: string | null;
    readonly device_id: string | null;
    readonly [key: string]: unknown;
  };
}

export async function insertReprintAudit(client: PoolClient, event: ReprintAuditEvent): Promise<void> {
  await client.query(
    `INSERT INTO audit_events
       (id, actor_user_id, actor_label, tenant_id, store_id, action,
        target_type, target_id, request_id, metadata)
     VALUES ($1, $2, NULL, $3, $4, $5, 'sale', $6, $7, $8::jsonb)`,
    [
      newId(),
      event.actorUserId,
      event.tenantId,
      event.storeId,
      REPRINT_AUDIT_ACTION,
      event.metadata.sale_ref,
      event.requestId,
      JSON.stringify(event.metadata),
    ],
  );
}

/** The guard's refusals (403 before the handler), written under the device's tenant. */
export class PgSaleHistoryRefusalAudit implements SaleHistoryRefusalAudit {
  constructor(private readonly pool: Pool) {}

  recordRefusal(refusal: SaleHistoryRefusal): Promise<void> {
    const scope: DeviceScope = refusal.scope;
    return runWithTenantContext(this.pool, { tenantId: scope.tenantId, isPlatformAdmin: false }, (client) =>
      insertReprintAudit(client, {
        tenantId: scope.tenantId,
        storeId: scope.storeId,
        actorUserId: refusal.actorUserId,
        requestId: refusal.requestId,
        metadata: {
          sale_ref: refusal.saleRef,
          outcome: "refused",
          reason: refusal.reason,
          mode: refusal.mode,
          kind: refusal.kind,
          device_id: scope.deviceId,
        },
      }),
    );
  }
}
