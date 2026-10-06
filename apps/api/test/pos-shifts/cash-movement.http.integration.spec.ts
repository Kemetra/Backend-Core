/**
 * recordCashMovement over HTTP — RT-17 slice 2b ([GATED] approval: Jira
 * RT-17 comments 10760 + 10919 + 10920), against real Postgres with every
 * migration (0036 included) and the production guard chain (see the
 * harness).
 *
 * Proves: the device path and the envelope path; the non-disclosing 404
 * across device, store and tenant; idempotency (same key → stored replay;
 * another key, same fact → 200 replay, even after the close, and at any
 * RFC 3339 offset of the same instant; different payload → 409); the
 * replay scoped to the PATH shift (RT-17 comment 10929, P3-5); 409 `shift_closed` for a new movement on a closed shift; strict wire
 * precision against the shift's currency (400); the device-path 403.
 */
import {
  CASHIER,
  CASHIER_UNADMITTED,
  DEV_A1,
  DEV_A1_SECOND,
  DEV_A2,
  DEV_B1,
  MANAGER,
  admin,
  atOffset,
  auditsOf,
  closeOpenShifts,
  expectError,
  expectReplay,
  expectSchema,
  managerEnvelope,
  minutesAgo,
  movementBody,
  movementPath,
  newKey,
  openOn,
  post,
  resetState,
  skipped,
  startHarness,
  stopHarness,
  type FixtureDevice,
} from "./__support__/shift-http-harness";

beforeAll(() => startHarness("cash-movement.http"), 240_000);
afterAll(() => stopHarness(), 60_000);
afterEach(() => resetState());

/** A movement on `shiftId` sent from `device`'s till. */
interface MovementCall {
  readonly device: FixtureDevice;
  readonly shiftId: string;
  readonly body: Record<string, unknown>;
  readonly key?: string;
}

function record(call: MovementCall) {
  return post({ path: movementPath(call.shiftId), bearer: call.device.token, body: call.body, key: call.key });
}

/** The stored row (provenance columns) of the movement a `body` names, or undefined. */
async function movementRow(body: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
  const r = await admin().query(
    `SELECT shift_id, device_id, amount::text AS amount, currency_code, recorded_by_user_id
       FROM shift_cash_movements WHERE id = $1`,
    [body["movementId"]],
  );
  return r.rows[0];
}

describe("recordCashMovement — device path records the movement", () => {
  it("201: the CashMovement projection in the shift's currency, the verified cashier as recorder", async () => {
    if (skipped()) return;
    const shiftId = await openOn(DEV_A1);
    const body = movementBody();
    const res = await record({ device: DEV_A1, shiftId, body });
    expect(res.status).toBe(201);
    expectSchema("CashMovement", res.body);
    expect(res.body).toMatchObject({
      movementId: body["movementId"],
      shiftId,
      kind: "pay_out",
      amount: "120.00",
      currencyCode: "EGP",
      reasonCode: "petty_expense",
      note: "Cleaning supplies",
      recordedByUserId: CASHIER.id,
    });
    const row = await movementRow(body);
    expect(row).toEqual({
      shift_id: shiftId,
      device_id: DEV_A1.id,
      amount: "120.0000",
      currency_code: "EGP",
      recorded_by_user_id: CASHIER.id,
    });
    const audits = auditsOf("shift.cash_movement.recorded");
    expect(audits.map((p) => p.actor_user_id)).toEqual([CASHIER.id]);
  });

  it("a movement without a note has no note in its projection", async () => {
    if (skipped()) return;
    const shiftId = await openOn(DEV_A1);
    const { note: _note, ...body } = movementBody({ kind: "pay_in", reasonCode: "float_top_up" });
    const res = await record({ device: DEV_A1, shiftId, body });
    expect(res.status).toBe(201);
    expectSchema("CashMovement", res.body);
    expect(res.body).not.toHaveProperty("note");
  });

  it("201 on the envelope path: the envelope operator is the recorder", async () => {
    if (skipped()) return;
    const shiftId = await openOn(DEV_A1);
    const envelope = await managerEnvelope(DEV_A1);
    const { operatorUserId: _claim, ...body } = movementBody();
    const res = await post({ path: movementPath(shiftId), bearer: envelope, body });
    expect([res.status, res.body.recordedByUserId]).toEqual([201, MANAGER.id]);
  });
});

describe("recordCashMovement — the shift must resolve to this device (non-disclosing 404)", () => {
  it.each([
    ["another device of the same store", DEV_A1_SECOND],
    ["another store of the same tenant", DEV_A2],
    ["another tenant", DEV_B1],
  ])("a shift of %s is 404 shift_not_found, recording nothing", async (_label, owner) => {
    if (skipped()) return;
    const shiftId = await openOn(owner);
    const body = movementBody();
    expectError(await record({ device: DEV_A1, shiftId, body }), { status: 404, code: "shift_not_found" });
    expect(await movementRow(body)).toBeUndefined();
  });

  it("an unknown shift is the same 404; a malformed shift_id is 400", async () => {
    if (skipped()) return;
    const unknown = "0e170000-0000-4000-8000-0000000ff001";
    expectError(await record({ device: DEV_A1, shiftId: unknown, body: movementBody() }), {
      status: 404,
      code: "shift_not_found",
    });
    expectError(await record({ device: DEV_A1, shiftId: "not-a-uuid", body: movementBody() }), {
      status: 400,
      code: "validation_error",
    });
  });
});

