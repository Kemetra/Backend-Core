/**
 * RT-113 BC2 — cashier-admissions runtime, end to end on real PostgreSQL.
 *
 * Covers the BC2 acceptance criteria of RT-113 comment 10763 §5 item 3 and
 * the decisions of comment 10826, against the merged contract
 * `pos-cashier-admissions.openapi.yaml` (every response body is validated
 * with AJV):
 *
 *   - 401 for a missing / unknown / revoked device credential;
 *   - generic 403 `refused` (no oracle) for an unknown user, a user of
 *     another tenant, a deleted user, a revoked membership, an ineligible
 *     role, a store the user cannot access, an inactive store and an
 *     incomplete profile; the cause goes to the audit row, not the body;
 *   - outcome order: a revoked user never sees `active_elsewhere`;
 *   - a second terminal gets `active_elsewhere`; `takeover` ends the first
 *     admission and the first device's heartbeat then gets
 *     `active_elsewhere`;
 *   - same-device re-admission (heartbeat) returns the SAME admission_id and
 *     renews the TTL; the applied TTL and offline grace come from config;
 *   - the server TTL frees the admission (expires_at moved into the past);
 *   - `reconcile_offline`: server arrival order decides, no takeover;
 *   - scope comes from the device row only (tenant, store);
 *   - `end` is idempotent and non-disclosing; only an own admission changes;
 *   - roster: exactly the store's POS-eligible cashiers, minimum disclosure;
 *   - tenant isolation: a tenant-B device cannot see or end tenant-A state.
 *
 * Idempotency, concurrency and the takeover rate limit are in
 * cashier-admissions.idempotency.integration.spec.ts.
 */
import { randomUUID } from "node:crypto";

import {
  CASHIER,
  CASHIER_B,
  CASHIER_OTHER_STORE,
  CASHIER_SPECIFIC,
  DELETED,
  DEV_A1,
  DEV_A1_SECOND,
  DEV_A2,
  DEV_A3,
  DEV_B1,
  DEV_REVOKED,
  MANAGER,
  MANAGER_ROLE_A,
  MUTABLE,
  MUTABLE_SPECIFIC,
  NO_CLERK,
  REVOKED,
  STORE_A1,
  STORE_A2,
  STORE_A3,
  TENANT_A,
  TENANT_B,
  ADMIT,
  ROSTER,
  admissionsFor,
  admitAs,
  admitted,
  auditsFor,
  endAs,
  endPath,
  expectActiveElsewhere,
  expectRefused,
  expectSchema,
  h,
  http,
  liveFor,
  online,
  reconcile,
  resetState,
  rosterAs,
  skipped,
  startHarness,
  stopHarness,
} from "./__support__/admissions-harness";

beforeAll(async () => {
  await startHarness("cashier-admissions.integration.spec");
}, 240_000);

afterAll(async () => {
  await stopHarness();
}, 60_000);

afterEach(async () => {
  await resetState();
});

// ===========================================================================
// 401 — device authentication comes first
// ===========================================================================
describe("device authentication (401)", () => {
  it.each([
    ["missing Authorization", undefined],
    ["unknown device token", "Bearer not-a-device-token-zzzzzzzzzzzz"],
    ["revoked device token", `Bearer ${DEV_REVOKED.token}`],
    ["non-Bearer scheme", `Basic ${DEV_A1.token}`],
  ])("%s → 401 on all three routes, before validation", async (_label, header) => {
    if (skipped()) return;
    const withAuth = <T extends { set: (k: string, v: string) => T }>(r: T): T =>
      header === undefined ? r : r.set("authorization", header);
    // An invalid body and an invalid path id still answer 401: auth runs first.
    const responses = await Promise.all([
      withAuth(http().post(ADMIT)).send({ mode: "bogus" }),
      withAuth(http().post(endPath("not-a-uuid"))),
      withAuth(http().get(ROSTER)),
    ]);
    for (const res of responses) {
      expect(res.status).toBe(401);
      expectSchema("Error", res.body);
      expect(res.body.error.code).toBe("unauthorized");
    }
  });
});

