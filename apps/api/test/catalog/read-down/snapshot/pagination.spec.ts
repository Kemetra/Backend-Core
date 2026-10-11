/**
 * pagination.spec.ts — RT-394 snapshot pagination completeness.
 *
 * The snapshot over-fetches `limit + 1` products by id and drops unsellable
 * ones in the service. Continuation MUST follow the products SCANNED, not the
 * ones emitted, or a page can end with `next_page_token: null` while later
 * sellable products exist:
 *   - Mode A: every row in the window is excluded → no emitted row → no token.
 *   - Mode B: excluded rows earlier in the window, a sellable row last → that
 *     row is emitted and nothing "beyond" it was fetched → no token.
 *
 * Seeds its own extra tenant-A products on top of the read-down fixture so the
 * shared seed (and the suites that read it) stay unchanged. Tenant-A order by
 * id (store A-X):
 *   a401 unpriced · a402 retired · d010111 SELLABLE · d010222 unpriced ·
 *   d010333 non-representable · d010444 SELLABLE · d0105a1..a6 unpriced ·
 *   d0106b1 SELLABLE
 *
 * Docker policy: a missing Docker runtime is a HARD failure unless
 * MIGRATION_TEST_ALLOW_SKIP=1 (CI MUST NOT set it). Run targeted under WSL.
 */
import { ACTOR_A, TENANT_A } from "../../__support__/isolation-harness";
import {
  READ_DOWN_FIXTURE_IDS,
  resetHarness,
  startSnapshotHarness,
  stopSnapshotHarness,
  type HarnessHandle,
} from "./__snapshot-harness";

/** Sellable, right after the non-representable product (Mode B at limit=2). */
const SELLABLE_AFTER_NONREPR = "0a000000-0000-7000-8000-00000d010444";
/** A run of unpriced products longer than the small limits walked below. */
const EXCLUDED_RUN = [
  "0a000000-0000-7000-8000-00000d0105a1",
  "0a000000-0000-7000-8000-00000d0105a2",
  "0a000000-0000-7000-8000-00000d0105a3",
  "0a000000-0000-7000-8000-00000d0105a4",
  "0a000000-0000-7000-8000-00000d0105a5",
  "0a000000-0000-7000-8000-00000d0105a6",
];
/** Sellable, after the long excluded run. */
const SELLABLE_AFTER_RUN = "0a000000-0000-7000-8000-00000d0106b1";

const ALL_SELLABLE = [
  READ_DOWN_FIXTURE_IDS.sellableProduct,
  SELLABLE_AFTER_NONREPR,
  SELLABLE_AFTER_RUN,
].sort();

/** Tenant-A product rows in store A-X (base 2 + read-down 3 + seeded here 8). */
const TOTAL_PRODUCTS = 13;

let h: HarnessHandle;

beforeAll(async () => {
  h = await startSnapshotHarness();
  if (!h.harness) return;
  await h.harness.env.admin.query(
    `INSERT INTO tenant_products
       (id, tenant_id, name, default_price, default_currency_code, is_active,
        tax_category, created_by, updated_by)
     VALUES
       ($1, $2, 'RT-394 Sellable After NonRepr', '5.00', 'EGP', true, 'standard', $3, $3),
       ($4, $2, 'RT-394 Sellable After Run', '7.25', 'EGP', true, 'standard', $3, $3)`,
    [SELLABLE_AFTER_NONREPR, TENANT_A, ACTOR_A, SELLABLE_AFTER_RUN],
  );
  await h.harness.env.admin.query(
    `INSERT INTO tenant_products
       (id, tenant_id, name, default_price, default_currency_code, is_active,
        tax_category, created_by, updated_by)
     SELECT id, $2, 'RT-394 Unpriced ' || ord, NULL, NULL, true, 'standard', $3, $3
       FROM unnest($1::uuid[]) WITH ORDINALITY AS t(id, ord)`,
    [EXCLUDED_RUN, TENANT_A, ACTOR_A],
  );
}, 180_000);

