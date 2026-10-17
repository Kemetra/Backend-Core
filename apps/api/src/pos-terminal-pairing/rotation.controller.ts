/**
 * RT-369 — `posRotateTerminalToken`: POST /api/pos/v1/terminals/rotate
 * (pos-terminal-pairing.openapi.yaml 1.2.0-draft).
 *
 * Refusal order (the contract's): the device guard's 401, the per-device
 * rotation budget's 429 (`PosWriteRateLimitGuard`, ADR 0009, fail-open),
 * then the idempotency interceptor's 400 / 425 / 409, then the service's
 * locked re-check (401), then 200. No request body is read. The 200 carries
 * the new token, so it is never cached (`no-store`, `Pragma: no-cache`).
 *
 * `@Idempotent("required", { replay: "forbid", clientScope: "device" })`:
 * the new token is never stored for replay (RT-82 K3), a same-key retry is
 * 409 `idempotency_key_conflict`, and the key is scoped to the authenticated
 * device. Not `@Auditable`: the 200 carries a SECRET; the service writes the
 * `pos.device.*` rows itself.
 */
import { Controller, Header, HttpCode, HttpStatus, Post, Req, UnauthorizedException, UseGuards } from "@nestjs/common";

import { PosWriteRateLimitBucket } from "../auth/pos-write-rate-limit.decorator";
import { PosWriteRateLimitGuard } from "../auth/pos-write-rate-limit.guard";
import { DeviceBearer } from "../auth/route-auth";
import { Idempotent } from "../idempotency/idempotent.decorator";
import { DeviceRotationAuthGuard, type RotationRequest } from "./device-rotation-auth.guard";
import { RotationService, type TerminalRotateResponseBody } from "./rotation.service";

@Controller()
export class RotationController {
  constructor(private readonly rotation: RotationService) {}

  @Post("api/pos/v1/terminals/rotate")
  @HttpCode(HttpStatus.OK)
  @DeviceBearer()
  @UseGuards(DeviceRotationAuthGuard, PosWriteRateLimitGuard)
  @PosWriteRateLimitBucket("posRotateDevice")
  @Header("Cache-Control", "no-store")
  @Header("Pragma", "no-cache")
  @Idempotent("required", { replay: "forbid", replayMarkerFields: ["terminal_id"], clientScope: "device" })
  async rotate(@Req() request: RotationRequest): Promise<TerminalRotateResponseBody> {
    const context = request.context;
    const deviceId = request.posDeviceId;
    const presentedHash = request.rotationPresentedHash;
    if (!context?.tenantId || !context.storeId || !deviceId || !presentedHash) throw unauthorized();

    const result = await this.rotation.rotate(
      { tenantId: context.tenantId, storeId: context.storeId, deviceId },
      presentedHash,
    );
    if (result.kind === "rejected") throw unauthorized();
    return result.body;
  }
}

function unauthorized(): UnauthorizedException {
  return new UnauthorizedException("Unauthorized");
}
