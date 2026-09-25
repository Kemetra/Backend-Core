/**
 * InProgressMarker — T522.
 *
 * Redis-backed in-flight marker for the HTTP idempotency layer.
 *
 * Uses `SET key value NX EX ttlSec` (atomic, expires if the origin request
 * crashes before cleanup). The caller passes a tuple that already includes
 * tenantId (`composeTuple`); this class only hashes that string. It does
 * not add a tenant of its own.
 *
 * Storage key format: `idem:inflight:<hex16(sha256(tuple))>`
 * Payload: minimal — just `"1"`. No PII, no original-request data.
 *
 * References: strategy.md §9.
 */
import { Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";

/** Minimal Redis surface the marker needs (superset of what AlwaysAllowRedis provides). */
export interface InflightRedis {
  /**
   * SET key value NX EX ttlSeconds.
   * Returns "OK" if the key was set (we won the race), null if already present.
   */
  set(
    key: string,
    value: string,
    options: { nx: true; ex: number },
  ): Promise<"OK" | null>;
  /** DEL key — best-effort cleanup. */
  del(key: string): Promise<number>;
}

export const INFLIGHT_REDIS = Symbol.for("api.idempotency.inflightRedis");

/** Default in-flight TTL: 60 seconds (strategy.md §9.2). */
export const DEFAULT_INFLIGHT_TTL_SEC = 60;

@Injectable()
export class InProgressMarker {
  constructor(private readonly redis: InflightRedis) {}

  /**
   * Attempt to set the in-flight marker atomically.
   *
   * @returns true  — marker set successfully (this request "owns" the slot)
   *          false — marker already present (another request is in flight)
   */
  async trySet(tuple: string, ttlSec = DEFAULT_INFLIGHT_TTL_SEC): Promise<boolean> {
    const key = this.markerKey(tuple);
    const result = await this.redis.set(key, "1", { nx: true, ex: ttlSec });
    return result === "OK";
  }

  /**
   * Best-effort cleanup. Errors are swallowed — the TTL is the authoritative
   * cleanup mechanism (strategy.md §9.3).
   */
  async del(tuple: string): Promise<void> {
    const key = this.markerKey(tuple);
    await this.redis.del(key).catch(() => undefined);
  }

  private markerKey(tuple: string): string {
    const hash = createHash("sha256").update(tuple).digest("hex").slice(0, 32);
    return `idem:inflight:${hash}`;
  }
}
