/**
 * The one log line of a fail-closed `entitlement_unavailable` — RT-664. It
 * tells an outage or a missing grant apart from a legitimate deny. Business
 * fields only: the error class and its SQLSTATE-like code, never the message
 * (it can carry SQL or a connection string), a tenant id or a row value.
 */
import type { Logger } from "@data-pulse-2/shared";

export function unavailableLogger(logger: Pick<Logger, "warn"> | undefined, surface: "check" | "console"): (err: unknown) => void {
  return (err) => {
    if (logger === undefined) return;
    const code = (err as { code?: unknown } | null)?.code;
    logger.warn(
      {
        event: "ai.entitlements.unavailable",
        surface,
        err_class: err instanceof Error ? err.name : "non_error_throw",
        ...(typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? { err_code: code } : {}),
      },
      "ai entitlements unavailable",
    );
  };
}
