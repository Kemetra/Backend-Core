/**
 * void-happy.spec.ts — 008 US3 T050.
 *
 * recordVoid → a SEPARATE void terminal event referencing the sale, stamped
 * with a server-clock `voidedAt`. The original `sales` row + `sale_lines` are
 * byte-identical afterwards (NEVER mutated, §X / FR-010/011, SC-006).
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
      "DELETE FROM sale_voids WHERE source_system = 'pos-1'",
    );
    await h.harness.env.admin.query(
      "DELETE FROM sale_lines WHERE sale_id IN (SELECT id FROM sales WHERE source_system = 'pos-1')",
    );
    await h.harness.env.admin.query(
      "DELETE FROM sales WHERE source_system = 'pos-1'",
    );
  }
});

async function captureSale(externalId: string): Promise<string> {
  if (!h.harness) throw new Error("harness not initialized");
  const res = await h.harness
    .http()
    .post("/api/pos/v1/sales")
    .set("Idempotency-Key", idempKey("vcap"))
    .send(captureBody({ externalId }));
  expect(res.status).toBe(201);
  return res.body.saleRef;
}

describe("T050 — recordVoid happy path (separate terminal event, sale unchanged)", () => {
  it("voids a sale → 201 SaleTerminalEvent; original sale + lines unchanged", async () => {
    if (h.dockerSkipped || !h.harness) return;
    const saleRef = await captureSale("ext-void-happy");

    const before = await h.harness.http().get(`/api/pos/v1/sales/${saleRef}`);
    expect(before.status).toBe(200);

    const res = await h.harness
      .http()
      .post(`/api/pos/v1/sales/${saleRef}/void`)
      .set("Idempotency-Key", idempKey("vk1"))
      .send({ sourceSystem: "pos-1", externalId: "void-evt-001" });

    expect(res.status).toBe(201);
    expect(res.body.kind).toBe("void");
    expect(res.body.saleRef).toBe(saleRef);
    expect(typeof res.body.eventRef).toBe("string");
    expect(typeof res.body.recordedAt).toBe("string");
    // Void carries no refund money.
    expect(res.body.posRefundAmount ?? null).toBeNull();
    expect(res.body.currencyCode ?? null).toBeNull();

    // Exactly one void row was written.
    const voids = await h.harness.env.admin.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM sale_voids WHERE external_id = 'void-evt-001'`,
    );
    expect(voids.rows[0]?.n).toBe("1");

    // The sale is NEVER mutated: every stored field of its projection is
    // identical afterwards. Only the DERIVED return state moves (RT-73): the
    // sale reads as voided and nothing on it remains returnable (RT-14 D2).
    const after = await h.harness.http().get(`/api/pos/v1/sales/${saleRef}`);
    expect(after.status).toBe(200);
    expect(before.body.voided).toBe(false);
    expect(after.body).toEqual({
      ...before.body,
      voided: true,
      lines: before.body.lines.map((l: Record<string, unknown>) => ({
        ...l,
        returnableQuantity: "0.000000",
      })),
    });
  });
});