// ===========================================================================
// 400 — request validation (after auth, before eligibility)
// ===========================================================================
describe("request validation (400)", () => {
  it.each<[string, Record<string, unknown>]>([
    ["a client-supplied branch_id", online(CASHIER.id, { branch_id: STORE_A2 })],
    ["a client-supplied tenant_id", online(CASHIER.id, { tenant_id: TENANT_A })],
    ["a PIN on the wire", online(CASHIER.id, { pin: "1234" })],
    ["takeover on reconcile_offline", reconcile(CASHIER.id, { takeover: true })],
    ["offline_admitted_at on online", online(CASHIER.id, { offline_admitted_at: "2026-10-04T08:15:00Z" })],
    ["a short idempotency_key", online(CASHIER.id, { idempotency_key: "short" })],
    ["a non-uuid user_id", online("user_rt113_cashier")],
    ["an unknown mode", { mode: "offline", user_id: CASHIER.id, idempotency_key: "rt113-key-0123456789" }],
  ])("%s → 400 validation_error; nothing recorded", async (_label, body) => {
    if (skipped()) return;
    const res = await admitAs(DEV_A1, body);
    expect(res.status).toBe(400);
    expectSchema("Error", res.body);
    expect(res.body.error.code).toBe("validation_error");
    expect(await admissionsFor(CASHIER.id)).toEqual([]);
  });

  it("an ineligible user with a malformed body gets 400, not 403 (400 precedes eligibility)", async () => {
    if (skipped()) return;
    const res = await admitAs(DEV_A1, online(MANAGER.id, { pin: "1234" }));
    expect(res.status).toBe(400);
  });

  it("end with a malformed admission_id → 400", async () => {
    if (skipped()) return;
    const res = await endAs(DEV_A1, "not-a-uuid");
    expect(res.status).toBe(400);
    expectSchema("Error", res.body);
  });
});

// ===========================================================================
// 403 — eligibility, generic and non-disclosing
// ===========================================================================
describe("eligibility (403 refused, no oracle)", () => {
  const UNKNOWN_USER = randomUUID();
  const cases: Array<[string, () => string, string]> = [
    ["an unknown user", () => UNKNOWN_USER, "membership_inactive"],
    ["a user of another tenant", () => CASHIER_B.id, "membership_inactive"],
    ["a deleted user", () => DELETED.id, "user_deleted"],
    ["a revoked membership", () => REVOKED.id, "membership_inactive"],
    ["an ineligible role (store_manager)", () => MANAGER.id, "role_ineligible"],
    ["a store the user cannot access", () => CASHIER_OTHER_STORE.id, "store_not_accessible"],
    ["a user without a provider subject", () => NO_CLERK.id, "profile_incomplete"],
  ];

  it.each(cases)("%s → 403 refused, audited with the category only", async (_label, userId, category) => {
    if (skipped()) return;
    const requestId = randomUUID();
    const res = await admitAs(DEV_A1, online(userId()), requestId);
    expectRefused(res);
    expect(res.body.error.request_id).toBe(requestId);
    const audits = await auditsFor(requestId);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: "pos.cashier_admission.refused",
      actor_user_id: null,
      tenant_id: TENANT_A,
      store_id: STORE_A1,
      metadata: { device_id: DEV_A1.id, user_id: userId(), category },
    });
    expect(JSON.stringify(audits[0]!.metadata)).not.toMatch(/token|pin|name|email/i);
  });

  it("every refusal body is identical apart from request_id (no oracle)", async () => {
    if (skipped()) return;
    const bodies = [];
    for (const [, userId] of cases) {
      const res = await admitAs(DEV_A1, online(userId()));
      expectRefused(res);
      bodies.push({ ...res.body.error, request_id: "x" });
    }
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
  });

  it("an inactive (soft-deleted) store refuses every cashier", async () => {
    if (skipped()) return;
    await h().admin.query("UPDATE stores SET deleted_at = now() WHERE id = $1", [STORE_A3]);
    const requestId = randomUUID();
    expectRefused(await admitAs(DEV_A3, online(CASHIER.id), requestId));
    expect((await auditsFor(requestId))[0]?.metadata).toMatchObject({ category: "store_inactive" });
  });

  it("specific store access is honoured: the A1-only cashier is admitted at A1, refused at A2", async () => {
    if (skipped()) return;
    admitted(await admitAs(DEV_A1, online(CASHIER_SPECIFIC.id)));
    expectRefused(await admitAs(DEV_A2, online(CASHIER_SPECIFIC.id)));
  });
});

