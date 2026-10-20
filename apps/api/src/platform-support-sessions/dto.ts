/**
 * `OpenSupportSessionRequest` (platform-support-sessions.openapi.yaml, RT-414
 * decisions 1 and 4). Unknown keys, a non-UUID tenant, a purpose outside the
 * closed set or a `ticket_ref` that breaks its pattern are a 400
 * `validation_error`.
 */
import { z } from "zod";

import { SUPPORT_PURPOSES } from "@data-pulse-2/db";

export const TICKET_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:#/-]{0,63}$/;

export const OpenSupportSessionSchema = z
  .object({
    tenant_id: z.string().uuid(),
    purpose: z.enum(SUPPORT_PURPOSES),
    ticket_ref: z.string().min(1).max(64).regex(TICKET_REF_PATTERN).optional(),
  })
  .strict();
export type OpenSupportSessionInput = z.infer<typeof OpenSupportSessionSchema>;
