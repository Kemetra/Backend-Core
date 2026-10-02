/**
 * __snapshot-harness.ts — shared Testcontainers + Nest wiring for the 010 US1
 * snapshot specs (T030–T034, T036). NOT a spec file (`__`-prefixed, no `.spec`)
 * so Jest's testMatch ignores it.
 *
 * Mirrors the 008 `__capture-harness.ts`: a hand-rolled `Test.createTestingModule`
 * with the real ReadDownController + ReadDownService (PG_POOL → env.app, so the
 * resolver runs UNDER RLS — tenant isolation is real), the device-auth guards
 * overridden to allow, and a configurable POS-principal context guard that sets
 * `req.context`. Seeds the read-down fixtures (seedReadDownFixture, which calls
 * seedCatalogIsolationFixture first) so the resolver has priced/unpriced/
 * non-representable products + an override across tenants A/B and stores X/Y.
 */
import "reflect-metadata";

import {
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
  type Provider,
} from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { Pool } from "pg";
import request from "supertest";

import { GlobalExceptionFilter } from "../../../../src/common/exception.filter";
import { PG_POOL } from "../../../../src/auth/auth.module";
import { PosDeviceAuthGuard } from "../../../../src/auth/pos-device-auth.guard";
import type { ResolvedContext } from "../../../../src/context/types";

import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../../_helpers/postgres-container";
import {
  TENANT_A,
  TENANT_B,
  STORE_A_X,
  STORE_A_Y,
  STORE_B_X,
} from "../../__support__/isolation-harness";
import {
  READ_DOWN_FIXTURE_IDS,
  seedReadDownFixture,
} from "../__support__/seed-read-down";

import { ReadDownController } from "../../../../src/catalog/read-down/read-down.controller";
import { ReadDownService } from "../../../../src/catalog/read-down/read-down.service";

export {
  TENANT_A,
  TENANT_B,
  STORE_A_X,
  STORE_A_Y,
  STORE_B_X,
  READ_DOWN_FIXTURE_IDS,
  type PgTestEnv,
};

/** Stand-in POS device principal id (`req.context.userId`). */
export const DEVICE_USER_ID = "0d000000-0000-7000-8000-0000000010d1";

/** Sets `req.context` to a POS principal; mutable per test. */
export class ConfigurableContextGuard implements CanActivate {
  public tenantId: string | null = TENANT_A;
  public storeId: string | null = STORE_A_X;
  public userId: string | null = DEVICE_USER_ID;
  /** When true, publishes NO context — exercises the unauthenticated path. */
  public anonymous = false;

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<{
      context?: ResolvedContext;
      principal?: { userId?: string };
    }>();
    if (this.anonymous) return true;
    req.context = {
      userId: this.userId,
      tenantId: this.tenantId,
      storeId: this.storeId,
      isPlatformAdmin: false,
      source: "token",
    };
    if (this.userId) req.principal = { userId: this.userId };
    return true;
  }
}

export interface SnapshotHarness {
  readonly env: PgTestEnv;
  readonly app: INestApplication;
  readonly contextGuard: ConfigurableContextGuard;
  http(): ReturnType<typeof request>;
}

export interface HarnessHandle {
  harness: SnapshotHarness | null;
  dockerSkipped: boolean;
}

export async function startSnapshotHarness(): Promise<HarnessHandle> {
  let env: PgTestEnv;
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[010 snapshot harness] Docker NOT AVAILABLE: ${msg}\n`);
      return { harness: null, dockerSkipped: true };
    }
    throw new Error(`Container start failed: ${msg}`);
  }

  let startedApp: INestApplication | undefined;
  try {
    await applyAllUpAndCreateAppRole(env);
    // Seeds the catalog parents + the 010 priced/unpriced/non-repr products +
    // the store A-X override (whose INSERT fires the 0015 triggers).
    await seedReadDownFixture(env);

    const contextGuard = new ConfigurableContextGuard();
    const providers: Provider[] = [
      { provide: PG_POOL, useFactory: (): Pool => env.app },
      ReadDownService,
    ];

    const moduleRef = await Test.createTestingModule({
      controllers: [ReadDownController],
      providers,
    })
      // The read-down routes now guard with PosDeviceAuthGuard (issue #488,
      // Option B-prime). These resolver/projection specs are NOT about auth —
      // the global ConfigurableContextGuard below injects req.context — so the
      // route guard is stubbed to allow. Device-principal auth itself is
      // covered by pos-device-auth.guard.unit.spec.ts + the real-guard
      // integration spec device-auth-required.spec.ts.
      .overrideGuard(PosDeviceAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    const app = moduleRef.createNestApplication({ bufferLogs: true });
    startedApp = app;
    app.useGlobalFilters(new GlobalExceptionFilter());
    app.useGlobalGuards(contextGuard);
    await app.init();

    return {
      harness: {
        env,
        app,
        contextGuard,
        http: () => request(app.getHttpServer()),
      },
      dockerSkipped: false,
    };
  } catch (err) {
    if (startedApp) await startedApp.close().catch(() => undefined);
    await stopPgEnv(env).catch(() => undefined);
    throw err;
  }
}

export async function stopSnapshotHarness(h: HarnessHandle): Promise<void> {
  if (h.harness) {
    await h.harness.app.close();
    await stopPgEnv(h.harness.env);
  }
}

export function resetHarness(h: HarnessHandle): void {
  if (!h.harness) return;
  h.harness.contextGuard.tenantId = TENANT_A;
  h.harness.contextGuard.storeId = STORE_A_X;
  h.harness.contextGuard.userId = DEVICE_USER_ID;
  h.harness.contextGuard.anonymous = false;
}
