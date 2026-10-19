/**
 * movement-list.spec.ts — 009-US1-ONHAND (T032).
 *
 * FR-004 / SC-001: list the movements behind a balance in a stable order, each
 * showing type / signed qty / timestamps / actor / reason / provenance refs;
 * the listed movements sum to the reported on-hand. Plus the contract's
 * filter semantics: productId set → that product; omitted → ad-hoc
 * (NULL-product) movements only.
 *
 * Layer: service + DB against the RLS-active env.app pool. Docker-gated.
 */
import "reflect-metadata";

import { Pool } from "pg";

import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../_helpers/postgres-container";
import {
  seedCatalogIsolationFixture,
  PRODUCT_A_ACTIVE,
  STORE_A_X,
  TENANT_A,
} from "../../catalog/__support__/isolation-harness";
import {
  seedInventoryFixture,
  MOVE_ADHOC_A_X,
} from "../__support__/seed-inventory";
import { InventoryService } from "../../../src/inventory/inventory.service";

let env: PgTestEnv | null = null;
let dockerSkipped = false;
let service: InventoryService;

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    await seedCatalogIsolationFixture(env);
    await seedInventoryFixture(env);
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
