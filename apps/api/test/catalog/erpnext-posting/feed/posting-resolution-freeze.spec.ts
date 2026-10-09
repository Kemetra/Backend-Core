/**
 * RT-330 — the posting feed reads the intent's FROZEN item resolution, not the
 * live `erpnext_item_map`.
 *
 * Regression guard for RT-316 V1 (reproduced end-to-end on the rt9 lab): after
 * a confirmed item map was retired, the feed omitted the pending intent and the
 * cursor moved past it (stranded); after the product was re-pointed to another
 * ERP item, the feed emitted the intent with the NEW item (silent retarget).
 *
 * The seeded sale_post carries resolution v1 (ERP-ITEM-A), as the worker writes
 * it at creation. The map is then retired and re-pointed to ERP-ITEM-B through
 * the real 013 service, and every pull must still offer the intent with A.
 *
 * Docker policy mirrors posting-feed.spec: HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../../_helpers/postgres-container";
import { ErpnextItemMapService } from "../../../../src/catalog/erpnext-item-map/erpnext-item-map.service";
import { ErpnextPostingService } from "../../../../src/catalog/erpnext-posting/erpnext-posting.service";
import type { PostingWorkItem } from "../../../../src/catalog/erpnext-posting/posting-work-item.projection";
import { ACTOR_A, STORE_A_X } from "../../__support__/isolation-harness";
import { SALE_A_X } from "../../sales/__support__/seed-sales";
import {
  POSTING_STATUS_FIXTURE_IDS,
  POST_A_PENDING,
  seedPostingStatusFixture,
} from "../__support__/seed-posting-status";

let env: PgTestEnv | null = null;
let skip = false;

const TENANT_A = POSTING_STATUS_FIXTURE_IDS.tenantA;
const TPROD = "01900000-0000-7000-8000-0000000a7e30";

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    await seedPostingStatusFixture(env);
    const a = env.admin;
    await a.query(
      `INSERT INTO tenant_products
         (id, tenant_id, name, tax_category, created_by, updated_by)
       VALUES ($1, $2, 'RT-330 Widget', 'standard', $3, $3)`,
      [TPROD, TENANT_A, ACTOR_A],
    );
    await a.query(`UPDATE sale_lines SET tenant_product_ref = $1 WHERE sale_id = $2`, [
      TPROD,
      SALE_A_X,
    ]);
    const item = await a.query<{ id: string }>(
      `INSERT INTO erpnext_item_map
         (id, tenant_id, tenant_product_id, erpnext_item_ref, state,
          suggestion_source, confirmed_by, confirmed_at)
       VALUES (gen_random_uuid(), $1, $2, 'ERP-ITEM-A', 'confirmed', 'manual', $3, now())
       RETURNING id`,
      [TENANT_A, TPROD, ACTOR_A],
    );
    const wh = await a.query<{ id: string }>(
      `INSERT INTO erpnext_warehouse_map
         (id, tenant_id, store_id, purpose, erpnext_warehouse_ref, set_by, version)
       VALUES (gen_random_uuid(), $1, $2, 'stock', 'ERP-WH-A', $3, 1)
       RETURNING id`,
      [TENANT_A, STORE_A_X, ACTOR_A],
    );
    // Resolution v1, as the worker writes it when it creates the intent.
    await a.query(
      `INSERT INTO erpnext_posting_resolution
         (tenant_id, intent_id, resolution_version, sale_line_id,
          erpnext_item_ref, item_map_id, warehouse_ref, warehouse_map_id, resolved_by)
       SELECT $1, $2, 1, sl.id, 'ERP-ITEM-A', $3, 'ERP-WH-A', $4, 'system'
         FROM sale_lines sl WHERE sl.sale_id = $5`,
      [TENANT_A, POST_A_PENDING, item.rows[0]!.id, wh.rows[0]!.id, SALE_A_X],
    );
    await a.query(
      `UPDATE erpnext_posting_status SET current_resolution_version = 1 WHERE id = $1`,
      [POST_A_PENDING],
    );
  } catch (err) {
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      skip = true;
      // eslint-disable-next-line no-console
      console.warn(`[posting-resolution-freeze.spec] Docker unavailable: ${String(err)}`);
      return;
    }
    throw err;
  }
}, 180_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

function feed(): ErpnextPostingService {
  if (!env) throw new Error("Docker unavailable");
  return new ErpnextPostingService(env.app);
}

function maps(): ErpnextItemMapService {
  if (!env) throw new Error("Docker unavailable");
  return new ErpnextItemMapService(env.app);
}

/** The ERP item names the feed offers for the frozen intent, or null when it is not offered. */
async function offeredItems(since: bigint | null): Promise<string[] | null> {
  const page = await feed().pullPostings({ tenantId: TENANT_A, since, limit: 100 });
  const item = page.items.find((i: PostingWorkItem) => i.workItemRef === POST_A_PENDING);
  if (!item || item.kind !== "sale_post") return null;
  return item.sale.lines.map((l) => l.erpnextItemRef.name);
}

