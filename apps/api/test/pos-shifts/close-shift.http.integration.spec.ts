/**
 * closeShift over HTTP — RT-17 slice 2b-2 ([GATED] approval: Jira RT-17
 * comments 10760 + 10919 + 10920; carried items 10929, 10931, 10932),
 * against real Postgres with every migration (0036 included) and the
 * production guard chain (see the harness).
 *
 * Proves: the device path (closingUserId = the verified cashier) and the
 * envelope path (forced close is envelope-only); the arithmetic 422 and the
 * strict wire precision 400, recording nothing; the refund refs (an
 * unknown, foreign, non-cash or already-claimed ref is the same
 * non-disclosing 422 `refund_ref_invalid`; another currency is 422
 * `currency_mismatch`; a ref claimed concurrently rolls the whole close
 * back); the variance approver; replay and conflict (200 / 409), concurrent
 * identical closes (the loser replays), the non-disclosing 404; an exact
 * envelope replay answered before the stated closer's live check; the 425,
 * the per-device rate-limit key on both paths and the envelope 429; and that
 * no log line carries a note, a forcedReason or an operatorUserId claim.
 */
import { randomUUID } from "node:crypto";

import {
  CASHIER,
  CASHIER_A2_ONLY,
  CASHIER_B,
  CASHIER_UNADMITTED,
  DEV_A1,
  DEV_A1_SECOND,
  DEV_A2,
  DEV_B1,
  MANAGER,
  admin,
  auditsOf,
  closeBody,
  closePath,
  expectError,
  expectReplay,
  expectSchema,
  h,
  holdShiftLock,
  managerEnvelope,
  movementBody,
  movementPath,
  newKey,
  openOn,
  post,
  resetState,
  seedReturn,
  skipped,
  startHarness,
  stopHarness,
  waitForLockWaiters,
  type FixtureDevice,
} from "./__support__/shift-http-harness";

beforeAll(() => startHarness("close-shift.http"), 240_000);
afterAll(() => stopHarness(), 60_000);
afterEach(() => resetState());

/** A close of `shiftId` sent with `bearer` (a till token or an envelope). */
interface CloseCall {
  readonly bearer: string;
  readonly shiftId: string;
  readonly body: Record<string, unknown>;
  readonly key?: string;
}

function close(call: CloseCall) {
  return post({ path: closePath(call.shiftId), bearer: call.bearer, body: call.body, key: call.key });
}

/** A device-path close of `shiftId` from `device`'s till. */
function closeFrom(device: FixtureDevice, shiftId: string, body: Record<string, unknown> = closeBody()) {
  return close({ bearer: device.token, shiftId, body });
}

/** A close body for the manager envelope path: no operatorUserId claim. */
function envelopeBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const { operatorUserId: _claim, ...body } = closeBody(overrides);
  return body;
}

const FORCED = { closeKind: "forced", forcedReason: "Cashier left without closing" };

/** The shift's lifecycle state and whether a close row exists. */
async function stateOf(shiftId: string): Promise<{ lifecycle: string; closed: boolean }> {
  const r = await admin().query<{ lifecycle_state: string; closed: boolean }>(
    `SELECT s.lifecycle_state, EXISTS (SELECT 1 FROM shift_closes c WHERE c.shift_id = s.shift_id) AS closed
       FROM shifts s WHERE s.shift_id = $1`,
    [shiftId],
  );
  return { lifecycle: r.rows[0]?.lifecycle_state ?? "missing", closed: r.rows[0]?.closed ?? false };
}

const STILL_OPEN = { lifecycle: "open", closed: false };

/** The stored provenance of a close. */
async function closeRow(shiftId: string): Promise<Record<string, unknown> | undefined> {
  const r = await admin().query(
    `SELECT closing_user_id, recorded_by_user_id, close_kind, forced_reason, variance::text AS variance,
            variance_approved_by_user_id
       FROM shift_closes WHERE shift_id = $1`,
    [shiftId],
  );
  return r.rows[0];
}

