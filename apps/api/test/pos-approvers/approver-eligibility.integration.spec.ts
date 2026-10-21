/**
 * RT-788 (RT-114 MA-BC2) — `posCheckApproverEligibility` end to end on real
 * PostgreSQL, against the merged contract `pos-approvers.openapi.yaml`
 * (RT-492; every 200 and error body is validated with AJV).
 *
 * MA-BC2 acceptance (RT-114 comment 10764): one test per predicate (user
 * deleted, membership revoked, role ineligible, store removed, cross-tenant),
 * a generic response, tenant isolation. Plus the contract:
 *
 *   - 401 for a missing / unknown / revoked / non-Bearer credential, before
 *     validation;
 *   - 400 for an empty list, more than 50 ids, a duplicate (case-insensitive),
 *     a malformed id or an unknown / scope field;
 *   - eligible = active membership in the device's tenant AND user not
 *     deleted AND role in {owner, tenant_admin, store_manager} AND access to
 *     the device's store (store scoping is enforced in code, not by RLS);
 *   - minimum disclosure: an unknown, cross-tenant or otherwise ineligible id
 *     is `{ user_id, eligible: false }` and nothing else;
 *   - request order, ids echoed as sent, `Cache-Control: no-store`, no
 *     `action_kinds`, no audit row.
 */
import { randomUUID } from "node:crypto";

import {
  DELETED,
  DEV_A1,
  DEV_A2,
  DEV_B1,
  DEV_REVOKED,
  ELIGIBILITY,
  MANAGER,
  MANAGER_A1,
  MANAGER_A2,
  MANAGER_B,
  MEMBERSHIP_DELETED,
  MUTABLE,
  OWNER,
  REVOKED,
  STAFF,
  TENANT_A,
  TENANT_ADMIN,
  auditCountFor,
  checkAs,
  eligibilityOf,
  expectSchema,
  http,
  removeMutableStoreAccess,
  resetState,
  results,
  skipped,
  startHarness,
  stopHarness,
} from "./__support__/approvers-harness";

beforeAll(async () => {
  await startHarness("approver-eligibility.integration.spec");
}, 240_000);

afterAll(async () => {
  await stopHarness();
}, 60_000);

afterEach(async () => {
  await resetState();
});

const VALID_BODY = { user_ids: [MANAGER.id] };

// ===========================================================================
// 401 — device authentication comes first
// ===========================================================================
describe("device authentication (401)", () => {
  it.each([
    ["missing Authorization", undefined],
    ["unknown device token", "Bearer not-a-device-token-zzzzzzzzzzzz"],
    ["revoked device token", `Bearer ${DEV_REVOKED.token}`],
    ["non-Bearer scheme", `Basic ${DEV_A1.token}`],
    ["an operator-identity JWT", "Bearer eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.c2ln"],
  ])("%s → generic 401, even for an invalid body", async (_label, header) => {
    if (skipped()) return;
    for (const body of [VALID_BODY, { user_ids: [] }]) {
      const req = http().post(ELIGIBILITY);
      const res = await (header === undefined ? req : req.set("authorization", header)).send(body);
      expect(res.status).toBe(401);
      expectSchema("Error", res.body);
      expect(res.body.error.code).toBe("unauthorized");
    }
  });

  it("a dashboard cookie does not authenticate this surface", async () => {
    if (skipped()) return;
    const res = await http().post(ELIGIBILITY).set("cookie", "dp2_session=anything").send(VALID_BODY);
    expect(res.status).toBe(401);
  });
});

// ===========================================================================
// 400 — request validation (after auth, before evaluation)
// ===========================================================================
describe("request validation (400)", () => {
  const many = (n: number) => Array.from({ length: n }, () => randomUUID());

  it.each<[string, unknown]>([
    ["an empty user_ids", { user_ids: [] }],
    ["51 ids (bound exceeded)", { user_ids: many(51) }],
    ["a duplicate id", { user_ids: [MANAGER.id, MANAGER.id] }],
    ["a duplicate in another letter case", { user_ids: [MANAGER.id, MANAGER.id.toUpperCase()] }],
    ["a non-UUID id", { user_ids: ["user_manager"] }],
    ["a client-supplied tenant_id", { user_ids: [MANAGER.id], tenant_id: TENANT_A }],
    ["a client-supplied branch_id", { user_ids: [MANAGER.id], branch_id: randomUUID() }],
    ["a missing user_ids", {}],
  ])("%s → 400 validation_error", async (_label, body) => {
    if (skipped()) return;
    const res = await checkAs(DEV_A1, body);
    expect(res.status).toBe(400);
    expectSchema("Error", res.body);
    expect(res.body.error.code).toBe("validation_error");
    expect(JSON.stringify(res.body)).not.toMatch(/eligible/);
  });

  it("50 ids is within the bound", async () => {
    if (skipped()) return;
    const ids = [MANAGER.id, ...many(49)];
    const res = await checkAs(DEV_A1, { user_ids: ids });
    expect(results(res)).toHaveLength(50);
  });
});

