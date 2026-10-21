/**
 * RT-639 — the "rotate soon" hint a device-token response carries.
 *
 * Once a device credential has 15 days or less left, every response to a
 * device-token call carries two headers (pos-terminal-pairing.openapi.yaml,
 * "Credential rotation"):
 *
 *   X-Device-Token-Rotate-After   ISO-8601 instant, `expires_at - 15 days`:
 *                                 the same instant the rotate response gives
 *                                 as `rotate_after`.
 *   X-Device-Token-Rotate-Stage   `notice` (15 days or less left),
 *                                 `warning` (10 or less), `urgent` (3 or less,
 *                                 or already past `expires_at`).
 *
 * The server keeps no per-device state, so it cannot say "once". It sends the
 * stage on every response while it holds; the terminal shows each stage the
 * first time it sees it. More than 15 days left: no header. Pure: the clock
 * is a parameter.
 *
 * Only an instant and a stage travel; never token material.
 */

const DAY_MS = 86_400_000;

/** How long before `expires_at` the hint starts (RT-138 L4: the rotate response's `rotate_after`). */
export const ROTATION_HINT_LEAD_MS = 15 * DAY_MS;

export const ROTATE_AFTER_HEADER = "X-Device-Token-Rotate-After";
export const ROTATE_STAGE_HEADER = "X-Device-Token-Rotate-Stage";

export type RotationStage = "notice" | "warning" | "urgent";

export interface RotationHint {
  readonly rotateAfter: Date;
  readonly stage: RotationStage;
}

/** Upper bounds of the remaining time for each stage, tightest first. */
const STAGES: readonly { readonly withinMs: number; readonly stage: RotationStage }[] = [
  { withinMs: 3 * DAY_MS, stage: "urgent" },
  { withinMs: 10 * DAY_MS, stage: "warning" },
  { withinMs: ROTATION_HINT_LEAD_MS, stage: "notice" },
];

/** The hint for a credential expiring at `expiresAt`, or null while more than 15 days remain. */
export function computeRotationHint(expiresAt: Date, now: Date): RotationHint | null {
  const remainingMs = expiresAt.getTime() - now.getTime();
  const stage = STAGES.find((s) => remainingMs <= s.withinMs)?.stage;
  if (stage === undefined) return null;
  return { rotateAfter: new Date(expiresAt.getTime() - ROTATION_HINT_LEAD_MS), stage };
}

/** Set the hint headers on `res` when one is due; otherwise leave it untouched. */
export function applyRotationHint(
  res: { setHeader: (name: string, value: string) => unknown },
  expiresAt: Date,
  now: Date = new Date(),
): void {
  const hint = computeRotationHint(expiresAt, now);
  if (hint === null) return;
  res.setHeader(ROTATE_AFTER_HEADER, hint.rotateAfter.toISOString());
  res.setHeader(ROTATE_STAGE_HEADER, hint.stage);
}
