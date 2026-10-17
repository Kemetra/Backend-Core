/**
 * RT-365 — the Console device registry over HTTP against real Postgres
 * (Testcontainers, every migration, the NOBYPASSRLS `app_test` pool) and the
 * real module graph (`TenantContextGuard`, `RolesGuard`,
 * `MembershipRepository`). Only cookie authentication is faked: a header
 * names the session (the RT-192 / RT-383 pattern).
 *
 *   GET  /api/v1/devices                    consoleListDevices
 *   GET  /api/v1/devices/{deviceId}         consoleGetDevice
 *   POST /api/v1/devices/{deviceId}/revoke  consoleRevokeDevice
 *
 * What this proves (RT-365 acceptance):
 *   - reads: exception-first order, trust-state and store filters, the
 *     operator store scope, keyset walks, replace links, the derived custody
 *     exception, the revoke note on the detail only;
 *   - cascade: a live operator token is revoked and rejected after the revoke
 *     (an expired one and another device's are untouched), the till's own
 *     token stops authenticating, pending codes for the device are cancelled;
 *   - cross-store and cross-tenant refusal (the non-disclosing 404);
 *   - 409 for a non-security, non-recovery reason with an open shift (a legacy
 *     open shift counts);
 *   - a security revoke succeeds for a store_manager, with the exception;
 *   - a recovery revoke succeeds for owner / tenant_admin with note +
 *     acknowledgement, is refused for store_manager (403) and without the note
 *     or the acknowledgement (422);
 *   - no cash fact changes on any path; idempotency; one audit row with no
 *     secret, none on a refusal;
 *   - every 200 and error body validates against the contract schemas.
 *
 * Docker policy: HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import "reflect-metadata";

import type { PoolClient } from "pg";
import type request from "supertest";

import { AuthTokenRepository } from "../../src/auth/auth-token.repository";
import { lockDeviceLifecycle } from "../../src/devices/device-lifecycle-lock";
import { DevicesModule } from "../../src/devices/devices.module";
import { runWithTenantContext } from "@data-pulse-2/db";

import { LEGACY_SHIFT_OPEN_SQL } from "../../src/pos-audit-events/pos-audit-events.service";
import { DeviceRepository } from "../../src/pos-operators/device.repository";
import { ShiftCashUpRepository } from "../../src/pos-shifts/shift-cash-up.repository";
import { scopedHttpHarness } from "../_helpers/scoped-http-harness";
import { STORE_A_X, STORE_A_Y, STORE_B_X, TENANT_A } from "../catalog/__support__/isolation-harness";
import { SES_ADMIN_SPEC, SES_OWNER_ALL } from "../catalog/erpnext-reconciliation/__support__/read-store-scope";
import {
  cashFactsDigest,
  CODE_OTHER_PENDING,
  CODE_PLAIN_REPLACEMENT,
  CODE_PLAIN_TERMINAL,
  D_B,
  D_EXC,
  D_LATE_Y,
  D_NEW,
  D_OLD,
  D_RETIRED,
  D_SOON,
  DEVICE_TOKEN_PLAIN,
  NO_DEVICE,
  OP_TOKEN_PLAIN_EXPIRED_HASH,
  OP_TOKEN_PLAIN_LIVE,
  OP_TOKEN_SEC_LIVE,
  OP_TOKEN_SOON_LIVE,
  R_BLOCK,
  CASHIER_A,
  R_LEGACY_LATE,
  R_PLAIN,
  R_RACE,
  R_REC,
  R_REVERSE,
  R_REC_ADMIN,
  R_SEC,
  R_Y,
  SES_MANAGER,
  SES_MANAGER_ACTIVE,
  SES_STAFF,
  seedDeviceFixture,
  SHIFT_EXC,
  SHIFT_REC,
  SHIFT_REC_ADMIN,
  SHIFT_SEC,
  TENANT_A_ORDER,
  USER_MANAGER,
} from "./__support__/device-fixture";

const LIST = "/api/v1/devices";
const detail = (deviceId: string): string => `${LIST}/${deviceId}`;
const revoke = (deviceId: string): string => `${LIST}/${deviceId}/revoke`;
/** The default list (no `trust_state`) leaves retired devices out (RT-368). */
const DEFAULT_ORDER = TENANT_A_ORDER.filter((d) => d !== D_RETIRED);
const X_DEVICES = TENANT_A_ORDER.filter((d) => ![D_LATE_Y, R_Y, D_RETIRED].includes(d));
const Y_DEVICES = [D_LATE_Y, R_Y];

