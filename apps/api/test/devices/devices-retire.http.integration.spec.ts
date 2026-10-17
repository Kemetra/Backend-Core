/**
 * RT-368 (RT-287 F5; D-Q2, D-Q4 as amended) — the device retire over HTTP
 * against real Postgres (Testcontainers, every migration, the NOBYPASSRLS
 * `app_test` pool) and the real `DevicesModule`, on the RT-365 device fixture.
 *
 *   POST /api/v1/devices/{deviceId}/retire  consoleRetireDevice
 *   GET  /api/v1/devices                    consoleListDevices (default filter)
 *
 * What this proves (RT-368 acceptance):
 *   - parity: on every device state × open shift, the impact preview's retire
 *     verdict is the retire's outcome (allowed → 200 retired, blocked → 409
 *     blockCode with the preview, no_change → 200 already_retired);
 *   - an active device is revoked (reason `retired`, the cascade) and retired;
 *     an already-revoked device keeps its revoke fields and loses its pending
 *     codes; an open shift is 409 unresolved_cash_session; a custody
 *     exception is 409 unresolved_custody_exception;
 *   - idempotent repeat; terminal (a retired device cannot be replaced);
 *   - history keeps resolving (the row, its shifts and its replace link stay);
 *   - no DELETE route; scope 404 and body 400;
 *   - audit `pos.device.retired` without the reason text;
 *   - the list's default filter drops retired devices.
 *
 * Docker policy: HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import "reflect-metadata";

import { createHash } from "node:crypto";

import type request from "supertest";

import { DevicesModule } from "../../src/devices/devices.module";
import { scopedHttpHarness } from "../_helpers/scoped-http-harness";
import { STORE_A_X, TENANT_A } from "../catalog/__support__/isolation-harness";
import { SES_ADMIN_SPEC, SES_OWNER_ALL } from "../catalog/erpnext-reconciliation/__support__/read-store-scope";
import {
  CASHIER_A,
  cashFactsDigest,
  CODE_PLAIN_REPLACEMENT,
  CODE_PLAIN_TERMINAL,
  D_B,
  D_EXC,
  D_NEW,
  D_OLD,
  D_RETIRED,
  NO_DEVICE,
  OP_TOKEN_PLAIN_LIVE,
  R_BLOCK,
  R_PLAIN,
  R_SEC,
  R_Y,
  SES_MANAGER,
  SES_STAFF,
  seedDeviceFixture,
  SHIFT_BLOCK,
  SHIFT_EXC,
  SHIFT_SEC,
} from "./__support__/device-fixture";

const retirePath = (deviceId: string): string => `/api/v1/devices/${deviceId}/retire`;
const REASON = "End of life, returned to vendor";
const CLOSED_SHIFT = "0a000000-0000-7000-8000-00000368c001";
const OLD_PENDING_CODE = "0a000000-0000-7000-8000-00000368c002";

let cashBaseline = "";

const h = scopedHttpHarness({
  label: "RT-368 device retire",
  contractId: "devices.openapi",
  module: DevicesModule,
  seed: async (env) => {
    await seedDeviceFixture(env);
    // A closed legacy shift on R_PLAIN: history that must keep resolving after its retire.
    await env.admin.query(
      `INSERT INTO shifts (shift_id, tenant_id, store_id, opening_cashier_user_id, opening_device_id, opened_at, lifecycle_state)
       VALUES ($1, $2, $3, $4, $5, '2026-10-01T08:00:00Z', 'closed')`,
      [CLOSED_SHIFT, TENANT_A, STORE_A_X, CASHIER_A, R_PLAIN],
    );
    // A pending replacement code naming the already-revoked D_OLD: retire cancels it (R2).
    await env.admin.query(
      `INSERT INTO pairing_codes
         (id, tenant_id, store_id, code_hash, terminal_id, terminal_label, branch_name, branch_address,
          tenant_tax_registration_id, printer_vendor_id, printer_product_id, status, expires_at, replaces_device_id)
       VALUES ($1, $2, $3, $4, gen_random_uuid(), 'Till', 'Branch', 'Address', 'TAX-1', '0x04b8', '0x0202',
               'pending', now() + interval '1 day', $5)`,
      [OLD_PENDING_CODE, TENANT_A, STORE_A_X, createHash("sha256").update("old-pending").digest(), D_OLD],
    );
    cashBaseline = await cashFactsDigest(env.admin);
  },
});
const skip = (): boolean => h.skipped();

type Preview = { verdict: string; blockCode: string | null };

async function preview(deviceId: string): Promise<Preview> {
  const res = await h.get(`/api/v1/devices/${deviceId}/impact`, SES_OWNER_ALL, { action: "retire" });
  expect(res.status).toBe(200);
  return res.body as Preview;
}

const retire = (deviceId: string, session = SES_OWNER_ALL, body: object = { retireReason: REASON }): request.Test =>
  h.post(retirePath(deviceId), session, body);

/** The contract's retire outcome for a preview (verdict → status, outcome or code). */
function expectedOutcome(p: Preview): [number, string] {
  if (p.verdict === "allowed") return [200, "retired"];
  if (p.verdict === "no_change") return [200, "already_retired"];
  return [409, String(p.blockCode)];
}

