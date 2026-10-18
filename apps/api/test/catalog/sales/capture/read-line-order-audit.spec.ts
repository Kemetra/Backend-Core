/**
 * read-line-order-audit.spec.ts — RT-689 (RT-547 + RT-548).
 *
 * RT-547 (plan §1.3): `readSaleProjection` lists lines by
 * `line_seq NULLS LAST, line_name, id`. A sale captured with a recorded order
 * returns it on all three paths that share the projection (`readSale`, the
 * `captureSale` 201 and the provenance-dedup replay). A legacy sale (every
 * `line_seq` NULL) falls back to name, then `lineRef`, deterministically —
 * including two lines with the same name.
 *
 * RT-548 (plan §2.2): `readSale` emits one `pos_sales.detail_read` per
 * authorized 200 with metadata exactly `{ sale_ref }`; none on 404/401, and
 * none on `captureSale` (which reuses the projection, not the route).
 */
import {
  startCaptureHarness,
  stopCaptureHarness,
  resetHarness,
  captureBody,
  idempKey,
  DEVICE_USER_ID,
  TENANT_A,
  STORE_A_X,
  STORE_A_Y,
  type HarnessHandle,
} from "./__capture-harness";
import type { AuditJobEnqueuer } from "../../../../src/audit/audit-job.enqueuer";
import type { AuditJobPayload } from "../../../../src/audit/audit-job.types";

class SpyAuditEnqueuer implements AuditJobEnqueuer {
  public calls: AuditJobPayload[] = [];
  async enqueue(payload: AuditJobPayload): Promise<void> {
    // Push before any `await`: the interceptor fires emitAsync without awaiting.
    this.calls.push(payload);
  }
  reset(): void {
    this.calls = [];
  }
}

const spy = new SpyAuditEnqueuer();
const h: HarnessHandle = { harness: null, dockerSkipped: false };

beforeAll(async () => {
  Object.assign(h, await startCaptureHarness({ auditEnqueuer: spy }));
}, 180_000);
afterAll(async () => {
  await stopCaptureHarness(h);
}, 60_000);
beforeEach(() => {
  resetHarness(h);
  spy.reset();
});
afterEach(async () => {
  if (h.harness) {
    await h.harness.env.admin.query(
      "DELETE FROM sale_lines WHERE sale_id IN (SELECT id FROM sales WHERE source_system = 'pos-1')",
    );
    await h.harness.env.admin.query("DELETE FROM sales WHERE source_system = 'pos-1'");
  }
});

function line(lineName: string, amount: string): Record<string, unknown> {
  return { lineName, unitPrice: amount, currencyCode: "USD", quantity: "1", lineAmount: amount, unit: "ea" };
}

type WireLine = { lineRef: string; lineName: string; lineAmount: string };
const names = (lines: WireLine[]): string[] => lines.map((l) => l.lineName);

/** Capture `body` with a fresh Idempotency-Key (a provenance re-delivery on repeat). */
async function capture(body: Record<string, unknown>, key: string) {
  return h.harness!.http().post("/api/pos/v1/sales").set("Idempotency-Key", idempKey(key)).send(body);
}

