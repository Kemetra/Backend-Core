/**
 * void-approval.spec.ts — RT-530.
 *
 * A finalized sale is voided only with a bound manager approval (RT-114 PIN
 * evidence) from a `store_manager`-or-above approver who has access to the
 * sale's store, who is neither the requester nor the sale's selling operator,
 * on the sale's own business day. Backend-Core re-validates all of it on
 * arrival, so a queued (offline) void can still be refused.
 *
 * Security negative cases first: a direct API void with the actor's envelope
 * and no approval is refused; so is every way of weakening the approval.
 */
import {
  startCaptureHarness,
  stopCaptureHarness,
  resetHarness,
  captureBody,
  idempKey,
  DEVICE_USER_ID,
  type HarnessHandle,
} from "../capture/__capture-harness";
import {
  APPROVER_CASHIER,
  APPROVER_MANAGER,
  APPROVER_NO_STORE,
  APPROVER_OTHER_TENANT,
  APPROVER_OWNER,
  APPROVER_REVOKED,
  APPROVER_TENANT_ADMIN,
  APPROVAL_ID,
  approvedVoidBody,
  type ApprovedVoidOverrides,
} from "../__support__/void-approval-fixture";
import { captureOneLine, enableReturns, disableReturns, postReturn, returnBody } from "./__returns-support";

const h: HarnessHandle = { harness: null, dockerSkipped: false };

beforeAll(async () => {
  enableReturns();
  Object.assign(h, await startCaptureHarness());
}, 180_000);
afterAll(async () => {
  disableReturns();
  await stopCaptureHarness(h);
}, 60_000);
beforeEach(() => resetHarness(h));
afterEach(async () => {
  if (!h.harness) return;
  const admin = h.harness.env.admin;
  await admin.query("DELETE FROM outbox_events WHERE event_type = 'erpnext.posting.requested'").catch(() => undefined);
  await admin.query("DELETE FROM sale_voids WHERE source_system = 'pos-1'");
  await admin.query("DELETE FROM sale_return_tenders WHERE return_id IN (SELECT id FROM sale_returns WHERE source_system = 'pos-1')");
  await admin.query("DELETE FROM sale_return_lines WHERE return_id IN (SELECT id FROM sale_returns WHERE source_system = 'pos-1')");
  await admin.query("DELETE FROM sale_returns WHERE source_system = 'pos-1'");
  await admin.query("DELETE FROM sale_lines WHERE sale_id IN (SELECT id FROM sales WHERE source_system = 'pos-1')");
  await admin.query("DELETE FROM sales WHERE source_system = 'pos-1'");
});

function skip(): boolean {
  return h.dockerSkipped || !h.harness;
}

async function capture(externalId: string): Promise<string> {
  const res = await h
    .harness!.http()
    .post("/api/pos/v1/sales")
    .set("Idempotency-Key", idempKey(`cap${externalId}`))
    .send(captureBody({ externalId }));
  expect(res.status).toBe(201);
  return res.body.saleRef as string;
}

async function postVoid(saleRef: string, body: Record<string, unknown>, key: string) {
  return h.harness!.http().post(`/api/pos/v1/sales/${saleRef}/void`).set("Idempotency-Key", idempKey(key)).send(body);
}

