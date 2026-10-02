/**
 * RT-152 (RT-134 CS2) — deployment-environment feed gate.
 *
 * Docker-free: the real controllers run behind the REAL ConnectorEnvironmentGuard,
 * with ConnectorAuthGuard replaced by a stub that attaches `request.connector`
 * from the `x-test-connector-env` header (the registration lookup itself is
 * covered by connector-auth-guard.spec). Services are mocks, so "no handler ran"
 * is asserted directly: a refused request reaches no service and therefore
 * mutates no posting/bin state.
 *
 *   - mismatch / unconfigured deployment -> generic 403 `forbidden` on all four
 *     feed operations, body names neither environment, service never called;
 *   - matching environment -> request reaches the service (regression);
 *   - heartbeat is not gated by environment;
 *   - production boot guard.
 */
import "reflect-metadata";

import {
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
} from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { ConnectorAuthGuard } from "../../../src/auth/connector-auth.guard";
import type { AuthedRequest } from "../../../src/auth/auth.guard";
import { ErpnextBinViewController } from "../../../src/catalog/erpnext-bin-view/erpnext-bin-view.controller";
import { ErpnextBinViewService } from "../../../src/catalog/erpnext-bin-view/erpnext-bin-view.service";
import { ErpnextPostingController } from "../../../src/catalog/erpnext-posting/erpnext-posting.controller";
import { ErpnextPostingService } from "../../../src/catalog/erpnext-posting/erpnext-posting.service";
import { GlobalExceptionFilter } from "../../../src/common/exception.filter";
import { ConnectorHealthHeartbeatController } from "../../../src/connector-health/connector-health.controller";
import { ConnectorHealthService } from "../../../src/connector-health/connector-health.service";
import {
  assertDeploymentEnvironmentConfigured,
  resolveDeploymentEnvironment,
} from "../../../src/connector/deployment-environment";

const TENANT = "01900000-0000-7000-8000-0000000a7c10";
const REF = "01900000-0000-7000-8000-0000000a7c11";
const BASE = "/api/connector/v1/erpnext";

/** Stand-in for ConnectorAuthGuard: connector principal + header-driven environment. */
class StubConnectorAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const env = String(req.headers["x-test-connector-env"] ?? "pilot");
    (req as { principal?: unknown }).principal = {
      kind: "token",
      scope: "connector",
      tenantId: TENANT,
      tokenId: "t",
    };
    req.connector = { registrationId: "r", tenantId: TENANT, environment: env };
    return true;
  }
}

const postingService = {
  pullPostings: jest.fn(async () => ({ items: [], cursor: null, nextPageToken: null })),
  ackOutcome: jest.fn(async () => ({ replayed: false, outcome: { ok: true } })),
};
const binService = {
  pullRequests: jest.fn(async () => ({ items: [], cursor: null, nextPageToken: null })),
  reportSnapshot: jest.fn(),
};
const healthService = {
  recordHeartbeat: jest.fn(async () => ({ ok: true })),
};

let app: INestApplication;
const savedEnv = process.env["DEPLOYMENT_ENVIRONMENT"];

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    controllers: [
      ErpnextPostingController,
      ErpnextBinViewController,
      ConnectorHealthHeartbeatController,
    ],
    providers: [
      { provide: ErpnextPostingService, useValue: postingService },
      { provide: ErpnextBinViewService, useValue: binService },
      { provide: ConnectorHealthService, useValue: healthService },
    ],
  })
    .overrideGuard(ConnectorAuthGuard)
    .useClass(StubConnectorAuthGuard)
    .compile();
  app = moduleRef.createNestApplication({ bufferLogs: true });
  app.useGlobalFilters(new GlobalExceptionFilter());
  await app.init();
});

afterAll(async () => {
  await app.close();
  if (savedEnv === undefined) delete process.env["DEPLOYMENT_ENVIRONMENT"];
  else process.env["DEPLOYMENT_ENVIRONMENT"] = savedEnv;
});

beforeEach(() => {
  jest.clearAllMocks();
  process.env["DEPLOYMENT_ENVIRONMENT"] = "prod";
});

const http = () => request(app.getHttpServer());
const asEnv = (e: string) => ({ "x-test-connector-env": e, "idempotency-key": "k1" });