let ownerUserId = "";
let cashBaseline = "";

const h = scopedHttpHarness({
  label: "RT-365 devices",
  contractId: "devices.openapi",
  module: DevicesModule,
  seed: async (env) => {
    ownerUserId = await seedDeviceFixture(env);
    cashBaseline = await cashFactsDigest(env.admin);
  },
});
const skip = (): boolean => h.skipped();
const get = h.get;
const post = (path: string, session: string | null, body: unknown): request.Test => h.post(path, session, body as object);

type Item = Record<string, unknown> & { deviceId: string };

async function page(session: string, query: Record<string, string | number> = {}) {
  const res = await get(LIST, session, query).expect(200);
  h.conforms("DevicePage", res.body);
  return res.body as { items: Item[]; nextCursor: string | null };
}

async function ids(session: string, query: Record<string, string | number> = {}): Promise<string[]> {
  const body = await page(session, { page_size: 200, ...query });
  expect(body.nextCursor).toBeNull();
  return body.items.map((i) => i.deviceId);
}

async function walk(session: string, pageSize: number): Promise<string[]> {
  const seen: string[] = [];
  let cursor: string | null = null;
  for (let pages = 1; pages <= 50; pages += 1) {
    const body = await page(session, { page_size: pageSize, ...(cursor ? { cursor } : {}) });
    seen.push(...body.items.map((i) => i.deviceId));
    cursor = body.nextCursor;
    if (cursor === null) return seen;
  }
  throw new Error("walk did not end");
}

async function expectError(res: request.Response, status: number, code: string): Promise<void> {
  expect({ status: res.status, code: (res.body as { error?: { code?: string } }).error?.code }).toEqual({ status, code });
  h.conforms("Error", res.body);
}

async function deviceRow(deviceId: string) {
  const r = await h.env().admin.query(
    `SELECT revoked_at, revoked_by, revoke_reason, revoke_note FROM devices WHERE id = $1`,
    [deviceId],
  );
  return r.rows[0] as { revoked_at: Date | null; revoked_by: string | null; revoke_reason: string | null; revoke_note: string | null };
}

async function revokeAudits(deviceId: string) {
  const r = await h.env().admin.query<{ actor_user_id: string; store_id: string; target_type: string; metadata: Record<string, unknown> }>(
    `SELECT actor_user_id, store_id, target_type, metadata FROM audit_events
      WHERE action = 'pos.device.revoked' AND target_id = $1`,
    [deviceId],
  );
  return r.rows;
}

const tokenLookup = (): AuthTokenRepository => new AuthTokenRepository(h.env().admin);
const deviceLookup = (): DeviceRepository => new DeviceRepository(h.env().admin, h.env().admin);

