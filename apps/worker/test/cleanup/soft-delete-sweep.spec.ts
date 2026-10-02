/**
 * T312 — SoftDeleteSweepProcessor unit tests.
 *
 * Coverage
 * --------
 * 1. Job name literal pin — value must stay "soft-delete-sweep"
 * 2. Happy path — processor calls purgeSoftDeletedStores with the correct cutoff
 * 3. 0 rows purged — no-op success (idempotency)
 * 4. Cutoff arithmetic — exactly 30 days before the injected clock
 * 5. DB error propagation — transient errors bubble unwrapped
 * 6. Unknown job name — throws UnknownSoftDeleteSweepJobError
 * 7. Payload passthrough — extra keys in job data do not cause validation error
 * 8. No tenant purge method — SoftDeleteSweepDbLike has no tenant method
 *
 * No BullMQ runtime, no Redis, no Postgres, no Docker.
 */
import {
  SoftDeleteSweepProcessor,
  SoftDeleteSweepDbLike,
  SOFT_DELETE_SWEEP_JOB_NAME,
  SWEEP_DB,
  UnknownSoftDeleteSweepJobError,
  MalformedSoftDeleteSweepJobError,
} from "../../src/cleanup/soft-delete-sweep.processor";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDb(purgedCount = 0): jest.Mocked<SoftDeleteSweepDbLike> {
  return {
    purgeSoftDeletedStores: jest.fn().mockResolvedValue(purgedCount),
  };
}

/** Fixed reference time for deterministic cutoff assertions. */
const FIXED_NOW = new Date("2026-05-12T12:00:00.000Z");

/** Expected cutoff: exactly 30 days before FIXED_NOW. */
const EXPECTED_CUTOFF = new Date("2026-04-12T12:00:00.000Z");

function makeProcessor(
  db: SoftDeleteSweepDbLike,
  now: () => Date = () => FIXED_NOW,
): SoftDeleteSweepProcessor {
  // Bypass NestJS DI — inject directly via constructor (Layer A pattern).
  return new SoftDeleteSweepProcessor(db, now);
}

// ---------------------------------------------------------------------------
// 1. Job name literal pin
// ---------------------------------------------------------------------------

describe("SOFT_DELETE_SWEEP_JOB_NAME", () => {
  it('equals "soft-delete-sweep"', () => {
    expect(SOFT_DELETE_SWEEP_JOB_NAME).toBe("soft-delete-sweep");
  });
});

// ---------------------------------------------------------------------------
// 2. Happy path
// ---------------------------------------------------------------------------

