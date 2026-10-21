/**
 * platform-audit.query.schema.ts — query schema for
 * `GET /api/v1/platform/audit/events` (`listPlatformAuditEvents`, RT-431).
 *
 * The `listAuditEvents` schema without `store_id`: the closed set is
 * `action`, `kind`, `actor_user_id`, `from`, `to`, `cursor` and `limit`, with
 * the same bounds, defaults and cursor codec. It stays `.strict()`, so a
 * `tenant_id`, a `store_id` or any other key is a 400 `validation_error`.
 */
import type { z } from "zod";

import { AuditQuerySchema } from "./audit.query.schema";

export const PlatformAuditQuerySchema = AuditQuerySchema.omit({ store_id: true });

export type PlatformAuditQueryParsed = z.output<typeof PlatformAuditQuerySchema>;
