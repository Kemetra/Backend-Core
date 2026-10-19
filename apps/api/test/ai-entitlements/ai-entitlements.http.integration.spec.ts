/**
 * RT-664 — `ai-entitlements.openapi.yaml` over HTTP against real Postgres
 * (Testcontainers, every migration incl. 0055, the NOBYPASSRLS `app_test`
 * pool with ONLY the RT-664 grants on the 0055 tables), the real module
 * graph (`TenantContextGuard`, `RolesGuard`, the owner-membership guard,
 * `MembershipRepository`) and the real `IdempotencyInterceptor` over a fake
 * Redis. Only cookie authentication is faked (the `x-test-session` header).
 *
 *   consoleGetTenantAiEntitlements — the full view (owner, tenant_admin,
 *   platform admin) and the minimal view (store_manager) per D-6; store_staff,
 *   another tenant and an absent tenant are the same non-disclosing 404 (T7,
 *   T9: a paid tier never elevates); a revoked member is refused on the next
 *   request (T8); the kill switch makes features unavailable with no reason;
 *   an unreadable store is 503 `entitlement_unavailable`.
 *
 *   consolePutTenantAiFeatureOptOut — owner only (a platform admin or a
 *   tenant_admin is the 404, D-5); the contract's check order; subtract-only
 *   (an opt-in never exceeds the plan: 422 `not_entitled`); same state writes
 *   nothing; a stale `expectedOptOutVersion` is 409; one audit row per change;
 *   idempotent replay.
 *
 * Every body validates against the contract schemas.
 *
 * Docker policy: HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import "reflect-metadata";

import type request from "supertest";

import { AiEntitlementsModule } from "../../src/ai-entitlements/ai-entitlements.module";
import { AiEntitlementGrants } from "../../src/ai-entitlements/entitlement-grants";
import { MembershipRepository } from "../../src/context/membership.repository";
import { idempotencyProviders } from "../_helpers/idempotency-providers";
import { scopedHttpHarness } from "../_helpers/scoped-http-harness";
import { AI_TABLE_GRANTS, F_ASK, F_BRIEFING, F_DOCTOR, PLATFORM_ADMIN, restrictAiGrants } from "./__support__/ai-fixture";
import {
  MEMBERSHIP_OWNER_REVOKE,
  SES_ADMIN,
  SES_MANAGER,
  SES_OWNER,
  SES_OWNER_B,
  SES_OWNER_REVOKE,
  SES_PA_ADMIN,
  SES_STAFF,
  seedAiHttpFixture,
  STORE_A1,
  STORE_A2,
  TENANT_A,
  TENANT_B,
  USER_OWNER,
} from "./__support__/http-fixture";

const view = (tenantId: string): string => `/api/v1/tenants/${tenantId}/ai/entitlements`;
const optOut = (tenantId: string, featureId: string): string => `${view(tenantId)}/opt-outs/${featureId}`;
const NOT_FOUND = { code: "not_found", message: "Not Found" };
const OPT_OUT_CHANGED = "ai_entitlement.opt_out_changed";

const h = scopedHttpHarness({
  label: "RT-664 ai-entitlements",
  contractId: "ai-entitlements.openapi",
  module: AiEntitlementsModule,
  seed: seedAiHttpFixture,
  providers: idempotencyProviders(),
});
const skip = (): boolean => h.skipped();

let keySeq = 0;
const nextKey = (): string => `rt664-http-${String((keySeq += 1)).padStart(8, "0")}`;

function put(path: string, session: string | null, body: object, key: string | null = nextKey()): request.Test {
  const req = h.put(path, session, body);
  return key === null ? req : req.set("Idempotency-Key", key);
}

function expectNotFound(res: request.Response): void {
  expect(res.status).toBe(404);
  expect((res.body as { error?: unknown }).error).toMatchObject(NOT_FOUND);
  expect(JSON.stringify(res.body)).not.toMatch(/plan|entitle|meter|ai_/i);
}

function expectError(res: request.Response, status: number, code: string): void {
  expect({ status: res.status, code: (res.body as { error?: { code?: string } }).error?.code }).toEqual({ status, code });
  h.conforms("Error", res.body);
}

type FullView = {
  view: "full";
  entitlementVersion: number;
  optOutVersion: number;
  state: string;
  features: Array<{ featureId: string; availability: string; unavailableReason: string | null; entitled: boolean; optOut: { optedOut: boolean }; meters: Array<{ meter: string; storeRef: string | null; limit: number; used: number; remaining: number }> }>;
};

const feature = (body: FullView, featureId: string) => body.features.find((f) => f.featureId === featureId)!;

async function grant(input: { expectedVersion: number; planCode?: string; state?: "active" | "grace" }): Promise<void> {
  const grants = new AiEntitlementGrants(h.env().app, new MembershipRepository(h.env().app));
  await grants.publishRevision({ actorUserId: PLATFORM_ADMIN, requestId: null }, TENANT_A, {
    expectedVersion: input.expectedVersion,
    state: input.state ?? "active",
    planCode: input.planCode ?? "ai_assist",
    catalogVersion: 1,
    reason: "RT-664 HTTP spec",
  });
}

async function auditCount(): Promise<number> {
  const r = await h.env().admin.query(`SELECT count(*)::int AS n FROM audit_events WHERE tenant_id = $1 AND action = $2`, [TENANT_A, OPT_OUT_CHANGED]);
  return r.rows[0].n as number;
}

beforeAll(() => {
  process.env["AI_GATEWAY_ENABLED"] = "1";
});
afterAll(() => {
  delete process.env["AI_GATEWAY_ENABLED"];
});

describe("GET before any revision", () => {
  it("is state none at version 0: every catalogue feature is unavailable, not entitled, with no meter", async () => {
    if (skip()) return;
    const res = await h.get(view(TENANT_A), SES_OWNER).expect(200);
    h.conforms("TenantAiEntitlementsFull", res.body);
    expect(res.headers["cache-control"]).toBe("no-store");
    const body = res.body as FullView;
    expect(body).toMatchObject({ view: "full", entitlementVersion: 0, optOutVersion: 0, state: "none", effectiveFrom: null, effectiveUntil: null });
    expect(body.features.map((f) => f.featureId)).toEqual([...body.features.map((f) => f.featureId)].sort());
    expect(body.features.every((f) => f.availability === "unavailable" && !f.entitled && f.meters.length === 0 && f.unavailableReason === "not_entitled")).toBe(true);
  });
});

describe("GET roles and isolation (D-6, T7, T9)", () => {
  it("owner, tenant_admin and a platform admin get the full view; store_manager the minimal one", async () => {
    if (skip()) return;
    await grant({ expectedVersion: 0 });
    for (const session of [SES_OWNER, SES_ADMIN, SES_PA_ADMIN]) {
      const res = await h.get(view(TENANT_A), session).expect(200);
      h.conforms("TenantAiEntitlementsFull", res.body);
      expect((res.body as FullView).entitlementVersion).toBe(1);
    }
    const minimal = await h.get(view(TENANT_A), SES_MANAGER).expect(200);
    h.conforms("TenantAiEntitlementsMinimal", minimal.body);
    expect(Object.keys(minimal.body as object).sort()).toEqual(["evaluatedAt", "features", "view"]);
    expect((minimal.body as { features: Array<{ featureId: string; availability: string }> }).features).toContainEqual({ featureId: F_ASK, availability: "available" });
    h.conforms("TenantAiEntitlements", minimal.body);
  });

  it("an entitled feature lists its meters: a tenant meter once, a store meter per store", async () => {
    if (skip()) return;
    const body = (await h.get(view(TENANT_A), SES_OWNER).expect(200)).body as FullView;
    expect(feature(body, F_ASK)).toMatchObject({ availability: "available", unavailableReason: null, entitled: true, optOut: { optedOut: false } });
    expect(feature(body, F_ASK).meters).toEqual([expect.objectContaining({ meter: "ask_requests", storeRef: null, limit: 5, used: 0, remaining: 5 })]);
    expect(feature(body, F_BRIEFING).meters.map((m) => m.storeRef).sort()).toEqual([STORE_A1, STORE_A2].sort());
    expect(feature(body, F_DOCTOR)).toMatchObject({ availability: "unavailable", unavailableReason: "not_entitled", entitled: false, meters: [] });
  });

  it("T9: store_staff, another tenant's id and an absent tenant are the same 404 with no plan information", async () => {
    if (skip()) return;
    expectNotFound(await h.get(view(TENANT_A), SES_STAFF));
    expectNotFound(await h.get(view(TENANT_B), SES_OWNER));
    expectNotFound(await h.get(view(TENANT_A), SES_OWNER_B));
    expectNotFound(await h.get(view("0c000000-0000-7000-8000-000006640099"), SES_OWNER));
  });

  it("is 401 without a session and 400 for a malformed tenant id or any query parameter", async () => {
    if (skip()) return;
    expect((await h.get(view(TENANT_A), null)).status).toBe(401);
    expectError(await h.get(view("not-a-uuid"), SES_OWNER), 400, "validation_error");
    expectError(await h.get(view(TENANT_A), SES_OWNER, { view: "full" }), 400, "validation_error");
  });

  it("the kill switch makes every feature unavailable with no tenant-facing reason", async () => {
    if (skip()) return;
    process.env["AI_GATEWAY_ENABLED"] = "0";
    try {
      const body = (await h.get(view(TENANT_A), SES_OWNER).expect(200)).body as FullView;
      h.conforms("TenantAiEntitlementsFull", body);
      expect(feature(body, F_ASK)).toMatchObject({ availability: "unavailable", unavailableReason: null, entitled: true });
    } finally {
      process.env["AI_GATEWAY_ENABLED"] = "1";
    }
  });

  it("an unreadable entitlement store is 503 entitlement_unavailable (fail closed)", async () => {
    if (skip()) return;
    await h.env().admin.query(`REVOKE SELECT ON tenant_ai_entitlements FROM app_test`);
    try {
      expectError(await h.get(view(TENANT_A), SES_OWNER), 503, "entitlement_unavailable");
    } finally {
      await h.env().admin.query(`GRANT SELECT ON tenant_ai_entitlements TO app_test`);
    }
  });

  it("before the owner-gated grants are applied, both routes fail closed with 503 and write nothing", async () => {
    if (skip()) return;
    const admin = h.env().admin;
    for (const [table] of AI_TABLE_GRANTS) await admin.query(`REVOKE ALL ON ${table} FROM app_test`);
    try {
      expectError(await h.get(view(TENANT_A), SES_OWNER), 503, "entitlement_unavailable");
      expectError(await put(optOut(TENANT_A, F_ASK), SES_OWNER, { expectedOptOutVersion: 0, optedOut: true, reason: "x" }), 503, "entitlement_unavailable");
    } finally {
      await restrictAiGrants(admin, "app_test");
    }
    expect(await auditCount()).toBe(0);
  });

  it("T8: a member revoked after the session started is refused on the next request", async () => {
    if (skip()) return;
    await h.get(view(TENANT_A), SES_OWNER_REVOKE).expect(200);
    await h.env().admin.query(`UPDATE memberships SET revoked_at = now() WHERE id = $1`, [MEMBERSHIP_OWNER_REVOKE]);
    expectNotFound(await h.get(view(TENANT_A), SES_OWNER_REVOKE));
  });
});

describe("PUT opt-out (D-5)", () => {
  const off = (expected: number, reason = "data governance") => ({ expectedOptOutVersion: expected, optedOut: true, reason });
  const on = (expected: number) => ({ expectedOptOutVersion: expected, optedOut: false, reason: "back on" });

  it("is the same 404 for tenant_admin, store_manager, store_staff, a platform admin and another tenant, writing nothing", async () => {
    if (skip()) return;
    for (const session of [SES_ADMIN, SES_MANAGER, SES_STAFF, SES_PA_ADMIN]) expectNotFound(await put(optOut(TENANT_A, F_ASK), session, off(0)));
    expectNotFound(await put(optOut(TENANT_A, F_ASK), SES_OWNER_B, off(0)));
    expectNotFound(await put(optOut(TENANT_B, F_ASK), SES_OWNER, off(0)));
    expect(await auditCount()).toBe(0);
  });

  it("checks the key, then the body, then the feature (400, 400, 404)", async () => {
    if (skip()) return;
    expectError(await put(optOut(TENANT_A, F_ASK), SES_OWNER, off(0), null), 400, "idempotency_key_required");
    expectError(await put(optOut(TENANT_A, F_ASK), SES_OWNER, { expectedOptOutVersion: 0, optedOut: true }), 400, "validation_error");
    expectError(await put(optOut(TENANT_A, F_ASK), SES_OWNER, { ...off(0), reason: "" }), 400, "validation_error");
    expectError(await put(optOut(TENANT_A, F_ASK), SES_OWNER, { ...off(0), plan: "ai_ops" }), 400, "validation_error");
    expectError(await put(optOut(TENANT_A, "AI.bad"), SES_OWNER, off(0)), 400, "validation_error");
    expectNotFound(await put(optOut(TENANT_A, "ai.not.in.catalogue"), SES_OWNER, off(0)));
  });

  it("the owner opts a feature out: version 1, feature_disabled_tenant, one audit row; a replay is replayed", async () => {
    if (skip()) return;
    const key = nextKey();
    const res = await put(optOut(TENANT_A, F_ASK), SES_OWNER, off(0), key).expect(200);
    h.conforms("TenantAiEntitlementsFull", res.body);
    const body = res.body as FullView;
    expect(body.optOutVersion).toBe(1);
    expect(body.entitlementVersion).toBe(1);
    expect(feature(body, F_ASK)).toMatchObject({ availability: "unavailable", unavailableReason: "feature_disabled_tenant", entitled: true, optOut: { optedOut: true } });
    const audit = await h.env().admin.query(`SELECT actor_user_id, metadata FROM audit_events WHERE tenant_id = $1 AND action = $2`, [TENANT_A, OPT_OUT_CHANGED]);
    expect(audit.rows).toEqual([
      { actor_user_id: USER_OWNER, metadata: { feature_id: F_ASK, old_opted_out: false, new_opted_out: true, reason: "data governance", opt_out_version: 1 } },
    ]);
    const replay = await put(optOut(TENANT_A, F_ASK), SES_OWNER, off(0), key).expect(200);
    expect(replay.headers["idempotent-replayed"]).toBe("true");
    expect(await auditCount()).toBe(1);
  });

  it("the same state again writes no version and no audit row; a stale version is 409", async () => {
    if (skip()) return;
    const same = await put(optOut(TENANT_A, F_ASK), SES_OWNER, off(1, "again")).expect(200);
    expect((same.body as FullView).optOutVersion).toBe(1);
    expect(await auditCount()).toBe(1);
    expectError(await put(optOut(TENANT_A, F_ASK), SES_OWNER, on(0)), 409, "ai_opt_out_changed_concurrently");
  });

  it("an opt-in never exceeds the plan (422 not_entitled); an opt-out of an unentitled feature is accepted", async () => {
    if (skip()) return;
    expectError(await put(optOut(TENANT_A, F_DOCTOR), SES_OWNER, on(1)), 422, "not_entitled");
    const res = await put(optOut(TENANT_A, F_DOCTOR), SES_OWNER, off(1)).expect(200);
    expect(feature(res.body as FullView, F_DOCTOR)).toMatchObject({ entitled: false, unavailableReason: "not_entitled", optOut: { optedOut: true } });
    expect((res.body as FullView).optOutVersion).toBe(2);
  });

  it("opting back in restores the plan feature and never changes the entitlement version", async () => {
    if (skip()) return;
    const res = await put(optOut(TENANT_A, F_ASK), SES_OWNER, on(2)).expect(200);
    const body = res.body as FullView;
    expect(body).toMatchObject({ optOutVersion: 3, entitlementVersion: 1 });
    expect(feature(body, F_ASK)).toMatchObject({ availability: "available", optOut: { optedOut: false } });
    expect(await auditCount()).toBe(3);
  });
});
