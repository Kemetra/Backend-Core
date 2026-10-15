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
 *
 * Helpers take one options object (no string-argument runs).
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

const skip = (): boolean => h.dockerSkipped || !h.harness;

const UNKNOWN_USER = "0a000000-0000-7000-8000-0000000530ff";

/** A distinct id per case: the Idempotency-Key and the sale's external id derive from it. */
interface Case {
  readonly id: string;
}

async function capture({ id }: Case): Promise<string> {
  const res = await h
    .harness!.http()
    .post("/api/pos/v1/sales")
    .set("Idempotency-Key", idempKey(`cap${id}`))
    .send(captureBody({ externalId: `rt530-${id}` }));
  expect(res.status).toBe(201);
  return res.body.saleRef as string;
}

interface VoidCall extends Case {
  readonly saleRef: string;
  readonly body: Record<string, unknown>;
}

async function postVoid({ saleRef, body, id }: VoidCall) {
  return h.harness!.http().post(`/api/pos/v1/sales/${saleRef}/void`).set("Idempotency-Key", idempKey(id)).send(body);
}

async function voidCount(saleRef: string): Promise<number> {
  const r = await h.harness!.env.admin.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM sale_voids WHERE sale_id = $1`,
    [saleRef],
  );
  return Number(r.rows[0]!.n);
}

async function reversalEvents(saleRef: string): Promise<number> {
  const r = await h.harness!.env.admin.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM outbox_events
      WHERE event_type = 'erpnext.posting.requested' AND payload->>'sale_id' = $1`,
    [saleRef],
  );
  return Number(r.rows[0]!.n);
}

function approved(saleRef: string, overrides: ApprovedVoidOverrides = {}): Promise<Record<string, unknown>> {
  return approvedVoidBody(h.harness!.env.admin, saleRef, overrides);
}

interface Refusal extends Case {
  readonly saleRef: string;
  readonly overrides: ApprovedVoidOverrides;
  readonly status: number;
  readonly code: string;
}

async function expectRefused({ saleRef, overrides, id, status, code }: Refusal): Promise<void> {
  const res = await postVoid({ saleRef, id, body: await approved(saleRef, overrides) });
  expect(res.status).toBe(status);
  expect(res.body.error.code).toBe(code);
  expect(await voidCount(saleRef)).toBe(0);
  expect(await reversalEvents(saleRef)).toBe(0);
}

/** Refuse a void whose approval fields are overridden, on a freshly captured sale. */
async function refusedWith(
  c: Case,
  overrides: ApprovedVoidOverrides,
  expected: { readonly status: number; readonly code: string },
): Promise<void> {
  const saleRef = await capture(c);
  await expectRefused({ saleRef, overrides, id: c.id, ...expected });
}

