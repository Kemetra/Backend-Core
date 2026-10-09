/**
 * 015-US1-FEED — `PostingRequestedConsumer.handle()` Testcontainers spec.
 *
 * Proves the CREATION-moment eligibility resolution (015-RESOLVE) + the
 * conflict-safe insert, by constructing the consumer with a real pool and
 * calling `handle()` directly (no module wiring — that is verified separately):
 *
 *   - resolvable sale (every line → confirmed item-map; store → warehouse map)
 *     → a `pending` erpnext_posting_status row;
 *   - unmapped line (no confirmed map / only suggested / ad-hoc) → a
 *     `permanently_rejected` row, rejection_category='unmapped_item';
 *   - unmapped store (no warehouse map) → `permanently_rejected`,
 *     rejection_category='unmapped_store';
 *   - the 008 sale fact is NEVER mutated;
 *   - at-least-once: a 2nd handle() of the same event is a no-op (O-3 unique),
 *     the FIRST verdict stands;
 *   - RT-173 (RT-83 option 2): a reversal's row is created only after its
 *     sale's sale_post row exists — before that the consumer throws the typed
 *     retryable ReversalAwaitingSalePostError and inserts nothing.
 *
 * Docker policy mirrors the other worker DB specs: HARD failure unless
 * MIGRATION_TEST_ALLOW_SKIP=1.
 */
import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../../../packages/db/__tests__/_helpers/postgres-container";
import {
  PostingRequestedConsumer,
  ReversalAwaitingSalePostError,
  PostingResolutionNotFrozenError,
} from "../../src/erpnext-posting/posting-requested.consumer";
import type { OutboxEventEnvelope } from "@data-pulse-2/shared";

const TENANT = "01900000-0000-7000-8000-0000000aa111";
const OTHER_TENANT = "01900000-0000-7000-8000-0000000aa222";
const STORE_MAPPED = "01900000-0000-7000-8000-0000000ac111";
const STORE_UNMAPPED = "01900000-0000-7000-8000-0000000ac222";
const ACTOR = "01900000-0000-7000-8000-0000000ad111";
const TPRODUCT = "01900000-0000-7000-8000-0000000ae111";
const PAYLOAD_HASH = "a".repeat(64);

let env: PgTestEnv | null = null;
let skip = false;

async function seedBase(e: PgTestEnv): Promise<void> {
  const a = e.admin;
  await a.query(
    `INSERT INTO tenants (id, slug, name, default_currency_code)
       VALUES ($1, 'prc', 'PRC Tenant', 'USD') ON CONFLICT (id) DO NOTHING`,
    [TENANT],
  );
  await a.query(
    `INSERT INTO stores (id, tenant_id, code, name) VALUES
       ($1, $3, 'PRCM', 'Mapped'), ($2, $3, 'PRCU', 'Unmapped')
     ON CONFLICT (id) DO NOTHING`,
    [STORE_MAPPED, STORE_UNMAPPED, TENANT],
  );
  await a.query(
    `INSERT INTO users (id, email, password_hash) VALUES ($1, 'prc@fixture.invalid', NULL)
     ON CONFLICT (id) DO NOTHING`,
    [ACTOR],
  );
  // A tenant product + a CONFIRMED item map (the resolvable identity).
  await a.query(
    `INSERT INTO tenant_products
       (id, tenant_id, name, tax_category, created_by, updated_by)
       VALUES ($1, $2, 'Widget', 'standard', $3, $3) ON CONFLICT (id) DO NOTHING`,
    [TPRODUCT, TENANT, ACTOR],
  );
  await a.query(
    `INSERT INTO erpnext_item_map
       (id, tenant_id, tenant_product_id, erpnext_item_ref, state,
        suggestion_source, confirmed_by, confirmed_at)
     VALUES (gen_random_uuid(), $1, $2, 'ERP-ITEM-1', 'confirmed',
        'manual', $3, now())
     ON CONFLICT DO NOTHING`,
    [TENANT, TPRODUCT, ACTOR],
  );
  // A warehouse map ONLY for STORE_MAPPED.
  await a.query(
    `INSERT INTO erpnext_warehouse_map
       (id, tenant_id, store_id, purpose, erpnext_warehouse_ref, set_by, version)
     VALUES (gen_random_uuid(), $1, $2, 'stock', 'ERP-WH-1', $3, 1)
     ON CONFLICT DO NOTHING`,
    [TENANT, STORE_MAPPED, ACTOR],
  );
}

