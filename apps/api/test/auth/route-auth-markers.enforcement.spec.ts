/**
 * RT-129 (RT-120 A9) — route-level enforcement of the auth markers.
 *
 * The global FailClosedAuthGuard trusts two markers to mean "this route
 * authenticates itself":
 *   - @DeviceBearer()   → the route MUST also run PosDeviceAuthGuard;
 *   - @DeviceAttested() → the handler checks the device attestation itself.
 * If a future change keeps the marker but drops the route guard, the route
 * silently becomes public. This sweep over the real AppModule catches that.
 */
import "reflect-metadata";

import { Controller, Get, type INestApplication, type Type } from "@nestjs/common";
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { NestFactory, ModulesContainer } from "@nestjs/core";
import request from "supertest";

import { AppModule } from "../../src/app.module";
import { PosDeviceAuthGuard } from "../../src/auth/pos-device-auth.guard";
import { DEVICE_ATTESTED_KEY, DEVICE_BEARER_KEY, DeviceBearer } from "../../src/auth/route-auth";

const HTTP_METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH", "ALL", "OPTIONS", "HEAD"];

/**
 * Device-attested handlers reviewed to verify the attestation in-handler,
 * covered by test/pos-audit-events/pos-audit-events.controller.spec.ts.
 * Adding a route here is a security review decision.
 */
const REVIEWED_DEVICE_ATTESTED = ["PosAuditEventsController.syncBatch"];

interface MarkedRoute {
  id: string;
  method: string;
  path: string;
  guards: unknown[];
}

function joinPath(base: unknown, sub: unknown): string {
  const parts = [base, sub]
    .flatMap((p) => (Array.isArray(p) ? [p[0]] : [p]))
    .filter((p): p is string => typeof p === "string" && p.length > 0 && p !== "/");
  return "/" + parts.map((p) => p.replace(/^\/+|\/+$/g, "")).join("/");
}

/** Every handler of `controller` carrying `marker` (on the handler or the class). */
export function markedRoutes(controller: Type<unknown>, marker: string): MarkedRoute[] {
  const proto = controller.prototype as Record<string, unknown>;
  return Object.getOwnPropertyNames(proto)
    .filter((name) => name !== "constructor" && typeof proto[name] === "function")
    .flatMap((name) => {
      const handler = proto[name] as object;
      const verb = Reflect.getMetadata(METHOD_METADATA, handler) as number | undefined;
      if (verb === undefined) return [];
      const marked =
        Reflect.getMetadata(marker, handler) === true ||
        Reflect.getMetadata(marker, controller) === true;
      if (!marked) return [];
      const guards = [
        ...((Reflect.getMetadata(GUARDS_METADATA, controller) as unknown[] | undefined) ?? []),
        ...((Reflect.getMetadata(GUARDS_METADATA, handler) as unknown[] | undefined) ?? []),
      ];
      return [
        {
          id: `${controller.name}.${name}`,
          method: HTTP_METHODS[verb] ?? "GET",
          path: joinPath(
            Reflect.getMetadata(PATH_METADATA, controller),
            Reflect.getMetadata(PATH_METADATA, handler),
          ),
          guards,
        },
      ];
    });
}

function missingDeviceGuard(routes: MarkedRoute[]): string[] {
  return routes.filter((r) => !r.guards.includes(PosDeviceAuthGuard)).map((r) => r.id);
}

describe("route auth markers are enforced at the route (RT-129 / A9)", () => {
  let app: INestApplication;
  let deviceBearer: MarkedRoute[] = [];
  let deviceAttested: MarkedRoute[] = [];
  const originalEnv = {
    NODE_ENV: process.env["NODE_ENV"],
    DATABASE_URL: process.env["DATABASE_URL"],
    AUTH_LOOKUP_DATABASE_URL: process.env["AUTH_LOOKUP_DATABASE_URL"],
    REDIS_URL: process.env["REDIS_URL"],
  };

  beforeAll(async () => {
    process.env["NODE_ENV"] = "test";
    // Unreachable on purpose: every assertion below must hold without a DB.
    process.env["DATABASE_URL"] = "postgres://marker-check:marker-check@127.0.0.1:1/marker-check";
    delete process.env["AUTH_LOOKUP_DATABASE_URL"];
    delete process.env["REDIS_URL"];
    app = await NestFactory.create(AppModule, { logger: false });
    await app.init();

    const controllers = [...app.get(ModulesContainer).values()].flatMap((mod) =>
      [...mod.controllers.values()].map((wrapper) => wrapper.metatype as Type<unknown>),
    );
    deviceBearer = controllers.flatMap((c) => markedRoutes(c, DEVICE_BEARER_KEY));
    deviceAttested = controllers.flatMap((c) => markedRoutes(c, DEVICE_ATTESTED_KEY));
  });

  afterAll(async () => {
    await app.close();
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("finds the marked routes (the sweep is not vacuous)", () => {
    expect(deviceBearer.map((r) => r.id).sort()).toEqual([
      // RT-113 BC2: the cashier-admissions surface (device bearer only).
      "CashierAdmissionsController.admit",
      "CashierAdmissionsController.end",
      "CashierAdmissionsController.roster",
      "ReadDownController.getDeltas",
      "ReadDownController.getSnapshot",
    ]);
    expect(deviceAttested.length).toBeGreaterThan(0);
  });

  it("every @DeviceBearer route also runs PosDeviceAuthGuard", () => {
    expect(missingDeviceGuard(deviceBearer)).toEqual([]);
  });

  it("every @DeviceAttested route is a reviewed in-handler attestation route", () => {
    expect(deviceAttested.map((r) => r.id).sort()).toEqual([...REVIEWED_DEVICE_ATTESTED].sort());
  });

  it("every @DeviceBearer route answers 401 without a device bearer", async () => {
    for (const route of deviceBearer) {
      const res = await request(app.getHttpServer())[
        route.method.toLowerCase() as "get"
      ](route.path);
      expect({ route: route.id, status: res.status }).toEqual({ route: route.id, status: 401 });
    }
  });

  it("the checker flags a @DeviceBearer route that lost its guard", () => {
    @Controller("probe")
    class UnguardedProbeController {
      @Get("unguarded")
      @DeviceBearer()
      read(): void {}
    }
    expect(missingDeviceGuard(markedRoutes(UnguardedProbeController, DEVICE_BEARER_KEY))).toEqual([
      "UnguardedProbeController.read",
    ]);
  });
});
