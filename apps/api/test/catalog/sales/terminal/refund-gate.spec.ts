/**
 * refund-gate.spec.ts — Jira RT-787 (RT-271 R-11): the legacy amount-only
 * `recordRefund` sits behind a deployment gate, off by default. Off → 404
 * `not_found` and nothing recorded, a provenance replay of an earlier refund
 * included; on → the route behaves as before.
 */
import {
  startCaptureHarness,
  stopCaptureHarness,
  resetHarness,
  idempKey,
  refundBody,
  type HarnessHandle,
} from "../capture/__capture-harness";
import { captureOneLine, cleanReturnsFixtures, setLegacyRefund } from "./__returns-support";

const h: HarnessHandle = { harness: null, dockerSkipped: false };

beforeAll(async () => {
  Object.assign(h, await startCaptureHarness());
}, 180_000);
afterAll(async () => {
  setLegacyRefund(false);
  await stopCaptureHarness(h);
}, 60_000);
beforeEach(() => {
  resetHarness(h);
  setLegacyRefund(false);
});
afterEach(async () => {
  await cleanReturnsFixtures(h);
});

const skip = (): boolean => h.dockerSkipped || !h.harness;

function postRefund(saleRef: string, key: string) {
  return h
    .harness!.http()
    .post(`/api/pos/v1/sales/${saleRef}/refund`)
    .set("Idempotency-Key", idempKey(key))
    .send(refundBody({ externalId: "gate-rf-1", posRefundAmount: "1.0000" }));
}

async function refundsOf(saleRef: string): Promise<number> {
  const r = await h.harness!.env.admin.query("SELECT 1 FROM sale_refunds WHERE sale_id = $1", [saleRef]);
  return r.rowCount ?? 0;
}

describe("RT-787 R-11 — legacy recordRefund gate", () => {
  it("off (the default) → 404 not_found, nothing recorded", async () => {
    if (skip()) return;
    const s = await captureOneLine(h, { externalId: "gate-off", quantity: "1", lineAmount: "5.0000" });
    const res = await postRefund(s.saleRef, "gateoff");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("not_found");
    expect(await refundsOf(s.saleRef)).toBe(0);
  });

  it("on → recorded; off again → a provenance replay of it is 404 too", async () => {
    if (skip()) return;
    const s = await captureOneLine(h, { externalId: "gate-on", quantity: "1", lineAmount: "5.0000" });
    setLegacyRefund(true);
    expect((await postRefund(s.saleRef, "gateon1")).status).toBe(201);
    setLegacyRefund(false);
    const replay = await postRefund(s.saleRef, "gateon2");
    expect(replay.status).toBe(404);
    expect(await refundsOf(s.saleRef)).toBe(1);
  });
});
