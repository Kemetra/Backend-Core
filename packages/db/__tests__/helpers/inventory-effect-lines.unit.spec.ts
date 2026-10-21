/**
 * RT-427 — pure effect-line rules (owner decision 2) and DC-1 provenance keys.
 */
import {
  decideEffectLine,
  returnLineEffectKey,
  saleLineEffectKey,
  voidEffectKey,
  type EffectLineFacts,
} from "../../src/helpers/inventory-effects/effect-lines";

const LINE: EffectLineFacts = {
  tenantProductRef: "0a000000-0000-7000-8000-000000000001",
  quantity: "2.000000",
  unit: "ea",
  trackingMode: "none",
  establishedUnit: null,
};

describe("decideEffectLine", () => {
  it.each<[string, Partial<EffectLineFacts>]>([
    ["a product line with no established unit", {}],
    ["a line in the established unit", { establishedUnit: "ea" }],
    ["four significant decimals", { quantity: "1.234500" }],
    ["an integer text", { quantity: "3" }],
  ])("writes %s", (_label, over) => {
    expect(decideEffectLine({ ...LINE, ...over })).toEqual({ kind: "write" });
  });

  it.each<[string, Partial<EffectLineFacts>]>([
    ["a line with no product", { tenantProductRef: null, trackingMode: null }],
    ["a zero quantity", { quantity: "0.000000" }],
    ["a bare zero", { quantity: "0" }],
  ])("ignores %s", (_label, over) => {
    expect(decideEffectLine({ ...LINE, ...over })).toEqual({ kind: "ignore" });
  });

  it.each<[string, Partial<EffectLineFacts>, string]>([
    ["a batch-tracked product", { trackingMode: "batch" }, "tracked_product"],
    ["a serial-tracked product", { trackingMode: "serial" }, "tracked_product"],
    ["five significant decimals", { quantity: "1.234560" }, "quantity_precision"],
    ["six significant decimals", { quantity: "0.000001" }, "quantity_precision"],
    ["another unit than the established one", { establishedUnit: "kg" }, "unit_mismatch"],
  ])("skips %s", (_label, over, reason) => {
    expect(decideEffectLine({ ...LINE, ...over })).toEqual({ kind: "skip", reason });
  });

  it("checks tracking before precision and unit", () => {
    expect(decideEffectLine({ ...LINE, trackingMode: "batch", quantity: "0.000001", establishedUnit: "kg" })).toEqual({
      kind: "skip",
      reason: "tracked_product",
    });
  });
});

describe("DC-1 provenance keys", () => {
  it("are deterministic from the business line", () => {
    expect(saleLineEffectKey("L1")).toBe("sale_line:L1");
    expect(voidEffectKey("V1", "L1")).toBe("void:V1:L1");
    expect(returnLineEffectKey("R1")).toBe("return_line:R1");
  });
});
