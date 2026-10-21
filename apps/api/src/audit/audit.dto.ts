/**
 * audit.dto.ts — wire shapes for `GET /api/v1/audit/events`.
 *
 * Mirrors `packages/contracts/openapi/audit.openapi.yaml`:
 *
 *   AuditEvent: { id, occurred_at, actor_user_id?, actor_label?,
 *                 tenant_id, store_id?, action, kind, target_type?,
 *                 target_id?, request_id?, metadata }
 *   ListAuditEventsResponse: { items: AuditEvent[], next_cursor: string|null }
 *
 * Snake_case field names match the OpenAPI YAML — the controller hands
 * this back verbatim, no further mapping. ISO 8601 string for
 * `occurred_at` (not `Date`) so JSON serialization is stable.
 */
import type { AuditActionKind } from "./audit-action-kinds";

export interface AuditEventDto {
  readonly id: string;
  readonly occurred_at: string;
  readonly actor_user_id: string | null;
  readonly actor_label: string | null;
  readonly tenant_id: string;
  readonly store_id: string | null;
  readonly action: string;
  /** RT-567: derived from `action` by `kindOf` (not stored). */
  readonly kind: AuditActionKind;
  readonly target_type: string | null;
  readonly target_id: string | null;
  readonly request_id: string | null;
  readonly metadata: Record<string, unknown>;
}

export interface ListAuditEventsResponse {
  readonly items: readonly AuditEventDto[];
  readonly next_cursor: string | null;
}

/**
 * RT-431 `PlatformAuditEvent`: a platform-scoped row. `tenant_id` is always
 * null and `actor_label` is masked (`platform-audit.mask.ts`).
 */
export interface PlatformAuditEventDto extends Omit<AuditEventDto, "tenant_id"> {
  readonly tenant_id: null;
}

export interface ListPlatformAuditEventsResponse {
  readonly items: readonly PlatformAuditEventDto[];
  readonly next_cursor: string | null;
}
