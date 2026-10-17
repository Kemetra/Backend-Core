/**
 * void-safe404.spec.ts — 008 US3 T052.
 *
 * A void referencing an out-of-scope (cross-store) or unknown sale is a
 * non-disclosing 404 and writes NO record (FR-014, SI-004). Existence is never
 * leaked: wrong-store and never-existed are indistinguishable.
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

describe("T052 — recordVoid object-safety (non-disclosing 404, no record)", () => {
  it("a same-tenant cross-store void of a known sale → 404, nothing written", async () => {
    if (h.dockerSkipped || !h.harness) return;
    const cap = await h.harness
      .http()
      .post("/api/pos/v1/sales")
      .set("Idempotency-Key", idempKey("vs404a"))
      .send(captureBody({ externalId: "ext-void-xstore" }));
    expect(cap.status).toBe(201);
    const saleRef = cap.body.saleRef;

    // A different store binding (same tenant) must not be able to void it.
    h.harness.contextGuard.storeId = STORE_A_Y;
    const res = await h.harness
      .http()
      .post(`/api/pos/v1/sales/${saleRef}/void`)
      .set("Idempotency-Key", idempKey("vs1"))
      .send({ sourceSystem: "pos-1", externalId: "void-evt-xstore" });
    expect(res.status).toBe(404);

    const voids = await h.harness.env.admin.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM sale_voids WHERE external_id = 'void-evt-xstore'`,
    );
    expect(voids.rows[0]?.n).toBe("0");
  });

  it("a void of an unknown saleRef → 404, nothing written", async () => {
    if (h.dockerSkipped || !h.harness) return;
    h.harness.contextGuard.storeId = STORE_A_X;
    const unknown = "0d000000-0000-7000-8000-0000000fffff";
    const res = await h.harness
      .http()
      .post(`/api/pos/v1/sales/${unknown}/void`)
      .set("Idempotency-Key", idempKey("vs2"))
      .send({ sourceSystem: "pos-1", externalId: "void-evt-unknown" });
    expect(res.status).toBe(404);

    const voids = await h.harness.env.admin.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM sale_voids WHERE external_id = 'void-evt-unknown'`,
    );
    expect(voids.rows[0]?.n).toBe("0");
  });

  it("a cross-tenant void of another tenant's sale → 404, nothing written", async () => {
    if (h.dockerSkipped || !h.harness) return;
    // Sale captured under TENANT_A / STORE_A_X (harness defaults).
    const cap = await h.harness
      .http()
      .post("/api/pos/v1/sales")
      .set("Idempotency-Key", idempKey("vs404t"))
      .send(captureBody({ externalId: "ext-void-xtenant" }));
    expect(cap.status).toBe(201);
    const saleRef = cap.body.saleRef;

    // Switch the principal to TENANT_B — RLS must hide TENANT_A's sale, so the
    // void is a non-disclosing 404 (existence never leaked across tenants).
    h.harness.contextGuard.tenantId = TENANT_B;
    h.harness.contextGuard.storeId = STORE_B_X;
    const res = await h.harness
      .http()
      .post(`/api/pos/v1/sales/${saleRef}/void`)
      .set("Idempotency-Key", idempKey("vs3"))
      .send({ sourceSystem: "pos-1", externalId: "void-evt-xtenant" });
    expect(res.status).toBe(404);

    const voids = await h.harness.env.admin.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM sale_voids WHERE external_id = 'void-evt-xtenant'`,
    );
    expect(voids.rows[0]?.n).toBe("0");
  });
});