const FEED_OPERATIONS: Array<[string, (e: string) => request.Test]> = [
  ["posting pull", (e) => http().get(`${BASE}/postings`).set(asEnv(e))],
  [
    "posting ack",
    (e) =>
      http()
        .post(`${BASE}/postings/${REF}/outcome`)
        .set(asEnv(e))
        .send({ outcome: "failed_transient" }),
  ],
  ["bin-view pull", (e) => http().get(`${BASE}/bin-view-requests`).set(asEnv(e))],
  [
    "bin-view snapshot",
    (e) => http().post(`${BASE}/bin-view-requests/${REF}/snapshot`).set(asEnv(e)).send({}),
  ],
];

describe("feed gate — environment mismatch", () => {
  it.each(FEED_OPERATIONS)(
    "%s: staging registration vs prod deployment -> 403, no state change",
    async (_name, call) => {
      const res = await call("staging");
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("forbidden");
      expect(JSON.stringify(res.body)).not.toMatch(/staging|prod/);
      expect(postingService.pullPostings).not.toHaveBeenCalled();
      expect(postingService.ackOutcome).not.toHaveBeenCalled();
      expect(binService.pullRequests).not.toHaveBeenCalled();
      expect(binService.reportSnapshot).not.toHaveBeenCalled();
    },
  );

  it("an unset deployment environment fails closed (403)", async () => {
    delete process.env["DEPLOYMENT_ENVIRONMENT"];
    await http().get(`${BASE}/postings`).set(asEnv("prod")).expect(403);
    expect(postingService.pullPostings).not.toHaveBeenCalled();
  });

  it("an invalid deployment environment fails closed (403)", async () => {
    process.env["DEPLOYMENT_ENVIRONMENT"] = "production";
    await http().get(`${BASE}/postings`).set(asEnv("production")).expect(403);
  });
});

describe("feed gate — matching environment (regression)", () => {
  it("posting pull reaches the service", async () => {
    await http().get(`${BASE}/postings`).set(asEnv("prod")).expect(200);
    expect(postingService.pullPostings).toHaveBeenCalledTimes(1);
  });

  it("bin-view pull reaches the service", async () => {
    await http().get(`${BASE}/bin-view-requests`).set(asEnv("prod")).expect(200);
    expect(binService.pullRequests).toHaveBeenCalledTimes(1);
  });

  it("posting ack reaches the service", async () => {
    await http()
      .post(`${BASE}/postings/${REF}/outcome`)
      .set(asEnv("prod"))
      .send({ outcome: "failed_transient" })
      .expect(201);
    expect(postingService.ackOutcome).toHaveBeenCalledTimes(1);
  });
});

describe("heartbeat is not gated", () => {
  it("a mismatched-environment registration can still heartbeat", async () => {
    const res = await http().post(`${BASE}/health/heartbeat`).set(asEnv("staging")).send({});
    expect(res.status).not.toBe(403);
  });
});

describe("deployment environment config", () => {
  it("accepts exactly dev|staging|pilot|prod", () => {
    for (const v of ["dev", "staging", "pilot", "prod"]) {
      expect(resolveDeploymentEnvironment({ DEPLOYMENT_ENVIRONMENT: v })).toBe(v);
    }
    for (const v of [undefined, "", "production", "PROD", "test"]) {
      expect(resolveDeploymentEnvironment({ DEPLOYMENT_ENVIRONMENT: v })).toBeNull();
    }
  });

  it("production boot fails when missing or invalid", () => {
    expect(() => assertDeploymentEnvironmentConfigured({ NODE_ENV: "production" })).toThrow(
      /DEPLOYMENT_ENVIRONMENT/,
    );
    expect(() =>
      assertDeploymentEnvironmentConfigured({ NODE_ENV: "production", DEPLOYMENT_ENVIRONMENT: "live" }),
    ).toThrow(/DEPLOYMENT_ENVIRONMENT/);
  });

  it("production boot succeeds with a valid value; non-production never throws", () => {
    expect(() =>
      assertDeploymentEnvironmentConfigured({ NODE_ENV: "production", DEPLOYMENT_ENVIRONMENT: "pilot" }),
    ).not.toThrow();
    expect(() => assertDeploymentEnvironmentConfigured({ NODE_ENV: "development" })).not.toThrow();
    expect(() => assertDeploymentEnvironmentConfigured({})).not.toThrow();
  });
});
