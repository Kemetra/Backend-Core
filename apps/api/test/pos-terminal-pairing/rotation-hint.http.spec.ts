/**
 * RT-639 — the rotate-soon hint reaches the HTTP response.
 *
 * Docker-free: a real `PosDeviceAuthGuard` on `@DeviceBearer()` probe routes
 * inside a Nest app, over a fake `DeviceRepository`. Proves the hint reaches the
 * wire on a success, and not on a handler error (through the global exception
 * filter) nor for a refused token.
 */
import "reflect-metadata";

import { Controller, Get, type INestApplication, ConflictException, UseGuards } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { PosDeviceAuthGuard } from "../../src/auth/pos-device-auth.guard";
import { DeviceBearer } from "../../src/auth/route-auth";
import { GlobalExceptionFilter } from "../../src/common/exception.filter";
import { DeviceRepository } from "../../src/pos-operators/device.repository";

const DAY = 86_400_000;

@Controller("probe")
@DeviceBearer()
@UseGuards(PosDeviceAuthGuard)
class ProbeController {
  @Get("ok")
  ok(): { ok: true } {
    return { ok: true };
  }

  @Get("conflict")
  conflict(): never {
    throw new ConflictException("conflict");
  }
}

let app: INestApplication;
let expiresInDays = 90;
/** Set to simulate a request that presented the previous (rotation overlap) token. */
let overlapEndsInMs: number | null = null;

beforeAll(async () => {
  const devices = {
    findActiveByAttestationWithExpiry: async (raw: string) =>
      raw === "good-token"
        ? {
            id: "0a000000-0000-7000-8000-0000000dev01",
            tenantId: "0a000000-0000-7000-8000-0000000ten01",
            storeId: "0a000000-0000-7000-8000-0000000sto01",
            expiresAt: new Date(Date.now() + expiresInDays * DAY),
            presentedPreviousUntil: overlapEndsInMs === null ? null : new Date(Date.now() + overlapEndsInMs),
          }
        : null,
  };
  const moduleRef = await Test.createTestingModule({
    controllers: [ProbeController],
    providers: [PosDeviceAuthGuard, { provide: DeviceRepository, useValue: devices }],
  }).compile();
  app = moduleRef.createNestApplication({ bufferLogs: true });
  app.useGlobalFilters(new GlobalExceptionFilter());
  await app.init();
});

afterAll(async () => {
  if (app) await app.close();
});

const call = (path: string, token = "good-token") =>
  request(app.getHttpServer()).get(path).set("Authorization", `Bearer ${token}`);

describe("rotate-soon hint on the wire (RT-639)", () => {
  it("more than 15 days left: no hint headers", async () => {
    expiresInDays = 60;
    const res = await call("/probe/ok");

    expect(res.status).toBe(200);
    expect(res.headers["x-device-token-rotate-after"]).toBeUndefined();
    expect(res.headers["x-device-token-rotate-stage"]).toBeUndefined();
  });

  it.each([
    [14, "notice"],
    [9, "warning"],
    [2, "urgent"],
  ])("%s days left: both headers, stage %s", async (days, stage) => {
    expiresInDays = days;
    const res = await call("/probe/ok");

    expect(res.status).toBe(200);
    expect(res.headers["x-device-token-rotate-stage"]).toBe(stage);
    const rotateAfter = res.headers["x-device-token-rotate-after"] as string;
    expect(new Date(rotateAfter).toISOString()).toBe(rotateAfter);
    expect(new Date(rotateAfter).getTime()).toBeCloseTo(Date.now() + (days - 15) * DAY, -4);
  });

  it("a previous-token request gets urgent even though the device's expiry was just reset", async () => {
    expiresInDays = 90;
    overlapEndsInMs = 5 * 60_000;
    try {
      const res = await call("/probe/ok");

      expect(res.status).toBe(200);
      expect(res.headers["x-device-token-rotate-stage"]).toBe("urgent");
    } finally {
      overlapEndsInMs = null;
    }
  });

  it("an error response carries no hint, even when the token is about to lapse", async () => {
    expiresInDays = 2;
    const res = await call("/probe/conflict");

    expect(res.status).toBe(409);
    expect(res.headers["x-device-token-rotate-after"]).toBeUndefined();
    expect(res.headers["x-device-token-rotate-stage"]).toBeUndefined();
  });

  it("a refused token gets 401 and no hint", async () => {
    expiresInDays = 2;
    const res = await call("/probe/ok", "unknown-token");

    expect(res.status).toBe(401);
    expect(res.headers["x-device-token-rotate-after"]).toBeUndefined();
    expect(res.headers["x-device-token-rotate-stage"]).toBeUndefined();
  });
});
