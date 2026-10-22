/**
 * RT-427 — void / return / refund Inventory Effects through the real HTTP
 * routes, and the posted-ack chain to `confirmed` (Testcontainers).
 *
 * The sale effects are written with the shared writer the worker calls
 * (`writeSaleLineEffects`), on the app (RLS) pool, as the worker's
 * sale-processing transaction does; the void, return and refund go through the
 * capture harness's real controller + service.
 *
 * Proves:
 *   - a void restores the sale's effect exactly once, at the compensated
 *     position; a replayed void writes nothing more;
 *   - a return lands `+q` in the tenant's return landing status;
 *   - a refund writes no effect (847, 851);
 *   - with the flag OFF, a void of a sale with no effects writes nothing;
 *   - chain: sale effect → linked `pending` → RT-426 `posted` signal →
 *     `confirmed`, the effect quantity untouched; the void restores it once.
 */
import {
  linkEffectsToPostingIntent,
  runWithTenantContext,
  writeSaleLineEffects,
} from "@data-pulse-2/db";

import { applyPostingSignalToEffects } from "../../../src/inventory/effect-integration/effect-integration.transitions";
import {
  PRODUCT_A_ACTIVE,
  STORE_A_X,
  TENANT_A,
  approvedVoid,
  captureBody,
  idempKey,
  resetHarness,
  startCaptureHarness,
  stopCaptureHarness,
  type HarnessHandle,
} from "../../catalog/sales/capture/__capture-harness";
import {
  cleanReturnsFixtures,
  disableReturns,
  enableReturns,
  postReturn,
  returnBody,
} from "../../catalog/sales/terminal/__returns-support";

const h: HarnessHandle = { harness: null, dockerSkipped: false };
const skip = (): boolean => h.dockerSkipped || !h.harness;

beforeAll(async () => {
  // RT-787 (RT-271 R-11): the legacy refund route is gated off by default.
  process.env["POS_LEGACY_REFUND_ENABLED"] = "true";
  Object.assign(h, await startCaptureHarness());
}, 180_000);
afterAll(async () => {
  delete process.env["POS_LEGACY_REFUND_ENABLED"];
  disableReturns();
  await stopCaptureHarness(h);
}, 60_000);
beforeEach(async () => {
  resetHarness(h);
  enableReturns();
  if (!skip()) await setActivation(true);
});
afterEach(async () => {
  if (skip()) return;
  const q = (sql: string) => h.harness!.env.admin.query(sql);
  // Effects are append-only for the app role; the superuser clears them.
  await q(`DELETE FROM inventory_effect_integration WHERE effect_id IN
           (SELECT id FROM stock_movements WHERE source_system = 'pos-1')`);
  await q(`DELETE FROM stock_movements WHERE source_system = 'pos-1'`);
  await q(`DELETE FROM erpnext_posting_status WHERE source_system = 'pos-1'`);
  await q(`DELETE FROM sale_refunds WHERE sale_id IN (SELECT id FROM sales WHERE source_system = 'pos-1')`);
  await cleanReturnsFixtures(h);
});

async function setActivation(on: boolean): Promise<void> {
  await h.harness!.env.admin.query(
    `INSERT INTO tenant_inventory_settings (tenant_id, updated_by, sale_effects_activated_at, sale_effects_activated_by)
     VALUES ($1, $1, CASE WHEN $2 THEN now() END, CASE WHEN $2 THEN $1::uuid END)
     ON CONFLICT (tenant_id) DO UPDATE
       SET sale_effects_activated_at = EXCLUDED.sale_effects_activated_at,
           sale_effects_activated_by = EXCLUDED.sale_effects_activated_by,
           return_landing_status = 'sellable'`,
    [TENANT_A, on],
  );
}