// ===========================================================================
// Reads
// ===========================================================================
describe("consoleListDevices", () => {
  it("lists tenant A exception-first for the all-store owner", async () => {
    if (skip()) return;
    expect(await ids(SES_OWNER_ALL)).toEqual(DEFAULT_ORDER);
  });

  it("walks the same order once at every page size", async () => {
    if (skip()) return;
    for (const size of [1, 2, 3, 5]) expect(await walk(SES_OWNER_ALL, size)).toEqual(DEFAULT_ORDER);
  });

  it("applies the operator store scope", async () => {
    if (skip()) return;
    expect(await ids(SES_ADMIN_SPEC)).toEqual(X_DEVICES);
    expect(await ids(SES_MANAGER)).toEqual(DEFAULT_ORDER);
    expect(await ids(SES_MANAGER_ACTIVE)).toEqual(Y_DEVICES);
    expect(await ids(SES_MANAGER_ACTIVE, { trust_state: "retired" })).toEqual([D_RETIRED]);
  });

  it("filters by store and trust state", async () => {
    if (skip()) return;
    expect(await ids(SES_OWNER_ALL, { store_id: STORE_A_Y })).toEqual(Y_DEVICES);
    expect(await ids(SES_OWNER_ALL, { trust_state: "revoked" })).toEqual([D_EXC, D_OLD]);
    expect(await ids(SES_OWNER_ALL, { trust_state: "retired" })).toEqual([D_RETIRED]);
    expect(await ids(SES_OWNER_ALL)).not.toContain(D_RETIRED);
    expect(await ids(SES_OWNER_ALL, { trust_state: "active", store_id: STORE_A_Y })).toEqual([D_LATE_Y, R_Y]);
  });

  it("refuses a store outside the scope or of another tenant as the same 404", async () => {
    if (skip()) return;
    await expectError(await get(LIST, SES_MANAGER_ACTIVE, { store_id: STORE_A_X }), 404, "not_found");
    await expectError(await get(LIST, SES_OWNER_ALL, { store_id: STORE_B_X }), 404, "not_found");
    await expectError(await get(LIST, SES_STAFF), 404, "not_found");
  });

  it("answers 400 for a malformed filter or cursor, and 401 without a session", async () => {
    if (skip()) return;
    await expectError(await get(LIST, SES_OWNER_ALL, { trust_state: "expired" }), 400, "validation_error");
    await expectError(await get(LIST, SES_OWNER_ALL, { tenant_id: STORE_A_X }), 400, "validation_error");
    await expectError(await get(LIST, SES_OWNER_ALL, { cursor: "bm90LWEtY3Vyc29y" }), 400, "validation_error");
    expect((await get(LIST, null)).status).toBe(401);
  });

  it("projects the custody exception, the replace links and the pre-RT-365 revoke", async () => {
    if (skip()) return;
    const byId = new Map((await page(SES_OWNER_ALL, { page_size: 200 })).items.map((i) => [i.deviceId, i]));
    expect(byId.get(D_EXC)).toMatchObject({ trustState: "revoked", revokeReason: "stolen", custodyExceptionShiftId: SHIFT_EXC });
    expect(byId.get(D_EXC)).not.toHaveProperty("revokeNote");
    expect(byId.get(R_SEC)).toMatchObject({ trustState: "active", custodyExceptionShiftId: null });
    expect(byId.get(D_NEW)).toMatchObject({ replacesDeviceId: D_OLD, replacedByDeviceId: null });
    expect(byId.get(D_OLD)).toMatchObject({
      trustState: "revoked",
      revokeReason: null,
      revokedByUserId: null,
      replacedByDeviceId: D_NEW,
    });
    const retired = (await page(SES_OWNER_ALL, { page_size: 200, trust_state: "retired" })).items;
    expect(retired.find((i) => i.deviceId === D_RETIRED)).toMatchObject({ trustState: "retired", revokeReason: "retired" });
    expect(byId.get(D_SOON)).toMatchObject({ expiresAt: "2026-11-01T00:00:00.000Z", lastSeenAt: null });
  });
});

describe("replace links and the store scope", () => {
  const linksOf = async (session: string, deviceId: string) => {
    // A retired device is listed only with trust_state=retired (RT-368 default filter).
    const query = deviceId === D_RETIRED ? { page_size: 200, trust_state: "retired" } : { page_size: 200 };
    const item = (await page(session, query)).items.find((i) => i.deviceId === deviceId);
    return item === undefined ? undefined : { replaces: item["replacesDeviceId"], replacedBy: item["replacedByDeviceId"] };
  };

  it("shows a cross-store move to a caller that sees both stores", async () => {
    if (skip()) return;
    expect(await linksOf(SES_OWNER_ALL, D_SOON)).toEqual({ replaces: D_RETIRED, replacedBy: null });
    expect(await linksOf(SES_OWNER_ALL, D_RETIRED)).toEqual({ replaces: null, replacedBy: D_SOON });
  });

  it("hides the other side of a move from a caller scoped to one store", async () => {
    if (skip()) return;
    expect(await linksOf(SES_ADMIN_SPEC, D_SOON)).toEqual({ replaces: null, replacedBy: null });
    expect(await linksOf(SES_MANAGER_ACTIVE, D_RETIRED)).toEqual({ replaces: null, replacedBy: null });
    const res = await get(detail(D_SOON), SES_ADMIN_SPEC).expect(200);
    expect(res.body).toMatchObject({ replacesDeviceId: null });
  });
});

