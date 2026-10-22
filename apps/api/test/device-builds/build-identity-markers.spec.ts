/**
 * RT-719: the exact set of build identity REPORTING operations, enforced at the
 * route. `pos-terminal-pairing.openapi.yaml` ("Build identity report") names
 * thirteen operations and says "and nowhere else": not `posPairTerminal`, not
 * `posRotateTerminalToken`, not a route that authenticates with an operator
 * credential, and not the other hinted device operations. The runtime records
 * the identity only on a handler marked `@ReportsBuildIdentity()`, so this sweep
 * over the real AppModule joins every marked handler to its contract operation
 * (method + path) and pins the set, and checks each one authenticates with the
 * device token (it runs `PosDeviceAuthGuard`, directly or in a reviewed
 * composite), since a header on any other route would never be read.
 */
import "reflect-metadata";

import { GUARDS_METADATA } from "@nestjs/common/constants";
import type { INestApplication } from "@nestjs/common";

import { PosDeviceAuthGuard } from "../../src/auth/pos-device-auth.guard";
import { REPORTS_BUILD_IDENTITY_KEY } from "../../src/auth/route-auth";
import { SaleCaptureAuthGuard } from "../../src/catalog/sales/sale-capture-auth.guard";
import { SaleHistoryAuthGuard } from "../../src/catalog/sales/history/sale-history-auth.guard";
import { ShiftCashUpAuthGuard } from "../../src/pos-shifts/shift-cash-up-auth.guard";
import { appControllers, bootDbLessApp, type DbLessApp } from "../_helpers/db-less-app";
import { contractRouteKey, contractRoutes, controllerRoutes } from "../_helpers/openapi-routes";

/** The thirteen reporting operations of the contract, by operationId. */
const REPORTING_OPERATION_IDS = [
  "captureSale",
  "closeShift",
  "listSaleHistory",
  "openShift",
  "posCreateCashierAdmission",
  "posEndCashierAdmission",
  "posGetCashVariancePolicy",
  "posGetCatalogDeltas",
  "posGetCatalogSnapshot",
  "posListCashierAdmissionRoster",
  "readSaleHistoryDetail",
  "recordCashMovement",
  "recordSaleReprint",
];

/** Route guards that run `PosDeviceAuthGuard` on their device path (reviewed in RT-129 / RT-224 / RT-539). */
const DEVICE_GUARD_COMPOSITES: readonly unknown[] = [SaleCaptureAuthGuard, ShiftCashUpAuthGuard, SaleHistoryAuthGuard];

describe("RT-719 build identity reporting operations are exactly the thirteen of the contract", () => {
  let booted: DbLessApp;
  let app: INestApplication;

  beforeAll(async () => {
    booted = await bootDbLessApp("build-identity-markers");
    app = booted.app;
  });

  afterAll(async () => {
    await booted.close();
  });

  const markedHandlers = () =>
    appControllers(app)
      .flatMap((controller) => controllerRoutes(controller))
      .filter((route) => Reflect.getMetadata(REPORTS_BUILD_IDENTITY_KEY, route.handler) === true);

  it("marks exactly the handlers whose contract operations are the thirteen reporting operations", () => {
    const operationByKey = new Map(contractRoutes().map((route) => [contractRouteKey(route), route.operation.operationId] as const));
    const marked = markedHandlers();
    const operationIds = marked.map((route) => operationByKey.get(route.key));
    expect(operationIds.every((id) => id !== undefined)).toBe(true);
    expect([...(operationIds as string[])].sort((a, b) => a.localeCompare(b))).toEqual(REPORTING_OPERATION_IDS);
  });

  it("only marks routes that authenticate with the device token (the headers would never be read otherwise)", () => {
    for (const route of markedHandlers()) {
      const guards = [
        ...((Reflect.getMetadata(GUARDS_METADATA, route.controller) as unknown[] | undefined) ?? []),
        ...((Reflect.getMetadata(GUARDS_METADATA, route.handler) as unknown[] | undefined) ?? []),
      ];
      const runsDeviceGuard = guards.includes(PosDeviceAuthGuard) || guards.some((g) => DEVICE_GUARD_COMPOSITES.includes(g));
      expect({ route: route.id, runsDeviceGuard }).toEqual({ route: route.id, runsDeviceGuard: true });
    }
  });

  it("does not mark the pairing, rotation, heartbeat or any operator-credential route", () => {
    const ids = markedHandlers().map((route) => route.id);
    for (const never of ["PairingController", "RotationController", "DeviceHeartbeatController", "PosApproversController", "PosOperatorsController"]) {
      expect(ids.filter((id) => id.startsWith(`${never}.`))).toEqual([]);
    }
  });
});
