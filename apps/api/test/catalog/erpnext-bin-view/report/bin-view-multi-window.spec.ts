/**
 * RT-175 — ErpnextBinViewService.reportSnapshot multi-window Testcontainers spec.
 *
 * Proves the stock-view 1.2.0-draft connector-paged report rules (RT-21 §4) on
 * the service, against real Postgres + RLS:
 *   AC1  a 3-window attempt (500/500/37) records all 1,037 entries flat in the §4
 *        storage shape and emits exactly ONE `erpnext.reconciliation.requested`,
 *        after the final window;
 *   AC2  a non-final window emits nothing and the run stays `running`;
 *   AC3  window 2 before window 1 → window_sequence_conflict, no state change;
 *   AC4  duplicate item across windows / readAt mismatch / window after final →
 *        window_sequence_conflict;
 *   AC5  identical re-report of a window → replay (stable body); same
 *        (attempt, seq) with a different body → idempotency conflict;
 *   AC6  a new attemptRef at seq 0 discards an incomplete attempt; after
 *        completion any other attempt → window_sequence_conflict;
 *   AC7  a v1 body (no window) records the §4 shape as one complete window and
 *        answers today's projection; a historical stored report without
 *        `complete` is read as complete;
 *   AC9  a cross-tenant requestRef → non-disclosing not-found on every window.
 *
 * Docker policy: HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import { deterministicId } from "@data-pulse-2/shared";

import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../../_helpers/postgres-container";
import {
  BinViewConflictError,
  BinViewNotFoundError,
  BinViewWindowSequenceConflictError,
  ErpnextBinViewService,
} from "../../../../src/catalog/erpnext-bin-view/erpnext-bin-view.service";
import {
  ACTOR_A,
  PRODUCT_A_ACTIVE,
  STORE_A_X,
  TENANT_A,
  TENANT_B,
} from "../../__support__/isolation-harness";
import { seedReconciliationFixture } from "../../erpnext-reconciliation/__support__/seed-reconciliation";

let env: PgTestEnv | null = null;
let skip = false;

const BIN_VIEW_REQUEST_NS = "0190b1de-0000-7000-8000-0000000be019";
const ERP_ITEM_REF = "ERP-ITEM-175MAP";
const READ_AT = "2026-10-04T08:00:00.000Z";
const OTHER_READ_AT = "2026-10-04T08:00:05.000Z";

const ATTEMPT_A = "0a000000-0000-4000-8000-0000000a175a";
const ATTEMPT_B = "0a000000-0000-4000-8000-0000000a175b";
const ATTEMPT_C = "0a000000-0000-4000-8000-0000000a175c";

const RUN = {
  threeWindows: "0a000000-0000-7000-8000-00000e1750a1",
  outOfOrder: "0a000000-0000-7000-8000-00000e1750a2",
  conflicts: "0a000000-0000-7000-8000-00000e1750a3",
  replay: "0a000000-0000-7000-8000-00000e1750a4",
  supersede: "0a000000-0000-7000-8000-00000e1750a5",
  v1: "0a000000-0000-7000-8000-00000e1750a6",
  historical: "0a000000-0000-7000-8000-00000e1750a7",
  crossTenant: "0a000000-0000-7000-8000-00000e1750a8",
  empty: "0a000000-0000-7000-8000-00000e1750a9",
} as const;

const refOf = (runId: string): string =>
  deterministicId(BIN_VIEW_REQUEST_NS, `${runId}:0`);

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    await seedReconciliationFixture(env);
    const a = env.admin;
    for (const id of Object.values(RUN)) {
      await a.query(
        `INSERT INTO erpnext_reconciliation_run
           (id, tenant_id, store_id, kind, trigger, status, actor_user_id)
         VALUES ($1, $2, $3, 'stock', 'on_demand', 'running', $4)
         ON CONFLICT (id) DO NOTHING`,
        [id, TENANT_A, STORE_A_X, ACTOR_A],
      );
    }
    await a.query(
      `INSERT INTO erpnext_item_map
         (id, tenant_id, tenant_product_id, erpnext_item_ref, state,
          suggestion_source, confirmed_by, confirmed_at)
       VALUES (gen_random_uuid(), $1, $2, $3, 'confirmed', 'manual', $4, now())
       ON CONFLICT DO NOTHING`,
      [TENANT_A, PRODUCT_A_ACTIVE, ERP_ITEM_REF, ACTOR_A],
    );
  } catch (err) {
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      skip = true;
      // eslint-disable-next-line no-console
      console.warn(`[bin-view-multi-window.spec] Docker unavailable: ${String(err)}`);
      return;
    }
    throw err;
  }
}, 180_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

type Entry = { erpnextItemRef: { doctype: "Item"; name: string }; quantity: string; stockUom: string };

/** `n` distinct ERPNext items `${prefix}-00000..`. */
function items(prefix: string, n: number): Entry[] {
  return Array.from({ length: n }, (_, i) => ({
    erpnextItemRef: { doctype: "Item" as const, name: `${prefix}-${String(i).padStart(5, "0")}` },
    quantity: `${i}.500000`,
    stockUom: "Nos",
  }));
}