describe("closeShift — device path records the close", () => {
  it("201: the Shift projection with its close, the verified cashier as recorder, the shift closed", async () => {
    if (skipped()) return;
    const shiftId = await openOn(DEV_A1);
    const res = await closeFrom(DEV_A1, shiftId);
    expect(res.status).toBe(201);
    expectSchema("Shift", res.body);
    expect(res.body).toMatchObject({
      shiftId,
      status: "closed",
      close: { closeKind: "normal", openingFloat: "500.00", expectedCash: "2755.00", variance: "-5.00", saleCount: 37 },
    });
    expect(res.body.close).not.toHaveProperty("forcedReason");
    expect(await closeRow(shiftId)).toMatchObject({ closing_user_id: CASHIER.id, recorded_by_user_id: CASHIER.id });
    expect(await stateOf(shiftId)).toEqual({ lifecycle: "closed", closed: true });
    expect(auditsOf("shift.closed").map((p) => p.actor_user_id)).toEqual([CASHIER.id]);
  });

  it("totals are recorded verbatim: a whole-unit spelling is echoed at the currency's minor unit", async () => {
    if (skipped()) return;
    const shiftId = await openOn(DEV_A1);
    const body = closeBody({ countedCash: "2750", cashSalesTotal: "2450.0" });
    const res = await closeFrom(DEV_A1, shiftId, body);
    expect([res.status, res.body.close?.countedCash, res.body.close?.cashSalesTotal]).toEqual([201, "2750.00", "2450.00"]);
  });

  it.each([
    ["a forced close", FORCED, "refused", 403],
    ["closingUserId other than operatorUserId", { closingUserId: CASHIER_UNADMITTED.id }, "refused", 403],
    ["an unadmitted cashier's claim", { closingUserId: CASHIER_UNADMITTED.id, operatorUserId: CASHIER_UNADMITTED.id }, "refused", 403],
  ])("%s on the device path is %s (%i), recording nothing", async (_label, overrides, code, status) => {
    if (skipped()) return;
    const shiftId = await openOn(DEV_A1);
    expectError(await closeFrom(DEV_A1, shiftId, closeBody(overrides)), { status, code });
    expect(await stateOf(shiftId)).toEqual(STILL_OPEN);
  });
});

describe("closeShift — manager envelope path", () => {
  it("a forced close: 201, closed_forced, the reason echoed, the stated closer recorded, the operator the recorder", async () => {
    if (skipped()) return;
    const shiftId = await openOn(DEV_A1);
    const body = envelopeBody({ ...FORCED, closingUserId: MANAGER.id });
    const res = await close({ bearer: await managerEnvelope(DEV_A1), shiftId, body });
    expect(res.status).toBe(201);
    expectSchema("Shift", res.body);
    expect(res.body.close).toMatchObject({ closeKind: "forced", forcedReason: FORCED.forcedReason });
    expect(await closeRow(shiftId)).toMatchObject({ closing_user_id: MANAGER.id, recorded_by_user_id: MANAGER.id });
    expect(await stateOf(shiftId)).toEqual({ lifecycle: "closed_forced", closed: true });
  });

  it("a normal close on behalf of the cashier: 201, the stated closer recorded as stated", async () => {
    if (skipped()) return;
    const shiftId = await openOn(DEV_A1);
    const res = await close({ bearer: await managerEnvelope(DEV_A1), shiftId, body: envelopeBody() });
    expect(res.status).toBe(201);
    expect(await closeRow(shiftId)).toMatchObject({ closing_user_id: CASHIER.id, recorded_by_user_id: MANAGER.id });
  });

  it.each([
    ["without access to the store", CASHIER_A2_ONLY.id],
    ["of another tenant", CASHIER_B.id],
  ])("a closer %s is the generic 403 refused", async (_label, closingUserId) => {
    if (skipped()) return;
    const shiftId = await openOn(DEV_A1);
    const res = await close({ bearer: await managerEnvelope(DEV_A1), shiftId, body: envelopeBody({ closingUserId }) });
    expectError(res, { status: 403, code: "refused" });
    expect(await stateOf(shiftId)).toEqual(STILL_OPEN);
  });

  it.each([
    ["the same close", {}, 200],
    ["a different close", { countedCash: "2755.00", variance: "0.00" }, 403],
  ])(
    "after the stated closer's access is revoked, %s → %i (an exact replay is answered before the live check, RT-17 10931 #4)",
    async (_label, change, status) => {
      if (skipped()) return;
      const shiftId = await openOn(DEV_A1);
      const envelope = await managerEnvelope(DEV_A1);
      const body = envelopeBody();
      expect((await close({ bearer: envelope, shiftId, body })).status).toBe(201);
      await admin().query(`UPDATE memberships SET revoked_at = now() WHERE id = $1`, [CASHIER.membership]);
      expect((await close({ bearer: envelope, shiftId, body: { ...body, ...change } })).status).toBe(status);
    },
  );
});

