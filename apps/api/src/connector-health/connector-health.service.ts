/**
 * ConnectorHealthService — 020.
 *
 * The DP2-side connector health engine.
 *   - US1/US3 (reads): list + single-instance connection status for a tenant
 *     admin. LEFT JOIN connector_registration ⟕ connector_health, then derive the
 *     liveness verdict AT READ against the server clock (never stored). A
 *     cross-tenant / absent registration resolves to 0 rows (RLS) → safe 404.
 *   - US2 (write): record a connector heartbeat. Identity + tenant come from the
 *     018 guard-attached context, NEVER the body (§XII). Upsert keyed on
 *     connector_registration_id, last-write-wins (no version check); records
 *     `last_seen_at = now()` from the SERVER clock (§X) plus the self-reported
 *     fields. NO per-beat audit row (FR-017). Increments connector_heartbeat_total.
 *
 * All DB work runs under the caller's tenant GUC via `runWithTenantContext`; RLS
 * scopes the rows. DP2 makes NO outbound ERPNext HTTP anywhere here (arc boundary).
 */
import { Inject, Injectable } from "@nestjs/common";
import { runWithTenantContext } from "@data-pulse-2/db";
import { newId } from "@data-pulse-2/shared";
import type { Pool } from "pg";

import { PG_POOL } from "../auth/auth.module";
import { recordConnectorHeartbeat } from "../observability/metrics/api.metrics";
import {
  type ConnectorHealthJoinRow,
  type ConnectorHealthViewBody,
  toConnectorHealthView,
} from "./dto/connector-health-view.dto";

/** The self-reported heartbeat fields (already validated by the DTO). */
export interface HeartbeatFields {
  readonly connectorVersion?: string | undefined;
  readonly backlogIndicator?: number | undefined;
  readonly erpnextReachable?: boolean | undefined;
  readonly sourceClockAt?: string | undefined;
}

/** Guard-attached connector identity (018 ConnectorAuthGuard `request.connector`). */
export interface ConnectorIdentity {
  readonly registrationId: string;
  readonly tenantId: string;
}

/** Raw joined row (snake_case from SQL). */
interface JoinDbRow {
  connector_id: string;
  display_name: string;
  environment: string;
  erpnext_site_ref: string;
  disabled_at: Date | null;
  last_seen_at: Date | null;
  connector_version: string | null;
  backlog_indicator: number | null;
  erpnext_reachable: boolean | null;
  reported_fields_at: Date | null;
}

const JOIN_SELECT = `
  SELECT r.id                      AS connector_id,
         r.display_name            AS display_name,
         r.environment             AS environment,
         r.erpnext_site_ref        AS erpnext_site_ref,
         r.disabled_at             AS disabled_at,
         h.last_seen_at            AS last_seen_at,
         h.connector_version       AS connector_version,
         h.backlog_indicator       AS backlog_indicator,
         h.erpnext_reachable       AS erpnext_reachable,
         h.reported_fields_at      AS reported_fields_at
    FROM connector_registration r
    LEFT JOIN connector_health h
      ON h.connector_registration_id = r.id
`;

function toJoin(row: JoinDbRow): ConnectorHealthJoinRow {
  return {
    connectorId: row.connector_id,
    displayName: row.display_name,
    environment: row.environment,
    erpnextSiteRef: row.erpnext_site_ref,
    disabledAt: row.disabled_at,
    lastSeenAt: row.last_seen_at,
    connectorVersion: row.connector_version,
    backlogIndicator: row.backlog_indicator,
    erpnextReachable: row.erpnext_reachable,
    reportedFieldsAt: row.reported_fields_at,
  };
}

