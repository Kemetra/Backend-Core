/**
 * movement-list-paging.spec.ts — RT-731 (inventory.yaml 1.5.0-draft).
 *
 * `listStockMovements` lists newest first (`occurred_at DESC, id DESC`) in
 * keyset pages: a walk over more than 200 movements reaches every one exactly
 * once, `scope=all` lists every movement of the store, and the cursor is
 * bound to the tenant, the store and the filters (any other use is a 400).
 * Tenant / store isolation holds for the store-wide listing.
 *
 * Layer: service + DB against the RLS-active env.app pool. Docker-gated.
 */
import "reflect-metadata";

import { BadRequestException, NotFoundException } from "@nestjs/common";
import { Pool } from "pg";

import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../_helpers/postgres-container";
import {
  seedCatalogIsolationFixture,
  ACTOR_A,
  PRODUCT_A_ACTIVE,
  STORE_A_X,
  STORE_A_Y,
  STORE_B_X,
  TENANT_A,
  TENANT_B,
} from "../../catalog/__support__/isolation-harness";
import { seedInventoryFixture } from "../__support__/seed-inventory";
import {
  InventoryService,
  type StockMovementListBody,
} from "../../../src/inventory/inventory.service";

/** Product movements seeded at STORE_A_Y on top of the fixture's one. */
const SEEDED_PRODUCT_MOVES = 230;
/** Of those, how many share one occurred_at (the id breaks the tie). */
const TIED_MOVES = 12;
const SEEDED_ADHOC_MOVES = 7;

let env: PgTestEnv | null = null;
let dockerSkipped = false;
let service: InventoryService;

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    await seedCatalogIsolationFixture(env);
    await seedInventoryFixture(env);
    await seedPagingMovements(env.admin);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      dockerSkipped = true;
      // eslint-disable-next-line no-console
      console.warn(`\n[movement-list-paging] Docker NOT AVAILABLE: ${msg}\n`);
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }
  service = new InventoryService(env.app as unknown as Pool);
}, 180_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

function maybeSkip(): boolean {
  if (dockerSkipped) {
    // eslint-disable-next-line no-console
    console.warn("[movement-list-paging] skipping — Docker unavailable");
    return true;
  }
  return false;
}

/**
 * STORE_A_Y: SEEDED_PRODUCT_MOVES product movements one minute apart, the last
 * TIED_MOVES of them at the same instant, plus SEEDED_ADHOC_MOVES ad-hoc
 * movements interleaved in time.
 */
async function seedPagingMovements(admin: Pool): Promise<void> {
  const base = Date.parse("2026-01-01T00:00:00.000Z");
  const tiedAt = new Date(base + SEEDED_PRODUCT_MOVES * 60_000).toISOString();
  for (let i = 0; i < SEEDED_PRODUCT_MOVES; i += 1) {
    const tied = i >= SEEDED_PRODUCT_MOVES - TIED_MOVES;
    const at = tied ? tiedAt : new Date(base + i * 60_000 + 123).toISOString();
    await admin.query(
      `INSERT INTO stock_movements
         (tenant_id, store_id, movement_type, quantity, stocking_unit,
          tenant_product_ref, reason, occurred_at, created_by,
          stock_location_id, inventory_status)
       VALUES ($1, $2, 'inbound', 1.0000, 'ea', $3, 'paging seed', $4, $5,
         (SELECT id FROM stock_locations WHERE store_id = $2::uuid AND kind = 'primary'), 'sellable')`,
      [TENANT_A, STORE_A_Y, PRODUCT_A_ACTIVE, at, ACTOR_A],
    );
  }
  for (let i = 0; i < SEEDED_ADHOC_MOVES; i += 1) {
    const at = new Date(base + i * 30 * 60_000 + 30_000).toISOString();
    await admin.query(
      `INSERT INTO stock_movements
         (tenant_id, store_id, movement_type, quantity, stocking_unit,
          tenant_product_ref, reason, occurred_at, created_by,
          stock_location_id, inventory_status)
       VALUES ($1, $2, 'adjustment', 1.0000, 'ea', NULL, 'paging ad-hoc', $3, $4,
         (SELECT id FROM stock_locations WHERE store_id = $2::uuid AND kind = 'primary'), 'sellable')`,
      [TENANT_A, STORE_A_Y, at, ACTOR_A],
    );
  }
}

type ListInput = Parameters<InventoryService["listStockMovements"]>[0];

