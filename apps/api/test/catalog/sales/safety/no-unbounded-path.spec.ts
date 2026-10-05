/**
 * T091 — no-unbounded-batch-path guard (008 WIRING slice).
 *
 * FR-080 / SI-011 mandate: "no path MUST offer an unbounded batch that
 * circumvents the inherited [001/004] rate-limit posture or starves other
 * tenants" — the posture's *existence* is the mandate. The gate-D.2 decision
 * sets an **offline-recovery batch ceiling of 500 sale events/request**, but
 * that numeric ceiling BINDS ONLY WHEN A BULK PATH SHIPS. No bulk/batch path
 * exists today (only single-sale capture + single terminal events), so the
 * correct guard for THIS slice is: assert the sales surface exposes ONLY
 * single-sale routes and rejects an array-shaped (multi-sale) body. The 500/req
 * ceiling is documented here as binding-when-bulk-ships; implementing it is a
 * separate [GATED] OpenAPI decision and is explicitly NOT done here.
 *
 * Pure unit-level: reads the capture DTO schema + the controller source. No
 * HTTP server, no Redis, no Postgres — Docker-free.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { CaptureSaleRequestSchema } from "../../../../src/catalog/sales/dto/capture-sale-request.dto";

/**
 * The 500-event/request bulk-sync ceiling (gate D.2 / OQ-6). BINDING ONLY WHEN
 * a bulk/offline-recovery batch endpoint ships. No such endpoint exists today;
 * this constant documents the ceiling a future bulk slice must enforce.
 */
const BULK_SYNC_CEILING_BINDING_WHEN_BULK_SHIPS = 500;

describe("T091: capture body is single-sale — rejects an unbounded array (FR-080/SI-011)", () => {
  const singleValidBody = {
    sourceSystem: "pos-x",
    externalId: "ext-1",
    currencyCode: "USD",
    posTotal: "100.00",
    occurredAt: "2026-05-31T00:00:00.000Z",
    lines: [
      {
        lineName: "Item",
        unitPrice: "100.00",
        currencyCode: "USD",
        quantity: "1",
        lineAmount: "100.00",
        unit: "ea",
      },
    ],
  };

  it("accepts a single sale object", () => {
    expect(CaptureSaleRequestSchema.safeParse(singleValidBody).success).toBe(true);
  });

  it("REJECTS a top-level array of sales (no unbounded multi-sale batch body)", () => {
    const batch = [singleValidBody, singleValidBody, singleValidBody];
    expect(CaptureSaleRequestSchema.safeParse(batch).success).toBe(false);
  });

  it("REJECTS a wrapper carrying a `sales` array (no batch envelope)", () => {
    const envelope = { sales: [singleValidBody, singleValidBody] };
    // `.strict()` rejects the unknown `sales` key; even a permissive parse must
    // not silently accept a batch shape.
    expect(CaptureSaleRequestSchema.safeParse(envelope).success).toBe(false);
  });

  it("the only array in the contract is intra-sale `lines` (line items of ONE sale)", () => {
    // `lines` is bounded to a single sale's line items, NOT a batch of sales.
    // This pins that the array dimension is per-sale, so adding a multi-sale
    // path would require a NEW shape (and a [GATED] contract change), which
    // this assertion would force a reviewer to notice.
    // Public key-introspection API (`.keyof().options`), not the brittle
    // internal `._def.shape()`. RT-225: the schema is the strict object plus a
    // cross-field refinement, so introspect its inner object.
    const keys = CaptureSaleRequestSchema.innerType().keyof().options;
    expect(keys).toContain("lines");
    expect(keys).not.toContain("sales");
  });
});

describe("T091: sales controller exposes ONLY single-resource routes (no bulk endpoint)", () => {
  const controllerSrc = readFileSync(
    join(__dirname, "..", "..", "..", "..", "src", "catalog", "sales", "sales.controller.ts"),
    "utf8",
  );

  it("has no route decorator naming a bulk / batch / import path", () => {
    // Any @Post/@Get/@Put route literal that names a batch surface is a
    // bulk path. The current surface is: POST /sales, GET /sales/:saleRef,
    // POST /sales/:saleRef/void, POST /sales/:saleRef/refund — all single.
    const routeLiterals = [...controllerSrc.matchAll(/@(?:Post|Get|Put|Patch|Delete)\(\s*["'`]([^"'`]+)["'`]/g)]
      .map((m) => m[1]!.toLowerCase());

    expect(routeLiterals.length).toBeGreaterThan(0);
    for (const route of routeLiterals) {
      expect(route).not.toMatch(/bulk|batch|import|\bsync\b|\/sales\/all/);
    }
  });

  it("every capture / terminal route is keyed on a single saleRef or the singular collection", () => {
    const routeLiterals = [...controllerSrc.matchAll(/@(?:Post|Get|Put|Patch|Delete)\(\s*["'`]([^"'`]+)["'`]/g)]
      .map((m) => m[1]!);
    // POST collection route is the singular "api/pos/v1/sales" (one sale per
    // request); all others carry the :saleRef path param. None is a fan-in.
    for (const route of routeLiterals) {
      const isSingularCollection = route === "api/pos/v1/sales";
      const isSingleResource = route.includes(":saleRef");
      expect(isSingularCollection || isSingleResource).toBe(true);
    }
  });
});

describe("T091: bulk-sync ceiling is documented as binding-when-bulk-ships", () => {
  it("records the gate-D.2 500-event/request ceiling for a future bulk slice", () => {
    // Self-documenting pin: when a bulk/offline-recovery endpoint ships, it
    // MUST enforce this ceiling (FR-080 / SI-011 / OQ-6). It is NOT enforced
    // here because no bulk path exists — implementing one is a [GATED] decision.
    expect(BULK_SYNC_CEILING_BINDING_WHEN_BULK_SHIPS).toBe(500);
  });
});
