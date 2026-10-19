/**
 * RT-619 — console rate-limit ratchet and guard order (RT-574 issue 1, AC5,
 * AC6, AC9).
 *
 * Sweeps the real AppModule (no DB, no Redis) and every OpenAPI contract:
 *   - every runtime operation that declares `cookieAuth` appears in the
 *     snapshot below with its resolved class. A new cookieAuth operation that
 *     is not in the snapshot fails here, so its author must classify it (the
 *     runtime still falls back to the verb default, so a missed snapshot never
 *     leaves a route unlimited). A changed class is a deliberate snapshot edit;
 *   - the shared exemption list matches the runtime exactly;
 *   - the contract-only cookieAuth operations are listed with their INTENDED
 *     class (RT-574 D3), and the spec breaks when one gains a runtime route,
 *     forcing it into the snapshot;
 *   - the guard is registered immediately after FailClosedAuthGuard in
 *     AppModule's providers.
 *
 * The snapshot starts from the RT-574 D3 class lists (owner O2/O4).
 */
import "reflect-metadata";

import type { Type } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";

import { AppModule } from "../../src/app.module";
import { FailClosedAuthGuard } from "../../src/auth/fail-closed-auth.guard";
import { resolveConsoleRateLimitClass } from "../../src/console-rate-limit/console-rate-limit.classify";
import type { ConsoleRateLimitClass } from "../../src/console-rate-limit/console-rate-limit.config";
import {
  CONSOLE_RATE_LIMIT_EXEMPTIONS,
  CONSOLE_RATE_LIMIT_EXEMPT_OPERATION_IDS,
} from "../../src/console-rate-limit/console-rate-limit.exemptions";
import { ConsoleRateLimitGuard } from "../../src/console-rate-limit/console-rate-limit.guard";
import { appControllers, bootDbLessApp, type DbLessApp } from "../_helpers/db-less-app";
import {
  contractRouteKey,
  contractRoutes,
  controllerRoutes,
  usesScheme,
  type ControllerRoute,
} from "../_helpers/openapi-routes";

