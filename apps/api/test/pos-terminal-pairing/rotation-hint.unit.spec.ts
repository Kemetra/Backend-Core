/**
 * RT-639 — the "rotate soon" hint on device-token responses.
 *
 * `computeRotationHint` is pure: from the device's `expires_at` and the clock
 * it says whether to hint and at which stage (15 / 10 / 3 days left).
 * `applyRotationHint` writes the two response headers.
 */
import { of, throwError, lastValueFrom } from "rxjs";
import type { CallHandler, ExecutionContext } from "@nestjs/common";

import {
  DeviceRotationHintInterceptor,
  ROTATE_AFTER_HEADER,
  ROTATE_STAGE_HEADER,
  ROTATION_HINT_LEAD_MS,
  applyRotationHint,
  computeRotationHint,
} from "../../src/pos-terminal-pairing/rotation-hint";

const DAY = 86_400_000;
const NOW = new Date("2027-01-01T12:00:00.000Z");

/** A device whose token has exactly `ms` left at NOW. */
const expiringIn = (ms: number): Date => new Date(NOW.getTime() + ms);

describe("computeRotationHint (RT-639)", () => {
  it("is null while more than 15 days remain", () => {
    expect(computeRotationHint(expiringIn(90 * DAY), NOW)).toBeNull();
    expect(computeRotationHint(expiringIn(15 * DAY + 1), NOW)).toBeNull();
  });

  it.each([
    ["exactly 15 days", 15 * DAY, "notice"],
    ["14 days", 14 * DAY, "notice"],
    ["10 days and 1 ms", 10 * DAY + 1, "notice"],
    ["exactly 10 days", 10 * DAY, "warning"],
    ["5 days", 5 * DAY, "warning"],
    ["3 days and 1 ms", 3 * DAY + 1, "warning"],
    ["exactly 3 days", 3 * DAY, "urgent"],
    ["1 day", DAY, "urgent"],
    ["expiring now", 0, "urgent"],
    ["already expired (rotate-only grace)", -2 * DAY, "urgent"],
  ])("stage at %s left is %s", (_label, remainingMs, stage) => {
    expect(computeRotationHint(expiringIn(remainingMs), NOW)?.stage).toBe(stage);
  });

  it("rotateAfter is always expires_at - 15 days, the same instant the rotate response gives", () => {
    const expiresAt = expiringIn(4 * DAY);
    const hint = computeRotationHint(expiresAt, NOW);

    expect(hint?.rotateAfter.getTime()).toBe(expiresAt.getTime() - 15 * DAY);
    expect(ROTATION_HINT_LEAD_MS).toBe(15 * DAY);
  });
});

describe("applyRotationHint (RT-639)", () => {
  const makeRes = () => {
    const headers: Record<string, string> = {};
    return { headers, setHeader: (k: string, v: string) => void (headers[k] = v) };
  };

  it("sets Rotate-After as an ISO-8601 instant and the stage", () => {
    const res = makeRes();
    const expiresAt = expiringIn(12 * DAY);

    applyRotationHint(res, expiresAt, NOW);

    expect(res.headers[ROTATE_AFTER_HEADER]).toBe(new Date(expiresAt.getTime() - 15 * DAY).toISOString());
    expect(res.headers[ROTATE_STAGE_HEADER]).toBe("notice");
  });

  it("sets nothing while more than 15 days remain", () => {
    const res = makeRes();

    applyRotationHint(res, expiringIn(60 * DAY), NOW);

    expect(res.headers).toEqual({});
  });

  it("uses the contract's header names", () => {
    expect(ROTATE_AFTER_HEADER).toBe("X-Device-Token-Rotate-After");
    expect(ROTATE_STAGE_HEADER).toBe("X-Device-Token-Rotate-Stage");
  });
});

describe("DeviceRotationHintInterceptor (RT-639)", () => {
  /** The interceptor reads the real clock, unlike the pure functions above. */
  const realExpiringIn = (ms: number): Date => new Date(Date.now() + ms);
  const makeCtx = (expiry: Date | undefined) => {
    const headers: Record<string, string> = {};
    const ctx = {
      switchToHttp: () => ({
        getRequest: () => ({ deviceRotationExpiry: expiry }),
        getResponse: () => ({ setHeader: (k: string, v: string) => void (headers[k] = v) }),
      }),
    } as unknown as ExecutionContext;
    return { ctx, headers };
  };
  const ok: CallHandler = { handle: () => of("body") };
  const failing: CallHandler = { handle: () => throwError(() => new Error("handler failed")) };

  it("sets the headers once the handler succeeded", async () => {
    const { ctx, headers } = makeCtx(realExpiringIn(2 * DAY));

    await expect(lastValueFrom(new DeviceRotationHintInterceptor().intercept(ctx, ok))).resolves.toBe("body");

    expect(headers[ROTATE_STAGE_HEADER]).toBe("urgent");
    expect(headers[ROTATE_AFTER_HEADER]).toBeDefined();
  });

  it("sets nothing while the handler has not answered, and nothing when it fails", async () => {
    const { ctx, headers } = makeCtx(realExpiringIn(2 * DAY));

    await expect(lastValueFrom(new DeviceRotationHintInterceptor().intercept(ctx, failing))).rejects.toThrow("handler failed");

    expect(headers).toEqual({});
  });

  it("sets nothing when the guard recorded no expiry (not a device-token request)", async () => {
    const { ctx, headers } = makeCtx(undefined);

    await lastValueFrom(new DeviceRotationHintInterceptor().intercept(ctx, ok));

    expect(headers).toEqual({});
  });

  it("sets nothing while more than 15 days remain", async () => {
    const { ctx, headers } = makeCtx(realExpiringIn(60 * DAY));

    await lastValueFrom(new DeviceRotationHintInterceptor().intercept(ctx, ok));

    expect(headers).toEqual({});
  });
});
