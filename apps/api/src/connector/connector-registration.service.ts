/**
 * ConnectorRegistrationService — 018.
 *
 * The DP2-side connector boundary engine. US1 (this slice): register a
 * connector instance + issue its first machine credential. US2/US3 extend it
 * (rotate/revoke, disable). All writes run under the caller's tenant GUC via
 * `runWithTenantContext` (tenant from the dashboard session principal, never the
 * body — §XII); RLS scopes the rows.
 *
 * Credentials reuse the existing opaque-bearer primitive: `generateRawToken()` +
 * the `auth_tokens` insert (hashed via `hashToken` inside the repository). The
 * raw secret is returned to the caller EXACTLY ONCE and never stored in a
 * recoverable form (FR-007). Every lifecycle action writes a platform
 * `audit_events` row IN THE SAME TRANSACTION as the state change (FR-020, the
 * 017 `triggerRun` precedent — NOT the async `@Auditable` path).
 */
import { Inject, Injectable } from "@nestjs/common";
import { generateRawToken, hashToken } from "@data-pulse-2/auth";
import { runWithTenantContext } from "@data-pulse-2/db";
import { newId } from "@data-pulse-2/shared";
import type { Pool, PoolClient } from "pg";

import { PG_POOL } from "../auth/auth.module";
import { recordConnectorLifecycle } from "../observability/metrics/api.metrics";
import {
  type ConnectorInstanceBody,
  type CredentialStatusBody,
  DEFAULT_CREDENTIAL_EXPIRY_DAYS,
  type IssuedCredentialBody,
  toConnectorInstance,
} from "./dto/register-connector.dto";

export interface RegisterInstanceInput {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly displayName: string;
  readonly erpnextSiteRef: string;
  readonly environment: string;
}

export interface IssueCredentialInput {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly instanceId: string;
  readonly expiresInDays?: number;
}

/** A registration row as read back (snake_case from SQL). */
interface RegistrationDbRow {
  id: string;
  display_name: string;
  erpnext_site_ref: string;
  environment: string;
  created_at: Date;
  disabled_at: Date | null;
}

type RegisterResult =
  | { kind: "ok"; instance: ConnectorInstanceBody }
  | { kind: "conflict" };

type IssueResult =
  | { kind: "ok"; credential: IssuedCredentialBody }
  | { kind: "not_found" }
  | { kind: "conflict" };

/** At most one unrevoked connector credential per registration (migration 0021). */
const ACTIVE_CONNECTOR_CREDENTIAL_UNIQUE = "uq_auth_tokens_active_connector_credential";

const INSTANCE_COLS =
  "id, display_name, erpnext_site_ref, environment, created_at, disabled_at";

