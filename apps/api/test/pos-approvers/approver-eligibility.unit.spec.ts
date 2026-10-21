/**
 * RT-788 (RT-114 MA-BC2) — Docker-free units of the approver-eligibility
 * runtime: the request DTO (bounds, case-insensitive duplicates, no scope
 * field), the per-user classifier (first failing V1 predicate names the
 * server-side cause) and the service (one tenant-scoped read, request order,
 * ids echoed as sent, minimum disclosure, cause logged and never returned).
 */
import type { Logger } from "@data-pulse-2/shared";
import type { PoolClient } from "pg";

import {
  APPROVER_ROLE_CODES,
  classifyApprover,
  type ApproverEligibilityReader,
  type ApproverRow,
} from "../../src/pos-approvers/approver-eligibility";
import { ApproverEligibilityService } from "../../src/pos-approvers/approver-eligibility.service";
import { ApproverEligibilityRequestSchema, MAX_APPROVER_USER_IDS } from "../../src/pos-approvers/dto";
import type { DeviceScope } from "../../src/pos-cashier-admissions/device-scope";

const USER_A = "0190f5a2-3b4c-7d8e-9f01-00000000000a";
const USER_B = "0190f5a2-3b4c-7d8e-9f01-00000000000b";
const USER_C = "0190f5a2-3b4c-7d8e-9f01-00000000000c";

const SCOPE: DeviceScope = {
  deviceId: "0190f5a2-3b4c-7d8e-9f01-0000000000d1",
  tenantId: "0190f5a2-3b4c-7d8e-9f01-0000000000e1",
  storeId: "0190f5a2-3b4c-7d8e-9f01-0000000000f1",
};

function ids(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `0190f5a2-3b4c-7d8e-9f01-${String(i).padStart(12, "0")}`);
}

const parse = (body: unknown) => ApproverEligibilityRequestSchema.safeParse(body);

// ===========================================================================
// Request DTO
// ===========================================================================
describe("ApproverEligibilityRequestSchema", () => {
  it("bounds user_ids to 1..50", () => {
    expect(MAX_APPROVER_USER_IDS).toBe(50);
    expect(parse({ user_ids: ids(1) }).success).toBe(true);
    expect(parse({ user_ids: ids(50) }).success).toBe(true);
    expect(parse({ user_ids: [] }).success).toBe(false);
    expect(parse({ user_ids: ids(51) }).success).toBe(false);
  });

  it.each<[string, unknown]>([
    ["a missing user_ids", {}],
    ["a non-array user_ids", { user_ids: USER_A }],
    ["a non-UUID id", { user_ids: ["not-a-uuid"] }],
    ["a urn:uuid: prefixed id", { user_ids: [`urn:uuid:${USER_A}`] }],
    ["an exact duplicate", { user_ids: [USER_A, USER_A] }],
    ["a duplicate in another letter case", { user_ids: [USER_A, USER_A.toUpperCase()] }],
    ["a client-supplied tenant_id", { user_ids: [USER_A], tenant_id: SCOPE.tenantId }],
    ["a client-supplied branch_id", { user_ids: [USER_A], branch_id: SCOPE.storeId }],
    ["an unknown field", { user_ids: [USER_A], action_kinds: ["sale.void"] }],
    ["a null body", null],
  ])("rejects %s", (_label, body) => {
    expect(parse(body).success).toBe(false);
  });

  it("accepts distinct ids in any letter case and keeps their spelling", () => {
    const upper = USER_B.toUpperCase();
    const result = parse({ user_ids: [USER_A, upper] });
    expect(result.success).toBe(true);
    expect(result.success && result.data.user_ids).toEqual([USER_A, upper]);
  });
});

// ===========================================================================
// Classifier
// ===========================================================================
describe("classifyApprover", () => {
  const ELIGIBLE: ApproverRow = {
    user_id: USER_A,
    membership_active: true,
    user_live: true,
    role_eligible: true,
    eligible: true,
  };

  it("the manager-eligible role set is exactly owner, tenant_admin, store_manager", () => {
    expect([...APPROVER_ROLE_CODES].sort()).toEqual(["owner", "store_manager", "tenant_admin"]);
  });

  it("an eligible row is eligible", () => {
    expect(classifyApprover(ELIGIBLE)).toEqual({ eligible: true });
  });

  it.each<[string, ApproverRow | undefined, string]>([
    ["no row (unknown or other tenant)", undefined, "membership_inactive"],
    ["no active membership", { ...ELIGIBLE, membership_active: false, user_live: false, role_eligible: false, eligible: false }, "membership_inactive"],
    ["a deleted user", { ...ELIGIBLE, user_live: false, role_eligible: false, eligible: false }, "user_deleted"],
    ["an ineligible role", { ...ELIGIBLE, role_eligible: false, eligible: false }, "role_ineligible"],
    ["no access to the device's store", { ...ELIGIBLE, eligible: false }, "store_not_accessible"],
  ])("%s → ineligible, cause %s", (_label, row, cause) => {
    expect(classifyApprover(row)).toEqual({ eligible: false, cause });
  });
});

