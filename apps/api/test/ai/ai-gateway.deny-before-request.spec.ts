/**
 * RT-655 acceptance 2 — deny-before-request.
 *
 * Every deny path must end in a deterministic fallback with NO provider request
 * and NO evidence read (AD-AI-ENT-001 D-1: "deny before spend"; RT-643 §5). The
 * gateway order is the ticket's: authorize -> entitlement -> kill switch ->
 * budget -> evidence -> route -> provider.
 */
import { AiGateway } from "../../src/ai/gateway/ai-gateway.service";
import type { AiFallbackReason } from "../../src/ai/gateway/ai-gateway.types";
import type { ResolvedContext } from "../../src/context/types";
import {
  FEATURE_ID,
  STORE_A,
  STORE_B,
  TENANT_ID,
  TEST_FEATURE,
  USER_ID,
  buildHarness,
  scope,
  sessionCtx,
  type Harness,
  type HarnessOptions,
} from "./_support/gateway-harness";

function expectNoRequestNoRead(h: Harness): void {
  expect(h.provider.calls).toHaveLength(0);
  expect(h.calls.evidence).toBe(0);
}

async function runDenied(
  options: HarnessOptions,
  ctx: ResolvedContext = sessionCtx(),
  storeIds: readonly string[] = [STORE_A],
): Promise<{ h: Harness; result: Awaited<ReturnType<AiGateway["run"]>> }> {
  const h = buildHarness(options);
  const result = await h.gateway.run(FEATURE_ID, scope({ ctx, storeIds }));
  return { h, result };
}

const throwing = (message: string) => (): Promise<never> => Promise.reject(new Error(message));