/** Walk every page; returns the items in walk order and the page count. */
async function walk(
  input: Omit<ListInput, "cursor">,
): Promise<{ items: StockMovementListBody["items"]; pages: number }> {
  const items: StockMovementListBody["items"][number][] = [];
  let cursor: string | undefined;
  let pages = 0;
  for (;;) {
    const page = await service.listStockMovements({ ...input, cursor });
    pages += 1;
    items.push(...page.items);
    if (page.nextCursor === null) break;
    cursor = page.nextCursor;
    if (pages > 1000) throw new Error("walk did not terminate");
  }
  return { items, pages };
}

/** Rows straight from the DB (admin, RLS-free) in the contract order. */
async function expectedIds(where: string, params: unknown[]): Promise<string[]> {
  const r = await (env as PgTestEnv).admin.query<{ id: string }>(
    `SELECT id FROM stock_movements WHERE ${where} ORDER BY occurred_at DESC, id DESC`,
    params,
  );
  return r.rows.map((row) => row.id);
}

function expectNewestFirst(items: StockMovementListBody["items"]): void {
  for (let i = 1; i < items.length; i += 1) {
    const prev = items[i - 1]!;
    const cur = items[i]!;
    const order =
      Date.parse(prev.occurredAt) - Date.parse(cur.occurredAt) ||
      (prev.id > cur.id ? 1 : prev.id < cur.id ? -1 : 0);
    expect(order).toBeGreaterThan(0);
  }
}

describe("RT-731 — product listing is newest first and pages past 200", () => {
  it("the first page holds the newest movements, not the oldest", async () => {
    if (maybeSkip()) return;
    const expected = await expectedIds(
      "store_id = $1 AND tenant_product_ref = $2",
      [STORE_A_Y, PRODUCT_A_ACTIVE],
    );
    expect(expected.length).toBeGreaterThan(200);
    const page = await service.listStockMovements({
      tenantId: TENANT_A,
      storeId: STORE_A_Y,
      productId: PRODUCT_A_ACTIVE,
      limit: 200,
    });
    expect(page.items.map((m) => m.id)).toEqual(expected.slice(0, 200));
    expect(page.nextCursor).not.toBeNull();
  });

  it.each([1, 7, 50, 200])(
    "a walk with limit=%i returns every movement once, newest first, then a null cursor",
    async (limit) => {
      if (maybeSkip()) return;
      const expected = await expectedIds(
        "store_id = $1 AND tenant_product_ref = $2",
        [STORE_A_Y, PRODUCT_A_ACTIVE],
      );
      const { items, pages } = await walk({
        tenantId: TENANT_A,
        storeId: STORE_A_Y,
        productId: PRODUCT_A_ACTIVE,
        limit,
      });
      expect(items.map((m) => m.id)).toEqual(expected);
      expect(new Set(items.map((m) => m.id)).size).toBe(items.length);
      expectNewestFirst(items);
      expect(pages).toBe(Math.ceil(expected.length / limit));
    },
    60_000,
  );

  it("an exhausted listing that fits one page has a null cursor", async () => {
    if (maybeSkip()) return;
    const page = await service.listStockMovements({
      tenantId: TENANT_A,
      storeId: STORE_A_X,
      productId: PRODUCT_A_ACTIVE,
    });
    expect(page.items.length).toBeGreaterThan(0);
    expect(page.nextCursor).toBeNull();
  });
});

describe("RT-731 — scope", () => {
  it("scope=all lists every movement of the store (products and ad-hoc), newest first", async () => {
    if (maybeSkip()) return;
    const expected = await expectedIds("store_id = $1", [STORE_A_Y]);
    const { items } = await walk({
      tenantId: TENANT_A,
      storeId: STORE_A_Y,
      scope: "all",
      limit: 64,
    });
    expect(items.map((m) => m.id)).toEqual(expected);
    expect(items.some((m) => m.tenantProductRef === null)).toBe(true);
    expect(items.some((m) => m.tenantProductRef === PRODUCT_A_ACTIVE)).toBe(true);
  });

  it("omitting scope and productId still lists ad-hoc movements only (default adhoc)", async () => {
    if (maybeSkip()) return;
    const expected = await expectedIds(
      "store_id = $1 AND tenant_product_ref IS NULL",
      [STORE_A_Y],
    );
    expect(expected).toHaveLength(SEEDED_ADHOC_MOVES);
    const byDefault = await walk({ tenantId: TENANT_A, storeId: STORE_A_Y, limit: 3 });
    const explicit = await walk({
      tenantId: TENANT_A,
      storeId: STORE_A_Y,
      scope: "adhoc",
      limit: 3,
    });
    expect(byDefault.items.map((m) => m.id)).toEqual(expected);
    expect(explicit.items.map((m) => m.id)).toEqual(expected);
  });
});

