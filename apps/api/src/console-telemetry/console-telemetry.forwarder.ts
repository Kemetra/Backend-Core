/**
 * Forwards a rebuilt envelope to the Console Sentry project (RT-632, OBS-3).
 *
 * The destination comes only from `CONSOLE_SENTRY_DSN`, so the tunnel is never
 * an open relay. Default-inert: with the DSN unset, blank or malformed,
 * `enabled` is false and nothing is sent. Forwarding is fire-and-forget with
 * a timeout and a bound on concurrent requests (the excess is dropped), so
 * Sentry being slow or down never holds a request or a socket of other API
 * traffic. Logs carry an upstream status or a fixed line only: never the
 * envelope, the DSN or the upstream URL (it contains the project id and host).
 */
import { Inject, Injectable, Optional } from "@nestjs/common";
import { resolveSentryConfig, type Logger } from "@data-pulse-2/shared";

import { ROOT_LOGGER } from "../common/logging.interceptor";

export const CONSOLE_TELEMETRY_FETCH = "CONSOLE_TELEMETRY_FETCH";

/** The slice of `fetch` the forwarder uses; injected so tests replace the network. */
export type TelemetryFetch = (
  url: string,
  init: {
    method: "POST";
    headers: Record<string, string>;
    body: Buffer;
    redirect: "error";
    signal: AbortSignal;
  },
) => Promise<{ status: number; body?: { cancel(): Promise<void> } | null }>;

/** Concurrent forwards; a Console error burst beyond this is dropped. */
export const MAX_IN_FLIGHT_FORWARDS = 4;
export const FORWARD_TIMEOUT_MS = 5000;

const SENTRY_CLIENT = "backend-core-console-tunnel/1.0";

interface ForwardTarget {
  readonly url: string;
  readonly auth: string;
}

type WarnLogger = Pick<Logger, "warn">;

/** Envelope endpoint and auth header from a DSN `scheme://key@host[/prefix]/project`. */
function targetFromDsn(dsn: string): ForwardTarget {
  const url = new URL(dsn);
  const segments = url.pathname.split("/");
  const projectId = segments.pop() ?? "";
  const prefix = segments.join("/").replace(/\/+$/, "");
  const key = decodeURIComponent(url.username);
  return {
    url: `${url.protocol}//${url.host}${prefix}/api/${projectId}/envelope/`,
    auth: `Sentry sentry_version=7, sentry_key=${key}, sentry_client=${SENTRY_CLIENT}`,
  };
}

/** `null` (inert) unless `CONSOLE_SENTRY_DSN` is a usable DSN. Never logs the value. */
export function resolveForwardTarget(env: NodeJS.ProcessEnv, logger?: WarnLogger): ForwardTarget | null {
  const raw = env["CONSOLE_SENTRY_DSN"]?.trim();
  if (!raw) return null;
  const config = resolveSentryConfig({ SENTRY_DSN: raw });
  if (config === null) {
    logger?.warn("console telemetry disabled: CONSOLE_SENTRY_DSN is not a valid DSN");
    return null;
  }
  return targetFromDsn(config.dsn);
}

@Injectable()
export class ConsoleTelemetryForwarder {
  private readonly target: ForwardTarget | null;
  private inFlight = 0;

  constructor(
    @Inject(CONSOLE_TELEMETRY_FETCH) private readonly fetchFn: TelemetryFetch,
    @Optional() @Inject(ROOT_LOGGER) private readonly logger?: Logger,
  ) {
    this.target = resolveForwardTarget(process.env, logger);
  }

  get enabled(): boolean {
    return this.target !== null;
  }

  /** Starts the forward and returns at once. Never throws. */
  forward(envelope: Buffer): void {
    const target = this.target;
    if (target === null || this.inFlight >= MAX_IN_FLIGHT_FORWARDS) return;
    this.inFlight += 1;
    void this.send(target, envelope).finally(() => {
      this.inFlight -= 1;
    });
  }

  private async send(target: ForwardTarget, envelope: Buffer): Promise<void> {
    try {
      const response = await this.fetchFn(target.url, {
        method: "POST",
        headers: { "Content-Type": "application/x-sentry-envelope", "X-Sentry-Auth": target.auth },
        body: envelope,
        redirect: "error",
        signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
      });
      await response.body?.cancel().catch(() => undefined);
      if (response.status < 200 || response.status >= 300) {
        this.logger?.warn({ status: response.status }, "console telemetry: upstream rejected envelope");
      }
    } catch {
      this.logger?.warn("console telemetry: forward failed");
    }
  }
}