/** Capture a one-line sale of PRODUCT_A_ACTIVE (qty 2 at 5.0000). */
async function captureProductSale(externalId: string): Promise<{ saleRef: string; lineRef: string }> {
  const res = await h
    .harness!.http()
    .post("/api/pos/v1/sales")
    .set("Idempotency-Key", idempKey(`cap${externalId}`))
    .send(
      captureBody({
        externalId,
        posTotal: "10.0000",
        lines: [
          {
            lineName: "Widget",
            unitPrice: "5.0000",
            currencyCode: "USD",
            quantity: "2",
            lineAmount: "10.0000",
            unit: "ea",
            tenantProductRef: PRODUCT_A_ACTIVE,
          },
        ],
      }),
    );
  if (res.status !== 201) throw new Error(`capture failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { saleRef: res.body.saleRef, lineRef: res.body.lines[0].lineRef };
}

/** What the worker's sale-processing transaction writes for the sale. */
async function writeSaleEffects(saleRef: string): Promise<void> {
  await runWithTenantContext(h.harness!.env.app, { tenantId: TENANT_A, isPlatformAdmin: false }, (c) =>
    writeSaleLineEffects(c, { tenantId: TENANT_A, storeId: STORE_A_X, saleId: saleRef }),
  );
}

interface Effect {
  id: string;
  event_type: string;
  quantity: string;
  inventory_status: string;
  stock_location_id: string;
  compensates_effect_id: string | null;
  state: string;
}

async function effectsOfSale(saleRef: string): Promise<Effect[]> {
  const r = await h.harness!.env.admin.query<Effect>(
    `SELECT m.id, m.event_type, m.quantity::text AS quantity, m.inventory_status, m.stock_location_id,
            m.compensates_effect_id, i.state
       FROM stock_movements m JOIN inventory_effect_integration i ON i.effect_id = m.id
      WHERE m.sale_id = $1 ORDER BY m.event_type, m.received_at`,
    [saleRef],
  );
  return r.rows;
}

async function postVoid(saleRef: string, externalId: string): Promise<number> {
  const body = await approvedVoid(h, saleRef, { body: { externalId } });
  const res = await h
    .harness!.http()
    .post(`/api/pos/v1/sales/${saleRef}/void`)
    .set("Idempotency-Key", idempKey(`void${externalId}`))
    .send(body);
  return res.status;
}

describe("void", () => {
  it("restores the sale effect exactly once at its position; a replay writes nothing more", async () => {
    if (skip()) return;
    const { saleRef } = await captureProductSale("rt427-void-1");
    await writeSaleEffects(saleRef);
    const body = await approvedVoid(h, saleRef, { body: { externalId: "rt427-void-evt-1" } });
    const send = () =>
      h.harness!.http().post(`/api/pos/v1/sales/${saleRef}/void`).set("Idempotency-Key", idempKey("void1")).send(body);
    expect((await send()).status).toBe(201);
    h.harness!.fakeRedis.clear();
    expect([200, 201]).toContain((await send()).status);
    const [sale, restore, ...rest] = await effectsOfSale(saleRef);
    expect(rest).toEqual([]);
    expect(sale).toMatchObject({ event_type: "sale", quantity: "-2.0000" });
    expect(restore).toMatchObject({
      event_type: "sale_void",
      quantity: "2.0000",
      compensates_effect_id: sale!.id,
      stock_location_id: sale!.stock_location_id,
      inventory_status: sale!.inventory_status,
      state: "not_posted",
    });
  });

  it("with the flag OFF, a void of a sale with no effects writes nothing", async () => {
    if (skip()) return;
    await setActivation(false);
    const { saleRef } = await captureProductSale("rt427-void-off");
    expect(await postVoid(saleRef, "rt427-void-evt-off")).toBe(201);
    expect(await effectsOfSale(saleRef)).toEqual([]);
  });
});

describe("return and refund", () => {
  it("a return lands +q in the tenant's return landing status", async () => {
    if (skip()) return;
    await h.harness!.env.admin.query(
      `UPDATE tenant_inventory_settings SET return_landing_status = 'return_inspection' WHERE tenant_id = $1`,
      [TENANT_A],
    );
    const { saleRef, lineRef } = await captureProductSale("rt427-ret-1");
    await writeSaleEffects(saleRef);
    const res = await postReturn(h, saleRef, returnBody("rt427-ret-evt-1", [{ lineRef, quantity: "1" }], "5.0000"), "ret1");
    expect(res.status).toBe(201);
    const effects = await effectsOfSale(saleRef);
    expect(effects.map((e) => [e.event_type, e.quantity, e.inventory_status, e.compensates_effect_id])).toEqual([
      ["sale", "-2.0000", "sellable", null],
      ["sale_return", "1.0000", "return_inspection", null],
    ]);
  });

  it("a refund writes no effect", async () => {
    if (skip()) return;
    const { saleRef } = await captureProductSale("rt427-ref-1");
    await writeSaleEffects(saleRef);
    const res = await h
      .harness!.http()
      .post(`/api/pos/v1/sales/${saleRef}/refund`)
      .set("Idempotency-Key", idempKey("ref1"))
      .send({ sourceSystem: "pos-1", externalId: "rt427-ref-evt-1", posRefundAmount: "5.0000", currencyCode: "USD" });
    expect(res.status).toBe(201);
    expect((await effectsOfSale(saleRef)).map((e) => e.event_type)).toEqual(["sale"]);
  });
});

describe("posted-ack chain", () => {
  it("pending → confirmed on the RT-426 posted signal, quantity untouched; the void then restores once", async () => {
    if (skip()) return;
    const { saleRef } = await captureProductSale("rt427-chain-1");
    await writeSaleEffects(saleRef);
    const admin = h.harness!.env.admin;
    const posting = await admin.query<{ id: string }>(
      `INSERT INTO erpnext_posting_status (tenant_id, store_id, sale_id, kind, source_ref_id, source_system,
                                           external_id, payload_hash, status)
       SELECT tenant_id, store_id, id, 'sale_post', id, source_system, external_id, payload_hash, 'pending'
         FROM sales WHERE id = $1 RETURNING id`,
      [saleRef],
    );
    const postingId = posting.rows[0]!.id;
    await runWithTenantContext(h.harness!.env.app, { tenantId: TENANT_A, isPlatformAdmin: false }, async (c) => {
      await linkEffectsToPostingIntent(c, {
        tenantId: TENANT_A,
        kind: "sale_post",
        sourceRefId: saleRef,
        postingStatusId: postingId,
        verdict: { status: "pending" },
      });
      await applyPostingSignalToEffects(c, {
        postingStatusId: postingId,
        signal: "posted",
        erpDocumentRef: JSON.stringify({ doctype: "Sales Invoice", name: "SINV-427" }),
        erpConfirmedAt: new Date(),
      });
    });
    const [confirmed] = await effectsOfSale(saleRef);
    expect(confirmed).toMatchObject({ event_type: "sale", quantity: "-2.0000", state: "confirmed" });

    expect(await postVoid(saleRef, "rt427-chain-void")).toBe(201);
    const after = await effectsOfSale(saleRef);
    expect(after.map((e) => [e.event_type, e.quantity, e.state])).toEqual([
      ["sale", "-2.0000", "confirmed"],
      ["sale_void", "2.0000", "not_posted"],
    ]);
  });
});
