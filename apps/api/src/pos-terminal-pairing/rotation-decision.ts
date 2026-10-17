/**
 * RT-369 (RT-138 L4) — the device token rotation decision: which token the
 * caller presented and whether it may rotate. Pure: the rotation guard runs
 * it on the unlocked lookup, and the service runs it again on the row it
 * holds `FOR UPDATE` (pos-terminal-pairing.openapi.yaml, "Credential
 * rotation").
 *
 * Checked in this order (the first that applies decides, and is the
 * `pos.device.rotation_rejected` reason):
 *   1. `retired`        the device is retired (retire implies revoke);
 *   2. `revoked`        the device is revoked: never any grace;
 *   3. `previous_expired`  the hash is the previous one and its window has
 *                          closed;
 *      `token_replaced`    the hash is neither the current nor the previous
 *                          one (another rotation replaced it; reachable only
 *                          under the lock, since the guard's lookup matched it);
 *   4. `grace_elapsed`     `now >= expires_at + 7 days`.
 * Otherwise allowed; `inGrace` when `now >= expires_at`.
 *
 * Hashes are compared in constant time. `now` is the database clock, read
 * with the row.
 */
import { timingSafeEqual } from "node:crypto";

/** The rotate-only grace after `expires_at` (RT-138 L4, owner grace clarification). */
export const ROTATION_GRACE_MS = 7 * 86_400_000;

export type RotationCredential = "current" | "previous";
export type RotationRejectReason = "retired" | "revoked" | "previous_expired" | "token_replaced" | "grace_elapsed";

/** The device columns the decision reads, plus the database clock. */
export interface RotationDeviceState {
  readonly tokenHash: Buffer;
  readonly previousTokenHash: Buffer | null;
  readonly previousValidUntil: Date | null;
  readonly revokedAt: Date | null;
  readonly retiredAt: Date | null;
  readonly expiresAt: Date;
  readonly now: Date;
}

export type RotationDecision =
  | { readonly kind: "allowed"; readonly credential: RotationCredential; readonly inGrace: boolean }
  | { readonly kind: "rejected"; readonly reason: RotationRejectReason };

function sameHash(a: Buffer, b: Buffer | null): boolean {
  return b !== null && a.length === b.length && timingSafeEqual(a, b);
}

type TokenMatch = RotationCredential | "previous_expired" | "token_replaced";

/** Which token `presented` is: current, previous inside its window, previous past it, or neither. */
function matchToken(device: RotationDeviceState, presented: Buffer): TokenMatch {
  // Both comparisons always run, so the timing does not tell which one matched.
  const isCurrent = sameHash(presented, device.tokenHash);
  const isPrevious = sameHash(presented, device.previousTokenHash);
  if (isCurrent) return "current";
  if (!isPrevious) return "token_replaced";
  const windowOpen = device.previousValidUntil !== null && device.now < device.previousValidUntil;
  return windowOpen ? "previous" : "previous_expired";
}

export function decideRotation(device: RotationDeviceState, presented: Buffer): RotationDecision {
  if (device.retiredAt !== null) return { kind: "rejected", reason: "retired" };
  if (device.revokedAt !== null) return { kind: "rejected", reason: "revoked" };
  const credential = matchToken(device, presented);
  if (credential === "previous_expired" || credential === "token_replaced") {
    return { kind: "rejected", reason: credential };
  }
  const nowMs = device.now.getTime();
  const expiresMs = device.expiresAt.getTime();
  if (nowMs >= expiresMs + ROTATION_GRACE_MS) return { kind: "rejected", reason: "grace_elapsed" };
  return { kind: "allowed", credential, inGrace: nowMs >= expiresMs };
}