// ===========================================================================
// BC2 AC: device revoked, membership revoked, role ineligible, store removed
// ===========================================================================
describe("revocation mid-session (BC2 AC: 401 / 403)", () => {
  it("device revoked → the heartbeat gets 401", async () => {
    if (skipped()) return;
    admitted(await admitAs(DEV_A1_SECOND, online(MUTABLE.id)));
    await h().admin.query("UPDATE devices SET revoked_at = now() WHERE id = $1", [DEV_A1_SECOND.id]);
    const res = await admitAs(DEV_A1_SECOND, online(MUTABLE.id));
    expect(res.status).toBe(401);
    expectSchema("Error", res.body);
  });

  it("membership revoked → the heartbeat gets 403", async () => {
    if (skipped()) return;
    admitted(await admitAs(DEV_A1, online(MUTABLE.id)));
    await h().admin.query("UPDATE memberships SET revoked_at = now() WHERE id = $1", [MUTABLE.membership]);
    expectRefused(await admitAs(DEV_A1, online(MUTABLE.id)));
  });

  it("role made ineligible → the heartbeat gets 403", async () => {
    if (skipped()) return;
    admitted(await admitAs(DEV_A1, online(MUTABLE.id)));
    await h().admin.query("UPDATE memberships SET role_id = $2 WHERE id = $1", [
      MUTABLE.membership,
      MANAGER_ROLE_A,
    ]);
    expectRefused(await admitAs(DEV_A1, online(MUTABLE.id)));
  });

  it("store access removed → the heartbeat gets 403", async () => {
    if (skipped()) return;
    admitted(await admitAs(DEV_A1, online(MUTABLE_SPECIFIC.id)));
    await h().admin.query("DELETE FROM store_access WHERE membership_id = $1 AND store_id = $2", [
      MUTABLE_SPECIFIC.membership,
      STORE_A1,
    ]);
    expectRefused(await admitAs(DEV_A1, online(MUTABLE_SPECIFIC.id)));
  });

  it("user deleted → the heartbeat gets 403", async () => {
    if (skipped()) return;
    admitted(await admitAs(DEV_A1, online(MUTABLE.id)));
    await h().admin.query("UPDATE users SET deleted_at = now() WHERE id = $1", [MUTABLE.id]);
    expectRefused(await admitAs(DEV_A1, online(MUTABLE.id)));
  });

  it("outcome order: a revoked user never sees active_elsewhere (403 precedes it)", async () => {
    if (skipped()) return;
    admitted(await admitAs(DEV_A1, online(MUTABLE.id)));
    await h().admin.query("UPDATE memberships SET revoked_at = now() WHERE id = $1", [MUTABLE.membership]);
    expectRefused(await admitAs(DEV_A1_SECOND, online(MUTABLE.id)));
    expectRefused(await admitAs(DEV_A1_SECOND, online(MUTABLE.id, { takeover: true })));
    expectRefused(await admitAs(DEV_A1_SECOND, reconcile(MUTABLE.id)));
    // Nothing changed: the first device's admission is untouched.
    const live = await liveFor(MUTABLE.id);
    expect(live.map((a) => a.device_id)).toEqual([DEV_A1.id]);
  });
});

