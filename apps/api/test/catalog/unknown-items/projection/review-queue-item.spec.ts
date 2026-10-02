/**
 * review-queue-item.spec.ts  (007 — T022 RED / T023 GREEN)
 *
 * `ReviewQueueItem` is the review-surface projection of an `unknown_items`
 * row: the shipped `UnknownItem` wire shape MINUS `sale_context`
 * (FR-007 / 006 FR-021a). `toReviewQueueItem(row, canSeeProduct)` is the single
 * shared projection helper that BOTH catalog controllers import (R7.2) — the
 * list/dismiss path (unknown-items.controller) and the link/create path
 * (reconciliation.controller). It MUST NOT be used for the POS capture
 * response (`toUnknownWireShape`), which keeps `sale_context` for the
 * provenance round-trip (R7.3).
 *
 * FR-001a (data-model §2.2): for a row carrying a product reference,
 * `resolved_product_id` is included ONLY when the caller may see that product
 * (`canSeeProduct === true`); otherwise the KEY IS OMITTED (not null) while the
 * item row itself is still returned. The helper does NOT compute authority —
 * the caller supplies the boolean.
 *
 * Pure projection unit test (no Nest app, no Postgres): input row → output
 * object. Fast, deterministic RED/GREEN.
 */
import "reflect-metadata";

import {
  toReviewQueueItem,
  type ReviewQueueItem,
} from "../../../../src/catalog/unknown-items/dto/review-queue-item.dto";
import type { UnknownItemRow } from "../../../../src/catalog/unknown-items/unknown-items.service";

const ENCOUNTERED = new Date("2026-05-20T08:30:00.000Z");
const RESOLVED = new Date("2026-05-22T14:00:00.000Z");

function pendingRow(overrides: Partial<UnknownItemRow> = {}): UnknownItemRow {
  return {
    id: "0a000000-0000-7000-8000-0000000000a1",
    tenantId: "0a000000-0000-7000-8000-00000000ten1",
    storeId: "0a000000-0000-7000-8000-0000000store1",
    identifierType: "barcode",
    identifierValue: "5012345678900",
    sourceSystem: null,
    resolutionStatus: "pending",
    resolutionAction: null,
    resolvedAt: null,
    resolvedBy: null,
    resolvedProductId: null,
    encounteredAt: ENCOUNTERED,
    saleContext: { register: "POS-3", basket_total: 1299 },
    ...overrides,
  };
}

function resolvedRow(overrides: Partial<UnknownItemRow> = {}): UnknownItemRow {
  return pendingRow({
    resolutionStatus: "resolved",
    resolutionAction: "linked",
    resolvedAt: RESOLVED,
    resolvedBy: "0a000000-0000-7000-8000-00000000actr",
    resolvedProductId: "0a000000-0000-7000-8000-0000000prod1",
    ...overrides,
  });
}

describe("toReviewQueueItem — review-surface projection (007 FR-007 / FR-001a)", () => {
  // RQ1 — sale_context is NEVER present on the projection, in any status (FR-007)
  it("RQ1: omits sale_context entirely (pending row)", () => {
    const item = toReviewQueueItem(pendingRow(), true);
    expect(Object.prototype.hasOwnProperty.call(item, "sale_context")).toBe(
      false,
    );
    expect((item as unknown as Record<string, unknown>)["sale_context"]).toBeUndefined();
  });

  it("RQ1b: omits sale_context entirely (resolved row, caller can see product)", () => {
    const item = toReviewQueueItem(resolvedRow(), true);
    expect(Object.prototype.hasOwnProperty.call(item, "sale_context")).toBe(
      false,
    );
  });

  // RQ2 — the full ReviewQueueItem field set is present and snake_case
  it("RQ2: projects the data-model §2.1 field set in snake_case", () => {
    const item = toReviewQueueItem(resolvedRow(), true);
    expect(item).toEqual<ReviewQueueItem>({
      id: "0a000000-0000-7000-8000-0000000000a1",
      tenant_id: "0a000000-0000-7000-8000-00000000ten1",
      store_id: "0a000000-0000-7000-8000-0000000store1",
      identifier_type: "barcode",
      identifier_value: "5012345678900",
      source_system: null,
      resolution_status: "resolved",
      resolution_action: "linked",
      resolved_at: RESOLVED.toISOString(),
      resolved_by: "0a000000-0000-7000-8000-00000000actr",
      resolved_product_id: "0a000000-0000-7000-8000-0000000prod1",
      encountered_at: ENCOUNTERED.toISOString(),
    });
  });

  // RQ3 — Date fields are serialized to ISO-8601 strings (matches the shipped wire shape)
  it("RQ3: serializes resolved_at and encountered_at as ISO-8601 strings", () => {
    const item = toReviewQueueItem(resolvedRow(), true);
    expect(item.resolved_at).toBe(RESOLVED.toISOString());
    expect(item.encountered_at).toBe(ENCOUNTERED.toISOString());
    // pending row: resolved_at is null, encountered_at still a string
    const pending = toReviewQueueItem(pendingRow(), true);
    expect(pending.resolved_at).toBeNull();
    expect(typeof pending.encountered_at).toBe("string");
  });

  // RQ4 — FR-001a: caller CAN see product → resolved_product_id present
  it("RQ4: includes resolved_product_id when canSeeProduct is true (FR-001a)", () => {
    const item = toReviewQueueItem(resolvedRow(), true);
    expect(Object.prototype.hasOwnProperty.call(item, "resolved_product_id")).toBe(
      true,
    );
    expect(item.resolved_product_id).toBe(
      "0a000000-0000-7000-8000-0000000prod1",
    );
  });

  // RQ5 — FR-001a: caller CANNOT see product → resolved_product_id KEY OMITTED (not null), row still returned
  it("RQ5: omits the resolved_product_id KEY when canSeeProduct is false, row still returned (FR-001a)", () => {
    const item = toReviewQueueItem(resolvedRow(), false);
    // the key is absent — NOT present-and-null
    expect(Object.prototype.hasOwnProperty.call(item, "resolved_product_id")).toBe(
      false,
    );
    // the item itself is still fully projected (existence already established)
    expect(item.id).toBe("0a000000-0000-7000-8000-0000000000a1");
    expect(item.resolution_status).toBe("resolved");
    expect(item.resolved_by).toBe("0a000000-0000-7000-8000-00000000actr");
  });

  // RQ6 — a pending row has no product reference regardless of canSeeProduct;
  // suppression never invents a key, and a null product id is conveyed as null when visible.
  it("RQ6: pending row → resolved_product_id is null (visible) or absent (suppressed), never invented", () => {
    const visible = toReviewQueueItem(pendingRow(), true);
    expect(visible.resolved_product_id).toBeNull();

    const suppressed = toReviewQueueItem(pendingRow(), false);
    expect(
      Object.prototype.hasOwnProperty.call(suppressed, "resolved_product_id"),
    ).toBe(false);
  });
});
