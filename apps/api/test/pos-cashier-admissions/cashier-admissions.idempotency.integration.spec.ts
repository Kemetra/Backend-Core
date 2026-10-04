/**
 * RT-113 BC2 — cashier-admissions idempotency, serialisation and the
 * takeover rate limit, on real PostgreSQL.
 *
 * Idempotency (contract `posCreateCashierAdmission` **Idempotency**, 10826
 * decision 2):
 *   - same key + same body → the stored 200, ONLY while that admission is
 *     still live on this device AND the user is still eligible; nothing is
 *     applied again (no second row, no second audit event);
 *   - otherwise the retry is evaluated as new (a new admission, a 403, or
 *     active_elsewhere);
 *   - same key + different body → 409 idempotency_key_conflict;
 *   - the key is scoped to the device;
 *   - of two concurrent same-key requests, exactly one is processed and the
 *     other receives the same outcome.
 *
 * Serialisation (10826 decision 1): concurrent takeovers / sign-ins for one
 * (tenant, store, user) leave exactly one live admission and never fail.
 *
 * Takeover rate limit (contract 429 `rate_limited`): per device, decided
 * before eligibility, nothing applied.
 */
import { randomUUID } from "node:crypto";

import {
  CASHIER,
  DEV_A1,
  DEV_A1_POOL,
  DEV_A1_SECOND,
  MANAGER,
  MUTABLE,
  admissionsFor,
  admitAs,
  admitted,
  auditsFor,
  endAs,
  expectActiveElsewhere,
  expectRefused,
  expectSchema,
  h,
  liveFor,
  newKey,
  online,
  reconcile,
  resetState,
  skipped,
  startHarness,
  stopHarness,
} from "./__support__/admissions-harness";

beforeAll(async () => {
  await startHarness("cashier-admissions.idempotency.integration.spec");
}, 240_000);

afterAll(async () => {
  await stopHarness();
}, 60_000);

afterEach(async () => {
  await resetState();
});

// ===========================================================================
// Replay
// ===========================================================================
describe("idempotent replay", () => {
  it("same key + same body returns the original 200 and applies nothing again", async () => {
    if (skipped()) return;
    const body = online(CASHIER.id);
    const firstId = randomUUID();
    const first = admitted(await admitAs(DEV_A1, body, firstId));
    const replayId = randomUUID();
    const replay = await admitAs(DEV_A1, body, replayId);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(first);
    expect(await admissionsFor(CASHIER.id)).toHaveLength(1);
    expect(await auditsFor(firstId)).toHaveLength(1);
    expect(await auditsFor(replayId)).toEqual([]);
  });

  it("a replayed takeover does not take over again", async () => {
    if (skipped()) return;
    admitted(await admitAs(DEV_A1, online(CASHIER.id)));
    const body = online(CASHIER.id, { takeover: true });
    const taken = admitted(await admitAs(DEV_A1_SECOND, body));
    const replay = await admitAs(DEV_A1_SECOND, body);
    expect(replay.body).toEqual(taken);
    const rows = await admissionsFor(CASHIER.id);
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.end_reason === "takeover")).toHaveLength(1);
  });

  it("omitted takeover and takeover:false are the same body (no 409)", async () => {
    if (skipped()) return;
    const key = newKey();
    const first = admitted(await admitAs(DEV_A1, { mode: "online", user_id: CASHIER.id, idempotency_key: key }));
    const replay = await admitAs(DEV_A1, {
      mode: "online",
      user_id: CASHIER.id,
      takeover: false,
      idempotency_key: key,
    });
    expect(replay.body).toEqual(first);
  });

  it("after the admission ended, the same key is evaluated as new (a new admission)", async () => {
    if (skipped()) return;
    const body = online(CASHIER.id);
    const first = admitted(await admitAs(DEV_A1, body));
    await endAs(DEV_A1, first.admission_id);
    const again = admitted(await admitAs(DEV_A1, body));
    expect(again.admission_id).not.toBe(first.admission_id);
    // The replay entry now points at the new admission.
    expect((await admitAs(DEV_A1, body)).body).toEqual(again);
  });

  it("after a takeover elsewhere, the same key is evaluated as new (active_elsewhere)", async () => {
    if (skipped()) return;
    const body = online(CASHIER.id);
    admitted(await admitAs(DEV_A1, body));
    admitted(await admitAs(DEV_A1_SECOND, online(CASHIER.id, { takeover: true })));
    expectActiveElsewhere(await admitAs(DEV_A1, body));
  });

  it("after the admission expired, the same key is evaluated as new", async () => {
    if (skipped()) return;
    const body = online(CASHIER.id);
    const first = admitted(await admitAs(DEV_A1, body));
    await h().admin.query(
      `UPDATE cashier_admissions
          SET created_at = now() - interval '13 hours', renewed_at = now() - interval '13 hours',
              expires_at = now() - interval '1 hour'
        WHERE id = $1`,
      [first.admission_id],
    );
    const again = admitted(await admitAs(DEV_A1, body));
    expect(again.admission_id).not.toBe(first.admission_id);
  });

  it("when the user is no longer eligible, the replay is refused (403), not replayed", async () => {
    if (skipped()) return;
    const body = online(MUTABLE.id);
    admitted(await admitAs(DEV_A1, body));
    await h().admin.query("UPDATE memberships SET revoked_at = now() WHERE id = $1", [MUTABLE.membership]);
    expectRefused(await admitAs(DEV_A1, body));
  });

  it("a replay entry past its window is not replayed", async () => {
    if (skipped()) return;
    const body = online(CASHIER.id);
    const first = admitted(await admitAs(DEV_A1, body));
    await h().admin.query(
      `UPDATE cashier_admission_requests
          SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour'`,
    );
    // Same admission still live on the device: re-evaluated as a heartbeat.
    const again = admitted(await admitAs(DEV_A1, body));
    expect(again.admission_id).toBe(first.admission_id);
    expect(again.server_time).not.toBe(first.server_time);
  });

  it("a 403 is not recorded: a retry after eligibility is restored is evaluated afresh", async () => {
    if (skipped()) return;
    await h().admin.query("UPDATE memberships SET revoked_at = now() WHERE id = $1", [MUTABLE.membership]);
    const body = online(MUTABLE.id);
    expectRefused(await admitAs(DEV_A1, body));
    await h().admin.query("UPDATE memberships SET revoked_at = NULL WHERE id = $1", [MUTABLE.membership]);
    admitted(await admitAs(DEV_A1, body));
  });

  it("the replay window never exceeds the admission TTL", async () => {
    if (skipped()) return;
    process.env["CASHIER_ADMISSION_TTL_SECONDS"] = "300";
    admitted(await admitAs(DEV_A1, online(CASHIER.id)));
    const r = await h().admin.query<{ window: number }>(
      `SELECT EXTRACT(EPOCH FROM (expires_at - created_at))::int AS window FROM cashier_admission_requests`,
    );
    expect(r.rows.map((x) => x.window)).toEqual([300]);
  });

  it("stores no raw idempotency key", async () => {
    if (skipped()) return;
    const body = online(CASHIER.id);
    admitted(await admitAs(DEV_A1, body));
    const r = await h().admin.query(`SELECT * FROM cashier_admission_requests`);
    expect(JSON.stringify(r.rows)).not.toContain(String(body["idempotency_key"]));
  });
});

