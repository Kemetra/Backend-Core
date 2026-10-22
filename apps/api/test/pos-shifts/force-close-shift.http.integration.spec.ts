/**
 * forceCloseShift over HTTP — RT-742 (`pos-shifts.openapi.yaml` 1.4.0-draft;
 * RT-554 follow-up, owner decision 2026-10-19; design option A, Jira RT-742
 * comment 13237), against real Postgres with every migration and the
 * production guard chain (see the harness).
 *
 * Proves: a manager on terminal B clears a stuck shift opened on terminal A
 * (and a legacy one) as NOT COUNTED, with no `shift_closes` row; the
 * manager / admin envelope is the only credential (a device token, a demoted
 * manager, removed store access and a revoked envelope are the generic 401);
 * tenant / store isolation (the non-disclosing 404); the stuck rule with the
 * caller's own session excluded (409 `shift_not_stuck`); the natural-key
 * replay and 409 `shift_force_closed`; 409 `shift_closed`; the late facts on
 * the opening terminal (close and open re-delivery 409 `shift_force_closed`,
 * another terminal's close 404, a new movement 409 `shift_closed`, an earlier
 * movement's replay 200, a new open 201); a close racing the force close; the
 * audit evidence; and that no log line or audit row carries the reason.
 */
import { randomUUID } from "node:crypto";

import {
  CASHIER,
  CASHIER_B,
  DEV_A1,
  DEV_A1_SECOND,
  DEV_A2,
  DEV_B1,
  MANAGER,
  OPEN_PATH,
  ROLE_A_STAFF,
  admin,
  auditsOf,
  closeBody,
  closePath,
  expectError,
  expectReplay,
  expectSchema,
  forcedClosePath,
  h,
  holdShiftLock,
  managerEnvelope,
  minutesAgo,
  movementBody,
  movementPath,
  newKey,
  openBody,
  openOn,
  post,
  resetState,
  seedLegacyShift,
  seedOperatorSession,
  skipped,
  startHarness,
  stopHarness,
  waitForLockWaiters,
} from "./__support__/shift-http-harness";

beforeAll(() => startHarness("force-close-shift.http"), 240_000);
afterAll(() => stopHarness(), 60_000);
afterEach(() => resetState());

const REASON = "Cashier left without closing; shift opened on till A";

/** A force close of `shiftId` with `bearer` (an envelope, a till token or none). */
function forceClose(call: { bearer: string | null; shiftId: string; reason?: string; key?: string | null }) {
  return post({
    path: forcedClosePath(call.shiftId),
    bearer: call.bearer,
    body: { forcedReason: call.reason ?? REASON },
    key: call.key,
  });
}

/** The shift's lifecycle and whether a cash-up close or a force close is recorded. */
async function stateOf(shiftId: string): Promise<{ lifecycle: string; cashUp: boolean; forced: boolean }> {
  const r = await admin().query<{ lifecycle_state: string; cash_up: boolean; forced: boolean }>(
    `SELECT s.lifecycle_state,
            EXISTS (SELECT 1 FROM shift_closes c WHERE c.shift_id = s.shift_id) AS cash_up,
            EXISTS (SELECT 1 FROM shift_forced_closes f WHERE f.shift_id = s.shift_id) AS forced
       FROM shifts s WHERE s.shift_id = $1`,
    [shiftId],
  );
  const row = r.rows[0];
  return { lifecycle: row?.lifecycle_state ?? "missing", cashUp: row?.cash_up ?? false, forced: row?.forced ?? false };
}

const STILL_OPEN = { lifecycle: "open", cashUp: false, forced: false };
const FORCE_CLOSED = { lifecycle: "closed_forced", cashUp: false, forced: true };

/** No log line and no audit row carries the reason. */
function expectReasonNeverLogged(): void {
  expect(h().logs.lines.filter((line) => line.includes(REASON))).toEqual([]);
  expect(JSON.stringify(h().audit.payloads)).not.toContain(REASON);
}

