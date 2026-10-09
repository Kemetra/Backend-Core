/**
 * RT-332 — OutcomeAckBodySchema: the `reconciliation_required` outcome and the
 * optional `resolutionVersion` echo (012 posting-feed 1.6.0-draft). Docker-free.
 */
import { OutcomeAckBodySchema } from "../../../../src/catalog/erpnext-posting/dto/outcome-ack.dto";

const DOC = { doctype: "Sales Invoice", name: "ACC-SINV-1" };
const REASON = { category: "validation", message: "existing invoice item differs" };

describe("OutcomeAckBodySchema — RT-332", () => {
  it("accepts reconciliation_required with the existing documentRef and a reason", () => {
    const r = OutcomeAckBodySchema.safeParse({
      outcome: "reconciliation_required",
      documentRef: DOC,
      reason: REASON,
    });
    expect(r.success).toBe(true);
  });

  it("rejects reconciliation_required without documentRef", () => {
    const r = OutcomeAckBodySchema.safeParse({ outcome: "reconciliation_required", reason: REASON });
    expect(r.success).toBe(false);
  });

  it("rejects reconciliation_required without reason", () => {
    const r = OutcomeAckBodySchema.safeParse({ outcome: "reconciliation_required", documentRef: DOC });
    expect(r.success).toBe(false);
  });

  it("accepts a positive integer resolutionVersion on posted", () => {
    const r = OutcomeAckBodySchema.safeParse({ outcome: "posted", documentRef: DOC, resolutionVersion: 3 });
    expect(r.success).toBe(true);
  });

  it.each([0, -1, 1.5, "2"])("rejects resolutionVersion %p", (v) => {
    const r = OutcomeAckBodySchema.safeParse({ outcome: "posted", documentRef: DOC, resolutionVersion: v });
    expect(r.success).toBe(false);
  });
});
