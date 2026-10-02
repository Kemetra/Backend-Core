/**
 * Health routes (RT-144), contract `health.openapi.yaml`.
 *
 * `@Public()`: deployment checks run without credentials. Liveness touches no
 * dependency; readiness answers 503 when a required dependency is down.
 */
import { Controller, Get, HttpStatus, Res } from "@nestjs/common";
import type { Response } from "express";

import { Public } from "../auth/route-auth";
import { HealthService, type ReadinessReport } from "./health.service";

@Public()
@Controller("api/v1/health")
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get("live")
  live(@Res({ passthrough: true }) res: Response): { status: "ok" } {
    res.setHeader("Cache-Control", "no-store");
    return { status: "ok" };
  }

  @Get("ready")
  async ready(@Res({ passthrough: true }) res: Response): Promise<ReadinessReport> {
    const report = await this.health.readiness();
    res.setHeader("Cache-Control", "no-store");
    res.status(report.status === "ready" ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return report;
  }
}