/** Insert a sale + one line; returns the sale id. */
async function seedSale(
  e: PgTestEnv,
  opts: { id: string; store: string; externalId: string; tenantProductRef: string | null },
): Promise<void> {
  await e.admin.query(
    `INSERT INTO sales
       (id, tenant_id, store_id, currency_code, pos_total, occurred_at,
        business_date, source_system, external_id, payload_hash, created_by)
     VALUES ($1, $2, $3, 'USD', 5.00, now(), '2026-06-01', 'pos-prc', $4, $5, $6)`,
    [opts.id, TENANT, opts.store, opts.externalId, PAYLOAD_HASH, ACTOR],
  );
  await e.admin.query(
    `INSERT INTO sale_lines
       (id, sale_id, tenant_id, store_id, line_name, unit_price, currency_code,
        quantity, line_amount, tax_amount, unit, tenant_product_ref)
     VALUES (gen_random_uuid(), $1, $2, $3, 'Widget', 5.0000, 'USD',
        1.000000, 5.0000, 0.0000, 'ea', $4)`,
    [opts.id, TENANT, opts.store, opts.tenantProductRef],
  );
}

type PostingEnvelope = Parameters<PostingRequestedConsumer["handle"]>[0];

/** Tests feed arbitrary (incl. malformed) payloads; the consumer validates them. */
function envelope(
  payload: Record<string, unknown>,
  eventId: string,
  tenantId: string = TENANT,
): PostingEnvelope {
  const env: OutboxEventEnvelope = {
    event_id: eventId,
    event_type: "erpnext.posting.requested",
    tenant_id: tenantId,
    store_id: null,
    payload,
    correlation_id: null,
    attempts: 1,
    occurred_at: new Date("2026-06-01T00:00:00.000Z"),
  };
  return env as PostingEnvelope;
}

async function statusRow(
  e: PgTestEnv,
  sourceRefId: string,
): Promise<{ status: string; rejection_category: string | null; count: number }> {
  const r = await e.admin.query<{ status: string; rejection_category: string | null }>(
    `SELECT status, rejection_category FROM erpnext_posting_status
      WHERE tenant_id = $1 AND source_ref_id = $2`,
    [TENANT, sourceRefId],
  );
  return {
    status: r.rows[0]?.status ?? "",
    rejection_category: r.rows[0]?.rejection_category ?? null,
    count: r.rowCount ?? 0,
  };
}

function salePostEvent(saleId: string, eventId: string, tenantId: string = TENANT): PostingEnvelope {
  return envelope(
    { sale_id: saleId, store_id: STORE_MAPPED, kind: "sale_post", source_ref_id: saleId },
    eventId,
    tenantId,
  );
}

function reversalEvent(
  saleId: string,
  voidId: string,
  opts: { eventId: string; tenantId?: string },
): PostingEnvelope {
  return envelope(
    { sale_id: saleId, store_id: STORE_MAPPED, kind: "reversal", source_ref_id: voidId },
    opts.eventId,
    opts.tenantId,
  );
}

/** Insert a void of `saleId`; returns the void id (the reversal's source_ref_id). */
async function seedVoid(e: PgTestEnv, saleId: string, voidId: string): Promise<string> {
  await e.admin.query(
    `INSERT INTO sale_voids (id, sale_id, tenant_id, store_id, business_date, source_system, external_id, payload_hash, created_by)
     VALUES ($1, $2, $3, $4, '2026-05-01', 'pos-prc', $5, $6, $7)`,
    [voidId, saleId, TENANT, STORE_MAPPED, `void-${voidId}`, PAYLOAD_HASH, ACTOR],
  );
  return voidId;
}

/** The (kind, status, sequence) rows for a sale, in feed (sequence) order. */
async function postingRows(
  e: PgTestEnv,
  saleId: string,
): Promise<Array<{ kind: string; status: string; sequence: string }>> {
  const r = await e.admin.query<{ kind: string; status: string; sequence: string }>(
    `SELECT kind, status, sequence::text AS sequence FROM erpnext_posting_status
      WHERE sale_id = $1 ORDER BY sequence`,
    [saleId],
  );
  return r.rows;
}

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    await seedBase(env);
  } catch (err) {
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      skip = true;
      // eslint-disable-next-line no-console
      console.warn(`[posting-requested-consumer.spec] Docker unavailable: ${String(err)}`);
      return;
    }
    throw err;
  }
}, 180_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

