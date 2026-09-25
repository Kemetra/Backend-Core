/**
 * 020-US2 (T023) — connector heartbeat request DTO.
 *
 * Strict Zod schema (§XII mass-assignment ban): the body carries ONLY the
 * self-reported observational fields. The connector identity + tenant are
 * resolved from the 018 guard-attached context, NEVER from the body — so
 * `tenant_id`, `registration_id`, `last_seen_at`, and any other identity /
 * server-owned field MUST NOT be body-assignable. `.strict()` rejects unknown
 * keys (incl. those identity fields) as a validation failure.
 *
 * ALL fields optional — an empty / absent body is a valid heartbeat (it still
 * records `last_seen_at = now()` from the server clock). Mirrors the contract
 * `HeartbeatReport` in
 * `packages/contracts/openapi/erpnext-connector/connector-health.yaml`.
 */
import { z } from "zod";

export const HeartbeatReportSchema = z
  .object({
    connectorVersion: z.string().min(1).max(64).optional(),
    // Postgres int4. 2147483648 would bind as 22003/500 instead of a 400.
    backlogIndicator: z.number().int().min(0).max(2147483647).optional(),
    erpnextReachable: z.boolean().optional(),
    // Connector-reported clock; provenance only, never used for the verdict (§X).
    sourceClockAt: z.string().datetime().optional(),
  })
  // `.strict()` rejects unknown keys (incl. smuggled identity fields, §XII).
  // `.default({})` coerces a truly bodyless POST (`undefined`) to an empty,
  // still-strict object so a no-body heartbeat is VALID (contract:
  // `requestBody.required: false`) rather than a spurious 400.
  .strict()
  .default({});

export type HeartbeatReportDto = z.infer<typeof HeartbeatReportSchema>;

/** The minimal heartbeat acknowledgement — server clock, no secret/identity echo. */
export interface HeartbeatAckBody {
  acknowledgedAt: string;
}