describe("closeShift — strict body (400)", () => {
  it.each([
    ["a normal close with a forcedReason", { forcedReason: "no" }],
    ["a forced close without a forcedReason", { closeKind: "forced" }],
    ["an empty forcedReason", { ...FORCED, forcedReason: "" }],
    ["a negative total", { cashSalesTotal: "-1.00" }],
    ["a fractional saleCount", { saleCount: 1.5 }],
    ["duplicate refund refs", { cashRefundReturnRefs: [DEV_A1.id, DEV_A1.id] }],
    ["a non-RFC 3339 closedAt", { closedAt: "2026-10-05T16:00:00+0200" }],
    ["more fractional digits than EGP's 2", { countedCash: "2750.001", variance: "-4.999" }],
    ["an unknown key (a scope field)", { storeId: DEV_A2.store }],
    ["a saleCount beyond a database integer", { saleCount: 2147483648 }],
    ["more than 1000 refund refs", { cashRefundReturnRefs: Array.from({ length: 1001 }, () => randomUUID()) }],
  ])("%s is 400 validation_error, recording nothing", async (_label, overrides) => {
    if (skipped()) return;
    const shiftId = await openOn(DEV_A1);
    expectError(await closeFrom(DEV_A1, shiftId, closeBody(overrides)), { status: 400, code: "validation_error" });
    expect(await stateOf(shiftId)).toEqual(STILL_OPEN);
  });

  it("a fraction on a JPY shift (0 digits) is 400 validation_error", async () => {
    if (skipped()) return;
    const shiftId = await openOn(DEV_A1, { currencyCode: "JPY", openingFloat: "500" });
    const body = closeBody({
      openingFloat: "500",
      cashSalesTotal: "2450",
      cashRefundsTotal: "75",
      payInTotal: "0",
      payOutTotal: "120",
      expectedCash: "2755",
      countedCash: "2750.5",
      variance: "-4.5",
    });
    expectError(await closeFrom(DEV_A1, shiftId, body), { status: 400, code: "validation_error" });
  });
});

describe("closeShift — the arithmetic invariant (422 shift_cashup_inconsistent), totals never rewritten", () => {
  it.each([
    ["expectedCash off by one cent", { expectedCash: "2755.01", variance: "-5.01" }],
    ["variance off by one cent", { variance: "-5.01" }],
    ["openingFloat other than the one recorded at open", { openingFloat: "600.00", expectedCash: "2855.00", variance: "-105.00" }],
  ])("%s is 422, recording nothing", async (_label, overrides) => {
    if (skipped()) return;
    const shiftId = await openOn(DEV_A1);
    const res = await closeFrom(DEV_A1, shiftId, closeBody(overrides));
    expectError(res, { status: 422, code: "shift_cashup_inconsistent" });
    expect(await stateOf(shiftId)).toEqual(STILL_OPEN);
  });

  it("a 3-digit currency is checked at its own minor unit", async () => {
    if (skipped()) return;
    const shiftId = await openOn(DEV_A1, { currencyCode: "KWD", openingFloat: "10.250" });
    const body = closeBody({
      openingFloat: "10.250",
      cashSalesTotal: "1.005",
      cashRefundsTotal: "0",
      payOutTotal: "0",
      expectedCash: "11.255",
      countedCash: "11.250",
      variance: "-0.005",
    });
    const res = await closeFrom(DEV_A1, shiftId, body);
    expect([res.status, res.body.close?.variance]).toEqual([201, "-0.005"]);
  });
});

