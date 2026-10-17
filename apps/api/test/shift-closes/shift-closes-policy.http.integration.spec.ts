/**
 * RT-387 — the shift variance policy on the admin shift-close reads
 * (`shift-closes.openapi.yaml` 1.1.0-draft) over HTTP against real Postgres
 * and the real module graph (the RT-383 pattern, cookie auth faked by header).
 *
 * What this proves:
 *   - every close carries `frozenPolicy` (null without one), the derived
 *     `approvalRequiredByPolicy` / `approvalMissing` (here derived by the 0050
 *     close guard from the frozen policy) and the persisted `approverCheck`
 *     (the verdict row, else not_applicable / the check_unavailable
 *     placeholder), on the list and on the detail;
 *   - the `approval_required`, `approval_missing` and `approver_check` filters,
 *     and their 400 on an unknown value;
 *   - every body validates against the contract.
 *
 * Docker policy: HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import "reflect-metadata";

import { ShiftClosesModule } from "../../src/shift-closes/shift-closes.module";
import type { RecordedFrozenPolicy } from "../../src/pos-shifts/shift-frozen-policy";
import { scopedHttpHarness } from "../_helpers/scoped-http-harness";
import { SES_OWNER_ALL } from "../catalog/erpnext-reconciliation/__support__/read-store-scope";
import { APPROVER_A, SCOPE_AX, seedClose, seedShiftCloseFixture } from "./__support__/shift-close-fixture";

const LIST = "/api/v1/shift-closes";
const id = (n: string): string => `0a000000-0000-7000-8000-00000387${n}`;
const P1 = id("0aa1");
const P2 = id("0aa2");
const P3 = id("0aa3");
const P4 = id("0aa4");
const P5 = id("0aa5");
const WINDOW = { closed_from: "2026-11-01T00:00:00Z", page_size: 50 };

const limit = (limitAmount: string): RecordedFrozenPolicy => ({
  policySource: "tenant",
  policyRevisionId: id("0ab1"),
  policyValue: { mode: "limit", limitAmount, currencyCode: "EGP" },
  policyFlags: ["policy_revision_unknown"],
});
const NONE: RecordedFrozenPolicy = { policySource: "system", policyRevisionId: null, policyValue: { mode: "none" }, policyFlags: [] };

/** opening 500, sales 1000 → expected 1500; counted 1480 → variance −20. */
const MINUS_20 = { opening: 50_000, sales: 100_000, refunds: 0, payIn: 0, payOut: 0, counted: 148_000 };

const h = scopedHttpHarness({
  label: "RT-387 shift-closes policy",
  contractId: "shift-closes.openapi",
  module: ShiftClosesModule,
  seed: async (env) => {
    await seedShiftCloseFixture(env);
    const at = (hour: number): string => `2026-11-01T${String(hour).padStart(2, "0")}:00:00.000Z`;
    await seedClose(env.app, { shiftId: P1, scope: SCOPE_AX, closedAt: at(10), amounts: MINUS_20, frozenPolicy: limit("10.00") });
    await seedClose(env.app, {
      shiftId: P2,
      scope: SCOPE_AX,
      closedAt: at(11),
      amounts: MINUS_20,
      frozenPolicy: limit("10.00"),
      approverId: APPROVER_A,
      verdict: { reason: null },
    });
    await seedClose(env.app, {
      shiftId: P3,
      scope: SCOPE_AX,
      closedAt: at(12),
      amounts: MINUS_20,
      frozenPolicy: NONE,
      approverId: APPROVER_A,
      verdict: { reason: "not_manager" },
    });
    await seedClose(env.app, { shiftId: P4, scope: SCOPE_AX, closedAt: at(13), amounts: MINUS_20, approverId: APPROVER_A });
    await seedClose(env.app, { shiftId: P5, scope: SCOPE_AX, closedAt: at(14), amounts: MINUS_20, frozenPolicy: limit("50.00") });
  },
});
const skip = (): boolean => h.skipped();

async function ids(query: Record<string, string | number> = {}): Promise<string[]> {
  const res = await h.get(LIST, SES_OWNER_ALL, { ...WINDOW, ...query }).expect(200);
  h.conforms("ShiftClosePage", res.body);
  return (res.body.items as Array<{ shiftId: string }>).map((i) => i.shiftId);
}

describe("RT-387 shift-closes — policy fields", () => {
  it("carries the frozen policy, the derived values and the approver check on every close", async () => {
    if (skip()) return;
    const res = await h.get(LIST, SES_OWNER_ALL, WINDOW).expect(200);
    h.conforms("ShiftClosePage", res.body);
    const byId = new Map((res.body.items as Array<Record<string, unknown> & { shiftId: string }>).map((i) => [i.shiftId, i]));
    expect([...byId.keys()]).toEqual([P5, P4, P3, P2, P1]);
    const fields = (shiftId: string) => {
      const { frozenPolicy, approvalRequiredByPolicy, approvalMissing, approverCheck } = byId.get(shiftId)!;
      return { frozenPolicy, approvalRequiredByPolicy, approvalMissing, approverCheck };
    };
    expect(fields(P1)).toEqual({
      frozenPolicy: limit("10.00"),
      approvalRequiredByPolicy: "yes",
      approvalMissing: "yes",
      approverCheck: { status: "not_applicable", reason: null },
    });
    expect(fields(P2)).toMatchObject({ approvalRequiredByPolicy: "yes", approvalMissing: "no", approverCheck: { status: "verified", reason: null } });
    expect(fields(P3)).toEqual({
      frozenPolicy: NONE,
      approvalRequiredByPolicy: "no",
      approvalMissing: "no",
      approverCheck: { status: "unverified", reason: "not_manager" },
    });
    expect(fields(P4)).toEqual({
      frozenPolicy: null,
      approvalRequiredByPolicy: "unknown",
      approvalMissing: "unknown",
      approverCheck: { status: "unverified", reason: "check_unavailable" },
    });
    expect(fields(P5)).toMatchObject({ approvalRequiredByPolicy: "no", approvalMissing: "no" });
  });

  it("the detail carries the same fields", async () => {
    if (skip()) return;
    const res = await h.get(`${LIST}/${P2}`, SES_OWNER_ALL).expect(200);
    h.conforms("ShiftCloseDetail", res.body);
    expect(res.body).toMatchObject({
      frozenPolicy: limit("10.00"),
      approvalRequiredByPolicy: "yes",
      approvalMissing: "no",
      approverCheck: { status: "verified", reason: null },
    });
  });

  it.each([
    [{ approval_required: "yes" }, [P2, P1]],
    [{ approval_required: "no" }, [P5, P3]],
    [{ approval_required: "unknown" }, [P4]],
    [{ approval_missing: "yes" }, [P1]],
    [{ approval_missing: "no" }, [P5, P3, P2]],
    [{ approver_check: "verified" }, [P2]],
    [{ approver_check: "unverified" }, [P4, P3]],
    [{ approver_check: "not_applicable" }, [P5, P1]],
    [{ approval_required: "yes", approver_check: "not_applicable" }, [P1]],
  ])("filters %j", async (query, expected) => {
    if (skip()) return;
    expect(await ids(query)).toEqual(expected);
  });

  it.each([{ approval_required: "maybe" }, { approval_missing: "YES" }, { approver_check: "check_unavailable" }])(
    "refuses %j with 400",
    async (query) => {
      if (skip()) return;
      const res = await h.get(LIST, SES_OWNER_ALL, query);
      expect(res.status).toBe(400);
      h.conforms("Error", res.body);
    },
  );
});
