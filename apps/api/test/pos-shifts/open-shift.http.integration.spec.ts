/**
 * openShift over HTTP — RT-17 slice 2b ([GATED] approval: Jira RT-17
 * comments 10760 + 10919 + 10920), against real Postgres with every
 * migration (0036 included) and the production guard chain (see the
 * harness).
 *
 * Proves: the device path and the envelope path; idempotency (same key →
 * stored replay; another key, same fact → 200 replay, at any RFC 3339
 * offset of the same instant; different payload → 409); one open shift per
 * device; the non-disclosing 409 for an out-of-scope `shiftId` (Codex P2,
 * RT-17 comment 10925); legacy adoption answered 201 (RT-17 comment 10929);
 * strict wire precision and RFC 3339 instants (400); the device-path 401 /
 * 403 split; the 400 idempotency codes; the 429 shape; on the envelope
 * path, legacy adoption and an exact replay answered before the stated
 * opener's live check (RT-17 comment 10931).
 */
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
  OPEN_PATH,
  admin,
  atOffset,
  auditsOf,
  closeOpenShifts,
  expectError,
  expectReplay,
  expectSchema,
  h,
  managerEnvelope,
  minutesAgo,
  newKey,
  openBody,
  openOn,
  post,
  resetState,
  skipped,
  startHarness,
  stopHarness,
  type FixtureDevice,
} from "./__support__/shift-http-harness";

beforeAll(() => startHarness("open-shift.http"), 240_000);
afterAll(() => stopHarness(), 60_000);
afterEach(() => resetState());

/** The stored row (provenance columns) of the shift an open `body` names. */
async function shiftRow(body: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
  const r = await admin().query(
    `SELECT source, tenant_id, store_id, opening_device_id, opening_cashier_user_id,
            recorded_by_user_id, opening_float::text AS opening_float, lifecycle_state
       FROM shifts WHERE shift_id = $1`,
    [body["shiftId"]],
  );
  return r.rows[0];
}

/** An open sent from `device`'s till with `body`. */
function openFrom(device: FixtureDevice, body: Record<string, unknown>) {
  return post({ path: OPEN_PATH, bearer: device.token, body });
}

describe("openShift — device path records the open", () => {
  it("201: the Shift projection, the verified cashier as recorder, the device's scope", async () => {
    if (skipped()) return;
    const body = openBody();
    const res = await openFrom(DEV_A1, body);
    expect([res.status, res.headers["idempotent-replayed"]]).toEqual([201, undefined]);
    expectSchema("Shift", res.body);
    expect(res.body).toMatchObject({
      shiftId: body["shiftId"],
      status: "open",
      currencyCode: "EGP",
      openingFloat: "500.00",
      openingUserId: CASHIER.id,
      openedAt: body["openedAt"],
    });
    const row = await shiftRow(body);
    expect(row).toEqual({
      source: "cash_up",
      tenant_id: DEV_A1.tenant,
      store_id: DEV_A1.store,
      opening_device_id: DEV_A1.id,
      opening_cashier_user_id: CASHIER.id,
      recorded_by_user_id: CASHIER.id,
      opening_float: "500.0000",
      lifecycle_state: "open",
    });
    const audits = auditsOf("shift.opened");
    expect(audits.map((p) => [p.actor_user_id, p.tenant_id, p.store_id])).toEqual([
      [CASHIER.id, DEV_A1.tenant, DEV_A1.store],
    ]);
  });

  it.each([
    ["EGP", "500.00", "500.00"],
    ["EGP", "500", "500.00"],
    ["JPY", "5000", "5000"],
    ["KWD", "12.250", "12.250"],
  ])("%s %s is accepted and echoed at the currency's minor unit as %s", async (currencyCode, openingFloat, echoed) => {
    if (skipped()) return;
    const res = await openFrom(DEV_A1, openBody({ currencyCode, openingFloat }));
    expect([res.status, res.body.openingFloat]).toEqual([201, echoed]);
  });
});

