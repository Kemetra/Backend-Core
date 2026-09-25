import { Injectable, Module, type OnModuleDestroy, type OnModuleInit, Inject } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { readdir, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Pool } from "pg";

import { AuditModule } from "./audit/audit.module";
import { AuthModule, PG_POOL } from "./auth/auth.module";
import { FailClosedAuthGuard } from "./auth/fail-closed-auth.guard";
import { ErpnextBinViewModule } from "./catalog/erpnext-bin-view/erpnext-bin-view.module";
import { ErpnextItemMapModule } from "./catalog/erpnext-item-map/erpnext-item-map.module";
import { ErpnextPostingModule } from "./catalog/erpnext-posting/erpnext-posting.module";
import { ErpnextProductReconciliationModule } from "./catalog/erpnext-product-reconciliation/erpnext-product-reconciliation.module";
import { ErpnextReconciliationModule } from "./catalog/erpnext-reconciliation/erpnext-reconciliation.module";
import { ErpnextSyncOpsModule } from "./catalog/erpnext-sync-ops/erpnext-sync-ops.module";
import { ErpnextWarehouseMapModule } from "./catalog/erpnext-warehouse-map/erpnext-warehouse-map.module";
import { ReadDownModule } from "./catalog/read-down/read-down.module";
import { ConnectorModule } from "./connector/connector.module";
import { ConnectorHealthModule } from "./connector-health/connector-health.module";
import { PairingModule } from "./pos-terminal-pairing/pairing.module";
import { ReconciliationModule } from "./catalog/reconciliation/reconciliation.module";
import { SalesModule } from "./catalog/sales/sales.module";
import { SaleSyncOpsModule } from "./catalog/sale-sync-ops/sale-sync-ops.module";
import { UnknownItemsModule } from "./catalog/unknown-items/unknown-items.module";
import { ContextModule } from "./context/context.module";
import { InventoryModule } from "./inventory/inventory.module";
import { MembershipsModule } from "./memberships/memberships.module";
import { OutboxAdminModule } from "./outbox/admin.module";
import { PosAuditEventsModule } from "./pos-audit-events/pos-audit-events.module";
import { PosOperatorsModule } from "./pos-operators/pos-operators.module";
import { PosShiftsModule } from "./pos-shifts/pos-shifts.module";
import { SettlementModule } from "./settlement/settlement.module";
import { StoresModule } from "./stores/stores.module";
import { TenantsModule } from "./tenants/tenants.module";
import {
  registerDbPoolGauges,
  registerDbMigrationStatusGauge,
} from "./observability/metrics/db.metrics";

/**
 * Nest-aware registrar for the `db_pool_in_use` and `db_pool_waiters`
 * ObservableGauge callbacks (T483 / P4 W1).
 *
 * On `onModuleInit` registers both callbacks against the API's pg.Pool
 * (injected via PG_POOL, exported by AuthModule). On `onModuleDestroy`
 * removes them so the callbacks do not reference a closed pool during
 * graceful shutdown.
 *
 * The pool reads are synchronous in-memory counters — no DB round-trip,
 * no re-entrancy risk, no async I/O.
 */
@Injectable()
class ApiDbPoolGaugeRegistrar implements OnModuleInit, OnModuleDestroy {
  private handle: { stop: () => void } | null = null;

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  onModuleInit(): void {
    this.handle = registerDbPoolGauges({ pool: this.pool });
  }

  onModuleDestroy(): void {
    const h = this.handle;
    this.handle = null;
    if (h !== null) {
      h.stop();
    }
  }
}

/**
 * Walk upward from `startDir` looking for the pnpm workspace root.
 * Returns the absolute path to the directory that contains
 * `pnpm-workspace.yaml`, or `null` if no such ancestor exists.
 *
 * Exported for unit tests; not part of the public API surface.
 */
export async function findWorkspaceRoot(
  startDir: string,
): Promise<string | null> {
  let current = resolve(startDir);
  // Hard ceiling on traversal depth to avoid infinite loops on broken FS.
  for (let i = 0; i < 32; i += 1) {
    try {
      const sentinel = resolve(current, "pnpm-workspace.yaml");
      const s = await stat(sentinel);
      if (s.isFile()) return current;
    } catch {
      // sentinel not present at this level — keep walking up
    }
    const parent = dirname(current);
    if (parent === current) return null; // reached filesystem root
    current = parent;
  }
  return null;
}

/**
 * Resolve the directory holding up-migration `*.sql` files.
 *
 * Resolution order:
 *   1. `DB_MIGRATIONS_DIR` env var, if set — used verbatim (absolute or
 *      relative to `process.cwd()`).
 *   2. Walk upward from `startDir` to the pnpm workspace root and resolve
 *      `<root>/packages/db/drizzle/`.
 *
 * Returns `null` if neither path can be resolved. Callers MUST treat
 * `null` as a discovery failure (never as "zero migrations").
 *
 * Exported for unit tests.
 */
