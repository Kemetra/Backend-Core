import "reflect-metadata";

import { type INestApplication } from "@nestjs/common";

import { bootDbLessApp, type DbLessApp } from "../_helpers/db-less-app";
import { CONTRACTS_DIR, contractRoutes, normalizePath } from "../_helpers/openapi-routes";

type ExpressLayer = {
  route?: {
    path: string;
    methods: Record<string, boolean>;
  };
};

function registeredRoutes(app: INestApplication): Set<string> {
  const express = app.getHttpAdapter().getInstance() as {
    router?: { stack: ExpressLayer[] };
    _router?: { stack: ExpressLayer[] };
  };
  const stack = express.router?.stack ?? express._router?.stack ?? [];
  return new Set(stack.flatMap((layer) =>
    Object.entries(layer.route?.methods ?? {})
      .filter(([, enabled]) => enabled)
      .map(([method]) => `${method.toUpperCase()} ${normalizePath(layer.route!.path)}`),
  ));
}

describe("OpenAPI operations map to registered Nest routes", () => {
  let booted: DbLessApp;
  let app: INestApplication;

  beforeAll(async () => {
    booted = await bootDbLessApp("route-check");
    app = booted.app;
  });

  afterAll(async () => {
    await booted.close();
  });

  it("has a real registered method/path for every production operationId", () => {
    const runtimeRoutes = registeredRoutes(app);
    const missing: string[] = [];
    const explicitContractOnly: string[] = [];
    const operationIds = new Set<string>();

    for (const { path, method, operation } of contractRoutes(CONTRACTS_DIR)) {
      const operationId = operation.operationId!;
      expect(operationIds.has(operationId)).toBe(false);
      operationIds.add(operationId);
      if (operation["x-runtime-status"] === "contract-only") {
        expect(operation["x-runtime-note"]?.trim().length).toBeGreaterThan(0);
        explicitContractOnly.push(operationId);
        continue;
      }
      expect(operation["x-runtime-status"]).toBeUndefined();
      const route = `${method.toUpperCase()} ${normalizePath(path)}`;
      if (!runtimeRoutes.has(route)) missing.push(`${operationId}: ${route}`);
    }

    expect(explicitContractOnly.sort()).toEqual([
      "acceptInvitation",
      "backfillSaleLinkedMovements",
      // RT-473 S1: tenant-branding contract; the runtime ships in RT-473 S2.
      "consoleDeleteTenantLogo",
      // RT-719: POS fleet build baseline (for RT-713); the runtime and migration are separate approvals.
      "consoleGetFleetBaseline",
      "consoleGetTenantLogo",
      "consolePreviewTenantLogo",
      "consolePutTenantLogo",
      // RT-742 (RT-554 follow-up): manager forced close from any terminal; the runtime ships in its own ticket.
      "forceCloseShift",
      // RT-490 (RT-271 F-1): refund execution and return reads; the runtime ships in F-2.
      "listSaleReturns",
      // RT-492 (RT-114 MA-BC1): approver-eligibility contract; the runtime ships in MA-BC2.
      "posCheckApproverEligibility",
      "posGetTenantBranding",
      // RT-450 (RT-50 F3): tracked line validation and lot lookup; the runtime ships in RT-451.
      "posListTrackedLots",
      "posRedeemVoucher",
      "posReverseVoucher",
      "posValidateTrackedLine",
      "posValidateVoucher",
      "readReturnByProvenance",
      "recordRefundExecution",
    ]);
    expect(missing).toEqual([]);
  });
});
