/**
 * RT-383 — Docker-free unit tests of the admin shift-close reads: the keyset
 * cursor, the wire projections, the query schema and the controller's error
 * mapping. The HTTP + Postgres behaviour is `shift-closes.http.integration.spec.ts`.
 */
import "reflect-metadata";

import { BadRequestException, NotFoundException, UnauthorizedException } from "@nestjs/common";

import type { TenantContextRequest } from "../../src/context/types";
import { ShiftClosesController } from "../../src/shift-closes/shift-closes.controller";
import {
  decodeShiftCloseCursor,
  encodeShiftCloseCursor,
  InvalidShiftCloseCursorError,
  toShiftCloseDetail,
  toShiftCloseSummary,
  type ShiftCloseDetailRow,
} from "../../src/shift-closes/shift-closes.projections";
import { ShiftCloseListQuerySchema, ShiftIdParamSchema } from "../../src/shift-closes/shift-closes.query";
import {
  ShiftCloseNotFoundError,
  StoreNotInScopeError,
  type ShiftClosesReadService,
} from "../../src/shift-closes/shift-closes.service";

const TENANT = "0a000000-0000-7000-8000-000003830001";
const OTHER_TENANT = "0b000000-0000-7000-8000-000003830001";
const SHIFT = "0a000000-0000-7000-8000-000003830002";
const STORE = "0a000000-0000-7000-8000-000003830003";
const USER = "0a000000-0000-7000-8000-000003830004";
const KEY = "2026-10-04T10:00:00.000001Z";

const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");

describe("shift-close cursor", () => {
  it("round-trips the full-precision keyset for the issuing tenant", () => {
    const cursor = encodeShiftCloseCursor({ tenantId: TENANT, closedAtKey: KEY, shiftId: SHIFT });
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeShiftCloseCursor({ tenantId: TENANT.toUpperCase(), cursor })).toEqual({
      closedAtKey: KEY,
      shiftId: SHIFT,
    });
  });

  it.each([
    ["another tenant's cursor", encodeShiftCloseCursor({ tenantId: OTHER_TENANT, closedAtKey: KEY, shiftId: SHIFT })],
    ["not JSON", Buffer.from("{not json", "utf8").toString("base64url")],
    ["another operation's kind", b64({ k: "i", t: TENANT, c: KEY, s: SHIFT })],
    ["an extra key", b64({ k: "shift_closes", t: TENANT, c: KEY, s: SHIFT, x: 1 })],
    ["a millisecond-only key", b64({ k: "shift_closes", t: TENANT, c: "2026-10-04T10:00:00.000Z", s: SHIFT })],
    ["an impossible date", b64({ k: "shift_closes", t: TENANT, c: "2026-13-45T10:00:00.000001Z", s: SHIFT })],
    ["a day Date.parse rolls over", b64({ k: "shift_closes", t: TENANT, c: "2026-02-31T00:00:00.000000Z", s: SHIFT })],
    ["an hour Date.parse rolls over", b64({ k: "shift_closes", t: TENANT, c: "2026-10-03T24:00:00.000000Z", s: SHIFT })],
    ["an upper-case shift id", b64({ k: "shift_closes", t: TENANT, c: KEY, s: SHIFT.toUpperCase() })],
    ["a JSON array", b64([TENANT, KEY, SHIFT])],
  ])("rejects %s", (_label, cursor) => {
    expect(() => decodeShiftCloseCursor({ tenantId: TENANT, cursor })).toThrow(InvalidShiftCloseCursorError);
  });
});

function detailRow(overrides: Partial<ShiftCloseDetailRow> = {}): ShiftCloseDetailRow {
  return {
    shift_id: SHIFT,
    store_id: STORE,
    currency_code: "EGP",
    closed_at: new Date("2026-10-03T10:00:00.000Z"),
    closed_at_key: "2026-10-03T10:00:00.000000Z",
    close_kind: "normal",
    forced_reason: null,
    closing_user_id: USER,
    variance_approved_by_user_id: null,
    opening_float: "500.0000",
    cash_sales_total: "1000.0000",
    cash_refunds_total: "0.0000",
    pay_in_total: "0.0000",
    pay_out_total: "0.0000",
    expected_cash: "1500.0000",
    counted_cash: "1495.0000",
    variance: "-5.0000",
    sale_count: 3,
    received_at: new Date("2026-10-03T10:00:01.000Z"),
    opened_at: new Date("2026-10-03T02:00:00.000Z"),
    opening_user_id: USER,
    recorded_by_user_id: USER,
    ...overrides,
  };
}

describe("shift-close projections", () => {
  it("formats stored numeric(19,4) money to the currency's minor unit, signed", () => {
    expect(toShiftCloseSummary(detailRow())).toMatchObject({
      openingFloat: "500.00",
      variance: "-5.00",
      forcedReason: null,
      varianceApprovedByUserId: null,
      closedAt: "2026-10-03T10:00:00.000Z",
    });
  });

  it("drops only zero digits: a zero-minor-unit currency has none, a three-digit one keeps three", () => {
    expect(toShiftCloseSummary(detailRow({ currency_code: "JPY", variance: "-5.0000" })).variance).toBe("-5");
    expect(toShiftCloseSummary(detailRow({ currency_code: "KWD", variance: "1.2500" })).variance).toBe("1.250");
  });

  it("never exposes the DB row's private columns", () => {
    const summary = toShiftCloseSummary(detailRow());
    expect(summary).not.toHaveProperty("closed_at_key");
    expect(summary).not.toHaveProperty("openedAt");
  });

  it("builds the detail with movements in the close's currency", () => {
    const detail = toShiftCloseDetail({
      row: detailRow({ close_kind: "forced", forced_reason: "Left early", variance_approved_by_user_id: USER }),
      refundReturnRefs: [SHIFT],
      movements: [
        {
          id: SHIFT,
          kind: "pay_out",
          amount: "20.0000",
          reason_code: "bank_drop",
          note: null,
          occurred_at: new Date("2026-10-03T06:00:00.000Z"),
          recorded_by_user_id: USER,
          received_at: new Date("2026-10-03T06:00:01.000Z"),
        },
      ],
    });
    expect(detail).toMatchObject({
      closeKind: "forced",
      forcedReason: "Left early",
      varianceApprovedByUserId: USER,
      openedAt: "2026-10-03T02:00:00.000Z",
      openingUserId: USER,
      recordedByUserId: USER,
      cashRefundReturnRefs: [SHIFT],
      cashMovements: [{ movementId: SHIFT, amount: "20.00", note: null, reasonCode: "bank_drop" }],
    });
  });
});

