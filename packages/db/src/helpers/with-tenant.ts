/**
 * `withTenant(db, tenantId)` — tenant-scoped query proxy.
 *
 * Returns a per-tenant view of every tenant-scoped table. Reads inject
 * `WHERE tenant_id = :tenantId` (or `id = :tenantId` for the `tenants`
 * table itself); writes refuse rows whose `tenant_id` does not match the
 * helper's bound `tenantId`.
 *
 * This is one of two layers of tenant isolation in the SaaS rebuild
 * (plan §3.3): the application-level helper here is paired with PostgreSQL
 * Row-Level Security at the DB layer. Even if a caller bypasses this
 * helper with raw SQL, RLS still enforces isolation.
 *
 * Coverage: every table in the foundation that carries a `tenant_id`
 * column, plus `tenants` itself. Platform-scoped writes (e.g., creating a
 * platform role with `tenant_id IS NULL`) are rejected at the helper
 * boundary — those go through a separate platform-admin path that this
 * helper does not represent.
 */
import { and, eq, type SQL } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  auditEvents,
  authTokens,
  idempotencyKeys,
  invitations,
  memberships,
  type NewAuditEventRow,
  type NewAuthTokenRow,
  type NewIdempotencyKeyRow,
  type NewInvitationRow,
  type NewMembershipRow,
  type NewRoleRow,
  type NewStoreAccessRow,
  type NewStoreRow,
  type NewTenantRow,
  roles,
  storeAccess,
  stores,
  tenants,
} from "../schema";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(label: string, value: unknown): asserts value is string {
  if (typeof value !== "string" || !UUID_RE.test(value)) {
    throw new Error(`withTenant: ${label} must be a UUID string`);
  }
}

function combineWhere(
  scopePredicate: SQL,
  callerWhere: SQL | undefined,
): SQL {
  return callerWhere ? (and(scopePredicate, callerWhere) as SQL) : scopePredicate;
}

export interface WithTenant {
  readonly tenantId: string;

  // tenants — scoped by id = tenantId
  tenants: {
    select: (where?: SQL) => ReturnType<NodePgDatabase["select"]>["from"] extends never ? never : ReturnType<ReturnType<NodePgDatabase["select"]>["from"]>;
  };
}

/**
 * The tables in this list are the canonical "tenant-scoped" surface. Tests
 * assert every one is reachable through the helper.
 */
export const TENANT_SCOPED_TABLES = [
  "tenants",
  "stores",
  "memberships",
  "store_access",
  "roles",
  "auth_tokens",
  "invitations",
  "audit_events",
  "idempotency_keys",
] as const;

export type TenantScopedTable = (typeof TENANT_SCOPED_TABLES)[number];

/** Render a rejected tenant_id for an error message; never throws. */
function describeTenantId(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? typeof value;
  } catch {
    // BigInt or a circular object: the type is enough to explain the refusal.
    return typeof value;
  }
}

