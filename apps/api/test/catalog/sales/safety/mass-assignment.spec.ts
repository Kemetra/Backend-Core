/**
 * mass-assignment.spec.ts — 008 US6 T070.
 *
 * Server-owned fields are NEVER body-assignable (FR-061, SC-005): the strict
 * Zod DTOs reject any attempt to supply tenant_id / store_id / created_by /
 * received_at / business_date / processed_at / mismatch_flag (capture) or
 * tenant/store/actor (void/refund) with a 400 — and nothing is persisted.
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
  // RT-787 (RT-271 R-11): the legacy refund route is gated off by default.
  process.env["POS_LEGACY_REFUND_ENABLED"] = "true";
  Object.assign(h, await startCaptureHarness());
}, 180_000);
afterAll(async () => {
  delete process.env["POS_LEGACY_REFUND_ENABLED"];
  await stopCaptureHarness(h);
}, 60_000);
beforeEach(() => resetHarness(h));
afterEach(async () => {
  if (h.harness) {
    await h.harness.env.admin.query(
      "DELETE FROM sale_refunds WHERE source_system = 'pos-1'",
    );
    await h.harness.env.admin.query(
      "DELETE FROM sale_voids WHERE source_system = 'pos-1'",
    );
    // RT-577 (0054): the shared approval-use ledger the sale_voids trigger fills.
    await h.harness.env.admin.query("DELETE FROM sale_approval_uses");
    await h.harness.env.admin.query(
      "DELETE FROM sale_lines WHERE sale_id IN (SELECT id FROM sales WHERE source_system = 'pos-1')",
    );
    await h.harness.env.admin.query(
      "DELETE FROM sales WHERE source_system = 'pos-1'",
    );
  }
});

const FORBIDDEN_ON_CAPTURE = [
  "tenant_id",
  "store_id",
  "created_by",
  "received_at",
  "business_date",
  "processed_at",
  "mismatch_flag",
] as const;

describe("T070 — captureSale rejects body-supplied server-owned fields", () => {
  it.each(FORBIDDEN_ON_CAPTURE)(
    "body-supplied %s → 400, no row written",
    async (field) => {
      if (h.dockerSkipped || !h.harness) return;
      const ext = `ext-ma-${field}`;
      const res = await h.harness
        .http()
        .post("/api/pos/v1/sales")
        .set("Idempotency-Key", idempKey(`ma${field}`))
        .send(captureBody({ externalId: ext, [field]: "x" }));
      expect(res.status).toBe(400);

      const n = await h.harness.env.admin.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM sales WHERE external_id = $1`,
        [ext],
      );
      expect(n.rows[0]?.n).toBe("0");
    },
  );
});

describe("T070 — terminal events reject body-supplied authority fields", () => {
  it("void with body-supplied tenant_id → 400, no record", async () => {
    if (h.dockerSkipped || !h.harness) return;
    const cap = await h.harness
      .http()
      .post("/api/pos/v1/sales")
      .set("Idempotency-Key", idempKey("mavc"))
      .send(captureBody({ externalId: "ext-ma-void" }));
    expect(cap.status).toBe(201);

    const res = await h.harness
      .http()
      .post(`/api/pos/v1/sales/${cap.body.saleRef}/void`)
      .set("Idempotency-Key", idempKey("mav1"))
      .send({
        sourceSystem: "pos-1",
        externalId: "ma-void",
        tenant_id: "x",
      });
    expect(res.status).toBe(400);

    const n = await h.harness.env.admin.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM sale_voids WHERE external_id = 'ma-void'`,
    );
    expect(n.rows[0]?.n).toBe("0");
  });

  it("refund with body-supplied store_id / created_by → 400, no record", async () => {
    if (h.dockerSkipped || !h.harness) return;
    const cap = await h.harness
      .http()
      .post("/api/pos/v1/sales")
      .set("Idempotency-Key", idempKey("marc"))
      .send(captureBody({ externalId: "ext-ma-refund" }));
    expect(cap.status).toBe(201);

    const res = await h.harness
      .http()
      .post(`/api/pos/v1/sales/${cap.body.saleRef}/refund`)
      .set("Idempotency-Key", idempKey("mar1"))
      .send({
        sourceSystem: "pos-1",
        externalId: "ma-refund",
        posRefundAmount: "1.0000",
        currencyCode: "USD",
        store_id: "x",
        created_by: "y",
      });
    expect(res.status).toBe(400);

    const n = await h.harness.env.admin.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM sale_refunds WHERE external_id = 'ma-refund'`,
    );
    expect(n.rows[0]?.n).toBe("0");
  });
});
