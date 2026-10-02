/**
 * RT-131 — `resolveStoreScope`: store authority comes from the membership,
 * never from a null active store. Docker-free; the real-RLS HTTP proof is
 * test/catalog/unknown-items/isolation/store-scope-authz.spec.ts.
 */
import { resolveStoreScope } from "../../src/context/store-scope";
import type { ResolvedContext } from "../../src/context/types";

const STORE_X = "0a000000-0000-7000-8000-0000013100a1";
const STORE_Y = "0a000000-0000-7000-8000-0000013100a2";

function ctx(overrides: Partial<ResolvedContext>): ResolvedContext {
  return {
    userId: "0a000000-0000-7000-8000-0000013102a1",
    tenantId: "0a000000-0000-7000-8000-0000013109a1",
    storeId: null,
    isPlatformAdmin: false,
    source: "session",
    ...overrides,
  };
}

describe("resolveStoreScope (RT-131)", () => {
  it("kind='all' + no active store → tenant-wide", () => {
    expect(resolveStoreScope(ctx({ storeAccess: { kind: "all" } }))).toEqual({
      kind: "tenant",
    });
  });

  it("kind='specific' + no active store → only the granted stores", () => {
    expect(
      resolveStoreScope(
        ctx({ storeAccess: { kind: "specific", storeIds: [STORE_X, STORE_Y] } }),
      ),
    ).toEqual({ kind: "stores", storeIds: [STORE_X, STORE_Y] });
  });

  it("kind='specific' with no grants → no store", () => {
    expect(
      resolveStoreScope(ctx({ storeAccess: { kind: "specific", storeIds: [] } })),
    ).toEqual({ kind: "stores", storeIds: [] });
  });

  it("an active store pins the scope to it, whatever the membership kind", () => {
    expect(
      resolveStoreScope(ctx({ storeId: STORE_X, storeAccess: { kind: "all" } })),
    ).toEqual({ kind: "stores", storeIds: [STORE_X] });
  });

  it("unresolved store access (e.g. a bearer token) fails closed, never tenant-wide", () => {
    expect(resolveStoreScope(ctx({ source: "token" }))).toEqual({
      kind: "stores",
      storeIds: [],
    });
  });
});