export function withTenant(db: NodePgDatabase, tenantId: string) {
  assertUuid("tenantId", tenantId);

  const refuseTenantMismatch = (
    table: string,
    rowTenantId: unknown,
    { allowNull = false }: { allowNull?: boolean } = {},
  ): void => {
    if (rowTenantId === null || rowTenantId === undefined) {
      if (allowNull) return;
      throw new Error(
        `withTenant: refusing write on ${table} — tenant_id must equal ${tenantId}, got null`,
      );
    }
    if (rowTenantId !== tenantId) {
      throw new Error(
        `withTenant: refusing write on ${table} — tenant_id mismatch (expected ${tenantId}, got ${describeTenantId(rowTenantId)})`,
      );
    }
  };

  return {
    tenantId,

    // -------------------------------------------------------------------------
    // tenants — scoped by id = tenantId (not tenant_id)
    // -------------------------------------------------------------------------
    tenants: {
      select: (where?: SQL) =>
        db
          .select()
          .from(tenants)
          .where(combineWhere(eq(tenants.id, tenantId), where)),
      update: (set: Partial<NewTenantRow>, where?: SQL) => {
        if (set.id !== undefined && set.id !== tenantId) {
          throw new Error(
            "withTenant: refusing tenants update that changes id",
          );
        }
        return db
          .update(tenants)
          .set(set)
          .where(combineWhere(eq(tenants.id, tenantId), where));
      },
      // No insert/delete on tenants via withTenant: creating or destroying a
      // tenant is a platform-admin operation, not a per-tenant one.
    },

    // -------------------------------------------------------------------------
    // stores — scoped by tenant_id = tenantId
    // -------------------------------------------------------------------------
    stores: {
      select: (where?: SQL) =>
        db
          .select()
          .from(stores)
          .where(combineWhere(eq(stores.tenantId, tenantId), where)),
      insert: (values: NewStoreRow) => {
        refuseTenantMismatch("stores", values.tenantId);
        return db.insert(stores).values(values);
      },
      update: (set: Partial<NewStoreRow>, where?: SQL) => {
        if (set.tenantId !== undefined && set.tenantId !== tenantId) {
          throw new Error(
            "withTenant: refusing stores update that reassigns tenant_id",
          );
        }
        return db
          .update(stores)
          .set(set)
          .where(combineWhere(eq(stores.tenantId, tenantId), where));
      },
      delete: (where?: SQL) =>
        db
          .delete(stores)
          .where(combineWhere(eq(stores.tenantId, tenantId), where)),
    },

    // -------------------------------------------------------------------------
    // memberships — scoped by tenant_id = tenantId
    // -------------------------------------------------------------------------
    memberships: {
      select: (where?: SQL) =>
        db
          .select()
          .from(memberships)
          .where(combineWhere(eq(memberships.tenantId, tenantId), where)),
      insert: (values: NewMembershipRow) => {
        refuseTenantMismatch("memberships", values.tenantId);
        return db.insert(memberships).values(values);
      },
      update: (set: Partial<NewMembershipRow>, where?: SQL) => {
        if (set.tenantId !== undefined && set.tenantId !== tenantId) {
          throw new Error(
            "withTenant: refusing memberships update that reassigns tenant_id",
          );
        }
        return db
          .update(memberships)
          .set(set)
          .where(combineWhere(eq(memberships.tenantId, tenantId), where));
      },
      delete: (where?: SQL) =>
        db
          .delete(memberships)
          .where(combineWhere(eq(memberships.tenantId, tenantId), where)),
    },

    // -------------------------------------------------------------------------
    // store_access — scoped by tenant_id = tenantId
    // -------------------------------------------------------------------------
    storeAccess: {
      select: (where?: SQL) =>
        db
          .select()
          .from(storeAccess)
          .where(combineWhere(eq(storeAccess.tenantId, tenantId), where)),
      insert: (values: NewStoreAccessRow) => {
        refuseTenantMismatch("store_access", values.tenantId);
        return db.insert(storeAccess).values(values);
      },
      delete: (where?: SQL) =>
        db
          .delete(storeAccess)
          .where(combineWhere(eq(storeAccess.tenantId, tenantId), where)),
    },

    // -------------------------------------------------------------------------
    // roles — special: reads see tenant + platform roles (tenant_id IS NULL),
    // but writes via this helper must refuse platform-scoped rows.
    // -------------------------------------------------------------------------
    roles: {
      select: (where?: SQL) =>
        db
          .select()
          .from(roles)
          .where(combineWhere(eq(roles.tenantId, tenantId), where)),
      insert: (values: NewRoleRow) => {
        // Refuse null tenant_id — platform-role creation is a platform-admin
        // path, not a per-tenant one.
        refuseTenantMismatch("roles", values.tenantId);
        return db.insert(roles).values(values);
      },
      update: (set: Partial<NewRoleRow>, where?: SQL) => {
        if (set.tenantId !== undefined) {
          // Reassigning a tenant role to platform (NULL) or to another tenant
          // is forbidden through this helper.
          if (set.tenantId === null || set.tenantId !== tenantId) {
            throw new Error(
              "withTenant: refusing roles update that changes tenant_id",
            );
          }
        }
        return db
          .update(roles)
          .set(set)
          .where(combineWhere(eq(roles.tenantId, tenantId), where));
      },
      delete: (where?: SQL) =>
        db
          .delete(roles)
          .where(combineWhere(eq(roles.tenantId, tenantId), where)),
    },

    // -------------------------------------------------------------------------
    // auth_tokens — scoped by tenant_id = tenantId; tenant_id is nullable but
    // this helper deals only with tenant-scoped tokens.
    // -------------------------------------------------------------------------
    authTokens: {
      select: (where?: SQL) =>
        db
          .select()
          .from(authTokens)
          .where(combineWhere(eq(authTokens.tenantId, tenantId), where)),
      insert: (values: NewAuthTokenRow) => {
        refuseTenantMismatch("auth_tokens", values.tenantId);
        return db.insert(authTokens).values(values);
      },
      update: (set: Partial<NewAuthTokenRow>, where?: SQL) => {
        if (set.tenantId !== undefined && set.tenantId !== tenantId) {
          throw new Error(
            "withTenant: refusing auth_tokens update that reassigns tenant_id",
          );
        }
        return db
          .update(authTokens)
          .set(set)
          .where(combineWhere(eq(authTokens.tenantId, tenantId), where));
      },
      delete: (where?: SQL) =>
        db
          .delete(authTokens)
          .where(combineWhere(eq(authTokens.tenantId, tenantId), where)),
    },

    // -------------------------------------------------------------------------
    // invitations
    // -------------------------------------------------------------------------
    invitations: {
      select: (where?: SQL) =>
        db
          .select()
          .from(invitations)
          .where(combineWhere(eq(invitations.tenantId, tenantId), where)),
      insert: (values: NewInvitationRow) => {
        refuseTenantMismatch("invitations", values.tenantId);
        return db.insert(invitations).values(values);
      },
      update: (set: Partial<NewInvitationRow>, where?: SQL) => {
        if (set.tenantId !== undefined && set.tenantId !== tenantId) {
          throw new Error(
            "withTenant: refusing invitations update that reassigns tenant_id",
          );
        }
        return db
          .update(invitations)
          .set(set)
          .where(combineWhere(eq(invitations.tenantId, tenantId), where));
      },
      delete: (where?: SQL) =>
        db
          .delete(invitations)
          .where(combineWhere(eq(invitations.tenantId, tenantId), where)),
    },

    // -------------------------------------------------------------------------
    // audit_events — INSERT-only at the application layer (no update path),
    // tenant_id is nullable (platform events) but this helper only handles
    // tenant-scoped writes.
    // -------------------------------------------------------------------------
    auditEvents: {
      select: (where?: SQL) =>
        db
          .select()
          .from(auditEvents)
          .where(combineWhere(eq(auditEvents.tenantId, tenantId), where)),
      insert: (values: NewAuditEventRow) => {
        refuseTenantMismatch("audit_events", values.tenantId);
        return db.insert(auditEvents).values(values);
      },
      // No update/delete — audit_events are immutable at the application layer.
    },

    // -------------------------------------------------------------------------
    // idempotency_keys — scoped by tenant_id = tenantId; tenant_id is NOT NULL.
    // -------------------------------------------------------------------------
    idempotencyKeys: {
      select: (where?: SQL) =>
        db
          .select()
          .from(idempotencyKeys)
          .where(combineWhere(eq(idempotencyKeys.tenantId, tenantId), where)),
      insert: (values: NewIdempotencyKeyRow) => {
        refuseTenantMismatch("idempotency_keys", values.tenantId);
        return db.insert(idempotencyKeys).values(values);
      },
      delete: (where?: SQL) =>
        db
          .delete(idempotencyKeys)
          .where(
            combineWhere(eq(idempotencyKeys.tenantId, tenantId), where),
          ),
    },
  };
}

export type WithTenantHelper = ReturnType<typeof withTenant>;
