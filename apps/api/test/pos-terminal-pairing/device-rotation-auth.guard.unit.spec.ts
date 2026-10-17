/**
 * RT-370 — the rotate guard records device activity only for a rotation it
 * allows (a refused token, known or unknown, is never "seen").
 */
import "reflect-metadata";

import type { ExecutionContext } from "@nestjs/common";
import { UnauthorizedException } from "@nestjs/common";
import { hashToken } from "@data-pulse-2/auth";

import type { DeviceRepository, RotationLookup } from "../../src/pos-operators/device.repository";
import { DeviceRotationAuthGuard } from "../../src/pos-terminal-pairing/device-rotation-auth.guard";
import type { RotationService } from "../../src/pos-terminal-pairing/rotation.service";

const TOKEN = "rt370-rotation-guard-token-aaaaaaaaaaaaaaaa";
const DEVICE_ID = "0a000000-0000-7000-8000-0000000d0372";
const TENANT_ID = "0a000000-0000-7000-8000-0000000a0372";
const STORE_ID = "0a000000-0000-7000-8000-0000000b0372";
const DAY = 86_400_000;

function lookup(expiresInMs: number, revoked = false): RotationLookup {
  const now = new Date("2026-10-17T12:00:00Z");
  return {
    id: DEVICE_ID,
    tenantId: TENANT_ID,
    storeId: STORE_ID,
    state: {
      tokenHash: hashToken(TOKEN),
      previousTokenHash: null,
      previousValidUntil: null,
      revokedAt: revoked ? now : null,
      retiredAt: null,
      expiresAt: new Date(now.getTime() + expiresInMs),
      now,
    },
  };
}

function harness(found: RotationLookup | null): {
  guard: DeviceRotationAuthGuard;
  recordActivity: jest.Mock;
  ctx: ExecutionContext;
} {
  const recordActivity = jest.fn();
  const devices = {
    findForRotation: jest.fn(async () => found),
    recordActivity,
  } as unknown as DeviceRepository;
  const rotation = { recordRejection: jest.fn(async () => undefined) } as unknown as RotationService;
  const request = { headers: { authorization: `Bearer ${TOKEN}` } };
  const ctx = { switchToHttp: () => ({ getRequest: () => request }) } as unknown as ExecutionContext;
  return { guard: new DeviceRotationAuthGuard(devices, rotation), recordActivity, ctx };
}

describe("DeviceRotationAuthGuard — device activity (RT-370)", () => {
  it.each([
    ["an unexpired device", 30 * DAY],
    ["an expired device inside the 7-day grace", -3 * DAY],
  ])("%s: allowed → recorded once", async (_label, expiresInMs) => {
    const { guard, recordActivity, ctx } = harness(lookup(expiresInMs));
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(recordActivity).toHaveBeenCalledTimes(1);
    expect(recordActivity).toHaveBeenCalledWith({ id: DEVICE_ID, tenantId: TENANT_ID });
  });

  it.each([
    ["past the grace", lookup(-8 * DAY)],
    ["revoked", lookup(30 * DAY, true)],
    ["unknown token", null],
  ])("%s: 401 and not recorded", async (_label, found) => {
    const { guard, recordActivity, ctx } = harness(found);
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(recordActivity).not.toHaveBeenCalled();
  });
});