describe("closeShift — refund refs (RT-17 10929 P3-6)", () => {
  it("cash-refunded returns of this tenant and store are claimed, echoed in order", async () => {
    if (skipped()) return;
    const refs = [await seedReturn({ at: DEV_A1 }), await seedReturn({ at: DEV_A1_SECOND })];
    const shiftId = await openOn(DEV_A1);
    const res = await closeFrom(DEV_A1, shiftId, closeBody({ cashRefundReturnRefs: refs }));
    expect([res.status, res.body.close?.cashRefundReturnRefs]).toEqual([201, refs]);
    const claims = await admin().query(`SELECT return_id FROM shift_refund_claims WHERE shift_id = $1 ORDER BY ordinal`, [shiftId]);
    expect(claims.rows.map((r) => r.return_id)).toEqual(refs);
  });

  it.each([
    ["an unknown return", async () => "0e170000-0000-4000-8000-0000000ff0aa"],
    ["a return of another store", async () => seedReturn({ at: DEV_A2 })],
    ["a return of another tenant", async () => seedReturn({ at: DEV_B1 })],
    ["a return without a cash refund", async () => seedReturn({ at: DEV_A1, cashTender: false })],
    ["a non-cash return in another currency", async () => seedReturn({ at: DEV_A1, cashTender: false, currency: "USD" })],
  ])("%s is 422 refund_ref_invalid, recording nothing", async (_label, ref) => {
    if (skipped()) return;
    const shiftId = await openOn(DEV_A1);
    const body = closeBody({ cashRefundReturnRefs: [await seedReturn({ at: DEV_A1 }), await ref()] });
    expectError(await closeFrom(DEV_A1, shiftId, body), { status: 422, code: "refund_ref_invalid" });
    expect(await stateOf(shiftId)).toEqual(STILL_OPEN);
  });

  it("a return already claimed by another device's close is the same 422, never naming that shift", async () => {
    if (skipped()) return;
    const ref = await seedReturn({ at: DEV_A1 });
    const other = await openOn(DEV_A1_SECOND);
    expect((await closeFrom(DEV_A1_SECOND, other, closeBody({ cashRefundReturnRefs: [ref] }))).status).toBe(201);
    const shiftId = await openOn(DEV_A1);
    const res = await closeFrom(DEV_A1, shiftId, closeBody({ cashRefundReturnRefs: [ref] }));
    expectError(res, { status: 422, code: "refund_ref_invalid" });
    expect(JSON.stringify(res.body)).not.toContain(other);
  });

  it("an upper-case ref resolves to the same return (201, echoed lower-case); one return in two spellings is 400 (PR #714 round 1)", async () => {
    if (skipped()) return;
    const ref = await seedReturn({ at: DEV_A1 });
    const shiftId = await openOn(DEV_A1);
    const duplicate = closeBody({ cashRefundReturnRefs: [ref, ref.toUpperCase()] });
    expectError(await closeFrom(DEV_A1, shiftId, duplicate), { status: 400, code: "validation_error" });
    const res = await closeFrom(DEV_A1, shiftId.toUpperCase(), closeBody({ cashRefundReturnRefs: [ref.toUpperCase()] }));
    expect([res.status, res.body.shiftId, res.body.close?.cashRefundReturnRefs]).toEqual([201, shiftId, [ref]]);
  });

  it("a cash refund in another currency is 422 currency_mismatch", async () => {
    if (skipped()) return;
    const shiftId = await openOn(DEV_A1);
    const body = closeBody({ cashRefundReturnRefs: [await seedReturn({ at: DEV_A1, currency: "USD" })] });
    expectError(await closeFrom(DEV_A1, shiftId, body), { status: 422, code: "currency_mismatch" });
    expect(await stateOf(shiftId)).toEqual(STILL_OPEN);
  });

  it("a ref claimed by a concurrent close rolls the whole close back: 422 refund_ref_invalid, nothing recorded", async () => {
    if (skipped()) return;
    const ref = await seedReturn({ at: DEV_A1 });
    const rival = await openOn(DEV_A1_SECOND);
    const shiftId = await openOn(DEV_A1);
    const claimer = await admin().connect();
    try {
      await claimer.query("BEGIN");
      await claimer.query(
        `INSERT INTO shift_closes
           (shift_id, tenant_id, store_id, device_id, currency_code, closed_at, closing_user_id, close_kind,
            opening_float, cash_sales_total, cash_refunds_total, pay_in_total, pay_out_total, expected_cash,
            counted_cash, variance, sale_count, recorded_by_user_id, payload_hash)
         SELECT shift_id, tenant_id, store_id, opening_device_id, currency_code, now(), opening_cashier_user_id,
                'normal', opening_float, 0, 0, 0, 0, opening_float, opening_float, 0, 0, recorded_by_user_id,
                decode(repeat('cd', 32), 'hex')
           FROM shifts WHERE shift_id = $1`,
        [rival],
      );
      await claimer.query(
        `INSERT INTO shift_refund_claims (return_id, shift_id, tenant_id, store_id, ordinal) VALUES ($1, $2, $3, $4, 0)`,
        [ref, rival, DEV_A1.tenant, DEV_A1.store],
      );
      const pending = closeFrom(DEV_A1, shiftId, closeBody({ cashRefundReturnRefs: [ref] })).then((res) => res);
      await waitForLockWaiters();
      await claimer.query(`UPDATE shifts SET lifecycle_state = 'closed' WHERE shift_id = $1`, [rival]);
      await claimer.query("COMMIT");
      expectError(await pending, { status: 422, code: "refund_ref_invalid" });
    } finally {
      await claimer.query("ROLLBACK").catch(() => undefined);
      claimer.release();
    }
    expect(await stateOf(shiftId)).toEqual(STILL_OPEN);
  });
});

