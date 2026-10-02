/**
 * `AuditJobPayload` — the envelope enqueued by `AuditEmitterInterceptor`
 * for the audit fan-out worker (T232/T233) to persist.
 *
 * This is a strict subset of the `AuditEvent` schema defined in
 * `specs/001-foundation-auth-tenant-store/contracts/audit.openapi.yaml`.
 * Fields omitted here (`id`, `occurred_at`) are server-stamped at insert
 * time by the worker — they MUST NOT be set by the interceptor.
 *
 * Nullability mirrors the OpenAPI schema:
 *   - `actor_user_id`  nullable — device-bound / anonymous-actor pattern.
 *   - `actor_label`    nullable — human-readable label if no user id.
 *   - `store_id`       nullable — tenant-level actions have no active store.
 *   - `target_type`    nullable — some actions (e.g. auth.signin) have no target object.
 *   - `target_id`      nullable — paired with `target_type`.
 *   - `request_id`     nullable — present when `RequestIdInterceptor` ran upstream.
 *   - `metadata`       nullable — free-form supplementary data; MUST NOT contain PII,
 *                                 credentials, or tokens (FR-AUDIT-3).
 */
export interface AuditJobPayload {
  readonly actor_user_id: string | null;
  readonly actor_label: string | null;
  readonly tenant_id: string | null;
  readonly store_id: string | null;
  readonly action: string;
  readonly target_type: string | null;
  readonly target_id: string | null;
  readonly request_id: string | null;
  readonly metadata: Record<string, unknown> | null;
  /**
   * Stable id of the audit row this job writes (RT-124). Stamped once at
   * enqueue when absent, used as the BullMQ jobId and as audit_events.id, so
   * a retried or re-added job cannot insert a second row.
   */
  readonly event_id?: string;
}