afterAll(async () => {
  await stopSnapshotHarness(h);
}, 60_000);

beforeEach(() => resetHarness(h));

function skip(): boolean {
  if (!h.harness) {
    // eslint-disable-next-line no-console
    console.warn("[pagination.spec] skipping — Docker unavailable");
    return true;
  }
  return false;
}

interface SnapshotPage {
  items: { product_id: string }[];
  cursor: string;
  next_page_token: string | null;
}

/**
 * Follow `next_page_token` until it is null. Bounded: every page must advance
 * past at least one product, so more pages than products means a loop.
 */
async function walkSnapshot(limit: number): Promise<SnapshotPage[]> {
  const pages: SnapshotPage[] = [];
  let pageToken: string | null = null;
  do {
    if (pages.length > TOTAL_PRODUCTS + 1) {
      throw new Error(`snapshot walk at limit=${limit} did not terminate`);
    }
    const query: Record<string, string | number> = { limit };
    if (pageToken) query["page_token"] = pageToken;
    const res = await h.harness!.http().get("/api/pos/v1/catalog/snapshot").query(query);
    expect(res.status).toBe(200);
    const page = res.body as SnapshotPage;
    expect(page.items.length).toBeLessThanOrEqual(limit);
    pages.push(page);
    pageToken = page.next_page_token;
  } while (pageToken);
  return pages;
}

function emittedIds(pages: SnapshotPage[]): string[] {
  return pages.flatMap((p) => p.items.map((r) => r.product_id));
}

describe("posGetCatalogSnapshot — pagination completeness (RT-394)", () => {
  it("serves every sellable product in one default-limit page (baseline)", async () => {
    if (skip()) return;
    const pages = await walkSnapshot(500);
    expect(pages).toHaveLength(1);
    expect(emittedIds(pages).sort()).toEqual(ALL_SELLABLE);
    expect(pages[0]!.next_page_token).toBeNull();
  });

  it("Mode A: a first window of only excluded products still continues (limit=1)", async () => {
    if (skip()) return;
    const pages = await walkSnapshot(1);
    // Page 1's window holds only unsellable products — it must NOT be final.
    expect(pages[0]!.next_page_token).not.toBeNull();
    expect(emittedIds(pages).sort()).toEqual(ALL_SELLABLE);
  });

  it("Mode B: a sellable product ending a window with excluded rows still continues (limit=2)", async () => {
    if (skip()) return;
    const pages = await walkSnapshot(2);
    expect(emittedIds(pages)).toContain(SELLABLE_AFTER_NONREPR);
    expect(emittedIds(pages).sort()).toEqual(ALL_SELLABLE);
  });

  it("a run of excluded products longer than the limit is walked through to the sellable product after it", async () => {
    if (skip()) return;
    const pages = await walkSnapshot(3);
    expect(emittedIds(pages)).toContain(SELLABLE_AFTER_RUN);
  });

  it.each([1, 2, 3, 4, 5, 6, 7, 8, 12, 13, 14])(
    "limit=%i: every sellable product exactly once, one cursor, a null-token final page",
    async (limit) => {
      if (skip()) return;
      const pages = await walkSnapshot(limit);
      const ids = emittedIds(pages);
      expect(ids.sort()).toEqual(ALL_SELLABLE); // exactly once: no gaps, no dups
      expect(new Set(pages.map((p) => p.cursor)).size).toBe(1); // FR-012 shape
      expect(pages[pages.length - 1]!.next_page_token).toBeNull();
    },
  );

  it("the final page of a walk is terminal: its token is null and no product follows", async () => {
    if (skip()) return;
    const pages = await walkSnapshot(TOTAL_PRODUCTS);
    const last = pages[pages.length - 1]!;
    expect(last.next_page_token).toBeNull();
    expect(emittedIds(pages).sort()).toEqual(ALL_SELLABLE);
  });
});