describe("closeShift — variance approval (recorded; the role never blocks)", () => {
  it.each([
    ["a manager", MANAGER.id],
    ["a user without the manager role", CASHIER_UNADMITTED.id],
  ])("approved by %s: 201, recorded and echoed", async (_label, approver) => {
    if (skipped()) return;
    const shiftId = await openOn(DEV_A1);
    const res = await closeFrom(DEV_A1, shiftId, closeBody({ varianceApprovedByUserId: approver }));
    expect([res.status, res.body.close?.varianceApprovedByUserId]).toEqual([201, approver]);
    expect((await closeRow(shiftId))?.["variance_approved_by_user_id"]).toBe(approver);
  });

  it.each([
    ["an unknown user", "0e170000-0000-4000-8000-0000000ff0bb"],
    ["a user of another tenant", CASHIER_B.id],
  ])("approved by %s: 400 validation_error, recording nothing", async (_label, approver) => {
    if (skipped()) return;
    const shiftId = await openOn(DEV_A1);
    const res = await closeFrom(DEV_A1, shiftId, closeBody({ varianceApprovedByUserId: approver }));
    expectError(res, { status: 400, code: "validation_error" });
    expect(await stateOf(shiftId)).toEqual(STILL_OPEN);
  });
});

describe("closeShift — replay, conflict and scope", () => {
  it("the same key and body replays the stored 201", async () => {
    if (skipped()) return;
    const call = { bearer: DEV_A1.token, shiftId: await openOn(DEV_A1), body: closeBody(), key: newKey() };
    const first = await close(call);
    const again = await close(call);
    expect([again.status, again.headers["idempotent-replayed"], again.body]).toEqual([201, "true", first.body]);
  });

  it("the same close under another key (amounts respelled) is a 200 replay", async () => {
    if (skipped()) return;
    const shiftId = await openOn(DEV_A1);
    const body = closeBody();
    const first = await closeFrom(DEV_A1, shiftId, body);
    const replay = await closeFrom(DEV_A1, shiftId, { ...body, countedCash: "2750", variance: "-5" });
    expectReplay(replay);
    expect(replay.body).toEqual(first.body);
  });

  it.each([
    ["counted cash", { countedCash: "2755.00", variance: "0.00" }],
    ["closing time", { closedAt: new Date(Date.now() - 60_000).toISOString() }],
    ["sale count", { saleCount: 38 }],
  ])("a second close with another %s is 409 shift_payload_conflict", async (_label, change) => {
    if (skipped()) return;
    const shiftId = await openOn(DEV_A1);
    const body = closeBody();
    await closeFrom(DEV_A1, shiftId, body);
    expectError(await closeFrom(DEV_A1, shiftId, { ...body, ...change }), { status: 409, code: "shift_payload_conflict" });
  });

  it.each([
    ["another device of the same store", DEV_A1_SECOND],
    ["another store of the same tenant", DEV_A2],
    ["another tenant", DEV_B1],
  ])("a shift of %s is 404 shift_not_found, closing nothing", async (_label, owner) => {
    if (skipped()) return;
    const shiftId = await openOn(owner);
    expectError(await closeFrom(DEV_A1, shiftId), { status: 404, code: "shift_not_found" });
    expect(await stateOf(shiftId)).toEqual(STILL_OPEN);
  });

  it("an unknown shift is the same 404; a malformed shift_id is 400", async () => {
    if (skipped()) return;
    expectError(await closeFrom(DEV_A1, "0e170000-0000-4000-8000-0000000ff001"), { status: 404, code: "shift_not_found" });
    expectError(await closeFrom(DEV_A1, "not-a-uuid"), { status: 400, code: "validation_error" });
  });

  it("a new movement after the close is 409 shift_closed", async () => {
    if (skipped()) return;
    const shiftId = await openOn(DEV_A1);
    await closeFrom(DEV_A1, shiftId);
    const res = await post({ path: movementPath(shiftId), bearer: DEV_A1.token, body: movementBody() });
    expectError(res, { status: 409, code: "shift_closed" });
  });
});

