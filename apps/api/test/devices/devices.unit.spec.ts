/**
 * RT-365 — pure units of the Console device registry: the revoke decision
 * (RT-287 D-Q4 as amended), the projections, the exception-first rank, the
 * keyset cursor and the request schemas. No DB, no HTTP
 * (`devices.http.integration.spec.ts` covers the wire and the transaction).
 */
import {
  decideRevoke,
  decodeDeviceCursor,
  encodeDeviceCursor,
  InvalidDeviceCursorError,
  toDeviceDetail,
  toDeviceSummary,
  type DeviceReadRow,
} from "../../src/devices/devices.projections";
import { DeviceListQuerySchema, DeviceRevokeBodySchema } from "../../src/devices/devices.query";

const TENANT = "0190f5a2-3b4c-7d8e-9f01-000000000001";
const DEVICE = "0190f5a2-3b4c-7d8e-9f01-23456789abcd";
const STORE = "0190f5a2-3b4c-7d8e-9f01-000000000002";
const USER = "0190f5a2-3b4c-7d8e-9f01-000000000003";
const SHIFT = "0190f5a2-3b4c-7d8e-9f01-000000000004";

const ACTIVE_ROW: DeviceReadRow = {
  id: DEVICE,
  store_id: STORE,
  label: "Till 1",
  created_at: new Date("2026-10-01T09:00:00.000Z"),
  expires_at: new Date("2026-12-30T09:00:00.000Z"),
  expires_at_key: "2026-12-30T09:00:00.000000Z",
  last_seen_at: null,
  revoked_at: null,
  revoked_by: null,
  revoke_reason: null,
  revoke_note: null,
  retired_at: null,
  retired_by: null,
  retire_reason: null,
  replaces_device_id: null,
  replaced_by_device_id: null,
  open_shift_id: null,
  rank: 1,
};

// ===========================================================================
// decideRevoke — RT-287 D-Q4 (amended)
// ===========================================================================
describe("decideRevoke", () => {
  const base = {
    alreadyRevoked: false,
    openShiftId: null as string | null,
    callerRole: "store_manager" as string | null,
    note: undefined as string | undefined,
    acknowledgeCustodyException: undefined as boolean | undefined,
  };

  it("answers already_revoked first, whatever the reason and the open shift", () => {
    for (const reason of ["admin_error", "hardware_failure", "lost"] as const) {
      expect(decideRevoke({ ...base, reason, alreadyRevoked: true, openShiftId: SHIFT })).toEqual({
        kind: "already_revoked",
      });
    }
  });

  it.each(["lost", "stolen", "suspected_compromise", "hardware_failure", "replaced", "moved", "retired", "admin_error", "other"] as const)(
    "revokes with %s when there is no open shift, with no custody exception",
    (reason) => {
      expect(decideRevoke({ ...base, reason })).toEqual({ kind: "revoke", custodyExceptionShiftId: null });
    },
  );

  it.each(["lost", "stolen", "suspected_compromise"] as const)(
    "a security revoke (%s) with an open shift succeeds for a store_manager, making the custody exception",
    (reason) => {
      expect(decideRevoke({ ...base, reason, openShiftId: SHIFT })).toEqual({
        kind: "revoke",
        custodyExceptionShiftId: SHIFT,
      });
    },
  );

  it.each(["replaced", "moved", "retired", "admin_error", "other"] as const)(
    "refuses %s with an open shift as 409 unresolved_cash_session, even for an owner",
    (reason) => {
      expect(
        decideRevoke({ ...base, reason, openShiftId: SHIFT, callerRole: "owner", note: "n", acknowledgeCustodyException: true }),
      ).toEqual({ kind: "refuse", status: 409, code: "unresolved_cash_session" });
    },
  );

  describe("recovery revoke (hardware_failure with an open shift)", () => {
    const recovery = { ...base, reason: "hardware_failure" as const, openShiftId: SHIFT };

    it.each(["owner", "tenant_admin"])("succeeds for %s with a note and the acknowledgement", (callerRole) => {
      expect(
        decideRevoke({ ...recovery, callerRole, note: "Dead till; cash in safe", acknowledgeCustodyException: true }),
      ).toEqual({ kind: "revoke", custodyExceptionShiftId: SHIFT });
    });

    it("refuses a store_manager with 403 before checking the note or acknowledgement", () => {
      expect(decideRevoke({ ...recovery, callerRole: "store_manager" })).toEqual({
        kind: "refuse",
        status: 403,
        code: "recovery_revoke_forbidden",
      });
      expect(decideRevoke({ ...recovery, callerRole: null })).toEqual({
        kind: "refuse",
        status: 403,
        code: "recovery_revoke_forbidden",
      });
    });

    it("refuses an owner without a note with 422 recovery_note_required", () => {
      expect(decideRevoke({ ...recovery, callerRole: "owner", acknowledgeCustodyException: true })).toEqual({
        kind: "refuse",
        status: 422,
        code: "recovery_note_required",
      });
    });

    it("refuses an owner without acknowledgement: true with 422 custody_exception_not_acknowledged", () => {
      for (const acknowledgeCustodyException of [undefined, false]) {
        expect(decideRevoke({ ...recovery, callerRole: "owner", note: "n", acknowledgeCustodyException })).toEqual({
          kind: "refuse",
          status: 422,
          code: "custody_exception_not_acknowledged",
        });
      }
    });
  });
});

