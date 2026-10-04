/**
 * Pure helpers for `posCreateCashierAdmission` (RT-113 BC2): the idempotency
 * digests and the admission decision once eligibility has passed.
 */
import { createHash } from "node:crypto";

import { canonicalJson } from "../idempotency/canonical-json";
import type { AdmissionRequestInput } from "./dto";

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/**
 * sha256 of the idempotency key. Only the digest is stored or compared; the
 * raw key is never persisted or logged (contract: "never logged raw").
 */
export function keyDigest(idempotencyKey: string): Buffer {
  return sha256(idempotencyKey);
}

/**
 * sha256 of the canonical request body without the key. An omitted
 * `takeover` is the default `false`, so `{takeover:false}` and no `takeover`
 * are the same body (contract `default: false`).
 */
export function requestFingerprint(body: AdmissionRequestInput): Buffer {
  const { idempotency_key: _key, ...rest } = body;
  const canonical = rest.mode === "online" ? { ...rest, takeover: rest.takeover ?? false } : rest;
  return sha256(canonicalJson(canonical));
}

export interface LiveAdmission {
  readonly id: string;
  readonly deviceId: string;
}

export type AdmissionAction = "create" | "renew" | "takeover" | "active_elsewhere";

/**
 * What to do for an ELIGIBLE cashier, given the live admission (if any) for
 * (tenant, store, user) after lazy expiry:
 *
 *   - none                → create (first sign-in / after end, expiry, takeover)
 *   - live on this device → renew the same admission (heartbeat)
 *   - live elsewhere      → takeover when requested (online only), otherwise
 *                           the minimum-disclosure `active_elsewhere`.
 *
 * `takeover` is false for `reconcile_offline` (the schema forbids it there):
 * the server's live admission always wins (D8).
 */
export function admissionAction(
  live: LiveAdmission | null,
  deviceId: string,
  takeover: boolean,
): AdmissionAction {
  if (live === null) return "create";
  if (live.deviceId === deviceId) return "renew";
  return takeover ? "takeover" : "active_elsewhere";
}