describe("RT-530 — a void without a valid approval is refused (security negatives)", () => {
  it("the actor's envelope with NO approval is refused (403 void_approval_required), nothing recorded", async () => {
    if (skip()) return;
    const c = { id: "noappr" };
    const saleRef = await capture(c);
    const res = await postVoid({ ...c, saleRef, body: { sourceSystem: "pos-1", externalId: "void-noappr" } });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("void_approval_required");
    expect(await voidCount(saleRef)).toBe(0);
    const read = await h.harness!.http().get(`/api/pos/v1/sales/${saleRef}`);
    expect(read.body.voided).toBe(false);
  });

  it("an omitted approval object is refused for lack of approval, even with a valid day", async () => {
    if (skip()) return;
    await refusedWith({ id: "omitted" }, { omitApproval: true }, { status: 403, code: "void_approval_required" });
  });

  it("self-void: approver == requester → 403 void_self_approval", async () => {
    if (skip()) return;
    const c = { id: "self" };
    const saleRef = await capture(c);
    h.harness!.contextGuard.userId = APPROVER_MANAGER;
    await expectRefused({
      ...c,
      saleRef,
      overrides: { approval: { requesterUserId: APPROVER_MANAGER, approverUserId: APPROVER_MANAGER } },
      status: 403,
      code: "void_self_approval",
    });
  });

  it("self-void: approver == the sale's selling operator → 403 void_self_approval", async () => {
    if (skip()) return;
    // The sale was captured by DEVICE_USER_ID (created_by). A manager other than the
    // approver requests; the approver is the selling operator themselves.
    const c = { id: "seller" };
    const saleRef = await capture(c);
    h.harness!.contextGuard.userId = APPROVER_TENANT_ADMIN;
    await expectRefused({
      ...c,
      saleRef,
      overrides: { approval: { requesterUserId: APPROVER_TENANT_ADMIN, approverUserId: DEVICE_USER_ID } },
      status: 403,
      code: "void_self_approval",
    });
  });

  it.each([
    ["a cashier (store_staff)", APPROVER_CASHIER],
    ["a store_manager without access to the sale's store", APPROVER_NO_STORE],
    ["a store_manager whose membership is revoked", APPROVER_REVOKED],
    ["a manager of another tenant", APPROVER_OTHER_TENANT],
    ["a user that does not exist", UNKNOWN_USER],
  ])("ineligible approver (%s) → 403 void_approver_not_eligible", async (_label, approverUserId) => {
    if (skip()) return;
    await refusedWith(
      { id: `inel${approverUserId.slice(-4)}` },
      { approval: { approverUserId } },
      { status: 403, code: "void_approver_not_eligible" },
    );
  });

  it.each([
    ["a user that does not exist", UNKNOWN_USER],
    ["another real manager of the store", APPROVER_TENANT_ADMIN],
    ["a user whose membership is revoked", APPROVER_REVOKED],
    ["a user without access to the sale's store", APPROVER_NO_STORE],
    ["a user of another tenant", APPROVER_OTHER_TENANT],
  ])("a requester who is not the authenticated actor (%s) → 403 void_requester_mismatch", async (_label, requesterUserId) => {
    if (skip()) return;
    await refusedWith(
      { id: `req${requesterUserId.slice(-4)}` },
      { approval: { requesterUserId } },
      { status: 403, code: "void_requester_mismatch" },
    );
  });

  it("a manager's own envelope, naming themselves approver and a fabricated requester → 403, nothing recorded", async () => {
    if (skip()) return;
    const c = { id: "fabricated" };
    const saleRef = await capture(c);
    h.harness!.contextGuard.userId = APPROVER_MANAGER;
    await expectRefused({
      ...c,
      saleRef,
      overrides: { approval: { requesterUserId: UNKNOWN_USER, approverUserId: APPROVER_MANAGER } },
      status: 403,
      code: "void_requester_mismatch",
    });
    expect(await reversalEvents(saleRef)).toBe(0);
  });

  it("a manager approving a void they requested on their own envelope → 403 void_self_approval", async () => {
    if (skip()) return;
    const c = { id: "ownapprove" };
    const saleRef = await capture(c);
    h.harness!.contextGuard.userId = APPROVER_MANAGER;
    await expectRefused({
      ...c,
      saleRef,
      overrides: { approval: { requesterUserId: APPROVER_MANAGER, approverUserId: APPROVER_MANAGER } },
      status: 403,
      code: "void_self_approval",
    });
  });

  it.each([
    ["has no access to the sale's store", APPROVER_NO_STORE],
    ["has a revoked membership", APPROVER_REVOKED],
    ["does not exist", UNKNOWN_USER],
    ["belongs to another tenant", APPROVER_OTHER_TENANT],
  ])("an authenticated requester who %s → 403 void_requester_not_eligible", async (_label, actor) => {
    if (skip()) return;
    const c = { id: `actor${actor.slice(-4)}` };
    const saleRef = await capture(c);
    h.harness!.contextGuard.userId = actor;
    await expectRefused({
      ...c,
      saleRef,
      overrides: { approval: { requesterUserId: actor } },
      status: 403,
      code: "void_requester_not_eligible",
    });
    expect(await reversalEvents(saleRef)).toBe(0);
  });

  it("a void on another business day → 422 void_outside_business_day", async () => {
    if (skip()) return;
    await refusedWith({ id: "otherday" }, { body: { businessDate: "2026-05-02" } }, { status: 422, code: "void_outside_business_day" });
  });

  it("a void with no businessDate → 422 void_outside_business_day", async () => {
    if (skip()) return;
    await refusedWith({ id: "nodate" }, { body: { businessDate: undefined } }, { status: 422, code: "void_outside_business_day" });
  });

  it.each([
    ["wrong action", "action", { action: "cart.cancel_post_handoff" }],
    ["another sale", "saleref", { saleRef: "0a000000-0000-7000-8000-0000000530d1" }],
    ["another amount", "amount", { amount: "12.5001" }],
    ["an approval time in the future", "future", { approvedAt: "2999-01-01T00:00:00.000Z" }],
  ])("approval binding mismatch (%s) → 422 void_approval_invalid", async (_label, id, approval) => {
    if (skip()) return;
    await refusedWith({ id: `bind${id}` }, { approval }, { status: 422, code: "void_approval_invalid" });
  });

  it("unknown keys in the approval or the body are rejected (400), mass-assignment ban", async () => {
    if (skip()) return;
    const c = { id: "mass" };
    const saleRef = await capture(c);
    const extraApproval = await approved(saleRef, { approval: { role: "owner" } });
    expect((await postVoid({ saleRef, id: "mass1", body: extraApproval })).status).toBe(400);
    const extraBody = await approved(saleRef, { body: { voidedAt: "2026-05-01T00:00:00Z" } });
    expect((await postVoid({ saleRef, id: "mass2", body: extraBody })).status).toBe(400);
    expect(await voidCount(saleRef)).toBe(0);
  });
});

