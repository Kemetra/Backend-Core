/**
 * RT-427 — sale effects written in the sale-processing transaction, and
 * linked by the posting-requested consumer (Testcontainers).
 *
 * Runs the real `SaleProcessingProcessor` and `PostingRequestedConsumer` on
 * the non-superuser app pool (RLS + FORCE), with fixtures on the admin pool.
 *
 * Proves:
 *   - flag OFF: processing writes no effect and emits only the sale_post
 *     intent — the behaviour before RT-427;
 *   - flag ON: one `not_posted` effect per product line, committed with
 *     `processed_at` and the intent; a re-run writes nothing more;
 *   - DC-2: when the intent cannot be written, the effects and `processed_at`
 *     roll back together;
 *   - a skipped line warns (identifiers only) and never stalls the sale;
 *   - the consumer links the sale's effects to the posting row it creates:
 *     `pending`, or `rejected` with the category for an unmapped item; a
 *     re-delivery changes nothing;
 *   - another tenant's processing never touches these effects.
 *
 * Docker policy: HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import type { OutboxEventEnvelope } from "@data-pulse-2/shared";

import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../../../packages/db/__tests__/_helpers/postgres-container";
import { PostingRequestedConsumer } from "../../src/erpnext-posting/posting-requested.consumer";
import { SaleProcessingProcessor } from "../../src/sales/sale-processing.processor";

const TENANT = "01900000-0000-7000-8000-000000427e01";
const TENANT_B = "01900000-0000-7000-8000-000000427e02";
const STORE = "01900000-0000-7000-8000-000000427e11";
const STORE_B = "01900000-0000-7000-8000-000000427e12";
const ACTOR = "01900000-0000-7000-8000-000000427e21";
const MAPPED = "01900000-0000-7000-8000-000000427e31";
const UNMAPPED = "01900000-0000-7000-8000-000000427e32";
const TRACKED = "01900000-0000-7000-8000-000000427e33";

let env: PgTestEnv | null = null;
let seq = 0;

function pg(): PgTestEnv {
  if (!env) throw new Error("env not initialized");
  return env;
}
const skip = (): boolean => env === null;

function nextId(): string {
  seq += 1;
  return `01900000-0000-7000-8000-${(0x427f00000000 + seq).toString(16)}`;
}

async function seedSale(tenantId: string, storeId: string, products: ReadonlyArray<string | null>): Promise<string> {
  const saleId = nextId();
  await pg().admin.query(
    `INSERT INTO sales (id, tenant_id, store_id, currency_code, pos_total, occurred_at, business_date,
                        source_system, external_id, payload_hash, created_by)
     VALUES ($1, $2, $3, 'USD', 0, now(), current_date, 'pos-427', $4, $5, $6)`,
    [saleId, tenantId, storeId, `ext-${saleId}`, "a".repeat(64), ACTOR],
  );
  for (const product of products) {
    await pg().admin.query(
      `INSERT INTO sale_lines (id, sale_id, tenant_id, store_id, line_name, unit_price, currency_code,
                               quantity, line_amount, unit, tenant_product_ref)
       VALUES (gen_random_uuid(), $1, $2, $3, 'x', 0, 'USD', 2, 0, 'ea', $4)`,
      [saleId, tenantId, storeId, product],
    );
  }
  return saleId;
}

async function activate(tenantId: string): Promise<void> {
  await pg().admin.query(
    `INSERT INTO tenant_inventory_settings (tenant_id, updated_by, sale_effects_activated_at, sale_effects_activated_by)
     VALUES ($1, $2, now(), $2)
     ON CONFLICT (tenant_id) DO UPDATE SET sale_effects_activated_at = now(), sale_effects_activated_by = $2`,
    [tenantId, ACTOR],
  );
}

async function effects(saleId: string): Promise<Array<{ quantity: string; state: string; posting_status_id: string | null; state_reason: string | null }>> {
  const r = await pg().admin.query(
    `SELECT m.quantity::text AS quantity, i.state, i.posting_status_id, i.state_reason
       FROM stock_movements m JOIN inventory_effect_integration i ON i.effect_id = m.id
      WHERE m.event_type = 'sale' AND m.event_ref_id = $1 ORDER BY m.external_id`,
    [saleId],
  );
  return r.rows;
}

async function outboxTypes(saleId: string): Promise<string[]> {
  const r = await pg().admin.query<{ event_type: string }>(
    `SELECT event_type FROM outbox_events
      WHERE payload->>'sale_id' = $1 OR payload->>'eventRefId' = $1 ORDER BY event_type`,
    [saleId],
  );
  return r.rows.map((x) => x.event_type);
}

async function processedAt(saleId: string): Promise<Date | null> {
  const r = await pg().admin.query<{ processed_at: Date | null }>(`SELECT processed_at FROM sales WHERE id = $1`, [saleId]);
  return r.rows[0]!.processed_at;
}

function postingEvent(saleId: string, tenantId: string = TENANT, storeId: string = STORE): Parameters<PostingRequestedConsumer["handle"]>[0] {
  const e: OutboxEventEnvelope = {
    event_id: nextId(),
    event_type: "erpnext.posting.requested",
    tenant_id: tenantId,
    store_id: null,
    payload: { sale_id: saleId, store_id: storeId, kind: "sale_post", source_ref_id: saleId },
    correlation_id: null,
    attempts: 1,
    occurred_at: new Date(),
  };
  return e as Parameters<PostingRequestedConsumer["handle"]>[0];
}

const logger = { error: jest.fn(), warn: jest.fn() };
const quietConsumerLogger = { warn: jest.fn(), error: jest.fn() };

function processor(): SaleProcessingProcessor {
  return new SaleProcessingProcessor(pg().app, logger);
}

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err) {
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[sale-effects.integration.spec] Docker NOT AVAILABLE — skipping: ${String(err)}\n`);
      return;
    }
    throw err;
  }
  await applyAllUpAndCreateAppRole(env);
  const a = env.admin;
  await a.query(`INSERT INTO tenants (id, slug, name) VALUES ($1, 'rt427-w-a', 'A'), ($2, 'rt427-w-b', 'B')`, [
    TENANT,
    TENANT_B,
  ]);
  await a.query(`INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $2, 'WA', 'A'), ($3, $4, 'WB', 'B')`, [
    STORE,
    TENANT,
    STORE_B,
    TENANT_B,
  ]);
  await a.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'rt427w@fixture.invalid', NULL)`, [ACTOR]);
  await a.query(
    `INSERT INTO tenant_products (id, tenant_id, name, tax_category, created_by, updated_by, tracking_mode) VALUES
       ($1, $4, 'mapped', 'standard', $5, $5, 'none'), ($2, $4, 'unmapped', 'standard', $5, $5, 'none'),
       ($3, $4, 'tracked', 'standard', $5, $5, 'batch')`,
    [MAPPED, UNMAPPED, TRACKED, TENANT, ACTOR],
  );
  await a.query(
    `INSERT INTO erpnext_item_map (id, tenant_id, tenant_product_id, erpnext_item_ref, state, suggestion_source,
                                   confirmed_by, confirmed_at)
     VALUES (gen_random_uuid(), $1, $2, 'ERP-427', 'confirmed', 'manual', $3, now()),
            (gen_random_uuid(), $1, $4, 'ERP-427-T', 'confirmed', 'manual', $3, now())`,
    [TENANT, MAPPED, ACTOR, TRACKED],
  );
  await a.query(
    `INSERT INTO erpnext_warehouse_map (id, tenant_id, store_id, purpose, erpnext_warehouse_ref, set_by, version)
     VALUES (gen_random_uuid(), $1, $2, 'stock', 'WH-427', $3, 1)`,
    [TENANT, STORE, ACTOR],
  );
}, 240_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

beforeEach(() => {
  logger.warn.mockReset();
  logger.error.mockReset();
});

describe("flag OFF", () => {
  it("processes the sale exactly as before: no effect, only the sale_post intent", async () => {
    if (skip()) return;
    const saleId = await seedSale(TENANT, STORE, [MAPPED, MAPPED]);
    const result = await processor().process({ saleId, tenantId: TENANT, storeId: STORE });
    expect(result.applied).toBe(true);
    expect(await effects(saleId)).toEqual([]);
    expect(await outboxTypes(saleId)).toEqual(["erpnext.posting.requested"]);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe("flag ON", () => {
  beforeAll(async () => {
    if (env) await activate(TENANT);
  });

  it("writes one not_posted effect per product line with processed_at and the intent; a re-run adds nothing", async () => {
    if (skip()) return;
    const saleId = await seedSale(TENANT, STORE, [MAPPED, MAPPED, null]);
    await processor().process({ saleId, tenantId: TENANT, storeId: STORE });
    const again = await processor().process({ saleId, tenantId: TENANT, storeId: STORE });
    expect(again.applied).toBe(false);
    expect(await effects(saleId)).toEqual([
      { quantity: "-2.0000", state: "not_posted", posting_status_id: null, state_reason: "awaiting_posting_intent" },
      { quantity: "-2.0000", state: "not_posted", posting_status_id: null, state_reason: "awaiting_posting_intent" },
    ]);
    expect(await outboxTypes(saleId)).toEqual(["erpnext.posting.requested", "inventory.movement.created"]);
  });

  it("DC-2: when the intent insert fails, the effects and processed_at roll back together", async () => {
    if (skip()) return;
    const saleId = await seedSale(TENANT, STORE, [MAPPED]);
    await pg().admin.query(`
      CREATE OR REPLACE FUNCTION rt427_refuse_posting_intent() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.event_type = 'erpnext.posting.requested' THEN RAISE EXCEPTION 'injected intent failure'; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER rt427_refuse_posting_intent BEFORE INSERT ON outbox_events
        FOR EACH ROW EXECUTE FUNCTION rt427_refuse_posting_intent();`);
    try {
      await expect(processor().process({ saleId, tenantId: TENANT, storeId: STORE })).rejects.toThrow(
        /injected intent failure/,
      );
    } finally {
      await pg().admin.query(`DROP TRIGGER rt427_refuse_posting_intent ON outbox_events`);
    }
    expect(await processedAt(saleId)).toBeNull();
    expect(await effects(saleId)).toEqual([]);
    expect(await outboxTypes(saleId)).toEqual([]);
  });

  it("a skipped line warns with identifiers only and the sale still processes", async () => {
    if (skip()) return;
    const saleId = await seedSale(TENANT, STORE, [TRACKED, MAPPED]);
    const result = await processor().process({ saleId, tenantId: TENANT, storeId: STORE });
    expect(result.applied).toBe(true);
    expect(await effects(saleId)).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [fields] = logger.warn.mock.calls[0] as [Record<string, unknown>];
    expect(fields).toMatchObject({
      event: "inventory.sale_effect.skipped",
      event_type: "sale",
      reason: "tracked_product",
      tenant_id: TENANT,
      store_id: STORE,
      sale_id: saleId,
    });
    expect(Object.keys(fields).sort()).toEqual(
      ["event", "event_type", "line_id", "reason", "sale_id", "store_id", "tenant_id", "event_ref_id"].sort(),
    );
  });

  it("the consumer links the effects pending to the posting row it creates; a re-delivery changes nothing", async () => {
    if (skip()) return;
    const saleId = await seedSale(TENANT, STORE, [MAPPED]);
    await processor().process({ saleId, tenantId: TENANT, storeId: STORE });
    const consumer = new PostingRequestedConsumer(pg().app, quietConsumerLogger);
    await consumer.handle(postingEvent(saleId));
    await consumer.handle(postingEvent(saleId));
    const posting = await pg().admin.query<{ id: string; status: string }>(
      `SELECT id, status FROM erpnext_posting_status WHERE source_ref_id = $1`,
      [saleId],
    );
    expect(posting.rows).toHaveLength(1);
    expect(await effects(saleId)).toEqual([
      { quantity: "-2.0000", state: "pending", posting_status_id: posting.rows[0]!.id, state_reason: null },
    ]);
  });

  it("an unmapped item rejects the intent at creation: the effect stands, rejected with the category", async () => {
    if (skip()) return;
    const saleId = await seedSale(TENANT, STORE, [UNMAPPED]);
    await processor().process({ saleId, tenantId: TENANT, storeId: STORE });
    await new PostingRequestedConsumer(pg().app, quietConsumerLogger).handle(postingEvent(saleId));
    const [effect] = await effects(saleId);
    expect(effect).toMatchObject({ quantity: "-2.0000", state: "rejected", state_reason: "unmapped_item" });
    expect(effect!.posting_status_id).not.toBeNull();
  });

  it("another tenant never sees or writes these effects", async () => {
    if (skip()) return;
    await activate(TENANT_B);
    const saleId = await seedSale(TENANT, STORE, [MAPPED]);
    // Tenant B's context cannot resolve tenant A's sale.
    await expect(processor().process({ saleId, tenantId: TENANT_B, storeId: STORE })).rejects.toThrow();
    expect(await effects(saleId)).toEqual([]);
    expect(await processedAt(saleId)).toBeNull();
  });
});
