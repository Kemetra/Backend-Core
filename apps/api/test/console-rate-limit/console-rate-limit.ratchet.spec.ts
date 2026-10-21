/**
 * RT-619 — console rate-limit ratchet and guard order (RT-574 issue 1, AC5,
 * AC6, AC9).
 *
 * Sweeps the real AppModule (no DB, no Redis) and every OpenAPI contract:
 *   - every operation that declares `cookieAuth` is classified in its
 *     contract's class file, `classes/<contract>.rate-limit.yaml` (RT-805: one
 *     file per contract, so parallel PRs never edit a shared list). A new
 *     cookieAuth operation that is not classified fails here, so its author
 *     must classify it (the runtime still falls back to the verb default, so a
 *     missed entry never leaves a route unlimited). A changed class is a
 *     deliberate class-file edit;
 *   - a runtime operation resolves to its declared class; a contract-only one
 *     (`x-runtime-status: contract-only`) carries its INTENDED class (RT-574
 *     D3) and the spec breaks when it gains a route while still marked. When
 *     its runtime ships, only the marker goes; the class entry stays;
 *   - no entry is stale, duplicated or of an unknown class (negative cases in
 *     console-rate-limit.ratchet-rules.spec.ts);
 *   - the shared exemption list matches the runtime exactly;
 *   - the guard is registered immediately after FailClosedAuthGuard in
 *     AppModule's providers.
 *
 * The classes start from the RT-574 D3 class lists (owner O2/O4).
 */
import "reflect-metadata";

import type { Type } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";

import { AppModule } from "../../src/app.module";
import { FailClosedAuthGuard } from "../../src/auth/fail-closed-auth.guard";
import { resolveConsoleRateLimitClass } from "../../src/console-rate-limit/console-rate-limit.classify";
import { CONSOLE_RATE_LIMIT_BUDGETS } from "../../src/console-rate-limit/console-rate-limit.config";
import {
  CONSOLE_RATE_LIMIT_EXEMPTIONS,
  CONSOLE_RATE_LIMIT_EXEMPT_OPERATION_IDS,
} from "../../src/console-rate-limit/console-rate-limit.exemptions";
import { ConsoleRateLimitGuard } from "../../src/console-rate-limit/console-rate-limit.guard";
import { loadClassFiles, ratchetViolations } from "../_helpers/console-rate-limit-classes";
import { appControllers, bootDbLessApp, type DbLessApp } from "../_helpers/db-less-app";
import {
  contractRouteKey,
  contractRoutes,
  controllerRoutes,
  usesScheme,
  type ContractRoute,
  type ControllerRoute,
} from "../_helpers/openapi-routes";

const VALID_CLASSES: ReadonlySet<string> = new Set([...Object.keys(CONSOLE_RATE_LIMIT_BUDGETS), "exempt"]);

/** operationId → declared class, across every class file. */
const declaredClasses = (): Record<string, string> =>
  Object.assign({}, ...loadClassFiles().map((f) => f.classes)) as Record<string, string>;

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
  const isRuntime = (op: ContractRoute) => op.operation["x-runtime-status"] !== "contract-only";

  it("every cookieAuth operation is classified in its contract's class file and the runtime agrees", () => {
    const violations = ratchetViolations({
      cookieOps: cookieOps(),
      classFiles: loadClassFiles(),
      validClasses: VALID_CLASSES,
      resolveRuntime: (op) => {
        const route = byKey.get(contractRouteKey(op));
        return route && resolveConsoleRateLimitClass(route.controller, route.handler as (...args: unknown[]) => unknown);
      },
    });
    expect(violations).toEqual([]);
  });

  it("the sweep is not vacuous", () => {
    expect(cookieOps().filter(isRuntime).length).toBeGreaterThanOrEqual(98);
    expect(Object.keys(declaredClasses())).toHaveLength(cookieOps().length);
  });

  it("the shared exemption list is exactly the operations resolving to exempt", () => {
    const runtimeIds = new Set(cookieOps().filter(isRuntime).map((op) => op.operation.operationId!));
    const exempt = Object.entries(declaredClasses())
      .filter(([id, cls]) => cls === "exempt" && runtimeIds.has(id))
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