describe("RT-530 — a valid manager approval voids the sale", () => {
  it("store_manager approval → 201 + a sale_voids row carrying the approver and the evidence", async () => {
    if (skip()) return;
    const c = { id: "happy" };
    const saleRef = await capture(c);
    const res = await postVoid({ ...c, saleRef, body: await approved(saleRef) });
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
  ])("a %s approver is eligible", async (role, approverUserId) => {
    if (skip()) return;
    const c = { id: `role${role}` };
    const saleRef = await capture(c);
    const body = await approved(saleRef, { approval: { approverUserId } });
    expect((await postVoid({ ...c, saleRef, body })).status).toBe(201);
  });

  it("a manager requesting on their own envelope, with another manager approving → 201 attributed to the manager", async () => {
    if (skip()) return;
    const c = { id: "managerreq" };
    const saleRef = await capture(c);
    h.harness!.contextGuard.userId = APPROVER_TENANT_ADMIN;
    const body = await approved(saleRef, {
      approval: { requesterUserId: APPROVER_TENANT_ADMIN, approverUserId: APPROVER_MANAGER },
    });
    expect((await postVoid({ ...c, saleRef, body })).status).toBe(201);
    const row = await h.harness!.env.admin.query(
      `SELECT created_by::text, requested_by_user_id::text, approved_by_user_id::text FROM sale_voids WHERE sale_id = $1`,
      [saleRef],
    );
    expect(row.rows).toEqual([
      {
        created_by: APPROVER_TENANT_ADMIN,
        requested_by_user_id: APPROVER_TENANT_ADMIN,
        approved_by_user_id: APPROVER_MANAGER,
      },
    ]);
  });

  it("the amount is compared exactly as a decimal (12.5 == 12.5000)", async () => {
    if (skip()) return;
    const c = { id: "amount" };
    const saleRef = await capture(c);
    const body = await approved(saleRef, { approval: { amount: "12.5" } });
    expect((await postVoid({ ...c, saleRef, body })).status).toBe(201);
  });

  it("emits ONE reversal posting request, in the same transaction as the void", async () => {
    if (skip()) return;
    const c = { id: "outbox" };
    const saleRef = await capture(c);
    expect((await postVoid({ ...c, saleRef, body: await approved(saleRef) })).status).toBe(201);
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
    const saleRef = await capture({ id: "twice" });
    const first = await approved(saleRef, { body: { externalId: "void-a" } });
    expect((await postVoid({ saleRef, id: "twicea", body: first })).status).toBe(201);
    const second = await approved(saleRef, { body: { externalId: "void-b" } });
    const res = await postVoid({ saleRef, id: "twiceb", body: second });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("already_reversed");
    const replay = await postVoid({ saleRef, id: "twicec", body: first });
    expect(replay.status).toBe(200);
    expect(replay.headers["idempotent-replayed"]).toBe("true");
  });

  it("a sale that already has a return → 409 already_reversed", async () => {
    if (skip()) return;
    const s = await captureOneLine(h, { externalId: "rt530-hasret", quantity: "2", lineAmount: "4.0000" });
    const r = await postReturn(h, s.saleRef, returnBody("rt530-ret-1", [{ lineRef: s.lineRef, quantity: "1" }], "2.0000"), "hasret");
    expect(r.status).toBe(201);
    const res = await postVoid({ saleRef: s.saleRef, id: "hasretv", body: await approved(s.saleRef) });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("already_reversed");
  });

  it("an unknown sale is still a non-disclosing 404, before any approval check", async () => {
    if (skip()) return;
    const body = { sourceSystem: "pos-1", externalId: "void-unk" };
    const res = await postVoid({ saleRef: "0a000000-0000-7000-8000-0000000530e1", id: "unk", body });
    expect(res.status).toBe(404);
  });
});

