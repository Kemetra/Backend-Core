/**
 * RT-664 — platform-admin entitlement revisions and dispute adjustments
 * (AD-AI-ENT-001 D-2, RT-644 §4.7) against real Postgres with only the
 * RT-664 domain grants on the 0055 tables.
 *
 *   - T18 tenant self-grant: refused by the service (not a platform admin)
 *     and by RLS (no `app.is_platform_admin`), so only the platform source
 *     can grant.
 *   - Revisions: reason required, `expectedVersion` optimistic concurrency
 *     (a stale or concurrent write is a conflict, never merged), a SHA-256
 *     `content_hash`, one `ai_entitlement.revision_published` audit row.
 *   - T20: a dispute is a compensating `adjusted` row; nothing is mutated;
 *     the adjusted total never exceeds the committed units (also under
 *     concurrent adjustments with different keys); a retried key is the
 *     same adjustment; one `ai_usage.adjusted` audit row.
 *
 * Docker policy: HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import "reflect-metadata";

import { createHash } from "node:crypto";

import { runWithTenantContext } from "@data-pulse-2/db";
import type { Pool } from "pg";

import { AiEntitlementChecker } from "../../src/ai-entitlements/entitlement-checker";
import {
  AdjustmentRefusedError,
  AiEntitlementGrants,
  EntitlementRevisionConflictError,
  InvalidEntitlementRevisionError,
  NotPlatformAdminError,
} from "../../src/ai-entitlements/entitlement-grants";
import { MembershipRepository } from "../../src/context/membership.repository";
import type { PgTestEnv } from "../_helpers/postgres-container";
import { counter, ctxFor, F_ASK, key, newTenant, PLATFORM_ADMIN, startAiDb, stopAiDb, type AiTenant } from "./__support__/ai-fixture";

let env: PgTestEnv | null = null;
let grants: AiEntitlementGrants;
let checker: AiEntitlementChecker;

beforeAll(async () => {
  env = await startAiDb("RT-664 grants");
  if (env === null) return;
  grants = new AiEntitlementGrants(env.app, new MembershipRepository(env.app));
  checker = new AiEntitlementChecker(env.app, { reservationTtlSeconds: 900 });
}, 240_000);

afterAll(async () => {
  await stopAiDb(env);
}, 60_000);

const skip = (): boolean => env === null;
const admin = (): Pool => env!.admin;
const platform = { actorUserId: PLATFORM_ADMIN, requestId: "0a000000-0000-7000-8000-0000066400f1" };

const activeGrant = (expectedVersion: number) => ({
  expectedVersion,
  state: "active" as const,
  planCode: "ai_assist",
  catalogVersion: 1,
  reason: "pilot grant",
});

async function audits(tenantId: string, action: string) {
  const r = await admin().query(
    `SELECT actor_user_id, target_type, target_id, request_id, metadata FROM audit_events
      WHERE tenant_id = $1 AND action = $2 ORDER BY occurred_at, id`,
    [tenantId, action],
  );
  return r.rows as Array<{ actor_user_id: string; target_type: string; target_id: string; request_id: string | null; metadata: Record<string, unknown> }>;
}

async function committedEntry(t: AiTenant): Promise<string> {
  const decision = (await checker.check(ctxFor(t), { featureId: F_ASK, targetStores: [], unitsEstimate: 1, idempotencyKey: key() })).decision;
  if (decision.decision !== "allow") throw new Error("expected allow");
  await checker.settle({ tenantId: t.tenantId, reservationId: decision.reservationId, outcome: "ok" });
  const r = await admin().query<{ id: string }>(
    `SELECT id FROM ai_usage_ledger WHERE reservation_id = $1 AND entry_kind = 'committed'`,
    [decision.reservationId],
  );
  return r.rows[0]!.id;
}

describe("T18 — no tenant self-grant", () => {
  it("refuses a caller who is not a platform admin, and writes nothing", async () => {
    if (skip()) return;
    const t = await newTenant(admin());
    await expect(grants.publishRevision({ actorUserId: t.ownerId, requestId: null }, t.tenantId, activeGrant(0))).rejects.toBeInstanceOf(
      NotPlatformAdminError,
    );
    const n = await admin().query(`SELECT count(*)::int AS n FROM tenant_ai_entitlements WHERE tenant_id = $1`, [t.tenantId]);
    expect(n.rows[0].n).toBe(0);
  });

  it("RLS refuses a revision INSERT from the tenant's own context (42501)", async () => {
    if (skip()) return;
    const t = await newTenant(admin());
    const insert = runWithTenantContext(env!.app, { tenantId: t.tenantId, isPlatformAdmin: false }, (client) =>
      client.query(
        `INSERT INTO tenant_ai_entitlements (id, tenant_id, entitlement_version, state, effective_from, source, reason,
           created_by_user_id, content_hash, plan_code, catalog_version)
         VALUES (gen_random_uuid(), $1, 1, 'active', now(), 'manual_platform', 'self', $2, decode(repeat('00', 32), 'hex'), 'ai_assist', 1)`,
        [t.tenantId, t.ownerId],
      ),
    );
    await expect(insert).rejects.toMatchObject({ code: "42501" });
  });
});

describe("platform-admin revisions", () => {
  it("publishes v1 with a NULL base, a content hash and one audit row with the reason", async () => {
    if (skip()) return;
    const t = await newTenant(admin());
    expect(await grants.publishRevision(platform, t.tenantId, activeGrant(0))).toEqual({ entitlementVersion: 1 });
    const row = await admin().query(
      `SELECT base_version, source, reason, created_by_user_id, octet_length(content_hash) AS hash_len, content_hash
         FROM tenant_ai_entitlements WHERE tenant_id = $1`,
      [t.tenantId],
    );
    expect(row.rows[0]).toMatchObject({ base_version: null, source: "manual_platform", reason: "pilot grant", created_by_user_id: PLATFORM_ADMIN, hash_len: 32 });
    const rows = await audits(t.tenantId, "ai_entitlement.revision_published");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor_user_id: PLATFORM_ADMIN,
      target_type: "tenant_ai_entitlement",
      request_id: "0a000000-0000-7000-8000-0000066400f1",
      metadata: { entitlement_version: 1, base_version: null, state: "active", plan_code: "ai_assist", catalog_version: 1, reason: "pilot grant" },
    });
    const hash = (row.rows[0] as { content_hash: Buffer }).content_hash.toString("hex");
    expect(rows[0]!.metadata["content_hash"]).toBe(hash);
  });

  it("v2 names v1 as its base; a stale expectedVersion is a conflict and writes nothing", async () => {
    if (skip()) return;
    const t = await newTenant(admin());
    await grants.publishRevision(platform, t.tenantId, activeGrant(0));
    expect(await grants.publishRevision(platform, t.tenantId, { ...activeGrant(1), state: "grace" })).toEqual({ entitlementVersion: 2 });
    await expect(grants.publishRevision(platform, t.tenantId, activeGrant(1))).rejects.toBeInstanceOf(EntitlementRevisionConflictError);
    const r = await admin().query(`SELECT entitlement_version, base_version FROM tenant_ai_entitlements WHERE tenant_id = $1 ORDER BY 1`, [t.tenantId]);
    expect(r.rows).toEqual([
      { entitlement_version: 1, base_version: null },
      { entitlement_version: 2, base_version: 1 },
    ]);
  });

  it("two concurrent writers on the same base: exactly one wins", async () => {
    if (skip()) return;
    const t = await newTenant(admin());
    const results = await Promise.allSettled([0, 1, 2, 3].map(() => grants.publishRevision(platform, t.tenantId, activeGrant(0))));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results.filter((x): x is PromiseRejectedResult => x.status === "rejected")) {
      expect(r.reason).toBeInstanceOf(EntitlementRevisionConflictError);
    }
  });

  it("the content hash is the SHA-256 of the canonical revision content (stable across key order)", async () => {
    if (skip()) return;
    const a = await newTenant(admin());
    const b = await newTenant(admin());
    const effectiveFrom = "2026-10-01T00:00:00.000Z";
    const overrides = [{ featureId: F_ASK, action: "enable" as const, meter: "ask_requests", meterLimitDelta: 2, reason: "pilot" }];
    await grants.publishRevision(platform, a.tenantId, { ...activeGrant(0), effectiveFrom, overrides });
    await grants.publishRevision(platform, b.tenantId, {
      ...activeGrant(0),
      effectiveFrom,
      overrides: [{ reason: "pilot", meterLimitDelta: 2, meter: "ask_requests", action: "enable", featureId: F_ASK }],
    });
    const r = await admin().query<{ h: string }>(
      `SELECT encode(content_hash, 'hex') AS h FROM tenant_ai_entitlements WHERE tenant_id = ANY($1::uuid[])`,
      [[a.tenantId, b.tenantId]],
    );
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0]!.h).toBe(r.rows[1]!.h);
    const expected = createHash("sha256")
      .update(
        JSON.stringify({
          catalog_version: 1,
          effective_from: effectiveFrom,
          effective_until: null,
          overrides: [{ action: "enable", feature_id: F_ASK, meter: "ask_requests", meter_limit_delta: 2, reason: "pilot" }],
          plan_code: "ai_assist",
          reason: "pilot grant",
          source: "manual_platform",
          state: "active",
        }),
      )
      .digest("hex");
    expect(r.rows[0]!.h).toBe(expected);
  });

  it.each([
    ["an empty reason", { reason: "" }],
    ["an unknown plan", { planCode: "nope" }],
    ["state none with a plan", { state: "none" as const }],
    ["a trial with no end", { state: "trial" as const }],
    ["an override of a feature outside the catalogue", { overrides: [{ featureId: "ai.unknown.thing", action: "disable" as const, reason: "x" }] }],
    ["an enable override of a feature the plan lacks", { overrides: [{ featureId: "ai.catalog.doctor", action: "enable" as const, reason: "x" }] }],
    ["an override of a meter the feature lacks", { overrides: [{ featureId: F_ASK, action: "enable" as const, meter: "nope", meterLimitDelta: 1, reason: "x" }] }],
  ])("refuses %s as invalid and writes nothing", async (_name, patch) => {
    if (skip()) return;
    const t = await newTenant(admin());
    await expect(grants.publishRevision(platform, t.tenantId, { ...activeGrant(0), ...patch })).rejects.toBeInstanceOf(
      InvalidEntitlementRevisionError,
    );
    expect(await audits(t.tenantId, "ai_entitlement.revision_published")).toEqual([]);
  });

  it("state none needs no plan and denies every feature", async () => {
    if (skip()) return;
    const t = await newTenant(admin());
    await grants.publishRevision(platform, t.tenantId, { expectedVersion: 0, state: "none", planCode: null, catalogVersion: null, reason: "reset" });
    const d = (await checker.check(ctxFor(t), { featureId: F_ASK, targetStores: [], unitsEstimate: 1, idempotencyKey: key() })).decision;
    expect(d).toMatchObject({ decision: "deny", reasonCode: "not_entitled", entitlementVersion: 1 });
  });
});

describe("T20 — dispute adjustments", () => {
  it("credits a committed request with a compensating row and one audit row; nothing is mutated", async () => {
    if (skip()) return;
    const t = await newTenant(admin());
    await grants.publishRevision(platform, t.tenantId, activeGrant(0));
    const entry = await committedEntry(t);
    const before = await admin().query(`SELECT * FROM ai_usage_ledger WHERE tenant_id = $1 ORDER BY id`, [t.tenantId]);
    const k = key();
    const adj = await grants.adjustUsage(platform, t.tenantId, { committedEntryId: entry, units: 1, reason: "duplicate charge", idempotencyKey: k });
    expect(adj.replayed).toBe(false);
    expect(await counter(admin(), t.tenantId, "ask_requests")).toEqual({ used: 0, reserved: 0 });
    const after = await admin().query(`SELECT * FROM ai_usage_ledger WHERE tenant_id = $1 AND id <> $2 ORDER BY id`, [t.tenantId, adj.adjustmentId]);
    expect(after.rows).toEqual(before.rows);
    const row = await admin().query(`SELECT entry_kind, adjusts_entry_id, units, adjustment_reason, actor_user_id FROM ai_usage_ledger WHERE id = $1`, [adj.adjustmentId]);
    expect(row.rows[0]).toEqual({ entry_kind: "adjusted", adjusts_entry_id: entry, units: 1, adjustment_reason: "duplicate charge", actor_user_id: PLATFORM_ADMIN });
    const rows = await audits(t.tenantId, "ai_usage.adjusted");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ target_type: "ai_usage_ledger_entry", target_id: adj.adjustmentId, metadata: { adjusts_entry_id: entry, units: 1, reason: "duplicate charge" } });
    // A retry of the same key is the same adjustment, applied once.
    expect(await grants.adjustUsage(platform, t.tenantId, { committedEntryId: entry, units: 1, reason: "duplicate charge", idempotencyKey: k })).toEqual({
      adjustmentId: adj.adjustmentId,
      replayed: true,
    });
    expect(await audits(t.tenantId, "ai_usage.adjusted")).toHaveLength(1);
  });

  it("never credits more than the committed units, also under concurrent adjustments with different keys", async () => {
    if (skip()) return;
    const t = await newTenant(admin());
    await grants.publishRevision(platform, t.tenantId, activeGrant(0));
    const entry = await committedEntry(t);
    await committedEntry(t);
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () => grants.adjustUsage(platform, t.tenantId, { committedEntryId: entry, units: 1, reason: "dispute", idempotencyKey: key() })),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results.filter((x): x is PromiseRejectedResult => x.status === "rejected")) {
      expect(r.reason).toBeInstanceOf(AdjustmentRefusedError);
    }
    expect(await counter(admin(), t.tenantId, "ask_requests")).toEqual({ used: 1, reserved: 0 });
  });

  it("refuses a non platform admin, a reused key with another body, and an entry of another tenant", async () => {
    if (skip()) return;
    const t = await newTenant(admin());
    const other = await newTenant(admin());
    await grants.publishRevision(platform, t.tenantId, activeGrant(0));
    await grants.publishRevision(platform, other.tenantId, activeGrant(0));
    const entry = await committedEntry(t);
    const foreign = await committedEntry(other);
    await expect(
      grants.adjustUsage({ actorUserId: t.ownerId, requestId: null }, t.tenantId, { committedEntryId: entry, units: 1, reason: "self", idempotencyKey: key() }),
    ).rejects.toBeInstanceOf(NotPlatformAdminError);
    const k = key();
    await grants.adjustUsage(platform, t.tenantId, { committedEntryId: entry, units: 1, reason: "a", idempotencyKey: k });
    await expect(grants.adjustUsage(platform, t.tenantId, { committedEntryId: entry, units: 1, reason: "b", idempotencyKey: k })).rejects.toBeInstanceOf(
      AdjustmentRefusedError,
    );
    await expect(
      grants.adjustUsage(platform, t.tenantId, { committedEntryId: foreign, units: 1, reason: "x", idempotencyKey: key() }),
    ).rejects.toBeInstanceOf(AdjustmentRefusedError);
    expect(await counter(admin(), other.tenantId, "ask_requests")).toEqual({ used: 1, reserved: 0 });
  });

  it("RLS refuses an `adjusted` row from a tenant context without the platform flag (42501)", async () => {
    if (skip()) return;
    const t = await newTenant(admin());
    await grants.publishRevision(platform, t.tenantId, activeGrant(0));
    const entry = await committedEntry(t);
    const insert = runWithTenantContext(env!.app, { tenantId: t.tenantId, isPlatformAdmin: false }, (client) =>
      client.query(
        `INSERT INTO ai_usage_ledger (id, tenant_id, reservation_id, entry_kind, feature_id, counter_id, units,
           entitlement_version, idempotency_key, actor_user_id, adjusts_entry_id, adjustment_reason)
         SELECT x.id, l.tenant_id, x.id, 'adjusted', l.feature_id, l.counter_id, 1, l.entitlement_version, $2, $3, l.id, 'self credit'
           FROM ai_usage_ledger l, (SELECT gen_random_uuid() AS id) x WHERE l.id = $1`,
        [entry, key(), t.ownerId],
      ),
    );
    await expect(insert).rejects.toMatchObject({ code: "42501" });
  });
});