function win(
  entries: Entry[],
  attemptRef: string,
  windowSeq: number,
  isFinal: boolean,
  readAt: string = READ_AT,
) {
  return { entries, window: { attemptRef, windowSeq, isFinal }, readAt };
}

let keySeq = 0;
function report(
  runId: string,
  body: { entries: Entry[]; window?: { attemptRef: string; windowSeq: number; isFinal: boolean }; readAt: string },
  tenantId: string = TENANT_A,
) {
  return new ErpnextBinViewService(env!.app).reportSnapshot({
    tenantId,
    requestRef: refOf(runId),
    body,
    idempotencyKey: `rt175-key-${(keySeq += 1)}`,
  });
}

interface StoredReport {
  requestRef: string;
  runRef: string;
  erpnextWarehouseRef: string;
  attemptRef: string | null;
  readAt: string;
  recordedAt: string;
  complete: boolean;
  windowsRecorded: number;
  acceptedEntryCount: number;
  windows: Array<{ windowSeq: number; entryCount: number; isFinal: boolean; recordedAt: string }>;
  entries: Array<{ erpnextItemRef: string; tenant_product_ref: string | null; quantity: string; stockUom: string }>;
}

async function stored(runId: string): Promise<StoredReport | undefined> {
  const r = await env!.admin.query<{ summary: { bin_view_report?: StoredReport } | null }>(
    `SELECT summary FROM erpnext_reconciliation_run WHERE id = $1`,
    [runId],
  );
  return r.rows[0]?.summary?.bin_view_report;
}

