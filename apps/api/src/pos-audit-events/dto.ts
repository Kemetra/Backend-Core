/**
 * POS-Audit-Events DTOs — Wave 2 audit-event sync surface.
 *
 * Source of truth:
 *   `packages/contracts/openapi/pos-audit-events.openapi.yaml`
 *
 * The action_category field is validated in the service (not as a Zod
 * enum) so that per-event rejection semantics work: an unrecognised
 * category produces a `schema_violation` rejection for that event only,
 * not a top-level 400 that blocks the entire batch.
 *
 * Forbidden payload fields (FR-027 / PR-1): the set is closed and checked
 * recursively by `hasForbiddenField`.
 */
import { z } from "zod";

export const POS_AUDIT_ACTION_CATEGORIES = [
  "shift.open",
  "shift.close",
  "shift.forced_close",
  "operator.session.takeover",
  "cashier.pin.reset",
  "cashier.pin.unlock",
] as const satisfies readonly string[];

export type PosAuditActionCategory = (typeof POS_AUDIT_ACTION_CATEGORIES)[number];

const FORBIDDEN_PAYLOAD_KEYS = new Set<string>([
  "pin",
  "pin_hash",
  "password",
  "password_hash",
  "clerk_jwt",
  "clerk_session_token",
  "device_token",
  "device_token_attestation",
  "token",
  "secret",
  "credential",
]);

/**
 * Recursively check whether `value` contains any forbidden key at any
 * nesting level, including inside array elements. Returns `true` if a
 * violation is found.
 */
export function hasForbiddenField(value: unknown, depth = 0): boolean {
  // Fail closed: an object/array beyond the supported inspection depth is a
  // schema violation. Treating it as safe would let a credential field hide
  // below the traversal cutoff.
  if (typeof value !== "object" || value === null) return false;
  if (depth > 20) return true;
  if (Array.isArray(value)) {
    return value.some((item) => hasForbiddenField(item, depth + 1));
  }
  for (const key of Object.keys(value as Record<string, unknown>)) {
    if (FORBIDDEN_PAYLOAD_KEYS.has(key)) return true;
    if (hasForbiddenField((value as Record<string, unknown>)[key], depth + 1)) return true;
  }
  return false;
}

const AuditEventItemSchema = z
  .object({
    event_id: z.string().uuid(),
    tenant_id: z.string().uuid(),
    branch_id: z.string().uuid(),
    originating_terminal_id: z.string().uuid(),
    acting_operator_id: z.string().min(1),
    session_id: z.string().uuid().nullable().optional(),
    shift_id: z.string().uuid().nullable().optional(),
    action_category: z.string().min(1),
    created_at: z.string().datetime(),
    approving_supervisor_id: z.string().min(1).nullable().optional(),
    payload: z.record(z.unknown()),
  })
  .strict();

export type AuditEventItemInput = z.infer<typeof AuditEventItemSchema>;

export const PosAuditEventsSyncSchema = z
  .object({
    device_token_attestation: z.string().min(1),
    events: z.array(AuditEventItemSchema).min(1),
  })
  .strict();

export type PosAuditEventsSyncInput = z.infer<typeof PosAuditEventsSyncSchema>;

export interface RejectedEvent {
  event_id: string;
  category: "invalid_input" | "tenant_mismatch" | "schema_violation";
}

export interface PosAuditEventsSyncResponseBody {
  accepted: string[];
  duplicates: string[];
  rejected: RejectedEvent[];
}
