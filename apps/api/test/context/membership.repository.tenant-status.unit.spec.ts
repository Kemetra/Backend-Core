/**
 * membership.repository.tenant-status.unit.spec.ts — RT-669 (RT-667 / R-1).
 *
 * The console's tenant resolution must refuse a tenant that is not active.
 * "Active" is the RT-213 rule: `tenants.status = 'active' AND
 * tenants.deleted_at IS NULL`. Every MembershipRepository read that admits a
 * member into a tenant carries that predicate, so a membership in a
 * suspended, pending or soft-deleted tenant reads exactly like a revoked one:
 *
 *   - findActiveMembership        (TenantContextGuard session branch, switchTenant)
 *   - findRoleCodeForUserInTenant (RolesGuard path-as-context routes)
 *   - listForUser / listTenantRolesForUser (`/context/me`, sign-in memberships)
 *
 * and `isTenantActive` answers the same question for the `dashboard_api`
 * token branch.
 *
 * Strategy: the REAL Drizzle query builder over a fake `PoolClient` that
 * records the SQL it is sent, so the predicate is asserted on the statement
 * itself (the companion `membership.repository.unit.spec.ts` fakes the
 * builder and cannot see SQL). Behaviour against real rows and RLS is in
 * `test/auth/tenant-status-console-auth.http.integration.spec.ts`.
 */
import "reflect-metadata";

import type { Pool, PoolClient } from "pg";

import { MembershipRepository } from "../../src/context/membership.repository";

const USER_ID = "06690000-0000-4000-8000-0000000000a1";
const TENANT_ID = "06690000-0000-4000-8000-0000000000b1";

/** One statement as node-postgres received it. */
interface SentQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

/** A fake client: records each statement, answers with the queued rows. */
function fakeClient(rowsQueue: unknown[][] = []): { client: PoolClient; sent: SentQuery[] } {
  const sent: SentQuery[] = [];
  const query = jest.fn(async (q: { text: string; values?: unknown[] } | string, values?: unknown[]) => {
    const text = typeof q === "string" ? q : q.text;
    // Drizzle passes the parameters as the second argument.
    sent.push({ text, values: values ?? (typeof q === "string" ? undefined : q.values) ?? [] });
    return { rows: rowsQueue.shift() ?? [], rowCount: 0, fields: [] };
  });
  return { client: { query } as unknown as PoolClient, sent };
}

/** The repository; its own pool is never used (every call passes a client). */
function repo(): MembershipRepository {
  return new MembershipRepository({} as Pool);
}

/** The statement joins `tenants` and requires an active, undeleted tenant. */
function expectTenantActivePredicate(q: SentQuery | undefined): void {
  expect(q).toBeDefined();
  const text = q!.text;
  expect(text).toMatch(/join "tenants" on "tenants"\."id" = "memberships"\."tenant_id"/);
  const status = /"tenants"\."status" = \$(\d+)/.exec(text);
  expect(status).not.toBeNull();
  expect(q!.values[Number(status![1]) - 1]).toBe("active");
  expect(text).toMatch(/"tenants"\."deleted_at" is null/);
}

describe("RT-669 — MembershipRepository applies the tenant-active rule", () => {
  it("findActiveMembership: only a membership in an active, undeleted tenant", async () => {
    const { client, sent } = fakeClient();
    await expect(repo().findActiveMembership(USER_ID, TENANT_ID, client)).resolves.toBeNull();
    expect(sent).toHaveLength(1);
    expectTenantActivePredicate(sent[0]);
  });

  it("findRoleCodeForUserInTenant: only a role in an active, undeleted tenant", async () => {
    const { client, sent } = fakeClient();
    await expect(repo().findRoleCodeForUserInTenant(USER_ID, TENANT_ID, client)).resolves.toBeNull();
    expect(sent).toHaveLength(1);
    expectTenantActivePredicate(sent[0]);
  });

  it("listForUser (/context/me): lists only active, undeleted tenants", async () => {
    const { client, sent } = fakeClient();
    await expect(repo().listForUser(USER_ID, client)).resolves.toEqual([]);
    expect(sent).toHaveLength(1);
    expectTenantActivePredicate(sent[0]);
  });

  it("listTenantRolesForUser (sign-in memberships): lists only active, undeleted tenants", async () => {
    const { client, sent } = fakeClient();
    await expect(repo().listTenantRolesForUser(USER_ID, client)).resolves.toEqual([]);
    expect(sent).toHaveLength(1);
    expectTenantActivePredicate(sent[0]);
  });
});

describe("RT-669 — MembershipRepository.isTenantActive", () => {
  /** A tenants row as Drizzle reads it (array row mode: status, deleted_at). */
  const row = (status: string, deletedAt: Date | null): unknown[] => [status, deletedAt];

  it.each([
    { label: "active", rows: [row("active", null)], expected: true },
    { label: "suspended", rows: [row("suspended", null)], expected: false },
    { label: "pending", rows: [row("pending", null)], expected: false },
    { label: "soft-deleted", rows: [row("active", new Date())], expected: false },
    { label: "missing / not visible", rows: [], expected: false },
  ])("$label tenant → $expected", async ({ rows, expected }) => {
    const { client, sent } = fakeClient([rows]);
    await expect(repo().isTenantActive(TENANT_ID, client)).resolves.toBe(expected);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toMatch(/from "tenants"/);
    expect(sent[0]!.values).toContain(TENANT_ID);
  });
});