@Injectable()
export class ConnectorRegistrationService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /**
   * Register a connector instance. Duplicate (environment, erpnext_site_ref)
   * for the tenant → conflict (FR-005a, the DB unique). Writes an in-tx audit.
   */
  async register(input: RegisterInstanceInput): Promise<RegisterResult> {
    return runWithTenantContext(
      this.pool,
      { tenantId: input.tenantId, isPlatformAdmin: false },
      async (client): Promise<RegisterResult> => {
        const id = newId();
        let row: RegistrationDbRow | undefined;
        try {
          const res = await client.query<RegistrationDbRow>(
            `INSERT INTO connector_registration
               (id, tenant_id, display_name, erpnext_site_ref, environment, created_by)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING ${INSTANCE_COLS}`,
            [
              id,
              input.tenantId,
              input.displayName,
              input.erpnextSiteRef,
              input.environment,
              input.actorUserId,
            ],
          );
          row = res.rows[0];
        } catch (err) {
          // 23505 unique_violation → the (tenant, environment, site_ref) 1:1.
          if ((err as { code?: string }).code === "23505") {
            return { kind: "conflict" };
          }
          throw err;
        }
        if (!row) throw new Error("register: insert returned no row");

        await this.insertAudit(client, input.tenantId, input.actorUserId, {
          action: "connector.registration.created",
          targetType: "connector_registration",
          targetId: id,
          metadata: { environment: input.environment },
        });
        return { kind: "ok", instance: toConnectorInstance(asRow(row), null) };
      },
    );
  }

  /**
   * Disable a connector instance (US3): logical disable (set disabled_at/by).
   * All its credentials become unusable at the guard (predicate clause 7). NO
   * row is deleted (FR-014). Idempotent: re-disabling is a success no-op.
   * Cross-tenant / absent id → not_found (non-disclosing).
   */
  async disable(input: {
    tenantId: string;
    actorUserId: string;
    instanceId: string;
  }): Promise<{ kind: "ok"; instance: ConnectorInstanceBody } | { kind: "not_found" }> {
    return runWithTenantContext(
      this.pool,
      { tenantId: input.tenantId, isPlatformAdmin: false },
      async (client): Promise<{ kind: "ok"; instance: ConnectorInstanceBody } | { kind: "not_found" }> => {
        const found = await client.query<RegistrationDbRow>(
          `SELECT ${INSTANCE_COLS} FROM connector_registration WHERE id = $1`,
          [input.instanceId],
        );
        const existing = found.rows[0];
        if (!existing) return { kind: "not_found" };

        // Idempotent: only set + audit on the first transition to disabled.
        if (existing.disabled_at === null) {
          const upd = await client.query<RegistrationDbRow>(
            `UPDATE connector_registration
                SET disabled_at = now(), disabled_by = $2
              WHERE id = $1 AND disabled_at IS NULL
            RETURNING ${INSTANCE_COLS}`,
            [input.instanceId, input.actorUserId],
          );
          const row = upd.rows[0] ?? existing;
          await this.insertAudit(client, input.tenantId, input.actorUserId, {
            action: "connector.registration.disabled",
            targetType: "connector_registration",
            targetId: input.instanceId,
            metadata: {},
          });
          const active = await this.activeCredential(client, input.instanceId);
          return { kind: "ok", instance: toConnectorInstance(asRow(row), active) };
        }
        const active = await this.activeCredential(client, input.instanceId);
        return { kind: "ok", instance: toConnectorInstance(asRow(existing), active) };
      },
    );
  }

  /** List the tenant's connector instances with active-credential status. */
  async list(input: { tenantId: string }): Promise<ConnectorInstanceBody[]> {
    return runWithTenantContext(
      this.pool,
      { tenantId: input.tenantId, isPlatformAdmin: false },
      async (client): Promise<ConnectorInstanceBody[]> => {
        const res = await client.query<RegistrationDbRow>(
          `SELECT ${INSTANCE_COLS} FROM connector_registration ORDER BY created_at`,
        );
        const out: ConnectorInstanceBody[] = [];
        for (const row of res.rows) {
          const active = await this.activeCredential(client, row.id);
          out.push(toConnectorInstance(asRow(row), active));
        }
        return out;
      },
    );
  }

  /**
   * Issue a connector credential for a registered, non-disabled instance. The
   * raw secret is in the result ONCE. Bounded expiry (default 90d). Issuing for
   * an absent / cross-tenant / disabled instance → not_found (non-disclosing).
   * An instance that already has an unrevoked credential → conflict (RT-62):
   * the partial unique index rejects the insert, the transaction rolls back
   * (no audit row), and the caller is pointed at rotate.
   */
  async issue(input: IssueCredentialInput): Promise<IssueResult> {
    return runWithTenantContext(
      this.pool,
      { tenantId: input.tenantId, isPlatformAdmin: false },
      async (client): Promise<IssueResult> => {
        // RLS scopes the row; a disabled instance is treated as not-issuable.
        const inst = await client.query<{ id: string; disabled_at: Date | null }>(
          `SELECT id, disabled_at FROM connector_registration WHERE id = $1`,
          [input.instanceId],
        );
        const row = inst.rows[0];
        if (!row || row.disabled_at !== null) return { kind: "not_found" };

        let credential: IssuedCredentialBody;
        try {
          credential = await this.issueCredentialRow(client, {
            tenantId: input.tenantId,
            actorUserId: input.actorUserId,
            instanceId: input.instanceId,
            expiresInDays: input.expiresInDays ?? DEFAULT_CREDENTIAL_EXPIRY_DAYS,
          });
        } catch (err) {
          const pgErr = err as { code?: string; constraint?: string };
          if (pgErr.code === "23505" && pgErr.constraint === ACTIVE_CONNECTOR_CREDENTIAL_UNIQUE) {
            return { kind: "conflict" };
          }
          throw err;
        }
        await this.insertAudit(client, input.tenantId, input.actorUserId, {
          action: "connector.credential.issued",
          targetType: "connector_registration",
          targetId: input.instanceId,
          metadata: { credential_id: credential.credential_id },
        });
        return { kind: "ok", credential };
      },
    );
  }

  /**
   * Rotate an instance's credential (US2): atomic immediate-revoke. In ONE
   * transaction — verify the registration exists/tenant/not-disabled → revoke
   * its unrevoked connector credential(s) → issue a new one for the SAME
   * registration → audit. If the issue fails, the whole tx rolls back and the
   * old credential stays active (FR-009). At most one active per registration
   * (the revoke-first ordering keeps the partial-unique satisfied; FR-010).
   */
  async rotate(input: IssueCredentialInput): Promise<IssueResult> {
    return runWithTenantContext(
      this.pool,
      { tenantId: input.tenantId, isPlatformAdmin: false },
      async (client): Promise<IssueResult> => {
        const inst = await client.query<{ id: string; disabled_at: Date | null }>(
          `SELECT id, disabled_at FROM connector_registration WHERE id = $1`,
          [input.instanceId],
        );
        const row = inst.rows[0];
        if (!row || row.disabled_at !== null) return { kind: "not_found" };

        // Revoke the current active credential(s) FIRST so the new insert does
        // not collide with the at-most-one-unrevoked partial-unique.
        await client.query(
          `UPDATE auth_tokens
              SET revoked_at = now()
            WHERE connector_registration_id = $1
              AND scope = 'connector'
              AND revoked_at IS NULL`,
          [input.instanceId],
        );

        const credential = await this.issueCredentialRow(client, {
          tenantId: input.tenantId,
          actorUserId: input.actorUserId,
          instanceId: input.instanceId,
          expiresInDays: input.expiresInDays ?? DEFAULT_CREDENTIAL_EXPIRY_DAYS,
        });
        await this.insertAudit(client, input.tenantId, input.actorUserId, {
          action: "connector.credential.rotated",
          targetType: "connector_registration",
          targetId: input.instanceId,
          metadata: { credential_id: credential.credential_id },
        });
        return { kind: "ok", credential };
      },
    );
  }

  /**
   * Revoke one credential by id (US2). RLS-scoped: a cross-tenant / absent id
   * resolves to 0 rows → not_found (non-disclosing). Idempotent: revoking an
   * already-revoked credential is a success no-op. The registration stays
   * active. Audited in-tx.
   */
  async revoke(input: {
    tenantId: string;
    actorUserId: string;
    credentialId: string;
  }): Promise<{ kind: "ok" } | { kind: "not_found" }> {
    return runWithTenantContext(
      this.pool,
      { tenantId: input.tenantId, isPlatformAdmin: false },
      async (client): Promise<{ kind: "ok" } | { kind: "not_found" }> => {
        // Confirm the credential exists in scope (RLS) + is a connector cred.
        const found = await client.query<{ id: string; connector_registration_id: string | null }>(
          `SELECT id, connector_registration_id FROM auth_tokens
            WHERE id = $1 AND scope = 'connector'`,
          [input.credentialId],
        );
        const r = found.rows[0];
        if (!r) return { kind: "not_found" };

        await client.query(
          `UPDATE auth_tokens SET revoked_at = now()
            WHERE id = $1 AND revoked_at IS NULL`,
          [input.credentialId],
        );
        await this.insertAudit(client, input.tenantId, input.actorUserId, {
          action: "connector.credential.revoked",
          targetType: "connector_registration",
          targetId: r.connector_registration_id ?? input.credentialId,
          metadata: { credential_id: input.credentialId },
        });
        return { kind: "ok" };
      },
    );
  }

  /**
   * Insert one connector-scoped auth_tokens row (raw secret hashed here) and
   * return the one-time wire shape. Shared by issue + rotate (US2).
   */
  private async issueCredentialRow(
    client: PoolClient,
    input: {
      tenantId: string;
      actorUserId: string;
      instanceId: string;
      expiresInDays: number;
    },
  ): Promise<IssuedCredentialBody> {
    const rawToken = generateRawToken();
    const credentialId = newId();
    const res = await client.query<{ issued_at: Date; expires_at: Date }>(
      `INSERT INTO auth_tokens
         (id, token_hash, tenant_id, user_id, scope, expires_at, connector_registration_id)
       VALUES ($1, $2, $3, $4, 'connector', now() + ($5 || ' days')::interval, $6)
       RETURNING issued_at, expires_at`,
      [
        credentialId,
        hashToken(rawToken),
        input.tenantId,
        input.actorUserId,
        String(input.expiresInDays),
        input.instanceId,
      ],
    );
    const r = res.rows[0]!;
    return {
      credential_id: credentialId,
      instance_id: input.instanceId,
      secret: rawToken,
      issued_at: r.issued_at.toISOString(),
      expires_at: r.expires_at.toISOString(),
    };
  }

  /** The instance's current active (unrevoked, unexpired) credential status, or null. */
  private async activeCredential(
    client: PoolClient,
    instanceId: string,
  ): Promise<CredentialStatusBody | null> {
    const res = await client.query<{
      id: string;
      issued_at: Date;
      expires_at: Date;
      revoked_at: Date | null;
    }>(
      `SELECT id, issued_at, expires_at, revoked_at
         FROM auth_tokens
        WHERE connector_registration_id = $1
          AND scope = 'connector'
          AND revoked_at IS NULL
        LIMIT 1`,
      [instanceId],
    );
    const r = res.rows[0];
    if (!r) return null;
    return {
      credential_id: r.id,
      instance_id: instanceId,
      issued_at: r.issued_at.toISOString(),
      expires_at: r.expires_at.toISOString(),
      revoked_at: r.revoked_at ? r.revoked_at.toISOString() : null,
    };
  }

  private async insertAudit(
    client: PoolClient,
    tenantId: string,
    actorUserId: string,
    opts: {
      action: string;
      targetType: string;
      targetId: string;
      metadata: Record<string, unknown>;
    },
  ): Promise<void> {
    await client.query(
      `INSERT INTO audit_events (id, actor_user_id, tenant_id, action, target_type, target_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [
        newId(),
        actorUserId,
        tenantId,
        opts.action,
        opts.targetType,
        opts.targetId,
        JSON.stringify(opts.metadata),
      ],
    );
    // §FR-022a operational signal — one increment per connector lifecycle
    // action (every caller of insertAudit here is a lifecycle action). A SIGNAL:
    // unlabeled, never alters the outcome. Fires inside the tx by call-position
    // but the metric add is a pure in-memory no-op-until-reader op.
    recordConnectorLifecycle();
  }
}

/** Map a snake_case SQL row to the camelCase shape `toConnectorInstance` expects. */
function asRow(r: RegistrationDbRow): Parameters<typeof toConnectorInstance>[0] {
  return {
    id: r.id,
    displayName: r.display_name,
    erpnextSiteRef: r.erpnext_site_ref,
    environment: r.environment,
    createdAt: r.created_at,
    disabledAt: r.disabled_at,
    // Fields not selected but present on the row type — not used by the projection.
  } as Parameters<typeof toConnectorInstance>[0];
}
