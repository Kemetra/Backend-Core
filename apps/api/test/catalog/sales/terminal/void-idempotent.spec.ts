/**
 * void-idempotent.spec.ts — 008 US3 T051.
 *
 * A second void of the same sale with the SAME provenance (independent of the
 * Idempotency-Key) is a deterministic already-voided replay: 200 +
 * `Idempotent-Replayed`, the identical event, and exactly ONE void row (FR-013).
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

describe("T051 — recordVoid is idempotent on provenance", () => {
  it("second void (same provenance, different Idempotency-Key) → 200 replay, one row", async () => {
    if (h.dockerSkipped || !h.harness) return;
    const cap = await h.harness
      .http()
      .post("/api/pos/v1/sales")
      .set("Idempotency-Key", idempKey("vicap"))
      .send(captureBody({ externalId: "ext-void-idem" }));
    expect(cap.status).toBe(201);
    const saleRef = cap.body.saleRef;
    const voidBody = await approvedVoid(h, saleRef, { body: { externalId: "void-evt-idem" } });

    const first = await h.harness
      .http()
      .post(`/api/pos/v1/sales/${saleRef}/void`)
      .set("Idempotency-Key", idempKey("vi1"))
      .send(voidBody);
    expect(first.status).toBe(201);

    // Re-delivery with a DIFFERENT Idempotency-Key but the SAME void provenance.
    const second = await h.harness
      .http()
      .post(`/api/pos/v1/sales/${saleRef}/void`)
      .set("Idempotency-Key", idempKey("vi2"))
      .send(voidBody);
    expect(second.status).toBe(200);
    expect(second.headers["idempotent-replayed"]).toBe("true");
    expect(second.body.eventRef).toBe(first.body.eventRef);

    const voids = await h.harness.env.admin.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM sale_voids WHERE external_id = 'void-evt-idem'`,
    );
    expect(voids.rows[0]?.n).toBe("1");
  });

  it("the SAME provenance reused for a DIFFERENT sale → 409, target sale not voided", async () => {
    if (h.dockerSkipped || !h.harness) return;
    // Two distinct sales in the same store.
    const capA = await h.harness
      .http()
      .post("/api/pos/v1/sales")
      .set("Idempotency-Key", idempKey("vxa"))
      .send(captureBody({ externalId: "ext-void-collA" }));
    const capB = await h.harness
      .http()
      .post("/api/pos/v1/sales")
      .set("Idempotency-Key", idempKey("vxb"))
      .send(captureBody({ externalId: "ext-void-collB" }));
    expect(capA.status).toBe(201);
    expect(capB.status).toBe(201);
    const saleA = capA.body.saleRef;
    const saleB = capB.body.saleRef;
    const provFor = (saleRef: string) => approvedVoid(h, saleRef, { body: { externalId: "void-evt-coll" } });

    const v1 = await h.harness
      .http()
      .post(`/api/pos/v1/sales/${saleA}/void`)
      .set("Idempotency-Key", idempKey("vc1"))
      .send(await provFor(saleA));
    expect(v1.status).toBe(201);

    // Reusing the void's provenance against a DIFFERENT sale is a conflict, not
    // a replay — it must NOT report saleB as voided, and must write no row.
    const v2 = await h.harness
      .http()
      .post(`/api/pos/v1/sales/${saleB}/void`)
      .set("Idempotency-Key", idempKey("vc2"))
      .send(await provFor(saleB));
    expect(v2.status).toBe(409);

    const rows = await h.harness.env.admin.query<{ sale_id: string }>(
      `SELECT sale_id FROM sale_voids WHERE external_id = 'void-evt-coll'`,
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0]?.sale_id).toBe(saleA);
  });
});
