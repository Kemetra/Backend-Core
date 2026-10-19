/**
 * movement-list.spec.ts — 009-US1-ONHAND (T032).
 *
 * FR-004 / SC-001: list the movements behind a balance in a stable order, each
 * showing type / signed qty / timestamps / actor / reason / provenance refs;
 * the listed movements sum to the reported on-hand. Plus the contract's
 * filter semantics: productId set → that product; omitted → ad-hoc
 * (NULL-product) movements only.
 *
 * RT-731 (inventory.yaml 1.5.0-draft): newest first (occurred_at DESC, id
 * DESC) in keyset pages — a walk over more than 200 movements reaches every
 * one exactly once, `scope=all` lists every movement of the store, the cursor
 * is bound to the tenant, the store and the filters (any other use is a 400),
 * and the store-wide listing keeps tenant / store isolation. STORE_A_Y holds
 * the paging seed; the original cases above read STORE_A_X.
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
import {
  seedInventoryFixture,
  MOVE_ADHOC_A_X,
} from "../__support__/seed-inventory";
import {
  InventoryService,
  type StockMovementListBody,
} from "../../../src/inventory/inventory.service";

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
      console.warn(`\n[movement-list] Docker NOT AVAILABLE: ${msg}\n`);
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
    console.warn("[movement-list] skipping — Docker unavailable");
    return true;
  }
  return false;
}

describe("listStockMovements — product-scoped (FR-004/SC-001)", () => {
  it("lists PRODUCT_A_ACTIVE movements at STORE_A_X; they sum to the reported on-hand (7)", async () => {
    if (maybeSkip()) return;
    const list = await service.listStockMovements({
      tenantId: TENANT_A,
      storeId: STORE_A_X,
      productId: PRODUCT_A_ACTIVE,
    });
    // 3 product movements: +10, −1, −2.
    expect(list.items).toHaveLength(3);
    const sum = list.items.reduce((acc, m) => acc + Number(m.quantity), 0);
    expect(sum).toBe(7);
    const onHand = await service.getOnHand({
      tenantId: TENANT_A,
      storeId: STORE_A_X,
      productId: PRODUCT_A_ACTIVE,
    });
    expect(sum).toBe(Number(onHand.quantity)); // listed movements sum to on-hand
  });

  it("each item carries the projected fields (type, signed qty, timestamps, actor, reason)", async () => {
    if (maybeSkip()) return;
    const list = await service.listStockMovements({
      tenantId: TENANT_A,
      storeId: STORE_A_X,
      productId: PRODUCT_A_ACTIVE,
    });
    const m = list.items[0];
    expect(m).toBeDefined();
    expect(typeof m?.movementType).toBe("string");
    expect(typeof m?.quantity).toBe("string");
    expect(typeof m?.occurredAt).toBe("string");
    expect(typeof m?.createdBy).toBe("string"); // acting principal (FR-004)
    // Projection MUST NOT leak the lineage / dedup columns (§IV).
    expect(m).not.toHaveProperty("idempotency_key");
    expect(m).not.toHaveProperty("source_system");
    expect(m).not.toHaveProperty("external_id");
  });

  it("returns items in a stable order, newest first (occurred_at DESC, then id DESC; RT-731)", async () => {
    if (maybeSkip()) return;
    const list = await service.listStockMovements({
      tenantId: TENANT_A,
      storeId: STORE_A_X,
      productId: PRODUCT_A_ACTIVE,
    });
    const keys = list.items.map((m) => [m.occurredAt, m.id].join("|"));
    const sorted = [...keys].sort().reverse();
    expect(keys).toEqual(sorted);
  });
});

describe("listStockMovements — ad-hoc (no productId) returns NULL-product movements only", () => {
  it("omitting productId lists the ad-hoc movement, not the product movements", async () => {
    if (maybeSkip()) return;
    const list = await service.listStockMovements({
      tenantId: TENANT_A,
      storeId: STORE_A_X,
      // no productId → ad-hoc (NULL tenant_product_ref) only (contract).
    });
    const ids = list.items.map((m) => m.id);
    expect(ids).toContain(MOVE_ADHOC_A_X);
    // Every returned item is genuinely ad-hoc.
    for (const m of list.items) {
      expect(m.tenantProductRef).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// RT-731 — newest first, keyset paging, scope, cursor binding, isolation
// ---------------------------------------------------------------------------

/** Product movements seeded at STORE_A_Y on top of the fixture's one. */
const SEEDED_PRODUCT_MOVES = 230;
/** Of those, how many share one occurred_at (the id breaks the tie). */
const TIED_MOVES = 12;
const SEEDED_ADHOC_MOVES = 7;
const PAGING_BASE_MS = Date.parse("2026-01-01T00:00:00.000Z");

