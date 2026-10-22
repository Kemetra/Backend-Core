/**
 * refund-idempotent.spec.ts — 008 US4 T057.
 *
 * A re-delivered refund (same provenance, any Idempotency-Key) is NOT
 * double-applied: 201 then a deterministic 200 replay, exactly one row (FR-013).
 * Reusing the provenance for a DIFFERENT sale is a 409 conflict, never a replay
 * (the cross-sale guard proven for void applies identically here).
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

function refundBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sourceSystem: "pos-1",
    externalId: "refund-evt-idem",
    posRefundAmount: "5.0000",
    currencyCode: "USD",
    ...overrides,
  };
}

async function capture(externalId: string, key: string): Promise<string> {
  if (!h.harness) throw new Error("harness not initialized");
  const res = await h.harness
    .http()
    .post("/api/pos/v1/sales")
    .set("Idempotency-Key", idempKey(key))
    .send(captureBody({ externalId }));
  expect(res.status).toBe(201);
  return res.body.saleRef;
}

describe("T057 — recordRefund is idempotent on provenance", () => {
  it("re-delivered refund (same provenance, different key) → 200 replay, one row", async () => {
    if (h.dockerSkipped || !h.harness) return;
    const saleRef = await capture("ext-refund-idem", "ricap");

    const first = await h.harness
      .http()
      .post(`/api/pos/v1/sales/${saleRef}/refund`)
      .set("Idempotency-Key", idempKey("ri1"))
      .send(refundBody());
    expect(first.status).toBe(201);

    const second = await h.harness
      .http()
      .post(`/api/pos/v1/sales/${saleRef}/refund`)
      .set("Idempotency-Key", idempKey("ri2"))
      .send(refundBody());
    expect(second.status).toBe(200);
    expect(second.headers["idempotent-replayed"]).toBe("true");
    expect(second.body.eventRef).toBe(first.body.eventRef);
    expect(second.body.posRefundAmount).toBe("5.0000");

    const refunds = await h.harness.env.admin.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM sale_refunds WHERE external_id = 'refund-evt-idem'`,
    );
    expect(refunds.rows[0]?.n).toBe("1");
  });

  it("the SAME provenance reused for a DIFFERENT sale → 409, target not refunded", async () => {
    if (h.dockerSkipped || !h.harness) return;
    const saleA = await capture("ext-refund-collA", "rxa");
    const saleB = await capture("ext-refund-collB", "rxb");
    const prov = refundBody({ externalId: "refund-evt-coll" });

    const r1 = await h.harness
      .http()
      .post(`/api/pos/v1/sales/${saleA}/refund`)
      .set("Idempotency-Key", idempKey("rc1"))
      .send(prov);
    expect(r1.status).toBe(201);

    const r2 = await h.harness
      .http()
      .post(`/api/pos/v1/sales/${saleB}/refund`)
      .set("Idempotency-Key", idempKey("rc2"))
      .send(prov);
    expect(r2.status).toBe(409);

    const rows = await h.harness.env.admin.query<{ sale_id: string }>(
      `SELECT sale_id FROM sale_refunds WHERE external_id = 'refund-evt-coll'`,
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0]?.sale_id).toBe(saleA);
  });
});
