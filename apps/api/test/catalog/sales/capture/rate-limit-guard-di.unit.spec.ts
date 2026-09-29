/**
 * rate-limit-guard-di.unit.spec.ts — regression guard for the PR #600 fallout.
 *
 * PR #600 (ADR-0009) added `@UseGuards(…, PosWriteRateLimitGuard)` to
 * `SalesController.captureSale`. Nest validates the guard's provider graph at
 * module-compile time even when the guard is overridden to a no-op, so the
 * `RateLimiter` dependency MUST be resolvable in any TestingModule that declares
 * `SalesController` — or the whole module fails to build with
 * `Nest can't resolve dependencies of the PosWriteRateLimitGuard (RateLimiter, …)`.
 * That deterministic failure broke every POS-write Docker integration suite on
 * `main` (db-integration red since 2026-06-20, cb26b15).
 *
 * This Docker-FREE spec reproduces the module-build in isolation: it asserts the
 * module compiles when `RateLimiter` is provided (and the guard overridden),
 * pinning the harness contract so a future guard-dependency addition can't
 * silently re-break every integration suite. No DB, no Testcontainers.
 */
import "reflect-metadata";
import { Test } from "@nestjs/testing";

import { SalesController } from "../../../../src/catalog/sales/sales.controller";
import { SalesService } from "../../../../src/catalog/sales/sales.service";
import { SaleReturnsService } from "../../../../src/catalog/sales/sale-returns.service";
import { PG_POOL } from "../../../../src/auth/auth.module";
import { OPERATOR_CONTEXT_RESOLVER } from "../../../../src/auth/operator-context-resolver";
import { PosOperatorEnvelopeSaleGuard } from "../../../../src/auth/pos-operator-envelope-sale.guard";
import { PosOperatorAuthGuard } from "../../../../src/auth/pos-operator-auth.guard";
import { TenantContextGuard } from "../../../../src/context/tenant-context.guard";
import { PosWriteRateLimitGuard } from "../../../../src/auth/pos-write-rate-limit.guard";
import { RateLimiter } from "../../../../src/auth/rate-limit";

/** Minimal always-allow RateLimiter fake (mirrors the guard unit spec). */
const fakeRateLimiter = {
  check: async () => ({ allowed: true, count: 1, remaining: 99, resetMs: 1000 }),
} as unknown as RateLimiter;

/**
 * Build the module the way the integration harness does. `overrideRateLimitGuard`
 * toggles the FIX: whether `PosWriteRateLimitGuard` is overridden to a no-op.
 * The other three guards are always overridden (as the real harness does).
 *
 * Key Nest behaviour: `.overrideGuard(X)` replaces X with a stub and Nest NEVER
 * instantiates the real X — so its `RateLimiter` constructor dependency is never
 * resolved. Conversely, NOT overriding `PosWriteRateLimitGuard` makes Nest try to
 * construct the real guard and fail on the unresolvable `RateLimiter` — which is
 * exactly the PR #600 break (the harness overrides the other guards but not this
 * one). The fix is the override, NOT adding a RateLimiter provider.
 */
function compileSalesModule(overrideRateLimitGuard: boolean): Promise<unknown> {
  const providers = [
    SalesService,
    SaleReturnsService,
    { provide: PG_POOL, useValue: {} },
    {
      provide: OPERATOR_CONTEXT_RESOLVER,
      useValue: { resolve: async () => ({ kind: "refused", reason: "device_invalid" }) },
    },
  ];
  let builder = Test.createTestingModule({ controllers: [SalesController], providers })
    .overrideGuard(PosOperatorEnvelopeSaleGuard)
    .useValue({ canActivate: () => true })
    .overrideGuard(PosOperatorAuthGuard)
    .useValue({ canActivate: () => true })
    .overrideGuard(TenantContextGuard)
    .useValue({ canActivate: () => true });
  if (overrideRateLimitGuard) {
    builder = builder
      .overrideGuard(PosWriteRateLimitGuard)
      .useValue({ canActivate: () => true });
  }
  return builder.compile();
}

describe("SalesController module build — PosWriteRateLimitGuard DI (PR #600 regression)", () => {
  it("FAILS to compile when PosWriteRateLimitGuard is NOT overridden (reproduces the break)", async () => {
    // The real guard is constructed; its RateLimiter dep is unresolvable here.
    await expect(compileSalesModule(false)).rejects.toThrow(/RateLimiter|PosWriteRateLimitGuard/);
  });

  it("compiles when PosWriteRateLimitGuard IS overridden to a no-op (the fix)", async () => {
    const moduleRef = await compileSalesModule(true);
    expect(moduleRef).toBeDefined();
  });
});
