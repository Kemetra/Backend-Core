/**
 * return-concurrency.spec.ts — Jira RT-73 AC1: concurrent reversals on one
 * sale are serialized by the `sales` row lock (SELECT … FOR UPDATE), so they
 * can never over-return a line or break void/return exclusivity (RT-14 D2).
 *
 * The requests are fired in parallel over separate pool connections. Without
 * the lock, several transactions read the same cumulative quantity and all
 * commit; the assertions below fail in that case.
 */
import {
  startCaptureHarness,
  stopCaptureHarness,
  resetHarness,
  idempKey,
  type HarnessHandle,
} from "../capture/__capture-harness";
import {
  captureOneLine,
  cleanReturnsFixtures,
  disableReturns,
  enableReturns,
  postReturn,
  returnBody,
} from "./__returns-support";

const h: HarnessHandle = { harness: null, dockerSkipped: false };

beforeAll(async () => {
  Object.assign(h, await startCaptureHarness());
}, 180_000);
afterAll(async () => {
  disableReturns();
  await stopCaptureHarness(h);
}, 60_000);
beforeEach(() => {
  resetHarness(h);
  enableReturns();
});
afterEach(async () => {
  await cleanReturnsFixtures(h);
});

const skip = (): boolean => h.dockerSkipped || !h.harness;

describe("RT-73 — row lock serializes reversals on one sale", () => {
  it("six concurrent returns of 1 on a line of 3: exactly three succeed", async () => {
    if (skip()) return;
    const s = await captureOneLine(h, { externalId: "ret-conc", quantity: "3", lineAmount: "9.0000" });
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        postReturn(
          h,
          s.saleRef,
          returnBody(`ret-conc-${i}`, [{ lineRef: s.lineRef, quantity: "1" }], "3.0000"),
          `rconc${i}`,
        ),
      ),
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 201, 201, 409, 409, 409]);
    for (const r of results.filter((x) => x.status === 409)) {
      expect(r.body.error.code).toBe("over_return");
    }
    const total = await h.harness!.env.admin.query<{ q: string }>(
      `SELECT COALESCE(SUM(quantity), 0)::text AS q FROM sale_return_lines WHERE sale_line_id = $1`,
      [s.lineRef],
    );
    expect(Number(total.rows[0]!.q)).toBe(3);
  });

  it("a concurrent void and return: exactly one wins, the other is 409 already_reversed", async () => {
    if (skip()) return;
    const s = await captureOneLine(h, { externalId: "ret-conc-vr", quantity: "1", lineAmount: "5.0000" });
    const [voidRes, returnRes] = await Promise.all([
      h
        .harness!.http()
        .post(`/api/pos/v1/sales/${s.saleRef}/void`)
        .set("Idempotency-Key", idempKey("rcvr-void"))
        .send({ sourceSystem: "pos-1", externalId: "void-conc-vr" }),
      postReturn(
        h,
        s.saleRef,
        returnBody("ret-conc-vr-1", [{ lineRef: s.lineRef, quantity: "1" }], "5.0000"),
        "rcvr-ret",
      ),
    ]);
    const statuses = [voidRes.status, returnRes.status].sort();
    expect(statuses).toEqual([201, 409]);
    const loser = voidRes.status === 409 ? voidRes : returnRes;
    expect(loser.body.error.code).toBe("already_reversed");
  });
});