/** The occurred_at of seeded movement `i` (product, else ad-hoc). */
function seededInstant(i: number, product: boolean): string {
  if (!product) return new Date(PAGING_BASE_MS + i * 30 * 60_000 + 30_000).toISOString();
  const tied = i >= SEEDED_PRODUCT_MOVES - TIED_MOVES;
  const offset = tied ? SEEDED_PRODUCT_MOVES * 60_000 : i * 60_000 + 123;
  return new Date(PAGING_BASE_MS + offset).toISOString();
}

/**
 * STORE_A_Y: SEEDED_PRODUCT_MOVES product movements one minute apart, the last
 * TIED_MOVES at one instant, plus SEEDED_ADHOC_MOVES ad-hoc movements
 * interleaved in time.
 */
async function seedPagingMovements(admin: Pool): Promise<void> {
  const rows = [
    ...Array.from({ length: SEEDED_PRODUCT_MOVES }, (_, i) => [PRODUCT_A_ACTIVE, seededInstant(i, true)]),
    ...Array.from({ length: SEEDED_ADHOC_MOVES }, (_, i) => [null, seededInstant(i, false)]),
  ];
  for (const [product, at] of rows) {
    await admin.query(
      `INSERT INTO stock_movements
         (tenant_id, store_id, movement_type, quantity, stocking_unit,
          tenant_product_ref, reason, occurred_at, created_by,
          stock_location_id, inventory_status)
       VALUES ($1, $2, 'adjustment', 1.0000, 'ea', $3, 'paging seed', $4, $5,
         (SELECT id FROM stock_locations WHERE store_id = $2::uuid AND kind = 'primary'), 'sellable')`,
      [TENANT_A, STORE_A_Y, product, at, ACTOR_A],
    );
  }
}

type ListInput = Parameters<InventoryService["listStockMovements"]>[0];
type Movement = StockMovementListBody["items"][number];

/** Walk every page; returns the items in walk order and the page count. */
async function walk(input: Omit<ListInput, "cursor">): Promise<{ items: Movement[]; pages: number }> {
  const items: Movement[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const page = await service.listStockMovements({ ...input, cursor });
    pages += 1;
    items.push(...page.items);
    cursor = page.nextCursor ?? undefined;
    if (pages > 1000) throw new Error("walk did not terminate");
  } while (cursor !== undefined);
  return { items, pages };
}

/** Ids straight from the DB (admin, RLS-free) in the contract order. */
async function expectedIds(where: string, params: readonly unknown[]): Promise<string[]> {
  const r = await (env as PgTestEnv).admin.query<{ id: string }>(
    `SELECT id FROM stock_movements WHERE ${where} ORDER BY occurred_at DESC, id DESC`,
    [...params],
  );
  return r.rows.map((row) => row.id);
}

const PRODUCT_AT_A_Y = ["store_id = $1 AND tenant_product_ref = $2", [STORE_A_Y, PRODUCT_A_ACTIVE]] as const;