function guard(): PgTestEnv {
  if (!env) throw new Error("Docker unavailable");
  return env;
}

describe("PostingRequestedConsumer.handle — 015-RESOLVE at creation", () => {
  it("resolvable sale → a pending erpnext_posting_status row", async () => {
    if (skip) return;
    const e = guard();
    const saleId = "01900000-0000-7000-8000-00000050a001";
    await seedSale(e, { id: saleId, store: STORE_MAPPED, externalId: "s-ok", tenantProductRef: TPRODUCT });
    const c = new PostingRequestedConsumer(e.app);
    await c.handle(
      envelope(
        { sale_id: saleId, store_id: STORE_MAPPED, kind: "sale_post", source_ref_id: saleId },
        "01900000-0000-7000-8000-0000000ev001",
      ),
    );
    const row = await statusRow(e, saleId);
    expect(row.count).toBe(1);
    expect(row.status).toBe("pending");
    expect(row.rejection_category).toBeNull();
  });

  it("unmapped line (ad-hoc, no tenant_product_ref) → permanently_rejected unmapped_item", async () => {
    if (skip) return;
    const e = guard();
    const saleId = "01900000-0000-7000-8000-00000050a002";
    await seedSale(e, { id: saleId, store: STORE_MAPPED, externalId: "s-adhoc", tenantProductRef: null });
    const c = new PostingRequestedConsumer(e.app);
    await c.handle(
      envelope(
        { sale_id: saleId, store_id: STORE_MAPPED, kind: "sale_post", source_ref_id: saleId },
        "01900000-0000-7000-8000-0000000ev002",
      ),
    );
    const row = await statusRow(e, saleId);
    expect(row.status).toBe("permanently_rejected");
    expect(row.rejection_category).toBe("unmapped_item");
  });

  it("unmapped store (no warehouse map) → permanently_rejected unmapped_store", async () => {
    if (skip) return;
    const e = guard();
    const saleId = "01900000-0000-7000-8000-00000050a003";
    await seedSale(e, { id: saleId, store: STORE_UNMAPPED, externalId: "s-nowh", tenantProductRef: TPRODUCT });
    const c = new PostingRequestedConsumer(e.app);
    await c.handle(
      envelope(
        { sale_id: saleId, store_id: STORE_UNMAPPED, kind: "sale_post", source_ref_id: saleId },
        "01900000-0000-7000-8000-0000000ev003",
      ),
    );
    const row = await statusRow(e, saleId);
    expect(row.status).toBe("permanently_rejected");
    expect(row.rejection_category).toBe("unmapped_store");
  });

  it("is idempotent: a 2nd handle() of the same event is a no-op (O-3 unique), first verdict stands", async () => {
    if (skip) return;
    const e = guard();
    const saleId = "01900000-0000-7000-8000-00000050a004";
    await seedSale(e, { id: saleId, store: STORE_MAPPED, externalId: "s-dup", tenantProductRef: TPRODUCT });
    const c = new PostingRequestedConsumer(e.app);
    const ev = envelope(
      { sale_id: saleId, store_id: STORE_MAPPED, kind: "sale_post", source_ref_id: saleId },
      "01900000-0000-7000-8000-0000000ev004",
    );
    await c.handle(ev);
    await c.handle(ev); // re-delivery
    const r = await e.admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM erpnext_posting_status
        WHERE tenant_id = $1 AND source_ref_id = $2`,
      [TENANT, saleId],
    );
    expect(r.rows[0]?.count).toBe("1");
  });

  it("never mutates the 008 sale fact (processed_at untouched by the consumer)", async () => {
    if (skip) return;
    const e = guard();
    const saleId = "01900000-0000-7000-8000-00000050a005";
    await seedSale(e, { id: saleId, store: STORE_MAPPED, externalId: "s-immut", tenantProductRef: TPRODUCT });
    const before = await e.admin.query<{ processed_at: Date | null }>(
      `SELECT processed_at FROM sales WHERE id = $1`,
      [saleId],
    );
    const c = new PostingRequestedConsumer(e.app);
    await c.handle(
      envelope(
        { sale_id: saleId, store_id: STORE_MAPPED, kind: "sale_post", source_ref_id: saleId },
        "01900000-0000-7000-8000-0000000ev005",
      ),
    );
    const after = await e.admin.query<{ processed_at: Date | null }>(
      `SELECT processed_at FROM sales WHERE id = $1`,
      [saleId],
    );
    expect(after.rows[0]?.processed_at ?? null).toEqual(before.rows[0]?.processed_at ?? null);
  });

  it("does NOT write to the unknown-items queue on an unmapped posting failure (rider R4)", async () => {
    if (skip) return;
    const e = guard();
    const saleId = "01900000-0000-7000-8000-00000050a006";
    await seedSale(e, { id: saleId, store: STORE_MAPPED, externalId: "s-noq", tenantProductRef: null });
    const before = await e.admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM unknown_items WHERE tenant_id = $1`,
      [TENANT],
    );
    const c = new PostingRequestedConsumer(e.app);
    await c.handle(
      envelope(
        { sale_id: saleId, store_id: STORE_MAPPED, kind: "sale_post", source_ref_id: saleId },
        "01900000-0000-7000-8000-0000000ev006",
      ),
    );
    // The failure is a permanently_rejected posting row + a reconciliation case
    // (017) — NEVER routed into the inbound unknown-items queue (rider R4 / OQ-6:
    // separate operational states).
    const after = await e.admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM unknown_items WHERE tenant_id = $1`,
      [TENANT],
    );
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
    expect((await statusRow(e, saleId)).status).toBe("permanently_rejected");
  });
});

describe("PostingRequestedConsumer.handle — US3 reversal cardinality (data-model §5)", () => {
  it("a void AND a refund of the SAME sale → TWO distinct reversal rows (REVERSAL-CARDINALITY)", async () => {
    if (skip) return;
    const e = guard();
    const saleId = "01900000-0000-7000-8000-00000050b001";
    await seedSale(e, { id: saleId, store: STORE_MAPPED, externalId: "rev-sale-1", tenantProductRef: TPRODUCT });
    // The terminal events' OWN ids — distinct source_ref_id per reversal.
    const voidId = "01900000-0000-7000-8000-0000005ee0d1";
    const refundId = "01900000-0000-7000-8000-0000005ee0d2";
    await e.admin.query(
      `INSERT INTO sale_voids (id, sale_id, tenant_id, store_id, business_date, source_system, external_id, payload_hash, created_by)
       VALUES ($1, $2, $3, $4, '2026-05-01', 'pos-prc', 'void-rev-1', $5, $6)`,
      [voidId, saleId, TENANT, STORE_MAPPED, PAYLOAD_HASH, ACTOR],
    );
    await e.admin.query(
      `INSERT INTO sale_refunds (id, sale_id, tenant_id, store_id, pos_refund_amount, currency_code, source_system, external_id, payload_hash, created_by)
       VALUES ($1, $2, $3, $4, 2.50, 'USD', 'pos-prc', 'refund-rev-1', $5, $6)`,
      [refundId, saleId, TENANT, STORE_MAPPED, PAYLOAD_HASH, ACTOR],
    );

    const c = new PostingRequestedConsumer(e.app);
    // RT-173: a reversal row needs its sale's sale_post row to exist first.
    await c.handle(salePostEvent(saleId, "01900000-0000-7000-8000-0000000ev0b0"));
    await c.handle(
      envelope(
        { sale_id: saleId, store_id: STORE_MAPPED, kind: "reversal", source_ref_id: voidId },
        "01900000-0000-7000-8000-0000000ev0b1",
      ),
    );
    await c.handle(
      envelope(
        { sale_id: saleId, store_id: STORE_MAPPED, kind: "reversal", source_ref_id: refundId },
        "01900000-0000-7000-8000-0000000ev0b2",
      ),
    );

    // Two distinct reversal rows — neither blocked by the O-3 unique
    // (tenant_id, source_ref_id), since each terminal event has its own id.
    const rows = await e.admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM erpnext_posting_status
        WHERE tenant_id = $1 AND sale_id = $2 AND kind = 'reversal'`,
      [TENANT, saleId],
    );
    expect(rows.rows[0]?.count).toBe("2");
    expect((await statusRow(e, voidId)).status).toBe("pending");
    expect((await statusRow(e, refundId)).status).toBe("pending");
  });
});