function outcomeOf(res: request.Response): [number, string] {
  const body = res.body as { outcome?: string; error?: { code?: string } };
  return [res.status, res.status === 200 ? String(body.outcome) : String(body.error?.code)];
}

async function deviceRow(deviceId: string): Promise<Record<string, unknown>> {
  const r = await h
    .env()
    .admin.query(
      `SELECT revoked_at, revoked_by, revoke_reason, retired_at, retired_by, retire_reason FROM devices WHERE id = $1`,
      [deviceId],
    );
  return r.rows[0] as Record<string, unknown>;
}

async function auditRows(action: string, targetId: string): Promise<Array<Record<string, unknown>>> {
  const r = await h
    .env()
    .admin.query(`SELECT actor_user_id, metadata FROM audit_events WHERE action = $1 AND target_id = $2`, [
      action,
      targetId,
    ]);
  return r.rows as Array<Record<string, unknown>>;
}

// ===========================================================================
// 1. Parity: the retire verdict is the retire's outcome, on every state
// ===========================================================================
describe("consoleRetireDevice — parity with the impact preview", () => {
  it.each([
    ["active, open legacy shift", R_BLOCK],
    ["active, open cash-up shift", R_SEC],
    ["revoked, open shift (custody exception)", D_EXC],
    ["retired", D_RETIRED],
    ["active, no shift", R_PLAIN],
    ["revoked, no shift", D_OLD],
  ])("%s: preview verdict == retire outcome", async (_label, deviceId) => {
    if (skip()) return;
    const before = await deviceRow(deviceId);
    const p = await preview(deviceId);
    const res = await retire(deviceId);
    expect(outcomeOf(res)).toEqual(expectedOutcome(p));
    if (res.status === 409) {
      h.conforms("DeviceRetireConflict", res.body);
      expect(res.body.error.details).toMatchObject({ deviceId, action: "retire", verdict: "blocked", blockCode: p.blockCode });
      expect(await deviceRow(deviceId)).toEqual(before);
    } else {
      h.conforms("DeviceRetireResult", res.body);
      expect(res.body.device).toMatchObject({ deviceId, trustState: "retired" });
    }
  });

  it("refuses with the expected block codes", async () => {
    if (skip()) return;
    expect(outcomeOf(await retire(R_BLOCK))).toEqual([409, "unresolved_cash_session"]);
    expect(outcomeOf(await retire(D_EXC))).toEqual([409, "unresolved_custody_exception"]);
  });

  it("changes no cash fact on any path", async () => {
    if (skip()) return;
    expect(await cashFactsDigest(h.env().admin)).toBe(cashBaseline);
    const shifts = await h
      .env()
      .admin.query(`SELECT shift_id, lifecycle_state FROM shifts WHERE shift_id = ANY($1::uuid[]) ORDER BY shift_id`, [
        [SHIFT_BLOCK, SHIFT_EXC, SHIFT_SEC],
      ]);
    expect(shifts.rows.every((r: { lifecycle_state: string }) => r.lifecycle_state === "open")).toBe(true);
  });
});