// ===========================================================================
// Admission, single-active, takeover
// ===========================================================================
describe("online admission and the single-active rule", () => {
  it("admits with the contract fields; scope comes from the device row", async () => {
    if (skipped()) return;
    const requestId = randomUUID();
    const before = Date.now();
    const body = admitted(await admitAs(DEV_A1, online(CASHIER.id), requestId));
    expect(body).toMatchObject({
      kind: "admitted",
      display_name: "Mona A.",
      admission_ttl_seconds: 43200,
      offline_grace_seconds: 86400,
    });
    expect(Math.abs(new Date(body.server_time).getTime() - before)).toBeLessThan(60_000);
    const rows = await admissionsFor(CASHIER.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: body.admission_id,
      tenant_id: TENANT_A,
      store_id: STORE_A1,
      device_id: DEV_A1.id,
      mode: "online",
      takeover_of: null,
      ended_at: null,
    });
    const ttlMs = rows[0]!.expires_at.getTime() - new Date(body.server_time).getTime();
    expect(ttlMs).toBe(43200 * 1000);
    const audits = await auditsFor(requestId);
    expect(audits).toEqual([
      expect.objectContaining({
        action: "pos.cashier_admission.admitted",
        actor_user_id: CASHIER.id,
        tenant_id: TENANT_A,
        store_id: STORE_A1,
        target_id: body.admission_id,
        metadata: expect.objectContaining({ device_id: DEV_A1.id, user_id: CASHIER.id, mode: "online" }),
      }),
    ]);
  });

  it("a client-supplied branch_id query parameter is ignored: the store is the device's", async () => {
    if (skipped()) return;
    const res = await http()
      .post(`${ADMIT}?branch_id=${STORE_A2}`)
      .set("authorization", `Bearer ${DEV_A1.token}`)
      .send(online(CASHIER.id));
    const body = admitted(res);
    const rows = await admissionsFor(CASHIER.id);
    expect(rows.map((r) => [r.id, r.store_id])).toEqual([[body.admission_id, STORE_A1]]);
  });

  it("same device re-admission (heartbeat) returns the SAME admission_id and renews the TTL", async () => {
    if (skipped()) return;
    const first = admitted(await admitAs(DEV_A1, online(CASHIER.id)));
    await h().admin.query(
      `UPDATE cashier_admissions
          SET created_at = now() - interval '1 hour', renewed_at = now() - interval '1 hour',
              expires_at = now() + interval '1 hour'
        WHERE id = $1`,
      [first.admission_id],
    );
    const requestId = randomUUID();
    const second = admitted(await admitAs(DEV_A1, online(CASHIER.id), requestId));
    expect(second.admission_id).toBe(first.admission_id);
    const rows = await admissionsFor(CASHIER.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.expires_at.getTime()).toBe(new Date(second.server_time).getTime() + 43200 * 1000);
    expect((await auditsFor(requestId)).map((a) => a.action)).toEqual(["pos.cashier_admission.renewed"]);
  });

  it("the applied TTL and offline grace come from config and are on the wire", async () => {
    if (skipped()) return;
    process.env["CASHIER_ADMISSION_TTL_SECONDS"] = "120";
    process.env["CASHIER_OFFLINE_GRACE_SECONDS"] = "3600";
    const body = admitted(await admitAs(DEV_A1, online(CASHIER.id)));
    expect(body.admission_ttl_seconds).toBe(120);
    expect(body.offline_grace_seconds).toBe(3600);
    const [row] = await admissionsFor(CASHIER.id);
    expect(row!.expires_at.getTime()).toBe(new Date(body.server_time).getTime() + 120_000);
  });

  it("a second terminal gets active_elsewhere and nothing is recorded for it", async () => {
    if (skipped()) return;
    const first = admitted(await admitAs(DEV_A1, online(CASHIER.id)));
    const requestId = randomUUID();
    expectActiveElsewhere(await admitAs(DEV_A1_SECOND, online(CASHIER.id), requestId));
    const live = await liveFor(CASHIER.id);
    expect(live.map((a) => [a.id, a.device_id])).toEqual([[first.admission_id, DEV_A1.id]]);
    expect(await auditsFor(requestId)).toEqual([]);
  });

  it("takeover ends the first admission; the first device's heartbeat then gets active_elsewhere", async () => {
    if (skipped()) return;
    const first = admitted(await admitAs(DEV_A1, online(CASHIER.id)));
    const requestId = randomUUID();
    const taken = admitted(
      await admitAs(DEV_A1_SECOND, online(CASHIER.id, { takeover: true }), requestId),
    );
    expect(taken.admission_id).not.toBe(first.admission_id);

    const rows = await admissionsFor(CASHIER.id);
    const prior = rows.find((r) => r.id === first.admission_id)!;
    const next = rows.find((r) => r.id === taken.admission_id)!;
    expect(prior).toMatchObject({ end_reason: "takeover", device_id: DEV_A1.id });
    expect(prior.ended_at).not.toBeNull();
    expect(next).toMatchObject({ ended_at: null, device_id: DEV_A1_SECOND.id, takeover_of: first.admission_id });

    expect(await auditsFor(requestId)).toEqual([
      expect.objectContaining({
        action: "pos.cashier_admission.takeover",
        actor_user_id: CASHIER.id,
        target_id: taken.admission_id,
        metadata: expect.objectContaining({
          device_id: DEV_A1_SECOND.id,
          user_id: CASHIER.id,
          prior_admission_id: first.admission_id,
        }),
      }),
    ]);

    // The loser learns on its next heartbeat.
    expectActiveElsewhere(await admitAs(DEV_A1, online(CASHIER.id)));
    // And ending its stale admission changes nothing for the winner.
    expect((await endAs(DEV_A1, first.admission_id)).body).toEqual({ kind: "ended" });
    expect((await liveFor(CASHIER.id)).map((a) => a.id)).toEqual([taken.admission_id]);
  });

  it("takeover with no live admission elsewhere simply admits", async () => {
    if (skipped()) return;
    const body = admitted(await admitAs(DEV_A1, online(CASHIER.id, { takeover: true })));
    expect((await liveFor(CASHIER.id)).map((a) => [a.id, a.takeover_of])).toEqual([[body.admission_id, null]]);
  });

  it("the server TTL frees the admission: an expired live row is ended 'expired' and re-claimable", async () => {
    if (skipped()) return;
    const first = admitted(await admitAs(DEV_A1, online(CASHIER.id)));
    await h().admin.query(
      `UPDATE cashier_admissions
          SET created_at = now() - interval '13 hours', renewed_at = now() - interval '13 hours',
              expires_at = now() - interval '1 hour'
        WHERE id = $1`,
      [first.admission_id],
    );
    const requestId = randomUUID();
    const second = admitted(await admitAs(DEV_A1_SECOND, online(CASHIER.id), requestId));
    expect(second.admission_id).not.toBe(first.admission_id);
    const rows = await admissionsFor(CASHIER.id);
    expect(rows.find((r) => r.id === first.admission_id)).toMatchObject({ end_reason: "expired" });
    expect((await liveFor(CASHIER.id)).map((a) => a.device_id)).toEqual([DEV_A1_SECOND.id]);
    const actions = (await auditsFor(requestId)).map((a) => a.action);
    expect(actions).toEqual(["pos.cashier_admission.expired", "pos.cashier_admission.admitted"]);
    // The original device, now on an expired admission, learns on its heartbeat.
    expectActiveElsewhere(await admitAs(DEV_A1, online(CASHIER.id)));
  });

  it("the single-active rule is per store: one cashier may be live in two stores", async () => {
    if (skipped()) return;
    admitted(await admitAs(DEV_A1, online(CASHIER.id)));
    admitted(await admitAs(DEV_A2, online(CASHIER.id)));
    const live = await liveFor(CASHIER.id);
    expect(live.map((a) => a.store_id).sort()).toEqual([STORE_A1, STORE_A2].sort());
  });
});