describe("PostingRequestedConsumer.handle — RT-173 reversal waits for its sale_post row", () => {
  it("reversal before sale_post throws + inserts nothing; after sale_post it is created behind it", async () => {
    if (skip) return;
    const e = guard();
    const saleId = "01900000-0000-7000-8000-00000050c001";
    await seedSale(e, { id: saleId, store: STORE_MAPPED, externalId: "ord-1", tenantProductRef: TPRODUCT });
    const voidId = await seedVoid(e, saleId, "01900000-0000-7000-8000-0000005ec0d1");
    const c = new PostingRequestedConsumer(e.app);
    const reversal = reversalEvent(saleId, voidId, { eventId: "01900000-0000-7000-8000-0000000ev0c1" });

    // 1. The reversal is drained BEFORE the sale_post (the RT-83 race).
    await expect(c.handle(reversal)).rejects.toBeInstanceOf(ReversalAwaitingSalePostError);
    expect(await postingRows(e, saleId)).toEqual([]);

    // 2. The sale_post arrives; 3. the outbox redelivers the reversal.
    await c.handle(salePostEvent(saleId, "01900000-0000-7000-8000-0000000ev0c2"));
    await c.handle(reversal);

    const rows = await postingRows(e, saleId);
    expect(rows.map((r) => [r.kind, r.status])).toEqual([
      ["sale_post", "pending"],
      ["reversal", "pending"],
    ]);
    expect(BigInt(rows[1]?.sequence ?? "0")).toBeGreaterThan(BigInt(rows[0]?.sequence ?? "0"));
  });

  it("a redelivery after the reversal row exists is still a no-op (O-3)", async () => {
    if (skip) return;
    const e = guard();
    const saleId = "01900000-0000-7000-8000-00000050c002";
    await seedSale(e, { id: saleId, store: STORE_MAPPED, externalId: "ord-2", tenantProductRef: TPRODUCT });
    const voidId = await seedVoid(e, saleId, "01900000-0000-7000-8000-0000005ec0d2");
    const c = new PostingRequestedConsumer(e.app);
    const reversal = reversalEvent(saleId, voidId, { eventId: "01900000-0000-7000-8000-0000000ev0c3" });
    await c.handle(salePostEvent(saleId, "01900000-0000-7000-8000-0000000ev0c4"));
    await c.handle(reversal);
    const before = await postingRows(e, saleId);

    await c.handle(reversal); // re-delivery

    expect(await postingRows(e, saleId)).toEqual(before);
    expect(before).toHaveLength(2);
  });

  it("a permanently_rejected sale_post still satisfies the check", async () => {
    if (skip) return;
    const e = guard();
    const saleId = "01900000-0000-7000-8000-00000050c003";
    // Ad-hoc line (no tenant_product_ref) → the sale_post is permanently_rejected.
    await seedSale(e, { id: saleId, store: STORE_MAPPED, externalId: "ord-3", tenantProductRef: null });
    const voidId = await seedVoid(e, saleId, "01900000-0000-7000-8000-0000005ec0d3");
    const c = new PostingRequestedConsumer(e.app);
    await c.handle(salePostEvent(saleId, "01900000-0000-7000-8000-0000000ev0c5"));

    await c.handle(reversalEvent(saleId, voidId, { eventId: "01900000-0000-7000-8000-0000000ev0c6" }));

    const rows = await postingRows(e, saleId);
    expect(rows.map((r) => [r.kind, r.status])).toEqual([
      ["sale_post", "permanently_rejected"],
      ["reversal", "permanently_rejected"],
    ]);
  });

  it("another tenant cannot satisfy the check (RLS): the reversal is deferred, nothing is inserted", async () => {
    if (skip) return;
    const e = guard();
    const saleId = "01900000-0000-7000-8000-00000050c004";
    await seedSale(e, { id: saleId, store: STORE_MAPPED, externalId: "ord-4", tenantProductRef: TPRODUCT });
    const voidId = await seedVoid(e, saleId, "01900000-0000-7000-8000-0000005ec0d4");
    const c = new PostingRequestedConsumer(e.app);
    await c.handle(salePostEvent(saleId, "01900000-0000-7000-8000-0000000ev0c7"));

    // Same sale + void, but the envelope names a different tenant.
    const foreign = reversalEvent(saleId, voidId, {
      eventId: "01900000-0000-7000-8000-0000000ev0c8",
      tenantId: OTHER_TENANT,
    });

    await expect(c.handle(foreign)).rejects.toBeInstanceOf(ReversalAwaitingSalePostError);
    expect((await postingRows(e, saleId)).map((r) => r.kind)).toEqual(["sale_post"]);
  });

  it("a sale_post of a DIFFERENT sale does not satisfy the check", async () => {
    if (skip) return;
    const e = guard();
    const postedSale = "01900000-0000-7000-8000-00000050c005";
    const voidedSale = "01900000-0000-7000-8000-00000050c006";
    await seedSale(e, { id: postedSale, store: STORE_MAPPED, externalId: "ord-5", tenantProductRef: TPRODUCT });
    await seedSale(e, { id: voidedSale, store: STORE_MAPPED, externalId: "ord-6", tenantProductRef: TPRODUCT });
    const voidId = await seedVoid(e, voidedSale, "01900000-0000-7000-8000-0000005ec0d6");
    const c = new PostingRequestedConsumer(e.app);
    await c.handle(salePostEvent(postedSale, "01900000-0000-7000-8000-0000000ev0c9"));

    const reversal = reversalEvent(voidedSale, voidId, { eventId: "01900000-0000-7000-8000-0000000ev0ca" });

    await expect(c.handle(reversal)).rejects.toBeInstanceOf(ReversalAwaitingSalePostError);
    expect(await postingRows(e, voidedSale)).toEqual([]);
  });
});