describe("openShift — idempotency and natural-key dedupe", () => {
  it("the same Idempotency-Key and body replays the stored 201", async () => {
    if (skipped()) return;
    const call = { path: OPEN_PATH, bearer: DEV_A1.token, body: openBody(), key: newKey() };
    const first = await post(call);
    const again = await post(call);
    expect([again.status, again.headers["idempotent-replayed"]]).toEqual([201, "true"]);
    expect(again.body).toEqual(first.body);
  });

  it("the same open under another key is a 200 replay of the current projection, even after the close", async () => {
    if (skipped()) return;
    const body = openBody({ openingFloat: "500" });
    const first = await openFrom(DEV_A1, body);
    const replay = await openFrom(DEV_A1, { ...body, openingFloat: "500.00" });
    expectReplay(replay);
    expect(replay.body).toEqual(first.body);
    await closeOpenShifts();
    const afterClose = await openFrom(DEV_A1, body);
    expectReplay(afterClose);
    expectSchema("Shift", afterClose.body);
    expect(afterClose.body).toMatchObject({ status: "closed", close: { closeKind: "normal", variance: "0.00" } });
  });

  it.each([
    ["openingFloat", "600.00"],
    ["openedAt", minutesAgo(45)],
    ["currencyCode", "USD"],
  ])("the same shiftId with a different %s is 409 shift_payload_conflict", async (field, value) => {
    if (skipped()) return;
    const body = openBody();
    await openFrom(DEV_A1, body);
    expectError(await openFrom(DEV_A1, { ...body, [field]: value }), { status: 409, code: "shift_payload_conflict" });
  });

  it("an RFC 3339 offset openedAt is the same instant: 201, stored and projected in UTC, then a 200 replay at any other offset (Codex P2)", async () => {
    if (skipped()) return;
    const instant = minutesAgo(60);
    const body = openBody({ openedAt: atOffset(instant, 2) });
    const first = await openFrom(DEV_A1, body);
    expect([first.status, first.body.openedAt]).toEqual([201, instant]);
    const stored = await admin().query(`SELECT opened_at FROM shifts WHERE shift_id = $1`, [body["shiftId"]]);
    expect((stored.rows[0]?.opened_at as Date).toISOString()).toBe(instant);
    for (const openedAt of [atOffset(instant, -5), instant]) {
      const replay = await openFrom(DEV_A1, { ...body, openedAt });
      expectReplay(replay);
      expect(replay.body).toEqual(first.body);
    }
  });

  it("the same key with a different body is 409 idempotency_key_conflict", async () => {
    if (skipped()) return;
    const key = newKey();
    await post({ path: OPEN_PATH, bearer: DEV_A1.token, body: openBody(), key });
    const res = await post({ path: OPEN_PATH, bearer: DEV_A1.token, body: openBody(), key });
    expectError(res, { status: 409, code: "idempotency_key_conflict" });
  });

  it("a second open shift on the same device is 409 shift_already_open; another device is unaffected", async () => {
    if (skipped()) return;
    await openOn(DEV_A1);
    expectError(await openFrom(DEV_A1, openBody()), { status: 409, code: "shift_already_open" });
    expect((await openFrom(DEV_A1_SECOND, openBody())).status).toBe(201);
  });
});

describe("openShift — an out-of-scope shiftId is never disclosed (Codex P2, RT-17 10925)", () => {
  it.each([
    ["another device of the same store", DEV_A1_SECOND, CASHIER.id],
    ["another store of the same tenant", DEV_A2, CASHIER.id],
    ["another tenant", DEV_B1, CASHIER_B.id],
  ])("the shiftId of a shift on %s is 409 shift_payload_conflict, without a projection", async (_label, other, user) => {
    if (skipped()) return;
    const body = openBody();
    await openFrom(DEV_A1, body);
    const res = await openFrom(other, { ...body, openingUserId: user, operatorUserId: user });
    expectError(res, { status: 409, code: "shift_payload_conflict" });
    expect(JSON.stringify(res.body)).not.toContain("500.00");
    expect((await shiftRow(body))?.["opening_device_id"]).toBe(DEV_A1.id);
  });
});