/** operationId → resolved class, for every runtime cookieAuth operation. */
const SNAPSHOT: Record<string, ConsoleRateLimitClass> = {
  clearActiveStore: "write",
  consoleAddProductIdentifier: "write",
  consoleCancelPairingCode: "incidentControl",
  consoleCreateCatalogProduct: "write",
  consoleCreatePayerAccount: "write",
  consoleGetCatalogProduct: "cheapRead",
  consoleGetDevice: "cheapRead",
  consoleGetDeviceImpact: "expensiveRead",
  consoleGetSale: "cheapRead",
  // RT-649: an aggregate over up to 31 business days of every store in scope.
  consoleGetSalesSummary: "expensiveRead",
  consoleGetSaleAuditTimeline: "expensiveRead",
  consoleGetSaleSyncStatus: "cheapRead",
  consoleGetShiftClose: "cheapRead",
  consoleGetStoreCashVariancePolicy: "cheapRead",
  consoleGetSyncOpsSummary: "expensiveRead",
  consoleGetTenantCashVariancePolicy: "cheapRead",
  consoleIssuePairingCode: "onboarding",
  consoleListCatalogCategories: "cheapRead",
  consoleListCatalogProducts: "expensiveRead",
  consoleListDevices: "cheapRead",
  consoleListNeedsRepair: "expensiveRead",
  consoleListPairingCodes: "cheapRead",
  consoleListPayerAccounts: "cheapRead",
  consoleListPostingBacklog: "expensiveRead",
  consoleListReconciliationRuns: "cheapRead",
  consoleListSales: "expensiveRead",
  consoleListShiftCloses: "expensiveRead",
  consoleListStoreCashVariancePolicyRevisions: "cheapRead",
  consoleListTenantCashVariancePolicyRevisions: "cheapRead",
  consolePublishStoreCashVariancePolicyOverride: "write",
  consolePublishTenantCashVariancePolicy: "write",
  consoleRepairSaleSync: "write",
  consoleRetireCatalogProduct: "write",
  consoleRetireDevice: "incidentControl",
  consoleRetireProductIdentifier: "write",
  consoleRetireStoreOverride: "write",
  consoleRevokeDevice: "incidentControl",
  consoleUpdateCatalogProduct: "write",
  consoleUpdatePayerAccount: "write",
  consoleUpsertStoreOverride: "write",
  createInvitation: "onboarding",
  createRelocation: "write",
  createStatusMove: "write",
  createStockMovement: "write",
  createStockTransfer: "write",
  createStore: "write",
  createTenant: "onboarding",
  getActiveContext: "cheapRead",
  getConnectorHealth: "cheapRead",
  getOnHand: "cheapRead",
  getOutboxDeadLetter: "cheapRead",
  getProductReconciliationRunResults: "expensiveRead",
  getReconciliationRun: "cheapRead",
  getReturnLandingPolicy: "cheapRead",
  listAuditEvents: "expensiveRead",
  listConnectorHealth: "cheapRead",
  listErpnextNegativeOnHand: "expensiveRead",
  listErpnextNegativeOnHandStores: "expensiveRead",
  listMembers: "cheapRead",
  listOutboxDeadLetters: "expensiveRead",
  listPostingBacklog: "expensiveRead",
  listProductReconciliationBacklog: "expensiveRead",
  listProductReconciliationRuns: "cheapRead",
  listReconciliationResults: "expensiveRead",
  listStockLocations: "cheapRead",
  listStockMovements: "expensiveRead",
  listStores: "cheapRead",
  listTenants: "cheapRead",
  listTrackingIdentities: "cheapRead",
  previewStoreTimezoneChange: "jobOrPreview",
  readStore: "cheapRead",
  readTenant: "cheapRead",
  recordStockCount: "write",
  refreshSession: "exempt",
  repairPosting: "write",
  repairProductMapping: "write",
  repairStockMismatch: "write",
  requestEmailVerification: "exempt",
  reResolvePosting: "write",
  revokeMembership: "incidentControl",
  setReturnLandingPolicy: "write",
  signOut: "exempt",
  softDeleteStore: "write",
  softDeleteTenant: "write",
  switchActiveStore: "write",
  switchActiveTenant: "write",
  tenantAdminBulkDismissUnknownItems: "jobOrPreview",
  tenantAdminConfirmErpnextItemMapping: "write",
  tenantAdminCreateProductFromUnknownItem: "write",
  tenantAdminDisableConnectorInstance: "incidentControl",
  tenantAdminDismissUnknownItem: "write",
  tenantAdminGetTrackingProfile: "cheapRead",
  tenantAdminInspectUnknownItem: "cheapRead",
  tenantAdminIssueConnectorCredential: "onboarding",
  tenantAdminLinkUnknownItem: "write",
  tenantAdminListConnectorInstances: "cheapRead",
  tenantAdminListErpnextItemMappings: "cheapRead",
  tenantAdminListErpnextWarehouseMappings: "cheapRead",
  tenantAdminListUnknownItems: "expensiveRead",
  tenantAdminRegisterConnectorInstance: "onboarding",
  tenantAdminReopenUnknownItem: "write",
  tenantAdminRetireErpnextItemMapping: "write",
  tenantAdminRetireErpnextWarehouseMapping: "write",
  tenantAdminRevokeConnectorCredential: "incidentControl",
  tenantAdminRotateConnectorCredential: "incidentControl",
  tenantAdminSetErpnextWarehouseMapping: "write",
  tenantAdminSetTrackingProfile: "write",
  tenantAdminSuggestErpnextItemMapping: "write",
  triggerProductReconciliationRun: "jobOrPreview",
  triggerReconciliationRun: "jobOrPreview",
  updateMembership: "write",
  updateStore: "write",
  updateTenant: "write",
};

/**
 * cookieAuth operations with no runtime yet (x-runtime-status contract-only),
 * with the class RT-574 D3 intends for them. When one ships, this spec fails
 * until it moves into SNAPSHOT (and the handler carries @ConsoleRateLimit for
 * a non-default class).
 */