// ===========================================================================
// reconcile_offline (D8)
// ===========================================================================
describe("reconcile_offline", () => {
  it("with no live admission, records one with its provenance and admits", async () => {
    if (skipped()) return;
    const body = admitted(await admitAs(DEV_A1, reconcile(CASHIER.id)));
    const [row] = await admissionsFor(CASHIER.id);
    expect(row).toMatchObject({ id: body.admission_id, mode: "reconcile_offline", ended_at: null });
    expect(row!.offline_admitted_at?.toISOString()).toBe("2026-10-04T08:15:00.000Z");
  });

  it("the server's live admission wins: a reconcile against it is active_elsewhere", async () => {
    if (skipped()) return;
    const live = admitted(await admitAs(DEV_A1, online(CASHIER.id)));
    expectActiveElsewhere(await admitAs(DEV_A1_SECOND, reconcile(CASHIER.id)));
    expect((await liveFor(CASHIER.id)).map((a) => a.id)).toEqual([live.admission_id]);
  });

  it("two offline terminals: the first to reconcile wins (server arrival order)", async () => {
    if (skipped()) return;
    const winner = admitted(await admitAs(DEV_A1_SECOND, reconcile(CASHIER.id)));
    expectActiveElsewhere(await admitAs(DEV_A1, reconcile(CASHIER.id)));
    expect((await liveFor(CASHIER.id)).map((a) => [a.id, a.device_id])).toEqual([
      [winner.admission_id, DEV_A1_SECOND.id],
    ]);
  });

  it("a reconcile on the device that already holds the admission renews it (same id)", async () => {
    if (skipped()) return;
    const first = admitted(await admitAs(DEV_A1, online(CASHIER.id)));
    const second = admitted(await admitAs(DEV_A1, reconcile(CASHIER.id)));
    expect(second.admission_id).toBe(first.admission_id);
  });
});

