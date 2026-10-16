/**
 * A Testcontainers harness for Console HTTP specs on the RT-192 scoped app
 * (`bootScopedApp`): it registers the Jest lifecycle (start Postgres, apply
 * every migration, seed, boot the module), honours the repo Docker policy
 * (hard failure unless MIGRATION_TEST_ALLOW_SKIP=1), sends requests as a
 * named test session and checks bodies against a contract's schemas.
 *
 * `.ts` (not `.spec.ts`) so Jest does not collect it.
 */
import type { DynamicModule, INestApplication, Type } from "@nestjs/common";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import request from "supertest";

import { loadOpenApiContracts } from "../../src/openapi/loader";
import { bootScopedApp } from "../catalog/erpnext-reconciliation/__support__/read-store-scope";
import { applyAllUpAndCreateAppRole, startPgEnv, stopPgEnv, type PgTestEnv } from "./postgres-container";

export interface ScopedHttpHarness {
  /** The started environment; throws when Docker was skipped. */
  env(): PgTestEnv;
  /** True (with a warning) when Docker is unavailable and skipping is allowed. */
  skipped(): boolean;
  get(path: string, session: string | null, query?: Record<string, string | number>): request.Test;
  post(path: string, session: string | null, body: object): request.Test;
  /** Throws with the AJV errors when `body` does not match `components.schemas[name]`. */
  conforms(name: string, body: unknown): void;
}

export function scopedHttpHarness(options: {
  readonly label: string;
  readonly contractId: string;
  readonly module: Type<unknown> | DynamicModule;
  readonly seed: (env: PgTestEnv) => Promise<void>;
}): ScopedHttpHarness {
  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);
  const state: { env: PgTestEnv | null; app: INestApplication | null; skipped: boolean } = {
    env: null,
    app: null,
    skipped: false,
  };

  beforeAll(async () => {
    const contract = loadOpenApiContracts().find((c) => c.id === options.contractId);
    if (!contract) throw new Error(`${options.contractId} not found in packages/contracts/openapi/`);
    ajv.addSchema(contract.document as object, options.contractId);
    try {
      state.env = await startPgEnv();
      await applyAllUpAndCreateAppRole(state.env);
      await options.seed(state.env);
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      if (process.env["MIGRATION_TEST_ALLOW_SKIP"] !== "1") throw new Error(`Container start failed: ${reason}`);
      state.skipped = true;
      // eslint-disable-next-line no-console
      console.warn(`\n[${options.label}] Docker NOT AVAILABLE: ${reason}\n`);
      return;
    }
    // Bearer tokens resolve on the RLS-exempt pool, as the production auth-lookup role does.
    state.app = await bootScopedApp(state.env, options.module, undefined, { authLookupPool: state.env.admin });
  }, 240_000);

  afterAll(async () => {
    if (state.app) await state.app.close();
    if (state.env) await stopPgEnv(state.env);
  }, 60_000);

  const as = (req: request.Test, session: string | null): request.Test =>
    session === null ? req : req.set("x-test-session", session);
  const server = (): Parameters<typeof request>[0] => {
    if (!state.app) throw new Error(`${options.label}: app not booted`);
    return state.app.getHttpServer() as Parameters<typeof request>[0];
  };

  return {
    env: () => {
      if (!state.env) throw new Error(`${options.label}: no database (Docker skipped)`);
      return state.env;
    },
    skipped: () => {
      // eslint-disable-next-line no-console
      if (state.skipped) console.warn(`[${options.label}] skipping — Docker unavailable`);
      return state.skipped;
    },
    get: (path, session, query = {}) => as(request(server()).get(path).query(query), session),
    post: (path, session, body) => as(request(server()).post(path).send(body), session),
    conforms: (name, body) => {
      const validate = ajv.getSchema(`${options.contractId}#/components/schemas/${name}`);
      if (!validate) throw new Error(`ajv cannot resolve ${name}`);
      if (!validate(body)) throw new Error(`contract violation (${name}): ${JSON.stringify(validate.errors)}`);
    },
  };
}