describe("consoleGetDevice", () => {
  it("reads one device with its revoke note", async () => {
    if (skip()) return;
    const res = await get(detail(D_EXC.toUpperCase()), SES_ADMIN_SPEC).expect(200);
    h.conforms("DeviceDetail", res.body);
    expect(res.body).toMatchObject({
      deviceId: D_EXC,
      revokeNote: "Till taken; drawer cash in the safe",
      revokedByUserId: ownerUserId,
      custodyExceptionShiftId: SHIFT_EXC,
    });
  });

  it("reads the retire attribution", async () => {
    if (skip()) return;
    const res = await get(detail(D_RETIRED), SES_OWNER_ALL).expect(200);
    h.conforms("DeviceDetail", res.body);
    expect(res.body).toMatchObject({ retiredByUserId: ownerUserId, retireReason: "Decommissioned" });
  });

  it("refuses another tenant's, an out-of-scope, an absent device and a disallowed role as the same 404", async () => {
    if (skip()) return;
    await expectError(await get(detail(D_B), SES_OWNER_ALL), 404, "not_found");
    await expectError(await get(detail(D_LATE_Y), SES_ADMIN_SPEC), 404, "not_found");
    await expectError(await get(detail(D_SOON), SES_MANAGER_ACTIVE), 404, "not_found");
    await expectError(await get(detail(NO_DEVICE), SES_OWNER_ALL), 404, "not_found");
    await expectError(await get(detail(D_SOON), SES_STAFF), 404, "not_found");
    await expectError(await get(detail("not-a-uuid"), SES_OWNER_ALL), 400, "validation_error");
  });
});

// ===========================================================================
// Revoke
// ===========================================================================
describe("consoleRevokeDevice — refusals", () => {
  it("answers 400 for a malformed id or body, before any read", async () => {
    if (skip()) return;
    await expectError(await post(revoke("not-a-uuid"), SES_OWNER_ALL, { reason: "lost" }), 400, "validation_error");
    await expectError(await post(revoke(R_PLAIN), SES_OWNER_ALL, { reason: "other" }), 400, "validation_error");
    await expectError(await post(revoke(R_PLAIN), SES_OWNER_ALL, { reason: "broken" }), 400, "validation_error");
    await expectError(
      await post(revoke(R_PLAIN), SES_OWNER_ALL, { reason: "lost", storeId: STORE_A_X }),
      400,
      "validation_error",
    );
    expect((await deviceRow(R_PLAIN)).revoked_at).toBeNull();
  });

  it("refuses cross-store, cross-tenant, absent and disallowed-role revokes as the same 404", async () => {
    if (skip()) return;
    await expectError(await post(revoke(R_BLOCK), SES_MANAGER_ACTIVE, { reason: "lost" }), 404, "not_found");
    await expectError(await post(revoke(R_Y), SES_ADMIN_SPEC, { reason: "lost" }), 404, "not_found");
    await expectError(await post(revoke(D_B), SES_OWNER_ALL, { reason: "lost" }), 404, "not_found");
    await expectError(await post(revoke(NO_DEVICE), SES_OWNER_ALL, { reason: "lost" }), 404, "not_found");
    await expectError(await post(revoke(R_PLAIN), SES_STAFF, { reason: "lost" }), 404, "not_found");
    expect((await post(revoke(R_PLAIN), null, { reason: "lost" })).status).toBe(401);
    for (const d of [R_BLOCK, R_Y, R_PLAIN]) expect((await deviceRow(d)).revoked_at).toBeNull();
  });

  it("answers 409 unresolved_cash_session for a non-security reason with an open (legacy) shift", async () => {
    if (skip()) return;
    for (const reason of ["replaced", "moved", "retired", "admin_error"]) {
      await expectError(await post(revoke(R_BLOCK), SES_OWNER_ALL, { reason }), 409, "unresolved_cash_session");
    }
    await expectError(
      await post(revoke(R_BLOCK), SES_OWNER_ALL, { reason: "other", note: "x", acknowledgeCustodyException: true }),
      409,
      "unresolved_cash_session",
    );
    expect((await deviceRow(R_BLOCK)).revoked_at).toBeNull();
    expect(await revokeAudits(R_BLOCK)).toEqual([]);
  });

  it("refuses a recovery revoke for a store_manager (403) and without note or acknowledgement (422)", async () => {
    if (skip()) return;
    const note = "Till will not boot; drawer cash in the back-office safe";
    await expectError(
      await post(revoke(R_REC), SES_MANAGER, { reason: "hardware_failure", note, acknowledgeCustodyException: true }),
      403,
      "recovery_revoke_forbidden",
    );
    await expectError(
      await post(revoke(R_REC), SES_OWNER_ALL, { reason: "hardware_failure", acknowledgeCustodyException: true }),
      422,
      "recovery_note_required",
    );
    await expectError(
      await post(revoke(R_REC), SES_OWNER_ALL, { reason: "hardware_failure", note }),
      422,
      "custody_exception_not_acknowledged",
    );
    await expectError(
      await post(revoke(R_REC), SES_ADMIN_SPEC, { reason: "hardware_failure", note, acknowledgeCustodyException: false }),
      422,
      "custody_exception_not_acknowledged",
    );
    expect((await deviceRow(R_REC)).revoked_at).toBeNull();
    expect(await revokeAudits(R_REC)).toEqual([]);
  });
});