// ===========================================================================
// Key reuse with a different body
// ===========================================================================
describe("idempotency key conflict (409)", () => {
  it("same key with a different body → 409 idempotency_key_conflict; nothing applied", async () => {
    if (skipped()) return;
    const key = newKey();
    admitted(await admitAs(DEV_A1, online(CASHIER.id, { idempotency_key: key })));
    const res = await admitAs(DEV_A1, online(CASHIER.id, { idempotency_key: key, takeover: true }));
    expect(res.status).toBe(409);
    expectSchema("Error", res.body);
    expect(res.body.error.code).toBe("idempotency_key_conflict");
    const other = await admitAs(DEV_A1, reconcile(CASHIER.id, { idempotency_key: key }));
    expect(other.status).toBe(409);
    expect(await admissionsFor(CASHIER.id)).toHaveLength(1);
  });

  it("409 precedes eligibility: a reused key for an ineligible user is 409", async () => {
    if (skipped()) return;
    const key = newKey();
    admitted(await admitAs(DEV_A1, online(CASHIER.id, { idempotency_key: key })));
    const res = await admitAs(DEV_A1, online(MANAGER.id, { idempotency_key: key }));
    expect(res.status).toBe(409);
  });

  it("the key is scoped to the device: another device may use the same key", async () => {
    if (skipped()) return;
    const key = newKey();
    admitted(await admitAs(DEV_A1, online(CASHIER.id, { idempotency_key: key })));
    expectActiveElsewhere(await admitAs(DEV_A1_SECOND, online(CASHIER.id, { idempotency_key: key })));
  });
});