const CONTRACT_ONLY_INTENT: Record<string, ConsoleRateLimitClass> = {
  consoleDeleteTenantLogo: "write",
  consoleGetTenantLogo: "cheapRead",
  consolePreviewTenantLogo: "jobOrPreview",
  consolePutTenantLogo: "jobOrPreview",
  endSupportSession: "incidentControl",
  getCurrentSupportSession: "cheapRead",
  openSupportSession: "onboarding",
  renewSupportSession: "write",
};

describe("console rate-limit ratchet (RT-619 / RT-574 D1)", () => {
  let booted: DbLessApp;
  let byKey: Map<string, ControllerRoute>;
  let handlerIds: Set<string>;

  beforeAll(async () => {
    booted = await bootDbLessApp("console-rate-limit-ratchet");
    const routes = appControllers(booted.app).flatMap((c) => controllerRoutes(c));
    byKey = new Map(routes.map((r) => [r.key, r]));
    handlerIds = new Set(routes.map((r) => r.id));
  });

  afterAll(async () => {
    await booted.close();
  });

  const cookieOps = () => contractRoutes().filter((r) => usesScheme(r, "cookieAuth"));

  it("every runtime cookieAuth operation resolves to its snapshot class", () => {
    const actual: Record<string, ConsoleRateLimitClass> = {};
    const unmatched: string[] = [];
    for (const op of cookieOps()) {
      if (op.operation["x-runtime-status"] === "contract-only") continue;
      const route = byKey.get(contractRouteKey(op));
      if (!route) {
        unmatched.push(`${op.operation.operationId}: ${contractRouteKey(op)}`);
        continue;
      }
      actual[op.operation.operationId!] = resolveConsoleRateLimitClass(
        route.controller,
        route.handler as (...args: unknown[]) => unknown,
      );
    }
    expect(unmatched).toEqual([]);
    expect(actual).toEqual(SNAPSHOT);
  });

  it("the sweep is not vacuous", () => {
    expect(Object.keys(SNAPSHOT).length).toBeGreaterThanOrEqual(98);
  });

  it("contract-only cookieAuth operations are still runtime-less and carry an intended class", () => {
    const contractOnly = cookieOps().filter((op) => op.operation["x-runtime-status"] === "contract-only");
    expect(contractOnly.map((op) => op.operation.operationId).sort()).toEqual(Object.keys(CONTRACT_ONLY_INTENT).sort());
    for (const op of contractOnly) {
      expect({ op: op.operation.operationId, routed: byKey.has(contractRouteKey(op)) }).toEqual({
        op: op.operation.operationId,
        routed: false,
      });
    }
  });

  it("the shared exemption list is exactly the operations resolving to exempt", () => {
    const exempt = Object.entries(SNAPSHOT)
      .filter(([, cls]) => cls === "exempt")
      .map(([id]) => id)
      .sort();
    expect(exempt).toEqual([...CONSOLE_RATE_LIMIT_EXEMPT_OPERATION_IDS].sort());
  });

  it("every exemption names a real handler serving that operation", () => {
    const ops = new Map(cookieOps().map((op) => [op.operation.operationId!, op]));
    for (const { operationId, handler } of CONSOLE_RATE_LIMIT_EXEMPTIONS) {
      expect(handlerIds.has(handler)).toBe(true);
      const op = ops.get(operationId);
      expect(op).toBeDefined();
      expect(byKey.get(contractRouteKey(op!))?.id).toBe(handler);
    }
  });
});

describe("guard order (RT-574 D1/L9, AC9)", () => {
  it("ConsoleRateLimitGuard is the APP_GUARD immediately after FailClosedAuthGuard", () => {
    const providers = (Reflect.getMetadata("providers", AppModule) as unknown[]) ?? [];
    const guards = providers
      .filter((p): p is { provide: unknown; useClass: Type<unknown> } =>
        typeof p === "object" && p !== null && (p as { provide?: unknown }).provide === APP_GUARD,
      )
      .map((p) => p.useClass);
    expect(guards).toEqual([FailClosedAuthGuard, ConsoleRateLimitGuard]);
    const index = providers.findIndex(
      (p) => typeof p === "object" && p !== null && (p as { useClass?: unknown }).useClass === FailClosedAuthGuard,
    );
    expect((providers[index + 1] as { useClass?: unknown }).useClass).toBe(ConsoleRateLimitGuard);
  });
});
