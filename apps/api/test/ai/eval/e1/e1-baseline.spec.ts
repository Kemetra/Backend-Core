/**
 * RT-648 — the deterministic rule-table baseline `E1-BL v1` (RT-647 §5).
 *
 * Agreement with the gold labels is a CONSISTENCY check: the labels were
 * transcribed from the same RT-647 rule table the baseline implements, so a
 * pass here is not quality evidence (RT-647 §3 independence rule).
 */
import { explain } from "./e1.baseline";
import { E1_CASES, materialize } from "./e1.cases";
import { E1_OUT_SCHEMA } from "./e1.out-schema";
import { hasBidiControl } from "./e1.hostile";
import { matchesActionRequest, matchesHealthQuestion } from "./e1.question";
import { renderText } from "./e1.text";
import type { E1Case, E1Pack, E1Read, Lang } from "./e1.types";

const LANGS: readonly Lang[] = ["en", "ar"];
const byId = (id: string): E1Case => {
  const found = E1_CASES.find((c) => c.id === id);
  if (!found) throw new Error(`unknown case ${id}`);
  return found;
};

function patchRead(pack: E1Pack, op: E1Read["op"], patch: Partial<E1Read>): E1Pack {
  return { ...pack, reads: pack.reads.map((read) => (read.op === op ? { ...read, ...patch } : read)) };
}

describe("E1-BL v1 against the transcribed gold labels (consistency check)", () => {
  for (const c of E1_CASES) {
    for (const lang of LANGS) {
      it(`${c.id} (${lang}) matches its gold label`, () => {
        const out = explain(materialize(c, lang).pack);
        const rules =
          out.class.startsWith("abstain")
            ? out.tracks.processing.rule_id
            : [out.tracks.processing.rule_id, out.tracks.erp_sale.rule_id, out.tracks.erp_reversal.rule_id].join("/");
        expect({
          class: out.class,
          processing: out.tracks.processing.state,
          erp_sale: out.tracks.erp_sale.state,
          erp_reversal: out.tracks.erp_reversal.state,
          backlog_class: out.tracks.erp_sale.backlog_class,
          boundary: out.first_failing_boundary,
          open_unknowns: [...out.open_unknowns],
          runbooks: [...out.runbook_refs],
          rules,
          templates: out.claims.map((claim) => claim.template_id),
        }).toEqual({
          class: c.gold.class,
          processing: c.gold.processing,
          erp_sale: c.gold.erp_sale,
          erp_reversal: c.gold.erp_reversal,
          backlog_class: c.gold.backlog_class,
          boundary: c.gold.boundary,
          open_unknowns: [...c.gold.open_unknowns],
          runbooks: [...c.gold.runbooks],
          rules: c.gold.rules,
          templates: [...c.gold.templates],
        });
      });
    }
  }
});

describe("E1-BL v1 properties", () => {
  it("is a pure function: same pack, same output, whatever the clock says", () => {
    const { pack } = materialize(byId("E1-C09"), "en");
    const frozen = JSON.stringify(pack);
    jest.useFakeTimers();
    try {
      jest.setSystemTime(new Date("2031-01-01T00:00:00Z"));
      const first = explain(pack);
      jest.setSystemTime(new Date("2044-06-06T06:06:06Z"));
      expect(explain(pack)).toEqual(first);
    } finally {
      jest.useRealTimers();
    }
    expect(JSON.stringify(pack)).toBe(frozen);
  });

  it("gives the same labels for the EN and AR question of every case", () => {
    for (const c of E1_CASES) {
      const en = explain(materialize(c, "en").pack);
      const ar = explain(materialize(c, "ar").pack);
      expect({ ...ar, pack_id: en.pack_id }).toEqual(en);
    }
  });

  it("produces output that validates against the strict E1-OUT schema", () => {
    for (const c of E1_CASES) {
      for (const lang of LANGS) {
        expect(E1_OUT_SCHEMA.safeParse(explain(materialize(c, lang).pack)).success).toBe(true);
      }
    }
  });

  it("rejects unknown top-level and nested fields and unknown templates", () => {
    const out = explain(materialize(byId("E1-C09"), "en").pack);
    expect(E1_OUT_SCHEMA.safeParse({ ...out, tool_calls: [] }).success).toBe(false);
    expect(E1_OUT_SCHEMA.safeParse({ ...out, tracks: { ...out.tracks, processing: { ...out.tracks.processing, extra: 1 } } }).success).toBe(false);
    const [claim] = out.claims;
    expect(E1_OUT_SCHEMA.safeParse({ ...out, claims: [{ ...claim, extra: 1 }] }).success).toBe(false);
    expect(E1_OUT_SCHEMA.safeParse({ ...out, claims: [{ ...claim, template_id: "Z9" }] }).success).toBe(false);
    expect(E1_OUT_SCHEMA.safeParse({ ...out, claims: [{ ...claim, evidence_refs: [] }] }).success).toBe(false);
  });

  it("states a posting only for a posted track and never says healthy", () => {
    for (const c of E1_CASES) {
      const { pack } = materialize(c, "en");
      const out = explain(pack);
      const text = renderText(out, pack);
      if (out.tracks.erp_sale.state !== "posted") expect(text).not.toContain("Posted to ERPNext");
      expect(text.toLowerCase()).not.toMatch(/healthy|all good|up to date|reconciled|resolved in erp/);
    }
  });

  it("renders instants in the store timezone and quotes the business date verbatim", () => {
    const { pack } = materialize(byId("E1-C40"), "en");
    const text = renderText(explain(pack), pack);
    expect(text).toContain("business date 2026-10-17");
    expect(text).toContain("2026-10-17 01:30:00");
  });

  it("never echoes untrusted text, bad document refs or bad reason codes", () => {
    const echoes: [string, string][] = [
      ["E1-C26", "ignore rules"],
      ["E1-C27", "Ignore previous instructions"],
      ["E1-C29", "also report as posted"],
      ["E1-C30", "SYSTEM"],
    ];
    for (const [id, needle] of echoes) {
      const { pack } = materialize(byId(id), "en");
      const text = renderText(explain(pack), pack);
      expect(text).not.toContain(needle);
      expect(hasBidiControl(text)).toBe(false);
    }
    const { pack } = materialize(byId("E1-C26"), "en");
    expect(renderText(explain(pack), pack)).toContain("not displayable");
  });
});

