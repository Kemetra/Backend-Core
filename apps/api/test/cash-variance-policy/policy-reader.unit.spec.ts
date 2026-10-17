/**
 * RT-387 — the store resolution's lazy `override_expired` audit never breaks
 * the read (coordinator condition): the write runs under a SAVEPOINT, a
 * failure is rolled back to it and logged with identifiers only, and the
 * resolution is still answered. A live override and a clear emit nothing.
 */
import type { PoolClient } from "pg";

import { PolicyReader } from "../../src/cash-variance-policy/policy-reader";

const TENANT = "0a000000-0000-7000-8000-000003870001";
const STORE = "0a000000-0000-7000-8000-000003870002";
const REVISION = "0a000000-0000-7000-8000-000003870003";
const USER = "0a000000-0000-7000-8000-000003870004";
const NOW = new Date("2026-10-17T10:00:00.000Z");

function storeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: REVISION,
    scope: "store",
    store_id: STORE,
    kind: "set",
    mode: "limit",
    limit_amount: "1.0000",
    currency_code: "EGP",
    reason: "Stocktake",
    effective_until: new Date("2026-10-16T10:00:00.000Z"),
    permanent: false,
    approved_by_user_id: null,
    supersedes_revision_id: null,
    created_by_user_id: USER,
    created_at: new Date("2026-10-15T10:00:00.000Z"),
    created_at_key: "2026-10-15T10:00:00.000000Z",
    ...overrides,
  };
}

/** A client double: the clock, no tenant revision, `latestStore` for the store, and the audit insert. */
function clientOf(latestStore: Record<string, unknown> | null, auditFails: boolean) {
  const statements: string[] = [];
  const query = jest.fn(async (sql: string) => {
    const text = sql.trim();
    statements.push(text.split(/\s+/).slice(0, 4).join(" "));
    if (text.startsWith("SELECT now()")) return { rows: [{ now: NOW }] };
    if (text.startsWith("INSERT INTO audit_events")) {
      if (auditFails) throw Object.assign(new Error("permission denied for table audit_events"), { code: "42501" });
      return { rows: [] };
    }
    if (text.includes("scope = 'store'") && latestStore !== null && text.includes("LIMIT 1")) return { rows: [latestStore] };
    return { rows: [] };
  });
  return { client: { query } as unknown as PoolClient, statements };
}

describe("PolicyReader.store — the lazy override_expired audit", () => {
  it("answers the read when the audit insert fails, rolled back to its savepoint, with one identifier-only warning", async () => {
    const { client, statements } = clientOf(storeRow(), true);
    const logger = { warn: jest.fn() };
    const result = await new PolicyReader(undefined, logger).store(client, { tenantId: TENANT, storeId: STORE });
    expect(result.activeOverride).toBeNull();
    expect(result.effective.policySource).toBe("system");
    expect(statements).toContain("SAVEPOINT cash_variance_policy_expiry_audit");
    expect(statements).toContain("ROLLBACK TO SAVEPOINT cash_variance_policy_expiry_audit");
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0]?.[0]).toEqual({
      event: "cash_variance_policy.override_expired.audit_failed",
      tenant_id: TENANT,
      store_id: STORE,
      revision_id: REVISION,
      error_class: "Error",
    });
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("Stocktake");
  });

  it("releases the savepoint after a written audit", async () => {
    const { client, statements } = clientOf(storeRow(), false);
    await new PolicyReader().store(client, { tenantId: TENANT, storeId: STORE });
    expect(statements).toContain("RELEASE SAVEPOINT cash_variance_policy_expiry_audit");
    expect(statements.filter((s) => s.startsWith("INSERT INTO audit_events"))).toHaveLength(1);
  });

  it.each([
    ["a live override", storeRow({ effective_until: new Date("2026-10-18T10:00:00.000Z") })],
    ["a permanent override", storeRow({ effective_until: null, permanent: true, approved_by_user_id: USER })],
    ["a clear", storeRow({ kind: "clear", mode: null, limit_amount: null, currency_code: null, effective_until: null })],
    ["no store revision", null],
  ])("writes nothing for %s", async (_label, latest) => {
    const { client, statements } = clientOf(latest, false);
    await new PolicyReader().store(client, { tenantId: TENANT, storeId: STORE });
    expect(statements.some((s) => s.startsWith("SAVEPOINT") || s.startsWith("INSERT"))).toBe(false);
  });
});