describe("openShift — adopts the audit-ingest legacy row of the same shift (RT-17 10929, option b)", () => {
  /** A legacy (audit-ingest `shift.open`) row. */
  async function seedLegacy(row: { shiftId: string; device: FixtureDevice; openedAt: string }): Promise<void> {
    await admin().query(
      `INSERT INTO shifts (shift_id, tenant_id, store_id, opening_cashier_user_id, opening_device_id, opened_at)
       VALUES ($1, $2, $3, $4, $5, $6::timestamptz)`,
      [row.shiftId, row.device.tenant, row.device.store, CASHIER.id, row.device.id, row.openedAt],
    );
  }

  it("the same tenant, store, device, opened_at and opener → 201 like a first open; the row is now cash_up", async () => {
    if (skipped()) return;
    const body = openBody();
    await seedLegacy({ shiftId: body["shiftId"] as string, device: DEV_A1, openedAt: body["openedAt"] as string });
    const res = await openFrom(DEV_A1, body);
    expect(res.status).toBe(201);
    expectSchema("Shift", res.body);
    expect(await shiftRow(body)).toMatchObject({ source: "cash_up", recorded_by_user_id: CASHIER.id });
  });

  it("on the manager envelope path too: 201, the row is now cash_up, recorded by the envelope operator (RT-17 10931)", async () => {
    if (skipped()) return;
    const { operatorUserId: _claim, ...body } = openBody();
    await seedLegacy({ shiftId: body["shiftId"] as string, device: DEV_A1, openedAt: body["openedAt"] as string });
    const res = await post({ path: OPEN_PATH, bearer: await managerEnvelope(DEV_A1), body });
    expect(res.status).toBe(201);
    expectSchema("Shift", res.body);
    expect(await shiftRow(body)).toMatchObject({
      source: "cash_up",
      opening_cashier_user_id: CASHIER.id,
      recorded_by_user_id: MANAGER.id,
    });
  });

  it.each([
    ["of another device", { device: DEV_A1_SECOND, openedAt: null }],
    ["with another opened_at", { device: DEV_A1, openedAt: minutesAgo(90) }],
  ])("a legacy row %s is 409 shift_payload_conflict and stays legacy", async (_label, legacy) => {
    if (skipped()) return;
    const body = openBody();
    const openedAt = legacy.openedAt ?? (body["openedAt"] as string);
    await seedLegacy({ shiftId: body["shiftId"] as string, device: legacy.device, openedAt });
    expectError(await openFrom(DEV_A1, body), { status: 409, code: "shift_payload_conflict" });
    expect((await shiftRow(body))?.["source"]).toBe("legacy");
  });
});

describe("openShift — wire precision and strict body (400)", () => {
  it.each([
    ["more fractional digits than EGP's 2", { openingFloat: "500.000" }],
    ["a fraction on JPY (0 digits)", { currencyCode: "JPY", openingFloat: "500.5" }],
    ["a currency with no ISO-4217 minor unit", { currencyCode: "XAU", openingFloat: "1" }],
    ["an unknown key (a scope field)", { storeId: DEV_A2.store }],
    ["a negative float", { openingFloat: "-1.00" }],
    ["a non-RFC 3339 offset (+0200)", { openedAt: "2026-10-05T10:00:00+0200" }],
    ["an out-of-range offset (+24:00)", { openedAt: "2026-10-05T10:00:00+24:00" }],
  ])("%s is 400 validation_error", async (_label, overrides) => {
    if (skipped()) return;
    expectError(await openFrom(DEV_A1, openBody(overrides)), { status: 400, code: "validation_error" });
  });

  it.each([
    ["missing", "idempotency_key_required", null],
    ["malformed", "idempotency_key_malformed", "short key"],
  ])("a %s Idempotency-Key is 400 %s", async (_label, code, key) => {
    if (skipped()) return;
    expectError(await post({ path: OPEN_PATH, bearer: DEV_A1.token, body: openBody(), key }), { status: 400, code });
  });
});