describe("consoleRevokeDevice — revokes", () => {
  it("revokes with the cascade, one audit row and no secret", async () => {
    if (skip()) return;
    expect(await deviceLookup().findActiveByAttestation(DEVICE_TOKEN_PLAIN)).not.toBeNull();
    expect(await tokenLookup().findActiveByRawToken(OP_TOKEN_PLAIN_LIVE)).not.toBeNull();

    const res = await post(revoke(R_PLAIN), SES_MANAGER, { reason: "admin_error", note: "Paired to the wrong store" });
    expect(res.status).toBe(200);
    h.conforms("DeviceRevokeResult", res.body);
    expect(res.body).toMatchObject({
      outcome: "revoked",
      device: {
        deviceId: R_PLAIN,
        trustState: "revoked",
        revokedByUserId: USER_MANAGER,
        revokeReason: "admin_error",
        revokeNote: "Paired to the wrong store",
        custodyExceptionShiftId: null,
      },
    });

    // Cascade: the live operator token is rejected; the expired one and another device's are untouched.
    expect(await tokenLookup().findActiveByRawToken(OP_TOKEN_PLAIN_LIVE)).toBeNull();
    expect(await tokenLookup().findActiveByRawToken(OP_TOKEN_SOON_LIVE)).not.toBeNull();
    const expired = await h.env().admin.query(`SELECT revoked_at FROM auth_tokens WHERE token_hash = $1`, [
      OP_TOKEN_PLAIN_EXPIRED_HASH,
    ]);
    expect(expired.rows[0].revoked_at).toBeNull();
    // POS RT-215: the till's own bearer stops authenticating at once.
    expect(await deviceLookup().findActiveByAttestation(DEVICE_TOKEN_PLAIN)).toBeNull();
    // Pending codes for the device are cancelled; another device's stays pending.
    const codes = await h.env().admin.query<{ id: string; status: string }>(
      `SELECT id, status FROM pairing_codes WHERE id = ANY($1::uuid[]) ORDER BY id`,
      [[CODE_PLAIN_TERMINAL, CODE_PLAIN_REPLACEMENT, CODE_OTHER_PENDING]],
    );
    expect(Object.fromEntries(codes.rows.map((c) => [c.id, c.status]))).toEqual({
      [CODE_PLAIN_TERMINAL]: "cancelled",
      [CODE_PLAIN_REPLACEMENT]: "cancelled",
      [CODE_OTHER_PENDING]: "pending",
    });

    const audits = await revokeAudits(R_PLAIN);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actor_user_id: USER_MANAGER, store_id: STORE_A_X, target_type: "device" });
    expect(audits[0]!.metadata).toEqual({
      reason: "admin_error",
      revoked_session_count: 1,
      cancelled_pairing_code_count: 2,
      custody_exception: false,
    });
    expect(JSON.stringify(audits[0]!.metadata)).not.toMatch(/wrong store|token|hash|note/i);
  });

  it("answers a repeat with the current state and changes nothing", async () => {
    if (skip()) return;
    const before = await deviceRow(R_PLAIN);
    const res = await post(revoke(R_PLAIN), SES_OWNER_ALL, { reason: "stolen" });
    expect(res.status).toBe(200);
    h.conforms("DeviceRevokeResult", res.body);
    expect(res.body).toMatchObject({ outcome: "already_revoked", device: { revokeReason: "admin_error" } });
    expect(await deviceRow(R_PLAIN)).toEqual(before);
    expect(await revokeAudits(R_PLAIN)).toHaveLength(1);
  });

  it("a security revoke by a store_manager succeeds over an open shift, making the custody exception", async () => {
    if (skip()) return;
    const res = await post(revoke(R_SEC), SES_MANAGER, { reason: "stolen" });
    expect(res.status).toBe(200);
    h.conforms("DeviceRevokeResult", res.body);
    expect(res.body).toMatchObject({ outcome: "revoked", device: { custodyExceptionShiftId: SHIFT_SEC } });
    expect(await tokenLookup().findActiveByRawToken(OP_TOKEN_SEC_LIVE)).toBeNull();
    const audits = await revokeAudits(R_SEC);
    expect(audits.map((a) => a.metadata)).toEqual([
      {
        reason: "stolen",
        revoked_session_count: 1,
        cancelled_pairing_code_count: 0,
        custody_exception: true,
        shift_id: SHIFT_SEC,
      },
    ]);
    const shift = await h.env().admin.query(`SELECT lifecycle_state FROM shifts WHERE shift_id = $1`, [SHIFT_SEC]);
    expect(shift.rows[0].lifecycle_state).toBe("open");
    // Now rank 0, after D_EXC by expiry.
    expect((await ids(SES_OWNER_ALL, { trust_state: "revoked" })).slice(0, 2)).toEqual([D_EXC, R_SEC]);
  });

  it("a recovery revoke by an owner with note and acknowledgement succeeds", async () => {
    if (skip()) return;
    const res = await post(revoke(R_REC), SES_OWNER_ALL, {
      reason: "hardware_failure",
      note: "Till will not boot; drawer cash in the back-office safe",
      acknowledgeCustodyException: true,
    });
    expect(res.status).toBe(200);
    h.conforms("DeviceRevokeResult", res.body);
    expect(res.body).toMatchObject({
      outcome: "revoked",
      device: { revokeReason: "hardware_failure", revokedByUserId: ownerUserId, custodyExceptionShiftId: SHIFT_REC },
    });
    expect((await revokeAudits(R_REC)).map((a) => a.metadata)).toEqual([
      {
        reason: "hardware_failure",
        revoked_session_count: 0,
        cancelled_pairing_code_count: 0,
        custody_exception: true,
        shift_id: SHIFT_REC,
      },
    ]);
  });

  it("a recovery revoke by a tenant_admin with note and acknowledgement succeeds", async () => {
    if (skip()) return;
    const res = await post(revoke(R_REC_ADMIN), SES_ADMIN_SPEC, {
      reason: "hardware_failure",
      note: "Screen dead; drawer emptied into the safe by the manager",
      acknowledgeCustodyException: true,
    });
    expect(res.status).toBe(200);
    h.conforms("DeviceRevokeResult", res.body);
    expect(res.body).toMatchObject({
      outcome: "revoked",
      device: { revokeReason: "hardware_failure", custodyExceptionShiftId: SHIFT_REC_ADMIN },
    });
    expect((await revokeAudits(R_REC_ADMIN)).map((a) => a.metadata)).toEqual([
      expect.objectContaining({ custody_exception: true, shift_id: SHIFT_REC_ADMIN }),
    ]);
  });

  it("lets a narrowed store_manager revoke a device of its active store", async () => {
    if (skip()) return;
    const res = await post(revoke(R_Y), SES_MANAGER_ACTIVE, { reason: "lost" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ outcome: "revoked", device: { storeId: STORE_A_Y, revokeReason: "lost" } });
  });

  it("changed no cash fact on any path", async () => {
    if (skip()) return;
    expect(await cashFactsDigest(h.env().admin)).toBe(cashBaseline);
  });
});