// ===========================================================================
// 2. Effects
// ===========================================================================
describe("consoleRetireDevice — effects", () => {
  it("revoked the active device with reason retired through the cascade, then retired it", async () => {
    if (skip()) return;
    const row = await deviceRow(R_PLAIN);
    expect(row).toMatchObject({ revoke_reason: "retired", retire_reason: REASON });
    expect(row["revoked_at"]).not.toBeNull();
    expect(row["retired_at"]).not.toBeNull();
    expect(row["retired_by"]).toEqual(row["revoked_by"]);
    const tokens = await h
      .env()
      .admin.query(`SELECT revoked_at FROM auth_tokens WHERE token_hash = $1`, [
        createHash("sha256").update(OP_TOKEN_PLAIN_LIVE, "utf8").digest(),
      ]);
    expect(tokens.rows[0]?.revoked_at).not.toBeNull();
    const codes = await h
      .env()
      .admin.query(`SELECT status FROM pairing_codes WHERE id = ANY($1::uuid[])`, [
        [CODE_PLAIN_TERMINAL, CODE_PLAIN_REPLACEMENT],
      ]);
    expect(codes.rows.map((r: { status: string }) => r.status).sort()).toEqual(["cancelled", "cancelled"]);
    const [revoked] = await auditRows("pos.device.revoked", R_PLAIN);
    expect(revoked).toMatchObject({ actor_user_id: row["revoked_by"], metadata: { reason: "retired" } });
    const [retired] = await auditRows("pos.device.retired", R_PLAIN);
    expect(retired).toMatchObject({
      actor_user_id: row["retired_by"],
      metadata: { revoked_by_retire: true, cancelled_pairing_code_count: 2 },
    });
    expect(JSON.stringify(retired)).not.toContain(REASON);
  });

  it("kept the already-revoked device's revoke fields and cancelled its pending codes", async () => {
    if (skip()) return;
    const row = await deviceRow(D_OLD);
    expect(row).toMatchObject({ revoke_reason: null, revoked_by: null, retire_reason: REASON });
    const code = await h.env().admin.query(`SELECT status FROM pairing_codes WHERE id = $1`, [OLD_PENDING_CODE]);
    expect(code.rows[0]?.status).toBe("cancelled");
    expect(await auditRows("pos.device.revoked", D_OLD)).toHaveLength(0);
    const [retired] = await auditRows("pos.device.retired", D_OLD);
    expect(retired?.["metadata"]).toEqual({ revoked_by_retire: false, cancelled_pairing_code_count: 1 });
  });

  it("is idempotent: a repeat answers already_retired and changes nothing", async () => {
    if (skip()) return;
    const before = await deviceRow(R_PLAIN);
    const again = await retire(R_PLAIN, SES_OWNER_ALL, { retireReason: "Another reason" });
    expect(outcomeOf(again)).toEqual([200, "already_retired"]);
    expect(await deviceRow(R_PLAIN)).toEqual(before);
    expect(await auditRows("pos.device.retired", R_PLAIN)).toHaveLength(1);
  });

  it("is terminal: a retired device cannot be replaced", async () => {
    if (skip()) return;
    const p = await h.get(`/api/v1/devices/${R_PLAIN}/impact`, SES_OWNER_ALL, { action: "replace" });
    expect(p.body).toMatchObject({ verdict: "blocked", blockCode: "device_retired" });
  });

  it("keeps history resolving: the row, its shifts and its replace link stay", async () => {
    if (skip()) return;
    const shift = await h
      .env()
      .admin.query(
        `SELECT d.id, d.store_id FROM shifts s JOIN devices d ON d.id = s.opening_device_id WHERE s.shift_id = $1`,
        [CLOSED_SHIFT],
      );
    expect(shift.rows[0]).toEqual({ id: R_PLAIN, store_id: STORE_A_X });
    const detail = await h.get(`/api/v1/devices/${R_PLAIN}`, SES_OWNER_ALL);
    expect(detail.body).toMatchObject({ trustState: "retired", retireReason: REASON });
    const replacement = await h.get(`/api/v1/devices/${D_NEW}`, SES_OWNER_ALL);
    expect(replacement.body).toMatchObject({ replacesDeviceId: D_OLD });
  });
});

// ===========================================================================
// 3. Surface: no DELETE, scope, body, default list filter
// ===========================================================================
describe("consoleRetireDevice — surface", () => {
  it("has no DELETE route for a device", async () => {
    if (skip()) return;
    const res = await h.del(`/api/v1/devices/${R_Y}`, SES_OWNER_ALL);
    expect(res.status).toBe(404);
    expect((await deviceRow(R_Y))["retired_at"]).toBeNull();
  });

  it.each([
    ["another tenant's device", SES_OWNER_ALL, D_B],
    ["an absent device", SES_OWNER_ALL, NO_DEVICE],
    ["a device outside the caller's stores", SES_ADMIN_SPEC, R_Y],
    ["a role outside the list", SES_STAFF, R_Y],
  ])("answers the shared 404 for %s", async (_label, session, deviceId) => {
    if (skip()) return;
    const res = await retire(deviceId, session);
    expect([res.status, res.body.error?.code]).toEqual([404, "not_found"]);
  });

  it.each([
    ["no reason", {}],
    ["a blank reason", { retireReason: "  " }],
    ["a revoke-reason key", { retireReason: REASON, reason: "retired" }],
  ])("answers 400 for %s", async (_label, body) => {
    if (skip()) return;
    const res = await retire(R_Y, SES_OWNER_ALL, body);
    expect([res.status, res.body.error?.code]).toEqual([400, "validation_error"]);
  });

  it("lets a store_manager retire a device in a granted store", async () => {
    if (skip()) return;
    expect(outcomeOf(await retire(R_Y, SES_MANAGER))).toEqual([200, "retired"]);
  });

  it("drops retired devices from the default list and keeps them with trust_state=retired", async () => {
    if (skip()) return;
    const ids = async (query: Record<string, string | number>): Promise<string[]> => {
      const res = await h.get("/api/v1/devices", SES_OWNER_ALL, { page_size: 200, ...query });
      expect(res.status).toBe(200);
      return (res.body.items as Array<{ deviceId: string }>).map((i) => i.deviceId);
    };
    const defaults = await ids({});
    for (const retired of [D_RETIRED, R_PLAIN, D_OLD, R_Y]) expect(defaults).not.toContain(retired);
    expect(defaults).toContain(D_EXC);
    const retiredOnly = await ids({ trust_state: "retired" });
    expect(new Set(retiredOnly)).toEqual(new Set([D_RETIRED, R_PLAIN, D_OLD, R_Y]));
  });
});