// ===========================================================================
// end — idempotent and non-disclosing
// ===========================================================================
describe("end", () => {
  it("ends this device's admission; the next sign-in issues a new admission_id", async () => {
    if (skipped()) return;
    const first = admitted(await admitAs(DEV_A1, online(CASHIER.id)));
    const requestId = randomUUID();
    const res = await endAs(DEV_A1, first.admission_id, requestId);
    expect(res.status).toBe(200);
    expectSchema("PosCashierAdmissionEnded", res.body);
    expect(res.body).toEqual({ kind: "ended" });
    const [row] = await admissionsFor(CASHIER.id);
    expect(row).toMatchObject({ end_reason: "device_end" });
    expect(row!.ended_at).not.toBeNull();
    expect(await auditsFor(requestId)).toEqual([
      expect.objectContaining({
        action: "pos.cashier_admission.ended",
        actor_user_id: CASHIER.id,
        target_id: first.admission_id,
        metadata: expect.objectContaining({
          device_id: DEV_A1.id,
          user_id: CASHIER.id,
          prior_admission_id: first.admission_id,
          changed: true,
        }),
      }),
    ]);
    const next = admitted(await admitAs(DEV_A1, online(CASHIER.id)));
    expect(next.admission_id).not.toBe(first.admission_id);
  });

  it("is idempotent: a repeated end is 200 ended and changes nothing", async () => {
    if (skipped()) return;
    const first = admitted(await admitAs(DEV_A1, online(CASHIER.id)));
    await endAs(DEV_A1, first.admission_id);
    const [before] = await admissionsFor(CASHIER.id);
    const requestId = randomUUID();
    const again = await endAs(DEV_A1, first.admission_id, requestId);
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ kind: "ended" });
    const [after] = await admissionsFor(CASHIER.id);
    expect(after).toEqual(before);
    expect(await auditsFor(requestId)).toEqual([
      expect.objectContaining({
        action: "pos.cashier_admission.ended",
        actor_user_id: null,
        target_id: first.admission_id,
        metadata: { device_id: DEV_A1.id, prior_admission_id: first.admission_id, changed: false },
      }),
    ]);
  });

  it("an unknown admission_id → 200 ended", async () => {
    if (skipped()) return;
    const res = await endAs(DEV_A1, randomUUID());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ kind: "ended" });
  });

  it("another device's admission → 200 ended, and it stays live", async () => {
    if (skipped()) return;
    const theirs = admitted(await admitAs(DEV_A1, online(CASHIER.id)));
    const res = await endAs(DEV_A1_SECOND, theirs.admission_id);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ kind: "ended" });
    expect((await liveFor(CASHIER.id)).map((a) => a.id)).toEqual([theirs.admission_id]);
  });

  it("ending an expired admission records end_reason 'expired'", async () => {
    if (skipped()) return;
    const first = admitted(await admitAs(DEV_A1, online(CASHIER.id)));
    await h().admin.query(
      `UPDATE cashier_admissions
          SET created_at = now() - interval '13 hours', renewed_at = now() - interval '13 hours',
              expires_at = now() - interval '1 hour'
        WHERE id = $1`,
      [first.admission_id],
    );
    await endAs(DEV_A1, first.admission_id);
    const [row] = await admissionsFor(CASHIER.id);
    expect(row).toMatchObject({ end_reason: "expired" });
  });
});

