/**
 * refund-safe404.spec.ts — 008 US4 object-safety (shared with US3 / FR-014, SI-004).
 *
 * A refund referencing an out-of-scope (cross-store / cross-tenant) or unknown
 * sale is a non-disclosing 404 and writes NO record. Existence is never leaked.
 */
import {
  startCaptureHarness,
  stopCaptureHarness,
  resetHarness,
  captureBody,
  idempKey,
  STORE_A_X,
  STORE_A_Y,
  STORE_B_X,
  TENANT_B,
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

function refundBody(externalId: string): Record<string, unknown> {
  return {
    sourceSystem: "pos-1",
    externalId,
    posRefundAmount: "1.0000",
    currencyCode: "USD",
  };
}

async function captureAtStoreA(externalId: string): Promise<string> {
  if (!h.harness) throw new Error("harness not initialized");
  const res = await h.harness
    .http()
    .post("/api/pos/v1/sales")
    .set("Idempotency-Key", idempKey("rs4cap"))
    .send(captureBody({ externalId }));
  expect(res.status).toBe(201);
  return res.body.saleRef;
}

describe("T057b — recordRefund object-safety (non-disclosing 404, no record)", () => {
  it("same-tenant cross-store refund → 404, nothing written", async () => {
    if (h.dockerSkipped || !h.harness) return;
    const saleRef = await captureAtStoreA("ext-refund-xstore");
    h.harness.contextGuard.storeId = STORE_A_Y;
    const res = await h.harness
      .http()
      .post(`/api/pos/v1/sales/${saleRef}/refund`)
      .set("Idempotency-Key", idempKey("rs1"))
      .send(refundBody("refund-evt-xstore"));
    expect(res.status).toBe(404);
    const n = await h.harness.env.admin.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM sale_refunds WHERE external_id = 'refund-evt-xstore'`,
    );
    expect(n.rows[0]?.n).toBe("0");
  });

  it("cross-tenant refund → 404, nothing written", async () => {
    if (h.dockerSkipped || !h.harness) return;
    const saleRef = await captureAtStoreA("ext-refund-xtenant");
    h.harness.contextGuard.tenantId = TENANT_B;
    h.harness.contextGuard.storeId = STORE_B_X;
    const res = await h.harness
      .http()
      .post(`/api/pos/v1/sales/${saleRef}/refund`)
      .set("Idempotency-Key", idempKey("rs2"))
      .send(refundBody("refund-evt-xtenant"));
    expect(res.status).toBe(404);
    const n = await h.harness.env.admin.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM sale_refunds WHERE external_id = 'refund-evt-xtenant'`,
    );
    expect(n.rows[0]?.n).toBe("0");
  });

  it("unknown saleRef refund → 404, nothing written", async () => {
    if (h.dockerSkipped || !h.harness) return;
    h.harness.contextGuard.storeId = STORE_A_X;
    const unknown = "0d000000-0000-7000-8000-0000000fffff";
    const res = await h.harness
      .http()
      .post(`/api/pos/v1/sales/${unknown}/refund`)
      .set("Idempotency-Key", idempKey("rs3"))
      .send(refundBody("refund-evt-unknown"));
    expect(res.status).toBe(404);
    const n = await h.harness.env.admin.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM sale_refunds WHERE external_id = 'refund-evt-unknown'`,
    );
    expect(n.rows[0]?.n).toBe("0");
  });
});