async function activeMap(): Promise<{ id: string; version: number }> {
  const r = await env!.admin.query<{ id: string; version: number }>(
    `SELECT id, version FROM erpnext_item_map
      WHERE tenant_id = $1 AND tenant_product_id = $2 AND retired_at IS NULL`,
    [TENANT_A, TPROD],
  );
  return r.rows[0]!;
}

describe("RT-330 — a posting intent stays bound to its frozen ERP item", () => {
  it("is offered with item A after A is retired (not omitted, not stranded)", async () => {
    if (skip) return;
    const a = await activeMap();
    const retired = await maps().retire({ tenantId: TENANT_A, id: a.id, version: a.version });
    expect(retired.kind).toBe("ok");

    const items = await offeredItems(null);
    expect(items).not.toBeNull();
    expect(new Set(items)).toEqual(new Set(["ERP-ITEM-A"]));
  });

  it("is still offered with item A after the product is re-pointed to item B", async () => {
    if (skip) return;
    const sug = await maps().suggest({
      tenantId: TENANT_A,
      tenantProductId: TPROD,
      erpnextItemRef: "ERP-ITEM-B",
      actorUserId: ACTOR_A,
    });
    expect(sug.kind).toBe("ok");
    if (sug.kind !== "ok") return;
    const conf = await maps().confirm({
      tenantId: TENANT_A,
      id: sug.row.id,
      version: sug.row.version,
      actorUserId: ACTOR_A,
    });
    expect(conf.kind).toBe("ok");

    expect(new Set(await offeredItems(null))).toEqual(new Set(["ERP-ITEM-A"]));
  });

  it("a failed_transient re-head keeps the frozen version and item A", async () => {
    if (skip) return;
    const rec = await feed().ackOutcome({
      tenantId: TENANT_A,
      workItemRef: POST_A_PENDING,
      outcome: "failed_transient",
    });
    expect(rec.replayed).toBe(false);

    const row = await env!.admin.query<{ status: string; v: number | null }>(
      `SELECT status, current_resolution_version AS v FROM erpnext_posting_status WHERE id = $1`,
      [POST_A_PENDING],
    );
    expect(row.rows[0]).toEqual({ status: "pending", v: 1 });
    expect(new Set(await offeredItems(null))).toEqual(new Set(["ERP-ITEM-A"]));
  });

  it("RT-332: the work item carries its frozen resolution version and warehouse", async () => {
    if (skip) return;
    const page = await feed().pullPostings({ tenantId: TENANT_A, since: null, limit: 100 });
    const item = page.items.find((i: PostingWorkItem) => i.workItemRef === POST_A_PENDING);
    expect(item?.resolutionVersion).toBe(1);
    expect(item?.sale.warehouseRef).toEqual({ doctype: "Warehouse", name: "ERP-WH-A" });
  });
});