// ===========================================================================
// roster — the store's POS-eligible cashiers, minimum disclosure
// ===========================================================================
describe("roster", () => {
  it("lists exactly the eligible cashiers of the device's store", async () => {
    if (skipped()) return;
    const res = await rosterAs(DEV_A1);
    expect(res.status).toBe(200);
    expectSchema("PosCashierRosterResponse", res.body);
    const entries = (res.body as { cashiers: Array<{ user_id: string }> }).cashiers;
    const sorted = [...entries].sort((a, b) => a.user_id.localeCompare(b.user_id));
    expect(sorted).toEqual(
      [
        { user_id: CASHIER.id, operator_id: CASHIER.clerk, display_name: CASHIER.name },
        { user_id: CASHIER_SPECIFIC.id, operator_id: CASHIER_SPECIFIC.clerk, display_name: CASHIER_SPECIFIC.name },
        { user_id: MUTABLE.id, operator_id: MUTABLE.clerk, display_name: MUTABLE.name },
        { user_id: MUTABLE_SPECIFIC.id, operator_id: MUTABLE_SPECIFIC.clerk, display_name: MUTABLE_SPECIFIC.name },
      ].sort((a, b) => a.user_id.localeCompare(b.user_id)),
    );
  });

  it("the store comes from the device: the A2 till sees the A2 cashiers", async () => {
    if (skipped()) return;
    const res = await rosterAs(DEV_A2);
    const ids = (res.body as { cashiers: Array<{ user_id: string }> }).cashiers.map((c) => c.user_id).sort();
    expect(ids).toEqual([CASHIER.id, CASHIER_OTHER_STORE.id, MUTABLE.id].sort());
  });

  it("roster and admission agree: every roster entry is admissible, every refused user is absent", async () => {
    if (skipped()) return;
    const res = await rosterAs(DEV_A1);
    const ids = (res.body as { cashiers: Array<{ user_id: string }> }).cashiers.map((c) => c.user_id);
    for (const id of ids) {
      admitted(await admitAs(DEV_A1, online(id)));
    }
    for (const u of [CASHIER_OTHER_STORE, MANAGER, DELETED, REVOKED, NO_CLERK, CASHIER_B]) {
      expect(ids).not.toContain(u.id);
      expectRefused(await admitAs(DEV_A1, online(u.id)));
    }
  });

  it("an inactive store has an empty roster", async () => {
    if (skipped()) return;
    await h().admin.query("UPDATE stores SET is_active = false WHERE id = $1", [STORE_A3]);
    const res = await rosterAs(DEV_A3);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ cashiers: [] });
  });
});

