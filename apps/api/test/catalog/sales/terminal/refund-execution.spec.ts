/**
 * refund-execution.spec.ts — Jira RT-787 (RT-271 F-2): `recordRefundExecution`
 * against a real RLS-forced Postgres.
 *
 *   - check 1: the return resolves as a `recordReturn` return of the path's
 *     sale in the caller's (tenant, store) scope, else a non-disclosing 404;
 *   - check 2 (R-3): provenance replay 200; a changed payload, another
 *     return, or an `executionRef` reused under another provenance → 409;
 *   - check 3: the allocation belongs to the return, `paidAt` ≤ server clock
 *     + 120 s, one `shiftRef` per return (R-9, execution side) → 400;
 *   - check 4 (under the `sales` lock): the allocation's settled executions
 *     never exceed its amount → 422 `refund_execution_exceeds_allocation`;
 *   - R-7: a return deferred at acceptance is emitted exactly once, by the
 *     execution that settles it, whatever the flag says by then; a return
 *     emitted at acceptance is never emitted again.
 * Every refusal records nothing. The route is not behind POS_RETURNS_ENABLED.
 */
import {
  startCaptureHarness,
  stopCaptureHarness,
  resetHarness,
  STORE_A_Y,
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
  postingEventsFor,
  postReturn,
  setSettleBeforePost,
  uuidFor,
} from "./__returns-support";

const h: HarnessHandle = { harness: null, dockerSkipped: false };

beforeAll(async () => {
  Object.assign(h, await startCaptureHarness());
}, 180_000);
afterAll(async () => {
  disableReturns();
  setSettleBeforePost(false);
  await stopCaptureHarness(h);
}, 60_000);
beforeEach(() => {
  resetHarness(h);
  enableReturns();
  setSettleBeforePost(false);
});
afterEach(async () => {
  await cleanReturnsFixtures(h);
});

const skip = (): boolean => h.dockerSkipped || !h.harness;

interface AllocatedReturn {
  readonly saleRef: string;
  readonly returnRef: string;
  readonly a1: string;
  readonly a2: string;
}