describe("recordCashMovement — idempotency and natural-key dedupe", () => {
  it("the same key and body replays the stored 201", async () => {
    if (skipped()) return;
    const call = { device: DEV_A1, shiftId: await openOn(DEV_A1), body: movementBody(), key: newKey() };
    const first = await record(call);
    const again = await record(call);
    expect([again.status, again.headers["idempotent-replayed"], again.body]).toEqual([201, "true", first.body]);
  });

  it("the same movement under another key is a 200 replay, also after the close", async () => {
    if (skipped()) return;
    const shiftId = await openOn(DEV_A1);
    const body = movementBody({ amount: "120" });
    const first = await record({ device: DEV_A1, shiftId, body });
    const replay = await record({ device: DEV_A1, shiftId, body: { ...body, amount: "120.00" } });
    expectReplay(replay);
    expect(replay.body).toEqual(first.body);
    await closeOpenShifts();
    expectReplay(await record({ device: DEV_A1, shiftId, body }));
  });

  it("an RFC 3339 offset occurredAt is the same instant: projected in UTC, then a 200 replay at any other offset (Codex P2)", async () => {
    if (skipped()) return;
    const shiftId = await openOn(DEV_A1);
    const instant = minutesAgo(30);
    const body = movementBody({ occurredAt: atOffset(instant, 3) });
    const first = await record({ device: DEV_A1, shiftId, body });
    expect([first.status, first.body.occurredAt]).toEqual([201, instant]);
    const replay = await record({ device: DEV_A1, shiftId, body: { ...body, occurredAt: atOffset(instant, -4) } });
    expectReplay(replay);
    expect(replay.body).toEqual(first.body);
  });

  it.each([
    ["amount", "121.00"],
    ["kind", "pay_in"],
    ["note", "Something else"],
  ])("the same movementId with a different %s is 409 shift_payload_conflict", async (field, value) => {
    if (skipped()) return;
    const shiftId = await openOn(DEV_A1);
    const body = movementBody();
    await record({ device: DEV_A1, shiftId, body });
    expectError(await record({ device: DEV_A1, shiftId, body: { ...body, [field]: value } }), {
      status: 409,
      code: "shift_payload_conflict",
    });
  });

  it("a movementId recorded on another shift is 409 shift_payload_conflict, never echoed (RT-17 10929 P3-5)", async () => {
    if (skipped()) return;
    const first = await openOn(DEV_A1);
    const body = movementBody({ amount: "77.00" });
    await record({ device: DEV_A1, shiftId: first, body });
    await closeOpenShifts();
    const second = await openOn(DEV_A1);
    const res = await record({ device: DEV_A1, shiftId: second, body });
    expectError(res, { status: 409, code: "shift_payload_conflict" });
    expect(JSON.stringify(res.body)).not.toContain(first);
    expect((await movementRow(body))?.["shift_id"]).toBe(first);
  });
});

describe("recordCashMovement — a closed shift takes no new movement", () => {
  it("a new movement on a closed shift is 409 shift_closed, recording nothing", async () => {
    if (skipped()) return;
    const shiftId = await openOn(DEV_A1);
    await closeOpenShifts();
    const body = movementBody();
    expectError(await record({ device: DEV_A1, shiftId, body }), { status: 409, code: "shift_closed" });
    expect(await movementRow(body)).toBeUndefined();
  });
});

describe("recordCashMovement — wire precision against the shift currency, and refusals", () => {
  it.each([
    ["EGP", "1.005"],
    ["JPY", "100.5"],
  ])("a %s shift refuses %s as 400 validation_error", async (currencyCode, amount) => {
    if (skipped()) return;
    const shiftId = await openOn(DEV_A1, { currencyCode, openingFloat: "1000" });
    expectError(await record({ device: DEV_A1, shiftId, body: movementBody({ amount }) }), {
      status: 400,
      code: "validation_error",
    });
  });

  it.each([
    ["a zero amount", { amount: "0.00" }],
    ["an unknown reason", { reasonCode: "tips" }],
    ["an empty note", { note: "" }],
    ["a 201-character note", { note: "x".repeat(201) }],
  ])("%s is 400 validation_error", async (_label, overrides) => {
    if (skipped()) return;
    const shiftId = await openOn(DEV_A1);
    expectError(await record({ device: DEV_A1, shiftId, body: movementBody(overrides) }), {
      status: 400,
      code: "validation_error",
    });
  });

  it("a cashier with no covering admission is the generic 403 refused", async () => {
    if (skipped()) return;
    const shiftId = await openOn(DEV_A1);
    const body = movementBody({ operatorUserId: CASHIER_UNADMITTED.id });
    expectError(await record({ device: DEV_A1, shiftId, body }), { status: 403, code: "refused" });
  });
});