describe("forceCloseShift — a manager clears a stuck shift from another terminal (201)", () => {
  it("records a not-counted close: the projection, the state, the audit, no cash-up", async () => {
    if (skipped()) return;
    const shiftId = await openOn(DEV_A1);
    const res = await forceClose({ bearer: await managerEnvelope(DEV_A1_SECOND), shiftId });
    expect(res.status).toBe(201);
    expectSchema("ForceClosedShift", res.body);
    expect(res.body).toMatchObject({
      shiftId,
      status: "force_closed",
      currencyCode: "EGP",
      openingFloat: "500.00",
      openingUserId: CASHIER.id,
      forcedClose: {
        closedByUserId: MANAGER.id,
        closedFromTerminalLabel: "till-0002",
        openedOnTerminalLabel: "till-0001",
        forcedReason: REASON,
        cashCount: "not_counted",
      },
    });
    for (const total of ["countedCash", "expectedCash", "variance", "saleCount"]) {
      expect(res.body.forcedClose).not.toHaveProperty(total);
    }
    expect(await stateOf(shiftId)).toEqual(FORCE_CLOSED);
    expect(auditsOf("shift.force_closed").map((p) => [p.actor_user_id, p.store_id, p.metadata])).toEqual([
      [MANAGER.id, DEV_A1.store, { shift_id: shiftId, closed_from_device_id: DEV_A1_SECOND.id, opened_on_device_id: DEV_A1.id, replayed: false }],
    ]);
    expectReasonNeverLogged();
  });

  it("from the terminal that opened it too", async () => {
    if (skipped()) return;
    const shiftId = await openOn(DEV_A1);
    const res = await forceClose({ bearer: await managerEnvelope(DEV_A1), shiftId });
    expect([res.status, res.body.forcedClose?.closedFromTerminalLabel]).toEqual([201, "till-0001"]);
  });

  it("a stuck legacy shift closes the same way, with null currency, float and receipt", async () => {
    if (skipped()) return;
    const shiftId = await seedLegacyShift(DEV_A1);
    const res = await forceClose({ bearer: await managerEnvelope(DEV_A1_SECOND), shiftId });
    expect(res.status).toBe(201);
    expectSchema("ForceClosedShift", res.body);
    expect(res.body).toMatchObject({ currencyCode: null, openingFloat: null, receivedAt: null, status: "force_closed" });
    expect(await stateOf(shiftId)).toEqual(FORCE_CLOSED);
  });

  it("the terminal is free: it opens a new shift (201)", async () => {
    if (skipped()) return;
    const shiftId = await openOn(DEV_A1);
    expect((await forceClose({ bearer: await managerEnvelope(DEV_A1_SECOND), shiftId })).status).toBe(201);
    expect((await post({ path: OPEN_PATH, bearer: DEV_A1.token, body: openBody() })).status).toBe(201);
  });
});

describe("forceCloseShift — the manager / admin envelope is the only credential (generic 401, no 403)", () => {
  /** Runs `prepare` on a fresh stuck shift and the B-terminal envelope; asserts a 401 and nothing recorded. */
  async function expectRefused(prepare: (envelope: string) => Promise<string | null>): Promise<void> {
    const shiftId = await openOn(DEV_A1);
    const envelope = await managerEnvelope(DEV_A1_SECOND);
    const bearer = await prepare(envelope);
    expectError(await forceClose({ bearer, shiftId }), { status: 401, code: "unauthorized" });
    expect(await stateOf(shiftId)).toEqual(STILL_OPEN);
  }

  it.each<[string, (envelope: string) => Promise<string | null>]>([
    ["no bearer", async () => null],
    ["a device token (the device scheme is not accepted)", async () => DEV_A1_SECOND.token],
    ["a manager demoted to store_staff since sign-in", async (envelope) => {
      await admin().query(`UPDATE memberships SET role_id = $2 WHERE id = $1`, [MANAGER.membership, ROLE_A_STAFF]);
      return envelope;
    }],
    ["a manager whose store access was removed", async (envelope) => {
      await admin().query(`DELETE FROM store_access WHERE membership_id = $1`, [MANAGER.membership]);
      return envelope;
    }],
    ["a revoked membership", async (envelope) => {
      await admin().query(`UPDATE memberships SET revoked_at = now() WHERE id = $1`, [MANAGER.membership]);
      return envelope;
    }],
    ["an expired envelope (a stale manager approval)", async (envelope) => {
      await admin().query(`UPDATE auth_tokens SET expires_at = now() - interval '1 second' WHERE scope = 'pos_operator'`);
      return envelope;
    }],
    ["a revoked envelope", async (envelope) => {
      await admin().query(`UPDATE auth_tokens SET revoked_at = now() WHERE scope = 'pos_operator'`);
      return envelope;
    }],
  ])("%s → 401", async (_label, prepare) => {
    if (skipped()) return;
    await expectRefused(prepare);
  });
});

