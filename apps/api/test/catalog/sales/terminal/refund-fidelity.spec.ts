/**
 * refund-fidelity.spec.ts — 008 US4 T056.
 *
 * The POS-reported refund amount is preserved VERBATIM — the SaaS stores it
 * as-is and NEVER rewrites it to the sale total or anything else (FR-012/030/031).
 * A partial refund (amount < sale total) round-trips exactly.
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

describe("T056 — recordRefund preserves the POS amount verbatim", () => {
  it("a partial refund amount is stored exactly, never rewritten to the sale total", async () => {
    if (h.dockerSkipped || !h.harness) return;
    // Sale total is 12.5000 (captureBody default); refund a different, partial amount.
    const cap = await h.harness
      .http()
      .post("/api/pos/v1/sales")
      .set("Idempotency-Key", idempKey("rfcap"))
      .send(captureBody({ externalId: "ext-refund-fidelity" }));
    expect(cap.status).toBe(201);
    const saleRef = cap.body.saleRef;

    const res = await h.harness
      .http()
      .post(`/api/pos/v1/sales/${saleRef}/refund`)
      .set("Idempotency-Key", idempKey("rf1"))
      .send({
        sourceSystem: "pos-1",
        externalId: "refund-evt-partial",
        posRefundAmount: "7.3300",
        currencyCode: "USD",
      });

    expect(res.status).toBe(201);
    // Verbatim — NOT rewritten to the 12.5000 sale total.
    expect(res.body.posRefundAmount).toBe("7.3300");

    // And persisted exactly as reported.
    const row = await h.harness.env.admin.query<{ pos_refund_amount: string }>(
      `SELECT pos_refund_amount FROM sale_refunds WHERE external_id = 'refund-evt-partial'`,
    );
    expect(row.rows[0]?.pos_refund_amount).toBe("7.3300");
  });

  it("a sub-scale amount normalizes to numeric(19,4) scale, not rewritten in value", async () => {
    if (h.dockerSkipped || !h.harness) return;
    const cap = await h.harness
      .http()
      .post("/api/pos/v1/sales")
      .set("Idempotency-Key", idempKey("rfn"))
      .send(captureBody({ externalId: "ext-refund-norm" }));
    expect(cap.status).toBe(201);

    const res = await h.harness
      .http()
      .post(`/api/pos/v1/sales/${cap.body.saleRef}/refund`)
      .set("Idempotency-Key", idempKey("rfn1"))
      .send({
        sourceSystem: "pos-1",
        externalId: "refund-evt-norm",
        posRefundAmount: "7.3",
        currencyCode: "USD",
      });
    // numeric(19,4) — same value, canonical 4-dp scale (documents the contract).
    expect(res.status).toBe(201);
    expect(res.body.posRefundAmount).toBe("7.3000");
  });

  it("a negative refund amount is rejected at the boundary (400), nothing written", async () => {
    if (h.dockerSkipped || !h.harness) return;
    const cap = await h.harness
      .http()
      .post("/api/pos/v1/sales")
      .set("Idempotency-Key", idempKey("rfneg"))
      .send(captureBody({ externalId: "ext-refund-neg" }));
    expect(cap.status).toBe(201);

    const res = await h.harness
      .http()
      .post(`/api/pos/v1/sales/${cap.body.saleRef}/refund`)
      .set("Idempotency-Key", idempKey("rfneg1"))
      .send({
        sourceSystem: "pos-1",
        externalId: "refund-evt-neg",
        posRefundAmount: "-5.0000",
        currencyCode: "USD",
      });
    expect(res.status).toBe(400);

    const n = await h.harness.env.admin.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM sale_refunds WHERE external_id = 'refund-evt-neg'`,
    );
    expect(n.rows[0]?.n).toBe("0");
  });
});
