/**
 * RT-177 — ERPNext negative on-hand: pure projection + controller unit spec
 * (Docker-free).
 *
 *   §1 canonical exact-decimal "negative" test (`-0.000000` is not negative;
 *      no float ever touches a quantity).
 *   §2 view order + filtering of report entries (verbatim quantities, unmapped
 *      entries kept, malformed entries skipped).
 *   §3 opaque cursors: round-trip, cross-operation and garbage → InvalidCursorError;
 *      keyset paging has no duplicates or gaps.
 *   §4 snapshot freshness (RT-51 D4).
 *   §5 item projection ("tenantProduct null iff unmapped").
 *   §6 controller: no session → 401, cursor error → 400, invisible store → 404,
 *      store scope from the session reaches the service.
 */
import "reflect-metadata";

import {
  BadRequestException,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";

import { NegativeOnHandController } from "../../../../src/catalog/erpnext-reconciliation/negative-on-hand.controller";
import {
  InvalidCursorError,
  STALE_AFTER_SECONDS,
  compareEntries,
  decodeItemCursor,
  decodeStoreCursor,
  encodeItemCursor,
  encodeStoreCursor,
  isStrictlyNegative,
  negativeEntries,
  pageEntries,
  servesItems,
  snapshotStatus,
  toNegativeOnHandItem,
  toScaledQuantity,
  type NegativeEntry,
  type PositionedEntry,
} from "../../../../src/catalog/erpnext-reconciliation/negative-on-hand.projection";
import {
  NegativeOnHandStoreNotFoundError,
  type NegativeOnHandService,
} from "../../../../src/catalog/erpnext-reconciliation/negative-on-hand.service";
import { readScope } from "../../../../src/context/operator-store-scope";
import type { TenantContextRequest } from "../../../../src/context/types";

const TENANT = "01900000-0000-7000-8000-0000000000a1";
const USER = "01900000-0000-7000-8000-0000000000d1";
const STORE = "01900000-0000-7000-8000-0000000000c1";
const PRODUCT = "01900000-0000-7000-8000-0000000000e1";
const RUN = "01900000-0000-7000-8000-0000000000f1";

function positioned(
  rows: Array<[name: unknown, quantity: unknown, product?: unknown, uom?: unknown]>,
): PositionedEntry[] {
  return rows.map(([name, quantity, product, uom], i) => ({
    ordinal: i + 1,
    entry: {
      erpnextItemRef: name,
      tenant_product_ref: product ?? null,
      quantity,
      stockUom: uom ?? "Nos",
    },
  }));
}

describe("RT-177 §1 — canonical exact-decimal negative test", () => {
  it.each([
    ["-3.000000", true],
    ["-1.5", true],
    ["-0.000001", true],
    ["-999999999999999.999999", true],
    ["-0.000000", false],
    ["-0", false],
    ["-000.0", false],
    ["0", false],
    ["0.000000", false],
    ["5.000000", false],
  ])("isStrictlyNegative(%s) = %s", (q, expected) => {
    expect(isStrictlyNegative(q)).toBe(expected);
  });

  it.each(["", "-", "1e3", "-1e3", "-1.0000001", "NaN", " -1", "-1.", "--1", "0x10"])(
    "rejects the non-exact-decimal %p (never negative, never parsed as a float)",
    (q) => {
      expect(toScaledQuantity(q)).toBeNull();
      expect(isStrictlyNegative(q)).toBe(false);
    },
  );

  it("scales exactly beyond float precision", () => {
    expect(toScaledQuantity("-123456789012345.123456")).toBe(-123456789012345123456n);
    expect(toScaledQuantity("-0.1")).toBe(-100000n);
    expect(toScaledQuantity("-00010.50")).toBe(-10500000n);
  });
});

describe("RT-177 §2 — entry filtering + view order", () => {
  it("keeps exactly the strictly-negative entries, verbatim, most negative first", () => {
    const out = negativeEntries(
      positioned([
        ["A", "-3.000000", PRODUCT],
        ["B", "5.000000", PRODUCT],
        ["C", "-1.500000"],
        ["Z", "-0.000000"],
      ]),
    );
    expect(out.map((e) => [e.name, e.quantity, e.tenantProductRef])).toEqual([
      ["A", "-3.000000", PRODUCT],
      ["C", "-1.500000", null],
    ]);
  });

  it("orders by exact quantity (not by string), then name, then report position", () => {
    const out = negativeEntries(
      positioned([
        ["b", "-9.5"],
        ["a", "-10"],
        ["c", "-9.500000"],
        ["a", "-9.5"],
        ["a", "-9.5"],
      ]),
    );
    expect(out.map((e) => `${e.name}:${e.quantity}:${e.ordinal}`)).toEqual([
      "a:-10:2",
      "a:-9.5:4",
      "a:-9.5:5",
      "b:-9.5:1",
      "c:-9.500000:3",
    ]);
  });

  it("skips malformed entries instead of failing the read", () => {
    const out = negativeEntries(
      positioned([
        [null, "-1"],
        ["", "-1"],
        ["x".repeat(141), "-1"],
        ["NUM", -1],
        ["BADQ", "-1e3"],
        ["NOUOM", "-1", null, ""],
        [{ name: "OBJ" }, "-2", "not-a-uuid"],
      ]),
    );
    expect(out.map((e) => [e.name, e.tenantProductRef])).toEqual([["OBJ", null]]);
  });
});

describe("RT-177 §3 — opaque, scope-bound cursors + keyset paging", () => {
  const OTHER_TENANT = "01900000-0000-7000-8000-0000000000a2";
  const OTHER_STORE = "01900000-0000-7000-8000-0000000000c2";
  const itemScope = { tenantId: TENANT, storeId: STORE };
  const b64 = (payload: unknown): string => Buffer.from(JSON.stringify(payload)).toString("base64url");
  const firstEntry = (): NegativeEntry => negativeEntries(positioned([["Ä-ü", "-1.25"]]))[0]!;

  it("store cursor round-trips under its tenant", () => {
    const cursor = encodeStoreCursor({ tenantId: TENANT, storeId: STORE });
    expect(decodeStoreCursor({ tenantId: TENANT, cursor })).toBe(STORE);
  });

  it("item cursor round-trips under its tenant + store", () => {
    const cursor = encodeItemCursor({ ...itemScope, entry: firstEntry() });
    expect(decodeItemCursor({ ...itemScope, cursor })).toEqual({ scaled: -1250000n, name: "Ä-ü", ordinal: 1 });
  });

  it.each([
    { label: "garbage", cursor: "!!!" },
    { label: "not json", cursor: Buffer.from("nope").toString("base64url") },
    { label: "json array", cursor: b64([]) },
    { label: "extra key", cursor: b64({ k: "s", t: TENANT, s: STORE, x: 1 }) },
    { label: "unbound (pre-binding shape)", cursor: b64({ k: "s", s: STORE }) },
  ])("rejects a $label cursor on both operations", ({ cursor }) => {
    expect(() => decodeStoreCursor({ tenantId: TENANT, cursor })).toThrow(InvalidCursorError);
    expect(() => decodeItemCursor({ ...itemScope, cursor })).toThrow(InvalidCursorError);
  });

  it("a cursor of one operation is rejected by the other (kinds cannot be swapped)", () => {
    const itemCursor = encodeItemCursor({ ...itemScope, entry: firstEntry() });
    const storeCursor = encodeStoreCursor({ tenantId: TENANT, storeId: STORE });
    expect(() => decodeStoreCursor({ tenantId: TENANT, cursor: itemCursor })).toThrow(InvalidCursorError);
    expect(() => decodeItemCursor({ ...itemScope, cursor: storeCursor })).toThrow(InvalidCursorError);
  });

  it("an item cursor is bound to its store and tenant; a store cursor to its tenant", () => {
    const itemCursor = encodeItemCursor({ ...itemScope, entry: firstEntry() });
    expect(() => decodeItemCursor({ tenantId: TENANT, storeId: OTHER_STORE, cursor: itemCursor })).toThrow(
      InvalidCursorError,
    );
    expect(() => decodeItemCursor({ tenantId: OTHER_TENANT, storeId: STORE, cursor: itemCursor })).toThrow(
      InvalidCursorError,
    );
    const storeCursor = encodeStoreCursor({ tenantId: TENANT, storeId: STORE });
    expect(() => decodeStoreCursor({ tenantId: OTHER_TENANT, cursor: storeCursor })).toThrow(InvalidCursorError);
    // uuid comparison is case-insensitive.
    expect(decodeItemCursor({ tenantId: TENANT.toUpperCase(), storeId: STORE.toUpperCase(), cursor: itemCursor }).ordinal).toBe(1);
  });

  it("an item cursor with a non-decimal quantity is rejected", () => {
    const bad = b64({ k: "i", t: TENANT, st: STORE, q: "-1e3", n: "A", o: 1 });
    expect(() => decodeItemCursor({ ...itemScope, cursor: bad })).toThrow(InvalidCursorError);
  });

  it("pages cover every entry exactly once, in order, at every page size", () => {
    const rows: Array<[string, string]> = [];
    for (let i = 0; i < 23; i++) rows.push([`I${i % 7}`, `-${(i % 5) + 1}.${i % 3}`]);
    const ordered = negativeEntries(positioned(rows));
    for (const limit of [1, 2, 5, 22, 23, 24]) {
      const seen: number[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const position = cursor ? decodeItemCursor({ ...itemScope, cursor }) : null;
        const { page, nextCursor } = pageEntries({ ordered, cursor: position, limit, scope: itemScope });
        expect(page.length).toBeLessThanOrEqual(limit);
        seen.push(...page.map((e) => e.ordinal));
        cursor = nextCursor;
        pages += 1;
      } while (cursor !== null && pages < 100);
      expect(seen).toEqual(ordered.map((e) => e.ordinal));
      expect(pages).toBe(Math.max(1, Math.ceil(ordered.length / limit)));
    }
  });

  it("compareEntries is a total order on (quantity, name, ordinal)", () => {
    const a = { scaled: -1n, name: "A", ordinal: 1 };
    expect(compareEntries(a, { ...a })).toBe(0);
    expect(compareEntries(a, { ...a, ordinal: 2 })).toBeLessThan(0);
    expect(compareEntries(a, { ...a, name: "B" })).toBeLessThan(0);
    expect(compareEntries(a, { ...a, scaled: -2n })).toBeGreaterThan(0);
  });
});

describe("RT-177 §4 — snapshot freshness (RT-51 D4)", () => {
  const now = new Date("2026-10-04T12:00:00.000Z");
  const snapshot = {
    runId: RUN,
    erpnextWarehouseRef: "WH-S",
    readAt: "2026-10-04T11:59:00+02:00",
    recordedAt: "2026-10-04T11:00:00.000Z",
    reportedEntryCount: 3,
  };
  const pending = { runId: PRODUCT, requestedAt: "2026-10-04T11:30:00.000Z" };

  it("no active stock map → no_warehouse_mapping, everything null, even with an old snapshot", () => {
    const s = snapshotStatus({ mappedWarehouseRef: null, snapshot, pending, now });
    expect(s).toEqual({
      status: "no_warehouse_mapping",
      erpnextWarehouseRef: null,
      runId: null,
      readAt: null,
      recordedAt: null,
      staleAfterSeconds: STALE_AFTER_SECONDS,
      reportedEntryCount: null,
      pendingRequest: null,
    });
    expect(servesItems(s)).toBe(false);
  });

  it("mapped, no snapshot → no_snapshot with the mapped warehouse + the pending request", () => {
    const s = snapshotStatus({ mappedWarehouseRef: "WH-M", snapshot: null, pending, now });
    expect(s.status).toBe("no_snapshot");
    expect(s.erpnextWarehouseRef).toBe("WH-M");
    expect(s.pendingRequest).toEqual(pending);
    expect(servesItems(s)).toBe(false);
  });

  it("recordedAt within staleAfterSeconds → fresh (boundary inclusive)", () => {
    const edge = new Date(Date.parse(snapshot.recordedAt) + STALE_AFTER_SECONDS * 1000);
    const s = snapshotStatus({ mappedWarehouseRef: "WH-M", snapshot, pending: null, now: edge });
    expect(s.status).toBe("fresh");
    expect(s.erpnextWarehouseRef).toBe("WH-S");
    expect(s.staleAfterSeconds).toBe(86_400);
    expect(servesItems(s)).toBe(true);
  });

  it("recordedAt older than staleAfterSeconds → stale, still serves items", () => {
    const later = new Date(Date.parse(snapshot.recordedAt) + STALE_AFTER_SECONDS * 1000 + 1);
    const s = snapshotStatus({ mappedWarehouseRef: "WH-M", snapshot, pending, now: later });
    expect(s.status).toBe("stale");
    expect(s.pendingRequest).toEqual(pending);
    expect(servesItems(s)).toBe(true);
  });

  it("an unparseable recordedAt cannot prove freshness → stale", () => {
    const s = snapshotStatus({
      mappedWarehouseRef: "WH-M",
      snapshot: { ...snapshot, recordedAt: "yesterday" },
      pending: null,
      now,
    });
    expect(s.status).toBe("stale");
  });

  it("a snapshot without a warehouse ref falls back to the mapped warehouse", () => {
    const s = snapshotStatus({
      mappedWarehouseRef: "WH-M",
      snapshot: { ...snapshot, erpnextWarehouseRef: null },
      pending: null,
      now,
    });
    expect(s.erpnextWarehouseRef).toBe("WH-M");
  });
});

describe("RT-177 §5 — item projection", () => {
  const [mapped, unmapped] = negativeEntries(
    positioned([
      ["A", "-3.000000", PRODUCT],
      ["C", "-1.500000"],
    ]),
  );

  it("mapped entry with a named product → mapped + tenantProduct", () => {
    expect(toNegativeOnHandItem(mapped!, "WH", new Map([[PRODUCT, "Apples"]]))).toEqual({
      discrepancyKind: "erpnext_negative_on_hand",
      erpnextItemRef: { doctype: "Item", name: "A" },
      mappingStatus: "mapped",
      tenantProduct: { id: PRODUCT, name: "Apples" },
      erpnextWarehouseRef: "WH",
      quantity: "-3.000000",
      stockUom: "Nos",
    });
  });

  it("unmapped entry → unmapped + null product", () => {
    const item = toNegativeOnHandItem(unmapped!, "WH", new Map());
    expect(item.mappingStatus).toBe("unmapped");
    expect(item.tenantProduct).toBeNull();
    expect(item.quantity).toBe("-1.500000");
  });

  it("a product ref with no visible product row → unmapped (null iff unmapped)", () => {
    const item = toNegativeOnHandItem(mapped!, "WH", new Map());
    expect(item.mappingStatus).toBe("unmapped");
    expect(item.tenantProduct).toBeNull();
  });
});

describe("RT-177 §6 — controller", () => {
  const ctx = {
    userId: USER,
    tenantId: TENANT,
    storeId: null,
    isPlatformAdmin: false,
    source: "session" as const,
    storeAccess: { kind: "specific" as const, storeIds: [STORE] },
  };
  const reqWith = (context: TenantContextRequest["context"]): TenantContextRequest =>
    ({ context }) as TenantContextRequest;
  const authed = reqWith(ctx);
  const noCtx = reqWith(undefined);
  const noTenant = reqWith({ ...ctx, tenantId: null });

  function controllerWith(svc: Partial<NegativeOnHandService>): NegativeOnHandController {
    return new NegativeOnHandController(svc as NegativeOnHandService);
  }

  it("no session context / no tenant → 401 on both operations", async () => {
    const c = controllerWith({});
    for (const req of [noCtx, noTenant]) {
      await expect(c.listErpnextNegativeOnHandStores(req, {})).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      await expect(c.listErpnextNegativeOnHand(req, STORE, {})).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    }
  });

  it("passes the session context, default limit 100 and the cursor to the service", async () => {
    const listStores = jest.fn().mockResolvedValue({ items: [], nextCursor: null });
    const listItems = jest.fn().mockResolvedValue({ storeId: STORE, items: [], nextCursor: null });
    const c = controllerWith({ listStores, listItems });
    await c.listErpnextNegativeOnHandStores(authed, {});
    await c.listErpnextNegativeOnHand(authed, STORE, { cursor: "abc", limit: 7 });
    expect(listStores).toHaveBeenCalledWith({
      tenantId: TENANT,
      context: ctx,
      cursor: null,
      limit: 100,
    });
    expect(listItems).toHaveBeenCalledWith({
      tenantId: TENANT,
      context: ctx,
      storeId: STORE,
      cursor: "abc",
      limit: 7,
    });
  });

  it("an invalid cursor → 400 validation_error", async () => {
    const c = controllerWith({
      listStores: jest.fn().mockRejectedValue(new InvalidCursorError()),
      listItems: jest.fn().mockRejectedValue(new InvalidCursorError()),
    });
    const stores = c.listErpnextNegativeOnHandStores(authed, { cursor: "x" });
    await expect(stores).rejects.toBeInstanceOf(BadRequestException);
    await expect(c.listErpnextNegativeOnHand(authed, STORE, { cursor: "x" })).rejects.toMatchObject({
      response: { code: "validation_error" },
    });
  });

  it("an invisible store → non-disclosing 404 not_found", async () => {
    const c = controllerWith({
      listItems: jest.fn().mockRejectedValue(new NegativeOnHandStoreNotFoundError()),
    });
    await expect(c.listErpnextNegativeOnHand(authed, STORE, {})).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("any other error propagates unchanged", async () => {
    const boom = new Error("boom");
    const c = controllerWith({ listStores: jest.fn().mockRejectedValue(boom) });
    await expect(c.listErpnextNegativeOnHandStores(authed, {})).rejects.toBe(boom);
  });
});

describe("RT-177 §7 — read scope by role (RT-51 D6)", () => {
  const OTHER = "01900000-0000-7000-8000-0000000000c2";
  const base = {
    userId: USER,
    tenantId: TENANT,
    isPlatformAdmin: false,
    source: "session" as const,
  };
  const allAccess = { kind: "all" as const };
  const specific = { kind: "specific" as const, storeIds: [STORE, OTHER] };

  it.each([{ roleCode: "owner" }, { roleCode: "tenant_admin" }])(
    "$roleCode with an active store and 'all' access → tenant-wide",
    ({ roleCode }) => {
      const context = { ...base, storeId: STORE, storeAccess: allAccess };
      expect(readScope({ context, roleCode })).toEqual({ kind: "tenant" });
    },
  );

  it("owner with a 'specific' membership keeps its grant (the role never widens a membership)", () => {
    const context = { ...base, storeId: STORE, storeAccess: specific };
    expect(readScope({ context, roleCode: "owner" })).toEqual({ kind: "stores", storeIds: [STORE, OTHER] });
  });

  it("store_manager with an active store → that store only (RT-131)", () => {
    const context = { ...base, storeId: STORE, storeAccess: specific };
    expect(readScope({ context, roleCode: "store_manager" })).toEqual({ kind: "stores", storeIds: [STORE] });
  });

  it("store_manager without an active store → its granted stores; unknown role → standard scope", () => {
    const context = { ...base, storeId: null, storeAccess: specific };
    expect(readScope({ context, roleCode: "store_manager" })).toEqual({ kind: "stores", storeIds: [STORE, OTHER] });
    expect(readScope({ context: { ...context, storeId: OTHER }, roleCode: null })).toEqual({
      kind: "stores",
      storeIds: [OTHER],
    });
  });
});
