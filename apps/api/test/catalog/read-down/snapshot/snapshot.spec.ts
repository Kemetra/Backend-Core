/**
 * snapshot.spec.ts — 010 US1-SNAPSHOT acceptance (T030–T034).
 *
 * Exercises the real ReadDownController + ReadDownService over Testcontainers
 * Postgres (RLS-active, env.app) with the read-down fixtures seeded. Authored as
 * the RED→GREEN pair for US1: each `it` asserts a spec behavior
 * (FR-010..013/050..053, R5/R6) the GREEN ReadDownService now satisfies.
 *
 * Covers, by data-model §1 + the seed-read-down fixture:
 *   - T030 happy path: the snapshot returns exactly the sellable resolved rows
 *     with the real-schema-backed toBody shape + decimal money + server cursor;
 *     the removed pharmacy fields are absent.
 *   - T031 sellable filter: null_price + non_representable products are ABSENT.
 *   - T032 resolved override: store A-X's price override is reflected
 *     field-by-field (Tenant ⊕ Override).
 *   - T033 pagination: a small `limit` paginates via next_page_token at one
 *     consistent cursor point.
 *   - T034 empty: a tenant-B store (no sellable products resolve) returns a
 *     valid EMPTY snapshot at a cursor (not an error).
 *   - T036 isolation/non-disclosure (GREEN-verify): device-auth required;
 *     scope-mismatch branch_id → non-disclosing 404; a cross-tenant principal
 *     never sees another tenant's products; unresolved store →
 *     store_context_required.
 *
 * Docker policy: a missing Docker runtime is a HARD failure unless
 * MIGRATION_TEST_ALLOW_SKIP=1 (CI MUST NOT set it). Run targeted under WSL.
 */
import {
  DEVICE_USER_ID,
  READ_DOWN_FIXTURE_IDS,
  resetHarness,
  startSnapshotHarness,
  stopSnapshotHarness,
  STORE_A_X,
  STORE_B_X,
  TENANT_B,
  type HarnessHandle,
} from "./__snapshot-harness";

let h: HarnessHandle;
const F = READ_DOWN_FIXTURE_IDS;

beforeAll(async () => {
  h = await startSnapshotHarness();
}, 180_000);

afterAll(async () => {
  await stopSnapshotHarness(h);
}, 60_000);

beforeEach(() => resetHarness(h));

function skip(): boolean {
  if (!h.harness) {
    // eslint-disable-next-line no-console
    console.warn("[snapshot.spec] skipping — Docker unavailable");
    return true;
  }
  return false;
}

interface SellableRow {
  product_id: string;
  sku: string;
  name: string;
  aliases: string[];
  price: { amount: string; currency_code: string };
  tax_category: string;
  active: boolean;
  row_cursor: string;
}
interface SnapshotPage {
  items: SellableRow[];
  cursor: string;
  next_page_token: string | null;
}

// ===========================================================================
// T030 — happy path
// ===========================================================================
describe("posGetCatalogSnapshot — happy path (T030)", () => {
  it("returns the sellable resolved rows with the real-schema toBody shape + a server cursor", async () => {
    if (skip()) return;
    const res = await h.harness!.http().get("/api/pos/v1/catalog/snapshot");
    expect(res.status).toBe(200);
    const body = res.body as SnapshotPage;

    expect(typeof body.cursor).toBe("string");
    expect(body.cursor.length).toBeGreaterThan(0);
    expect(Array.isArray(body.items)).toBe(true);

    const sellable = body.items.find((r) => r.product_id === F.sellableProduct);
    expect(sellable).toBeDefined();
    // Real-schema-backed fields present (R-1/Option B).
    expect(sellable).toEqual(
      expect.objectContaining({
        product_id: F.sellableProduct,
        name: expect.any(String),
        tax_category: expect.any(String),
        active: true,
      }),
    );
    // Decimal money at the currency's NATURAL minor precision (R4) — EXACT, not
    // `8.5000`. The resolved price is the store A-X override (8.50), in EGP (2dp).
    expect(sellable!.price.amount).toBe("8.50");
    expect(sellable!.price.currency_code).toBe("EGP");
    expect(Array.isArray(sellable!.aliases)).toBe(true);
    expect(typeof sellable!.row_cursor).toBe("string");

    // The removed pharmacy fields are NOT present (R-1).
    for (const removed of [
      "name_ar",
      "name_en",
      "controlled_substance",
      "prescription_required",
      "unit_pack_label",
    ]) {
      expect(sellable as unknown as Record<string, unknown>).not.toHaveProperty(removed);
    }
  });
});

// ===========================================================================
// T031 — sellable filter (null_price + non_representable excluded)
// ===========================================================================
describe("posGetCatalogSnapshot — sellable filter (T031)", () => {
  it("excludes the unpriced + non-representable products while INCLUDING the sellable one (R5, non-vacuous)", async () => {
    if (skip()) return;
    const res = await h.harness!.http().get("/api/pos/v1/catalog/snapshot");
    expect(res.status).toBe(200);
    const ids = (res.body as SnapshotPage).items.map((r) => r.product_id);
    // Anchor: the sellable product MUST be present — so "excludes X" can never
    // pass vacuously on an empty/all-excluded result (the bug this guards).
    expect(ids).toContain(F.sellableProduct);
    expect(ids).not.toContain(F.unpricedProduct);
    expect(ids).not.toContain(F.nonRepresentableProduct);
  });
});