// ===========================================================================
// Projections
// ===========================================================================
describe("device projections", () => {
  it("projects an active device with every key and no secret", () => {
    expect(toDeviceSummary(ACTIVE_ROW)).toEqual({
      deviceId: DEVICE,
      storeId: STORE,
      label: "Till 1",
      trustState: "active",
      createdAt: "2026-10-01T09:00:00.000Z",
      expiresAt: "2026-12-30T09:00:00.000Z",
      lastSeenAt: null,
      revokedAt: null,
      revokedByUserId: null,
      revokeReason: null,
      retiredAt: null,
      replacesDeviceId: null,
      replacedByDeviceId: null,
      custodyExceptionShiftId: null,
    });
  });

  it("never reports a custody exception on an active device, even with an open shift", () => {
    expect(toDeviceSummary({ ...ACTIVE_ROW, open_shift_id: SHIFT }).custodyExceptionShiftId).toBeNull();
  });

  it("reports the open shift of a revoked device as its custody exception", () => {
    const row: DeviceReadRow = {
      ...ACTIVE_ROW,
      revoked_at: new Date("2026-10-16T10:00:00.000Z"),
      revoked_by: USER,
      revoke_reason: "stolen",
      revoke_note: "secret-free note",
      open_shift_id: SHIFT,
      rank: 0,
    };
    expect(toDeviceSummary(row)).toMatchObject({
      trustState: "revoked",
      revokedAt: "2026-10-16T10:00:00.000Z",
      revokedByUserId: USER,
      revokeReason: "stolen",
      custodyExceptionShiftId: SHIFT,
    });
    expect(toDeviceSummary(row)).not.toHaveProperty("revokeNote");
    expect(toDeviceDetail(row)).toMatchObject({ revokeNote: "secret-free note", retiredByUserId: null, retireReason: null });
  });

  it("reports retired over revoked", () => {
    const row: DeviceReadRow = {
      ...ACTIVE_ROW,
      revoked_at: new Date("2026-10-16T10:00:00.000Z"),
      retired_at: new Date("2026-10-16T11:00:00.000Z"),
      retired_by: USER,
      retire_reason: "Decommissioned",
      rank: 3,
    };
    expect(toDeviceDetail(row)).toMatchObject({
      trustState: "retired",
      retiredAt: "2026-10-16T11:00:00.000Z",
      retiredByUserId: USER,
      retireReason: "Decommissioned",
    });
  });
});

