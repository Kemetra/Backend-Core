/**
 * DeviceHeartbeatController: RT-327 runtime of `posReportDeviceHeartbeat`
 * (`packages/contracts/openapi/pos-device-health.openapi.yaml`):
 *
 *   POST /api/pos/v1/terminals/heartbeat
 *
 * Auth: the role-named `device` scheme only: `@DeviceBearer()` +
 * `PosDeviceAuthGuard`. Device, tenant and store come from the device row the
 * guard resolved, never from the body. The RT-719 `X-POS-*` headers are not
 * read here: the heartbeat is not a build-identity reporting operation.
 *
 * Outcome order: the guard answers 401 first, the Zod pipe 400 (a closed
 * body: unknown and identity keys are refused and nothing is stored), then
 * the reply is a 200 whether the beat was stored or throttled.
 */
import { Body, Controller, Header, HttpCode, HttpStatus, Post, Req, UseGuards } from "@nestjs/common";

import { PosDeviceAuthGuard } from "../auth/pos-device-auth.guard";
import { DeviceBearer } from "../auth/route-auth";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import type { TenantContextRequest } from "../context/types";
import { deviceScopeOf } from "../pos-cashier-admissions/device-scope";
import { HeartbeatReportSchema, type HeartbeatReport } from "./dto";
import type { HeartbeatAckBody } from "./heartbeat-ack";
import { DeviceHeartbeatService } from "./heartbeat.service";

@Controller("api/pos/v1/terminals")
@DeviceBearer()
@UseGuards(PosDeviceAuthGuard)
export class DeviceHeartbeatController {
  constructor(private readonly service: DeviceHeartbeatService) {}

  @Post("heartbeat")
  @HttpCode(HttpStatus.OK)
  @Header("Cache-Control", "no-store")
  async heartbeat(
    @Req() request: TenantContextRequest,
    @Body(new ZodValidationPipe(HeartbeatReportSchema)) body: HeartbeatReport,
  ): Promise<HeartbeatAckBody> {
    return this.service.report(deviceScopeOf(request), body);
  }
}
