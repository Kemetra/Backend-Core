/**
 * Boot helpers for Testcontainers specs of a device-bearer POS module
 * (`@DeviceBearer` + `PosDeviceAuthGuard`), first used by RT-788.
 *
 *   - `startPgEnvOrSkip`: start Postgres and apply every migration, under the
 *     repo Docker policy (hard failure unless MIGRATION_TEST_ALLOW_SKIP=1;
 *     then null, with a warning).
 *   - `bootDeviceModuleApp`: the real module with the device lookup on the
 *     RLS-exempt pool (as the production auth-lookup role) and the domain
 *     pool on the NOBYPASSRLS role, plus the production request-id
 *     interceptor, exception filter and global Zod pipe.
 *
 * `.ts` (not `.spec.ts`) so Jest does not collect it.
 */
import "reflect-metadata";

import type { DynamicModule, INestApplication, Type } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { Pool } from "pg";

import { AUTH_LOOKUP_POOL, PG_POOL } from "../../src/auth/auth.module";
import { GlobalExceptionFilter } from "../../src/common/exception.filter";
import { RequestIdInterceptor } from "../../src/common/request-id.interceptor";
import { ZodValidationPipe } from "../../src/common/zod-validation.pipe";
import { applyAllUpAndCreateAppRole, startPgEnv, type PgTestEnv } from "./postgres-container";

/** A migrated Postgres, or null when Docker is unavailable and skipping is allowed. */
export async function startPgEnvOrSkip(label: string): Promise<PgTestEnv | null> {
  let env: PgTestEnv;
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] !== "1") throw new Error(`Container start failed: ${reason}`);
    // eslint-disable-next-line no-console
    console.warn(`\n[${label}] Docker NOT AVAILABLE — skipping: ${reason}\n`);
    return null;
  }
  await applyAllUpAndCreateAppRole(env);
  return env;
}

export interface DevicePools {
  /** The NOBYPASSRLS domain pool (PG_POOL). */
  readonly domain: Pool;
  /** The RLS-exempt device lookup pool (AUTH_LOOKUP_POOL). */
  readonly lookup: Pool;
}

/** The module, booted as an HTTP app over the given pools. */
export async function bootDeviceModuleApp(
  module: Type<unknown> | DynamicModule,
  pools: DevicePools,
): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [module] })
    .overrideProvider(PG_POOL)
    .useValue(pools.domain)
    .overrideProvider(AUTH_LOOKUP_POOL)
    .useValue(pools.lookup)
    .compile();
  const app = moduleRef.createNestApplication({ bufferLogs: true, logger: false });
  app.useGlobalInterceptors(new RequestIdInterceptor());
  app.useGlobalFilters(new GlobalExceptionFilter());
  app.useGlobalPipes(new ZodValidationPipe());
  await app.init();
  return app;
}
