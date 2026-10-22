/**
 * reconcile.spec.ts — 008 US5 T062.
 *
 * Every captured sale AND its void / refund terminal events retain the
 * provenance needed to reconcile back to the POS payload (FR-040, SC-008;
 * gate C): `source_system`, `external_id`, and a SHA-256-canonical
 * `payload_hash` (64 hex chars) are persisted on each of the three rows.
 */
import {
  startCaptureHarness,
  stopCaptureHarness,
  resetHarness,
  captureBody,
  idempKey,
  approvedVoid,
  type HarnessHandle,
} from "../capture/__capture-harness";

const h: HarnessHandle = { harness: null, dockerSkipped: false };
const SHA256_HEX = /^[0-9a-f]{64}$/;

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

describe("T062 — provenance retained across sale / void / refund", () => {
  it("each row keeps source_system, external_id, and a SHA-256 payload_hash", async () => {
    if (h.dockerSkipped || !h.harness) return;
    const cap = await h.harness
      .http()
      .post("/api/pos/v1/sales")
      .set("Idempotency-Key", idempKey("pcap"))
      .send(captureBody({ externalId: "ext-prov-sale" }));
    expect(cap.status).toBe(201);
    const saleRef = cap.body.saleRef;

    const voided = await h.harness
      .http()
      .post(`/api/pos/v1/sales/${saleRef}/void`)
      .set("Idempotency-Key", idempKey("pvoid"))
      .send(await approvedVoid(h, saleRef, { body: { externalId: "prov-void" } }));
    expect(voided.status).toBe(201);

    const refunded = await h.harness
      .http()
      .post(`/api/pos/v1/sales/${saleRef}/refund`)
      .set("Idempotency-Key", idempKey("pref"))
      .send({
        sourceSystem: "pos-1",
        externalId: "prov-refund",
        posRefundAmount: "1.0000",
        currencyCode: "USD",
      });
    expect(refunded.status).toBe(201);

    const checks: Array<{ table: string; ext: string }> = [
      { table: "sales", ext: "ext-prov-sale" },
      { table: "sale_voids", ext: "prov-void" },
      { table: "sale_refunds", ext: "prov-refund" },
    ];
    const hashes: string[] = [];
    for (const { table, ext } of checks) {
      const row = await h.harness.env.admin.query<{
        source_system: string;
        external_id: string;
        payload_hash: string;
      }>(
        `SELECT source_system, external_id, payload_hash FROM ${table} WHERE external_id = $1`,
        [ext],
      );
      expect(row.rowCount).toBe(1);
      expect(row.rows[0]?.source_system).toBe("pos-1");
      expect(row.rows[0]?.external_id).toBe(ext);
      expect(row.rows[0]?.payload_hash).toMatch(SHA256_HEX);
      hashes.push(row.rows[0]!.payload_hash);
    }
    // Each hash is payload-DERIVED, not a shared constant: the three distinct
    // payloads (sale / void / refund) must yield three distinct hashes.
    expect(new Set(hashes).size).toBe(3);
  });
});
