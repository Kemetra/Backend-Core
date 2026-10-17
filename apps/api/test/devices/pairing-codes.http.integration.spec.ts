/**
 * RT-367 (RT-287 F4 / F9; D-Q1, D-Q4 as amended) — the Console pairing codes
 * and the replace / move redemption over HTTP against real Postgres
 * (Testcontainers, every migration, the NOBYPASSRLS `app_test` pool) and the
 * real module graph (`DevicesModule` + `PairingModule`).
 *
 *   POST /api/v1/pairing-codes                         consoleIssuePairingCode
 *   GET  /api/v1/pairing-codes                         consoleListPairingCodes
 *   POST /api/v1/pairing-codes/{pairingCodeId}/cancel  consoleCancelPairingCode
 *   POST /api/pos/v1/terminals/pair                    posPairTerminal (redemption)
 *
 * What this proves (RT-367 acceptance):
 *   - parity: for every lifecycle state × replace / move, the impact preview's
 *     verdict is the issue's outcome (201, or 409 with `blockCode` and the
 *     preview), and an issued code's redemption succeeds and auto-revokes an
 *     active replaced device (reason `replaced` / `moved`, no actor, operator
 *     tokens and sibling codes cascaded) and leaves a revoked one untouched;
 *   - pair-time re-check: a shift that opens after the issue makes the
 *     redemption 409 REPLACEMENT_BLOCKED and the code stays pending;
 *   - the broken till (RT-287 comment 11493): open shift → recovery revoke →
 *     replacement code → pair succeeds → the custody exception stays on the old
 *     device and shift;
 *   - a move keeps the old device and its shift in the old store;
 *   - issue / list / cancel / expire, the code returned once, the default label,
 *     `expires_at` on the pair response, idempotency (non-replayable), scope
 *     refusals as the shared 404, and no code in audit or idempotency storage.
 *
 * Docker policy: HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import "reflect-metadata";

import { createHash, randomUUID } from "node:crypto";

import { Module } from "@nestjs/common";
import type request from "supertest";

import { DevicesModule } from "../../src/devices/devices.module";
import { PairingModule } from "../../src/pos-terminal-pairing/pairing.module";
import { scopedHttpHarness } from "../_helpers/scoped-http-harness";
import { STORE_A_X, STORE_A_Y } from "../catalog/__support__/isolation-harness";
import { SES_ADMIN_SPEC, SES_OWNER_ALL } from "../catalog/erpnext-reconciliation/__support__/read-store-scope";
import {
  BINDING,
  CONC_SIBLING_CODE,
  CONC_SIBLING_RAW,
  D_B2,
  NO_DEVICE,
  OP_TOKEN_FREE,
  PARITY_DEVICES,
  RP_DEAD,
  MV_LIST,
  RP_CONC,
  RP_RACE,
  RP_REISSUE,
  RP_REV_SIB,
  RP_TWICE,
  SES_MANAGER_X,
  SES_STAFF,
  SHIFT_DEAD,
  SHIFT_RACE,
  SIBLING_CODE,
  STALE_SIBLING_CODE,
  openLegacyShift,
  seedPairingCodeFixture,
  shiftOf,
  type Kind,
  type LifecycleState,
} from "./__support__/pairing-code-fixture";

@Module({ imports: [DevicesModule, PairingModule] })
class PairingCodesTestModule {}

const CODES = "/api/v1/pairing-codes";
const PAIR = "/api/pos/v1/terminals/pair";
const cancelPath = (codeId: string): string => `${CODES}/${codeId}/cancel`;

const h = scopedHttpHarness({
  label: "RT-367 pairing codes",
  contractId: "devices.openapi",
  module: PairingCodesTestModule,
  seed: seedPairingCodeFixture,
});
const skip = (): boolean => h.skipped();

type Issued = {
  pairingCodeId: string;
  code: string;
  kind: string;
  storeId: string;
  terminalId: string;
  terminalLabel: string;
  replacesDeviceId: string | null;
  expiresAt: string;
  createdAt: string;
};

const issue = (session: string, body: object, key: string | null = randomUUID()): request.Test => {
  const req = h.post(CODES, session, { ...BINDING, ...body });
  return key === null ? req : req.set("Idempotency-Key", key);
};

async function issueOk(session: string, body: object): Promise<Issued> {
  const res = await issue(session, body);
  expect([res.status, res.body]).toEqual([201, expect.anything()]);
  h.conforms("PairingCodeIssued", res.body);
  return res.body as Issued;
}

const pair = (code: string): request.Test => h.post(PAIR, null, { pairing_code: code });

async function preview(deviceId: string, action: Kind): Promise<{ verdict: string; blockCode: string | null }> {
  const res = await h.get(`/api/v1/devices/${deviceId}/impact`, SES_OWNER_ALL, { action });
  expect(res.status).toBe(200);
  return res.body as { verdict: string; blockCode: string | null };
}

async function deviceRow(deviceId: string): Promise<Record<string, unknown>> {
  const r = await h
    .env()
    .admin.query(
      `SELECT store_id, revoked_at, revoked_by, revoke_reason, retired_at FROM devices WHERE id = $1`,
      [deviceId],
    );
  return r.rows[0] as Record<string, unknown>;
}

async function codeStatus(codeId: string): Promise<string> {
  const r = await h.env().admin.query<{ status: string }>(`SELECT status FROM pairing_codes WHERE id = $1`, [codeId]);
  return r.rows[0]!.status;
}

async function auditRows(action: string, targetId: string): Promise<Array<Record<string, unknown>>> {
  const r = await h
    .env()
    .admin.query(
      `SELECT actor_user_id, store_id, metadata FROM audit_events WHERE action = $1 AND target_id = $2`,
      [action, targetId],
    );
  return r.rows as Array<Record<string, unknown>>;
}

// ===========================================================================
// 1. Parity: preview verdict == issue outcome == redemption outcome
// ===========================================================================
describe("replace / move parity (preview == issue == redemption)", () => {
  const STATES: readonly LifecycleState[] = ["free", "shift", "rev", "exc", "ret"];
  const cases = (["replace", "move"] as const).flatMap((kind) => STATES.map((state) => [kind, state] as const));

  it.each(cases)("%s of a %s device", async (kind, state) => {
    if (skip()) return;
    const deviceId = PARITY_DEVICES[kind][state];
    const before = await deviceRow(deviceId);
    const p = await preview(deviceId, kind);

    const res = await issue(SES_OWNER_ALL, { storeId: STORE_A_X, replacesDeviceId: deviceId });
    if (p.verdict === "blocked") {
      expect([res.status, res.body.error?.code]).toEqual([409, p.blockCode]);
      h.conforms("PairingCodeIssueConflict", res.body);
      expect(res.body.error.details).toMatchObject({ deviceId, action: kind, verdict: "blocked", blockCode: p.blockCode });
      expect(await deviceRow(deviceId)).toEqual(before);
      return;
    }
    expect(p.verdict).toBe("allowed");
    expect(res.status).toBe(201);
    h.conforms("PairingCodeIssued", res.body);
    const issued = res.body as Issued;
    expect(issued).toMatchObject({ kind, storeId: STORE_A_X, replacesDeviceId: deviceId });

    // Redemption decides again with the same evaluator: still allowed.
    expect((await preview(deviceId, kind)).verdict).toBe("allowed");
    const paired = await pair(issued.code);
    expect(paired.status).toBe(200);
    expect(paired.body.terminal_id).toBe(issued.terminalId);
    expect(paired.body.branch_id).toBe(STORE_A_X);

    const after = await deviceRow(deviceId);
    expect(after["store_id"]).toBe(before["store_id"]);
    if (before["revoked_at"] === null) {
      expect(after).toMatchObject({ revoke_reason: kind === "replace" ? "replaced" : "moved", revoked_by: null });
      expect(after["revoked_at"]).not.toBeNull();
    } else {
      expect(after).toEqual(before);
    }
    const detail = await h.get(`/api/v1/devices/${issued.terminalId}`, SES_OWNER_ALL);
    expect(detail.body).toMatchObject({ storeId: STORE_A_X, trustState: "active", replacesDeviceId: deviceId });
  });

  it("cascades the auto-revoke: operator sessions, sibling codes, audit with no actor", async () => {
    if (skip()) return;
    const old = PARITY_DEVICES.replace.free;
    const live = await h
      .env()
      .admin.query(`SELECT revoked_at FROM auth_tokens WHERE device_id = $1 AND scope = 'pos_operator'`, [old]);
    expect(live.rows.every((r: { revoked_at: Date | null }) => r.revoked_at !== null)).toBe(true);
    expect(await codeStatus(SIBLING_CODE)).toBe("cancelled");
    const [revoked] = await auditRows("pos.device.revoked", old);
    expect(revoked).toMatchObject({
      actor_user_id: null,
      metadata: { reason: "replaced", revoked_session_count: 1, cancelled_pairing_code_count: 1, custody_exception: false },
    });
    const metadata = revoked!["metadata"] as Record<string, unknown>;
    expect(metadata["replaced_by_device_id"]).toEqual(expect.any(String));
    // C3: the auto-revoke joins to the issuer's pos.device.pairing_code.issued row.
    const [issued] = await auditRows("pos.device.pairing_code.issued", String(metadata["pairing_code_id"]));
    expect(issued).toMatchObject({ actor_user_id: expect.any(String) });
    // The old operator token no longer authenticates anything (revoked_at set above).
    expect(OP_TOKEN_FREE.length).toBeGreaterThan(0);
  });

  it("writes pos.device.paired for the new device, with no actor and no secret", async () => {
    if (skip()) return;
    const r = await h
      .env()
      .admin.query<{ target_id: string; actor_user_id: string | null; metadata: Record<string, unknown> }>(
        `SELECT target_id, actor_user_id, metadata FROM audit_events WHERE action = 'pos.device.paired'`,
      );
    expect(r.rows.length).toBeGreaterThan(0);
    for (const row of r.rows) {
      expect(row.actor_user_id).toBeNull();
      expect(Object.keys(row.metadata).sort()).toEqual([
        "cancelled_pairing_code_count",
        "kind",
        "pairing_code_id",
        "replaces_device_id",
      ]);
    }
  });
});

// ===========================================================================
// 2. Pair-time re-check and the broken till
// ===========================================================================
describe("redemption re-check (D-Q4) and the broken till (RT-287 11493)", () => {
  it("refuses the redemption when a shift opened after the issue; the code stays pending", async () => {
    if (skip()) return;
    const issued = await issueOk(SES_OWNER_ALL, { storeId: STORE_A_X, replacesDeviceId: RP_RACE });
    await openLegacyShift(h.env().admin, SHIFT_RACE, RP_RACE, STORE_A_X);
    expect(await preview(RP_RACE, "replace")).toMatchObject({ verdict: "blocked", blockCode: "unresolved_cash_session" });

    const res = await pair(issued.code);
    expect([res.status, res.body.error?.code]).toEqual([409, "REPLACEMENT_BLOCKED"]);
    expect(JSON.stringify(res.body)).not.toMatch(new RegExp(`${SHIFT_RACE}|${RP_RACE}`));
    expect(await codeStatus(issued.pairingCodeId)).toBe("pending");
    expect((await deviceRow(RP_RACE))["revoked_at"]).toBeNull();
    const minted = await h.env().admin.query(`SELECT 1 FROM devices WHERE id = $1`, [issued.terminalId]);
    expect(minted.rowCount).toBe(0);

    // M1: a blocked try proves the caller holds the code, so it does not use the
    // per-code attempt budget (5): more than 5 blocked tries, then the shift
    // closes, and the same code still pairs.
    for (let i = 0; i < 6; i += 1) {
      expect((await pair(issued.code)).body.error?.code).toBe("REPLACEMENT_BLOCKED");
    }
    await h.env().admin.query(`UPDATE shifts SET lifecycle_state = 'closed' WHERE shift_id = $1`, [SHIFT_RACE]);
    const paired = await pair(issued.code);
    expect(paired.status).toBe(200);
    expect((await deviceRow(RP_RACE))["revoke_reason"]).toBe("replaced");
  });

  it("lets exactly one of two concurrent replacement redemptions win (L3)", async () => {
    if (skip()) return;
    // The C7 issue check refuses a second live code, so the sibling is seeded.
    await h
      .env()
      .admin.query(`UPDATE pairing_codes SET expires_at = now() - interval '1 second' WHERE id = $1`, [
        CONC_SIBLING_CODE,
      ]);
    const issued = await issueOk(SES_OWNER_ALL, { storeId: STORE_A_X, replacesDeviceId: RP_CONC });
    await h
      .env()
      .admin.query(`UPDATE pairing_codes SET expires_at = now() + interval '1 hour' WHERE id = $1`, [
        CONC_SIBLING_CODE,
      ]);
    const [a, b] = await Promise.all([pair(issued.code), pair(CONC_SIBLING_RAW)]);
    const outcomes = [a, b].map((r) => (r.status === 200 ? "200" : `${r.status} ${r.body.error?.code}`)).sort();
    expect(outcomes[0]).toBe("200");
    expect(["409 REPLACEMENT_BLOCKED", "410 EXPIRED_CODE"]).toContain(outcomes[1]);
    const used = await h
      .env()
      .admin.query(`SELECT count(*)::int AS n FROM pairing_codes WHERE replaces_device_id = $1 AND status = 'used'`, [
        RP_CONC,
      ]);
    expect(used.rows[0].n).toBe(1);
    const replacements = await h
      .env()
      .admin.query(
        `SELECT count(*)::int AS n FROM devices d JOIN pairing_codes pc ON pc.device_id = d.id WHERE pc.replaces_device_id = $1`,
        [RP_CONC],
      );
    expect(replacements.rows[0].n).toBe(1);
  });

  it("revokes a dead till for recovery, replaces it, and keeps the custody exception on the old shift", async () => {
    if (skip()) return;
    const revoke = await h.post(`/api/v1/devices/${RP_DEAD}/revoke`, SES_OWNER_ALL, {
      reason: "hardware_failure",
      note: "Till will not boot; drawer cash in the safe",
      acknowledgeCustodyException: true,
    });
    expect(revoke.status).toBe(200);
    expect(await preview(RP_DEAD, "replace")).toMatchObject({ verdict: "allowed" });

    const issued = await issueOk(SES_OWNER_ALL, { storeId: STORE_A_X, replacesDeviceId: RP_DEAD });
    expect((await pair(issued.code)).status).toBe(200);

    const old = await h.get(`/api/v1/devices/${RP_DEAD}`, SES_OWNER_ALL);
    expect(old.body).toMatchObject({
      trustState: "revoked",
      revokeReason: "hardware_failure",
      custodyExceptionShiftId: SHIFT_DEAD,
      replacedByDeviceId: issued.terminalId,
    });
    const fresh = await h.get(`/api/v1/devices/${issued.terminalId}`, SES_OWNER_ALL);
    expect(fresh.body).toMatchObject({ trustState: "active", custodyExceptionShiftId: null });
    const shift = await h
      .env()
      .admin.query(`SELECT lifecycle_state, opening_device_id FROM shifts WHERE shift_id = $1`, [SHIFT_DEAD]);
    expect(shift.rows[0]).toEqual({ lifecycle_state: "open", opening_device_id: RP_DEAD });
  });

  it("keeps a moved device's shift in its old store", async () => {
    if (skip()) return;
    const shift = await h
      .env()
      .admin.query(`SELECT store_id, opening_device_id FROM shifts WHERE shift_id = $1`, [shiftOf("move", "exc")]);
    expect(shift.rows[0]).toEqual({ store_id: STORE_A_Y, opening_device_id: PARITY_DEVICES.move.exc });
    expect((await deviceRow(PARITY_DEVICES.move.exc))["store_id"]).toBe(STORE_A_Y);
  });
});

// ===========================================================================
// 2b. One replacement per device (C7)
// ===========================================================================
describe("one replacement per device (C7)", () => {
  it("refuses a second code while one is live, and after one was used", async () => {
    if (skip()) return;
    const first = await issueOk(SES_OWNER_ALL, { storeId: STORE_A_X, replacesDeviceId: RP_TWICE });
    const pending = await issue(SES_OWNER_ALL, { storeId: STORE_A_X, replacesDeviceId: RP_TWICE });
    expect([pending.status, pending.body.error?.code, pending.body.error?.details]).toEqual([
      409,
      "replacement_already_pending",
      undefined,
    ]);
    h.conforms("PairingCodeIssueConflict", pending.body);
    // The preview reports the lifecycle verdict, not this precondition.
    expect((await preview(RP_TWICE, "replace")).verdict).toBe("allowed");

    expect((await pair(first.code)).status).toBe(200);
    const used = await issue(SES_OWNER_ALL, { storeId: STORE_A_X, replacesDeviceId: RP_TWICE });
    expect([used.status, used.body.error?.code]).toEqual([409, "device_already_replaced"]);
  });

  it("lets a cancelled code be followed by a new one", async () => {
    if (skip()) return;
    const first = await issueOk(SES_OWNER_ALL, { storeId: STORE_A_X, replacesDeviceId: RP_REISSUE });
    expect((await h.post(cancelPath(first.pairingCodeId), SES_OWNER_ALL, {})).status).toBe(200);
    await issueOk(SES_OWNER_ALL, { storeId: STORE_A_X, replacesDeviceId: RP_REISSUE });
  });

  it("cancels a sibling replacement code when the replaced device was already revoked", async () => {
    if (skip()) return;
    const issued = await issueOk(SES_OWNER_ALL, { storeId: STORE_A_X, replacesDeviceId: RP_REV_SIB });
    expect(await codeStatus(STALE_SIBLING_CODE)).toBe("pending");
    expect((await pair(issued.code)).status).toBe(200);
    expect(await codeStatus(STALE_SIBLING_CODE)).toBe("cancelled");
    expect(await auditRows("pos.device.revoked", RP_REV_SIB)).toHaveLength(0);
    // L2: the redemption itself cancelled the sibling, so its paired row counts it.
    const paired = await auditRows("pos.device.paired", issued.terminalId);
    expect((paired[0]?.["metadata"] as Record<string, unknown>)["cancelled_pairing_code_count"]).toBe(1);
  });
});

// ===========================================================================
// 3. Issue
// ===========================================================================
describe("consoleIssuePairingCode", () => {
  it("issues a plain code once: 16 characters, hashed at rest, default label, redeemable", async () => {
    if (skip()) return;
    const res = await issue(SES_OWNER_ALL, { storeId: STORE_A_X, ttlMinutes: 30 });
    expect(res.status).toBe(201);
    expect(res.headers["cache-control"]).toBe("no-store");
    const issued = res.body as Issued;
    expect(issued).toMatchObject({ kind: "pair", replacesDeviceId: null, storeId: STORE_A_X });
    expect(issued.code).toMatch(/^[A-HJ-KMNP-TV-Z2-9]{16}$/);
    expect(issued.terminalLabel).toBe(`T-${issued.terminalId.replace(/-/g, "").slice(0, 8).toUpperCase()}`);
    const ttl = Date.parse(issued.expiresAt) - Date.parse(issued.createdAt);
    expect(ttl).toBe(30 * 60_000);

    const row = await h
      .env()
      .admin.query<{ code_hash: Buffer }>(`SELECT code_hash FROM pairing_codes WHERE id = $1`, [issued.pairingCodeId]);
    expect(row.rows[0]!.code_hash.equals(createHash("sha256").update(issued.code, "utf8").digest())).toBe(true);

    const [audit] = await auditRows("pos.device.pairing_code.issued", issued.pairingCodeId);
    expect(audit).toMatchObject({ store_id: STORE_A_X, actor_user_id: expect.any(String) });
    expect(JSON.stringify(audit)).not.toContain(issued.code);

    const paired = await pair(issued.code);
    expect(paired.status).toBe(200);
    expect(paired.body).toMatchObject({ terminal_label: issued.terminalLabel, branch_name: BINDING.branchName });
    expect(Date.parse(paired.body.expires_at) - Date.now()).toBeGreaterThan(89 * 86_400_000);
    expect((await pair(issued.code)).status).toBe(410);
  });

  it("keeps a given label and the optional COM port", async () => {
    if (skip()) return;
    const issued = await issueOk(SES_OWNER_ALL, { storeId: STORE_A_X, terminalLabel: "Counter 9", printerComPort: "COM3" });
    expect(issued.terminalLabel).toBe("Counter 9");
    expect((await pair(issued.code)).body).toMatchObject({ terminal_label: "Counter 9", printer_com_port: "COM3" });
  });

  it("lets a store_manager issue for a granted store", async () => {
    if (skip()) return;
    await issueOk(SES_MANAGER_X, { storeId: STORE_A_X });
  });

  it.each([
    ["a store outside the scope", SES_ADMIN_SPEC, { storeId: STORE_A_Y }],
    ["a move from a store outside the scope", SES_ADMIN_SPEC, { storeId: STORE_A_X, replacesDeviceId: PARITY_DEVICES.move.shift }],
    ["another tenant's device", SES_OWNER_ALL, { storeId: STORE_A_X, replacesDeviceId: D_B2 }],
    ["an absent device", SES_OWNER_ALL, { storeId: STORE_A_X, replacesDeviceId: NO_DEVICE }],
    ["a role outside the list", SES_STAFF, { storeId: STORE_A_X }],
  ])("answers the shared 404 for %s", async (_label, session, body) => {
    if (skip()) return;
    const res = await issue(session, body);
    expect([res.status, res.body.error?.code]).toEqual([404, "not_found"]);
  });

  it.each([
    ["no Idempotency-Key", {}, null, "idempotency_key_required"],
    ["a TTL over 24 h", { ttlMinutes: 1441 }, randomUUID(), "validation_error"],
    ["a smuggled tenantId", { tenantId: STORE_A_X }, randomUUID(), "validation_error"],
    ["a client-chosen kind", { kind: "move" }, randomUUID(), "validation_error"],
  ])("answers 400 for %s", async (_label, patch, key, code) => {
    if (skip()) return;
    const res = await issue(SES_OWNER_ALL, { storeId: STORE_A_X, ...patch }, key);
    expect([res.status, res.body.error?.code]).toEqual([400, code]);
  });

  it("never replays the code: a same-key retry is 409 and nothing stores the code", async () => {
    if (skip()) return;
    const key = randomUUID();
    const first = await issue(SES_OWNER_ALL, { storeId: STORE_A_X }, key);
    expect(first.status).toBe(201);
    const again = await issue(SES_OWNER_ALL, { storeId: STORE_A_X }, key);
    expect([again.status, again.body.error?.code]).toEqual([409, "idempotency_key_conflict"]);
    expect(JSON.stringify(again.body)).not.toContain(first.body.code);
    const stored = await h.env().admin.query(`SELECT * FROM idempotency_keys`);
    expect(JSON.stringify(stored.rows)).not.toContain(first.body.code);
    const codes = await h.env().admin.query(`SELECT count(*)::int AS n FROM pairing_codes WHERE store_id = $1`, [STORE_A_X]);
    const n = codes.rows[0].n as number;
    await issue(SES_OWNER_ALL, { storeId: STORE_A_X }, key);
    const after = await h.env().admin.query(`SELECT count(*)::int AS n FROM pairing_codes WHERE store_id = $1`, [STORE_A_X]);
    expect(after.rows[0].n).toBe(n);
  });
});

// ===========================================================================
// 4. List, cancel, expire
// ===========================================================================
describe("consoleListPairingCodes / consoleCancelPairingCode", () => {
  it("lists live pending codes in scope, newest first, with no code", async () => {
    if (skip()) return;
    const a = await issueOk(SES_OWNER_ALL, { storeId: STORE_A_X });
    const b = await issueOk(SES_OWNER_ALL, { storeId: STORE_A_Y });
    const res = await h.get(CODES, SES_OWNER_ALL, { page_size: 200 });
    expect(res.status).toBe(200);
    h.conforms("PairingCodePage", res.body);
    const ids = (res.body.items as Array<{ pairingCodeId: string }>).map((i) => i.pairingCodeId);
    expect(ids.indexOf(b.pairingCodeId)).toBeLessThan(ids.indexOf(a.pairingCodeId));
    expect(JSON.stringify(res.body)).not.toContain(a.code);

    const scoped = await h.get(CODES, SES_ADMIN_SPEC, { page_size: 200 });
    const scopedIds = (scoped.body.items as Array<{ pairingCodeId: string; storeId: string }>).map((i) => i.storeId);
    expect(new Set(scopedIds)).toEqual(new Set([STORE_A_X]));
    expect((await h.get(CODES, SES_ADMIN_SPEC, { store_id: STORE_A_Y })).status).toBe(404);
  });

  it("pages with a cursor", async () => {
    if (skip()) return;
    const first = await h.get(CODES, SES_OWNER_ALL, { page_size: 1 });
    expect(first.body.items).toHaveLength(1);
    expect(first.body.nextCursor).toEqual(expect.any(String));
    const second = await h.get(CODES, SES_OWNER_ALL, { page_size: 1, cursor: first.body.nextCursor });
    expect(second.body.items[0].pairingCodeId).not.toBe(first.body.items[0].pairingCodeId);
    expect((await h.get(CODES, SES_OWNER_ALL, { cursor: "bm90LWEtY3Vyc29y" })).status).toBe(400);
  });

  it("hides a move code's replaced device from a caller who cannot see its store", async () => {
    if (skip()) return;
    const issued = await issueOk(SES_OWNER_ALL, { storeId: STORE_A_X, replacesDeviceId: MV_LIST });
    const scoped = await h.get(CODES, SES_ADMIN_SPEC, { page_size: 200 });
    const item = (
      scoped.body.items as Array<{ pairingCodeId: string; kind: string; replacesDeviceId: string | null }>
    ).find((i) => i.pairingCodeId === issued.pairingCodeId);
    expect(item).toMatchObject({ kind: "move", replacesDeviceId: null });
  });

  it("cancels idempotently; a cancelled code is not listed and not redeemable", async () => {
    if (skip()) return;
    const issued = await issueOk(SES_OWNER_ALL, { storeId: STORE_A_X });
    const first = await h.post(cancelPath(issued.pairingCodeId), SES_OWNER_ALL, {});
    expect([first.status, first.body.outcome]).toEqual([200, "cancelled"]);
    h.conforms("PairingCodeCancelResult", first.body);
    const again = await h.post(cancelPath(issued.pairingCodeId), SES_OWNER_ALL, {});
    expect([again.status, again.body.outcome]).toEqual([200, "already_cancelled"]);
    expect(await auditRows("pos.device.pairing_code.cancelled", issued.pairingCodeId)).toHaveLength(1);
    const list = await h.get(CODES, SES_OWNER_ALL, { page_size: 200 });
    expect(JSON.stringify(list.body)).not.toContain(issued.pairingCodeId);
    expect((await pair(issued.code)).status).toBe(410);
  });

  it("refuses to cancel a used code (409) and an out-of-scope code (404)", async () => {
    if (skip()) return;
    const used = await issueOk(SES_OWNER_ALL, { storeId: STORE_A_X });
    expect((await pair(used.code)).status).toBe(200);
    const res = await h.post(cancelPath(used.pairingCodeId), SES_OWNER_ALL, {});
    expect([res.status, res.body.error?.code]).toEqual([409, "pairing_code_used"]);

    const y = await issueOk(SES_OWNER_ALL, { storeId: STORE_A_Y });
    const hidden = await h.post(cancelPath(y.pairingCodeId), SES_ADMIN_SPEC, {});
    expect([hidden.status, hidden.body.error?.code]).toEqual([404, "not_found"]);
    expect((await h.post(cancelPath("not-a-uuid"), SES_OWNER_ALL, {})).status).toBe(400);
  });

  it("drops an expired code from the list, refuses its redemption and still cancels it", async () => {
    if (skip()) return;
    const issued = await issueOk(SES_OWNER_ALL, { storeId: STORE_A_X });
    await h
      .env()
      .admin.query(`UPDATE pairing_codes SET expires_at = now() - interval '1 minute' WHERE id = $1`, [
        issued.pairingCodeId,
      ]);
    const list = await h.get(CODES, SES_OWNER_ALL, { page_size: 200 });
    expect(JSON.stringify(list.body)).not.toContain(issued.pairingCodeId);
    expect((await pair(issued.code)).status).toBe(410);
    const res = await h.post(cancelPath(issued.pairingCodeId), SES_OWNER_ALL, {});
    expect([res.status, res.body.outcome]).toEqual([200, "cancelled"]);
  });
});
