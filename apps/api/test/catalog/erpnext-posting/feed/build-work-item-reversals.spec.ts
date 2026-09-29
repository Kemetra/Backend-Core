/**
 * build-work-item-reversals.spec.ts — Jira RT-73 AC3 + comment 10350, against
 * a real RLS-forced Postgres (the unit spec fakes the client).
 *
 * Records a real return and a real void through the sale API, then projects
 * each as a `reversal` work-item with the production `buildWorkItem` under
 * the tenant GUC, proving:
 *   - a return carries `reversalKind: "return"`, its own `recordedAt` /
 *     `businessDate` and only the returned lines;
 *   - a void carries its own `recordedAt` / `businessDate`, no return lines;
 *   - the top-level `businessDate` stays the ORIGINAL sale's (RT-63 P1);
 *   - re-projecting yields an identical work-item (immutable sources).
 */
import { runWithTenantContext } from "@data-pulse-2/db";

import { buildWorkItem } from "../../../../src/catalog/erpnext-posting/posting-work-item.projection";
import {
  startCaptureHarness,
  stopCaptureHarness,
  resetHarness,
  captureBody,
  idempKey,
  TENANT_A,
  PRODUCT_A_ACTIVE,
  type HarnessHandle,
} from "../../sales/capture/__capture-harness";
import {
  cleanReturnsFixtures,
  disableReturns,
  enableReturns,
  postReturn,
  returnBody,
} from "../../sales/terminal/__returns-support";

const h: HarnessHandle = { harness: null, dockerSkipped: false };
const ERP_ITEM_REF = "ERP-ITEM-RT73";

beforeAll(async () => {
  Object.assign(h, await startCaptureHarness());
  if (!h.harness) return;
  await h.harness.env.admin.query(
    `INSERT INTO erpnext_item_map
       (id, tenant_id, tenant_product_id, erpnext_item_ref, state,
        suggestion_source, confirmed_by, confirmed_at)
     VALUES (gen_random_uuid(), $1, $2, $3, 'confirmed', 'manual', $4, now())
     ON CONFLICT DO NOTHING`,
    [TENANT_A, PRODUCT_A_ACTIVE, ERP_ITEM_REF, "01900000-0000-7000-8000-0000000be073"],
  );
}, 180_000);
afterAll(async () => {
  disableReturns();
  await stopCaptureHarness(h);
}, 60_000);
beforeEach(() => {
  resetHarness(h);
  enableReturns();
});
afterEach(async () => {
  await cleanReturnsFixtures(h);
});

const skip = (): boolean => h.dockerSkipped || !h.harness;

/** Capture a mapped one-line sale (3 × 9.0000) and return its refs + provenance. */
async function captureMapped(externalId: string) {
  const res = await h
    .harness!.http()
    .post("/api/pos/v1/sales")
    .set("Idempotency-Key", idempKey(`bw${externalId}`))
    .send(
      captureBody({
        externalId,
        posTotal: "9.0000",
        lines: [
          {
            lineName: "Mapped widget",
            unitPrice: "3.0000",
            currencyCode: "USD",
            quantity: "3",
            lineAmount: "9.0000",
            unit: "ea",
            tenantProductRef: PRODUCT_A_ACTIVE,
          },
        ],
      }),
    );
  expect(res.status).toBe(201);
  return {
    saleRef: res.body.saleRef as string,
    lineRef: res.body.lines[0].lineRef as string,
    businessDate: res.body.businessDate as string,
  };
}

async function project(saleRef: string, sourceRefId: string) {
  return runWithTenantContext(
    h.harness!.env.app,
    { tenantId: TENANT_A, isPlatformAdmin: false },
    (client) =>
      buildWorkItem(client, {
        id: "01900000-0000-7000-8000-0000000b7e73",
        kind: "reversal",
        saleId: saleRef,
        sourceRefId,
        sourceSystem: "pos-1",
        externalId: "bw-provenance",
        payloadHash: "a".repeat(64),
        sequence: "1",
      }),
  );
}

describe("RT-73 — reversal work-items from real rows", () => {
  it("a return projects reversalKind return, its own time/date and only the returned lines; re-projection is identical", async () => {
    if (skip()) return;
    const sale = await captureMapped("bw-ret");
    const ret = await postReturn(
      h,
      sale.saleRef,
      returnBody("bw-ret-1", [{ lineRef: sale.lineRef, quantity: "1" }], "3.0000"),
      "bwret1",
    );
    expect(ret.status).toBe(201);

    const first = await project(sale.saleRef, ret.body.returnRef);
    expect(first).not.toBeNull();
    expect(first!.businessDate).toBe(sale.businessDate);
    expect(first!.sale.lines[0]!.lineRef).toBe(sale.lineRef);
    expect(first!.reversalOf).toEqual({
      sourceSystem: "pos-1",
      externalId: "bw-ret",
      reversalKind: "return",
      recordedAt: ret.body.recordedAt,
      businessDate: ret.body.businessDate,
      returnLines: [
        { lineRef: sale.lineRef, quantity: "1.000000", lineAmount: "3.0000", taxAmount: null },
      ],
    });

    const again = await project(sale.saleRef, ret.body.returnRef);
    expect(again).toEqual(first);
  });

  it("a void projects its own recordedAt + businessDate and no returnLines; re-projection is identical", async () => {
    if (skip()) return;
    const sale = await captureMapped("bw-void");
    const v = await h
      .harness!.http()
      .post(`/api/pos/v1/sales/${sale.saleRef}/void`)
      .set("Idempotency-Key", idempKey("bwvoid"))
      .send({ sourceSystem: "pos-1", externalId: "bw-void-evt" });
    expect(v.status).toBe(201);
    const stored = await h.harness!.env.admin.query<{ business_date: string }>(
      "SELECT business_date::text AS business_date FROM sale_voids WHERE id = $1",
      [v.body.eventRef],
    );

    const first = await project(sale.saleRef, v.body.eventRef);
    expect(first!.reversalOf).toEqual({
      sourceSystem: "pos-1",
      externalId: "bw-void",
      reversalKind: "void",
      recordedAt: v.body.recordedAt,
      businessDate: stored.rows[0]!.business_date,
    });
    expect(await project(sale.saleRef, v.body.eventRef)).toEqual(first);
  });
});