async function voidCount(saleRef: string): Promise<number> {
  const r = await h.harness!.env.admin.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM sale_voids WHERE sale_id = $1`,
    [saleRef],
  );
  return Number(r.rows[0]!.n);
}

async function refused(saleRef: string, overrides: ApprovedVoidOverrides, key: string, status: number, code: string) {
  const body = await approvedVoidBody(h.harness!.env.admin, saleRef, overrides);
  const res = await postVoid(saleRef, body, key);
  expect(res.status).toBe(status);
  expect(res.body.error.code).toBe(code);
  expect(await voidCount(saleRef)).toBe(0);
}

describe("RT-530 — a void without a valid approval is refused (security negatives)", () => {
  it("the actor's envelope with NO approval is refused (403 void_approval_required), nothing recorded", async () => {
    if (skip()) return;
    const saleRef = await capture("rt530-noappr");
    const res = await postVoid(saleRef, { sourceSystem: "pos-1", externalId: "void-noappr" }, "noappr");
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("void_approval_required");
    expect(await voidCount(saleRef)).toBe(0);
    const read = await h.harness!.http().get(`/api/pos/v1/sales/${saleRef}`);
    expect(read.body.voided).toBe(false);
  });

  it("a business day with no approval is still refused for lack of approval", async () => {
    if (skip()) return;
    const saleRef = await capture("rt530-noappr2");
    await refused(saleRef, { omitApproval: true }, "noappr2", 403, "void_approval_required");
  });

  it("self-void: approver == requester → 403 void_self_approval", async () => {
    if (skip()) return;
    const saleRef = await capture("rt530-self");
    await refused(
      saleRef,
      { approval: { requesterUserId: APPROVER_MANAGER, approverUserId: APPROVER_MANAGER } },
      "self",
      403,
      "void_self_approval",
    );
  });

  it("self-void: approver == the sale's selling operator → 403 void_self_approval", async () => {
    if (skip()) return;
    const saleRef = await capture("rt530-seller");
    // The sale was captured by DEVICE_USER_ID (created_by). A manager other than the
    // approver requests; the approver is the selling operator themselves.
    await refused(
      saleRef,
      { approval: { requesterUserId: APPROVER_TENANT_ADMIN, approverUserId: DEVICE_USER_ID } },
      "seller",
      403,
      "void_self_approval",
    );
  });

  it.each([
    ["a cashier (store_staff)", APPROVER_CASHIER],
    ["a store_manager without access to the sale's store", APPROVER_NO_STORE],
    ["a store_manager whose membership is revoked", APPROVER_REVOKED],
    ["a manager of another tenant", APPROVER_OTHER_TENANT],
    ["a user that does not exist", "0a000000-0000-7000-8000-0000000530ff"],
  ])("ineligible approver (%s) → 403 void_approver_not_eligible", async (_label, approver) => {
    if (skip()) return;
    const saleRef = await capture(`rt530-inelig-${approver.slice(-4)}`);
    await refused(saleRef, { approval: { approverUserId: approver } }, `inel${approver.slice(-4)}`, 403, "void_approver_not_eligible");
  });

  it("a void on another business day → 422 void_outside_business_day", async () => {
    if (skip()) return;
    const saleRef = await capture("rt530-otherday");
    await refused(saleRef, { body: { businessDate: "2026-05-02" } }, "otherday", 422, "void_outside_business_day");
  });

  it("a void with no businessDate → 422 void_outside_business_day", async () => {
    if (skip()) return;
    const saleRef = await capture("rt530-nodate");
    await refused(saleRef, { body: { businessDate: undefined } }, "nodate", 422, "void_outside_business_day");
  });

  it.each([
    ["wrong action", { action: "cart.cancel_post_handoff" }],
    ["another sale", { saleRef: "0a000000-0000-7000-8000-0000000530d1" }],
    ["another amount", { amount: "12.5001" }],
    ["an approval time in the future", { approvedAt: "2999-01-01T00:00:00.000Z" }],
  ])("approval binding mismatch (%s) → 422 void_approval_invalid", async (_label, approval) => {
    if (skip()) return;
    const saleRef = await capture(`rt530-bind-${Object.keys(approval)[0]}`);
    await refused(saleRef, { approval }, `bind${Object.keys(approval)[0]}`, 422, "void_approval_invalid");
  });

  it("unknown keys in the approval or the body are rejected (400), mass-assignment ban", async () => {
    if (skip()) return;
    const saleRef = await capture("rt530-mass");
    const extraApproval = await approvedVoidBody(h.harness!.env.admin, saleRef, { approval: { role: "owner" } });
    expect((await postVoid(saleRef, extraApproval, "mass1")).status).toBe(400);
    const extraBody = await approvedVoidBody(h.harness!.env.admin, saleRef, { body: { voidedAt: "2026-05-01T00:00:00Z" } });
    expect((await postVoid(saleRef, extraBody, "mass2")).status).toBe(400);
    expect(await voidCount(saleRef)).toBe(0);
  });
});

describe("RT-530 — a valid manager approval voids the sale", () => {
  it("store_manager approval → 201 + a sale_voids row carrying the approver and the evidence", async () => {
    if (skip()) return;
    const saleRef = await capture("rt530-happy");
    const body = await approvedVoidBody(h.harness!.env.admin, saleRef);
    const res = await postVoid(saleRef, body, "happy");
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ kind: "void", saleRef });

    const row = await h.harness!.env.admin.query(
      `SELECT approval_id::text, approved_by_user_id::text, requested_by_user_id::text,
              approval_policy_version, approved_at IS NOT NULL AS has_time,
              void_business_date::text, created_by::text
         FROM sale_voids WHERE sale_id = $1`,
      [saleRef],
    );
    expect(row.rows).toEqual([
      {
        approval_id: APPROVAL_ID,
        approved_by_user_id: APPROVER_MANAGER,
        requested_by_user_id: DEVICE_USER_ID,
        approval_policy_version: "rt114-2026-10-07",
        has_time: true,
        void_business_date: "2026-05-01",
        created_by: DEVICE_USER_ID,
      },
    ]);
    const read = await h.harness!.http().get(`/api/pos/v1/sales/${saleRef}`);
    expect(read.body.voided).toBe(true);
  });

  it.each([
    ["tenant_admin", APPROVER_TENANT_ADMIN],
    ["owner", APPROVER_OWNER],
  ])("a %s approver is eligible", async (_label, approver) => {
    if (skip()) return;
    const saleRef = await capture(`rt530-role-${approver.slice(-3)}`);
    const body = await approvedVoidBody(h.harness!.env.admin, saleRef, { approval: { approverUserId: approver } });
    expect((await postVoid(saleRef, body, `role${approver.slice(-3)}`)).status).toBe(201);
  });

  it("the amount is compared exactly as a decimal (12.5 == 12.5000)", async () => {
    if (skip()) return;
    const saleRef = await capture("rt530-amount");
    const body = await approvedVoidBody(h.harness!.env.admin, saleRef, { approval: { amount: "12.5" } });
    expect((await postVoid(saleRef, body, "amount")).status).toBe(201);
  });

  it("emits ONE reversal posting request, in the same transaction as the void", async () => {
    if (skip()) return;
    const saleRef = await capture("rt530-outbox");
    const body = await approvedVoidBody(h.harness!.env.admin, saleRef);
    expect((await postVoid(saleRef, body, "outbox")).status).toBe(201);
    const ev = await h.harness!.env.admin.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM outbox_events
        WHERE event_type = 'erpnext.posting.requested' AND payload->>'sale_id' = $1 AND payload->>'kind' = 'reversal'`,
      [saleRef],
    );
    expect(ev.rows[0]!.n).toBe("1");
  });
});

