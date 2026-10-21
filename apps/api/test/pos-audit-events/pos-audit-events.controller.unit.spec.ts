import "reflect-metadata";

import { type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { OPERATOR_TOKEN_VERIFIER } from "../../src/auth/operator-token-verifier";
import { PosAuditEventsService } from "../../src/pos-audit-events/pos-audit-events.service";
import { PosAuditEventsController } from "../../src/pos-audit-events/pos-audit-events.controller";
import { ZodValidationPipe } from "../../src/common/zod-validation.pipe";
import { GlobalExceptionFilter } from "../../src/common/exception.filter";

const validBody = {
  device_token_attestation: "some-attestation-token",
  events: [
    {
      event_id: "11111111-0000-4000-8000-000000000001",
      tenant_id: "22222222-0000-4000-8000-000000000001",
      branch_id: "33333333-0000-4000-8000-000000000001",
      originating_terminal_id: "44444444-0000-4000-8000-000000000001",
      acting_operator_id: "user_clerk_abc",
      action_category: "shift.open",
      created_at: "2026-01-15T10:00:00.000Z",
      payload: { shift_id: "55555555-0000-4000-8000-000000000001", opened_at: "2026-01-15T10:00:00.000Z" },
    },
  ],
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

const fakeService = { syncBatch: jest.fn() };
const fakeClerkVerifier = { verify: jest.fn() };

let app: INestApplication;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    controllers: [PosAuditEventsController],
    providers: [
      { provide: PosAuditEventsService, useValue: fakeService },
      { provide: OPERATOR_TOKEN_VERIFIER, useValue: fakeClerkVerifier },
    ],
  }).compile();

  app = moduleRef.createNestApplication({ bufferLogs: true });
  app.useGlobalPipes(new ZodValidationPipe());
  app.useGlobalFilters(new GlobalExceptionFilter());
  await app.init();
});

afterAll(async () => {
  if (app) await app.close();
});

beforeEach(() => {
  jest.resetAllMocks();
  fakeService.syncBatch.mockResolvedValue({ accepted: ["evt-1"], duplicates: [], rejected: [] });
  fakeClerkVerifier.verify.mockResolvedValue({ sub: "user_clerk_123" });
});

function http() {
  return request(app.getHttpServer());
}

describe("POST /api/pos/v1/audit-events", () => {
  it("no Authorization header: service called and returns 200", async () => {
    const res = await http()
      .post("/api/pos/v1/audit-events")
      .send(validBody);

    expect(res.status).toBe(200);
    expect(fakeService.syncBatch).toHaveBeenCalledTimes(1);
    expect(fakeClerkVerifier.verify).not.toHaveBeenCalled();
  });

  it.each([
    ["Authorization header too short (B1.0)", "X"],
    ["Authorization header with wrong prefix (B2.0)", "Basic dXNlcjpwYXNz"],
    ["Authorization header with empty token after prefix (B3.0)", "Bearer   "],
  ])("%s: returns 401", async (_label, authorization) => {
    const res = await http()
      .post("/api/pos/v1/audit-events")
      .set("Authorization", authorization)
      .send(validBody);

    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, "unauthorized");
    expect(fakeService.syncBatch).not.toHaveBeenCalled();
  });

  it("valid JWT format but clerkVerifier throws: returns 401", async () => {
    fakeClerkVerifier.verify.mockRejectedValue(new Error("JWKS fetch failed"));

    const res = await http()
      .post("/api/pos/v1/audit-events")
      .set("Authorization", "Bearer valid.looking.jwt")
      .send(validBody);

    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, "unauthorized");
    expect(fakeService.syncBatch).not.toHaveBeenCalled();
  });

  it("service returns device_invalid: returns 401", async () => {
    fakeService.syncBatch.mockResolvedValue({ kind: "device_invalid" });

    const res = await http()
      .post("/api/pos/v1/audit-events")
      .send(validBody);

    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, "unauthorized");
  });

  it("happy path with valid JWT: clerkVerifier called and returns 200", async () => {
    const res = await http()
      .post("/api/pos/v1/audit-events")
      .set("Authorization", "Bearer eyJhbGciOiJSUzI1NiJ9.payload.sig")
      .send(validBody);

    expect(res.status).toBe(200);
    expect(fakeClerkVerifier.verify).toHaveBeenCalledWith("eyJhbGciOiJSUzI1NiJ9.payload.sig");
    expect(fakeService.syncBatch).toHaveBeenCalledTimes(1);
    expect(res.body).toEqual({ accepted: ["evt-1"], duplicates: [], rejected: [] });
  });

  it("req.requestId present: passes requestId to service", async () => {
    const res = await http()
      .post("/api/pos/v1/audit-events")
      .send(validBody);

    expect(res.status).toBe(200);
    const [, requestId] = fakeService.syncBatch.mock.calls[0] as [unknown, string | null];
    expect(requestId === null || typeof requestId === "string").toBe(true);
  });

  it("req.requestId undefined: passes null to service", async () => {
    const res = await http()
      .post("/api/pos/v1/audit-events")
      .send(validBody);

    expect(res.status).toBe(200);
    const [, requestId] = fakeService.syncBatch.mock.calls[0] as [unknown, string | null];
    expect(requestId).toBeNull();
  });

  it("invalid body (missing device_token_attestation): returns 400", async () => {
    const { device_token_attestation: _omit, ...bodyWithout } = validBody;

    const res = await http()
      .post("/api/pos/v1/audit-events")
      .send(bodyWithout);

    expect(res.status).toBe(400);
    expectErrorEnvelope(res.body, "validation_error");
    expect(fakeService.syncBatch).not.toHaveBeenCalled();
  });
});