describe("forceCloseShift — tenant and store isolation (non-disclosing 404)", () => {
  it.each([
    ["a shift of another store of the tenant", () => openOn(DEV_A2)],
    ["a shift of another tenant", () => openOn(DEV_B1)],
    ["a legacy shift of another store", () => seedLegacyShift(DEV_A2)],
    ["an unknown id", async () => randomUUID()],
  ])("%s → 404 shift_not_found, nothing recorded", async (_label, seed) => {
    if (skipped()) return;
    const shiftId = await seed();
    expectError(await forceClose({ bearer: await managerEnvelope(DEV_A1), shiftId }), { status: 404, code: "shift_not_found" });
    const r = await admin().query(`SELECT lifecycle_state FROM shifts WHERE shift_id = $1`, [shiftId]);
    expect(r.rows.map((row) => row.lifecycle_state)).toEqual(r.rows.length === 0 ? [] : ["open"]);
  });
});

describe("forceCloseShift — the stuck rule (409 shift_not_stuck)", () => {
  it("a shift younger than the staleness threshold is not stuck", async () => {
    if (skipped()) return;
    const shiftId = await openOn(DEV_A1, { openedAt: minutesAgo(5) });
    const res = await forceClose({ bearer: await managerEnvelope(DEV_A1_SECOND), shiftId });
    expectError(res, { status: 409, code: "shift_not_stuck" });
    expect(await stateOf(shiftId)).toEqual(STILL_OPEN);
  });

  it("the opening cashier's live session on another terminal makes the drawer live", async () => {
    if (skipped()) return;
    const shiftId = await seedLegacyShift(DEV_A1, { user: MANAGER.id });
    await seedOperatorSession(MANAGER, DEV_A1);
    const res = await forceClose({ bearer: await managerEnvelope(DEV_A1_SECOND), shiftId });
    expectError(res, { status: 409, code: "shift_not_stuck" });
  });

  it("the caller's own session does not: a manager clears their own stuck shift", async () => {
    if (skipped()) return;
    const shiftId = await seedLegacyShift(DEV_A1, { user: MANAGER.id });
    const res = await forceClose({ bearer: await managerEnvelope(DEV_A1_SECOND), shiftId });
    expect([res.status, res.body.openingUserId]).toEqual([201, MANAGER.id]);
  });

  it("a session of the cashier on ANOTHER store does not count", async () => {
    if (skipped()) return;
    const shiftId = await seedLegacyShift(DEV_A1, { user: MANAGER.id });
    await seedOperatorSession(MANAGER, DEV_A2);
    expect((await forceClose({ bearer: await managerEnvelope(DEV_A1_SECOND), shiftId })).status).toBe(201);
  });
});

