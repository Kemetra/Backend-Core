/**
 * integration-state-machine.unit.spec.ts — Jira RT-426 (RT-289 G2-3, DC-3, DC-5).
 *
 * The pure integration-state machine and its writer, without a database:
 *   - every §2.3 transition moves the effect to the state RT-289 names;
 *   - a signal that finds the effect already where it would move is a no-op
 *     (the O-3 duplicate ack, a concurrent repair);
 *   - every other (state, signal) pairing is illegal, and the writer refuses
 *     the whole signal (so the caller's transaction rolls back);
 *   - the writer only ever writes `inventory_effect_integration`.
 *
 * The db-integration spec (posting-outcome-transitions.spec.ts) proves the
 * same rules end to end through the posting ack and the repair.
 */
import type { PoolClient } from "pg";

import { INVENTORY_INTEGRATION_STATES, type InventoryIntegrationState } from "@data-pulse-2/db";

import {
  decideTransition,
  IllegalIntegrationTransitionError,
  type PostingSignal,
  type TransitionDecision,
} from "../../../src/inventory/effect-integration/integration-state-machine";
import { applyPostingSignalToEffects } from "../../../src/inventory/effect-integration/effect-integration.transitions";

const SIGNALS: readonly PostingSignal[] = [
  "posted",
  "failed_transient",
  "permanently_rejected",
  "reconciliation_required",
  "repair_re_post",
];

const move = (to: InventoryIntegrationState): TransitionDecision => ({ kind: "move", to });
const NO_OP: TransitionDecision = { kind: "no_op" };
const ILLEGAL: TransitionDecision = { kind: "illegal" };

/** The full RT-289 §2.3 table: every legal pairing; anything absent is illegal. */
const LEGAL: ReadonlyArray<[InventoryIntegrationState, PostingSignal, TransitionDecision]> = [
  // posted → confirmed (sets erp_confirmed_at + erp_document_ref)
  ["pending", "posted", move("confirmed")],
  ["confirmed", "posted", NO_OP], // duplicate ack (O-3 echo)
  // failed_transient → stays pending
  ["pending", "failed_transient", NO_OP],
  // permanently_rejected / retry budget exhausted → rejected
  ["pending", "permanently_rejected", move("rejected")],
  ["rejected", "permanently_rejected", NO_OP],
  // reconciliation_required and the stale-resolution path → reconciliation_required
  ["pending", "reconciliation_required", move("reconciliation_required")],
  ["rejected", "reconciliation_required", move("reconciliation_required")], // RT-332 upgrade
  ["reconciliation_required", "reconciliation_required", NO_OP],
  // repair re_post → rejected → pending
  ["rejected", "repair_re_post", move("pending")],
  ["pending", "repair_re_post", NO_OP], // a concurrent repair already re-offered it
];

function expected(state: InventoryIntegrationState, signal: PostingSignal): TransitionDecision {
  const hit = LEGAL.find(([s, sig]) => s === state && sig === signal);
  return hit ? hit[2] : ILLEGAL;
}

