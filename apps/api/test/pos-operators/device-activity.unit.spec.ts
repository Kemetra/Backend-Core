/**
 * RT-370 (RT-138 L7) — the throttled device activity writer, unit level (no
 * Postgres). The cross-replica half of the throttle (the conditional UPDATE)
 * and the real domain role are proven in
 * `test/auth/tenant-status-device-auth.http.integration.spec.ts`.
 */
import "reflect-metadata";

import type { Pool } from "pg";

import {
  DEVICE_ACTIVITY_INTERVAL_MS,
  DEVICE_ACTIVITY_MAX_TRACKED,
  DeviceActivityRecorder,
} from "../../src/pos-operators/device-activity";

const DEVICE = { id: "0a000000-0000-7000-8000-0000000d0370", tenantId: "0a000000-0000-7000-8000-0000000a0370" };
const OTHER = { id: "0a000000-0000-7000-8000-0000000d0371", tenantId: DEVICE.tenantId };

/** A domain pool whose tenant-context client records every statement. */
function domainPool(opts: { failOn?: RegExp } = {}): { pool: Pool; statements: string[]; params: unknown[][] } {
  const statements: string[] = [];
  const params: unknown[][] = [];
  const client = {
    query: jest.fn(async (text: string, values?: unknown[]) => {
      statements.push(text);
      params.push(values ?? []);
      if (opts.failOn?.test(text)) throw Object.assign(new Error("permission denied"), { code: "42501" });
      return { rows: [], rowCount: 1 };
    }),
    release: jest.fn(),
  };
  return { pool: { connect: jest.fn(async () => client) } as unknown as Pool, statements, params };
}

const touches = (statements: string[]): string[] => statements.filter((s) => /\bupdate\s+devices\b/i.test(s));

describe("DeviceActivityRecorder (RT-370)", () => {
  it("N authentications of one device inside the interval issue exactly one write", async () => {
    let now = 1_000_000;
    const recorder = new DeviceActivityRecorder(() => now);
    const { pool, statements } = domainPool();
    for (let i = 0; i < 10; i += 1) {
      recorder.record(pool, DEVICE);
      now += 20_000; // 10 × 20 s = 200 s < 5 min
    }
    await recorder.flush();
    expect(touches(statements)).toHaveLength(1);
  });

  it("a write is issued again once the interval has passed", async () => {
    let now = 1_000_000;
    const recorder = new DeviceActivityRecorder(() => now);
    const { pool, statements } = domainPool();
    recorder.record(pool, DEVICE);
    now += DEVICE_ACTIVITY_INTERVAL_MS;
    recorder.record(pool, DEVICE);
    await recorder.flush();
    expect(touches(statements)).toHaveLength(2);
  });

  it("each device is throttled on its own", async () => {
    const recorder = new DeviceActivityRecorder(() => 1_000_000);
    const { pool, statements } = domainPool();
    recorder.record(pool, DEVICE);
    recorder.record(pool, OTHER);
    recorder.record(pool, DEVICE);
    await recorder.flush();
    expect(touches(statements)).toHaveLength(2);
  });

  it("writes under the device's own tenant context, conditionally, never on a revoked device, skipping a locked row", async () => {
    const recorder = new DeviceActivityRecorder(() => 1_000_000);
    const { pool, statements, params } = domainPool();
    recorder.record(pool, DEVICE);
    await recorder.flush();
    const tenantSet = statements.findIndex((s) => /app\.current_tenant/.test(s));
    expect(params[tenantSet]).toEqual([DEVICE.tenantId]);
    const [touch] = touches(statements);
    expect(touch).toMatch(/last_seen_at\s*=\s*now\(\)/i);
    expect(touch).toMatch(/revoked_at IS NULL/);
    expect(touch).toMatch(/last_seen_at IS NULL OR last_seen_at < now\(\) - make_interval/);
    // NO KEY: never blocks an FK check (FOR KEY SHARE) of a sale or shift on the device.
    expect(touch).toMatch(/FOR NO KEY UPDATE SKIP LOCKED/);
    const touchParams = params[statements.indexOf(touch!)];
    expect(touchParams).toEqual([DEVICE.id, DEVICE.tenantId, DEVICE_ACTIVITY_INTERVAL_MS / 1000]);
  });

  it("does not run the write on the caller's tick (the request never waits for it)", async () => {
    const recorder = new DeviceActivityRecorder(() => 1_000_000);
    const { pool, statements } = domainPool();
    recorder.record(pool, DEVICE);
    expect(statements).toHaveLength(0);
    await recorder.flush();
    expect(touches(statements)).toHaveLength(1);
  });

  it("a failed write is swallowed: record() does not throw and flush() resolves", async () => {
    const recorder = new DeviceActivityRecorder(() => 1_000_000);
    const { pool } = domainPool({ failOn: /\bupdate\s+devices\b/i });
    expect(() => recorder.record(pool, DEVICE)).not.toThrow();
    await expect(recorder.flush()).resolves.toBeUndefined();
  });

  it("a pool that cannot even connect is swallowed too", async () => {
    const recorder = new DeviceActivityRecorder(() => 1_000_000);
    const pool = { connect: jest.fn().mockRejectedValue(new Error("pool ended")) } as unknown as Pool;
    expect(() => recorder.record(pool, DEVICE)).not.toThrow();
    await expect(recorder.flush()).resolves.toBeUndefined();
  });

  it("a failed write still holds the throttle (no retry storm against a failing database)", async () => {
    let now = 1_000_000;
    const recorder = new DeviceActivityRecorder(() => now);
    const { pool, statements } = domainPool({ failOn: /\bupdate\s+devices\b/i });
    recorder.record(pool, DEVICE);
    await recorder.flush();
    now += 1_000;
    recorder.record(pool, DEVICE);
    await recorder.flush();
    expect(touches(statements)).toHaveLength(1);
  });

  it("keeps at most DEVICE_ACTIVITY_MAX_TRACKED marks, dropping the oldest", async () => {
    const recorder = new DeviceActivityRecorder(() => 1_000_000);
    const { pool } = domainPool();
    for (let i = 0; i <= DEVICE_ACTIVITY_MAX_TRACKED; i += 1) {
      recorder.record(pool, { id: `device-${i}`, tenantId: DEVICE.tenantId });
    }
    await recorder.flush();
    expect(recorder.trackedCount()).toBe(DEVICE_ACTIVITY_MAX_TRACKED);
  });

  it("reset() forgets every mark", async () => {
    const recorder = new DeviceActivityRecorder(() => 1_000_000);
    const { pool, statements } = domainPool();
    recorder.record(pool, DEVICE);
    recorder.reset();
    recorder.record(pool, DEVICE);
    await recorder.flush();
    expect(touches(statements)).toHaveLength(2);
  });
});