describe("RT-731 — product listing is newest first and pages past 200", () => {
  it("the first page holds the newest movements, not the oldest", async () => {
    if (maybeSkip()) return;
    const expected = await expectedIds(...PRODUCT_AT_A_Y);
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
      const expected = await expectedIds(...PRODUCT_AT_A_Y);
      const { items, pages } = await walk({
        tenantId: TENANT_A,
        storeId: STORE_A_Y,
        productId: PRODUCT_A_ACTIVE,
        limit,
      });
      expect(items.map((m) => m.id)).toEqual(expected);
      expect(pages).toBe(Math.ceil(expected.length / limit));
    },
    60_000,
  );

  it("a listing that fits one page has a null cursor", async () => {
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
  it.each([
    ["scope=all lists every movement of the store", { scope: "all" as const }, "store_id = $1"],
    ["no scope lists ad-hoc movements only", {}, "store_id = $1 AND tenant_product_ref IS NULL"],
    ["scope=adhoc lists ad-hoc movements only", { scope: "adhoc" as const }, "store_id = $1 AND tenant_product_ref IS NULL"],
  ])("%s, newest first", async (_label, filter, where) => {
    if (maybeSkip()) return;
    const { items } = await walk({ tenantId: TENANT_A, storeId: STORE_A_Y, limit: 64, ...filter });
    expect(items.map((m) => m.id)).toEqual(await expectedIds(where, [STORE_A_Y]));
  });
});

describe("RT-731 — the cursor is bound to the tenant, the store and the filters", () => {
  const productQuery = { tenantId: TENANT_A, storeId: STORE_A_Y, productId: PRODUCT_A_ACTIVE, limit: 5 };

  async function issuedCursor(): Promise<string> {
    const page = await service.listStockMovements(productQuery);
    return page.nextCursor as string;
  }

  function encoded(payload: unknown): string {
    return Buffer.from(JSON.stringify(payload)).toString("base64url");
  }

  it("is accepted for the same tenant, store and filters", async () => {
    if (maybeSkip()) return;
    const next = await service.listStockMovements({ ...productQuery, cursor: await issuedCursor() });
    expect(next.items).toHaveLength(5);
  });

  it.each<[string, (cursor: string) => ListInput]>([
    ["reused with scope=all", (c) => ({ tenantId: TENANT_A, storeId: STORE_A_Y, scope: "all", cursor: c })],
    ["reused for ad-hoc", (c) => ({ tenantId: TENANT_A, storeId: STORE_A_Y, cursor: c })],
    ["reused at another store", (c) => ({ ...productQuery, storeId: STORE_A_X, cursor: c })],
    ["reused by another tenant", (c) => ({ ...productQuery, tenantId: TENANT_B, storeId: STORE_B_X, cursor: c })],
    ["not base64url JSON", () => ({ ...productQuery, cursor: "%%%not-a-cursor%%%" })],
    ["JSON of the wrong shape", () => ({ ...productQuery, cursor: encoded({ a: 1 }) })],
    [
      "a tracking-identity style cursor",
      () => ({ ...productQuery, cursor: encoded({ p: PRODUCT_A_ACTIVE, k: "batch", e: "infinity", c: "X", i: PRODUCT_A_ACTIVE }) }),
    ],
    [
      "an impossible instant",
      (c) => {
        const payload = JSON.parse(Buffer.from(c, "base64url").toString("utf8")) as object;
        return { ...productQuery, cursor: encoded({ ...payload, at: "0000-02-31T00:00:00.000000Z" }) };
      },
    ],
  ])("is a 400 when %s", async (_label, request) => {
    if (maybeSkip()) return;
    const input = request(await issuedCursor());
    await expect(service.listStockMovements(input)).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe("RT-731 — tenant / store isolation of the store-wide listing", () => {
  it.each([
    ["tenant A, store A.X", TENANT_A, STORE_A_X],
    ["tenant B, store B.X", TENANT_B, STORE_B_X],
  ])("scope=all for %s returns only that store's movements", async (_label, tenantId, storeId) => {
    if (maybeSkip()) return;
    const { items } = await walk({ tenantId, storeId, scope: "all", limit: 2 });
    expect(items.length).toBeGreaterThan(0);
    expect(items.map((m) => m.id)).toEqual(await expectedIds("store_id = $1", [storeId]));
  });

  it("another tenant's store is a non-disclosing 404", async () => {
    if (maybeSkip()) return;
    await expect(
      service.listStockMovements({ tenantId: TENANT_B, storeId: STORE_A_Y, scope: "all" }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