describe("AiGateway — deny before any provider request", () => {
  describe("authorize (step 1)", () => {
    it.each([
      ["no user", { userId: null }],
      ["no tenant (platform admin without a tenant)", { tenantId: null, isPlatformAdmin: true }],
      ["a platform admin, even inside a tenant (D-6: support reads only)", { isPlatformAdmin: true }],
      ["a token principal (POS device / connector)", { source: "token" as const }],
    ])("denies %s with not_authorized and touches nothing downstream", async (_name, ctxOver) => {
      const { h, result } = await runDenied({}, sessionCtx(ctxOver));
      expect(result).toMatchObject({
        kind: "fallback",
        reason: "not_authorized",
        providerRequested: false,
      });
      expect(h.calls).toEqual({ entitlement: 0, budget: 0, evidence: 0 });
      expect(h.provider.calls).toHaveLength(0);
    });

    it.each([
      [
        "a requested store outside the principal's scope (D-4: refuse, never narrow)",
        sessionCtx({ storeAccess: { kind: "specific", storeIds: [STORE_A] } }),
        [STORE_A, STORE_B],
      ],
      [
        "a tenant-wide request from a store-scoped principal",
        sessionCtx({ storeAccess: { kind: "specific", storeIds: [STORE_A] } }),
        [],
      ],
      [
        "store access that was never resolved (empty scope, fail closed)",
        (({ storeAccess: _unresolved, ...rest }) => rest)(sessionCtx()),
        [STORE_A],
      ],
    ])("denies %s with store_out_of_scope", async (_name, ctx, storeIds) => {
      const { h, result } = await runDenied({}, ctx, storeIds);
      expect(result).toMatchObject({
        kind: "fallback",
        reason: "store_out_of_scope",
        providerRequested: false,
      });
      expect(h.calls.entitlement).toBe(0);
      expectNoRequestNoRead(h);
    });

    it("allows the active store when the membership grants it", async () => {
      const ctx = sessionCtx({ storeId: STORE_A, storeAccess: { kind: "specific", storeIds: [STORE_A] } });
      const { result } = await runDenied({}, ctx);
      expect(result.kind).toBe("ok");
    });

    it("reports an unknown feature only after authorization (no feature enumeration)", async () => {
      const h = buildHarness();
      const unauthorized = await h.gateway.run("nope", scope({ ctx: sessionCtx({ userId: null }) }));
      expect(unauthorized).toMatchObject({ kind: "fallback", reason: "not_authorized" });
      const unknown = await h.gateway.run("nope", scope());
      expect(unknown).toMatchObject({
        kind: "fallback",
        reason: "unknown_feature",
        providerRequested: false,
      });
      expect(h.calls.entitlement).toBe(0);
      expectNoRequestNoRead(h);
    });
  });

  describe("entitlement (step 2)", () => {
    it.each([
      "not_entitled",
      "tenant_inactive",
      "trial_expired",
      "grace_read_only",
      "feature_disabled_tenant",
    ] as const)("denies with %s", async (reason) => {
      const { h, result } = await runDenied({ entitlement: { allowed: false, reason } });
      expect(result).toMatchObject({ kind: "fallback", reason, providerRequested: false });
      expect(h.calls.budget).toBe(0);
      expectNoRequestNoRead(h);
    });
  });

  describe("kill switch (step 3)", () => {
    it("denies with feature_disabled_system when the gateway is not enabled", async () => {
      const { h, result } = await runDenied({ enabled: false });
      expect(result).toMatchObject({
        kind: "fallback",
        reason: "feature_disabled_system",
        providerRequested: false,
      });
      expect(h.calls.budget).toBe(0);
      expectNoRequestNoRead(h);
    });
  });

  describe("budget pre-check (step 4)", () => {
    it.each(["quota_exhausted", "spend_cap_reached", "free_credit_exhausted"] as const)(
      "denies over-budget with %s",
      async (reason) => {
        const { h, result } = await runDenied({ budget: { allowed: false, reason } });
        expect(result).toMatchObject({ kind: "fallback", reason, providerRequested: false });
        expectNoRequestNoRead(h);
      },
    );
  });

  describe("fail closed on unknown state", () => {
    it.each([
      ["the entitlement check throws", { entitlement: throwing("store unreachable") }],
      ["the budget check throws", { budget: throwing("ledger unreachable") }],
    ])("denies with entitlement_unavailable when %s", async (_name, options) => {
      const { h, result } = await runDenied(options);
      expect(result).toMatchObject({ kind: "fallback", reason: "entitlement_unavailable" });
      expectNoRequestNoRead(h);
    });
  });

  describe("precedence — the first deny wins and later layers are never consulted", () => {
    const entitlementDeny = { allowed: false, reason: "not_entitled" } as const;
    const budgetDeny = { allowed: false, reason: "quota_exhausted" } as const;
    const unauthorizedCtx = sessionCtx({ userId: null });
    const wrongStoreCtx = sessionCtx({ storeAccess: { kind: "specific", storeIds: [STORE_B] } });

    it.each<[string, HarnessOptions, ResolvedContext, AiFallbackReason, Partial<Harness["calls"]>]>([
      [
        "unauthorized beats entitlement, kill switch and budget (no plan/system state leaks)",
        { enabled: false, entitlement: entitlementDeny, budget: budgetDeny },
        unauthorizedCtx,
        "not_authorized",
        { entitlement: 0, budget: 0, evidence: 0 },
      ],
      [
        "wrong store beats entitlement",
        { entitlement: entitlementDeny },
        wrongStoreCtx,
        "store_out_of_scope",
        { entitlement: 0 },
      ],
      [
        "entitlement beats kill switch and budget (ticket order)",
        { enabled: false, entitlement: entitlementDeny, budget: budgetDeny },
        sessionCtx(),
        "not_entitled",
        { budget: 0 },
      ],
      [
        "kill switch beats budget",
        { enabled: false, budget: budgetDeny },
        sessionCtx(),
        "feature_disabled_system",
        { budget: 0 },
      ],
    ])("%s", async (_name, options, ctx, reason, expectedCalls) => {
      const { h, result } = await runDenied(options, ctx);
      expect(result).toMatchObject({ kind: "fallback", reason });
      expect(h.calls).toMatchObject(expectedCalls);
      expect(h.provider.calls).toHaveLength(0);
    });
  });

  it("hands the entitlement port the caller's identity, feature and requested stores", async () => {
    const seen: unknown[] = [];
    const gateway = new AiGateway({
      features: [TEST_FEATURE as never],
      entitlement: {
        check(input) {
          seen.push(input);
          return Promise.resolve({ allowed: false, reason: "not_entitled" });
        },
      },
      budget: { check: () => Promise.resolve({ allowed: true }) },
      evidence: { build: () => Promise.resolve({ items: [] }) },
      routes: [],
      providers: [],
      runtime: { isEnabled: () => true, isProduction: () => false },
      metrics: { recordRun: () => undefined, recordProviderCall: () => undefined },
    });
    await gateway.run(FEATURE_ID, scope({ storeIds: [STORE_A] }));
    expect(seen).toEqual([
      { tenantId: TENANT_ID, userId: USER_ID, featureId: FEATURE_ID, storeIds: [STORE_A] },
    ]);
  });
});
