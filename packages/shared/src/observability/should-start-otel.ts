/**
 * Whether module-load instrumentation should construct and start the OTel SDK.
 *
 * Skip when `DP2_OTEL_DISABLED` is `1` or `true`, or when `OTEL_SDK_DISABLED`
 * is `true`. "true" is trimmed and case-insensitive so it matches
 * `@opentelemetry/core` `getBooleanFromEnv`. Any other value, including unset,
 * starts the SDK.
 *
 * Callers pass `process.env`. This module does not start the SDK.
 */
export function shouldStartOtel(env: NodeJS.ProcessEnv): boolean {
  const dp2 = normalized(env["DP2_OTEL_DISABLED"]);
  if (dp2 === "1" || dp2 === "true") {
    return false;
  }
  if (normalized(env["OTEL_SDK_DISABLED"]) === "true") {
    return false;
  }
  return true;
}

function normalized(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}