// ===========================================================================
// Cursor
// ===========================================================================
describe("device cursor", () => {
  const keyset = { rank: 1, expiresAtKey: "2026-12-30T09:00:00.000000Z", deviceId: DEVICE };

  it("round-trips the keyset under the issuing tenant", () => {
    const cursor = encodeDeviceCursor({ tenantId: TENANT, ...keyset });
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeDeviceCursor({ tenantId: TENANT, cursor })).toEqual(keyset);
  });

  it("refuses a cursor of another tenant, another operation or garbage", () => {
    const cursor = encodeDeviceCursor({ tenantId: TENANT, ...keyset });
    expect(() => decodeDeviceCursor({ tenantId: USER, cursor })).toThrow(InvalidDeviceCursorError);
    const foreign = Buffer.from(JSON.stringify({ k: "shift_closes", t: TENANT, r: 1, e: keyset.expiresAtKey, d: DEVICE })).toString(
      "base64url",
    );
    expect(() => decodeDeviceCursor({ tenantId: TENANT, cursor: foreign })).toThrow(InvalidDeviceCursorError);
    expect(() => decodeDeviceCursor({ tenantId: TENANT, cursor: "bm90LWpzb24" })).toThrow(InvalidDeviceCursorError);
  });

  it("refuses an out-of-range rank or an impossible date", () => {
    const bad = (payload: object): string => Buffer.from(JSON.stringify(payload)).toString("base64url");
    expect(() =>
      decodeDeviceCursor({ tenantId: TENANT, cursor: bad({ k: "devices", t: TENANT, r: 4, e: keyset.expiresAtKey, d: DEVICE }) }),
    ).toThrow(InvalidDeviceCursorError);
    expect(() =>
      decodeDeviceCursor({
        tenantId: TENANT,
        cursor: bad({ k: "devices", t: TENANT, r: 1, e: "2026-02-31T00:00:00.000000Z", d: DEVICE }),
      }),
    ).toThrow(InvalidDeviceCursorError);
  });
});

// ===========================================================================
// Request schemas
// ===========================================================================
describe("device request schemas", () => {
  it("lower-cases the store filter and refuses an unknown key or trust state", () => {
    expect(DeviceListQuerySchema.parse({ store_id: STORE.toUpperCase(), trust_state: "revoked" })).toEqual({
      store_id: STORE,
      trust_state: "revoked",
    });
    expect(DeviceListQuerySchema.safeParse({ tenant_id: TENANT }).success).toBe(false);
    expect(DeviceListQuerySchema.safeParse({ trust_state: "expired" }).success).toBe(false);
    expect(DeviceListQuerySchema.safeParse({ page_size: "201" }).success).toBe(false);
    expect(DeviceListQuerySchema.parse({ page_size: "10" })).toEqual({ page_size: 10 });
  });

  it("accepts the contract's revoke bodies", () => {
    expect(DeviceRevokeBodySchema.safeParse({ reason: "lost" }).success).toBe(true);
    expect(
      DeviceRevokeBodySchema.safeParse({ reason: "hardware_failure", note: "n", acknowledgeCustodyException: true }).success,
    ).toBe(true);
    expect(DeviceRevokeBodySchema.safeParse({ reason: "other", note: "Pilot ended" }).success).toBe(true);
  });

  it.each([
    ["no reason", {}],
    ["an unknown reason", { reason: "broken" }],
    ["other without a note", { reason: "other" }],
    ["a blank note", { reason: "lost", note: "   " }],
    ["a note over 500 characters", { reason: "lost", note: "x".repeat(501) }],
    ["an unknown key", { reason: "lost", storeId: STORE }],
    ["a string acknowledgement", { reason: "lost", acknowledgeCustodyException: "true" }],
  ])("refuses a revoke body with %s", (_label, body) => {
    expect(DeviceRevokeBodySchema.safeParse(body).success).toBe(false);
  });
});
