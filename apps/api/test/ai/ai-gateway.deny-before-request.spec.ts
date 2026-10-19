/**
 * RT-655 acceptance 2 — deny-before-request.
 *
 * Every deny path must end in a deterministic fallback with NO provider request
 * and NO evidence read (AD-AI-ENT-001 D-1: "deny before spend"; RT-643 §5). The
 * gateway order is the ticket's: authorize -> entitlement -> kill switch ->
 * budget -> evidence -> route -> provider.
 */
import { AiGateway } from "../../src/ai/gateway/ai-gateway.service";
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
} from "./_support/gateway-harness";

function expectNoRequestNoRead(h: Harness): void {
  expect(h.provider.calls).toHaveLength(0);
  expect(h.calls.evidence).toBe(0);
}

describe("AiGateway — deny before any provider request", () => {
  describe("authorize (step 1)", () => {
    it.each([
      ["no user", { userId: null }],
      ["no tenant (platform admin without a tenant)", { tenantId: null, isPlatformAdmin: true }],
      ["a platform admin, even inside a tenant (D-6: support reads only)", { isPlatformAdmin: true }],
      ["a token principal (POS device / connector)", { source: "token" as const }],
    ])("denies %s with not_authorized and touches nothing downstream", async (_name, ctxOver) => {
      const h = buildHarness();
      const result = await h.gateway.run(FEATURE_ID, scope({ ctx: sessionCtx(ctxOver) }));
      expect(result).toMatchObject({
        kind: "fallback",
        reason: "not_authorized",
        providerRequested: false,
      });
      expect(h.calls.entitlement).toBe(0);
      expect(h.calls.budget).toBe(0);
      expectNoRequestNoRead(h);
    });

    it("denies a wrong store: a requested store outside the principal's scope (D-4: refuse, never narrow)", async () => {
      const h = buildHarness();
      const ctx = sessionCtx({ storeAccess: { kind: "specific", storeIds: [STORE_A] } });
      const result = await h.gateway.run(FEATURE_ID, scope({ ctx, storeIds: [STORE_A, STORE_B] }));
      expect(result).toMatchObject({
        kind: "fallback",
        reason: "store_out_of_scope",
        providerRequested: false,
      });
      expect(h.calls.entitlement).toBe(0);
      expectNoRequestNoRead(h);
    });

    it("denies a tenant-wide request from a store-scoped principal", async () => {
      const h = buildHarness();
      const ctx = sessionCtx({ storeAccess: { kind: "specific", storeIds: [STORE_A] } });
      const result = await h.gateway.run(FEATURE_ID, scope({ ctx, storeIds: [] }));
      expect(result).toMatchObject({ kind: "fallback", reason: "store_out_of_scope" });
      expectNoRequestNoRead(h);
    });

    it("fails closed when store access was never resolved (empty scope)", async () => {
      const h = buildHarness();
      const { storeAccess: _unresolved, ...ctx } = sessionCtx();
      const result = await h.gateway.run(FEATURE_ID, scope({ ctx, storeIds: [STORE_A] }));
      expect(result).toMatchObject({ kind: "fallback", reason: "store_out_of_scope" });
      expectNoRequestNoRead(h);
    });

    it("allows the active store when the membership grants it", async () => {
      const h = buildHarness();
      const ctx = sessionCtx({ storeId: STORE_A, storeAccess: { kind: "specific", storeIds: [STORE_A] } });
      const result = await h.gateway.run(FEATURE_ID, scope({ ctx, storeIds: [STORE_A] }));
      expect(result.kind).toBe("ok");
    });

    it("reports an unknown feature only after authorization (no feature enumeration)", async () => {
      const h = buildHarness();
      const denied = await h.gateway.run("nope", scope({ ctx: sessionCtx({ userId: null }) }));
      expect(denied).toMatchObject({ kind: "fallback", reason: "not_authorized" });
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
      const h = buildHarness({ entitlement: { allowed: false, reason } });
      const result = await h.gateway.run(FEATURE_ID, scope());
      expect(result).toMatchObject({ kind: "fallback", reason, providerRequested: false });
      expect(h.calls.budget).toBe(0);
      expectNoRequestNoRead(h);
    });

    it("fails closed (entitlement_unavailable) when the entitlement check throws", async () => {
      const h = buildHarness({
        entitlement: async () => {
          throw new Error("store unreachable");
        },
      });
      const result = await h.gateway.run(FEATURE_ID, scope());
      expect(result).toMatchObject({ kind: "fallback", reason: "entitlement_unavailable" });
      expectNoRequestNoRead(h);
    });
  });

  describe("kill switch (step 3)", () => {
    it("denies with feature_disabled_system when the gateway is not enabled", async () => {
      const h = buildHarness({ enabled: false });
      const result = await h.gateway.run(FEATURE_ID, scope());
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
        const h = buildHarness({ budget: { allowed: false, reason } });
        const result = await h.gateway.run(FEATURE_ID, scope());
        expect(result).toMatchObject({ kind: "fallback", reason, providerRequested: false });
        expectNoRequestNoRead(h);
      },
    );

    it("fails closed (entitlement_unavailable) when the budget check throws", async () => {
      const h = buildHarness({
        budget: async () => {
          throw new Error("ledger unreachable");
        },
      });
      const result = await h.gateway.run(FEATURE_ID, scope());
      expect(result).toMatchObject({ kind: "fallback", reason: "entitlement_unavailable" });
      expectNoRequestNoRead(h);
    });
  });

  describe("precedence — the first deny wins and later layers are never consulted", () => {
    it("unauthorized beats entitlement, kill switch and budget (no plan/system state leaks)", async () => {
      const h = buildHarness({
        enabled: false,
        entitlement: { allowed: false, reason: "not_entitled" },
        budget: { allowed: false, reason: "quota_exhausted" },
      });
      const result = await h.gateway.run(FEATURE_ID, scope({ ctx: sessionCtx({ userId: null }) }));
      expect(result).toMatchObject({ kind: "fallback", reason: "not_authorized" });
      expect(h.calls).toEqual({ entitlement: 0, budget: 0, evidence: 0 });
    });

    it("wrong store beats entitlement", async () => {
      const h = buildHarness({ entitlement: { allowed: false, reason: "not_entitled" } });
      const ctx = sessionCtx({ storeAccess: { kind: "specific", storeIds: [STORE_B] } });
      const result = await h.gateway.run(FEATURE_ID, scope({ ctx, storeIds: [STORE_A] }));
      expect(result).toMatchObject({ kind: "fallback", reason: "store_out_of_scope" });
      expect(h.calls.entitlement).toBe(0);
    });

    it("entitlement beats kill switch and budget (ticket order)", async () => {
      const h = buildHarness({
        enabled: false,
        entitlement: { allowed: false, reason: "not_entitled" },
        budget: { allowed: false, reason: "quota_exhausted" },
      });
      const result = await h.gateway.run(FEATURE_ID, scope());
      expect(result).toMatchObject({ kind: "fallback", reason: "not_entitled" });
      expect(h.calls.budget).toBe(0);
    });

    it("kill switch beats budget", async () => {
      const h = buildHarness({
        enabled: false,
        budget: { allowed: false, reason: "quota_exhausted" },
      });
      const result = await h.gateway.run(FEATURE_ID, scope());
      expect(result).toMatchObject({ kind: "fallback", reason: "feature_disabled_system" });
      expect(h.calls.budget).toBe(0);
    });
  });

  it("hands the entitlement port the caller's identity, feature and requested stores", async () => {
    const seen: unknown[] = [];
    const gateway = new AiGateway({
      features: [TEST_FEATURE as never],
      entitlement: {
        async check(input) {
          seen.push(input);
          return { allowed: false, reason: "not_entitled" };
        },
      },
      budget: { check: async () => ({ allowed: true }) },
      evidence: { build: async () => ({ items: [] }) },
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
