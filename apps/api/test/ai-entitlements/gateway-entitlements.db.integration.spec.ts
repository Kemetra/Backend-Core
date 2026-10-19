/**
 * RT-664 — the AI gateway on the REAL entitlement port (the `ai-entitlements`
 * checker on Testcontainers Postgres with only the RT-664 grants) and the
 * fake provider: RT-664 acceptance 2, "zero provider calls on any deny path".
 *
 *   - not entitled (T1), opted out (D-5), over quota (T2), suspended (T15),
 *     free credit exhausted (T12) and spend cap reached (T16): zero provider
 *     calls; T12 / T16 reserve nothing (the budget runs before the reserve);
 *   - an ok run commits once (used +1), a provider outage (T10) or an output
 *     failing validation (D-8) releases (meter unchanged);
 *   - a retry with the same key after the response was lost replays the
 *     settled reservation without a second provider call (T13).
 *
 * Docker policy: HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import "reflect-metadata";

import { FakeModelProvider, type FakeModelBehavior } from "../../src/ai/adapters/fake/fake-model-provider";
import type { AiFeatureDefinition } from "../../src/ai/gateway/ai-feature";
import { AiGateway } from "../../src/ai/gateway/ai-gateway.service";
import type { AiBudgetDecision } from "../../src/ai/gateway/ai-gateway.types";
import { AiEntitlementChecker } from "../../src/ai-entitlements/entitlement-checker";
import { AiEntitlementGrants } from "../../src/ai-entitlements/entitlement-grants";
import { AiGatewayEntitlementPort } from "../../src/ai-entitlements/gateway-entitlement.port";
import { MembershipRepository } from "../../src/context/membership.repository";
import type { PgTestEnv } from "../_helpers/postgres-container";
import { EXPLAIN_OUTPUT_SCHEMA, FAKE_ROUTE, TEST_FEATURE } from "../ai/_support/gateway-harness";
import {
  AI_TABLE_GRANTS,
  counter,
  ctxFor,
  F_ASK,
  key,
  ledgerKinds,
  newTenant,
  PLATFORM_ADMIN,
  restrictAiGrants,
  startAiDb,
  stopAiDb,
  type AiTenant,
} from "./__support__/ai-fixture";

let env: PgTestEnv | null = null;
let port: AiGatewayEntitlementPort;
let grants: AiEntitlementGrants;

const ASK_FEATURE: AiFeatureDefinition = { ...(TEST_FEATURE as AiFeatureDefinition), featureId: F_ASK, outputSchema: EXPLAIN_OUTPUT_SCHEMA };
const PACK = { items: [{ ref: "sale:1", fields: { total: 1 } }] };

beforeAll(async () => {
  env = await startAiDb("RT-664 gateway");
  if (env === null) return;
  port = new AiGatewayEntitlementPort(new AiEntitlementChecker(env.app, { reservationTtlSeconds: 900 }));
  grants = new AiEntitlementGrants(env.app, new MembershipRepository(env.app));
}, 240_000);

afterAll(async () => {
  await stopAiDb(env);
}, 60_000);

const skip = (): boolean => env === null;

function gateway(options: { behavior?: FakeModelBehavior; budget?: AiBudgetDecision } = {}) {
  const provider = new FakeModelProvider({ providerKey: "fake", ...(options.behavior ? { behavior: options.behavior } : {}) });
  const gw = new AiGateway({
    features: [ASK_FEATURE],
    entitlement: port,
    budget: { check: () => Promise.resolve(options.budget ?? { allowed: true }) },
    evidence: { build: () => Promise.resolve(PACK) },
    routes: [FAKE_ROUTE],
    providers: [provider],
    runtime: { isEnabled: () => true, isProduction: () => false },
    metrics: { recordRun: () => undefined, recordProviderCall: () => undefined },
  });
  return { gw, provider };
}

async function entitled(t: AiTenant): Promise<void> {
  await grants.publishRevision({ actorUserId: PLATFORM_ADMIN, requestId: null }, t.tenantId, {
    expectedVersion: 0,
    state: "active",
    planCode: "ai_assist",
    catalogVersion: 1,
    reason: "RT-664 gateway spec",
  });
}

const run = (gw: AiGateway, t: AiTenant, idempotencyKey = key()) =>
  gw.run(F_ASK, { ctx: ctxFor(t), storeIds: [], correlationId: "corr-rt664", idempotencyKey });

describe("deny paths: zero provider calls", () => {
  it("T1: not entitled", async () => {
    if (skip()) return;
    const t = await newTenant(env!.admin);
    const { gw, provider } = gateway();
    expect(await run(gw, t)).toMatchObject({ kind: "fallback", reason: "not_entitled", providerRequested: false });
    expect(provider.calls).toHaveLength(0);
    expect(await ledgerKinds(env!.admin, t.tenantId)).toEqual([]);
  });

  it("T15: a suspended tenant", async () => {
    if (skip()) return;
    const t = await newTenant(env!.admin, "suspended");
    const { gw, provider } = gateway();
    expect(await run(gw, t)).toMatchObject({ kind: "fallback", reason: "tenant_inactive" });
    expect(provider.calls).toHaveLength(0);
  });

  it.each([
    ["T12 free credit exhausted", "free_credit_exhausted"],
    ["T16 spend cap reached", "spend_cap_reached"],
  ] as const)("%s: denied before any reservation (never a silent switch to paid spend)", async (_n, reason) => {
    if (skip()) return;
    const t = await newTenant(env!.admin);
    await entitled(t);
    const { gw, provider } = gateway({ budget: { allowed: false, reason } });
    expect(await run(gw, t)).toMatchObject({ kind: "fallback", reason, providerRequested: false });
    expect(provider.calls).toHaveLength(0);
    expect(await ledgerKinds(env!.admin, t.tenantId)).toEqual([]);
  });

  it("D-5: an owner opt-out denies feature_disabled_tenant and consumes no quota", async () => {
    if (skip()) return;
    const t = await newTenant(env!.admin);
    await entitled(t);
    await env!.admin.query(
      `INSERT INTO tenant_ai_feature_opt_outs (id, tenant_id, opt_out_version, feature_id, action, reason, created_by_user_id)
       VALUES (gen_random_uuid(), $1, 1, $2, 'opt_out', 'governance', $3)`,
      [t.tenantId, F_ASK, t.ownerId],
    );
    const { gw, provider } = gateway();
    expect(await run(gw, t)).toMatchObject({ kind: "fallback", reason: "feature_disabled_tenant" });
    expect(provider.calls).toHaveLength(0);
    expect(await ledgerKinds(env!.admin, t.tenantId)).toEqual([]);
  });

  it("T2: over quota", async () => {
    if (skip()) return;
    const t = await newTenant(env!.admin);
    await entitled(t);
    const { gw, provider } = gateway();
    for (let i = 0; i < 5; i += 1) expect((await run(gw, t)).kind).toBe("ok");
    expect(await run(gw, t)).toMatchObject({ kind: "fallback", reason: "quota_exhausted" });
    expect(provider.calls).toHaveLength(5);
    expect(await counter(env!.admin, t.tenantId, "ask_requests")).toEqual({ used: 5, reserved: 0 });
  });
});

describe("before the owner-gated grants are applied", () => {
  it("every run fails closed with entitlement_unavailable and zero provider calls", async () => {
    if (skip()) return;
    const t = await newTenant(env!.admin);
    await entitled(t);
    for (const [table] of AI_TABLE_GRANTS) await env!.admin.query(`REVOKE ALL ON ${table} FROM app_test`);
    try {
      const { gw, provider } = gateway();
      expect(await run(gw, t)).toMatchObject({ kind: "fallback", reason: "entitlement_unavailable", providerRequested: false });
      expect(provider.calls).toHaveLength(0);
    } finally {
      await restrictAiGrants(env!.admin, "app_test");
    }
    expect(await ledgerKinds(env!.admin, t.tenantId)).toEqual([]);
  });
});

describe("settlement on the ledger", () => {
  it("an ok run commits once; T10 an outage and D-8 an invalid output release (meter unchanged)", async () => {
    if (skip()) return;
    const t = await newTenant(env!.admin);
    await entitled(t);
    expect((await run(gateway().gw, t)).kind).toBe("ok");
    expect(await counter(env!.admin, t.tenantId, "ask_requests")).toEqual({ used: 1, reserved: 0 });

    const outage = gateway({ behavior: { kind: "result", result: { kind: "unavailable", cause: "provider_5xx" } } });
    expect(await run(outage.gw, t)).toMatchObject({ kind: "fallback", reason: "provider_unavailable", providerRequested: true });
    const invalid = gateway({ behavior: { kind: "result", result: { kind: "ok", rawOutput: { bad: true }, usage: { reported: true, outputTokens: 3 } } } });
    expect(await run(invalid.gw, t)).toMatchObject({ kind: "fallback", reason: "output_schema_invalid" });
    expect(await counter(env!.admin, t.tenantId, "ask_requests")).toEqual({ used: 1, reserved: 0 });

    const outcomes = await env!.admin.query(
      `SELECT entry_kind, outcome, output_tokens::int FROM ai_usage_ledger WHERE tenant_id = $1 AND entry_kind <> 'reserved' ORDER BY created_at`,
      [t.tenantId],
    );
    expect(outcomes.rows).toEqual([
      { entry_kind: "committed", outcome: "ok", output_tokens: 8 },
      { entry_kind: "released", outcome: "provider_unavailable", output_tokens: null },
      { entry_kind: "released", outcome: "output_invalid", output_tokens: 3 },
    ]);
  });

  type SameKeyRuns = (gw: AiGateway, t: AiTenant, k: string) => Promise<Array<{ kind: string }>>;
  const sequential: SameKeyRuns = async (gw, t, k) => [await run(gw, t, k), await run(gw, t, k)];
  const concurrent: SameKeyRuns = (gw, t, k) => Promise.all(Array.from({ length: 6 }, () => run(gw, t, k)));

  it.each([
    ["T13: a retry after the response was lost", sequential],
    ["concurrent runs", concurrent],
  ] as const)("%s with one key make ONE provider call and charge once", async (_name, runs) => {
    if (skip()) return;
    const t = await newTenant(env!.admin);
    await entitled(t);
    const { gw, provider } = gateway();
    const results = await runs(gw, t, key());
    expect(results.filter((r) => r.kind === "ok")).toHaveLength(1);
    expect(provider.calls).toHaveLength(1);
    expect(await counter(env!.admin, t.tenantId, "ask_requests")).toEqual({ used: 1, reserved: 0 });
  });
});