describe("RT-530 — reversal exclusivity is unchanged", () => {
  it("a second, different void of a voided sale → 409 already_reversed; the first void replays 200", async () => {
    if (skip()) return;
    const saleRef = await capture("rt530-twice");
    const first = await approvedVoidBody(h.harness!.env.admin, saleRef, { body: { externalId: "void-a" } });
    expect((await postVoid(saleRef, first, "twicea")).status).toBe(201);
    const second = await approvedVoidBody(h.harness!.env.admin, saleRef, { body: { externalId: "void-b" } });
    const res = await postVoid(saleRef, second, "twiceb");
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("already_reversed");
    const replay = await postVoid(saleRef, first, "twicec");
    expect(replay.status).toBe(200);
    expect(replay.headers["idempotent-replayed"]).toBe("true");
  });

  it("a sale that already has a return → 409 already_reversed", async () => {
    if (skip()) return;
    const s = await captureOneLine(h, { externalId: "rt530-hasret", quantity: "2", lineAmount: "4.0000" });
    const r = await postReturn(h, s.saleRef, returnBody("rt530-ret-1", [{ lineRef: s.lineRef, quantity: "1" }], "2.0000"), "hasret");
    expect(r.status).toBe(201);
    const body = await approvedVoidBody(h.harness!.env.admin, s.saleRef);
    const res = await postVoid(s.saleRef, body, "hasretv");
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("already_reversed");
  });

  it("an unknown sale is still a non-disclosing 404, before any approval check", async () => {
    if (skip()) return;
    const unknown = "0a000000-0000-7000-8000-0000000530e1";
    const res = await postVoid(unknown, { sourceSystem: "pos-1", externalId: "void-unk" }, "unk");
    expect(res.status).toBe(404);
  });
});

describe("RT-530 — idempotency", () => {
  it("the same void re-delivered (new Idempotency-Key) replays 200 with no duplicate row", async () => {
    if (skip()) return;
    const saleRef = await capture("rt530-replay");
    const body = await approvedVoidBody(h.harness!.env.admin, saleRef);
    const first = await postVoid(saleRef, body, "replay1");
    expect(first.status).toBe(201);
    const replay = await postVoid(saleRef, body, "replay2");
    expect(replay.status).toBe(200);
    expect(replay.headers["idempotent-replayed"]).toBe("true");
    expect(replay.body.eventRef).toBe(first.body.eventRef);
    expect(await voidCount(saleRef)).toBe(1);
  });

  it("the same Idempotency-Key replays the stored 201", async () => {
    if (skip()) return;
    const saleRef = await capture("rt530-samekey");
    const body = await approvedVoidBody(h.harness!.env.admin, saleRef);
    const first = await postVoid(saleRef, body, "samekey");
    const again = await postVoid(saleRef, body, "samekey");
    expect(first.status).toBe(201);
    expect(again.status).toBe(201);
    expect(again.headers["idempotent-replayed"]).toBe("true");
    expect(again.body.eventRef).toBe(first.body.eventRef);
  });

  it("a replay does not re-run the approval checks: it still answers after the approver left", async () => {
    if (skip()) return;
    const saleRef = await capture("rt530-left");
    const body = await approvedVoidBody(h.harness!.env.admin, saleRef);
    expect((await postVoid(saleRef, body, "left1")).status).toBe(201);
    await h.harness!.env.admin.query(
      `UPDATE memberships SET revoked_at = now() WHERE user_id = $1`,
      [APPROVER_MANAGER],
    );
    try {
      const replay = await postVoid(saleRef, body, "left2");
      expect(replay.status).toBe(200);
      expect(replay.headers["idempotent-replayed"]).toBe("true");
    } finally {
      await h.harness!.env.admin.query(`UPDATE memberships SET revoked_at = NULL WHERE user_id = $1`, [APPROVER_MANAGER]);
    }
  });
});
