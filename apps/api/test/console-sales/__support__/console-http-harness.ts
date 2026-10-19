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

interface HarnessOptions {
  readonly label: string;
  readonly contractId: string;
  readonly seed: (env: PgTestEnv) => Promise<void>;
}

export class ConsoleHttpHarness {
  readonly audit = new SpyAuditEnqueuer();
  private readonly ajv = new Ajv({ strict: false, allErrors: true });
  private pg: PgTestEnv | null = null;
  private nest: INestApplication | null = null;
  private dockerSkipped = false;

  constructor(private readonly options: HarnessOptions) {
    addFormats(this.ajv);
  }

  /** Load the contract, start Postgres, migrate, seed and boot the module. */
  async setUp(): Promise<void> {
    const found = loadOpenApiContracts().find((c) => c.id === this.options.contractId);
    if (!found) throw new Error(`${this.options.contractId} not found in packages/contracts/openapi/`);
    this.ajv.addSchema(found.document as object, this.options.contractId);
    try {
      this.pg = await startPgEnv();
      await applyAllUpAndCreateAppRole(this.pg);
      await this.options.seed(this.pg);
    } catch (err: unknown) {
      this.skipOrThrow(err);
      return;
    }
    // Bearer tokens resolve on the RLS-exempt pool, as the production auth-lookup role does.
    this.nest = await bootScopedApp(this.pg, ConsoleSalesModule, this.audit, { authLookupPool: this.pg.admin });
  }

  async tearDown(): Promise<void> {
    if (this.nest) await this.nest.close();
    if (this.pg) await stopPgEnv(this.pg);
  }

  private skipOrThrow(err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] !== "1") throw new Error(`Container start failed: ${msg}`);
    this.dockerSkipped = true;
    // eslint-disable-next-line no-console
    console.warn(`\n[${this.options.label}] Docker NOT AVAILABLE: ${msg}\n`);
  }

  /** True (with a warning) when Docker is unavailable and skipping is allowed. */
  skip(): boolean {
    // eslint-disable-next-line no-console
    if (this.dockerSkipped) console.warn(`[${this.options.label}] skipping — Docker unavailable`);
    return this.dockerSkipped;
  }

  env(): PgTestEnv {
    if (!this.pg) throw new Error("env not initialized");
    return this.pg;
  }

  /** The validator of `#/components/schemas/<name>` in the suite's contract. */
  schema(name: string): ValidateFunction {
    const v = this.ajv.getSchema(`${this.options.contractId}#/components/schemas/${name}`);
    if (!v) throw new Error(`ajv cannot resolve ${name}`);
    return v;
  }

  /** A GET of `path`, authenticated as `session` (null: no test session). */
  get(path: string, session: string | null, query: Query | string = {}): request.Test {
    if (!this.nest) throw new Error("app not initialized");
    const req = request(this.nest.getHttpServer()).get(path).query(query);
    return session === null ? req : req.set("x-test-session", session);
  }
}

/** Registers the suite's beforeAll / afterAll and returns its harness. */
export function useConsoleHttpHarness(options: HarnessOptions): ConsoleHttpHarness {
  const harness = new ConsoleHttpHarness(options);
  beforeAll(() => harness.setUp(), 240_000);
  afterAll(() => harness.tearDown(), 60_000);
  return harness;
}

export function expectValid(validate: ValidateFunction, body: unknown): void {
  if (!validate(body)) throw new Error(`contract violation: ${JSON.stringify(validate.errors)}`);
}