/** A sale of 2 × 5.0000 and a return of both, allocated 6 (a1) + 4 (a2). */
async function allocatedReturn(tag: string): Promise<AllocatedReturn> {
  const s = await captureOneLine(h, { externalId: `ex-${tag}`, quantity: "2", lineAmount: "10.0000" });
  const a1 = uuidFor(`${tag}-a1`);
  const a2 = uuidFor(`${tag}-a2`);
  const res = await postReturn(
    h,
    s.saleRef,
    allocatedReturnBody(`ex-${tag}-r`, [{ lineRef: s.lineRef, quantity: "2" }], [
      { amount: "6.0000", allocationRef: a1 },
      { amount: "4.0000", allocationRef: a2 },
    ]),
    `exr${tag}`,
  );
  if (res.status !== 201) throw new Error(`return failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { saleRef: s.saleRef, returnRef: res.body.returnRef, a1, a2 };
}

async function executionsOf(returnRef: string): Promise<number> {
  const r = await h.harness!.env.admin.query("SELECT 1 FROM refund_executions WHERE return_id = $1", [returnRef]);
  return r.rowCount ?? 0;
}

describe("RT-787 recordRefundExecution — happy path and replay", () => {
  it("201 with the RefundExecution projection; the instrument and currency are the allocation's", async () => {
    if (skip()) return;
    const r = await allocatedReturn("happy");
    const body = executionBody("ex-happy-e1", r.a1, "6.0000");
    const res = await postExecution(h, r.saleRef, r.returnRef, body, "exhappy");
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      executionRef: body["executionRef"],
      returnRef: r.returnRef,
      saleRef: r.saleRef,
      allocationRef: r.a1,
      sourceSystem: "pos-1",
      externalId: "ex-happy-e1",
      instrument: "cash",
      amount: "6.0000",
      currencyCode: "USD",
      outcome: "settled",
      evidence: body["evidence"],
      recordedAt: expect.any(String),
    });
  });

  it("the same provenance and payload with another key replays 200 with the identical body", async () => {
    if (skip()) return;
    const r = await allocatedReturn("replay");
    const body = executionBody("ex-replay-e1", r.a1, "6.0000");
    const first = await postExecution(h, r.saleRef, r.returnRef, body, "exreplay1");
    const again = await postExecution(h, r.saleRef, r.returnRef, body, "exreplay2");
    expect(again.status).toBe(200);
    expect(again.headers["idempotent-replayed"]).toBe("true");
    expect(again.body).toEqual(first.body);
    expect(await executionsOf(r.returnRef)).toBe(1);
  });

  it("the route is not behind POS_RETURNS_ENABLED", async () => {
    if (skip()) return;
    const r = await allocatedReturn("ungated");
    disableReturns();
    const res = await postExecution(h, r.saleRef, r.returnRef, executionBody("ex-ungated-e1", r.a1, "6.0000"), "exung");
    expect(res.status).toBe(201);
  });
});

describe("RT-787 recordRefundExecution — 409 conflicts (R-3)", () => {
  it("the same provenance with a changed payload → 409 conflict", async () => {
    if (skip()) return;
    const r = await allocatedReturn("chg");
    const body = executionBody("ex-chg-e1", r.a1, "3.0000");
    expect((await postExecution(h, r.saleRef, r.returnRef, body, "exchg1")).status).toBe(201);
    const res = await postExecution(h, r.saleRef, r.returnRef, { ...body, amount: "2.0000" }, "exchg2");
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("conflict");
    expect(await executionsOf(r.returnRef)).toBe(1);
  });

  it("an executionRef already recorded under another provenance → 409 conflict", async () => {
    if (skip()) return;
    const r = await allocatedReturn("eref");
    const body = executionBody("ex-eref-e1", r.a1, "3.0000");
    expect((await postExecution(h, r.saleRef, r.returnRef, body, "exeref1")).status).toBe(201);
    const res = await postExecution(
      h,
      r.saleRef,
      r.returnRef,
      { ...body, externalId: "ex-eref-e2" },
      "exeref2",
    );
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("conflict");
  });

  it("the same provenance against another return → 409 conflict", async () => {
    if (skip()) return;
    const r1 = await allocatedReturn("other1");
    const r2 = await allocatedReturn("other2");
    const body = executionBody("ex-other-e1", r1.a1, "6.0000");
    expect((await postExecution(h, r1.saleRef, r1.returnRef, body, "exother1")).status).toBe(201);
    const res = await postExecution(h, r2.saleRef, r2.returnRef, { ...body, allocationRef: r2.a1 }, "exother2");
    expect(res.status).toBe(409);
    expect(await executionsOf(r2.returnRef)).toBe(0);
  });
});

describe("RT-787 recordRefundExecution — 400 / 404 / 422, nothing recorded", () => {
  it("an allocationRef that is not an allocation of this return → 400", async () => {
    if (skip()) return;
    const r = await allocatedReturn("noalloc");
    const res = await postExecution(
      h,
      r.saleRef,
      r.returnRef,
      executionBody("ex-noalloc-e1", uuidFor("nope"), "1.0000"),
      "exnoalloc",
    );
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
    expect(await executionsOf(r.returnRef)).toBe(0);
  });

  it("paidAt more than 120 s after the server clock → 400; within it → 201", async () => {
    if (skip()) return;
    const r = await allocatedReturn("future");
    const late = executionBody("ex-future-e1", r.a1, "6.0000");
    const evidence = late["evidence"] as Record<string, unknown>;
    const tooLate = await postExecution(
      h,
      r.saleRef,
      r.returnRef,
      { ...late, evidence: { ...evidence, paidAt: new Date(Date.now() + 10 * 60_000).toISOString() } },
      "exfuture1",
    );
    expect(tooLate.status).toBe(400);
    const ok = await postExecution(
      h,
      r.saleRef,
      r.returnRef,
      { ...late, externalId: "ex-future-e2", executionRef: uuidFor("future-e2"),
        evidence: { ...evidence, paidAt: new Date(Date.now() + 30_000).toISOString() } },
      "exfuture2",
    );
    expect(ok.status).toBe(201);
  });

  it("a paidAt outside the stored range (year 0) → 400, never a 500", async () => {
    if (skip()) return;
    const r = await allocatedReturn("year0");
    const body = executionBody("ex-year0-e1", r.a1, "6.0000");
    const res = await postExecution(
      h,
      r.saleRef,
      r.returnRef,
      { ...body, evidence: { ...(body["evidence"] as object), paidAt: "0000-01-01T00:00:00Z" } },
      "exyear0",
    );
    expect(res.status).toBe(400);
    expect(await executionsOf(r.returnRef)).toBe(0);
  });

  it("R-9: a second execution of the return on another shift → 400", async () => {
    if (skip()) return;
    const r = await allocatedReturn("shift");
    expect(
      (await postExecution(h, r.saleRef, r.returnRef, executionBody("ex-shift-e1", r.a1, "6.0000"), "exshift1")).status,
    ).toBe(201);
    const second = executionBody("ex-shift-e2", r.a2, "4.0000");
    const res = await postExecution(
      h,
      r.saleRef,
      r.returnRef,
      { ...second, evidence: { ...(second["evidence"] as object), shiftRef: uuidFor("other-shift") } },
      "exshift2",
    );
    expect(res.status).toBe(400);
    expect(await executionsOf(r.returnRef)).toBe(1);
  });

  it("an execution above the allocation's remaining amount → 422 refund_execution_exceeds_allocation", async () => {
    if (skip()) return;
    const r = await allocatedReturn("over");
    expect(
      (await postExecution(h, r.saleRef, r.returnRef, executionBody("ex-over-e1", r.a2, "3.0000"), "exover1")).status,
    ).toBe(201);
    const res = await postExecution(h, r.saleRef, r.returnRef, executionBody("ex-over-e2", r.a2, "1.0001"), "exover2");
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("refund_execution_exceeds_allocation");
    expect(await executionsOf(r.returnRef)).toBe(1);
  });

  it("two concurrent executions cannot over-settle one allocation", async () => {
    if (skip()) return;
    const r = await allocatedReturn("conc");
    const results = await Promise.all(
      [0, 1].map((i) =>
        postExecution(h, r.saleRef, r.returnRef, executionBody(`ex-conc-e${i}`, r.a1, "4.0000"), `exconc${i}`),
      ),
    );
    expect(results.map((x) => x.status).sort()).toEqual([201, 422]);
    expect(await executionsOf(r.returnRef)).toBe(1);
  });

  it("an unknown return, a malformed returnRef and another store's sale are the same 404", async () => {
    if (skip()) return;
    const r = await allocatedReturn("404");
    const body = executionBody("ex-404-e1", r.a1, "6.0000");
    const unknown = await postExecution(h, r.saleRef, uuidFor("no-return"), body, "ex4041");
    const malformed = await postExecution(h, r.saleRef, "not-a-uuid", body, "ex4042");
    h.harness!.contextGuard.storeId = STORE_A_Y;
    const otherStore = await postExecution(h, r.saleRef, r.returnRef, body, "ex4043");
    for (const res of [unknown, malformed, otherStore]) {
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("not_found");
    }
    expect(await executionsOf(r.returnRef)).toBe(0);
  });
});

describe("RT-787 R-7 — settle before post", () => {
  it("a deferred return is emitted exactly once, by the settling execution, even after the flag is off", async () => {
    if (skip()) return;
    setSettleBeforePost(true);
    const r = await allocatedReturn("settle");
    expect(await postingEventsFor(h, r.returnRef)).toBe(0);
    await postExecution(h, r.saleRef, r.returnRef, executionBody("ex-settle-e1", r.a1, "6.0000"), "exsettle1");
    expect(await postingEventsFor(h, r.returnRef)).toBe(0);
    setSettleBeforePost(false);
    const last = executionBody("ex-settle-e2", r.a2, "4.0000");
    expect((await postExecution(h, r.saleRef, r.returnRef, last, "exsettle2")).status).toBe(201);
    expect(await postingEventsFor(h, r.returnRef)).toBe(1);
    // A replay of the settling execution emits nothing more.
    expect((await postExecution(h, r.saleRef, r.returnRef, last, "exsettle3")).status).toBe(200);
    expect(await postingEventsFor(h, r.returnRef)).toBe(1);
  });

  it("two concurrent final executions of a deferred return: one posting, one settling row", async () => {
    if (skip()) return;
    setSettleBeforePost(true);
    const r = await allocatedReturn("race");
    const results = await Promise.all([
      postExecution(h, r.saleRef, r.returnRef, executionBody("ex-race-e1", r.a1, "6.0000"), "exrace1"),
      postExecution(h, r.saleRef, r.returnRef, executionBody("ex-race-e2", r.a2, "4.0000"), "exrace2"),
    ]);
    expect(results.map((x) => x.status)).toEqual([201, 201]);
    expect(await postingEventsFor(h, r.returnRef)).toBe(1);
    const settling = await h.harness!.env.admin.query(
      "SELECT 1 FROM refund_executions WHERE return_id = $1 AND settles_return",
      [r.returnRef],
    );
    expect(settling.rowCount).toBe(1);
  });

  it("a return emitted at acceptance is never emitted again by its executions", async () => {
    if (skip()) return;
    const r = await allocatedReturn("early");
    expect(await postingEventsFor(h, r.returnRef)).toBe(1);
    setSettleBeforePost(true);
    await postExecution(h, r.saleRef, r.returnRef, executionBody("ex-early-e1", r.a1, "6.0000"), "exearly1");
    await postExecution(h, r.saleRef, r.returnRef, executionBody("ex-early-e2", r.a2, "4.0000"), "exearly2");
    expect(await postingEventsFor(h, r.returnRef)).toBe(1);
  });
});