// ===========================================================================
// Service
// ===========================================================================
interface Harness {
  readonly service: ApproverEligibilityService;
  readonly tenants: string[];
  readonly readerCalls: Array<{ scope: DeviceScope; userIds: readonly string[] }>;
  readonly logs: Array<{ obj: Record<string, unknown>; msg: string }>;
}

function harness(rows: ApproverRow[]): Harness {
  const tenants: string[] = [];
  const readerCalls: Harness["readerCalls"] = [];
  const logs: Harness["logs"] = [];
  const reader: ApproverEligibilityReader = {
    async evaluate(_client, scope, userIds) {
      readerCalls.push({ scope, userIds });
      return rows;
    },
  };
  const record = (obj: Record<string, unknown>, msg: string) => logs.push({ obj, msg });
  const logger = { info: record, warn: record, error: record, debug: record } as unknown as Logger;
  const service = new ApproverEligibilityService({
    tx: async (tenantId, work) => {
      tenants.push(tenantId);
      return work({} as PoolClient);
    },
    reader,
    logger,
  });
  return { service, tenants, readerCalls, logs };
}

const row = (userId: string, eligible: boolean): ApproverRow => ({
  user_id: userId,
  membership_active: eligible,
  user_live: eligible,
  role_eligible: eligible,
  eligible,
});

describe("ApproverEligibilityService.check", () => {
  it("evaluates every id in ONE read in the device's tenant, with the device's scope", async () => {
    const h = harness([row(USER_A, true)]);
    await h.service.check(SCOPE, [USER_A, USER_B], "req-1");
    expect(h.tenants).toEqual([SCOPE.tenantId]);
    expect(h.readerCalls).toHaveLength(1);
    expect(h.readerCalls[0]!.scope).toBe(SCOPE);
    expect(h.readerCalls[0]!.userIds).toEqual([USER_A, USER_B]);
  });

  it("answers one result per id, in request order, echoing each id as sent", async () => {
    const upperB = USER_B.toUpperCase();
    // The read returns canonical lowercase ids, in any order.
    const h = harness([row(USER_B, true), row(USER_C, false), row(USER_A, false)]);
    const body = await h.service.check(SCOPE, [USER_C, upperB, USER_A], "req-2");
    expect(body).toEqual({
      results: [
        { user_id: USER_C, eligible: false },
        { user_id: upperB, eligible: true },
        { user_id: USER_A, eligible: false },
      ],
    });
  });

  it("an id the read does not return is ineligible, with no other field", async () => {
    const h = harness([]);
    const body = await h.service.check(SCOPE, [USER_A], "req-3");
    expect(body.results).toEqual([{ user_id: USER_A, eligible: false }]);
  });

  it("never emits action_kinds (1.0.0-draft)", async () => {
    const h = harness([row(USER_A, true), row(USER_B, false)]);
    const body = await h.service.check(SCOPE, [USER_A, USER_B], "req-4");
    for (const result of body.results) expect(Object.keys(result).sort()).toEqual(["eligible", "user_id"]);
  });

  it("logs each ineligible cause server-side under the request id, never a name or token", async () => {
    const h = harness([
      row(USER_A, true),
      { ...row(USER_B, true), role_eligible: false, eligible: false },
    ]);
    await h.service.check(SCOPE, [USER_A, USER_B, USER_C], "req-5");
    expect(h.logs).toHaveLength(1);
    const { obj } = h.logs[0]!;
    expect(obj).toMatchObject({
      request_id: "req-5",
      device_id: SCOPE.deviceId,
      requested: 3,
      eligible: 1,
      ineligible: [
        { user_id: USER_B, cause: "role_ineligible" },
        { user_id: USER_C, cause: "membership_inactive" },
      ],
    });
    expect(JSON.stringify(obj)).not.toMatch(/token|pin|name|email/i);
  });
});
