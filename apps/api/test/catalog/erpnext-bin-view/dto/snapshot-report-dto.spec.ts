/**
 * RT-175 — SnapshotReportBodySchema unit spec (Docker-free).
 *
 * The stock-view 1.2.0-draft `BinViewSnapshotReport` body rules the DTO owns:
 * an optional strict `window {attemptRef, windowSeq, isFinal}`; entries ≤ the
 * request's `maxItems` (500); `windowSeq` < the request's `maxWindows` (20); a
 * window other than `{windowSeq 0, isFinal true}` carries ≥ 1 entry. A v1 body
 * (no `window`) validates exactly as before, empty entries included.
 */
import {
  BIN_VIEW_MAX_WINDOWS,
  BIN_VIEW_WINDOW_MAX_ITEMS,
  SnapshotReportBodySchema,
} from "../../../../src/catalog/erpnext-bin-view/dto/snapshot-report.dto";

const ATTEMPT = "0a000000-0000-4000-8000-0000000a1752";
const READ_AT = "2026-10-04T08:00:00.000Z";

const entries = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    erpnextItemRef: { doctype: "Item", name: `ERP-${i}` },
    quantity: "1.000000",
    stockUom: "Nos",
  }));

const ok = (body: unknown): boolean => SnapshotReportBodySchema.safeParse(body).success;

describe("RT-175 SnapshotReportBodySchema — v1.2 window rules", () => {
  it("constants match the advertised request (maxItems 500, maxWindows 20)", () => {
    expect(BIN_VIEW_WINDOW_MAX_ITEMS).toBe(500);
    expect(BIN_VIEW_MAX_WINDOWS).toBe(20);
  });

  it("v1 body (no window) is unchanged: empty and full reports validate", () => {
    expect(ok({ entries: [], readAt: READ_AT })).toBe(true);
    expect(ok({ entries: entries(500), readAt: READ_AT })).toBe(true);
    expect(ok({ entries: entries(501), readAt: READ_AT })).toBe(false);
  });

  it("valid windows: non-final 1..500 entries, final last window, empty single final window 0", () => {
    expect(ok({ entries: entries(500), window: { attemptRef: ATTEMPT, windowSeq: 0, isFinal: false }, readAt: READ_AT })).toBe(true);
    expect(ok({ entries: entries(1), window: { attemptRef: ATTEMPT, windowSeq: 19, isFinal: true }, readAt: READ_AT })).toBe(true);
    expect(ok({ entries: [], window: { attemptRef: ATTEMPT, windowSeq: 0, isFinal: true }, readAt: READ_AT })).toBe(true);
  });

  it.each([
    ["non-final window 0 with 0 entries", { entries: [], window: { attemptRef: ATTEMPT, windowSeq: 0, isFinal: false } }],
    ["final window > 0 with 0 entries", { entries: [], window: { attemptRef: ATTEMPT, windowSeq: 2, isFinal: true } }],
    ["windowSeq = maxWindows", { entries: entries(1), window: { attemptRef: ATTEMPT, windowSeq: 20, isFinal: true } }],
    ["negative windowSeq", { entries: entries(1), window: { attemptRef: ATTEMPT, windowSeq: -1, isFinal: true } }],
    ["fractional windowSeq", { entries: entries(1), window: { attemptRef: ATTEMPT, windowSeq: 1.5, isFinal: true } }],
    ["window entries > maxItems", { entries: entries(501), window: { attemptRef: ATTEMPT, windowSeq: 0, isFinal: false } }],
    ["unknown key in window", { entries: entries(1), window: { attemptRef: ATTEMPT, windowSeq: 0, isFinal: true, more: true } }],
    ["missing isFinal", { entries: entries(1), window: { attemptRef: ATTEMPT, windowSeq: 0 } }],
    ["non-uuid attemptRef", { entries: entries(1), window: { attemptRef: "attempt-1", windowSeq: 0, isFinal: true } }],
  ])("%s → invalid", (_label, partial) => {
    expect(ok({ ...partial, readAt: READ_AT })).toBe(false);
  });
});
