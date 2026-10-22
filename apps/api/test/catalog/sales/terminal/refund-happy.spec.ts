/**
 * refund-happy.spec.ts — 008 US4 T055.
 *
 * recordRefund → a SEPARATE refund terminal event referencing the sale, stamped
 * with a server-clock `refundedAt`, preserving the POS-reported amount. The
 * original `sales` row + `sale_lines` are byte-identical afterwards (NEVER
 * mutated, §X / FR-010/012, SC-006).
 */
import {
  startCaptureHarness,
  stopCaptureHarness,
  resetHarness,
  captureBody,
  idempKey,
  type HarnessHandle,
} from "../capture/__capture-harness";

const h: HarnessHandle = { harness: null, dockerSkipped: false };

beforeAll(async () => {
  Object.assign(h, await startCaptureHarness());
}, 180_000);
afterAll(async () => {
  await stopCaptureHarness(h);
}, 60_000);
beforeEach(() => resetHarness(h));
afterEach(async () => {
  if (h.harness) {
    await h.harness.env.admin.query(
      "DELETE FROM sale_refunds WHERE source_system = 'pos-1'",
    );
    await h.harness.env.admin.query(
      "DELETE FROM sale_lines WHERE sale_id IN (SELECT id FROM sales WHERE source_system = 'pos-1')",
    );
    await h.harness.env.admin.query(
      "DELETE FROM sales WHERE source_system = 'pos-1'",
    );
  }
});

describe("T055 — recordRefund happy path (separate terminal event, sale unchanged)", () => {
  it("refunds a sale → 201 SaleTerminalEvent; original sale + lines unchanged", async () => {
    if (h.dockerSkipped || !h.harness) return;
    const cap = await h.harness
      .http()
      .post("/api/pos/v1/sales")
      .set("Idempotency-Key", idempKey("rcap"))
      .send(captureBody({ externalId: "ext-refund-happy" }));
    expect(cap.status).toBe(201);
    const saleRef = cap.body.saleRef;

    const before = await h.harness.http().get(`/api/pos/v1/sales/${saleRef}`);
    expect(before.status).toBe(200);

    const res = await h.harness
      .http()
      .post(`/api/pos/v1/sales/${saleRef}/refund`)
      .set("Idempotency-Key", idempKey("rk1"))
      .send({
        sourceSystem: "pos-1",
        externalId: "refund-evt-001",
        posRefundAmount: "12.5000",
        currencyCode: "USD",
      });

    expect(res.status).toBe(201);
    expect(res.body.kind).toBe("refund");
    expect(res.body.saleRef).toBe(saleRef);
    expect(typeof res.body.eventRef).toBe("string");
    expect(typeof res.body.recordedAt).toBe("string");
    expect(res.body.posRefundAmount).toBe("12.5000");
    expect(res.body.currencyCode).toBe("USD");

    const refunds = await h.harness.env.admin.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM sale_refunds WHERE external_id = 'refund-evt-001'`,
    );
    expect(refunds.rows[0]?.n).toBe("1");

    const after = await h.harness.http().get(`/api/pos/v1/sales/${saleRef}`);
    expect(after.status).toBe(200);
    expect(after.body).toEqual(before.body);
  });
});
