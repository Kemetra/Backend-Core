/**
 * RT-387 — the shift variance policy over HTTP against real Postgres
 * (Testcontainers, every migration incl. 0050, the NOBYPASSRLS `app_test`
 * pool), the real module graph (`TenantContextGuard`, `RolesGuard`,
 * `MembershipRepository`, `PosDeviceAuthGuard`) and the real
 * `IdempotencyInterceptor` over a fake Redis. Only cookie authentication is
 * faked: a header names the session (the RT-192 / RT-383 pattern).
 *
 * `cash-variance-policy.openapi.yaml` 1.0.0-draft, every operation:
 *   - the device read: resolution, ETag / If-None-Match → 304, strict query;
 *   - tenant default: read, publish (Apply Now), revisions (keyset);
 *   - store override: read, set / clear, revisions (keyset);
 *   - the documented check order and refusal codes (400 / 403 / 404 / 409 /
 *     422), the owner rule for a permanent override, stricter-only at publish
 *     and stricter-wins at resolution;
 *   - RBAC and isolation: store_manager reads its own stores only and never
 *     configures; store_staff, another tenant, a store outside the scope, a
 *     deleted or absent store are the same non-disclosing 404;
 *   - one `cash_variance_policy.changed` audit row per revision, none on a
 *     refusal; idempotent publishes;
 *   - every 2xx and error body validates against the contract schemas.
 *
 * Docker policy: HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import "reflect-metadata";

import type request from "supertest";

import { CashVariancePolicyModule } from "../../src/cash-variance-policy/cash-variance-policy.module";
import { idempotencyProviders } from "../_helpers/idempotency-providers";
import { scopedHttpHarness } from "../_helpers/scoped-http-harness";
import { STORE_A_X, STORE_A_Y, STORE_B_X, TENANT_A, TENANT_B } from "../catalog/__support__/isolation-harness";
import {
  NON_EXISTENT,
  S_DELETED,
  SES_ADMIN_SPEC,
  SES_OWNER_ALL,
  SES_OWNER_SPEC,
} from "../catalog/erpnext-reconciliation/__support__/read-store-scope";
import {
  auditRows,
  countRevisions,
  SES_ADMIN_ALL,
  SES_MANAGER,
  SES_OWNER_B,
  SES_STAFF,
  seedPolicyFixture,
  TOKEN_X,
  TOKEN_Y,
  USER_ADMIN_ALL,
  USER_OWNER_ALL,
} from "./__support__/policy-fixture";

const tenantPath = (tenantId: string): string => `/api/v1/tenants/${tenantId}/cash-variance-policy`;
const tenantRevisions = (tenantId: string): string => `${tenantPath(tenantId)}/revisions`;
const storePath = (storeId: string): string => `/api/v1/stores/${storeId}/cash-variance-policy`;
const storeRevisions = (storeId: string): string => `${storePath(storeId)}/revisions`;
const DEVICE_READ = "/api/pos/v1/store/cash-variance-policy";
const NOT_FOUND = { code: "not_found", message: "Not Found" };
const CHANGED = "cash_variance_policy.changed";

const h = scopedHttpHarness({
  label: "RT-387 cash-variance-policy",
  contractId: "cash-variance-policy.openapi",
  module: CashVariancePolicyModule,
  seed: seedPolicyFixture,
  providers: idempotencyProviders(),
});
const skip = (): boolean => h.skipped();

let keySeq = 0;
const nextKey = (): string => `rt387-key-${String((keySeq += 1)).padStart(8, "0")}`;

function publish(path: string, session: string | null, body: object, key: string | null = nextKey()): request.Test {
  const req = h.post(path, session, body);
  return key === null ? req : req.set("Idempotency-Key", key);
}

function deviceRead(token: string, headers: Record<string, string> = {}): request.Test {
  let req = h.get(DEVICE_READ, null).set("Authorization", `Bearer ${token}`);
  for (const [k, v] of Object.entries(headers)) req = req.set(k, v);
  return req;
}

function expectError(res: request.Response, status: number, code: string): void {
  expect({ status: res.status, code: (res.body as { error?: { code?: string } }).error?.code }).toEqual({ status, code });
  h.conforms("Error", res.body);
}

function expectNotFound(res: request.Response): void {
  expect(res.status).toBe(404);
  expect((res.body as { error?: unknown }).error).toMatchObject(NOT_FOUND);
}

const limit = (limitAmount: string): object => ({ mode: "limit", limitAmount, currencyCode: "EGP" });
const inDays = (days: number): string => new Date(Date.now() + days * 86_400_000).toISOString();

let tenantRev1 = "";
let tenantRev2 = "";
let storeXLatest = "";

describe("device read before any revision", () => {
  it("is the System default with a strong ETag and no-cache", async () => {
    if (skip()) return;
    const res = await deviceRead(TOKEN_X).expect(200);
    h.conforms("DeviceCashVariancePolicy", res.body);
    expect(res.body).toMatchObject({ policySource: "system", policyRevisionId: null, policyValue: { mode: "none" } });
    expect(res.headers["etag"]).toMatch(/^"[0-9a-f]{64}"$/);
    expect(res.headers["cache-control"]).toBe("no-cache, private");
  });

  it("answers 304 with no body for the same If-None-Match", async () => {
    if (skip()) return;
    const first = await deviceRead(TOKEN_X).expect(200);
    const res = await deviceRead(TOKEN_X, { "If-None-Match": first.headers["etag"] as string }).expect(304);
    expect(res.text).toBe("");
    expect(res.headers["etag"]).toBe(first.headers["etag"]);
    expect(res.headers["cache-control"]).toBe("no-cache, private");
  });

  it("refuses a malformed If-None-Match and any query key with 400", async () => {
    if (skip()) return;
    expectError(await deviceRead(TOKEN_X, { "If-None-Match": "W/\"abc\"" }), 400, "validation_error");
    expectError(await h.get(DEVICE_READ, null, { store_id: STORE_A_Y }).set("Authorization", `Bearer ${TOKEN_X}`), 400, "validation_error");
  });

  it("is 401 without a device token, and for a dashboard session", async () => {
    if (skip()) return;
    expect((await h.get(DEVICE_READ, null)).status).toBe(401);
    expect((await h.get(DEVICE_READ, SES_OWNER_ALL)).status).toBe(401);
  });
});

describe("tenant default", () => {
  it("reads the System default before any publish", async () => {
    if (skip()) return;
    const res = await h.get(tenantPath(TENANT_A), SES_OWNER_ALL).expect(200);
    h.conforms("TenantCashVariancePolicy", res.body);
    expect(res.body).toEqual({
      tenantDefault: { policySource: "system", policyRevisionId: null, policyValue: { mode: "none" } },
      latestRevision: null,
      latestRevisionId: null,
    });
  });

  it("is the non-disclosing 404 for another tenant's id, store_manager, store_staff and another tenant's owner", async () => {
    if (skip()) return;
    expectNotFound(await h.get(tenantPath(TENANT_B), SES_OWNER_ALL));
    expectNotFound(await h.get(tenantPath(TENANT_A), SES_MANAGER));
    expectNotFound(await h.get(tenantPath(TENANT_A), SES_STAFF));
    expectNotFound(await h.get(tenantPath(TENANT_A), SES_OWNER_B));
    expectNotFound(await publish(tenantRevisions(TENANT_A), SES_MANAGER, { expectedRevisionId: null, policyValue: limit("1.00"), reason: "x" }));
    expectNotFound(await h.get(tenantRevisions(TENANT_A), SES_MANAGER));
    expect((await h.get(tenantPath(TENANT_A), null)).status).toBe(401);
  });

  it("refuses a malformed tenant id with 400", async () => {
    if (skip()) return;
    expectError(await h.get(tenantPath("not-a-uuid"), SES_OWNER_ALL), 400, "validation_error");
  });

  it.each([
    ["a limit without a currency", { expectedRevisionId: null, policyValue: { mode: "limit", limitAmount: "1.00" }, reason: "r" }],
    ["none with an amount", { expectedRevisionId: null, policyValue: { mode: "none", limitAmount: "1" }, reason: "r" }],
    ["an unknown key", { expectedRevisionId: null, policyValue: { mode: "none" }, reason: "r", tenantId: TENANT_A }],
    ["an empty reason", { expectedRevisionId: null, policyValue: { mode: "none" }, reason: "" }],
    ["a NUL in the reason", { expectedRevisionId: null, policyValue: { mode: "none" }, reason: "a\u0000b" }],
    ["a lone surrogate in the reason", { expectedRevisionId: null, policyValue: { mode: "none" }, reason: "a\ud800b" }],
    ["a 201-character reason", { expectedRevisionId: null, policyValue: { mode: "none" }, reason: "x".repeat(201) }],
    ["more digits than EGP's minor unit", { expectedRevisionId: null, policyValue: limit("1.005"), reason: "r" }],
    ["a negative limit", { expectedRevisionId: null, policyValue: limit("-1.00"), reason: "r" }],
    ["no expectedRevisionId", { policyValue: { mode: "none" }, reason: "r" }],
  ])("refuses %s with 400 and writes nothing", async (_label, body) => {
    if (skip()) return;
    expectError(await publish(tenantRevisions(TENANT_A), SES_OWNER_ALL, body), 400, "validation_error");
    expect(await countRevisions(h.env().admin)).toBe(0);
  });

  it("refuses a missing Idempotency-Key with 400", async () => {
    if (skip()) return;
    const res = await publish(tenantRevisions(TENANT_A), SES_OWNER_ALL, { expectedRevisionId: null, policyValue: { mode: "none" }, reason: "r" }, null);
    expect(res.status).toBe(400);
    expect(await countRevisions(h.env().admin)).toBe(0);
  });

  it("refuses a limit in a currency other than EGP with 422 policy_currency_unsupported", async () => {
    if (skip()) return;
    const body = { expectedRevisionId: null, policyValue: { mode: "limit", limitAmount: "5.00", currencyCode: "USD" }, reason: "r" };
    expectError(await publish(tenantRevisions(TENANT_A), SES_OWNER_ALL, body), 422, "policy_currency_unsupported");
    expect(await countRevisions(h.env().admin)).toBe(0);
  });

  it("publishes a limit (201), writes one audit row, and the device read follows", async () => {
    if (skip()) return;
    const before = await deviceRead(TOKEN_X).expect(200);
    const key = nextKey();
    const body = { expectedRevisionId: null, policyValue: limit("50.00"), reason: "Pilot default" };
    const res = await publish(tenantRevisions(TENANT_A), SES_ADMIN_ALL, body, key).expect(201);
    h.conforms("TenantCashVariancePolicy", res.body);
    tenantRev1 = res.body.latestRevisionId as string;
    expect(res.body.tenantDefault).toEqual({ policySource: "tenant", policyRevisionId: tenantRev1, policyValue: limit("50.00") });
    expect(res.body.latestRevision).toMatchObject({
      revisionId: tenantRev1,
      scope: "tenant",
      storeId: null,
      kind: "set",
      reason: "Pilot default",
      effectiveUntil: null,
      permanent: false,
      approvedByUserId: null,
      supersedesRevisionId: null,
      state: "current",
      createdByUserId: USER_ADMIN_ALL,
    });
    expect(res.body.latestRevision.effectiveFrom).toBe(res.body.latestRevision.createdAt);

    const audit = await auditRows(h.env().admin, CHANGED);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor_user_id: USER_ADMIN_ALL, tenant_id: TENANT_A, store_id: null, target_id: tenantRev1 });
    expect(audit[0]!.metadata).toMatchObject({
      scope: "tenant",
      revision_id: tenantRev1,
      old_value: { mode: "none" },
      new_value: limit("50.00"),
      reason: "Pilot default",
      effective_until: null,
      approved_by_user_id: null,
    });

    const replay = await publish(tenantRevisions(TENANT_A), SES_ADMIN_ALL, body, key).expect(201);
    expect(replay.headers["idempotent-replayed"]).toBe("true");
    expect(await countRevisions(h.env().admin)).toBe(1);

    const after = await deviceRead(TOKEN_X).expect(200);
    expect(after.body).toMatchObject({ policySource: "tenant", policyRevisionId: tenantRev1, policyValue: limit("50.00") });
    expect(after.headers["etag"]).not.toBe(before.headers["etag"]);
    await deviceRead(TOKEN_X, { "If-None-Match": before.headers["etag"] as string }).expect(200);
  });

  it("refuses a stale expectedRevisionId with 409 and writes nothing", async () => {
    if (skip()) return;
    const body = { expectedRevisionId: null, policyValue: limit("40.00"), reason: "stale" };
    expectError(await publish(tenantRevisions(TENANT_A), SES_OWNER_ALL, body), 409, "cash_variance_policy_changed_concurrently");
    expect(await countRevisions(h.env().admin)).toBe(1);
    expect(await auditRows(h.env().admin, CHANGED)).toHaveLength(1);
  });

  it("reads the latest revision and its concurrency token", async () => {
    if (skip()) return;
    const res = await h.get(tenantPath(TENANT_A), SES_ADMIN_SPEC).expect(200);
    h.conforms("TenantCashVariancePolicy", res.body);
    expect(res.body.latestRevisionId).toBe(tenantRev1);
  });
});

describe("store override", () => {
  it("reads the inherited tenant level (owner, tenant_admin and its own store_manager)", async () => {
    if (skip()) return;
    for (const session of [SES_OWNER_ALL, SES_ADMIN_SPEC, SES_MANAGER]) {
      const res = await h.get(storePath(STORE_A_X), session).expect(200);
      h.conforms("StoreCashVariancePolicy", res.body);
      expect(res.body).toEqual({
        storeId: STORE_A_X,
        effective: { policySource: "tenant", policyRevisionId: tenantRev1, policyValue: limit("50.00") },
        tenantDefault: { policySource: "tenant", policyRevisionId: tenantRev1, policyValue: limit("50.00") },
        activeOverride: null,
        latestRevisionId: null,
        permanentOverrideHorizonDays: 90,
      });
    }
  });

  it("is the non-disclosing 404 outside the caller's scope, for another tenant, a deleted or absent store", async () => {
    if (skip()) return;
    expectNotFound(await h.get(storePath(STORE_A_Y), SES_MANAGER));
    expectNotFound(await h.get(storePath(STORE_A_Y), SES_OWNER_SPEC));
    expectNotFound(await h.get(storePath(STORE_B_X), SES_OWNER_ALL));
    expectNotFound(await h.get(storePath(S_DELETED), SES_OWNER_SPEC));
    expectNotFound(await h.get(storePath(NON_EXISTENT), SES_OWNER_ALL));
    expectNotFound(await h.get(storePath(STORE_A_X), SES_STAFF));
    expectNotFound(await h.get(storePath(STORE_A_X), SES_OWNER_B));
    expectNotFound(await h.get(storeRevisions(STORE_A_X), SES_MANAGER));
    expectNotFound(await publish(storeRevisions(STORE_A_X), SES_MANAGER, { expectedRevisionId: null, kind: "set", policyValue: limit("1.00"), reason: "r", effectiveUntil: inDays(1) }));
    expectNotFound(await publish(storeRevisions(STORE_A_Y), SES_ADMIN_SPEC, { expectedRevisionId: null, kind: "set", policyValue: limit("1.00"), reason: "r", effectiveUntil: inDays(1) }));
    expect(await countRevisions(h.env().admin, STORE_A_X)).toBe(0);
  });

  it.each([
    ["none under a tenant limit", { mode: "none" }],
    ["a higher limit", limit("60.00")],
  ])("refuses %s with 422 override_looser_than_tenant", async (_label, policyValue) => {
    if (skip()) return;
    const body = { expectedRevisionId: null, kind: "set", policyValue, reason: "r", effectiveUntil: inDays(1) };
    expectError(await publish(storeRevisions(STORE_A_X), SES_OWNER_ALL, body), 422, "override_looser_than_tenant");
  });

  it("refuses an expiry not after the server time with 422 override_expiry_invalid", async () => {
    if (skip()) return;
    const body = { expectedRevisionId: null, kind: "set", policyValue: limit("10.00"), reason: "r", effectiveUntil: inDays(-1) };
    expectError(await publish(storeRevisions(STORE_A_X), SES_OWNER_ALL, body), 422, "override_expiry_invalid");
  });

  it("refuses a clear with no active override with 422 override_not_active", async () => {
    if (skip()) return;
    expectError(await publish(storeRevisions(STORE_A_X), SES_OWNER_ALL, { expectedRevisionId: null, kind: "clear", reason: "r" }), 422, "override_not_active");
  });

  it("refuses a clear carrying a value with 400", async () => {
    if (skip()) return;
    const body = { expectedRevisionId: null, kind: "clear", reason: "r", policyValue: limit("1.00") };
    expectError(await publish(storeRevisions(STORE_A_X), SES_OWNER_ALL, body), 400, "validation_error");
  });

  it.each([
    ["no expiry", undefined],
    ["an expiry beyond 90 days", 91],
  ])("refuses a permanent override (%s) from a tenant_admin with 403 owner_approval_required", async (_label, days) => {
    if (skip()) return;
    const body = {
      expectedRevisionId: null,
      kind: "set",
      policyValue: limit("10.00"),
      reason: "r",
      ...(days !== undefined ? { effectiveUntil: inDays(days) } : {}),
    };
    expectError(await publish(storeRevisions(STORE_A_X), SES_ADMIN_SPEC, body), 403, "owner_approval_required");
    expect(await countRevisions(h.env().admin, STORE_A_X)).toBe(0);
  });

  it("publishes an expiring override from a tenant_admin (201) and the store's terminals get it", async () => {
    if (skip()) return;
    const until = inDays(89);
    const body = { expectedRevisionId: null, kind: "set", policyValue: limit("20.00"), reason: "Renovation", effectiveUntil: until };
    const res = await publish(storeRevisions(STORE_A_X), SES_ADMIN_SPEC, body).expect(201);
    h.conforms("StoreCashVariancePolicy", res.body);
    storeXLatest = res.body.latestRevisionId as string;
    expect(res.body.effective).toEqual({ policySource: "store", policyRevisionId: storeXLatest, policyValue: limit("20.00") });
    expect(res.body.activeOverride).toMatchObject({ revisionId: storeXLatest, permanent: false, approvedByUserId: null, reason: "Renovation" });
    expect(new Date(res.body.activeOverride.effectiveUntil as string).toISOString()).toBe(until);

    expect((await deviceRead(TOKEN_X).expect(200)).body).toMatchObject({ policySource: "store", policyRevisionId: storeXLatest });
    expect((await deviceRead(TOKEN_Y).expect(200)).body).toMatchObject({ policySource: "tenant", policyRevisionId: tenantRev1 });

    const audit = (await auditRows(h.env().admin, CHANGED)).at(-1)!;
    expect(audit).toMatchObject({ store_id: STORE_A_X, target_id: storeXLatest });
    expect(audit.metadata).toMatchObject({ scope: "store", kind: "set", old_value: null, new_value: limit("20.00") });
  });

  it("accepts an override equal to the tenant level", async () => {
    if (skip()) return;
    const body = { expectedRevisionId: storeXLatest, kind: "set", policyValue: limit("50"), reason: "equal", effectiveUntil: inDays(2) };
    const res = await publish(storeRevisions(STORE_A_X), SES_OWNER_ALL, body).expect(201);
    storeXLatest = res.body.latestRevisionId as string;
    expect(res.body.effective.policySource).toBe("store");
  });

  it("publishes a permanent override from an owner, naming the owner as approver", async () => {
    if (skip()) return;
    const body = { expectedRevisionId: storeXLatest, kind: "set", policyValue: limit("30.00"), reason: "Formal store policy" };
    const res = await publish(storeRevisions(STORE_A_X), SES_OWNER_ALL, body).expect(201);
    h.conforms("StoreCashVariancePolicy", res.body);
    storeXLatest = res.body.latestRevisionId as string;
    expect(res.body.activeOverride).toMatchObject({
      revisionId: storeXLatest,
      effectiveUntil: null,
      permanent: true,
      approvedByUserId: USER_OWNER_ALL,
    });
  });

  it("refuses a stale expectedRevisionId with 409", async () => {
    if (skip()) return;
    const body = { expectedRevisionId: null, kind: "clear", reason: "stale" };
    expectError(await publish(storeRevisions(STORE_A_X), SES_OWNER_ALL, body), 409, "cash_variance_policy_changed_concurrently");
  });

  it("lets a tenant default tightened below the override win the store's resolution", async () => {
    if (skip()) return;
    const res = await publish(tenantRevisions(TENANT_A), SES_OWNER_ALL, { expectedRevisionId: tenantRev1, policyValue: limit("10.00"), reason: "tighten" }).expect(201);
    tenantRev2 = res.body.latestRevisionId as string;
    const store = await h.get(storePath(STORE_A_X), SES_OWNER_ALL).expect(200);
    expect(store.body.effective).toEqual({ policySource: "tenant", policyRevisionId: tenantRev2, policyValue: limit("10.00") });
    expect(store.body.activeOverride.revisionId).toBe(storeXLatest);
    expect((await deviceRead(TOKEN_X).expect(200)).body.policyRevisionId).toBe(tenantRev2);
  });

  it("clears the override (tenant_admin may clear a permanent one) and the store inherits again", async () => {
    if (skip()) return;
    const res = await publish(storeRevisions(STORE_A_X), SES_ADMIN_SPEC, { expectedRevisionId: storeXLatest, kind: "clear", reason: "Back to default" }).expect(201);
    h.conforms("StoreCashVariancePolicy", res.body);
    expect(res.body.activeOverride).toBeNull();
    expect(res.body.effective.policySource).toBe("tenant");
    storeXLatest = res.body.latestRevisionId as string;
  });
});

describe("revision lists", () => {
  it("lists tenant revisions newest first with derived states, and walks with page_size 1", async () => {
    if (skip()) return;
    const res = await h.get(tenantRevisions(TENANT_A), SES_OWNER_ALL).expect(200);
    h.conforms("TenantCashVariancePolicyRevisionPage", res.body);
    expect(res.body.items.map((i: { revisionId: string; state: string }) => [i.revisionId, i.state])).toEqual([
      [tenantRev2, "current"],
      [tenantRev1, "superseded"],
    ]);
    expect(res.body.nextCursor).toBeNull();
    const first = await h.get(tenantRevisions(TENANT_A), SES_OWNER_ALL, { page_size: 1 }).expect(200);
    expect(first.body.items[0].revisionId).toBe(tenantRev2);
    const second = await h.get(tenantRevisions(TENANT_A), SES_OWNER_ALL, { page_size: 1, cursor: first.body.nextCursor }).expect(200);
    h.conforms("TenantCashVariancePolicyRevisionPage", second.body);
    expect(second.body.items.map((i: { revisionId: string }) => i.revisionId)).toEqual([tenantRev1]);
    expect(second.body.nextCursor).toBeNull();
  });

  it("lists the store's revisions only, newest first, the clear included", async () => {
    if (skip()) return;
    const res = await h.get(storeRevisions(STORE_A_X), SES_ADMIN_SPEC).expect(200);
    h.conforms("StoreCashVariancePolicyRevisionPage", res.body);
    const items = res.body.items as Array<{ kind: string; state: string; storeId: string; permanent: boolean }>;
    expect(items.map((i) => [i.kind, i.state])).toEqual([
      ["clear", "current"],
      ["set", "superseded"],
      ["set", "superseded"],
      ["set", "superseded"],
    ]);
    expect(items.every((i) => i.storeId === STORE_A_X)).toBe(true);
    expect(items[1]!.permanent).toBe(true);
    expect((await h.get(storeRevisions(STORE_A_Y), SES_OWNER_ALL).expect(200)).body).toEqual({ items: [], nextCursor: null });
  });

  it("refuses a foreign or malformed cursor and a bad page_size with 400", async () => {
    if (skip()) return;
    const tenantPage = await h.get(tenantRevisions(TENANT_A), SES_OWNER_ALL, { page_size: 1 }).expect(200);
    expectError(await h.get(storeRevisions(STORE_A_X), SES_OWNER_ALL, { cursor: tenantPage.body.nextCursor }), 400, "validation_error");
    expectError(await h.get(tenantRevisions(TENANT_A), SES_OWNER_ALL, { cursor: "bm90LWEtY3Vyc29y" }), 400, "validation_error");
    expectError(await h.get(tenantRevisions(TENANT_A), SES_OWNER_ALL, { page_size: 0 }), 400, "validation_error");
    expectError(await h.get(tenantRevisions(TENANT_A), SES_OWNER_ALL, { page_size: 101 }), 400, "validation_error");
    expectError(await h.get(tenantRevisions(TENANT_A), SES_OWNER_ALL, { tenant_id: TENANT_B }), 400, "validation_error");
  });
});

describe("audit", () => {
  it("wrote exactly one changed row per revision", async () => {
    if (skip()) return;
    expect(await auditRows(h.env().admin, CHANGED)).toHaveLength(await countRevisions(h.env().admin));
  });
});

describe("RLS fails closed", () => {
  it("shows no revision to the app role without a tenant, and refuses an insert", async () => {
    if (skip()) return;
    const app = h.env().app;
    const client = await app.connect();
    try {
      const seen = await client.query(`SELECT count(*)::int AS n FROM cash_variance_policy_revisions`);
      expect(seen.rows[0].n).toBe(0);
      await client.query("BEGIN");
      await client.query(`SELECT set_config('app.current_tenant', $1, true)`, [TENANT_B]);
      const crossTenant = await client.query(`SELECT count(*)::int AS n FROM cash_variance_policy_revisions`);
      expect(crossTenant.rows[0].n).toBe(0);
      await expect(
        client.query(
          `INSERT INTO cash_variance_policy_revisions (id, tenant_id, scope, kind, mode, reason, permanent, created_by_user_id)
           VALUES (gen_random_uuid(), $1, 'tenant', 'set', 'none', 'x', false, $2)`,
          [TENANT_A, USER_OWNER_ALL],
        ),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  });
});

describe("store override expiry (D-9 override_expired, exactly once)", () => {
  const EXPIRED = "0a000000-0000-7000-8000-0000038706a1";
  const EXPIRED_ACTION = "cash_variance_policy.override_expired";

  it("stops applying at effectiveUntil with no write, and audits the expiry exactly once", async () => {
    if (skip()) return;
    const admin = h.env().admin;
    // An expiring override published two days ago on STORE_A_Y that expired a day ago.
    await admin.query(
      `INSERT INTO cash_variance_policy_revisions
         (id, tenant_id, scope, store_id, kind, mode, limit_amount, currency_code, reason,
          effective_until, permanent, created_by_user_id, created_at, effective_from)
       VALUES ($1, $2, 'store', $3, 'set', 'limit', 1, 'EGP', 'Stocktake week',
               now() - interval '1 day', false, $4, now() - interval '2 days', now() - interval '2 days')`,
      [EXPIRED, TENANT_A, STORE_A_Y, USER_OWNER_ALL],
    );

    // N concurrent resolves of the store, then more sequential ones: one row.
    const concurrent = await Promise.all(Array.from({ length: 6 }, () => deviceRead(TOKEN_Y)));
    for (const device of concurrent) {
      expect(device.status).toBe(200);
      expect(device.body).toMatchObject({ policySource: "tenant", policyRevisionId: tenantRev2 });
    }
    const store = await h.get(storePath(STORE_A_Y), SES_OWNER_ALL).expect(200);
    h.conforms("StoreCashVariancePolicy", store.body);
    expect(store.body).toMatchObject({ activeOverride: null, latestRevisionId: EXPIRED, effective: { policySource: "tenant" } });
    const list = await h.get(storeRevisions(STORE_A_Y), SES_OWNER_ALL).expect(200);
    h.conforms("StoreCashVariancePolicyRevisionPage", list.body);
    expect(list.body.items.map((i: { revisionId: string; state: string }) => [i.revisionId, i.state])).toEqual([[EXPIRED, "expired"]]);
    await deviceRead(TOKEN_Y).expect(200);

    const audit = await auditRows(admin, EXPIRED_ACTION);
    expect(audit).toHaveLength(1);
    // A store whose override is live, then cleared (STORE_A_X), never emits one.
    expect(audit.filter((row) => row.store_id === STORE_A_X)).toEqual([]);
    expect(audit[0]).toMatchObject({ actor_user_id: null, tenant_id: TENANT_A, store_id: STORE_A_Y, target_id: EXPIRED });
    // The policy effective from the expiry instant: the tenant level then (no
    // tenant revision existed yet), not the tenant default in force when the
    // row was written (tenantRev2): the content does not depend on when.
    expect(audit[0]!.metadata).toMatchObject({
      expired_revision_id: EXPIRED,
      effective_policy_source: "system",
      effective_policy_revision_id: null,
    });
  });

  it("a new override can replace an expired one (the expired revision is the expected one)", async () => {
    if (skip()) return;
    const body = { expectedRevisionId: EXPIRED, kind: "set", policyValue: limit("5.00"), reason: "Again", effectiveUntil: inDays(3) };
    const res = await publish(storeRevisions(STORE_A_Y), SES_OWNER_ALL, body).expect(201);
    expect(res.body.activeOverride.policyValue).toEqual(limit("5.00"));
    expect(await auditRows(h.env().admin, EXPIRED_ACTION)).toHaveLength(1);
  });
});