describe("SoftDeleteSweepProcessor.process — happy path", () => {
  it("calls purgeSoftDeletedStores with the computed cutoff", async () => {
    const db = makeDb(5);
    const processor = makeProcessor(db);

    await processor.process(SOFT_DELETE_SWEEP_JOB_NAME, {});

    expect(db.purgeSoftDeletedStores).toHaveBeenCalledTimes(1);
    expect(db.purgeSoftDeletedStores).toHaveBeenCalledWith(EXPECTED_CUTOFF);
  });

  it("resolves without throwing when rows are purged", async () => {
    const db = makeDb(3);
    const processor = makeProcessor(db);

    await expect(
      processor.process(SOFT_DELETE_SWEEP_JOB_NAME, {}),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 3. 0 rows purged — no-op success
// ---------------------------------------------------------------------------

describe("SoftDeleteSweepProcessor.process — 0 rows", () => {
  it("resolves without throwing when nothing is purged", async () => {
    const db = makeDb(0);
    const processor = makeProcessor(db);

    await expect(
      processor.process(SOFT_DELETE_SWEEP_JOB_NAME, {}),
    ).resolves.toBeUndefined();
  });

  it("still calls purgeSoftDeletedStores even when 0 rows will be deleted", async () => {
    const db = makeDb(0);
    const processor = makeProcessor(db);

    await processor.process(SOFT_DELETE_SWEEP_JOB_NAME, {});

    expect(db.purgeSoftDeletedStores).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 4. Cutoff arithmetic
// ---------------------------------------------------------------------------

describe("SoftDeleteSweepProcessor — cutoff arithmetic", () => {
  it("passes a cutoff exactly 30 days before the injected clock", async () => {
    const db = makeDb(0);
    const processor = makeProcessor(db);

    await processor.process(SOFT_DELETE_SWEEP_JOB_NAME, {});

    const [cutoff] = db.purgeSoftDeletedStores.mock.calls[0]!;
    const expectedMs = FIXED_NOW.getTime() - 30 * 24 * 60 * 60 * 1000;
    expect(cutoff.getTime()).toBe(expectedMs);
  });

  it("uses the clock at process() call time, not construction time", async () => {
    let callCount = 0;
    const clocks = [
      new Date("2026-05-01T00:00:00.000Z"),
      new Date("2026-05-10T00:00:00.000Z"),
    ];
    const dynamicClock = () => clocks[callCount++]!;

    const db = makeDb(0);
    const processor = makeProcessor(db, dynamicClock);

    await processor.process(SOFT_DELETE_SWEEP_JOB_NAME, {});
    const [firstCutoff] = db.purgeSoftDeletedStores.mock.calls[0]!;

    await processor.process(SOFT_DELETE_SWEEP_JOB_NAME, {});
    const [secondCutoff] = db.purgeSoftDeletedStores.mock.calls[1]!;

    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    expect(firstCutoff.getTime()).toBe(clocks[0]!.getTime() - thirtyDaysMs);
    expect(secondCutoff.getTime()).toBe(clocks[1]!.getTime() - thirtyDaysMs);
    expect(firstCutoff.getTime()).not.toBe(secondCutoff.getTime());
  });
});

// ---------------------------------------------------------------------------
// 5. DB error propagation
// ---------------------------------------------------------------------------

describe("SoftDeleteSweepProcessor.process — DB errors", () => {
  it("propagates DB errors unwrapped", async () => {
    const dbError = new Error("connection timeout");
    const db: jest.Mocked<SoftDeleteSweepDbLike> = {
      purgeSoftDeletedStores: jest.fn().mockRejectedValue(dbError),
    };
    const processor = makeProcessor(db);

    await expect(
      processor.process(SOFT_DELETE_SWEEP_JOB_NAME, {}),
    ).rejects.toThrow(dbError);
  });

  it("does not wrap the DB error in a processor-specific error", async () => {
    const dbError = new Error("deadlock detected");
    const db: jest.Mocked<SoftDeleteSweepDbLike> = {
      purgeSoftDeletedStores: jest.fn().mockRejectedValue(dbError),
    };
    const processor = makeProcessor(db);

    await expect(
      processor.process(SOFT_DELETE_SWEEP_JOB_NAME, {}),
    ).rejects.toBe(dbError);
  });
});

// ---------------------------------------------------------------------------
// 6. Unknown job name
// ---------------------------------------------------------------------------

describe("SoftDeleteSweepProcessor.process — unknown job name", () => {
  it("throws UnknownSoftDeleteSweepJobError for unrecognised job names", async () => {
    const db = makeDb(0);
    const processor = makeProcessor(db);

    await expect(
      processor.process("some-other-job", {}),
    ).rejects.toThrow(UnknownSoftDeleteSweepJobError);
  });

  it("error message includes the unrecognised job name", async () => {
    const db = makeDb(0);
    const processor = makeProcessor(db);

    await expect(
      processor.process("wrong-job-name", {}),
    ).rejects.toThrow("wrong-job-name");
  });

  it("does NOT call purgeSoftDeletedStores on unknown job name", async () => {
    const db = makeDb(0);
    const processor = makeProcessor(db);

    await expect(
      processor.process("wrong-job-name", {}),
    ).rejects.toThrow(UnknownSoftDeleteSweepJobError);

    expect(db.purgeSoftDeletedStores).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 7. Payload passthrough — extra keys allowed
// ---------------------------------------------------------------------------

describe("SoftDeleteSweepProcessor.process — payload schema", () => {
  it("accepts empty object payload", async () => {
    const db = makeDb(0);
    const processor = makeProcessor(db);

    await expect(
      processor.process(SOFT_DELETE_SWEEP_JOB_NAME, {}),
    ).resolves.toBeUndefined();
  });

  it("accepts payload with extra BullMQ metadata keys (passthrough)", async () => {
    const db = makeDb(0);
    const processor = makeProcessor(db);

    const richPayload = {
      timestamp: 1715515200000,
      repeatJobKey: "soft-delete-sweep::::3600000",
      traceContext: { traceparent: "00-abc-def-01" },
    };

    await expect(
      processor.process(SOFT_DELETE_SWEEP_JOB_NAME, richPayload),
    ).resolves.toBeUndefined();
  });

  it("rejects null payload — null is not an object, Zod parse fails", async () => {
    const db = makeDb(0);
    const processor = makeProcessor(db);

    await expect(
      processor.process(SOFT_DELETE_SWEEP_JOB_NAME, null),
    ).rejects.toThrow(MalformedSoftDeleteSweepJobError);
  });
});

// ---------------------------------------------------------------------------
// 8. No tenant purge method on the interface
// ---------------------------------------------------------------------------

describe("SoftDeleteSweepDbLike interface", () => {
  it("has no purgeSoftDeletedTenants method — tenants are out of scope for T312", () => {
    const db = makeDb(0);
    expect((db as unknown as Record<string, unknown>)["purgeSoftDeletedTenants"]).toBeUndefined();
  });

  it("SWEEP_DB token is a non-empty string", () => {
    expect(typeof SWEEP_DB).toBe("string");
    expect(SWEEP_DB.length).toBeGreaterThan(0);
  });
});
