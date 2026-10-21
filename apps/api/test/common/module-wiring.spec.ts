/**
 * Module wiring tests — T304-C-coverage.
 *
 * Compiles each POS feature module with PG_POOL overridden so every
 * anonymous factory provider (logger, repository, service) executes,
 * covering the factory function bodies and their ?? branches.
 *
 * Two describe blocks compile each module twice:
 *   1. LOG_LEVEL unset  → createLogger's (LOG_LEVEL ?? "info") right branch.
 *   2. LOG_LEVEL set    → createLogger's (LOG_LEVEL ?? "info") left branch.
 *
 * No Testcontainers, no real DB, no network. All factories that need
 * Redis or a DB connection fall back to their safe no-op paths:
 *   - EMAIL_JOB_ENQUEUER  → NoOpEmailJobEnqueuer  (REDIS_URL absent)
 *   - AUDIT_JOB_ENQUEUER  → NoOpAuditJobEnqueuer  (REDIS_URL absent)
 *   - CLERK_VERIFIER      → fail-closed verifier   (CLERK_SECRET_KEY absent)
 */
import "reflect-metadata";

import { Test } from "@nestjs/testing";

import { PG_POOL } from "../../src/auth/auth.module";
import { PosShiftsModule } from "../../src/pos-shifts/pos-shifts.module";
import { PosAuditEventsModule } from "../../src/pos-audit-events/pos-audit-events.module";
import { PosOperatorsModule } from "../../src/pos-operators/pos-operators.module";

const fakePool = { query: jest.fn(), connect: jest.fn(), end: jest.fn() };

// ---------------------------------------------------------------------------
// 1. LOG_LEVEL unset — covers the right branch of (LOG_LEVEL ?? "info")
// ---------------------------------------------------------------------------

describe("module wiring — LOG_LEVEL unset (covers ?? right branch)", () => {
  let savedLogLevel: string | undefined;

  beforeAll(() => {
    savedLogLevel = process.env["LOG_LEVEL"];
    delete process.env["LOG_LEVEL"];
  });

  afterAll(() => {
    if (savedLogLevel !== undefined) {
      process.env["LOG_LEVEL"] = savedLogLevel;
    } else {
      delete process.env["LOG_LEVEL"];
    }
  });

  it("PosShiftsModule compiles with mocked PG_POOL (covers factory fns)", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PosShiftsModule],
    })
      .overrideProvider(PG_POOL)
      .useValue(fakePool)
      .compile();

    expect(moduleRef).toBeDefined();
    await moduleRef.close();
  });

  it("PosAuditEventsModule compiles with mocked PG_POOL (covers factory fns)", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PosAuditEventsModule],
    })
      .overrideProvider(PG_POOL)
      .useValue(fakePool)
      .compile();

    expect(moduleRef).toBeDefined();
    await moduleRef.close();
  });

  it("PosOperatorsModule compiles with mocked PG_POOL (covers factory fns)", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PosOperatorsModule],
    })
      .overrideProvider(PG_POOL)
      .useValue(fakePool)
      .compile();

    expect(moduleRef).toBeDefined();
    await moduleRef.close();
  });
});

// ---------------------------------------------------------------------------
// 2. LOG_LEVEL set — covers the left branch of (LOG_LEVEL ?? "info")
// ---------------------------------------------------------------------------

describe("module wiring — LOG_LEVEL set (covers ?? left branch)", () => {
  let savedLogLevel: string | undefined;

  beforeAll(() => {
    savedLogLevel = process.env["LOG_LEVEL"];
    process.env["LOG_LEVEL"] = "debug";
  });

  afterAll(() => {
    if (savedLogLevel !== undefined) {
      process.env["LOG_LEVEL"] = savedLogLevel;
    } else {
      delete process.env["LOG_LEVEL"];
    }
  });

  it("PosShiftsModule logger uses LOG_LEVEL when set", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PosShiftsModule],
    })
      .overrideProvider(PG_POOL)
      .useValue(fakePool)
      .compile();

    expect(moduleRef).toBeDefined();
    await moduleRef.close();
  });

  it("PosAuditEventsModule logger uses LOG_LEVEL when set", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PosAuditEventsModule],
    })
      .overrideProvider(PG_POOL)
      .useValue(fakePool)
      .compile();

    expect(moduleRef).toBeDefined();
    await moduleRef.close();
  });

  it("PosOperatorsModule logger uses LOG_LEVEL when set", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PosOperatorsModule],
    })
      .overrideProvider(PG_POOL)
      .useValue(fakePool)
      .compile();

    expect(moduleRef).toBeDefined();
    await moduleRef.close();
  });
});

// ---------------------------------------------------------------------------
// 3. RT-791 — IDENTITY_PROVIDER=descope: the same modules compile with the
//    Descope verifier/adapter selected (no network: the JWKS is fetched lazily).
// ---------------------------------------------------------------------------

describe("module wiring — IDENTITY_PROVIDER=descope (RT-791)", () => {
  const saved: Record<string, string | undefined> = {};
  const KEYS = ["IDENTITY_PROVIDER", "DESCOPE_PROJECT_ID"];

  beforeAll(() => {
    for (const k of KEYS) saved[k] = process.env[k];
    process.env["IDENTITY_PROVIDER"] = "descope";
    process.env["DESCOPE_PROJECT_ID"] = "P2wiringTest0001";
  });

  afterAll(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it.each([
    ["PosShiftsModule", PosShiftsModule],
    ["PosAuditEventsModule", PosAuditEventsModule],
    ["PosOperatorsModule", PosOperatorsModule],
  ])("%s compiles with the Descope provider selected", async (_name, mod) => {
    const moduleRef = await Test.createTestingModule({ imports: [mod] })
      .overrideProvider(PG_POOL)
      .useValue(fakePool)
      .compile();

    expect(moduleRef).toBeDefined();
    await moduleRef.close();
  });
});