describe("RT-426 — integration-state machine (pure)", () => {
  describe.each(LEGAL)("%s on %s", (state, signal, decision) => {
    it(`decides ${JSON.stringify(decision)}`, () => {
      expect(decideTransition(state, signal)).toEqual(decision);
    });
  });

  it("refuses every (state, signal) pairing outside the §2.3 table", () => {
    const illegal: string[] = [];
    for (const state of INVENTORY_INTEGRATION_STATES) {
      for (const signal of SIGNALS) {
        expect(decideTransition(state, signal)).toEqual(expected(state, signal));
        if (expected(state, signal).kind === "illegal") illegal.push(`${state}/${signal}`);
      }
    }
    // Spot-check the ones that matter most.
    expect(illegal).toEqual(
      expect.arrayContaining([
        "confirmed/permanently_rejected", // the stored document wins (O-3)
        "confirmed/reconciliation_required",
        "confirmed/repair_re_post",
        "rejected/posted", // a rejected effect must be re-offered first
        "reconciliation_required/repair_re_post", // never re-offered (RT-332)
        "reconciliation_required/posted",
        "rejected/failed_transient",
      ]),
    );
  });

  it("no posting signal reaches an effect with no ERP intent", () => {
    for (const state of ["not_posted", "external", "erp_neutral"] as const) {
      for (const signal of SIGNALS) {
        expect(decideTransition(state, signal)).toEqual(ILLEGAL);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Writer, against a recording fake client
// ---------------------------------------------------------------------------

interface Recorded {
  readonly sql: string;
  readonly params: readonly unknown[];
}

function fakeClient(linked: ReadonlyArray<{ effect_id: string; state: InventoryIntegrationState }>): {
  client: PoolClient;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (/^\s*SELECT/.test(sql)) return { rows: linked, rowCount: linked.length };
      const ids = params[0] as string[];
      return { rows: [], rowCount: ids.length };
    },
  } as unknown as PoolClient;
  return { client, calls };
}

const INTENT = "0a000000-0000-7000-8000-0000000426a1";
const DOC = JSON.stringify({ doctype: "Sales Invoice", name: "ACC-SINV-0426" });
const AT = new Date("2026-10-13T10:00:00.000Z");

describe("RT-426 — applyPostingSignalToEffects (writer)", () => {
  it("an intent with no linked effects writes nothing", async () => {
    const { client, calls } = fakeClient([]);
    await expect(
      applyPostingSignalToEffects(client, { postingStatusId: INTENT, signal: "posted", erpDocumentRef: DOC, erpConfirmedAt: AT }),
    ).resolves.toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.sql).toMatch(/FROM inventory_effect_integration/);
    expect(calls[0]!.params).toEqual([INTENT]);
  });

  it("posted confirms every pending effect with the document and the confirmation time", async () => {
    const { client, calls } = fakeClient([
      { effect_id: "e1", state: "pending" },
      { effect_id: "e2", state: "pending" },
    ]);
    await expect(
      applyPostingSignalToEffects(client, { postingStatusId: INTENT, signal: "posted", erpDocumentRef: DOC, erpConfirmedAt: AT }),
    ).resolves.toBe(2);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.sql).toMatch(/^\s*UPDATE inventory_effect_integration/);
    expect(calls[1]!.params).toEqual([["e1", "e2"], "confirmed", DOC, AT, null]);
  });

  it("the writer touches only inventory_effect_integration, never stock_movements", async () => {
    const { client, calls } = fakeClient([{ effect_id: "e1", state: "pending" }]);
    await applyPostingSignalToEffects(client, { postingStatusId: INTENT, signal: "permanently_rejected", stateReason: "other" });
    for (const c of calls) expect(c.sql).not.toMatch(/stock_movements/);
  });

  it("rejected carries the category as reason and no document", async () => {
    const { client, calls } = fakeClient([{ effect_id: "e1", state: "pending" }]);
    await applyPostingSignalToEffects(client, {
      postingStatusId: INTENT,
      signal: "permanently_rejected",
      stateReason: "retry_budget_exhausted",
    });
    expect(calls[1]!.params).toEqual([["e1"], "rejected", null, null, "retry_budget_exhausted"]);
  });

  it("reconciliation_required keeps the mismatching document as evidence (or none)", async () => {
    const a = fakeClient([{ effect_id: "e1", state: "pending" }]);
    await applyPostingSignalToEffects(a.client, {
      postingStatusId: INTENT,
      signal: "reconciliation_required",
      erpDocumentRef: DOC,
      stateReason: "reconciliation_required",
    });
    expect(a.calls[1]!.params).toEqual([["e1"], "reconciliation_required", DOC, null, "reconciliation_required"]);

    const b = fakeClient([{ effect_id: "e1", state: "rejected" }]);
    await applyPostingSignalToEffects(b.client, { postingStatusId: INTENT, signal: "reconciliation_required" });
    expect(b.calls[1]!.params).toEqual([["e1"], "reconciliation_required", null, null, null]);
  });

  it("repair re_post moves rejected effects back to pending", async () => {
    const { client, calls } = fakeClient([{ effect_id: "e1", state: "rejected" }]);
    await applyPostingSignalToEffects(client, { postingStatusId: INTENT, signal: "repair_re_post", stateReason: "repair_re_post" });
    expect(calls[1]!.params).toEqual([["e1"], "pending", null, null, "repair_re_post"]);
  });

  it("a duplicate ack (effects already confirmed) writes nothing", async () => {
    const { client, calls } = fakeClient([{ effect_id: "e1", state: "confirmed" }]);
    await expect(
      applyPostingSignalToEffects(client, { postingStatusId: INTENT, signal: "posted", erpDocumentRef: DOC, erpConfirmedAt: AT }),
    ).resolves.toBe(0);
    expect(calls).toHaveLength(1);
  });

  it("failed_transient leaves pending effects as they are", async () => {
    const { client, calls } = fakeClient([{ effect_id: "e1", state: "pending" }]);
    await expect(applyPostingSignalToEffects(client, { postingStatusId: INTENT, signal: "failed_transient" })).resolves.toBe(0);
    expect(calls).toHaveLength(1);
  });

  it("refuses the whole signal when any linked effect cannot take it", async () => {
    const { client, calls } = fakeClient([
      { effect_id: "e1", state: "pending" },
      { effect_id: "e2", state: "rejected" },
    ]);
    const err = await applyPostingSignalToEffects(client, {
      postingStatusId: INTENT,
      signal: "posted",
      erpDocumentRef: DOC,
      erpConfirmedAt: AT,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IllegalIntegrationTransitionError);
    expect(err).toMatchObject({ from: "rejected", signal: "posted" });
    expect(calls).toHaveLength(1); // no UPDATE issued
  });

  it("a posted signal without the document or the confirmation time is refused", async () => {
    const a = fakeClient([{ effect_id: "e1", state: "pending" }]);
    await expect(
      applyPostingSignalToEffects(a.client, { postingStatusId: INTENT, signal: "posted", erpConfirmedAt: AT }),
    ).rejects.toThrow(/ERP document and confirmation time/);
    const b = fakeClient([{ effect_id: "e1", state: "pending" }]);
    await expect(
      applyPostingSignalToEffects(b.client, { postingStatusId: INTENT, signal: "posted", erpDocumentRef: DOC }),
    ).rejects.toThrow(/ERP document and confirmation time/);
  });
});
