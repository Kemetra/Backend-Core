/**
 * RT-567 / RT-687 — action-kind registry and the LIKE escape (unit).
 */
import { READ_ACTION_CODES, kindOf } from "../../src/audit/audit-action-kinds";
import { escapeLike } from "../../src/audit/audit.repository";

describe("kindOf", () => {
  it.each([
    // Registered reads, including a machine pull and the RT-689 POS readSale.
    ["shift_closes.listed", "read"],
    ["erpnext.postings.pulled", "read"],
    ["pos_sales.detail_read", "read"],
    // Known changes.
    ["sale.voided", "change"],
    ["auth.signin.failed", "change"],
    ["context.switch.store", "change"],
    // Unregistered codes default to change (D-2), even ones that look like reads.
    ["zz.unregistered.code", "change"],
    ["something.listed", "change"],
    ["", "change"],
    // Exact match, not a prefix match.
    ["shift_closes.listed.extra", "change"],
    ["shift_closes.", "change"],
  ])("kindOf(%j) is %s", (action, kind) => {
    expect(kindOf(action)).toBe(kind);
  });

  it("classifies every registered code as read", () => {
    expect(READ_ACTION_CODES.filter((code) => kindOf(code) !== "read")).toEqual([]);
  });
});

describe("escapeLike", () => {
  it.each([
    ["auth.signin.", "auth.signin."],
    ["%", "\\%"],
    ["auth_%", "auth\\_\\%"],
    ["a\\b", "a\\\\b"],
  ])("escapeLike(%j) is %j", (value, escaped) => {
    expect(escapeLike(value)).toBe(escaped);
  });
});
