/**
 * return-reads.spec.ts — Jira RT-787 (RT-271 F-2, R-8): `listSaleReturns` and
 * `readReturnByProvenance` against a real RLS-forced Postgres.
 *
 *   - every `recordReturn` return of the sale, oldest first, each with its
 *     derived refund settlement: null when untracked (no allocationRef),
 *     `open` → `partially_settled` → `settled` from settled executions;
 *   - the by-provenance read returns the same `SaleReturn` projection
 *     `recordReturn` answered with;
 *   - a sale outside the caller's (tenant, store) scope, an unknown
 *     provenance and a provenance of another sale are one non-disclosing 404;
 *   - neither read is behind POS_RETURNS_ENABLED, and neither records anything.
 */
import {
  startCaptureHarness,
  stopCaptureHarness,
  resetHarness,
  STORE_A_Y,
  TENANT_B,
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
  returnBody,
  uuidFor,
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

const list = (saleRef: string) => h.harness!.http().get(`/api/pos/v1/sales/${saleRef}/returns`);
const byProvenance = (saleRef: string, query: Record<string, string>) =>
  h.harness!.http().get(`/api/pos/v1/sales/${saleRef}/returns/by-provenance`).query(query);

describe("RT-787 listSaleReturns", () => {
  it("a sale with no return → 200 with an empty list", async () => {
    if (skip()) return;
    const s = await captureOneLine(h, { externalId: "rd-empty", quantity: "1", lineAmount: "5.0000" });
    const res = await list(s.saleRef);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ saleRef: s.saleRef, returns: [] });
  });

  it("lists returns oldest first, with settlement null (untracked) and open → partially_settled → settled", async () => {
    if (skip()) return;
    const s = await captureOneLine(h, { externalId: "rd-list", quantity: "3", lineAmount: "15.0000" });
    const plain = await postReturn(
      h,
      s.saleRef,
      returnBody("rd-list-1", [{ lineRef: s.lineRef, quantity: "1" }], "5.0000"),
      "rdlist1",
    );
    const a1 = uuidFor("rd-list-a1");
    const a2 = uuidFor("rd-list-a2");
    const tracked = await postReturn(
      h,
      s.saleRef,
      allocatedReturnBody("rd-list-2", [{ lineRef: s.lineRef, quantity: "2" }], [
        { amount: "6.0000", allocationRef: a1 },
        { amount: "4.0000", allocationRef: a2 },
      ]),
      "rdlist2",
    );
    expect([plain.status, tracked.status]).toEqual([201, 201]);

    const before = await list(s.saleRef);
    expect(before.status).toBe(200);
    expect(before.body.returns.map((r: { saleReturn: { returnRef: string } }) => r.saleReturn.returnRef)).toEqual([
      plain.body.returnRef,
      tracked.body.returnRef,
    ]);
    expect(before.body.returns[0]).toEqual({ saleReturn: plain.body, settlement: null });
    expect(before.body.returns[1].saleReturn).toEqual(tracked.body);
    expect(before.body.returns[1].settlement).toEqual({ state: "open", settledAmount: "0.0000", executions: [] });

    const e1 = await postExecution(h, { saleRef: s.saleRef, returnRef: tracked.body.returnRef },
      executionBody("rd-list-e1", a1, "6.0000"),
      "rdliste1",
    );
    const partial = await list(s.saleRef);
    expect(partial.body.returns[1].settlement).toEqual({
      state: "partially_settled",
      settledAmount: "6.0000",
      executions: [e1.body],
    });

    const e2 = await postExecution(h, { saleRef: s.saleRef, returnRef: tracked.body.returnRef },
      executionBody("rd-list-e2", a2, "4.0000"),
      "rdliste2",
    );
    const settled = await list(s.saleRef);
    expect(settled.body.returns[1].settlement).toEqual({
      state: "settled",
      settledAmount: "10.0000",
      executions: [e1.body, e2.body],
    });
  });

  it("is not behind POS_RETURNS_ENABLED", async () => {
    if (skip()) return;
    const s = await captureOneLine(h, { externalId: "rd-ungated", quantity: "1", lineAmount: "5.0000" });
    disableReturns();
    expect((await list(s.saleRef)).status).toBe(200);
  });

  it("another store's sale, another tenant's sale and a malformed saleRef are the same 404", async () => {
    if (skip()) return;
    const s = await captureOneLine(h, { externalId: "rd-scope", quantity: "1", lineAmount: "5.0000" });
    const malformed = await list("not-a-uuid");
    h.harness!.contextGuard.storeId = STORE_A_Y;
    const otherStore = await list(s.saleRef);
    resetHarness(h);
    h.harness!.contextGuard.tenantId = TENANT_B;
    const otherTenant = await list(s.saleRef);
    for (const res of [malformed, otherStore, otherTenant]) {
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("not_found");
    }
  });
});

describe("RT-787 readReturnByProvenance", () => {
  it("200 with the recorded SaleReturn and its settlement", async () => {
    if (skip()) return;
    const s = await captureOneLine(h, { externalId: "rd-prov", quantity: "1", lineAmount: "5.0000" });
    const ret = await postReturn(
      h,
      s.saleRef,
      returnBody("rd-prov-1", [{ lineRef: s.lineRef, quantity: "1" }], "5.0000"),
      "rdprov1",
    );
    const res = await byProvenance(s.saleRef, { sourceSystem: "pos-1", externalId: "rd-prov-1" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ saleReturn: ret.body, settlement: null });
  });

  it("an unknown provenance and a provenance recorded against another sale are the same 404", async () => {
    if (skip()) return;
    const s1 = await captureOneLine(h, { externalId: "rd-prov-a", quantity: "1", lineAmount: "5.0000" });
    const s2 = await captureOneLine(h, { externalId: "rd-prov-b", quantity: "1", lineAmount: "5.0000" });
    await postReturn(h, s1.saleRef, returnBody("rd-prov-x", [{ lineRef: s1.lineRef, quantity: "1" }], "5.0000"), "rdpx");
    const unknown = await byProvenance(s1.saleRef, { sourceSystem: "pos-1", externalId: "rd-prov-none" });
    const otherSale = await byProvenance(s2.saleRef, { sourceSystem: "pos-1", externalId: "rd-prov-x" });
    for (const res of [unknown, otherSale]) {
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("not_found");
    }
  });

  it.each([
    ["no externalId", { sourceSystem: "pos-1" }],
    ["an empty sourceSystem", { sourceSystem: "", externalId: "x" }],
    ["an externalId over 200 characters", { sourceSystem: "pos-1", externalId: "x".repeat(201) }],
    ["a NUL character", { sourceSystem: "pos-1", externalId: "a\u0000b" }],
  ])("%s → 400 validation_error", async (_name, query) => {
    if (skip()) return;
    const s = await captureOneLine(h, { externalId: `rd-q-${_name.length}`, quantity: "1", lineAmount: "5.0000" });
    const res = await byProvenance(s.saleRef, query);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
  });
});
