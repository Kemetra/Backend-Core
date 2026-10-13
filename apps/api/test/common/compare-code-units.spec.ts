import { compareCodeUnits } from "../../src/common/compare-code-units";

describe("compareCodeUnits", () => {
  const keys = ["b", "B", "a", "é", "_", "10", "9"];

  it("orders exactly like the default Array#sort", () => {
    expect([...keys].sort(compareCodeUnits)).toEqual([...keys].sort());
  });

  it("orders by UTF-16 code unit, not locale", () => {
    expect([...keys].sort(compareCodeUnits)).toEqual(["10", "9", "B", "_", "a", "b", "é"]);
  });

  it("returns 0 for equal strings and a signed result otherwise", () => {
    expect(compareCodeUnits("a", "a")).toBe(0);
    expect(compareCodeUnits("B", "a")).toBe(-1);
    expect(compareCodeUnits("a", "B")).toBe(1);
  });

  it("orders by UTF-16 code unit, not code point (surrogate pairs)", () => {
    // U+1F600 is stored as 😀; 0xD83D < 0xFFFF, so it sorts first.
    const sorted = ["￿", "\u{1F600}"].sort(compareCodeUnits);
    expect(sorted).toEqual(["\u{1F600}", "￿"]);
    expect(sorted).toEqual(["￿", "\u{1F600}"].sort());
  });
});