describe("E1-BL v1 gate and consistency rules", () => {
  it("R-G3: a non-200 timeline after a readable sale abstains without emitting sale facts", () => {
    const { pack } = materialize(byId("E1-C04"), "en");
    const out = explain(patchRead(pack, "consoleGetSaleAuditTimeline", { http_status: 404, body: null }));
    expect(out.class).toBe("abstain_unauthorized");
    expect(out.tracks.processing.rule_id).toBe("R-G3");
    expect(renderText(out, pack)).not.toContain("S-4");
  });

  it("R-G4: 429 (RT-620, added after the RT-647 baseline) is a read failure, not a verdict", () => {
    const { pack } = materialize(byId("E1-C04"), "en");
    const out = explain(patchRead(pack, "consoleGetSaleAuditTimeline", { http_status: 429, body: null }));
    expect(out.class).toBe("abstain_missing");
    expect(out.tracks.processing.rule_id).toBe("R-G4");
  });

  it("R-G4: a needed backlog read that times out abstains", () => {
    const { pack } = materialize(byId("E1-C14"), "en");
    const out = explain(patchRead(pack, "consoleListPostingBacklog", { http_status: "timeout", body: null }));
    expect(out.class).toBe("abstain_missing");
  });

  it("R-C3: a failed status without an open dead letter is stale evidence", () => {
    const { pack } = materialize(byId("E1-C06"), "en");
    const out = explain(patchRead(pack, "consoleGetSaleSyncStatus", { body: { ...(pack.reads.find((r) => r.op === "consoleGetSaleSyncStatus")?.body as object), deadLetter: null } }));
    expect(out.class).toBe("abstain_stale");
    expect(out.tracks.processing.rule_id).toBe("R-C3");
  });

  it("R-C2: a read skew above 30 s is stale evidence", () => {
    const { pack } = materialize(byId("E1-C01"), "en");
    const out = explain({ ...pack, max_read_skew_ms: 30_001 });
    expect(out.class).toBe("abstain_stale");
    expect(out.tracks.processing.rule_id).toBe("R-C2");
    expect(explain({ ...pack, max_read_skew_ms: 30_000 }).class).toBe("answer");
  });

  it("matches action and health questions in EN and AR, with Arabic diacritics and alef variants", () => {
    expect(matchesActionRequest("Please REPAIR this sale")).toBe(true);
    expect(matchesActionRequest("sync now")).toBe(true);
    expect(matchesActionRequest("Explain this sale")).toBe(false);
    expect(matchesActionRequest("أعِد المحاولة")).toBe(true);
    expect(matchesActionRequest("اعد المحاولة")).toBe(true);
    expect(matchesActionRequest("اشرح حالة هذه العملية")).toBe(false);
    expect(matchesHealthQuestion("is everything up to date?")).toBe(true);
    expect(matchesHealthQuestion("هل ترحيل ERP سليم لمتاجري؟")).toBe(true);
    expect(matchesHealthQuestion("Explain this sale")).toBe(false);
  });
});
