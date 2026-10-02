/**
 * @Idempotent — T521.
 *
 * Route-level decorator that marks a controller method for HTTP idempotency
 * enforcement by `IdempotencyInterceptor`.
 *
 * Usage:
 *   @Idempotent('required')   — missing Idempotency-Key header → 400
 *   @Idempotent('optional')   — missing header → pass-through, no replay
 *
 * The decorator publishes two metadata keys:
 *   IDEMPOTENT_POLICY_KEY — 'required' | 'optional'
 *   IDEMPOTENT_OPTIONS_KEY — IdempotentOptions (TTL overrides etc.)
 *
 * This decorator is passive — it only stores metadata. The interceptor
 * drives all enforcement. Exactly one usage in this slice (on `createInvitation`).
 *
 * Design discipline (strategy.md §12):
 *   - Route-level only — never applied to a class or globally.
 *   - The decorator does NOT check the HTTP verb at decoration time.
 *     Enforcement of safe-verb rejection is the interceptor's responsibility.
 */
import { SetMetadata, applyDecorators } from "@nestjs/common";

export type IdempotentPolicy = "required" | "optional";

export interface IdempotentOptions {
  /** Override the 72h default replay retention (seconds). */
  replayTtlSec?: number;
  /** Override the 60s default in-flight marker TTL (seconds). */
  inflightTtlSec?: number;
  /**
   * `"forbid"` — the response carries credential material and is never
   * stored or replayed (RT-82 K3). The key stays occupied, so the handler
   * never runs twice; a same-key retry answers `409 idempotency_key_conflict`.
   * Default `"allow"`.
   */
  replay?: "allow" | "forbid";
  /**
   * With `replay: "forbid"`: the top-level response fields kept in the stored
   * marker (an allowlist; every other field is dropped). Must name only
   * non-secret identifiers, e.g. `["credential_id"]`.
   */
  replayMarkerFields?: readonly string[];
}

export const IDEMPOTENT_POLICY_KEY = "dp2:idempotent:policy";
export const IDEMPOTENT_OPTIONS_KEY = "dp2:idempotent:options";

/**
 * Mark a route handler for HTTP idempotency enforcement.
 *
 * @param policy  'required' — missing header → 400; 'optional' — pass-through.
 * @param options Optional TTL overrides.
 */
export const Idempotent = (
  policy: IdempotentPolicy,
  options: IdempotentOptions = {},
) =>
  applyDecorators(
    SetMetadata(IDEMPOTENT_POLICY_KEY, policy),
    SetMetadata(IDEMPOTENT_OPTIONS_KEY, options),
  );
