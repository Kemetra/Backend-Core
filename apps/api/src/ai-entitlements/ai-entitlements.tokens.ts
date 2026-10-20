/**
 * DI tokens and process configuration of the AI entitlements module — RT-664.
 */
export const AI_ENTITLEMENTS_RUNTIME = Symbol.for("aiEntitlements.runtime");

/** Layer 0 as the entitlement read sees it: the AI gateway kill switch (`AI_GATEWAY_ENABLED`). */
export interface AiEntitlementsRuntime {
  isEnabled(): boolean;
}

export const AI_RESERVATION_TTL_ENV = "AI_RESERVATION_TTL_SECONDS";
/** 15 minutes: well above any route timeout; the sweeper releases a reservation still open after it. */
export const DEFAULT_AI_RESERVATION_TTL_SECONDS = 900;
export const MIN_AI_RESERVATION_TTL_SECONDS = 60;

/** The configured reservation TTL. An invalid value refuses boot rather than silently defaulting. */
export function resolveAiReservationTtlSeconds(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env[AI_RESERVATION_TTL_ENV] ?? "").trim();
  if (raw === "") return DEFAULT_AI_RESERVATION_TTL_SECONDS;
  const value = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < MIN_AI_RESERVATION_TTL_SECONDS) {
    throw new Error(`${AI_RESERVATION_TTL_ENV} must be a whole number of seconds >= ${MIN_AI_RESERVATION_TTL_SECONDS}`);
  }
  return value;
}