/** RT-330: the frozen resolution an intent carries (version, refs, provenance). */
async function resolutionOf(
  e: PgTestEnv,
  sourceRefId: string,
): Promise<{
  version: number | null;
  rows: Array<{ item: string; warehouse: string; by: string; version: number }>;
}> {
  const s = await e.admin.query<{ id: string; v: number | null }>(
    `SELECT id, current_resolution_version AS v FROM erpnext_posting_status
      WHERE tenant_id = $1 AND source_ref_id = $2`,
    [TENANT, sourceRefId],
  );
  const r = await e.admin.query<{ item: string; warehouse: string; by: string; version: number }>(
    `SELECT erpnext_item_ref AS item, warehouse_ref AS warehouse, resolved_by AS by,
            resolution_version AS version
       FROM erpnext_posting_resolution WHERE intent_id = $1 ORDER BY resolution_version`,
    [s.rows[0]?.id ?? null],
  );
  return { version: s.rows[0]?.v ?? null, rows: r.rows };
}

// Last in the file: the lineage case re-points TPRODUCT's shared item map.
describe("PostingRequestedConsumer.handle — RT-330 frozen resolution at creation", () => {
  it("a pending sale_post carries resolution v1 with the item and warehouse it resolved", async () => {
    if (skip) return;
    const e = guard();
    const saleId = "01900000-0000-7000-8000-00000050e001";
    await seedSale(e, { id: saleId, store: STORE_MAPPED, externalId: "rt330-1", tenantProductRef: TPRODUCT });
    await new PostingRequestedConsumer(e.app).handle(
      salePostEvent(saleId, "01900000-0000-7000-8000-0000000ev0e1"),
    );

    const res = await resolutionOf(e, saleId);
    expect(res.version).toBe(1);
    expect(res.rows).toEqual([{ item: "ERP-ITEM-1", warehouse: "ERP-WH-1", by: "system", version: 1 }]);
  });

  it("a permanently_rejected sale_post carries no resolution", async () => {
    if (skip) return;
    const e = guard();
    const saleId = "01900000-0000-7000-8000-00000050e002";
    await seedSale(e, { id: saleId, store: STORE_MAPPED, externalId: "rt330-2", tenantProductRef: null });
    await new PostingRequestedConsumer(e.app).handle(
      salePostEvent(saleId, "01900000-0000-7000-8000-0000000ev0e2"),
    );

    expect((await statusRow(e, saleId)).status).toBe("permanently_rejected");
    expect(await resolutionOf(e, saleId)).toEqual({ version: null, rows: [] });
  });

  it("a reversal created after a re-point keeps its sale's frozen item (lineage)", async () => {
    if (skip) return;
    const e = guard();
    const saleId = "01900000-0000-7000-8000-00000050e003";
    await seedSale(e, { id: saleId, store: STORE_MAPPED, externalId: "rt330-3", tenantProductRef: TPRODUCT });
    const c = new PostingRequestedConsumer(e.app);
    await c.handle(salePostEvent(saleId, "01900000-0000-7000-8000-0000000ev0e3"));

    // Re-point the product to another ERP item before the void is drained.
    await e.admin.query(
      `UPDATE erpnext_item_map SET retired_at = now()
        WHERE tenant_id = $1 AND tenant_product_id = $2 AND retired_at IS NULL`,
      [TENANT, TPRODUCT],
    );
    await e.admin.query(
      `INSERT INTO erpnext_item_map
         (id, tenant_id, tenant_product_id, erpnext_item_ref, state,
          suggestion_source, confirmed_by, confirmed_at)
       VALUES (gen_random_uuid(), $1, $2, 'ERP-ITEM-2', 'confirmed', 'manual', $3, now())`,
      [TENANT, TPRODUCT, ACTOR],
    );

    const voidId = await seedVoid(e, saleId, "01900000-0000-7000-8000-0000005ee3d1");
    await c.handle(reversalEvent(saleId, voidId, { eventId: "01900000-0000-7000-8000-0000000ev0e4" }));

    const res = await resolutionOf(e, voidId);
    expect(res.version).toBe(1);
    expect(res.rows.map((r) => r.item)).toEqual(["ERP-ITEM-1"]);
  });
});

