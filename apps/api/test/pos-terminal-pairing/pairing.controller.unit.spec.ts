import "reflect-metadata";

import { HttpException, NotFoundException } from "@nestjs/common";
import type { Request, Response } from "express";

import type { RateLimiter } from "../../src/auth/rate-limit";
import { PairingController } from "../../src/pos-terminal-pairing/pairing.controller";
import type { PairingService } from "../../src/pos-terminal-pairing/pairing.service";

function requestWithIp(ip: string): Request {
  return {
    ip,
    headers: { "x-forwarded-for": "203.0.113.250" },
    socket: { remoteAddress: ip },
  } as unknown as Request;
}

function responseStub(): jest.Mocked<Pick<Response, "setHeader">> {
  return { setHeader: jest.fn() };
}

describe("PairingController source-IP limiter", () => {
  it("counts an unknown pairing code before returning the non-disclosing 404", async () => {
    const pair = jest.fn().mockResolvedValue({ kind: "invalid" });
    const check = jest.fn().mockResolvedValue({
      allowed: true,
      count: 1,
      remaining: 29,
      resetMs: 60_000,
    });
    const controller = new PairingController(
      { pair } as unknown as PairingService,
      { check } as unknown as RateLimiter,
    );

    await expect(
      controller.pair(
        { pairing_code: "UNKNOWN-001" },
        requestWithIp("192.0.2.10"),
        responseStub() as unknown as Response,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(check).toHaveBeenCalledWith(
      "pairing_ip",
      "192.0.2.10",
      expect.objectContaining({ limit: 30 }),
    );
    expect(pair).toHaveBeenCalledTimes(1);
  });

  it("returns 429 with bounded Retry-After before code lookup", async () => {
    const pair = jest.fn();
    const check = jest.fn().mockResolvedValue({
      allowed: false,
      count: 31,
      remaining: 0,
      resetMs: 999_000,
    });
    const res = responseStub();
    const controller = new PairingController(
      { pair } as unknown as PairingService,
      { check } as unknown as RateLimiter,
    );

    let thrown: unknown;
    try {
      await controller.pair(
        { pairing_code: "UNKNOWN-002" },
        requestWithIp("192.0.2.11"),
        res as unknown as Response,
      );
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(HttpException);
    expect((thrown as HttpException).getStatus()).toBe(429);
    expect(res.setHeader).toHaveBeenCalledWith("Retry-After", "300");
    expect(pair).not.toHaveBeenCalled();
  });

  it("uses Express req.ip and never parses an untrusted forwarded header", async () => {
    const pair = jest.fn().mockResolvedValue({ kind: "invalid" });
    const check = jest.fn().mockResolvedValue({
      allowed: true,
      count: 1,
      remaining: 29,
      resetMs: 60_000,
    });
    const controller = new PairingController(
      { pair } as unknown as PairingService,
      { check } as unknown as RateLimiter,
    );

    await expect(
      controller.pair(
        { pairing_code: "UNKNOWN-003" },
        requestWithIp("192.0.2.12"),
        responseStub() as unknown as Response,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(check.mock.calls[0]?.[1]).toBe("192.0.2.12");
    expect(check.mock.calls[0]?.[1]).not.toBe("203.0.113.250");
  });
});
