/**
 * PosAuditEventsService — Wave 2 audit-event batch sync.
 *
 * Pipeline per request:
 *   1. Resolve device by `device_token_attestation` (hash lookup). 401 on
 *      miss / revoked.
 *   2. Process each event independently:
 *      a. Structural validation (Zod already ran; this catches action_category
 *         and payload forbidden-field violations).
 *      b. Tenant/branch scope check against the device-resolved scope.
 *      c. Resolve `acting_operator_id` (Clerk subject) → `users.id` (strict —
 *         reject as `invalid_input` on unmapped).
 *      d. Idempotent INSERT via `ON CONFLICT (id) DO NOTHING RETURNING id`.
 *         Conflict → `duplicates`; fresh insert → `accepted`.
 *   3. Return `{ accepted, duplicates, rejected }`.
 *
 * Per-event isolation: one failure MUST NOT block remaining valid events.
 * The loop catches and classifies each event's error individually.
 *
 * `occurred_at` is set from wire `created_at` (NOT the DB default `now()`)
 * to preserve offline-batch temporal integrity.
 *
 * `request_id` is the UUID set by `RequestIdInterceptor`. The column is
 * `uuid` type — `null` is safe; the string `"unknown"` is not.
 */
import { Injectable } from "@nestjs/common";
import type { Logger } from "@data-pulse-2/shared";
import { runWithTenantContext } from "@data-pulse-2/db";
import type { Pool, PoolClient } from "pg";

import { DeviceRepository } from "../pos-operators/device.repository";
import {
  hasForbiddenField,
  POS_AUDIT_ACTION_CATEGORIES,
  type AuditEventItemInput,
  type PosAuditEventsSyncInput,
  type PosAuditEventsSyncResponseBody,
  type RejectedEvent,
} from "./dto";