describe("RT-547 — readSale line order", () => {
  it("returns capture order on readSale, the 201 and the replay when line_seq is recorded", async () => {
    if (h.dockerSkipped || !h.harness) return;
    const body = captureBody({
      externalId: "ext-order-recorded",
      posTotal: "6.0000",
      lines: [line("Zeta", "1.0000"), line("Alpha", "2.0000"), line("Mid", "3.0000")],
    });

    const created = await capture(body, "ordrec1");
    expect(created.status).toBe(201);
    expect(names(created.body.lines)).toEqual(["Zeta", "Alpha", "Mid"]);

    const read = await h.harness.http().get(`/api/pos/v1/sales/${created.body.saleRef}`);
    expect(read.status).toBe(200);
    expect(names(read.body.lines)).toEqual(["Zeta", "Alpha", "Mid"]);

    // Provenance dedup-hit under a different key: re-projected, not cached.
    const replay = await capture(body, "ordrec2");
    expect(replay.status).toBe(200);
    expect(replay.headers["idempotent-replayed"]).toBe("true");
    expect(replay.body).toEqual(created.body);
  });

  it("orders a legacy sale (no line_seq) by name, then lineRef — duplicates included, deterministically", async () => {
    if (h.dockerSkipped || !h.harness) return;
    const body = captureBody({
      externalId: "ext-order-legacy",
      posTotal: "10.0000",
      lines: [line("Mid", "1.0000"), line("Alpha", "2.0000"), line("Zeta", "3.0000"), line("Alpha", "4.0000")],
    });
    const created = await capture(body, "ordleg1");
    expect(created.status).toBe(201);
    const saleRef: string = created.body.saleRef;

    // Simulate a pre-0047 (RT-538) sale: the order was never recorded.
    await h.harness.env.admin.query("UPDATE sale_lines SET line_seq = NULL WHERE sale_id = $1", [saleRef]);

    const read = await h.harness.http().get(`/api/pos/v1/sales/${saleRef}`);
    expect(read.status).toBe(200);
    const lines = read.body.lines as WireLine[];
    const expected = [...lines].sort((a, b) =>
      a.lineName === b.lineName ? (a.lineRef < b.lineRef ? -1 : 1) : a.lineName < b.lineName ? -1 : 1,
    );
    expect(lines).toEqual(expected);
    expect(names(lines)).toEqual(["Alpha", "Alpha", "Mid", "Zeta"]);

    // Deterministic: a second read and a replay return an identical body.
    const again = await h.harness.http().get(`/api/pos/v1/sales/${saleRef}`);
    expect(again.body).toEqual(read.body);
    const replay = await capture(body, "ordleg2");
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(read.body);
  });
});

describe("RT-548 — readSale emits pos_sales.detail_read", () => {
  it("emits one event per authorized 200 with metadata exactly { sale_ref }, and none on capture", async () => {
    if (h.dockerSkipped || !h.harness) return;
    const created = await capture(captureBody({ externalId: "ext-read-audit" }), "rdaud1");
    expect(created.status).toBe(201);
    const saleRef: string = created.body.saleRef;
    // captureSale reuses the projection but is not the audited read.
    expect(spy.calls.map((c) => c.action)).toEqual(["sale.captured"]);
    spy.reset();

    const read = await h.harness.http().get(`/api/pos/v1/sales/${saleRef}`);
    expect(read.status).toBe(200);
    expect(spy.calls).toHaveLength(1);
    const evt = spy.calls[0]!;
    expect(evt.action).toBe("pos_sales.detail_read");
    expect(evt.actor_user_id).toBe(DEVICE_USER_ID);
    expect(evt.tenant_id).toBe(TENANT_A);
    expect(evt.store_id).toBe(STORE_A_X);
    expect(evt.target_type).toBeNull();
    expect(evt.target_id).toBeNull();
    expect(evt.request_id).toBe(read.headers["x-request-id"]);
    // Identifiers only (FR-AUDIT-3, §XIV): no line, amount or tender content.
    expect(Object.keys(evt.metadata ?? {})).toEqual(["sale_ref"]);
    expect(evt.metadata).toEqual({ sale_ref: saleRef });
    const json = JSON.stringify(evt);
    for (const leak of ["Widget", "Gadget", "12.5000", "ext-read-audit", "pos-1"]) {
      expect(json).not.toContain(leak);
    }
  });

  it("emits nothing on a non-disclosing 404 (cross-store, absent, malformed) or a 401", async () => {
    if (h.dockerSkipped || !h.harness) return;
    const created = await capture(captureBody({ externalId: "ext-read-audit-neg" }), "rdaud2");
    expect(created.status).toBe(201);
    const saleRef: string = created.body.saleRef;
    spy.reset();

    h.harness.contextGuard.storeId = STORE_A_Y;
    expect((await h.harness.http().get(`/api/pos/v1/sales/${saleRef}`)).status).toBe(404);
    h.harness.contextGuard.storeId = STORE_A_X;
    expect(
      (await h.harness.http().get("/api/pos/v1/sales/0d000000-0000-7000-8000-00000000dead")).status,
    ).toBe(404);
    expect((await h.harness.http().get("/api/pos/v1/sales/not-a-uuid")).status).toBe(404);

    h.harness.contextGuard.anonymous = true;
    expect((await h.harness.http().get(`/api/pos/v1/sales/${saleRef}`)).status).toBe(401);

    expect(spy.calls).toEqual([]);
  });
});
