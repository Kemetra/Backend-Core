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
      // RT-729 (CAT-R1): console catalog read contract; the runtime ships in RT-730.
      "consoleGetCatalogProduct",
      "consoleGetTenantLogo",
      "consoleListCatalogCategories",
      "consoleListCatalogProducts",
      "consolePreviewTenantLogo",
      "consolePutTenantLogo",
      // RT-414: platform support-session contract; the runtime ships after owner approval.
      "endSupportSession",
      "getCurrentSupportSession",
      "openSupportSession",
      "posGetTenantBranding",
      "posRedeemVoucher",
      "posReverseVoucher",
      "posValidateVoucher",
      "renewSupportSession",
    ]);
    expect(missing).toEqual([]);
  });
});
