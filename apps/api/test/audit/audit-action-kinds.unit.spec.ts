/**
 * RT-567 / RT-687 — action-kind registry and the LIKE escape (unit).
 */
import {
  AUDIT_ACTION_KINDS,
  READ_ACTION_CODES,
  kindOf,
} from "../../src/audit/audit-action-kinds";
import { escapeLike } from "../../src/audit/audit.repository";

describe("kindOf", () => {
  it("classifies registered read codes as read", () => {
    expect(kindOf("shift_closes.listed")).toBe("read");
    expect(kindOf("erpnext.postings.pulled")).toBe("read");
    expect(kindOf("pos_sales.detail_read")).toBe("read");
  });

  it("classifies known change codes as change", () => {
    expect(kindOf("sale.voided")).toBe("change");
    expect(kindOf("auth.signin.failed")).toBe("change");
    expect(kindOf("context.switch.store")).toBe("change");
  });

  it("defaults an unregistered code to change (D-2), even one that looks like a read", () => {
    expect(kindOf("zz.unregistered.code")).toBe("change");
    expect(kindOf("something.listed")).toBe("change");
    expect(kindOf("")).toBe("change");
  });

  it("is an exact match, not a prefix match", () => {
    expect(kindOf("shift_closes.listed.extra")).toBe("change");
    expect(kindOf("shift_closes.")).toBe("change");
  });

  it("returns only declared kinds for every registered code", () => {
    for (const code of READ_ACTION_CODES) {
      expect(AUDIT_ACTION_KINDS).toContain(kindOf(code));
      expect(kindOf(code)).toBe("read");
    }
  });
});

describe("escapeLike", () => {
  it("leaves a plain action prefix unchanged", () => {
    expect(escapeLike("auth.signin.")).toBe("auth.signin.");
  });

  it("escapes %, _ and backslash", () => {
    expect(escapeLike("%")).toBe("\\%");
    expect(escapeLike("auth_%")).toBe("auth\\_\\%");
    expect(escapeLike("a\\b")).toBe("a\\\\b");
  });
});