// ===========================================================================
// Tenant isolation / RLS
// ===========================================================================
describe("tenant isolation", () => {
  it("a tenant-B device cannot admit, end or list tenant-A cashiers", async () => {
    if (skipped()) return;
    const theirs = admitted(await admitAs(DEV_A1, online(CASHIER.id)));
    expectRefused(await admitAs(DEV_B1, online(CASHIER.id)));
    expectRefused(await admitAs(DEV_B1, online(CASHIER.id, { takeover: true })));
    const ended = await endAs(DEV_B1, theirs.admission_id);
    expect(ended.status).toBe(200);
    expect(ended.body).toEqual({ kind: "ended" });
    expect((await liveFor(CASHIER.id)).map((a) => a.id)).toEqual([theirs.admission_id]);
    const roster = await rosterAs(DEV_B1);
    expect(roster.body).toEqual({
      cashiers: [{ user_id: CASHIER_B.id, operator_id: CASHIER_B.clerk, display_name: CASHIER_B.name }],
    });
  });

  it("a tenant-B device admits its own cashier into tenant B's scope only", async () => {
    if (skipped()) return;
    const body = admitted(await admitAs(DEV_B1, online(CASHIER_B.id)));
    const [row] = await admissionsFor(CASHIER_B.id);
    expect(row).toMatchObject({ id: body.admission_id, tenant_id: TENANT_B, device_id: DEV_B1.id });
  });

  it("RLS: the domain role in tenant B's context sees no tenant-A admission or replay row", async () => {
    if (skipped()) return;
    admitted(await admitAs(DEV_A1, online(CASHIER.id)));
    const client = await h().env.app.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.current_tenant', $1, true)", [TENANT_B]);
      await client.query("SELECT set_config('app.is_platform_admin', 'false', true)");
      const admissions = await client.query("SELECT id FROM cashier_admissions");
      const requests = await client.query("SELECT id FROM cashier_admission_requests");
      const updated = await client.query("UPDATE cashier_admissions SET ended_at = now(), end_reason = 'device_end'");
      expect(admissions.rowCount).toBe(0);
      expect(requests.rowCount).toBe(0);
      expect(updated.rowCount).toBe(0);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    expect(await liveFor(CASHIER.id)).toHaveLength(1);
  });
});


// ===========================================================================
// Time source: the clock is read AFTER the locks (Codex P2 on #697)
// ===========================================================================
describe("time source after the cashier lock", () => {
  /** Hold the cashier's serialisation lock on a separate session. */
  async function holdCashierLock(userId: string) {
    const client = await h().admin.connect();
    const key = `cashier_admission:${TENANT_A}:${STORE_A1}:${userId}`;
    await client.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [key]);
    return {
      async release(): Promise<Date> {
        const r = await client.query<{ at: Date }>("SELECT clock_timestamp() AS at");
        await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [key]);
        client.release();
        return r.rows[0]!.at;
      },
    };
  }

  /** Resolve once the request is blocked on the advisory lock. */
  async function waitUntilBlocked(): Promise<void> {
    for (let i = 0; i < 100; i += 1) {
      const r = await h().admin.query(
        `SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND wait_event = 'advisory'`,
      );
      if (r.rows.length > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("request never blocked on the advisory lock");
  }

  it("an admission that expires while the request waits is expired and re-claimable", async () => {
    if (skipped()) return;
    const first = admitted(await admitAs(DEV_A1, online(CASHIER.id)));
    await h().admin.query(
      `UPDATE cashier_admissions SET expires_at = clock_timestamp() + interval '1 second' WHERE id = $1`,
      [first.admission_id],
    );
    const lock = await holdCashierLock(CASHIER.id);
    const pending = admitAs(DEV_A1_SECOND, online(CASHIER.id)).then((res) => res);
    await waitUntilBlocked();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await lock.release();
    const second = admitted(await pending);
    expect(second.admission_id).not.toBe(first.admission_id);
    const rows = await admissionsFor(CASHIER.id);
    expect(rows.find((r) => r.id === first.admission_id)).toMatchObject({ end_reason: "expired" });
  });

  it("a renewal after waiting gets the full TTL from the moment it is applied", async () => {
    if (skipped()) return;
    const first = admitted(await admitAs(DEV_A1, online(CASHIER.id)));
    const lock = await holdCashierLock(CASHIER.id);
    const pending = admitAs(DEV_A1, online(CASHIER.id)).then((res) => res);
    await waitUntilBlocked();
    await new Promise((resolve) => setTimeout(resolve, 500));
    const releasedAt = await lock.release();
    const renewed = admitted(await pending);
    expect(renewed.admission_id).toBe(first.admission_id);
    const serverTime = new Date(renewed.server_time).getTime();
    expect(serverTime).toBeGreaterThanOrEqual(releasedAt.getTime());
    const [row] = await admissionsFor(CASHIER.id);
    expect(row!.expires_at.getTime()).toBe(serverTime + 43200 * 1000);
  });
});