describe("forceCloseShift — replay, conflict and a closed shift", () => {
  it("the same force close under another key, even by the same manager on another terminal: 200 replay of the recorded fact", async () => {
    if (skipped()) return;
    const shiftId = await openOn(DEV_A1);
    const first = await forceClose({ bearer: await managerEnvelope(DEV_A1_SECOND), shiftId });
    const again = await forceClose({ bearer: await managerEnvelope(DEV_A1), shiftId });
    expectReplay(again);
    expectSchema("ForceClosedShift", again.body);
    expect(again.body).toEqual(first.body);
  });

  it("the same key again: the stored 201, replayed", async () => {
    if (skipped()) return;
    const shiftId = await openOn(DEV_A1);
    const envelope = await managerEnvelope(DEV_A1_SECOND);
    const key = newKey();
    const first = await forceClose({ bearer: envelope, shiftId, key });
    const again = await forceClose({ bearer: envelope, shiftId, key });
    expect([again.status, again.headers["idempotent-replayed"], again.body]).toEqual([201, "true", first.body]);
  });

  it("another reason for a force-closed shift: 409 shift_force_closed", async () => {
    if (skipped()) return;
    const shiftId = await openOn(DEV_A1);
    const envelope = await managerEnvelope(DEV_A1_SECOND);
    await forceClose({ bearer: envelope, shiftId });
    expectError(await forceClose({ bearer: envelope, shiftId, reason: "another reason" }), { status: 409, code: "shift_force_closed" });
  });

  it("a shift closed with a cash-up: 409 shift_closed", async () => {
    if (skipped()) return;
    const shiftId = await openOn(DEV_A1);
    expect((await post({ path: closePath(shiftId), bearer: DEV_A1.token, body: closeBody() })).status).toBe(201);
    expectError(await forceClose({ bearer: await managerEnvelope(DEV_A1_SECOND), shiftId }), { status: 409, code: "shift_closed" });
  });

  it.each([
    ["a missing Idempotency-Key", { key: null }, "idempotency_key_required"],
    ["an empty reason", { reason: "" }, "validation_error"],
    ["a reason over 200 characters", { reason: "x".repeat(201) }, "validation_error"],
  ])("%s → 400 %s", async (_label, change, code) => {
    if (skipped()) return;
    const shiftId = await openOn(DEV_A1);
    const res = await forceClose({ bearer: await managerEnvelope(DEV_A1_SECOND), shiftId, ...change });
    expectError(res, { status: 400, code });
    expect(await stateOf(shiftId)).toEqual(STILL_OPEN);
  });

  it("a malformed shift_id → 400 validation_error", async () => {
    if (skipped()) return;
    expectError(await forceClose({ bearer: await managerEnvelope(DEV_A1), shiftId: "not-a-uuid" }), { status: 400, code: "validation_error" });
  });

  it("a total in the body is an unknown key → 400", async () => {
    if (skipped()) return;
    const shiftId = await openOn(DEV_A1);
    const res = await post({
      path: forcedClosePath(shiftId),
      bearer: await managerEnvelope(DEV_A1_SECOND),
      body: { forcedReason: REASON, countedCash: "0.00" },
    });
    expectError(res, { status: 400, code: "validation_error" });
  });
});