describe("RT-530 — idempotency", () => {
  it("the same void re-delivered (new Idempotency-Key) replays 200 with no duplicate row", async () => {
    if (skip()) return;
    const saleRef = await capture({ id: "replay" });
    const body = await approved(saleRef);
    const first = await postVoid({ saleRef, id: "replay1", body });
    expect(first.status).toBe(201);
    const replay = await postVoid({ saleRef, id: "replay2", body });
    expect(replay.status).toBe(200);
    expect(replay.headers["idempotent-replayed"]).toBe("true");
    expect(replay.body.eventRef).toBe(first.body.eventRef);
    expect(await voidCount(saleRef)).toBe(1);
  });

  it("the same Idempotency-Key replays the stored 201", async () => {
    if (skip()) return;
    const saleRef = await capture({ id: "samekey" });
    const call = { saleRef, id: "samekey", body: await approved(saleRef) };
    const first = await postVoid(call);
    const again = await postVoid(call);
    expect(first.status).toBe(201);
    expect(again.status).toBe(201);
    expect(again.headers["idempotent-replayed"]).toBe("true");
    expect(again.body.eventRef).toBe(first.body.eventRef);
  });

  it("a replay does not re-run the approval checks: it still answers after the approver left", async () => {
    if (skip()) return;
    const saleRef = await capture({ id: "left" });
    const body = await approved(saleRef);
    expect((await postVoid({ saleRef, id: "left1", body })).status).toBe(201);
    const admin = h.harness!.env.admin;
    await admin.query(`UPDATE memberships SET revoked_at = now() WHERE user_id = $1`, [APPROVER_MANAGER]);
    try {
      const replay = await postVoid({ saleRef, id: "left2", body });
      expect(replay.status).toBe(200);
      expect(replay.headers["idempotent-replayed"]).toBe("true");
    } finally {
      await admin.query(`UPDATE memberships SET revoked_at = NULL WHERE user_id = $1`, [APPROVER_MANAGER]);
    }
  });
});