@Injectable()
export class ConnectorHealthService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /** US1: list the tenant's connector instances with read-derived verdicts. */
  async listHealth(input: { tenantId: string }): Promise<ConnectorHealthViewBody[]> {
    return runWithTenantContext(
      this.pool,
      { tenantId: input.tenantId, isPlatformAdmin: false },
      async (client): Promise<ConnectorHealthViewBody[]> => {
        const res = await client.query<JoinDbRow>(
          `${JOIN_SELECT} ORDER BY r.created_at`,
        );
        const now = new Date();
        return res.rows.map((row) => toConnectorHealthView(toJoin(row), now));
      },
    );
  }

  /**
   * US3: single-instance health detail. Cross-tenant / absent id → null (RLS
   * scopes the registration to the caller's tenant) → the controller maps to a
   * non-disclosing 404.
   */
  async getHealth(input: {
    tenantId: string;
    registrationId: string;
  }): Promise<ConnectorHealthViewBody | null> {
    return runWithTenantContext(
      this.pool,
      { tenantId: input.tenantId, isPlatformAdmin: false },
      async (client): Promise<ConnectorHealthViewBody | null> => {
        const res = await client.query<JoinDbRow>(
          `${JOIN_SELECT} WHERE r.id = $1`,
          [input.registrationId],
        );
        const row = res.rows[0];
        if (!row) return null;
        return toConnectorHealthView(toJoin(row), new Date());
      },
    );
  }

  /**
   * US2: record a connector heartbeat (LWW upsert). Identity from the guard
   * context, NEVER the body (§XII). `last_seen_at = now()` is the SERVER clock
   * (§X). Self-reported fields are stored verbatim; `source_clock_at` is
   * provenance only (never used for the verdict). NO per-beat audit row (FR-017).
   * Increments connector_heartbeat_total on every accepted beat.
   *
   * The upsert is keyed on the registration (UNIQUE connector_registration_id) so
   * concurrent / repeated beats converge to the latest write (idempotent). The
   * INSERT branch derives `tenant_id` from the guard context — which already
   * matches the registration's tenant per the 018 usability predicate.
   */
  async recordHeartbeat(
    identity: ConnectorIdentity,
    fields: HeartbeatFields,
  ): Promise<{ acknowledgedAt: string }> {
    return runWithTenantContext(
      this.pool,
      { tenantId: identity.tenantId, isPlatformAdmin: false },
      async (client): Promise<{ acknowledgedAt: string }> => {
        // reported_fields_at tracks WHEN self-reported telemetry last arrived,
        // and stays null until the first beat that carries any (contract:
        // "null until reported"). An empty liveness-only beat must NOT stamp it
        // and must NOT clobber a previously-set value. `$8 = hasFields`:
        //   INSERT → now() when fields present, else NULL.
        //   UPDATE → now() when fields present, else PRESERVE the existing
        //            value via the target-table qualifier `connector_health.…`
        //            (NOT EXCLUDED, which is the rejected insert row = NULL here).
        const hasFields =
          (fields.connectorVersion !== null &&
            fields.connectorVersion !== undefined) ||
          (fields.backlogIndicator !== null &&
            fields.backlogIndicator !== undefined) ||
          (fields.erpnextReachable !== null &&
            fields.erpnextReachable !== undefined) ||
          (fields.sourceClockAt !== null && fields.sourceClockAt !== undefined);
        const res = await client.query<{ last_seen_at: Date }>(
          `INSERT INTO connector_health
             (id, tenant_id, connector_registration_id, last_seen_at,
              connector_version, backlog_indicator, erpnext_reachable,
              source_clock_at, reported_fields_at, updated_at)
           VALUES ($1, $2, $3, now(), $4, $5, $6, $7,
                   CASE WHEN $8 THEN now() ELSE NULL END, now())
           ON CONFLICT (connector_registration_id) DO UPDATE SET
             last_seen_at       = now(),
             connector_version  = EXCLUDED.connector_version,
             backlog_indicator  = EXCLUDED.backlog_indicator,
             erpnext_reachable  = EXCLUDED.erpnext_reachable,
             source_clock_at    = EXCLUDED.source_clock_at,
             reported_fields_at = CASE WHEN $8 THEN now()
                                       ELSE connector_health.reported_fields_at END,
             updated_at         = now()
           RETURNING last_seen_at`,
          [
            newId(),
            identity.tenantId,
            identity.registrationId,
            fields.connectorVersion ?? null,
            fields.backlogIndicator ?? null,
            fields.erpnextReachable ?? null,
            fields.sourceClockAt ?? null,
            hasFields,
          ],
        );
        const row = res.rows[0];
        if (!row) throw new Error("recordHeartbeat: upsert returned no row");
        // Operational signal (FR-018) — one increment per accepted beat. A
        // SIGNAL: unlabeled, never alters the outcome.
        recordConnectorHeartbeat();
        return { acknowledgedAt: row.last_seen_at.toISOString() };
      },
    );
  }
}
