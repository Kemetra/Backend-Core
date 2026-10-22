/**
 * RT-719: a failure to store the build identity is counted and swallowed: it
 * never reaches the request ("Throttled like the last-seen write"). A write that
 * is not a report is not counted at all, and no value is ever a metric label.
 */
import "reflect-metadata";

jest.mock("../../src/observability/metrics/api.metrics", () => {
  const actual = jest.requireActual("../../src/observability/metrics/api.metrics");
  return { ...actual, recordPosBuildIdentityReport: jest.fn() };
});

import type { Pool } from "pg";

import { recordPosBuildIdentityReport } from "../../src/observability/metrics/api.metrics";
import { DeviceActivityRecorder } from "../../src/pos-operators/device-activity";

const metric = recordPosBuildIdentityReport as jest.MockedFunction<typeof recordPosBuildIdentityReport>;
const DEVICE = { id: "07190000-0000-4000-8000-0000000e0001", tenantId: "07190000-0000-4000-8000-0000000a0001" };
const IDENTITY = { commit: "0123456789abcdef0123456789abcdef01234567", appVersion: "1.4.0", contractPin: null };

/** A pool whose connection fails: the write rejects. */
const failingPool = { connect: () => Promise.reject(Object.assign(new Error("boom"), { code: "57P01" })) } as unknown as Pool;

/** A pool whose transaction runs `statements` and reports `rowCount` for the update. */
function pool(rowCount: number): { pool: Pool; queries: Array<{ text: string; values: unknown[] | undefined }> } {
  const queries: Array<{ text: string; values: unknown[] | undefined }> = [];
  const client = {
    query: (text: string, values?: unknown[]) => {
      queries.push({ text, values });
      return Promise.resolve({ rowCount, rows: [] });
    },
    release: () => undefined,
  };
  return { pool: { connect: () => Promise.resolve(client) } as unknown as Pool, queries };
}

beforeEach(() => metric.mockClear());

describe("DeviceActivityRecorder: the build identity", () => {
  it("counts `failed` and swallows a store that fails", async () => {
    const recorder = new DeviceActivityRecorder();
    expect(() => recorder.record(failingPool, DEVICE, IDENTITY)).not.toThrow();
    await recorder.flush();
    expect(metric.mock.calls).toEqual([["failed"]]);
  });

  it("does not count a failed last-seen write that was not a report", async () => {
    const recorder = new DeviceActivityRecorder();
    recorder.record(failingPool, DEVICE);
    await recorder.flush();
    expect(metric).not.toHaveBeenCalled();
  });

  it("counts `recorded` or `unknown` only when the write took effect, never a value", async () => {
    const stored = pool(1);
    const recorder = new DeviceActivityRecorder();
    recorder.record(stored.pool, DEVICE, IDENTITY);
    await recorder.flush();
    recorder.reset();
    recorder.record(stored.pool, DEVICE, null);
    await recorder.flush();
    expect(metric.mock.calls).toEqual([["recorded"], ["unknown"]]);
    // The throttled write (no row matched) is not a store.
    metric.mockClear();
    const throttled = pool(0);
    recorder.reset();
    recorder.record(throttled.pool, DEVICE, IDENTITY);
    await recorder.flush();
    expect(metric).not.toHaveBeenCalled();
  });

  it("sends the identity as bound parameters, and a plain touch sends none", async () => {
    const reporting = pool(1);
    const recorder = new DeviceActivityRecorder();
    recorder.record(reporting.pool, DEVICE, IDENTITY);
    await recorder.flush();
    const update = reporting.queries.find((q) => /UPDATE devices/.test(q.text));
    expect(update?.text).toMatch(/reported_build_commit/);
    expect(update?.text).not.toContain(IDENTITY.commit);
    expect(update?.values).toEqual(expect.arrayContaining([IDENTITY.commit, IDENTITY.appVersion]));

    const plain = pool(1);
    recorder.reset();
    recorder.record(plain.pool, DEVICE);
    await recorder.flush();
    expect(plain.queries.find((q) => /UPDATE devices/.test(q.text))?.text).not.toMatch(/reported_build_commit/);
  });
});