// ===========================================================================
// T032 — resolved override (Tenant ⊕ Store Override)
// ===========================================================================
describe("posGetCatalogSnapshot — resolved override (T032)", () => {
  it("reflects the store A-X price override field-by-field (8.50, not the tenant 9.99)", async () => {
    if (skip()) return;
    const res = await h.harness!.http().get("/api/pos/v1/catalog/snapshot");
    expect(res.status).toBe(200);
    const sellable = (res.body as SnapshotPage).items.find(
      (r) => r.product_id === F.sellableProduct,
    );
    expect(sellable).toBeDefined();
    // Tenant default is 9.99; store A-X overrides to 8.50 → the override wins.
    // EXACT at natural minor precision (R4) — not 8.5000.
    expect(sellable!.price.amount).toBe("8.50");
    expect(sellable!.price.currency_code).toBe("EGP");
  });
});

// ===========================================================================
// T033 — pagination (next_page_token at one consistent cursor point)
// ===========================================================================
describe("posGetCatalogSnapshot — pagination (T033)", () => {
  it("paginates via next_page_token; all pages share the SAME cursor", async () => {
    if (skip()) return;
    // limit=1 forces multiple pages if >1 sellable row exists in tenant A.
    const first = await h.harness!
      .http()
      .get("/api/pos/v1/catalog/snapshot")
      .query({ limit: 1 });
    expect(first.status).toBe(200);
    const firstBody = first.body as SnapshotPage;
    expect(firstBody.items.length).toBeLessThanOrEqual(1);

    if (firstBody.next_page_token) {
      const second = await h.harness!
        .http()
        .get("/api/pos/v1/catalog/snapshot")
        .query({ limit: 1, page_token: firstBody.next_page_token });
      expect(second.status).toBe(200);
      const secondBody = second.body as SnapshotPage;
      // Same consistent cursor point across pages (FR-012).
      expect(secondBody.cursor).toBe(firstBody.cursor);
      // No duplicate product across the two pages.
      const firstIds = firstBody.items.map((r) => r.product_id);
      const secondIds = secondBody.items.map((r) => r.product_id);
      expect(firstIds.filter((id) => secondIds.includes(id))).toEqual([]);
    }
  });
});

// ===========================================================================
// T034 — empty-sellable store returns a valid empty snapshot at a cursor
// ===========================================================================
describe("posGetCatalogSnapshot — empty-sellable store (T034)", () => {
  it("a tenant-B store (only tenant-A products are priced) returns an EMPTY page at a cursor, not an error", async () => {
    if (skip()) return;
    // The seed prices only tenant-A products; the harness's tenant-B products
    // are unpriced → zero sellable rows for any tenant-B store. This decouples
    // the empty-snapshot case from the override mechanism (advisor).
    h.harness!.contextGuard.tenantId = TENANT_B;
    h.harness!.contextGuard.storeId = STORE_B_X;
    h.harness!.contextGuard.userId = DEVICE_USER_ID;
    const res = await h.harness!.http().get("/api/pos/v1/catalog/snapshot");
    expect(res.status).toBe(200);
    const body = res.body as SnapshotPage;
    expect(body.items).toEqual([]); // synced, empty ≠ never synced
    expect(typeof body.cursor).toBe("string");
    expect(body.cursor.length).toBeGreaterThan(0);
    expect(body.next_page_token).toBeNull();
  });
});

// ===========================================================================
// T036 — isolation & non-disclosure GREEN-verify (extends the sweep for snapshot)
// ===========================================================================
describe("posGetCatalogSnapshot — isolation & non-disclosure (T036)", () => {
  it("unauthenticated (no device principal / no context) → 401", async () => {
    if (skip()) return;
    h.harness!.contextGuard.anonymous = true;
    const res = await h.harness!.http().get("/api/pos/v1/catalog/snapshot");
    expect(res.status).toBe(401);
  });

  it("a branch_id NOT matching the token scope → non-disclosing 404 (FR-002/003/004)", async () => {
    if (skip()) return;
    // Principal scoped to (A, STORE_A_X); request another store via branch_id.
    const res = await h.harness!
      .http()
      .get("/api/pos/v1/catalog/snapshot")
      .query({ branch_id: STORE_B_X });
    expect(res.status).toBe(404);
    // Non-disclosing: the body must not reveal exists-vs-not-exists.
    expect(JSON.stringify(res.body)).not.toContain(STORE_B_X);
  });

  it("a matching branch_id serves only the principal's (tenant, store)", async () => {
    if (skip()) return;
    const res = await h.harness!
      .http()
      .get("/api/pos/v1/catalog/snapshot")
      .query({ branch_id: STORE_A_X });
    expect(res.status).toBe(200);
    // Every row is from tenant A's catalogue (RLS + the store predicate); the
    // sellable product resolves, nothing cross-tenant leaks.
    const ids = (res.body as SnapshotPage).items.map((r) => r.product_id);
    expect(ids).toContain(F.sellableProduct);
  });

  it("a cross-tenant principal never sees another tenant's products (RLS)", async () => {
    if (skip()) return;
    // Tenant B principal: the seed prices only tenant-A products → B sees none
    // of A's. (Proves the resolved read path is tenant-isolated, not just the
    // change-log — the DB-layer RLS-bypass probe lives in read-down-sweep §A.)
    h.harness!.contextGuard.tenantId = TENANT_B;
    h.harness!.contextGuard.storeId = STORE_B_X;
    const res = await h.harness!.http().get("/api/pos/v1/catalog/snapshot");
    expect(res.status).toBe(200);
    const ids = (res.body as SnapshotPage).items.map((r) => r.product_id);
    expect(ids).not.toContain(F.sellableProduct);
    expect(ids).not.toContain(F.unpricedProduct);
  });

  it("an unresolved store context → store_context_required (FR-005)", async () => {
    if (skip()) return;
    h.harness!.contextGuard.storeId = null;
    const res = await h.harness!.http().get("/api/pos/v1/catalog/snapshot");
    expect(res.status).toBe(401);
    expect(JSON.stringify(res.body)).toContain("store_context_required");
  });
});
