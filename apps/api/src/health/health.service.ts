/**
 * HealthService — readiness checks behind GET /api/v1/health/ready (RT-144).
 *
 * Readiness means every dependency required to serve traffic answered in
 * time: the domain pool, the auth lookup pool (every authenticated request
 * resolves its credential there first) and Redis (rate limits, idempotency).
 *
 * Bounded: each check races a short timeout, and concurrent callers share one
 * in-flight run, so an anonymous caller cannot multiply database or Redis
 * load by polling. The report holds fixed values only; failure detail goes to
 * the server log as the check name and an error code, never error text.
 */
import { Inject, Injectable, Optional } from "@nestjs/common";
import type { Pool } from "pg";
import type { Logger } from "@data-pulse-2/shared";

import { AUTH_LOOKUP_POOL, PG_POOL, REDIS_CLIENT } from "../auth/auth.module";
import type { RedisLike } from "../auth/rate-limit";
import { ROOT_LOGGER } from "../common/logging.interceptor";

export const HEALTH_CHECK_TIMEOUT_MS = 2_000;

/** A key that is never written: PTTL is a read-only Redis round trip. */
const REDIS_PROBE_KEY = "health:readiness-probe";

export type CheckName = "database" | "auth_database" | "redis";
export type CheckResult = "ok" | "failed";

export interface ReadinessReport {
  status: "ready" | "not_ready";
  checks: Record<CheckName, CheckResult>;
}

@Injectable()
export class HealthService {
  private inFlight: Promise<ReadinessReport> | null = null;

  constructor(
    @Inject(PG_POOL) private readonly domainPool: Pool,
    @Inject(AUTH_LOOKUP_POOL) private readonly lookupPool: Pool,
    @Inject(REDIS_CLIENT) private readonly redis: RedisLike,
    @Optional() @Inject(ROOT_LOGGER) private readonly logger?: Logger,
  ) {}

  readiness(): Promise<ReadinessReport> {
    if (this.inFlight === null) {
      this.inFlight = this.runChecks().finally(() => {
        this.inFlight = null;
      });
    }
    return this.inFlight;
  }

  private async runChecks(): Promise<ReadinessReport> {
    const [database, authDatabase, redis] = await Promise.all([
      this.check("database", () => this.domainPool.query("SELECT 1")),
      this.check("auth_database", () => this.lookupPool.query("SELECT 1")),
      this.check("redis", () => this.redis.pttl(REDIS_PROBE_KEY)),
    ]);
    const checks = { database, auth_database: authDatabase, redis };
    const ready = Object.values(checks).every((result) => result === "ok");
    return { status: ready ? "ready" : "not_ready", checks };
  }

  private async check(name: CheckName, probe: () => Promise<unknown>): Promise<CheckResult> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new HealthCheckTimeout()), HEALTH_CHECK_TIMEOUT_MS);
    });
    try {
      await Promise.race([probe(), timeout]);
      return "ok";
    } catch (err) {
      this.logger?.warn({ check: name, code: errorCode(err) }, "readiness check failed");
      return "failed";
    } finally {
      clearTimeout(timer);
    }
  }
}

class HealthCheckTimeout extends Error {
  readonly code = "TIMEOUT";
}

function errorCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Z0-9_]{1,32}$/.test(code) ? code : "ERROR";
}