// ===========================================================================
// Shift open vs revoke (RT-365, Codex P1): a shift can never open on a device
// after its revoke commits.
// ===========================================================================
describe("shift open serializes with the revoke", () => {
  const inTenantA = <T>(work: (c: PoolClient) => Promise<T>): Promise<T> =>
    runWithTenantContext(h.env().app, { tenantId: TENANT_A, isPlatformAdmin: false }, work);
  const scopeOf = (deviceId: string) => ({ tenantId: TENANT_A, storeId: STORE_A_X, deviceId });
  const shiftCount = async (deviceId: string): Promise<number> => {
    const r = await h.env().admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM shifts WHERE opening_device_id = $1`,
      [deviceId],
    );
    return r.rows[0]!.n;
  };

  it("a cash-up open waiting on the revoke's row lock is refused once the revoke commits", async () => {
    if (skip()) return;
    const revoker = await h.env().admin.connect();
    try {
      // The revoke's order: the lifecycle lock, then the row lock, then the update.
      await revoker.query("BEGIN");
      await lockDeviceLifecycle(revoker, { tenantId: TENANT_A, deviceId: R_RACE });
      await revoker.query(`SELECT 1 FROM devices WHERE id = $1 FOR UPDATE`, [R_RACE]);
      await revoker.query(
        `UPDATE devices SET revoked_at = now(), revoked_by = $2, revoke_reason = 'admin_error' WHERE id = $1`,
        [R_RACE, ownerUserId],
      );
      let settled = false;
      const open = inTenantA((c) => new ShiftCashUpRepository().lockOpenableDevice(c, scopeOf(R_RACE))).finally(() => {
        settled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(settled).toBe(false); // the open waits on the revoke's lock
      await revoker.query("COMMIT");
      expect(await open).toBe(false);
    } finally {
      revoker.release();
    }
    expect(await shiftCount(R_RACE)).toBe(0);
  });

  it("an unrevoked device stays openable", async () => {
    if (skip()) return;
    expect(await inTenantA((c) => new ShiftCashUpRepository().lockOpenableDevice(c, scopeOf(D_SOON)))).toBe(true);
  });

  it("an audit-ingest shift.open of a revoked device records no shift row", async () => {
    if (skip()) return;
    await h.env().admin.query(`UPDATE devices SET revoked_at = now() WHERE id = $1`, [R_LEGACY_LATE]);
    const late = "0a000000-0000-7000-8000-0000036503f1";
    const live = "0a000000-0000-7000-8000-0000036503f2";
    const at = "2026-10-16T12:00:00Z";
    const counts = await inTenantA(async (c) => {
      const a = await c.query(LEGACY_SHIFT_OPEN_SQL, [late, TENANT_A, STORE_A_X, CASHIER_A, R_LEGACY_LATE, at]);
      const b = await c.query(LEGACY_SHIFT_OPEN_SQL, [live, TENANT_A, STORE_A_X, CASHIER_A, D_SOON, at]);
      return [a.rowCount, b.rowCount];
    });
    expect(counts).toEqual([0, 1]);
    await h.env().admin.query(`DELETE FROM shifts WHERE shift_id = $1`, [live]);
  });
});

describe("revoke waits for a shift open that holds the lifecycle lock (reverse race)", () => {
  it("a non-security revoke that waited on a committed shift open is 409 unresolved_cash_session", async () => {
    if (skip()) return;
    const scope = { tenantId: TENANT_A, storeId: STORE_A_X, deviceId: R_REVERSE };
    const repo = new ShiftCashUpRepository();
    const opener = await h.env().admin.connect();
    let response: request.Response | null = null;
    try {
      // The cash-up open's order: the lifecycle lock and the revoked_at
      // recheck, then the insert. The revoke starts in between: before the
      // insert there is no FK lock on the device row yet, so only the shared
      // lifecycle lock can make the revoke wait (without it the revoke would
      // see no shift, succeed, and the insert would then land on a revoked
      // device).
      await opener.query("BEGIN");
      expect(await repo.lockOpenableDevice(opener, scope)).toBe(true);

      const revoking = post(revoke(R_REVERSE), SES_OWNER_ALL, { reason: "admin_error" }).then((res) => {
        response = res;
        return res;
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(response).toBeNull(); // the revoke waits on the open's lifecycle lock

      const opened = await repo.insertShift(opener, scope, {
        shiftId: "0a000000-0000-7000-8000-0000036503e1",
        openedAt: "2026-10-16T13:00:00Z",
        openingUserId: CASHIER_A,
        currencyCode: "EGP",
        openingFloat: "100.00",
        recordedByUserId: CASHIER_A,
        payloadHash: Buffer.alloc(32, 7),
      });
      expect(opened.kind).toBe("inserted");
      await opener.query("COMMIT");
      await expectError(await revoking, 409, "unresolved_cash_session");
    } finally {
      opener.release();
    }
    expect((await deviceRow(R_REVERSE)).revoked_at).toBeNull();
    expect(await revokeAudits(R_REVERSE)).toEqual([]);
  });
});

describe("revoke CSRF (RT-430)", () => {
  it("refuses a cookie-authenticated revoke without an Origin with 403 origin_rejected", async () => {
    if (skip()) return;
    // No test-session header: the real SessionOnlyAdminGuard runs, sees the
    // session cookie on an unsafe method, and checks Origin before any lookup.
    const res = await post(revoke(R_PLAIN), null, { reason: "lost" }).set("Cookie", "dp2_session=rt365-no-origin");
    await expectError(res, 403, "origin_rejected");
  });
});

