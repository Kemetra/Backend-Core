/**
 * cross-resource.spec.ts — Jira RT-155 AC1 + AC4 (RT-82 K1).
 *
 * The Idempotency-Key is bound to the resolved `:saleRef`. Reusing a key and
 * body from sale A on sale B must NOT replay A's response: B runs through its
 * own handler, whose provenance check answers its own `409 conflict` (the
 * provenance was used for A). A same-sale retry still replays the stored
 * status plus `Idempotent-Replayed: true`.
 *
 * Docker-gated (Testcontainers Postgres, RLS-forced).
 */
import {
  startCaptureHarness,
  stopCaptureHarness,
  resetHarness,
  idempKey,
  refundBody,
  voidBody,
  type HarnessHandle,
} from "../capture/__capture-harness";
import {
  captureOneLine,
  cleanReturnsFixtures,
  disableReturns,
  enableReturns,
  returnBody,
} from "../terminal/__returns-support";

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
  if (!h.harness) return;
  await h.harness.env.admin.query("DELETE FROM sale_refunds WHERE source_system = 'pos-1'");
  await cleanReturnsFixtures(h);
});

const skip = (): boolean => h.dockerSkipped || !h.harness;

type Kind = "void" | "refund" | "returns";

function post(kind: Kind, saleRef: string, key: string, body: Record<string, unknown>) {
  return h.harness!.http().post(`/api/pos/v1/sales/${saleRef}/${kind}`).set("Idempotency-Key", key).send(body);
}

async function rowsFor(kind: Kind, saleRef: string): Promise<number> {
  const table = { void: "sale_voids", refund: "sale_refunds", returns: "sale_returns" }[kind];
  const r = await h.harness!.env.admin.query(`SELECT 1 FROM ${table} WHERE sale_id = $1`, [saleRef]);
  return r.rowCount ?? 0;
}

const CASES: ReadonlyArray<{
  kind: Kind;
  body: (lineRef: string) => Record<string, unknown>;
}> = [
  { kind: "void", body: () => voidBody({ externalId: "rt155-void" }) },
  { kind: "refund", body: () => refundBody({ externalId: "rt155-refund" }) },
  {
    kind: "returns",
    body: (lineRef) => returnBody("rt155-ret", [{ lineRef, quantity: "1" }], "5.0000"),
  },
];

describe.each(CASES)("RT-155 — $kind keyed per saleRef", ({ kind, body }) => {
  it("AC1: same key + same body on another sale runs B's handler (no replay of A)", async () => {
    if (skip()) return;
    const a = await captureOneLine(h, { externalId: `rt155-${kind}-a`, quantity: "1", lineAmount: "5.0000" });
    const b = await captureOneLine(h, { externalId: `rt155-${kind}-b`, quantity: "1", lineAmount: "5.0000" });
    const key = idempKey(`rt155x${kind}`);
    const payload = body(a.lineRef);

    const first = await post(kind, a.saleRef, key, payload);
    expect(first.status).toBe(201);

    const onB = await post(kind, b.saleRef, key, payload);
    // B's own handler answered: its provenance check, not an interceptor replay
    // of A and not the interceptor's key conflict.
    expect(onB.status).toBe(409);
    expect(onB.body.error.code).toBe("conflict");
    expect(onB.headers["idempotent-replayed"]).toBeUndefined();
    expect(await rowsFor(kind, b.saleRef)).toBe(0);
  });

  it("AC4: a same-sale retry with the same key replays the stored status + header", async () => {
    if (skip()) return;
    const a = await captureOneLine(h, { externalId: `rt155-${kind}-r`, quantity: "1", lineAmount: "5.0000" });
    const key = idempKey(`rt155r${kind}`);
    const payload = body(a.lineRef);

    const first = await post(kind, a.saleRef, key, payload);
    expect(first.status).toBe(201);
    const retry = await post(kind, a.saleRef, key, payload);
    expect(retry.status).toBe(201);
    expect(retry.headers["idempotent-replayed"]).toBe("true");
    expect(retry.body).toEqual(first.body);
    expect(await rowsFor(kind, a.saleRef)).toBe(1);
  });
});