const ACTION_CATEGORY_SET = new Set<string>(POS_AUDIT_ACTION_CATEGORIES);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class PosAuditEventsService {
  constructor(
    private readonly pool: Pool,
    private readonly deviceRepository: DeviceRepository,
    private readonly logger: Logger,
  ) {}

  async syncBatch(
    body: PosAuditEventsSyncInput,
    requestId: string | null,
  ): Promise<PosAuditEventsSyncResponseBody | { kind: "device_invalid" }> {
    const device = await this.deviceRepository.findActiveByAttestation(
      body.device_token_attestation,
    );
    if (!device) {
      this.logger.warn({ request_id: requestId }, "pos-audit-events: device attestation invalid or revoked");
      return { kind: "device_invalid" };
    }

    const accepted: string[] = [];
    const duplicates: string[] = [];
    const rejected: RejectedEvent[] = [];

    for (const event of body.events) {
      try {
        await this.processEvent(
          event,
          device.id,
          device.tenantId,
          device.storeId,
          requestId,
          accepted,
          duplicates,
          rejected,
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          { request_id: requestId, event_id: event.event_id, err: msg },
          "pos-audit-events: unexpected error processing event",
        );
        rejected.push({ event_id: event.event_id, category: "invalid_input" });
      }
    }

    return { accepted, duplicates, rejected };
  }

  private async processEvent(
    event: AuditEventItemInput,
    deviceId: string,
    deviceTenantId: string,
    deviceStoreId: string,
    requestId: string | null,
    accepted: string[],
    duplicates: string[],
    rejected: RejectedEvent[],
  ): Promise<void> {
    // action_category: closed-set check.
    if (!ACTION_CATEGORY_SET.has(event.action_category)) {
      rejected.push({ event_id: event.event_id, category: "schema_violation" });
      return;
    }

    // Payload forbidden-field check (FR-027 / PR-1).
    if (hasForbiddenField(event.payload)) {
      rejected.push({ event_id: event.event_id, category: "schema_violation" });
      return;
    }

    // shift.open: payload.shift_id must be a valid UUID string.
    if (event.action_category === "shift.open") {
      const payloadShiftId = (event.payload as Record<string, unknown>)["shift_id"];
      if (typeof payloadShiftId !== "string" || !UUID_RE.test(payloadShiftId)) {
        rejected.push({ event_id: event.event_id, category: "schema_violation" });
        return;
      }
    }

    // Tenant/branch scope check.
    if (event.tenant_id !== deviceTenantId || event.branch_id !== deviceStoreId) {
      rejected.push({ event_id: event.event_id, category: "tenant_mismatch" });
      return;
    }

    // The authenticated device is authoritative terminal provenance. Retain
    // the wire field for compatibility, but never persist a contradictory id.
    if (event.originating_terminal_id !== deviceId) {
      rejected.push({ event_id: event.event_id, category: "invalid_input" });
      return;
    }

    // Idempotent insert: ON CONFLICT (id) DO NOTHING RETURNING id.
    const eventId = event.event_id;

    const outcome = await runWithTenantContext(
      this.pool,
      { tenantId: event.tenant_id, isPlatformAdmin: false },
      async (client): Promise<"accepted" | "duplicate" | "invalid_actor"> => {
        const actorUserId = await this.resolveActorUserId(
          client,
          event,
          deviceId,
        );
        if (actorUserId === null) return "invalid_actor";

        const r = await client.query<{ id: string }>(
          `INSERT INTO audit_events
             (id, occurred_at, actor_user_id, actor_label,
              tenant_id, store_id, action,
              target_type, target_id, request_id, metadata)
           VALUES
             ($1, $2::timestamptz, $3, $4,
              $5, $6, $7,
              $8, $9, $10::uuid, $11)
           ON CONFLICT (id) DO NOTHING
           RETURNING id`,
          [
            eventId,
            event.created_at,
            actorUserId,
            null,
            event.tenant_id,
            event.branch_id,
            event.action_category,
            null,
            null,
            requestId,
            JSON.stringify(event.payload),
          ],
        );

        const accepted = r.rows.length > 0;

        if (accepted && event.action_category === "shift.open") {
          const shiftId = (event.payload as Record<string, unknown>)["shift_id"] as string;
          await client.query(
            `INSERT INTO shifts
               (shift_id, tenant_id, store_id, opening_cashier_user_id, opening_device_id, opened_at)
             VALUES ($1, $2, $3, $4, $5, $6::timestamptz)
             ON CONFLICT (shift_id) DO NOTHING`,
            [
              shiftId,
              event.tenant_id,
              event.branch_id,
              actorUserId,
              deviceId,
              event.created_at,
            ],
          );
        }

        return accepted ? "accepted" : "duplicate";
      },
    );

    if (outcome === "invalid_actor") {
      rejected.push({ event_id: eventId, category: "invalid_input" });
    } else if (outcome === "accepted") {
      accepted.push(eventId);
    } else {
      duplicates.push(eventId);
    }
  }

  private async resolveActorUserId(
    client: PoolClient,
    event: AuditEventItemInput,
    deviceId: string,
  ): Promise<string | null> {
    // The bound POS session proves authorization at event time. Current
    // membership, role, and store grants may have changed while the event was
    // queued offline; using them here would discard a valid historical audit.
    const r = await client.query<{ id: string }>(
      `SELECT u.id
       FROM auth_tokens token
       JOIN users u ON u.id = token.user_id
       WHERE u.clerk_user_id = $1
         AND token.tenant_id = $2
         AND token.scope = 'pos_operator'
         AND token.device_id = $4
         AND token.store_id = $3
         AND ($5::uuid IS NULL OR token.id = $5::uuid)
         AND token.issued_at <= $6::timestamptz
         AND token.expires_at > $6::timestamptz
         AND (token.revoked_at IS NULL OR token.revoked_at >= $6::timestamptz)
       LIMIT 1`,
      [
        event.acting_operator_id,
        event.tenant_id,
        event.branch_id,
        deviceId,
        event.session_id ?? null,
        event.created_at,
      ],
    );
    return r.rows[0]?.id ?? null;
  }
}
