/**
 * Shared HTTP harness of the console sales specs (RT-562 list / detail and
 * RT-649 summary): one Postgres per suite (Testcontainers, every migration,
 * the NOBYPASSRLS `app_test` pool), the seeded fixture, the real
 * `ConsoleSalesModule` with only cookie authentication faked, an audit spy,
 * and AJV validators compiled from the suite's contract.
 *
 * Docker policy: HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 *
 * `.ts` (not `.spec.ts`) so Jest does not collect it.
 */
import type { INestApplication } from "@nestjs/common";
import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import request from "supertest";

import type { AuditJobEnqueuer } from "../../../src/audit/audit-job.enqueuer";
import type { AuditJobPayload } from "../../../src/audit/audit-job.types";
import { ConsoleSalesModule } from "../../../src/console-sales/console-sales.module";
import { loadOpenApiContracts } from "../../../src/openapi/loader";
import { applyAllUpAndCreateAppRole, startPgEnv, stopPgEnv, type PgTestEnv } from "../../_helpers/postgres-container";
import { bootScopedApp } from "../../catalog/erpnext-reconciliation/__support__/read-store-scope";

export type Query = Record<string, string | number>;

export class SpyAuditEnqueuer implements AuditJobEnqueuer {
  readonly payloads: AuditJobPayload[] = [];
  async enqueue(payload: AuditJobPayload): Promise<void> {
    this.payloads.push(payload);
  }
}

export interface ConsoleHttpHarness {
  readonly audit: SpyAuditEnqueuer;
  /** True (with a warning) when Docker is unavailable and skipping is allowed. */
  skip(): boolean;
  env(): PgTestEnv;
  app(): INestApplication;
  /** The validator of `#/components/schemas/<name>` in the suite's contract. */
  schema(name: string): ValidateFunction;
  /** A GET of `path`, authenticated as `session` (null: no test session). */
  get(path: string, session: string | null, query?: Query | string): request.Test;
}

/** Registers the suite's beforeAll / afterAll and returns its accessors. */
export function useConsoleHttpHarness(options: {
  readonly label: string;
  readonly contractId: string;
  readonly seed: (env: PgTestEnv) => Promise<void>;
}): ConsoleHttpHarness {
  const audit = new SpyAuditEnqueuer();
  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);
  let env: PgTestEnv | null = null;
  let app: INestApplication | null = null;
  let dockerSkipped = false;

  beforeAll(async () => {
    const found = loadOpenApiContracts().find((c) => c.id === options.contractId);
    if (!found) throw new Error(`${options.contractId} not found in packages/contracts/openapi/`);
    ajv.addSchema(found.document as object, options.contractId);
    try {
      env = await startPgEnv();
      await applyAllUpAndCreateAppRole(env);
      await options.seed(env);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
        dockerSkipped = true;
        // eslint-disable-next-line no-console
        console.warn(`\n[${options.label}] Docker NOT AVAILABLE: ${msg}\n`);
        return;
      }
      throw new Error(`Container start failed: ${msg}`);
    }
    // Bearer tokens resolve on the RLS-exempt pool, as the production auth-lookup role does.
    app = await bootScopedApp(env, ConsoleSalesModule, audit, { authLookupPool: env.admin });
  }, 240_000);

  afterAll(async () => {
    if (app) await app.close();
    if (env) await stopPgEnv(env);
  }, 60_000);

  return {
    audit,
    skip(): boolean {
      // eslint-disable-next-line no-console
      if (dockerSkipped) console.warn(`[${options.label}] skipping — Docker unavailable`);
      return dockerSkipped;
    },
    env(): PgTestEnv {
      if (!env) throw new Error("env not initialized");
      return env;
    },
    app(): INestApplication {
      if (!app) throw new Error("app not initialized");
      return app;
    },
    schema(name: string): ValidateFunction {
      const v = ajv.getSchema(`${options.contractId}#/components/schemas/${name}`);
      if (!v) throw new Error(`ajv cannot resolve ${name}`);
      return v;
    },
    get(path: string, session: string | null, query: Query | string = {}): request.Test {
      const req = request(app!.getHttpServer()).get(path).query(query);
      return session === null ? req : req.set("x-test-session", session);
    },
  };
}

export function expectValid(validate: ValidateFunction, body: unknown): void {
  if (!validate(body)) throw new Error(`contract violation: ${JSON.stringify(validate.errors)}`);
}
