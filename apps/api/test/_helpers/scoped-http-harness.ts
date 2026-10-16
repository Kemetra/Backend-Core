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

export interface ScopedHttpHarnessOptions {
  readonly label: string;
  readonly contractId: string;
  readonly module: Type<unknown> | DynamicModule;
  readonly seed: (env: PgTestEnv) => Promise<void>;
}

interface HarnessState {
  env: PgTestEnv | null;
  app: INestApplication | null;
  skipped: boolean;
}

/** Start Postgres, migrate, seed and boot; under the Docker policy a failure is fatal unless skipping is allowed. */
async function setUp(state: HarnessState, options: ScopedHttpHarnessOptions): Promise<void> {
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
}

/** A validator for `components.schemas[name]` of the contract `contractId`. */
function schemaChecker(contractId: string): (name: string, body: unknown) => void {
  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);
  const contract = loadOpenApiContracts().find((c) => c.id === contractId);
  if (!contract) throw new Error(`${contractId} not found in packages/contracts/openapi/`);
  ajv.addSchema(contract.document as object, contractId);
  return (name, body) => {
    const validate = ajv.getSchema(`${contractId}#/components/schemas/${name}`);
    if (!validate) throw new Error(`ajv cannot resolve ${name}`);
    if (!validate(body)) throw new Error(`contract violation (${name}): ${JSON.stringify(validate.errors)}`);
  };
}

function asSession(req: request.Test, session: string | null): request.Test {
  return session === null ? req : req.set("x-test-session", session);
}

export function scopedHttpHarness(options: ScopedHttpHarnessOptions): ScopedHttpHarness {
  const state: HarnessState = { env: null, app: null, skipped: false };
  const conforms = schemaChecker(options.contractId);

  beforeAll(() => setUp(state, options), 240_000);
  afterAll(async () => {
    if (state.app) await state.app.close();
    if (state.env) await stopPgEnv(state.env);
  }, 60_000);

  const server = (): Parameters<typeof request>[0] => {
    if (!state.app) throw new Error(`${options.label}: app not booted`);
    return state.app.getHttpServer() as Parameters<typeof request>[0];
  };
  const env = (): PgTestEnv => {
    if (!state.env) throw new Error(`${options.label}: no database (Docker skipped)`);
    return state.env;
  };
  const skipped = (): boolean => {
    // eslint-disable-next-line no-console
    if (state.skipped) console.warn(`[${options.label}] skipping — Docker unavailable`);
    return state.skipped;
  };

  return {
    env,
    skipped,
    get: (path, session, query = {}) => asSession(request(server()).get(path).query(query), session),
    post: (path, session, body) => asSession(request(server()).post(path).send(body), session),
    conforms,
  };
}
