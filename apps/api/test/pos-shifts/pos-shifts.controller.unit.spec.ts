import "reflect-metadata";

import { type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { PosShiftsController } from "../../src/pos-shifts/pos-shifts.controller";
import { PosShiftsService } from "../../src/pos-shifts/pos-shifts.service";
import { ZodValidationPipe } from "../../src/common/zod-validation.pipe";
import { GlobalExceptionFilter } from "../../src/common/exception.filter";
import { RequestIdInterceptor } from "../../src/common/request-id.interceptor";
import { StuckShiftsQuerySchema } from "../../src/pos-shifts/dto";

void StuckShiftsQuerySchema;

const BRANCH_ID = "a1000000-0000-4000-8000-000000000001";

const fakePosShiftsService = {
  getStuck: jest.fn(),
};

function expectErrorEnvelope(body: unknown, expectedCode: string): void {
  expect(body).toMatchObject({
    error: {
      code: expectedCode,
      message: expect.any(String),
      request_id: expect.any(String),
    },
  });
}

let app: INestApplication;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    controllers: [PosShiftsController],
    providers: [
      { provide: PosShiftsService, useValue: fakePosShiftsService },
    ],
  }).compile();

  app = moduleRef.createNestApplication({ bufferLogs: true });
  app.useGlobalPipes(new ZodValidationPipe());
  app.useGlobalFilters(new GlobalExceptionFilter());
  app.useGlobalInterceptors(new RequestIdInterceptor());
  await app.init();
});

afterAll(async () => {
  if (app) await app.close();
});

beforeEach(() => {
  fakePosShiftsService.getStuck.mockClear();
});

function http() {
  return request(app.getHttpServer());
}

describe("PosShiftsController — extractBearer branches", () => {
  it("B0.0: undefined authorization header → 401 (non-string input)", async () => {
    const res = await http()
      .get(`/api/pos/v1/shifts/stuck?branch_id=${BRANCH_ID}`)
      .expect(401);
    expectErrorEnvelope(res.body, "unauthorized");
    expect(fakePosShiftsService.getStuck).not.toHaveBeenCalled();
  });

  it.each([
    ["B1.0: empty string authorization header → 401 (too short)", ""],
    ["B2.0: 'Basic somethingelse' authorization header → 401 (wrong prefix)", "Basic somethingelse"],
    ["B3.0: 'Bearer ' (just prefix, empty token) → 401 (empty token)", "Bearer "],
  ])("%s", async (_label, authorization) => {
    const res = await http()
      .get(`/api/pos/v1/shifts/stuck?branch_id=${BRANCH_ID}`)
      .set("Authorization", authorization)
      .expect(401);
    expectErrorEnvelope(res.body, "unauthorized");
    expect(fakePosShiftsService.getStuck).not.toHaveBeenCalled();
  });
});

describe("PosShiftsController — service refusal", () => {
  it("B6.0: service returns { kind: 'refused' } → 401", async () => {
    fakePosShiftsService.getStuck.mockResolvedValueOnce({ kind: "refused" });

    const res = await http()
      .get(`/api/pos/v1/shifts/stuck?branch_id=${BRANCH_ID}`)
      .set("Authorization", "Bearer valid-jwt-token")
      .expect(401);
    expectErrorEnvelope(res.body, "unauthorized");
    expect(fakePosShiftsService.getStuck).toHaveBeenCalledTimes(1);
  });
});

describe("PosShiftsController — happy path", () => {
  it("service returns { kind: 'ok', body: { kind: 'ok', shifts: [] } } → 200", async () => {
    fakePosShiftsService.getStuck.mockResolvedValueOnce({
      kind: "ok",
      body: { kind: "ok", shifts: [] },
    });

    const res = await http()
      .get(`/api/pos/v1/shifts/stuck?branch_id=${BRANCH_ID}`)
      .set("Authorization", "Bearer valid-jwt-token")
      .expect(200);

    expect(res.body).toEqual({ kind: "ok", shifts: [] });
    expect(fakePosShiftsService.getStuck).toHaveBeenCalledTimes(1);
    const [tokenArg, branchArg] = fakePosShiftsService.getStuck.mock.calls[0] as [string, string, string | null];
    expect(tokenArg).toBe("valid-jwt-token");
    expect(branchArg).toBe(BRANCH_ID);
  });

  it("service returns non-empty shifts list → 200 with all shift items", async () => {
    const shifts = [
      {
        shift_id: "s1",
        cashier_display_name: "Alice",
        terminal_label: "Till 1",
        opened_at: new Date(Date.now() - 3_600_000).toISOString(),
        duration_minutes: 60,
      },
    ];
    fakePosShiftsService.getStuck.mockResolvedValueOnce({
      kind: "ok",
      body: { kind: "ok", shifts },
    });

    const res = await http()
      .get(`/api/pos/v1/shifts/stuck?branch_id=${BRANCH_ID}`)
      .set("Authorization", "Bearer valid-jwt-token")
      .expect(200);

    expect(res.body).toEqual({ kind: "ok", shifts });
  });
});

describe("PosShiftsController — requestId forwarding", () => {
  it("B5.0: passes requestId to service when req.requestId is set", async () => {
    fakePosShiftsService.getStuck.mockResolvedValueOnce({
      kind: "ok",
      body: { kind: "ok", shifts: [] },
    });

    const inboundRequestId = "c1000000-0000-4000-8000-000000000099";

    await http()
      .get(`/api/pos/v1/shifts/stuck?branch_id=${BRANCH_ID}`)
      .set("Authorization", "Bearer valid-jwt-token")
      .set("X-Request-Id", inboundRequestId)
      .expect(200);

    expect(fakePosShiftsService.getStuck).toHaveBeenCalledWith(
      "valid-jwt-token",
      BRANCH_ID,
      inboundRequestId,
    );
  });

  it("B5.1: passes a generated requestId string when no X-Request-Id header is supplied", async () => {
    fakePosShiftsService.getStuck.mockResolvedValueOnce({
      kind: "ok",
      body: { kind: "ok", shifts: [] },
    });

    await http()
      .get(`/api/pos/v1/shifts/stuck?branch_id=${BRANCH_ID}`)
      .set("Authorization", "Bearer valid-jwt-token")
      .expect(200);

    const [, , requestIdArg] = fakePosShiftsService.getStuck.mock.calls[0] as [
      string,
      string,
      string | null,
    ];
    expect(typeof requestIdArg).toBe("string");
    expect(requestIdArg).not.toBeNull();
  });
});

describe("PosShiftsController — ZodValidationPipe (query params)", () => {
  it("missing branch_id → 400 validation_error", async () => {
    const res = await http()
      .get("/api/pos/v1/shifts/stuck")
      .set("Authorization", "Bearer valid-jwt-token")
      .expect(400);
    expectErrorEnvelope(res.body, "validation_error");
    expect(fakePosShiftsService.getStuck).not.toHaveBeenCalled();
  });

  it("branch_id is not a UUID → 400 validation_error", async () => {
    const res = await http()
      .get("/api/pos/v1/shifts/stuck?branch_id=not-a-uuid")
      .set("Authorization", "Bearer valid-jwt-token")
      .expect(400);
    expectErrorEnvelope(res.body, "validation_error");
    expect(fakePosShiftsService.getStuck).not.toHaveBeenCalled();
  });
});