// ===========================================================================
// 200 — eligible managers
// ===========================================================================
describe("eligible approvers", () => {
  it.each([
    ["owner", OWNER],
    ["tenant_admin", TENANT_ADMIN],
    ["store_manager (all stores)", MANAGER],
    ["store_manager with specific access to the device's store", MANAGER_A1],
  ])("%s is eligible on a device of that store", async (_label, u) => {
    if (skipped()) return;
    expect(await eligibilityOf(DEV_A1, [u.id])).toEqual([true]);
  });

  it("a store-specific manager is eligible on their store's device", async () => {
    if (skipped()) return;
    expect(await eligibilityOf(DEV_A2, [MANAGER_A2.id])).toEqual([true]);
  });
});

// ===========================================================================
// 200 — every ineligible cause, indistinguishable
// ===========================================================================
describe("ineligible approvers (minimum disclosure)", () => {
  const UNKNOWN = randomUUID();
  const cases: Array<[string, string]> = [
    ["an unknown id", UNKNOWN],
    ["a user of another tenant (cross-tenant)", MANAGER_B.id],
    ["a deleted user", DELETED.id],
    ["a revoked membership", REVOKED.id],
    ["a soft-deleted membership", MEMBERSHIP_DELETED.id],
    ["an ineligible role (store_staff)", STAFF.id],
    ["a manager without access to the device's store", MANAGER_A2.id],
  ];

  it.each(cases)("%s → eligible: false", async (_label, userId) => {
    if (skipped()) return;
    const res = await checkAs(DEV_A1, { user_ids: [userId] });
    expect(results(res)).toEqual([{ user_id: userId, eligible: false }]);
  });

  it("store removed: a manager loses eligibility when the store access row is deleted", async () => {
    if (skipped()) return;
    expect(await eligibilityOf(DEV_A1, [MUTABLE.id])).toEqual([true]);
    await removeMutableStoreAccess();
    expect(await eligibilityOf(DEV_A1, [MUTABLE.id])).toEqual([false]);
  });

  it("every ineligible result is identical apart from user_id (no oracle)", async () => {
    if (skipped()) return;
    const res = await checkAs(DEV_A1, { user_ids: cases.map(([, id]) => id) });
    const shapes = results(res).map((r) => JSON.stringify({ ...r, user_id: "x" }));
    expect(new Set(shapes)).toEqual(new Set([JSON.stringify({ user_id: "x", eligible: false })]));
  });

  it("no result carries action_kinds or any other field", async () => {
    if (skipped()) return;
    const res = await checkAs(DEV_A1, { user_ids: [MANAGER.id, STAFF.id] });
    for (const r of results(res)) expect(Object.keys(r).sort()).toEqual(["eligible", "user_id"]);
  });
});

// ===========================================================================
// Tenant isolation and store scoping (scope from the device row only)
// ===========================================================================
describe("tenant isolation and store scoping", () => {
  it("a tenant-B device sees every tenant-A manager as ineligible", async () => {
    if (skipped()) return;
    const ids = [OWNER.id, TENANT_ADMIN.id, MANAGER.id, MANAGER_A1.id];
    expect(await eligibilityOf(DEV_B1, ids)).toEqual([false, false, false, false]);
  });

  it("a tenant-B device sees its own manager as eligible", async () => {
    if (skipped()) return;
    expect(await eligibilityOf(DEV_B1, [MANAGER_B.id])).toEqual([true]);
  });

  it("the same managers answer per the calling device's store", async () => {
    if (skipped()) return;
    const ids = [MANAGER_A1.id, MANAGER_A2.id, MANAGER.id];
    expect(await eligibilityOf(DEV_A1, ids)).toEqual([true, false, true]);
    expect(await eligibilityOf(DEV_A2, ids)).toEqual([false, true, true]);
  });
});

// ===========================================================================
// Response shape
// ===========================================================================
describe("response", () => {
  it("one result per id, in request order, each id echoed exactly as sent", async () => {
    if (skipped()) return;
    const upperOwner = OWNER.id.toUpperCase();
    const ids = [STAFF.id, upperOwner, MANAGER_B.id, MANAGER.id];
    const res = await checkAs(DEV_A1, { user_ids: ids });
    expect(results(res)).toEqual([
      { user_id: STAFF.id, eligible: false },
      { user_id: upperOwner, eligible: true },
      { user_id: MANAGER_B.id, eligible: false },
      { user_id: MANAGER.id, eligible: true },
    ]);
  });

  it("is read-only: no audit event is recorded", async () => {
    if (skipped()) return;
    const requestId = randomUUID();
    const res = await checkAs(DEV_A1, { user_ids: [MANAGER.id, STAFF.id] }, requestId);
    expect(res.status).toBe(200);
    expect(await auditCountFor(requestId)).toBe(0);
  });
});