describe("openShift — device path 401 / 403 split", () => {
  it.each([
    ["no bearer", null],
    ["an unknown device token", "not-a-device-token"],
  ])("%s with operatorUserId is the generic 401", async (_label, bearer) => {
    if (skipped()) return;
    expectError(await post({ path: OPEN_PATH, bearer, body: openBody() }), { status: 401, code: "unauthorized" });
  });

  it("an envelope that carries operatorUserId is the generic 401", async () => {
    if (skipped()) return;
    const envelope = await managerEnvelope();
    expectError(await post({ path: OPEN_PATH, bearer: envelope, body: openBody() }), { status: 401, code: "unauthorized" });
  });

  it.each([
    ["no covering admission", { openingUserId: CASHIER_UNADMITTED.id, operatorUserId: CASHIER_UNADMITTED.id }],
    ["openingUserId other than operatorUserId", { openingUserId: CASHIER_UNADMITTED.id }],
    ["a fact before every admission window", { openedAt: minutesAgo(3 * 24 * 60) }],
    ["a cashier of another tenant", { openingUserId: CASHIER_B.id, operatorUserId: CASHIER_B.id }],
  ])("%s is the generic 403 refused, recording nothing", async (_label, overrides) => {
    if (skipped()) return;
    const body = openBody(overrides);
    expectError(await openFrom(DEV_A1, body), { status: 403, code: "refused" });
    expect(await shiftRow(body)).toBeUndefined();
  });
});

describe("openShift — manager envelope (repair) path", () => {
  it("201: the stated opener is recorded, the envelope operator is the recorder", async () => {
    if (skipped()) return;
    const envelope = await managerEnvelope(DEV_A1);
    const { operatorUserId: _claim, ...body } = openBody();
    const res = await post({ path: OPEN_PATH, bearer: envelope, body });
    expect(res.status).toBe(201);
    expect(await shiftRow(body)).toMatchObject({
      opening_device_id: DEV_A1.id,
      opening_cashier_user_id: CASHIER.id,
      recorded_by_user_id: MANAGER.id,
    });
  });

  it.each([
    ["without access to the store", CASHIER_A2_ONLY.id],
    ["of another tenant", CASHIER_B.id],
  ])("an opener %s is the generic 403 refused", async (_label, openingUserId) => {
    if (skipped()) return;
    const envelope = await managerEnvelope(DEV_A1);
    const { operatorUserId: _claim, ...body } = openBody({ openingUserId });
    expectError(await post({ path: OPEN_PATH, bearer: envelope, body }), { status: 403, code: "refused" });
  });

  it.each([
    ["the same open", {}, 200],
    ["a different open of the same shiftId", { openingFloat: "600.00" }, 403],
  ])(
    "after the stated opener's access is revoked, %s → %i (an exact replay is answered before the live check, RT-17 10931 #4)",
    async (_label, change, status) => {
      if (skipped()) return;
      const envelope = await managerEnvelope(DEV_A1);
      const { operatorUserId: _claim, ...body } = openBody();
      expect((await post({ path: OPEN_PATH, bearer: envelope, body })).status).toBe(201);
      await admin().query(`UPDATE memberships SET revoked_at = now() WHERE id = $1`, [CASHIER.membership]);
      const res = await post({ path: OPEN_PATH, bearer: envelope, body: { ...body, ...change } });
      expect(res.status).toBe(status);
    },
  );
});

describe("openShift — rate limit", () => {
  it("over the per-device limit is 429 RATE_LIMITED with Retry-After", async () => {
    if (skipped()) return;
    h().limiter.denyKey = DEV_A1.id;
    const res = await openFrom(DEV_A1, openBody());
    expectError(res, { status: 429, code: "RATE_LIMITED" });
    expect(Number(res.headers["retry-after"])).toBeGreaterThanOrEqual(1);
  });
});
