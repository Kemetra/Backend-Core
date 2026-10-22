/**
 * refund-execution-audit.spec.ts — Jira RT-787: `recordRefundExecution`
 * emits one `sale.refund_executed` audit event on success, with identifiers
 * only (FR-AUDIT-3, §XIV), and none on a refusal (400 / 409 / 422), which
 * also writes nothing. The return reads audit as `read` events.
 */
import {
  startCaptureHarness,
  stopCaptureHarness,
  resetHarness,
  SpyAuditEnqueuer,
  type HarnessHandle,
} from "../capture/__capture-harness";
import {
  allocatedReturnBody,
  captureOneLine,
  cleanReturnsFixtures,
  disableReturns,
  enableReturns,
  executionBody,
  postExecution,
  postReturn,
  uuidFor,
} from "./__returns-support";

const spy = new SpyAuditEnqueuer();
const h: HarnessHandle = { harness: null, dockerSkipped: false };

beforeAll(async () => {
  Object.assign(h, await startCaptureHarness({ auditEnqueuer: spy }));
}, 180_000);
afterAll(async () => {
  disableReturns();
  await stopCaptureHarness(h);
}, 60_000);
beforeEach(() => {
  resetHarness(h);
  enableReturns();
  spy.reset();
});
afterEach(async () => {
  await cleanReturnsFixtures(h);
});

const skip = (): boolean => h.dockerSkipped || !h.harness;

async function allocated(tag: string): Promise<{ saleRef: string; returnRef: string; a1: string }> {
  const s = await captureOneLine(h, { externalId: `aud-${tag}`, quantity: "1", lineAmount: "5.0000" });
  const a1 = uuidFor(`aud-${tag}-a1`);
  const res = await postReturn(
    h,
    s.saleRef,
    allocatedReturnBody(`aud-${tag}-r`, [{ lineRef: s.lineRef, quantity: "1" }], [{ amount: "5.0000", allocationRef: a1 }]),
    `audr${tag}`,
  );
  if (res.status !== 201) throw new Error(`return failed: ${res.status}`);
  spy.reset();
  return { saleRef: s.saleRef, returnRef: res.body.returnRef, a1 };
}

const executed = () => spy.calls.filter((c) => c.action === "sale.refund_executed");

describe("RT-787 recordRefundExecution — audit", () => {
  it("a recorded execution emits one sale.refund_executed event with identifiers only", async () => {
    if (skip()) return;
    const r = await allocated("ok");
    const res = await postExecution(h, { saleRef: r.saleRef, returnRef: r.returnRef }, executionBody("aud-ok-e1", r.a1, "5.0000"), "audok");
    expect(res.status).toBe(201);
    expect(executed()).toHaveLength(1);
    expect(executed()[0]!.metadata).toEqual({
      sale_ref: r.saleRef,
      return_ref: r.returnRef,
      execution_ref: res.body.executionRef,
    });
  });

  it.each([
    ["400 (unknown allocation)", (a1: string) => executionBody("aud-400", uuidFor("nope"), "1.0000"), 400],
    ["422 (over the allocation)", (a1: string) => executionBody("aud-422", a1, "5.0001"), 422],
  ])("a %s refusal emits no audit event and writes nothing", async (_name, body, status) => {
    if (skip()) return;
    const r = await allocated(`ref${status}`);
    const res = await postExecution(h, { saleRef: r.saleRef, returnRef: r.returnRef }, body(r.a1), `audref${status}`);
    expect(res.status).toBe(status);
    expect(executed()).toHaveLength(0);
    const rows = await h.harness!.env.admin.query("SELECT 1 FROM refund_executions WHERE return_id = $1", [r.returnRef]);
    expect(rows.rowCount).toBe(0);
  });

  it("a 409 provenance conflict emits no audit event", async () => {
    if (skip()) return;
    const r = await allocated("409");
    const body = executionBody("aud-409", r.a1, "2.0000");
    expect((await postExecution(h, { saleRef: r.saleRef, returnRef: r.returnRef }, body, "aud4091")).status).toBe(201);
    spy.reset();
    const res = await postExecution(h, { saleRef: r.saleRef, returnRef: r.returnRef }, { ...body, amount: "3.0000" }, "aud4092");
    expect(res.status).toBe(409);
    expect(executed()).toHaveLength(0);
  });

  it("the return reads audit as pos_sales.returns_listed and pos_sales.return_read", async () => {
    if (skip()) return;
    const r = await allocated("read");
    await h.harness!.http().get(`/api/pos/v1/sales/${r.saleRef}/returns`);
    await h
      .harness!.http()
      .get(`/api/pos/v1/sales/${r.saleRef}/returns/by-provenance`)
      .query({ sourceSystem: "pos-1", externalId: "aud-read-r" });
    expect(spy.calls.map((c) => c.action)).toEqual(["pos_sales.returns_listed", "pos_sales.return_read"]);
  });
});