describe("RT-731 — the cursor is bound to the tenant, the store and the filters", () => {
  async function productCursor(): Promise<string> {
    const page = await service.listStockMovements({
      tenantId: TENANT_A,
      storeId: STORE_A_Y,
      productId: PRODUCT_A_ACTIVE,
      limit: 5,
    });
    expect(page.nextCursor).not.toBeNull();
    return page.nextCursor as string;
  }

  it("is accepted for the same tenant, store and filters", async () => {
    if (maybeSkip()) return;
    const cursor = await productCursor();
    const next = await service.listStockMovements({
      tenantId: TENANT_A,
      storeId: STORE_A_Y,
      productId: PRODUCT_A_ACTIVE,
      limit: 5,
      cursor,
    });
    expect(next.items).toHaveLength(5);
  });

  it.each([
    ["another filter: scope=all", { storeId: STORE_A_Y, scope: "all" as const }],
    ["another filter: ad-hoc", { storeId: STORE_A_Y }],
    ["another store", { storeId: STORE_A_X, productId: PRODUCT_A_ACTIVE }],
  ])("is a 400 when reused with %s", async (_label, change) => {
    if (maybeSkip()) return;
    const cursor = await productCursor();
    await expect(
      service.listStockMovements({ tenantId: TENANT_A, limit: 5, cursor, ...change }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("is a 400 when reused by another tenant", async () => {
    if (maybeSkip()) return;
    const cursor = await productCursor();
    await expect(
      service.listStockMovements({
        tenantId: TENANT_B,
        storeId: STORE_B_X,
        productId: PRODUCT_A_ACTIVE,
        cursor,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it.each([
    ["not base64url JSON", "%%%not-a-cursor%%%"],
    ["JSON of the wrong shape", Buffer.from('{"a":1}').toString("base64url")],
    ["a tracking-identity style cursor", Buffer.from(
      JSON.stringify({ p: PRODUCT_A_ACTIVE, k: "batch", e: "infinity", c: "X", i: PRODUCT_A_ACTIVE }),
    ).toString("base64url")],
  ])("is a 400 when it is %s", async (_label, cursor) => {
    if (maybeSkip()) return;
    await expect(
      service.listStockMovements({
        tenantId: TENANT_A,
        storeId: STORE_A_Y,
        productId: PRODUCT_A_ACTIVE,
        cursor,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("is a 400 when its position names an impossible instant", async () => {
    if (maybeSkip()) return;
    const cursor = await productCursor();
    const payload = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    const tampered = Buffer.from(
      JSON.stringify({ ...payload, at: "0000-02-31T00:00:00.000000Z" }),
    ).toString("base64url");
    await expect(
      service.listStockMovements({
        tenantId: TENANT_A,
        storeId: STORE_A_Y,
        productId: PRODUCT_A_ACTIVE,
        cursor: tampered,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe("RT-731 — tenant / store isolation of the store-wide listing", () => {
  it("scope=all at one store never returns another store's or tenant's movements", async () => {
    if (maybeSkip()) return;
    const { items } = await walk({
      tenantId: TENANT_A,
      storeId: STORE_A_X,
      scope: "all",
      limit: 2,
    });
    expect(items.length).toBeGreaterThan(0);
    for (const m of items) expect(m.storeId).toBe(STORE_A_X);
    expect(items.map((m) => m.id)).toEqual(await expectedIds("store_id = $1", [STORE_A_X]));
  });

  it("another tenant's store is a non-disclosing 404", async () => {
    if (maybeSkip()) return;
    await expect(
      service.listStockMovements({ tenantId: TENANT_B, storeId: STORE_A_Y, scope: "all" }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("tenant B's store-wide listing holds only tenant B rows", async () => {
    if (maybeSkip()) return;
    const { items } = await walk({ tenantId: TENANT_B, storeId: STORE_B_X, scope: "all" });
    expect(items.map((m) => m.id)).toEqual(await expectedIds("store_id = $1", [STORE_B_X]));
  });
});
