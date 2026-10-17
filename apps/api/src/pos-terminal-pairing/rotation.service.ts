/**
 * RT-369 (RT-287 F6; RT-138 L4 / DL-4) — the device token rotation
 * (`posRotateTerminalToken`, pos-terminal-pairing.openapi.yaml 1.2.0-draft).
 *
 * The guard (`DeviceRotationAuthGuard`) has already classified the presented
 * token on an unlocked read. Here, in ONE transaction on the domain pool
 * under the device's tenant (RLS; the lookup role stays SELECT-only, RT-138
 * §3): the lifecycle lock, the row lock, the same decision again on the
 * locked row (a revoke, retire or rotation may have committed meanwhile),
 * then the token swap and `pos.device.rotated`. A refusal under the lock
 * ends that transaction with no write, then records
 * `pos.device.rotation_rejected` in its own transaction (contract R2).
 *
 * Every refusal row is bounded per matched device (contract R1): the refusal
 * spends from the `posRotateRefusalAudit` bucket first, and once it is spent
 * no row is written (a warn log counts the suppression). That bucket is
 * separate from the rotation budget (`posRotateDevice`), so a refused token
 * can never make a valid rotation 429. A limiter outage fails open (the row
 * is written), as ADR 0009 D3.
 *
 * The new raw token leaves this service once, in the result; only its
 * SHA-256 is written. Never logged.
 */
import { Inject, Injectable, Optional } from "@nestjs/common";
import { generateRawToken, hashToken } from "@data-pulse-2/auth";
import { runWithTenantContext } from "@data-pulse-2/db";
import type { Logger } from "@data-pulse-2/shared";
import type { Pool } from "pg";

import { PG_POOL } from "../auth/auth.module";
import { POS_WRITE_RATE_LIMIT_BUCKETS, RateLimiter } from "../auth/rate-limit";
import { ROOT_LOGGER } from "../common/logging.interceptor";
import { decideRotation, type RotationRejectReason } from "./rotation-decision";
import {
  applyRotation,
  auditRotated,
  auditRotationRejected,
  lockDeviceForRotation,
  type RotationTarget,
} from "./rotation.store";

/** The 200 body (TerminalRotateResponse). */
export interface TerminalRotateResponseBody {
  readonly device_token: string;
  readonly terminal_id: string;
  readonly expires_at: string;
  readonly rotate_after: string;
}

export type RotationResult =
  | { readonly kind: "rotated"; readonly body: TerminalRotateResponseBody }
  | { readonly kind: "rejected" };

@Injectable()
export class RotationService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly rateLimiter: RateLimiter,
    @Optional() @Inject(ROOT_LOGGER) private readonly logger?: Pick<Logger, "warn">,
  ) {}

  /** Rotate the device's token; `presentedHash` is the hash of the bearer that authenticated. */
  async rotate(target: RotationTarget, presentedHash: Buffer): Promise<RotationResult> {
    const outcome = await this.rotateLocked(target, presentedHash);
    if (outcome.kind === "refused") {
      if (outcome.reason !== null) await this.recordRejection(target, outcome.reason);
      return { kind: "rejected" };
    }
    return outcome;
  }

  /** The locked transaction: rotate, or end with no write and say why it refused. */
  private rotateLocked(
    target: RotationTarget,
    presentedHash: Buffer,
  ): Promise<RotationResult | { readonly kind: "refused"; readonly reason: RotationRejectReason | null }> {
    return runWithTenantContext(this.pool, { tenantId: target.tenantId, isPlatformAdmin: false }, async (client) => {
      const state = await lockDeviceForRotation(client, target);
      if (state === null) return { kind: "refused", reason: null };
      const decision = decideRotation(state, presentedHash);
      if (decision.kind === "rejected") return { kind: "refused", reason: decision.reason };
      const rawToken = generateRawToken();
      const write = await applyRotation(client, target, decision.credential, hashToken(rawToken));
      await auditRotated(client, target, { credential: decision.credential, inGrace: decision.inGrace, write });
      return {
        kind: "rotated",
        body: {
          device_token: rawToken,
          terminal_id: target.deviceId,
          expires_at: write.expiresAt.toISOString(),
          rotate_after: write.rotateAfter.toISOString(),
        },
      };
    });
  }

  /**
   * `pos.device.rotation_rejected` in its own transaction, within the
   * device's refusal-audit budget (`posRotateRefusalAudit`), never the
   * rotation budget. A failed audit write never turns the 401 into a 5xx; it
   * is logged without any token material.
   */
  async recordRejection(target: RotationTarget, reason: RotationRejectReason): Promise<void> {
    if (!(await this.withinBudget(target, reason))) return;
    try {
      await runWithTenantContext(this.pool, { tenantId: target.tenantId, isPlatformAdmin: false }, (client) =>
        auditRotationRejected(client, target, reason),
      );
    } catch (err: unknown) {
      this.logger?.warn(
        {
          event: "pos.device.rotation_rejected.audit_failed",
          tenant_id: target.tenantId,
          device_id: target.deviceId,
          reason,
          error_class: err instanceof Error ? err.name : typeof err,
        },
        "rotation refusal audit write failed",
      );
    }
  }

  /** Spend one unit of the device's refusal-audit budget; false once it is spent (fail-open on a limiter outage). */
  private async withinBudget(target: RotationTarget, reason: RotationRejectReason): Promise<boolean> {
    try {
      const decision = await this.rateLimiter.check(
        "posRotateRefusalAudit",
        target.deviceId,
        POS_WRITE_RATE_LIMIT_BUCKETS.posRotateRefusalAudit,
      );
      if (decision.allowed) return true;
      this.logger?.warn(
        { event: "pos.device.rotation_rejected.suppressed", tenant_id: target.tenantId, device_id: target.deviceId, reason },
        "rotation refusal audit suppressed: the device's refusal-audit budget is spent",
      );
      return false;
    } catch (err: unknown) {
      this.logger?.warn(
        {
          event: "pos.device.rotation_rejected.budget_unavailable",
          tenant_id: target.tenantId,
          device_id: target.deviceId,
          error_class: err instanceof Error ? err.name : typeof err,
        },
        "refusal-audit budget unavailable; failing open (refusal audited)",
      );
      return true;
    }
  }
}
