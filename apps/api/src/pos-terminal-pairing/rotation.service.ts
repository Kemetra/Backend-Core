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
 * writes `pos.device.rotation_rejected` and changes nothing else.
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
    @Optional() @Inject(ROOT_LOGGER) private readonly logger?: Pick<Logger, "warn">,
  ) {}

  /** Rotate the device's token; `presentedHash` is the hash of the bearer that authenticated. */
  rotate(target: RotationTarget, presentedHash: Buffer): Promise<RotationResult> {
    return runWithTenantContext(this.pool, { tenantId: target.tenantId, isPlatformAdmin: false }, async (client) => {
      const state = await lockDeviceForRotation(client, target);
      if (state === null) return { kind: "rejected" };
      const decision = decideRotation(state, presentedHash);
      if (decision.kind === "rejected") {
        await auditRotationRejected(client, target, decision.reason);
        return { kind: "rejected" };
      }
      const rawToken = generateRawToken();
      const write = await applyRotation(client, target, decision.credential, hashToken(rawToken));
      await auditRotated(client, target, decision.credential, decision.inGrace, write);
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
   * `pos.device.rotation_rejected` for a refusal the guard decided (no lock:
   * nothing changes). A failed audit write never turns the 401 into a 5xx;
   * it is logged without any token material.
   */
  async recordRejection(target: RotationTarget, reason: RotationRejectReason): Promise<void> {
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
}
