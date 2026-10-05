/**
 * DeviceRepository — read-side lookups against `devices` for sign-in.
 *
 * Wave 1 sign-in resolves the terminal scope (tenant + branch) by hashing
 * the operator-supplied `device_token_attestation` and matching the
 * `devices.token_hash` column. The plaintext attestation is never logged
 * or persisted (ADR 0001 D7, FR-POS-AUTH-2).
 *
 * The lookup is intentionally direct against the pre-tenant lookup pool: at
 * sign-in time the request has no established tenant context (the device is
 * the source of that context). Tenant/store consistency between the device
 * and the resolved operator is enforced by the service layer
 * (PosOperatorsService.signIn) not by RLS, per ADR D9 final paragraph.
 *
 * Tenant status (RT-213)
 * ----------------------
 * Every device route resolves its device here: the PosDeviceAuthGuard
 * (read-down, cashier admissions), operator sign-in and takeover, POS
 * audit-event sync, and the live reverifier behind the operator envelope
 * (sales capture, settlement). So the tenant check lives here, once: a
 * device is "active" only while its tenant is active, i.e. `status =
 * 'active'` (the `tenants_status_valid` CHECK allows active, suspended and
 * pending) AND `deleted_at IS NULL`. A device of a suspended, pending or
 * soft-deleted tenant resolves to null, exactly like a revoked device, so
 * every caller refuses it with the response it already gives a revoked
 * device and nothing about the tenant is disclosed.
 *
 * The tenant row is read on the DOMAIN pool inside the device's own tenant
 * context (constitution §II), not on the lookup pool: the lookup role holds
 * no grant on `tenants` (docs/operations/database-roles.md), and the domain
 * role reads its own tenant row through the `tenants_tenant_isolation`
 * policy. No grant or migration is needed. A row that is not visible fails
 * closed.
 */
import { Injectable } from "@nestjs/common";
import { hashToken } from "@data-pulse-2/auth";
import { runWithTenantContext } from "@data-pulse-2/db";
import { devices, type DeviceRow } from "@data-pulse-2/db/schema";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { and, eq, isNull, type SQL } from "drizzle-orm";
import type { Pool } from "pg";

type DrizzleClient = NodePgDatabase;

function db(client: Pool): DrizzleClient {
  return drizzle(client);
}

interface TenantStatusRow {
  status: string;
  deleted_at: Date | null;
}

@Injectable()
export class DeviceRepository {
  /**
   * @param pool       the pre-tenant lookup pool (AUTH_LOOKUP_POOL): resolves
   *                   the device before any tenant context exists.
   * @param domainPool the domain pool (PG_POOL): reads the device's tenant
   *                   status under that tenant's RLS context.
   */
  constructor(
    private readonly pool: Pool,
    private readonly domainPool: Pool,
  ) {}

  /**
   * Resolve a device by its raw token attestation. Returns the row when
   * the hash matches, `revoked_at IS NULL` and the device's tenant is
   * active; returns null otherwise.
   *
   * Constant-time hash compare is provided by Postgres' BYTEA equality
   * — the column is UNIQUE so the lookup is a single index probe and
   * returns at most one row regardless of input.
   */
  async findActiveByAttestation(rawAttestation: string): Promise<DeviceRow | null> {
    if (rawAttestation.length === 0) return null;
    return this.findActive(eq(devices.tokenHash, hashToken(rawAttestation)));
  }

  /**
   * Resolve a device by id, with the same rules as `findActiveByAttestation`
   * (not revoked, tenant active). Used by the live reverifier, which knows
   * the device id from the operator envelope's `auth_tokens` row.
   */
  async findActiveById(deviceId: string): Promise<DeviceRow | null> {
    return this.findActive(eq(devices.id, deviceId));
  }

  private async findActive(match: SQL): Promise<DeviceRow | null> {
    const rows = await db(this.pool)
      .select()
      .from(devices)
      .where(and(match, isNull(devices.revokedAt)))
      .limit(1);
    const device = rows[0];
    if (!device) return null;
    return (await this.tenantIsActive(device.tenantId)) ? device : null;
  }

  private async tenantIsActive(tenantId: string): Promise<boolean> {
    const row = await runWithTenantContext(
      this.domainPool,
      { tenantId, isPlatformAdmin: false },
      async (client) => {
        const r = await client.query<TenantStatusRow>(
          `SELECT status, deleted_at FROM tenants WHERE id = $1 LIMIT 1`,
          [tenantId],
        );
        return r.rows[0];
      },
    );
    return row !== undefined && row.status === "active" && row.deleted_at === null;
  }
}
