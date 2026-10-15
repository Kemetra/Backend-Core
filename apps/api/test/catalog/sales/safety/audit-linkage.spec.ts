/**
 * audit-linkage.spec.ts — 008 US6 T072.
 *
 * Capture → void → refund each emit ONE canonical audit event through the
 * shipped AuditEmitterInterceptor (FR-090/092, SC-009): actor, tenant, store,
 * action, target (nullable), correlation id (request_id). The metadata field is
 * NULL — no raw payload / secret is ever carried in the audit record (FR-042 /
 * §XIV PII discipline). The audit path is insert-only (the enqueuer only ever
 * appends).
 *
 * NOTE: this proves the decorator + AuditEmitterInterceptor emit correctly when
 * wired (opt-in via the harness here); live production emission depends on
 * T232/T233 mounting the interceptor into main.ts.
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
  approvedVoid,
  type HarnessHandle,
} from "../capture/__capture-harness";
import { APPROVAL_ID, APPROVER_MANAGER } from "../__support__/void-approval-fixture";
import type { AuditJobEnqueuer } from "../../../../src/audit/audit-job.enqueuer";
import type { AuditJobPayload } from "../../../../src/audit/audit-job.types";

class SpyAuditEnqueuer implements AuditJobEnqueuer {
  public calls: AuditJobPayload[] = [];
  async enqueue(payload: AuditJobPayload): Promise<void> {
    // Push MUST stay before any `await` — the interceptor's tap.next invokes
    // emitAsync without awaiting, so the assertions read `calls` synchronously.
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
      "DELETE FROM sale_refunds WHERE source_system = 'pos-1'",
    );
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

describe("T072 — audit linkage across capture / void / refund", () => {
  it("each transition emits one canonical audit event, no raw payload in metadata", async () => {
    if (h.dockerSkipped || !h.harness) return;

    const cap = await h.harness
      .http()
      .post("/api/pos/v1/sales")
      .set("Idempotency-Key", idempKey("aud-cap"))
      .send(captureBody({ externalId: "ext-audit" }));
    expect(cap.status).toBe(201);
    const saleRef = cap.body.saleRef;

    const voided = await h.harness
      .http()
      .post(`/api/pos/v1/sales/${saleRef}/void`)
      .set("Idempotency-Key", idempKey("aud-void"))
      .send(await approvedVoid(h, saleRef, { body: { externalId: "audit-void" } }));
    expect(voided.status).toBe(201);

    const refunded = await h.harness
      .http()
      .post(`/api/pos/v1/sales/${saleRef}/refund`)
      .set("Idempotency-Key", idempKey("aud-ref"))
      .send({
        sourceSystem: "pos-1",
        externalId: "audit-refund",
        posRefundAmount: "1.0000",
        currencyCode: "USD",
      });
    expect(refunded.status).toBe(201);

    // Exactly one event per successful transition, in order.
    expect(spy.calls.map((c) => c.action)).toEqual([
      "sale.captured",
      "sale.voided",
      "sale.refunded",
    ]);

    // The correlation id on each event equals the X-Request-Id echoed on that
    // transition's response — a real per-request correlation, not just non-empty.
    const reqIds = [cap, voided, refunded].map(
      (r) => r.headers["x-request-id"],
    );
    spy.calls.forEach((evt, i) => {
      expect(evt.request_id).toEqual(expect.any(String));
      expect(evt.request_id).toBe(reqIds[i]);
    });

    // RT-530: ONLY the void event names its approval (ids and a policy label).
    const voidEvt = spy.calls.find((c) => c.action === "sale.voided");
    expect(voidEvt?.metadata).toEqual({
      approver_user_id: APPROVER_MANAGER,
      requester_user_id: DEVICE_USER_ID,
      approval_id: APPROVAL_ID,
      policy_version: "rt114-2026-10-07",
    });
    for (const evt of spy.calls.filter((c) => c.action !== "sale.voided")) {
      expect(evt.metadata).toBeNull();
    }

    for (const evt of spy.calls) {
      // Actor + scope are resolved from the principal/context, never the body.
      expect(evt.actor_user_id).toBe(DEVICE_USER_ID);
      expect(evt.tenant_id).toBe(TENANT_A);
      expect(evt.store_id).toBe(STORE_A_X);
      expect(evt.target_type).toBeNull();
      expect(evt.target_id).toBeNull();
      // No raw payload / secret travels in the audit record (FR-042/090/092,
      // §XIV): metadata is null AND no body-derived value appears anywhere in
      // the serialized event.
      const json = JSON.stringify(evt);
      expect(json).not.toContain("ext-audit"); // externalId
      expect(json).not.toContain("12.5000"); // posTotal
      expect(json).not.toContain("pos-1"); // sourceSystem
    }
  });
});