// ===========================================================================
// Concurrency
// ===========================================================================
describe("serialisation", () => {
  it("two concurrent same-key requests: one processed, the other gets the same outcome", async () => {
    if (skipped()) return;
    const body = online(CASHIER.id);
    const [a, b] = await Promise.all([admitAs(DEV_A1, body), admitAs(DEV_A1, body)]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body).toEqual(b.body);
    expect(await admissionsFor(CASHIER.id)).toHaveLength(1);
  });

  it("concurrent takeovers from five tills: all answered, exactly one live admission", async () => {
    if (skipped()) return;
    admitted(await admitAs(DEV_A1, online(CASHIER.id)));
    const responses = await Promise.all(
      DEV_A1_POOL.map((d) => admitAs(d, online(CASHIER.id, { takeover: true }))),
    );
    const ids = responses.map((res) => admitted(res).admission_id);
    const live = await liveFor(CASHIER.id);
    expect(live).toHaveLength(1);
    expect(ids).toContain(live[0]!.id);
    const rows = await admissionsFor(CASHIER.id);
    expect(rows.filter((r) => r.ended_at !== null).every((r) => r.end_reason === "takeover")).toBe(true);
    expect(rows).toHaveLength(1 + DEV_A1_POOL.length);
  });

  it("concurrent first sign-ins from five tills: exactly one admitted, the rest active_elsewhere", async () => {
    if (skipped()) return;
    const responses = await Promise.all(DEV_A1_POOL.map((d) => admitAs(d, online(CASHIER.id))));
    for (const res of responses) {
      expect(res.status).toBe(200);
      expectSchema("PosCashierAdmissionResponse", res.body);
    }
    const kinds = responses.map((res) => (res.body as { kind: string }).kind).sort();
    expect(kinds).toEqual(["active_elsewhere", "active_elsewhere", "active_elsewhere", "active_elsewhere", "admitted"]);
    expect(await liveFor(CASHIER.id)).toHaveLength(1);
  });

  it("the database enforces one live admission per (tenant, store, user)", async () => {
    if (skipped()) return;
    const first = admitted(await admitAs(DEV_A1, online(CASHIER.id)));
    const [row] = await admissionsFor(CASHIER.id);
    await expect(
      h().admin.query(
        `INSERT INTO cashier_admissions (id, tenant_id, store_id, user_id, device_id, mode, expires_at)
         VALUES ($1, $2, $3, $4, $5, 'online', now() + interval '1 hour')`,
        [randomUUID(), row!.tenant_id, row!.store_id, CASHIER.id, DEV_A1_SECOND.id],
      ),
    ).rejects.toMatchObject({ code: "23505" });
    expect((await liveFor(CASHIER.id)).map((a) => a.id)).toEqual([first.admission_id]);
  });
});

// ===========================================================================
// Takeover rate limit (429)
// ===========================================================================
describe("takeover rate limit (429)", () => {
  it("over the per-device limit → 429 rate_limited; nothing ended or created", async () => {
    if (skipped()) return;
    process.env["CASHIER_TAKEOVER_RATE_LIMIT"] = "2";
    admitted(await admitAs(DEV_A1, online(CASHIER.id)));
    admitted(await admitAs(DEV_A1_SECOND, online(CASHIER.id, { takeover: true })));
    admitted(await admitAs(DEV_A1, online(CASHIER.id, { takeover: true })));
    const before = await admissionsFor(CASHIER.id);
    admitted(await admitAs(DEV_A1_SECOND, online(CASHIER.id, { takeover: true })));
    const limited = await admitAs(DEV_A1_SECOND, online(CASHIER.id, { takeover: true }));
    expect(limited.status).toBe(429);
    expectSchema("Error", limited.body);
    expect(limited.body.error.code).toBe("rate_limited");
    const after = await admissionsFor(CASHIER.id);
    expect(after).toHaveLength(before.length + 1);
    // Another device has its own budget.
    admitted(await admitAs(DEV_A1_POOL[0]!, online(CASHIER.id, { takeover: true })));
  });

  it("non-takeover requests do not consume the takeover budget", async () => {
    if (skipped()) return;
    process.env["CASHIER_TAKEOVER_RATE_LIMIT"] = "1";
    for (let i = 0; i < 3; i += 1) admitted(await admitAs(DEV_A1, online(CASHIER.id)));
    expectActiveElsewhere(await admitAs(DEV_A1_SECOND, online(CASHIER.id)));
    admitted(await admitAs(DEV_A1_SECOND, online(CASHIER.id, { takeover: true })));
  });

  it("429 precedes eligibility: an over-limit takeover for an ineligible user is 429", async () => {
    if (skipped()) return;
    process.env["CASHIER_TAKEOVER_RATE_LIMIT"] = "1";
    admitted(await admitAs(DEV_A1, online(CASHIER.id, { takeover: true })));
    const res = await admitAs(DEV_A1, online(MANAGER.id, { takeover: true }));
    expect(res.status).toBe(429);
  });

  it("a replayed takeover is not counted against the limit", async () => {
    if (skipped()) return;
    process.env["CASHIER_TAKEOVER_RATE_LIMIT"] = "1";
    const body = online(CASHIER.id, { takeover: true });
    const first = admitted(await admitAs(DEV_A1, body));
    const replay = await admitAs(DEV_A1, body);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(first);
  });
});
