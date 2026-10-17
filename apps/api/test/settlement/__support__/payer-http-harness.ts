/**
 * Shared harness for the Console payer-account HTTP integration specs
 * (RT-418 create / list, RT-572 update): the cookie-session stand-ins, the
 * seeded Console members of two tenants, the real `IdempotencyInterceptor`
 * over a fake Redis, and an Ajv checker over the `settlement.yaml` schemas.
 *
 * Only cookie authentication is faked (an `x-test-session` header names the
 * session); everything else is the real module graph against RLS-forced
 * Postgres (`bootScopedApp`).
 */
import "reflect-metadata";

import { resolve } from "node:path";

import { APP_INTERCEPTOR, Reflector } from "@nestjs/core";
import Ajv from "ajv";
import addFormats from "ajv-formats";

import { IdempotencyKeyStore } from "@data-pulse-2/shared";

import {
  IDEMPOTENCY_KEY_STORE,
  IdempotencyInterceptor,
} from "../../../src/idempotency/idempotency.interceptor";
import { InProgressMarker } from "../../../src/idempotency/in-progress-marker";
import { loadOpenApiContracts } from "../../../src/openapi/loader";
import { seedConsoleMember } from "../../_helpers/console-members";
import type { PgTestEnv } from "../../_helpers/postgres-container";
import {
  seedCatalogIsolationFixture,
  STORE_A_X,
  TENANT_A,
  TENANT_B,
} from "../../catalog/__support__/isolation-harness";

// Sessions (the `x-test-session` stand-in for the dp2_session cookie).
export const SES_OWNER_ALL = "0a000000-0000-7000-8000-0000004181a1";
export const SES_OWNER_ACTIVE_X = "0a000000-0000-7000-8000-0000004181a2";
export const SES_ADMIN_X = "0a000000-0000-7000-8000-0000004181a3";
export const SES_MANAGER = "0a000000-0000-7000-8000-0000004181a4";
export const SES_STAFF = "0a000000-0000-7000-8000-0000004181a5";
export const SES_OWNER_B = "0b000000-0000-7000-8000-0000004181b1";

export const ABSENT_STORE = "0a000000-0000-7000-8000-0000004183ff";

class FakeRedis {
  private readonly store = new Map<string, { value: string; expiresAt: number }>();
  async get(key: string): Promise<string | null> {
    const e = this.store.get(key);
    if (!e || Date.now() > e.expiresAt) return null;
    return e.value;
  }
  async set(key: string, value: string, options: { px: number }): Promise<unknown> {
    this.store.set(key, { value, expiresAt: Date.now() + options.px });
    return "OK";
  }
}

class FakeMarker {
  async trySet(): Promise<boolean> {
    return true;
  }
  async del(): Promise<void> {
    /* no-op */
  }
}

export function idempotencyProviders() {
  const redis = new FakeRedis();
  const store = new IdempotencyKeyStore({
    redis,
    pgWriter: { async insert() {} },
    pgReader: {
      async find() {
        return null;
      },
    },
    defaultTtlMs: 72 * 60 * 60 * 1000,
  });
  const interceptor = new IdempotencyInterceptor(new Reflector(), store, new FakeMarker() as unknown as InProgressMarker);
  return [
    { provide: IDEMPOTENCY_KEY_STORE, useValue: store },
    { provide: APP_INTERCEPTOR, useValue: interceptor },
  ];
}

/** An Ajv checker over `settlement.yaml`: `check("PayerAccount", body)` throws on a contract violation. */
export function contractChecker(): (name: string, body: unknown) => void {
  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);
  const dir = resolve(__dirname, "..", "..", "..", "..", "..", "packages", "contracts", "openapi", "settlement");
  const contract = loadOpenApiContracts({ dir }).find((c) => c.id === "settlement");
  if (!contract) throw new Error("settlement/settlement.yaml not found");
  ajv.addSchema(contract.document as object, "settlement");
  return (name, body) => {
    const validate = ajv.getSchema(`settlement#/components/schemas/${name}`)!;
    if (!validate(body)) throw new Error(`contract violation (${name}): ${JSON.stringify(validate.errors)}`);
  };
}

/** The catalog isolation fixture (tenants A and B) plus the Console members the payer specs sign in as. */
export async function seedPayerMembers(e: PgTestEnv): Promise<void> {
  await seedCatalogIsolationFixture(e);
  const members = [
    { userId: "0a000000-0000-7000-8000-0000004184a1", role: "owner", stores: "all" as const, sessions: { [SES_OWNER_ALL]: null, [SES_OWNER_ACTIVE_X]: STORE_A_X } },
    { userId: "0a000000-0000-7000-8000-0000004184a2", role: "tenant_admin", stores: [STORE_A_X], sessions: { [SES_ADMIN_X]: null } },
    { userId: "0a000000-0000-7000-8000-0000004184a3", role: "store_manager", stores: "all" as const, sessions: { [SES_MANAGER]: null } },
    { userId: "0a000000-0000-7000-8000-0000004184a4", role: "store_staff", stores: "all" as const, sessions: { [SES_STAFF]: null } },
  ];
  for (const [i, m] of members.entries()) {
    await seedConsoleMember(e.admin, {
      tenantId: TENANT_A,
      userId: m.userId,
      email: `rt418-${m.role}@example.test`,
      membershipId: `0a000000-0000-7000-8000-0000004185a${i + 1}`,
      roleId: `0a000000-0000-7000-8000-0000004186a${i + 1}`,
      roleCode: m.role,
      stores: m.stores,
      sessions: m.sessions,
    });
  }
  await seedConsoleMember(e.admin, {
    tenantId: TENANT_B,
    userId: "0b000000-0000-7000-8000-0000004184b1",
    email: "rt418-owner-b@example.test",
    membershipId: "0b000000-0000-7000-8000-0000004185b1",
    roleId: "0b000000-0000-7000-8000-0000004186b1",
    roleCode: "owner",
    stores: "all",
    sessions: { [SES_OWNER_B]: null },
  });
}
