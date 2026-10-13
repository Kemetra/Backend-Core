/**
 * Tracking Profile DTOs — RT-448 (RT-50 Gate 7 G7-1).
 *
 * Contract: packages/contracts/openapi/catalog/tracking-profile.yaml
 * (`SetTrackingProfileRequest`, `TrackingProfile`).
 */
import { TRACKING_MODES, type TrackingMode } from "@data-pulse-2/db";
import { z } from "zod";

/**
 * Strict set command (`additionalProperties: false`, §XII): `tenant_id`,
 * `product_id` and the actor are server-resolved; any other key is a 400.
 * `expiry_required` is a batch fact (386).
 */
export const SetTrackingProfileRequestSchema = z
  .object({
    tracking_mode: z.enum(TRACKING_MODES),
    expiry_required: z.boolean(),
  })
  .strict()
  .refine((b) => !b.expiry_required || b.tracking_mode === "batch", {
    message: "expiry_required is allowed only with tracking_mode 'batch'",
    path: ["expiry_required"],
  });
export type SetTrackingProfileRequestDto = z.infer<typeof SetTrackingProfileRequestSchema>;

/** Service-level row. */
export interface TrackingProfileRow {
  readonly productId: string;
  readonly trackingMode: TrackingMode;
  readonly expiryRequired: boolean;
  readonly profileLocked: boolean;
}

/** Contract `TrackingProfile` — the `toBody()` projection (§IV). */
export interface TrackingProfileBody {
  readonly product_id: string;
  readonly tracking_mode: TrackingMode;
  readonly expiry_required: boolean;
  readonly profile_locked: boolean;
}

export function toTrackingProfile(row: TrackingProfileRow): TrackingProfileBody {
  return {
    product_id: row.productId,
    tracking_mode: row.trackingMode,
    expiry_required: row.expiryRequired,
    profile_locked: row.profileLocked,
  };
}
