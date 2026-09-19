import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import type { Pool } from "pg";

import { InstrumentedPool } from "../observability/instrumented-pool";

export const PG_POOL = "PG_POOL";
export const AUTH_LOOKUP_POOL = "AUTH_LOOKUP_POOL";

const ownedPools = new WeakSet<Pool>();

function createOwnedPool(connectionString: string): Pool {
  const pool = new InstrumentedPool({ connectionString });
  ownedPools.add(pool);
  return pool;
}

export function domainPoolFactory(): Pool {
  const url = process.env["DATABASE_URL"];
  if (!url) {
    throw new Error("AuthModule: DATABASE_URL is not set; cannot create domain pg.Pool");
  }
  return createOwnedPool(url);
}

/**
 * Pre-tenant identity/token/device lookup pool.
 *
 * Production must provide a distinct credential. Tests and local development
 * may deliberately reuse an injected PG_POOL so hermetic module tests do not
 * need a second database user. That fallback is never available in production.
 */
export function authLookupPoolFactory(domainPool: Pool): Pool {
  const lookupUrl = process.env["AUTH_LOOKUP_DATABASE_URL"];
  if (!lookupUrl) {
    if (process.env["NODE_ENV"] === "production") {
      throw new Error(
        "AuthModule: AUTH_LOOKUP_DATABASE_URL is required in production; " +
          "pre-tenant lookups must not reuse the domain pool",
      );
    }
    return domainPool;
  }

  const domainUrl = process.env["DATABASE_URL"];
  if (process.env["NODE_ENV"] === "production" && lookupUrl === domainUrl) {
    throw new Error(
      "AuthModule: AUTH_LOOKUP_DATABASE_URL must use credentials distinct from DATABASE_URL",
    );
  }
  return createOwnedPool(lookupUrl);
}

interface RoleRow {
  role_name: string;
  is_superuser: boolean;
  bypass_rls: boolean;
}

async function readRole(pool: Pool): Promise<RoleRow> {
  const result = await pool.query<RoleRow>(
    `SELECT current_user AS role_name,
            r.rolsuper AS is_superuser,
            r.rolbypassrls AS bypass_rls
       FROM pg_roles r
      WHERE r.rolname = current_user`,
  );
  const role = result.rows[0];
  if (!role) throw new Error("database pool role could not be resolved");
  return role;
}

/** Exported for Testcontainers proof of the production role boundary. */
export async function verifyDatabasePoolBoundary(
  domainPool: Pool,
  lookupPool: Pool,
): Promise<void> {
  const [domainRole, lookupRole] = await Promise.all([
    readRole(domainPool),
    readRole(lookupPool),
  ]);

  if (domainRole.is_superuser || domainRole.bypass_rls) {
    throw new Error(
      "AuthModule: DATABASE_URL role must be non-superuser and must not have BYPASSRLS",
    );
  }
  if (lookupRole.is_superuser) {
    throw new Error("AuthModule: AUTH_LOOKUP_DATABASE_URL role must not be a superuser");
  }
  if (!lookupRole.bypass_rls) {
    throw new Error(
      "AuthModule: AUTH_LOOKUP_DATABASE_URL role must have BYPASSRLS for pre-tenant lookups",
    );
  }
  if (domainRole.role_name === lookupRole.role_name) {
    throw new Error(
      "AuthModule: domain and pre-tenant lookup pools must use distinct database roles",
    );
  }
}

@Injectable()
export class DatabasePoolBoundaryVerifier implements OnModuleInit {
  constructor(
    @Inject(PG_POOL) private readonly domainPool: Pool,
    @Inject(AUTH_LOOKUP_POOL) private readonly lookupPool: Pool,
  ) {}

  async onModuleInit(): Promise<void> {
    if (
      process.env["NODE_ENV"] === "production" ||
      process.env["VERIFY_DATABASE_POOL_BOUNDARY"] === "1"
    ) {
      await verifyDatabasePoolBoundary(this.domainPool, this.lookupPool);
    }
  }
}

/** Close only pools created by this module; never close test-supplied pools. */
@Injectable()
export class DatabasePoolLifecycle implements OnModuleDestroy {
  constructor(
    @Inject(PG_POOL) private readonly domainPool: Pool,
    @Inject(AUTH_LOOKUP_POOL) private readonly lookupPool: Pool,
  ) {}

  async onModuleDestroy(): Promise<void> {
    const pools = new Set([this.domainPool, this.lookupPool]);
    await Promise.all(
      [...pools]
        .filter((pool) => ownedPools.has(pool))
        .map((pool) => pool.end()),
    );
  }
}