describe("PostingRequestedConsumer.handle — RT-330 a pending intent is never left unfrozen", () => {
  it("eligible but nothing to freeze (no 'stock' warehouse) → throws and inserts nothing", async () => {
    if (skip) return;
    const e = guard();
    const storeId = "01900000-0000-7000-8000-0000000ac333";
    await e.admin.query(
      `INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $2, 'PRCR', 'Returns only')`,
      [storeId, TENANT],
    );
    await e.admin.query(
      `INSERT INTO erpnext_warehouse_map
         (id, tenant_id, store_id, purpose, erpnext_warehouse_ref, set_by, version)
       VALUES (gen_random_uuid(), $1, $2, 'returns', 'ERP-WH-R', $3, 1)`,
      [TENANT, storeId, ACTOR],
    );
    const saleId = "01900000-0000-7000-8000-00000050e005";
    await seedSale(e, { id: saleId, store: storeId, externalId: "rt330-5", tenantProductRef: TPRODUCT });

    await expect(
      new PostingRequestedConsumer(e.app).handle(
        envelope(
          { sale_id: saleId, store_id: storeId, kind: "sale_post", source_ref_id: saleId },
          "01900000-0000-7000-8000-0000000ev0e5",
        ),
      ),
    ).rejects.toBeInstanceOf(PostingResolutionNotFrozenError);
    expect(await postingRows(e, saleId)).toEqual([]);
  });
});

