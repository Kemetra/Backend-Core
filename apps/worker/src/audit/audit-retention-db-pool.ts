/**
 * AuditRetentionDbPool — the audit retention sweep's own Postgres pool (RT-353).
 *
 * Migration 0005 grants `UPDATE (retention_marked_at)` on `audit_events` only
 * to the `audit_retention_worker` role, and the retention decision record (§8)
 * keeps the API's runtime role INSERT-only on that table. The API and the
 * worker share `DATABASE_URL`, so the sweep cannot run on the domain role:
 * with the documented grants it fails with 42501 on every run (RT-351). It
 * connects with `AUDIT_RETENTION_DATABASE_URL` instead.
 *
 *   - production + URL missing → throws at boot.
 *   - non-production + URL missing → borrows the domain pool (dev / CI keep
 *     working; `AuditDbPool` still owns and closes it).
 *   - URL set → a small dedicated pool that this wrapper owns and closes.
 *
 * The role's grants are checked at boot by `AuditRetentionRoleVerifier`.
 */
import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import type { Pool } from "pg";

import { InstrumentedPool } from "../observability/instrumented-pool";

@Injectable()
export class AuditRetentionDbPool implements OnModuleDestroy {
  private _pool: Pool | null;

  /**
   * @param pool  the pool the sweep runs on, or `null` on the no-DB path.
   * @param owned whether this wrapper must end it (false for the borrowed
   *              domain pool, which `AuditDbPool` ends).
   */
  constructor(
    pool: Pool | null,
    private readonly owned: boolean,
  ) {
    this._pool = pool;
  }

  get pool(): Pool | null {
    return this._pool;
  }

  /** True when the sweep has its own credential, false when it borrows the domain pool. */
  get dedicated(): boolean {
    return this.owned;
  }

  async onModuleDestroy(): Promise<void> {
    const p = this._pool;
    this._pool = null;
    if (p !== null && this.owned) {
      await p.end();
    }
  }
}

export function auditRetentionPoolProviderFactory(domainPool: Pool | null): AuditRetentionDbPool {
  const url = process.env["AUDIT_RETENTION_DATABASE_URL"];
  if (!url) {
    if (process.env["NODE_ENV"] === "production") {
      throw new Error(
        "WorkerModule: AUDIT_RETENTION_DATABASE_URL is required in production; " +
          "the audit retention sweep must not run on the DATABASE_URL role (RT-353)",
      );
    }
    return new AuditRetentionDbPool(domainPool, false);
  }
  // One sweep at a time, one connection per batch: two is plenty.
  return new AuditRetentionDbPool(new InstrumentedPool({ connectionString: url, max: 2 }), true);
}