export async function resolveMigrationsDir(
  startDir: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const override = env["DB_MIGRATIONS_DIR"];
  if (override !== undefined && override.length > 0) {
    return resolve(override);
  }
  const root = await findWorkspaceRoot(startDir);
  if (root === null) return null;
  return resolve(root, "packages", "db", "drizzle");
}

/**
 * Count UP migration SQL files in `<workspace>/packages/db/drizzle/`.
 *
 * Counting rules:
 *   - Match `^\d{4}_.+\.sql$` (e.g. `0007_catalog.sql`).
 *   - Exclude `*.down.sql` (rollback companions) so the count equals the
 *     up-migration ledger.
 *
 * Throws on any filesystem error (directory missing, unreadable, …) so
 * the caller can fall back to a safe "unknown total" state rather than
 * silently emitting a false-healthy signal.
 *
 * Exported for unit tests.
 */
export async function countMigrationFiles(
  startDir: string = __dirname,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const drizzleDir = await resolveMigrationsDir(startDir, env);
  if (drizzleDir === null) {
    throw new Error(
      "could not locate migrations directory: no DB_MIGRATIONS_DIR override " +
        "and no pnpm-workspace.yaml found in any ancestor of " +
        startDir,
    );
  }
  const files = await readdir(drizzleDir);
  return files.filter(
    (f) => /^\d{4}_.+\.sql$/.test(f) && !f.endsWith(".down.sql"),
  ).length;
}

/**
 * Nest-aware registrar for the `db_migration_status` ObservableGauge
 * callback (T483 / P4 W3).
 *
 * On `onModuleInit` resolves the total migration count from the filesystem,
 * then registers the scrape-time callback. On `onModuleDestroy` removes it
 * so a stale callback doesn't fire against a closed pool.
 *
 * If the filesystem count fails, the gauge falls back to `Number.MAX_SAFE_INTEGER`
 * as the total so `pending=1` is always observed — never a false "applied" signal.
 */
@Injectable()
class ApiDbMigrationStatusGaugeRegistrar implements OnModuleInit, OnModuleDestroy {
  private handle: { stop: () => void } | null = null;

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async onModuleInit(): Promise<void> {
    let totalMigrations: number;
    try {
      totalMigrations = await countMigrationFiles();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        JSON.stringify({
          level: "warn",
          component: "migration.status.gauge",
          message: "could not count migration files; gauge will report pending until resolved",
          error: message,
        }) + "\n",
      );
      // Unknown total → never mark as applied to avoid a false healthy signal.
      totalMigrations = Number.MAX_SAFE_INTEGER;
    }
    this.handle = registerDbMigrationStatusGauge({
      pool: this.pool,
      totalMigrations,
    });
  }

  onModuleDestroy(): void {
    const h = this.handle;
    this.handle = null;
    if (h !== null) {
      h.stop();
    }
  }
}

/**
 * Root module.
 *
 * Domain modules wired so far:
 *   - `AuditModule`         — audit event queue producer + global APP_INTERCEPTOR (Scope A)
 *   - `AuthModule`          — sign-in, sign-out, refresh, password-reset (slice 3c)
 *   - `ContextModule`       — active tenant/store switching (US3)
 *   - `TenantsModule`       — tenant CRUD (US2)
 *   - `StoresModule`        — store CRUD within active tenant (US2)
 *   - `MembershipsModule`   — membership revoke (US4, first slice)
 *   - `OutboxAdminModule`   — outbox dead-letter triage (T591, 1C-C1)
 *   - `PosOperatorsModule`  — POS operator sign-in (Wave 1, PR-5)
 *   - `PosAuditEventsModule`— POS audit-event batch sync (Wave 2, PR-6)
 *
 * Cross-cutting interceptors, the global filter, and the global Zod
 * pipe are registered in `main.ts`.
 */
@Module({
  imports: [AuditModule, AuthModule, ContextModule, TenantsModule, StoresModule, MembershipsModule, OutboxAdminModule, PosOperatorsModule, PosAuditEventsModule, PosShiftsModule, UnknownItemsModule, ReconciliationModule, SalesModule, InventoryModule, ReadDownModule, ErpnextItemMapModule, ErpnextWarehouseMapModule, ErpnextPostingModule, ErpnextReconciliationModule, ErpnextProductReconciliationModule, ErpnextBinViewModule, ErpnextSyncOpsModule, SaleSyncOpsModule, SettlementModule, ConnectorModule, ConnectorHealthModule, PairingModule],
  controllers: [],
  providers: [
    ApiDbPoolGaugeRegistrar,
    ApiDbMigrationStatusGaugeRegistrar,
    { provide: APP_GUARD, useClass: FailClosedAuthGuard },
  ],
})
export class AppModule {}
