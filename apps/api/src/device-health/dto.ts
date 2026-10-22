/**
 * Zod schemas of the RT-327 POS device health surface
 * (`pos-device-health.openapi.yaml`). Mirrors the contract:
 *
 *   - the heartbeat body is closed (`.strict()` = `additionalProperties:
 *     false`): an unknown key, and any identity or server-owned key
 *     (`device_id`, `tenant_id`, `store_id`, `last_seen_at`), is a 400 and
 *     nothing is stored. Every field is bounded and enumerated or patterned,
 *     with no free text; `null` means the same as omitting it;
 *   - the policy change is a full replacement with a required
 *     `expectedRevision` (`null` for the channel's first policy).
 *
 * Tenant, store, device and actor are never read from a body (§XII).
 */
import { z } from "zod";

import { APP_VERSION_MAX_LENGTH, APP_VERSION_MIN_LENGTH, APP_VERSION_PATTERN } from "./semver";

export const UPDATE_CHANNELS = ["lab", "canary", "stable"] as const;
export type UpdateChannel = (typeof UPDATE_CHANNELS)[number];

export const UPDATE_STATES = [
  "idle",
  "checking",
  "downloading",
  "downloaded",
  "verify_failed",
  "verify_unavailable",
  "compat_blocked",
  "update_pending",
  "installing",
  "error",
] as const;
export type UpdateState = (typeof UPDATE_STATES)[number];

export const SCHEMA_HEAD_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

const AppVersionSchema = z
  .string()
  .min(APP_VERSION_MIN_LENGTH)
  .max(APP_VERSION_MAX_LENGTH)
  .regex(APP_VERSION_PATTERN, "must be a semantic version without build metadata");

const InstantSchema = z.string().datetime({ offset: true });

export const HeartbeatReportSchema = z
  .object({
    app_version: AppVersionSchema.nullish(),
    update_channel: z.enum(UPDATE_CHANNELS).nullish(),
    update_state: z.enum(UPDATE_STATES).nullish(),
    pending_version: AppVersionSchema.nullish(),
    schema_head: z.string().min(1).max(64).regex(SCHEMA_HEAD_PATTERN).nullish(),
    source_clock_at: InstantSchema.nullish(),
  })
  .strict();

export type HeartbeatReport = z.infer<typeof HeartbeatReportSchema>;

export const ChannelParamSchema = z.enum(UPDATE_CHANNELS);

export const PosVersionPolicyChangeSchema = z
  .object({
    latestVersion: AppVersionSchema,
    recommendedVersion: AppVersionSchema,
    minSupportedVersion: AppVersionSchema,
    minSupportedGraceUntil: InstantSchema,
    expectedRevision: z.number().int().min(1).nullable(),
  })
  .strict();

export type PosVersionPolicyChange = z.infer<typeof PosVersionPolicyChangeSchema>;