async function events(runId: string): Promise<number> {
  const r = await env!.admin.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM outbox_events
      WHERE event_type = 'erpnext.reconciliation.requested'
        AND payload->>'run_id' = $1`,
    [runId],
  );
  return Number(r.rows[0]!.count);
}

async function runStatus(runId: string): Promise<string> {
  const r = await env!.admin.query<{ status: string }>(
    `SELECT status FROM erpnext_reconciliation_run WHERE id = $1`,
    [runId],
  );
  return r.rows[0]!.status;
}

describe("RT-175 — multi-window bin-view report (stock-view 1.2)", () => {
  it("AC1/AC2: 500/500/37 attempt records 1,037 entries; only the final window emits, exactly once", async () => {
    if (skip) return;
    const runId = RUN.threeWindows;
    const all = items("ERP-3W", 1036);
    // Put the one MAPPED item in the last window so its reverse-resolve is proven.
    const mapped: Entry = { erpnextItemRef: { doctype: "Item", name: ERP_ITEM_REF }, quantity: "7.000000", stockUom: "Nos" };
    const w0 = all.slice(0, 500);
    const w1 = all.slice(500, 1000);
    const w2 = [...all.slice(1000), mapped];
    expect(w2).toHaveLength(37);

    const r0 = await report(runId, win(w0, ATTEMPT_A, 0, false));
    expect(r0.replayed).toBe(false);
    expect(r0.view).toMatchObject({
      requestRef: refOf(runId),
      runRef: runId,
      acceptedEntryCount: 500,
      readAt: READ_AT,
      windowSeq: 0,
      windowsRecorded: 1,
      complete: false,
    });
    // AC2: a non-final window never triggers the compare; the run stays running.
    expect(await events(runId)).toBe(0);
    expect(await runStatus(runId)).toBe("running");
    expect((await stored(runId))!.complete).toBe(false);

    const r1 = await report(runId, win(w1, ATTEMPT_A, 1, false));
    expect(r1.view).toMatchObject({ windowSeq: 1, windowsRecorded: 2, complete: false, acceptedEntryCount: 500 });
    expect(await events(runId)).toBe(0);
    expect(await runStatus(runId)).toBe("running");

    const r2 = await report(runId, win(w2, ATTEMPT_A, 2, true));
    expect(r2.view).toMatchObject({ windowSeq: 2, windowsRecorded: 3, complete: true, acceptedEntryCount: 37 });
    expect(await events(runId)).toBe(1);

    const s = (await stored(runId))!;
    expect(Object.keys(s).sort()).toEqual(
      [
        "acceptedEntryCount",
        "attemptRef",
        "complete",
        "entries",
        "erpnextWarehouseRef",
        "readAt",
        "recordedAt",
        "requestRef",
        "runRef",
        "windows",
        "windowsRecorded",
      ].sort(),
    );
    expect(s.attemptRef).toBe(ATTEMPT_A);
    expect(s.complete).toBe(true);
    expect(s.windowsRecorded).toBe(3);
    expect(s.acceptedEntryCount).toBe(1037);
    expect(s.entries).toHaveLength(1037);
    expect(new Set(s.entries.map((e) => e.erpnextItemRef)).size).toBe(1037);
    expect(s.windows.map((w) => [w.windowSeq, w.entryCount, w.isFinal])).toEqual([
      [0, 500, false],
      [1, 500, false],
      [2, 37, true],
    ]);
    expect(s.readAt).toBe(READ_AT);
    const mappedRow = s.entries.find((e) => e.erpnextItemRef === ERP_ITEM_REF)!;
    expect(mappedRow.tenant_product_ref).toBe(PRODUCT_A_ACTIVE);
    expect(s.entries.filter((e) => e.tenant_product_ref === null)).toHaveLength(1036);
    // Exact-decimal strings preserved verbatim (§III).
    expect(s.entries[1]!.quantity).toBe("1.500000");
  });

  it("AC3: window 2 before window 1 → window_sequence_conflict, no state change", async () => {
    if (skip) return;
    const runId = RUN.outOfOrder;
    // Nothing recorded yet: a non-zero window is a gap.
    await expect(report(runId, win(items("ERP-OO2", 3), ATTEMPT_A, 2, true))).rejects.toBeInstanceOf(
      BinViewWindowSequenceConflictError,
    );
    expect(await stored(runId)).toBeUndefined();
    expect(await events(runId)).toBe(0);

    await report(runId, win(items("ERP-OO0", 2), ATTEMPT_A, 0, false));
    const before = await stored(runId);
    await expect(report(runId, win(items("ERP-OO2", 3), ATTEMPT_A, 2, true))).rejects.toBeInstanceOf(
      BinViewWindowSequenceConflictError,
    );
    expect(await stored(runId)).toEqual(before);
    expect(await events(runId)).toBe(0);
    expect(await runStatus(runId)).toBe("running");
  });

  it("AC4: duplicate item across windows / readAt mismatch / window after final → window_sequence_conflict", async () => {
    if (skip) return;
    const runId = RUN.conflicts;
    const w0 = items("ERP-CF0", 3);
    await report(runId, win(w0, ATTEMPT_A, 0, false));
    const before = await stored(runId);

    // Duplicate erpnextItemRef already reported in window 0.
    await expect(
      report(runId, win([...items("ERP-CF1", 2), w0[1]!], ATTEMPT_A, 1, true)),
    ).rejects.toBeInstanceOf(BinViewWindowSequenceConflictError);
    // readAt different from the attempt's.
    await expect(
      report(runId, win(items("ERP-CF1", 2), ATTEMPT_A, 1, true, OTHER_READ_AT)),
    ).rejects.toBeInstanceOf(BinViewWindowSequenceConflictError);
    expect(await stored(runId)).toEqual(before);
    expect(await events(runId)).toBe(0);

    await report(runId, win(items("ERP-CF1", 2), ATTEMPT_A, 1, true));
    expect(await events(runId)).toBe(1);
    const completed = await stored(runId);
    // A window after the final one.
    await expect(
      report(runId, win(items("ERP-CF2", 2), ATTEMPT_A, 2, true)),
    ).rejects.toBeInstanceOf(BinViewWindowSequenceConflictError);
    expect(await stored(runId)).toEqual(completed);
    expect(await events(runId)).toBe(1);
  });

  it("AC5: identical re-report replays (stable body); same (attempt, seq) with a different body → conflict", async () => {
    if (skip) return;
    const runId = RUN.replay;
    const w0 = items("ERP-RP0", 4);
    const first = await report(runId, win(w0, ATTEMPT_A, 0, false));
    const replay = await report(runId, win([...w0].reverse(), ATTEMPT_A, 0, false));
    expect(replay.replayed).toBe(true);
    expect(replay.view).toEqual(first.view);

    // Different entries, same (attempt, seq).
    await expect(
      report(runId, win([...w0.slice(0, 3), { ...w0[3]!, quantity: "99.000000" }], ATTEMPT_A, 0, false)),
    ).rejects.toBeInstanceOf(BinViewConflictError);
    // Different isFinal, same (attempt, seq).
    await expect(report(runId, win(w0, ATTEMPT_A, 0, true))).rejects.toBeInstanceOf(BinViewConflictError);
    expect(await events(runId)).toBe(0);

    // Replay of a final window after completion is still a replay (no 2nd event).
    const w1 = items("ERP-RP1", 1);
    const fin = await report(runId, win(w1, ATTEMPT_A, 1, true));
    const finReplay = await report(runId, win(w1, ATTEMPT_A, 1, true));
    expect(finReplay.replayed).toBe(true);
    expect(finReplay.view).toEqual(fin.view);
    const earlyReplay = await report(runId, win(w0, ATTEMPT_A, 0, false));
    expect(earlyReplay.view).toEqual(first.view);
    expect(await events(runId)).toBe(1);
  });

  it("AC6: a new attemptRef at seq 0 discards an incomplete attempt; after completion another attempt → conflict", async () => {
    if (skip) return;
    const runId = RUN.supersede;
    await report(runId, win(items("ERP-SA0", 3), ATTEMPT_A, 0, false));
    await report(runId, win(items("ERP-SA1", 3), ATTEMPT_A, 1, false));

    const b0 = items("ERP-SB0", 2);
    const rb0 = await report(runId, win(b0, ATTEMPT_B, 0, false, OTHER_READ_AT));
    expect(rb0.view).toMatchObject({ windowSeq: 0, windowsRecorded: 1, complete: false });
    let s = (await stored(runId))!;
    expect(s.attemptRef).toBe(ATTEMPT_B);
    expect(s.readAt).toBe(OTHER_READ_AT);
    expect(s.windowsRecorded).toBe(1);
    expect(s.entries.map((e) => e.erpnextItemRef)).toEqual(b0.map((e) => e.erpnextItemRef.name));

    // The superseded attempt's next window is stale.
    await expect(
      report(runId, win(items("ERP-SA2", 1), ATTEMPT_A, 2, true)),
    ).rejects.toBeInstanceOf(BinViewWindowSequenceConflictError);

    await report(runId, win(items("ERP-SB1", 1), ATTEMPT_B, 1, true, OTHER_READ_AT));
    expect(await events(runId)).toBe(1);
    s = (await stored(runId))!;
    expect(s.complete).toBe(true);
    expect(s.acceptedEntryCount).toBe(3);

    // After completion: a new attempt, the superseded attempt, or a v1 body.
    await expect(report(runId, win(items("ERP-SC0", 1), ATTEMPT_C, 0, true))).rejects.toBeInstanceOf(
      BinViewWindowSequenceConflictError,
    );
    await expect(report(runId, win(items("ERP-SA0", 3), ATTEMPT_A, 0, false))).rejects.toBeInstanceOf(
      BinViewWindowSequenceConflictError,
    );
    await expect(report(runId, { entries: items("ERP-V1", 1), readAt: READ_AT })).rejects.toBeInstanceOf(
      BinViewWindowSequenceConflictError,
    );
    expect(await stored(runId)).toEqual(s);
    expect(await events(runId)).toBe(1);
  });

  it("AC7: a v1 body records one complete window and answers today's projection (no window fields)", async () => {
    if (skip) return;
    const runId = RUN.v1;
    const body = { entries: items("ERP-V1X", 2), readAt: READ_AT };
    const r = await report(runId, body);
    expect(r.replayed).toBe(false);
    expect(Object.keys(r.view).sort()).toEqual(
      ["acceptedEntryCount", "erpnextWarehouseRef", "readAt", "recordedAt", "requestRef", "runRef"].sort(),
    );
    expect(r.view.acceptedEntryCount).toBe(2);
    expect(await events(runId)).toBe(1);
    const s = (await stored(runId))!;
    expect(s.attemptRef).toBeNull();
    expect(s.complete).toBe(true);
    expect(s.windows).toEqual([{ windowSeq: 0, entryCount: 2, isFinal: true, recordedAt: s.recordedAt }]);

    const replay = await report(runId, body);
    expect(replay.replayed).toBe(true);
    expect(replay.view).toEqual(r.view);
    await expect(
      report(runId, { entries: items("ERP-V1Y", 2), readAt: READ_AT }),
    ).rejects.toBeInstanceOf(BinViewConflictError);
    expect(await events(runId)).toBe(1);
  });

  it("AC7/(iv): a historical stored report without `complete` is read as complete", async () => {
    if (skip) return;
    const runId = RUN.historical;
    const historical = {
      requestRef: refOf(runId),
      runRef: runId,
      erpnextWarehouseRef: "ERP-WH-017A",
      readAt: READ_AT,
      recordedAt: "2026-10-01T00:00:00.000Z",
      acceptedEntryCount: 1,
      entries: [{ erpnextItemRef: "ERP-HIST-1", tenant_product_ref: null, quantity: "1.000000", stockUom: "Nos" }],
    };
    await env!.admin.query(
      `UPDATE erpnext_reconciliation_run
          SET summary = jsonb_build_object('bin_view_report', $2::jsonb)
        WHERE id = $1`,
      [runId, JSON.stringify(historical)],
    );
    // Same v1 report → today's O-3 echo.
    const replay = await report(runId, {
      entries: [{ erpnextItemRef: { doctype: "Item", name: "ERP-HIST-1" }, quantity: "1.000000", stockUom: "Nos" }],
      readAt: READ_AT,
    });
    expect(replay.replayed).toBe(true);
    expect(replay.view).toEqual({
      requestRef: refOf(runId),
      runRef: runId,
      erpnextWarehouseRef: "ERP-WH-017A",
      acceptedEntryCount: 1,
      readAt: READ_AT,
      recordedAt: "2026-10-01T00:00:00.000Z",
    });
    // Complete → a windowed attempt cannot supersede it.
    await expect(report(runId, win(items("ERP-HW", 1), ATTEMPT_A, 0, false))).rejects.toBeInstanceOf(
      BinViewWindowSequenceConflictError,
    );
    expect(await stored(runId)).toEqual(historical);
    expect(await events(runId)).toBe(0);
  });

  it("empty warehouse: one empty final window 0 completes and emits once", async () => {
    if (skip) return;
    const runId = RUN.empty;
    const r = await report(runId, win([], ATTEMPT_A, 0, true));
    expect(r.view).toMatchObject({ acceptedEntryCount: 0, windowSeq: 0, windowsRecorded: 1, complete: true });
    expect(await events(runId)).toBe(1);
  });

  it("AC9: a cross-tenant requestRef → non-disclosing not-found on every window, nothing written", async () => {
    if (skip) return;
    const runId = RUN.crossTenant;
    await report(runId, win(items("ERP-XT0", 2), ATTEMPT_A, 0, false));
    const before = await stored(runId);
    for (const body of [
      win(items("ERP-XT0", 2), ATTEMPT_A, 0, false),
      win(items("ERP-XT1", 2), ATTEMPT_A, 1, false),
      win(items("ERP-XT2", 2), ATTEMPT_A, 2, true),
      win(items("ERP-XTB", 2), ATTEMPT_B, 0, true),
      { entries: items("ERP-XTV", 1), readAt: READ_AT },
    ]) {
      await expect(report(runId, body, TENANT_B)).rejects.toBeInstanceOf(BinViewNotFoundError);
    }
    expect(await stored(runId)).toEqual(before);
    expect(await events(runId)).toBe(0);
  });
});