describe("closeShift — concurrency", () => {
  it("two identical closes under different keys: one records (201), the other replays (200)", async () => {
    if (skipped()) return;
    const shiftId = await openOn(DEV_A1);
    const body = closeBody();
    const lock = await holdShiftLock(shiftId);
    const racing = [closeFrom(DEV_A1, shiftId, body), closeFrom(DEV_A1, shiftId, body)].map((r) => r.then((res) => res));
    await waitForLockWaiters(2);
    await lock.release();
    const statuses = (await Promise.all(racing)).map((res) => res.status).sort();
    expect(statuses).toEqual([200, 201]);
    expect(await stateOf(shiftId)).toEqual({ lifecycle: "closed", closed: true });
  });

  it("the same key while the first request is in flight is 425 idempotency_in_progress", async () => {
    if (skipped()) return;
    const shiftId = await openOn(DEV_A1);
    const call = { bearer: DEV_A1.token, shiftId, body: closeBody(), key: newKey() };
    const lock = await holdShiftLock(shiftId);
    const first = close(call).then((res) => res);
    await waitForLockWaiters();
    const early = await close(call);
    await lock.release();
    expect([early.status, early.headers["retry-after"]]).toEqual([425, "2"]);
    expectSchema("IdempotencyInProgressBody", early.body);
    expect(early.body).toEqual({ error: "idempotency_in_progress", retryAfterSec: 2 });
    expect((await first).status).toBe(201);
  });
});

describe("closeShift — rate limit (ADR 0009, keyed per device on both paths)", () => {
  it("the device path and the envelope path both ask the posWriteShift bucket about the bound device", async () => {
    if (skipped()) return;
    const shiftId = await openOn(DEV_A1);
    const envelope = await managerEnvelope(DEV_A1);
    h().limiter.calls.length = 0;
    await closeFrom(DEV_A1, shiftId);
    await close({ bearer: envelope, shiftId, body: envelopeBody() });
    expect(h().limiter.calls).toEqual([
      { bucket: "posWriteShift", key: DEV_A1.id },
      { bucket: "posWriteShift", key: DEV_A1.id },
    ]);
  });

  it("over the limit on the envelope path is 429 RATE_LIMITED with Retry-After; another till is unaffected", async () => {
    if (skipped()) return;
    const shiftId = await openOn(DEV_A1);
    const other = await openOn(DEV_A1_SECOND);
    h().limiter.denyKey = DEV_A1.id;
    const res = await close({ bearer: await managerEnvelope(DEV_A1), shiftId, body: envelopeBody() });
    expectError(res, { status: 429, code: "RATE_LIMITED" });
    expect(Number(res.headers["retry-after"])).toBeGreaterThanOrEqual(1);
    expect((await closeFrom(DEV_A1_SECOND, other)).status).toBe(201);
  });
});

describe("cash-up logs never carry the free text or the attribution claim (Constitution §XIV, RT-17 10931)", () => {
  const NOTE = "note-sentinel-4f2a";
  const REASON = "forced-reason-sentinel-9c1d";

  it("refused and accepted requests log, but no line holds a note, a forcedReason or a refused claim", async () => {
    if (skipped()) return;
    const shiftId = await openOn(DEV_A1);
    const refusedClaim = { note: NOTE, operatorUserId: CASHIER_UNADMITTED.id };
    await post({ path: movementPath(shiftId), bearer: DEV_A1.token, body: movementBody(refusedClaim) });
    await post({ path: movementPath(shiftId), bearer: DEV_A1.token, body: movementBody({ note: NOTE }) });
    const refusedClose = { ...FORCED, forcedReason: REASON, operatorUserId: CASHIER_UNADMITTED.id };
    await closeFrom(DEV_A1, shiftId, closeBody({ ...refusedClose, closingUserId: CASHIER_UNADMITTED.id }));
    const body = envelopeBody({ ...FORCED, forcedReason: REASON, closingUserId: MANAGER.id });
    expect((await close({ bearer: await managerEnvelope(DEV_A1), shiftId, body })).status).toBe(201);
    const logged = h().logs.lines.join("\n");
    expect(logged).toContain("shift.cash_up.operator_refused");
    expect(logged).toContain("request completed");
    expect([NOTE, REASON, CASHIER_UNADMITTED.id].filter((secret) => logged.includes(secret))).toEqual([]);
  });
});
