import { SetMetadata, type CustomDecorator } from "@nestjs/common";

/**
 * Metadata key used by `AuditEmitterInterceptor` to discover auditable
 * routes. Namespaced to avoid collision with third-party libraries.
 */
export const AUDITABLE_KEY = "dp2:auditable";

/**
 * `@Auditable(action)` — marks a route handler as auditable.
 *
 * The interceptor reads this metadata via `Reflector` and emits one
 * `AuditJobPayload` per request. Routes without this decorator are
 * transparent to the interceptor (no-op fast path).
 *
 * Usage:
 *   @Auditable("context.switch.tenant")
 *   @Post("tenant")
 *   async switchTenant(...) { ... }
 *
 * Action naming convention: `<domain>.<verb>.<detail>` in dot notation,
 * matching the `AuditEvent.action` field in the OpenAPI contract
 * (`specs/001-foundation-auth-tenant-store/contracts/audit.openapi.yaml`).
 *
 * This decorator is passive — it only publishes metadata. No-op on its
 * own; the interceptor drives all side effects.
 */
export const Auditable = (action: string): CustomDecorator =>
  SetMetadata(AUDITABLE_KEY, action);

/**
 * A request a handler may annotate with audit metadata (RT-530). The handler
 * sets it AFTER it has the data (for example the approver of a sale void), and
 * `AuditEmitterInterceptor` copies it into the emitted event's `metadata`.
 * Absent -> `metadata: null`, as before. MUST NOT carry PII, credentials,
 * tokens or payloads (FR-AUDIT-3, Constitution XIV): ids and labels only.
 */
export interface AuditAnnotatedRequest {
  auditMetadata?: Record<string, unknown>;
}

/** Attach audit metadata to the request for the interceptor to emit. */
export function annotateAudit(request: object, metadata: Record<string, unknown>): void {
  (request as AuditAnnotatedRequest).auditMetadata = metadata;
}