// Last in the file: retires TPRODUCT's map with no replacement.
describe("PostingRequestedConsumer.handle — RT-330 a reversal follows its sale's frozen resolution", () => {
  it("is created pending with the sale's frozen item even when the live map is retired", async () => {
    if (skip) return;
    const e = guard();
    const saleId = "01900000-0000-7000-8000-00000050e006";
    await seedSale(e, { id: saleId, store: STORE_MAPPED, externalId: "rt330-6", tenantProductRef: TPRODUCT });
    const c = new PostingRequestedConsumer(e.app);
    await c.handle(salePostEvent(saleId, "01900000-0000-7000-8000-0000000ev0e6"));
    const frozen = (await resolutionOf(e, saleId)).rows.map((r) => r.item);
    expect(frozen).toHaveLength(1);

    // The product loses its mapping entirely before the void is drained.
    await e.admin.query(
      `UPDATE erpnext_item_map SET retired_at = now()
        WHERE tenant_id = $1 AND tenant_product_id = $2 AND retired_at IS NULL`,
      [TENANT, TPRODUCT],
    );
    const voidId = await seedVoid(e, saleId, "01900000-0000-7000-8000-0000005ee6d1");
    await c.handle(reversalEvent(saleId, voidId, { eventId: "01900000-0000-7000-8000-0000000ev0e7" }));

    expect((await statusRow(e, voidId)).status).toBe("pending");
    const res = await resolutionOf(e, voidId);
    expect(res.version).toBe(1);
    expect(res.rows.map((r) => r.item)).toEqual(frozen);
  });
});