describe("shift-close query schema", () => {
  const parse = (q: Record<string, unknown>) => ShiftCloseListQuerySchema.safeParse(q);

  it("lower-cases ids and coerces page_size", () => {
    const r = parse({ store_id: STORE.toUpperCase(), page_size: "7" });
    expect(r.success && r.data).toEqual({ store_id: STORE, page_size: 7 });
    expect(ShiftIdParamSchema.parse(SHIFT.toUpperCase())).toBe(SHIFT);
  });

  it.each([
    ["one second later", "2026-10-03T10:00:00Z", "2026-10-03T10:00:01Z", true],
    ["the same instant in two offsets", "2026-10-03T10:00:00Z", "2026-10-03T12:00:00+02:00", false],
    ["one microsecond later", "2026-10-03T10:00:00.000001Z", "2026-10-03T10:00:00.000002Z", true],
    ["one microsecond earlier", "2026-10-03T10:00:00.000002Z", "2026-10-03T10:00:00.000001Z", false],
    ["trailing zeros only", "2026-10-03T10:00:00.5Z", "2026-10-03T10:00:00.500000Z", false],
    ["an earlier day", "2026-10-04T00:00:00Z", "2026-10-03T00:00:00Z", false],
  ])("closed_to %s than closed_from: valid=%s", (_label, from, to, valid) => {
    expect(parse({ closed_from: from, closed_to: to }).success).toBe(valid);
  });

  it("accepts either bound alone", () => {
    expect(parse({ closed_from: "2026-10-03T10:00:00Z" }).success).toBe(true);
    expect(parse({ closed_to: "2026-10-03T10:00:00Z" }).success).toBe(true);
  });

  it.each([
    ["2026-10-01T10:00:00Z", true],
    ["2026-10-01T10:00:00.123456+15:59", true],
    ["2026-10-01T10:00:00-15:59", true],
    ["0001-01-01T00:00:00Z", true],
    ["2026-10-01T10:00:00+16:00", false],
    ["2026-10-01T10:00:00-23:59", false],
    ["2026-10-01T10:00:00+99:99", false],
    ["2026-10-01T10:00:00+05:99", false],
    ["2026-10-01T10:00:00+0530", false],
    ["0000-01-01T00:00:00Z", false],
  ])("closed_from %s: valid=%s (an instant Postgres can represent)", (value, valid) => {
    expect(parse({ closed_from: value }).success).toBe(valid);
  });

  it("rejects an unknown key", () => {
    expect(parse({ tenant_id: TENANT }).success).toBe(false);
  });
});

describe("ShiftClosesController error mapping", () => {
  const request = { context: { tenantId: TENANT } } as unknown as TenantContextRequest;
  const service = (impl: Partial<ShiftClosesReadService>) =>
    new ShiftClosesController(impl as ShiftClosesReadService);

  it("a request without a resolved tenant is 401", async () => {
    const controller = service({});
    const noTenant = { context: { tenantId: null } } as unknown as TenantContextRequest;
    await expect(controller.list(noTenant, {})).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(controller.get({} as TenantContextRequest, SHIFT)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("maps a foreign cursor to 400 and an out-of-scope store to 404", async () => {
    const badCursor = service({ list: () => Promise.reject(new InvalidShiftCloseCursorError()) });
    await expect(badCursor.list(request, { cursor: "x" })).rejects.toBeInstanceOf(BadRequestException);
    const outOfScope = service({ list: () => Promise.reject(new StoreNotInScopeError()) });
    await expect(outOfScope.list(request, { store_id: STORE })).rejects.toBeInstanceOf(NotFoundException);
  });

  it("passes the defaults and only the filters given", async () => {
    const list = jest.fn().mockResolvedValue({ items: [], nextCursor: null });
    await service({ list }).list(request, { approval: "approved" });
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT, cursor: null, limit: 50, filters: { approval: "approved" } }),
    );
  });

  it("maps a missing close to 404 and a malformed id to 400", async () => {
    const missing = service({ get: () => Promise.reject(new ShiftCloseNotFoundError()) });
    await expect(missing.get(request, SHIFT)).rejects.toBeInstanceOf(NotFoundException);
    await expect(missing.get(request, "nope")).rejects.toBeInstanceOf(BadRequestException);
  });

  it("rethrows an unexpected error on both reads (→ 500)", async () => {
    const boom = new Error("db down");
    const failing = service({ list: () => Promise.reject(boom), get: () => Promise.reject(boom) });
    await expect(failing.list(request, {})).rejects.toBe(boom);
    await expect(failing.get(request, SHIFT)).rejects.toBe(boom);
  });
});