describe("forceCloseShift — late facts from the opening terminal (contract, Late facts)", () => {
  /** A shift on DEV_A1 with one recorded movement, force-closed from DEV_A1_SECOND. */
  async function forceClosedShift(): Promise<{ shiftId: string; open: Record<string, unknown>; movement: Record<string, unknown> }> {
    const open = openBody();
    expect((await post({ path: OPEN_PATH, bearer: DEV_A1.token, body: open })).status).toBe(201);
    const shiftId = open["shiftId"] as string;
    const movement = movementBody();
    expect((await post({ path: movementPath(shiftId), bearer: DEV_A1.token, body: movement })).status).toBe(201);
    expect((await forceClose({ bearer: await managerEnvelope(DEV_A1_SECOND), shiftId })).status).toBe(201);
    return { shiftId, open, movement };
  }

  it("the opening terminal's close, any payload → 409 shift_force_closed, nothing recorded", async () => {
    if (skipped()) return;
    const { shiftId } = await forceClosedShift();
    expectError(await post({ path: closePath(shiftId), bearer: DEV_A1.token, body: closeBody() }), { status: 409, code: "shift_force_closed" });
    const precision = closeBody({ countedCash: "2750.001", variance: "-4.999" });
    expectError(await post({ path: closePath(shiftId), bearer: DEV_A1.token, body: precision }), { status: 409, code: "shift_force_closed" });
    expect(await stateOf(shiftId)).toEqual(FORCE_CLOSED);
  });

  it("another terminal's close → the non-disclosing 404", async () => {
    if (skipped()) return;
    const { shiftId } = await forceClosedShift();
    expectError(await post({ path: closePath(shiftId), bearer: DEV_A1_SECOND.token, body: closeBody() }), { status: 404, code: "shift_not_found" });
  });

  it("the open re-delivered under another key → 409 shift_force_closed", async () => {
    if (skipped()) return;
    const { open } = await forceClosedShift();
    expectError(await post({ path: OPEN_PATH, bearer: DEV_A1.token, body: open }), { status: 409, code: "shift_force_closed" });
  });

  it("a new movement → 409 shift_closed; the earlier movement still replays 200", async () => {
    if (skipped()) return;
    const { shiftId, movement } = await forceClosedShift();
    expectError(await post({ path: movementPath(shiftId), bearer: DEV_A1.token, body: movementBody() }), { status: 409, code: "shift_closed" });
    expectReplay(await post({ path: movementPath(shiftId), bearer: DEV_A1.token, body: movement }));
  });
});

describe("forceCloseShift — concurrency on the shift row lock", () => {
  it("a close racing the force close: exactly one wins and the loser gets the matching 409", async () => {
    if (skipped()) return;
    const shiftId = await openOn(DEV_A1);
    const envelope = await managerEnvelope(DEV_A1_SECOND);
    const lock = await holdShiftLock(shiftId);
    const closing = post({ path: closePath(shiftId), bearer: DEV_A1.token, body: closeBody() }).then((r) => r);
    const forcing = forceClose({ bearer: envelope, shiftId }).then((r) => r);
    await waitForLockWaiters(2);
    await lock.release();
    const [close, force] = await Promise.all([closing, forcing]);
    const outcome = [close.status, close.body?.error?.code ?? null, force.status, force.body?.error?.code ?? null];
    expect([
      [201, null, 409, "shift_closed"],
      [409, "shift_force_closed", 201, null],
    ]).toContainEqual(outcome);
    const state = await stateOf(shiftId);
    expect(state.cashUp !== state.forced).toBe(true);
  });

  it("two managers' identical force closes: one 201, one 200 replay", async () => {
    if (skipped()) return;
    const shiftId = await openOn(DEV_A1);
    const [envelopeA, envelopeB] = [await managerEnvelope(DEV_A1), await managerEnvelope(DEV_A1_SECOND)];
    const lock = await holdShiftLock(shiftId);
    const both = Promise.all([forceClose({ bearer: envelopeA, shiftId }), forceClose({ bearer: envelopeB, shiftId })]);
    await waitForLockWaiters(2);
    await lock.release();
    expect((await both).map((r) => r.status).sort()).toEqual([200, 201]);
  });
});

describe("forceCloseShift — rate limit", () => {
  it("is keyed to the calling terminal in the posWriteShift bucket (429)", async () => {
    if (skipped()) return;
    const shiftId = await openOn(DEV_A1);
    const envelope = await managerEnvelope(DEV_A1_SECOND);
    h().limiter.denyKey = DEV_A1_SECOND.id;
    const res = await forceClose({ bearer: envelope, shiftId });
    expect(res.status).toBe(429);
    expect(await stateOf(shiftId)).toEqual(STILL_OPEN);
  });
});

describe("forceCloseShift — a cashier of another tenant never reaches it", () => {
  it("tenant B's till token → 401", async () => {
    if (skipped()) return;
    const shiftId = await openOn(DEV_B1);
    expectError(await forceClose({ bearer: DEV_B1.token, shiftId }), { status: 401, code: "unauthorized" });
    expect(CASHIER_B.tenant).not.toBe(MANAGER.tenant);
  });
});
