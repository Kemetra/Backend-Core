/**
 * RT-175 — ErpnextBinViewService.reportSnapshot multi-window Testcontainers spec.
 *
 * Proves the stock-view 1.3.0-draft connector-paged report rules (introduced
 * in 1.2; RT-21 §4) on
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
 * Test helpers take typed option objects (no positional primitive arguments).
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
  threeWindows: { runId: "0a000000-0000-7000-8000-00000e1750a1" },
  outOfOrder: { runId: "0a000000-0000-7000-8000-00000e1750a2" },
  conflicts: { runId: "0a000000-0000-7000-8000-00000e1750a3" },
  replay: { runId: "0a000000-0000-7000-8000-00000e1750a4" },
  supersede: { runId: "0a000000-0000-7000-8000-00000e1750a5" },
  v1: { runId: "0a000000-0000-7000-8000-00000e1750a6" },
  historical: { runId: "0a000000-0000-7000-8000-00000e1750a7" },
  crossTenant: { runId: "0a000000-0000-7000-8000-00000e1750a8" },
  empty: { runId: "0a000000-0000-7000-8000-00000e1750a9" },
  staleRetry: { runId: "0a000000-0000-7000-8000-00000e1750aa" },
  supersedeCap: { runId: "0a000000-0000-7000-8000-00000e1750ab" },
  lockHeld: { runId: "0a000000-0000-7000-8000-00000e1750ac" },
  lockFree: { runId: "0a000000-0000-7000-8000-00000e1750ad" },
} as const;

/** Identifies one seeded reconciliation run. */
interface RunKey {
  readonly runId: string;
}

/** A batch of `count` distinct ERPNext items named `${prefix}-00000..`. */
interface ItemsSpec {
  readonly prefix: string;
  readonly count: number;
}

/** One reported entry. */
interface EntrySpec {
  readonly ref: string;
  readonly qty: string;
}

/** One report window of an attempt. */
interface WindowSpec {
  readonly entries: Entry[];
  readonly attemptRef: string;
  readonly seq: number;
  readonly isFinal: boolean;
  readonly readAt?: string;
}

/** One `reportSnapshot` call. */
interface ReportCall extends RunKey {
  readonly body: ReportBody;
  readonly tenantId?: string;
}

type Entry = { erpnextItemRef: { doctype: "Item"; name: string }; quantity: string; stockUom: string };
type ReportBody = {
  entries: Entry[];
  window?: { attemptRef: string; windowSeq: number; isFinal: boolean };
  readAt: string;
};

const refOf = ({ runId }: RunKey): string => deterministicId(BIN_VIEW_REQUEST_NS, `${runId}:0`);

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    await seedReconciliationFixture(env);
    const a = env.admin;
    for (const { runId } of Object.values(RUN)) {
      await a.query(
        `INSERT INTO erpnext_reconciliation_run
           (id, tenant_id, store_id, kind, trigger, status, actor_user_id)
         VALUES ($1, $2, $3, 'stock', 'on_demand', 'running', $4)
         ON CONFLICT (id) DO NOTHING`,
        [runId, TENANT_A, STORE_A_X, ACTOR_A],
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

function entry({ ref, qty }: EntrySpec): Entry {
  return { erpnextItemRef: { doctype: "Item", name: ref }, quantity: qty, stockUom: "Nos" };
}

function items({ prefix, count }: ItemsSpec): Entry[] {
  return Array.from({ length: count }, (_, i) =>
    entry({ ref: `${prefix}-${String(i).padStart(5, "0")}`, qty: `${i}.500000` }),
  );
}

function win({ entries, attemptRef, seq, isFinal, readAt = READ_AT }: WindowSpec): ReportBody {
  return { entries, window: { attemptRef, windowSeq: seq, isFinal }, readAt };
}

let keySeq = 0;
function report({ runId, body, tenantId = TENANT_A }: ReportCall) {
  keySeq += 1;
  return new ErpnextBinViewService(env!.app).reportSnapshot({
    tenantId,
    requestRef: refOf({ runId }),
    body,
    idempotencyKey: `rt175-key-${keySeq}`,
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
  supersededAttemptRefs: string[];
}

async function stored({ runId }: RunKey): Promise<StoredReport | undefined> {
  const r = await env!.admin.query<{ summary: { bin_view_report?: StoredReport } | null }>(
    `SELECT summary FROM erpnext_reconciliation_run WHERE id = $1`,
    [runId],
  );
  return r.rows[0]?.summary?.bin_view_report;
}

async function events({ runId }: RunKey): Promise<number> {
  const r = await env!.admin.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM outbox_events
      WHERE event_type = 'erpnext.reconciliation.requested'
        AND payload->>'run_id' = $1`,
    [runId],
  );
  return Number(r.rows[0]!.count);
}

async function runStatus({ runId }: RunKey): Promise<string> {
  const r = await env!.admin.query<{ status: string }>(
    `SELECT status FROM erpnext_reconciliation_run WHERE id = $1`,
    [runId],
  );
  return r.rows[0]!.status;
}

const STORED_KEYS = [
  "acceptedEntryCount",
  "attemptRef",
  "complete",
  "entries",
  "erpnextWarehouseRef",
  "readAt",
  "recordedAt",
  "requestRef",
  "runRef",
  "supersededAttemptRefs",
  "windows",
  "windowsRecorded",
].sort();

/** The three windows of the AC1 attempt: 500 / 500 / 37 (the mapped item last). */
function threeWindowAttempt(): Entry[][] {
  const all = items({ prefix: "ERP-3W", count: 1036 });
  const mapped = entry({ ref: ERP_ITEM_REF, qty: "7.000000" });
  return [all.slice(0, 500), all.slice(500, 1000), [...all.slice(1000), mapped]];
}

/** A deterministic attempt uuid for supersede-cap tests: attempt #n. */
interface AttemptNo {
  readonly n: number;
}
const attemptNo = ({ n }: AttemptNo): string =>
  `0a000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

/** Settles with "done" when `p` settles first, else "pending" after `ms`. */
interface RaceSpec {
  readonly p: Promise<unknown>;
  readonly ms: number;
}
async function settlesWithin({ p, ms }: RaceSpec): Promise<"done" | "pending"> {
  let timer: NodeJS.Timeout | undefined;
  const pending = new Promise<"pending">((res) => {
    timer = setTimeout(() => res("pending"), ms);
  });
  const done = p.then(
    () => "done" as const,
    () => "done" as const,
  );
  const outcome = await Promise.race([done, pending]);
  clearTimeout(timer);
  return outcome;
}

describe("RT-175 — multi-window bin-view report (stock-view 1.2)", () => {
  it("AC1/AC2: 500/500/37 attempt records 1,037 entries; only the final window emits, exactly once", async () => {
    if (skip) return;
    const run = RUN.threeWindows;
    const [w0, w1, w2] = threeWindowAttempt() as [Entry[], Entry[], Entry[]];
    expect(w2).toHaveLength(37);

    const r0 = await report({ ...run, body: win({ entries: w0, attemptRef: ATTEMPT_A, seq: 0, isFinal: false }) });
    expect(r0.replayed).toBe(false);
    expect(r0.view).toMatchObject({
      requestRef: refOf(run),
      runRef: run.runId,
      acceptedEntryCount: 500,
      readAt: READ_AT,
      windowSeq: 0,
      windowsRecorded: 1,
      complete: false,
    });
    // AC2: a non-final window never triggers the compare; the run stays running.
    expect(await events(run)).toBe(0);
    expect(await runStatus(run)).toBe("running");
    expect((await stored(run))!.complete).toBe(false);

    const r1 = await report({ ...run, body: win({ entries: w1, attemptRef: ATTEMPT_A, seq: 1, isFinal: false }) });
    expect(r1.view).toMatchObject({ windowSeq: 1, windowsRecorded: 2, complete: false, acceptedEntryCount: 500 });
    expect(await events(run)).toBe(0);
    expect(await runStatus(run)).toBe("running");

    const r2 = await report({ ...run, body: win({ entries: w2, attemptRef: ATTEMPT_A, seq: 2, isFinal: true }) });
    expect(r2.view).toMatchObject({ windowSeq: 2, windowsRecorded: 3, complete: true, acceptedEntryCount: 37 });
    expect(await events(run)).toBe(1);
  });

  it("AC1: the completed attempt is stored flat in the §4 shape (1,037 entries, 3 windows)", async () => {
    if (skip) return;
    const s = (await stored(RUN.threeWindows))!;
    expect(Object.keys(s).sort()).toEqual(STORED_KEYS);
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
    const run = RUN.outOfOrder;
    const early = win({ entries: items({ prefix: "ERP-OO2", count: 3 }), attemptRef: ATTEMPT_A, seq: 2, isFinal: true });
    // Nothing recorded yet: a non-zero window is a gap.
    await expect(report({ ...run, body: early })).rejects.toBeInstanceOf(BinViewWindowSequenceConflictError);
    expect(await stored(run)).toBeUndefined();
    expect(await events(run)).toBe(0);

    await report({
      ...run,
      body: win({ entries: items({ prefix: "ERP-OO0", count: 2 }), attemptRef: ATTEMPT_A, seq: 0, isFinal: false }),
    });
    const before = await stored(run);
    await expect(report({ ...run, body: early })).rejects.toBeInstanceOf(BinViewWindowSequenceConflictError);
    expect(await stored(run)).toEqual(before);
    expect(await events(run)).toBe(0);
    expect(await runStatus(run)).toBe("running");
  });

  it("AC4: duplicate item across windows / readAt mismatch / window after final → window_sequence_conflict", async () => {
    if (skip) return;
    const run = RUN.conflicts;
    const w0 = items({ prefix: "ERP-CF0", count: 3 });
    const w1 = items({ prefix: "ERP-CF1", count: 2 });
    await report({ ...run, body: win({ entries: w0, attemptRef: ATTEMPT_A, seq: 0, isFinal: false }) });
    const before = await stored(run);

    // Duplicate erpnextItemRef already reported in window 0.
    await expect(
      report({ ...run, body: win({ entries: [...w1, w0[1]!], attemptRef: ATTEMPT_A, seq: 1, isFinal: true }) }),
    ).rejects.toBeInstanceOf(BinViewWindowSequenceConflictError);
    // readAt different from the attempt's.
    await expect(
      report({
        ...run,
        body: win({ entries: w1, attemptRef: ATTEMPT_A, seq: 1, isFinal: true, readAt: OTHER_READ_AT }),
      }),
    ).rejects.toBeInstanceOf(BinViewWindowSequenceConflictError);
    expect(await stored(run)).toEqual(before);
    expect(await events(run)).toBe(0);

    await report({ ...run, body: win({ entries: w1, attemptRef: ATTEMPT_A, seq: 1, isFinal: true }) });
    expect(await events(run)).toBe(1);
    const completed = await stored(run);
    // A window after the final one.
    await expect(
      report({
        ...run,
        body: win({ entries: items({ prefix: "ERP-CF2", count: 2 }), attemptRef: ATTEMPT_A, seq: 2, isFinal: true }),
      }),
    ).rejects.toBeInstanceOf(BinViewWindowSequenceConflictError);
    expect(await stored(run)).toEqual(completed);
    expect(await events(run)).toBe(1);
  });

  it("AC5: identical re-report replays (stable body); same (attempt, seq) with a different body → conflict", async () => {
    if (skip) return;
    const run = RUN.replay;
    const w0 = items({ prefix: "ERP-RP0", count: 4 });
    const first = await report({ ...run, body: win({ entries: w0, attemptRef: ATTEMPT_A, seq: 0, isFinal: false }) });
    const replay = await report({
      ...run,
      body: win({ entries: [...w0].reverse(), attemptRef: ATTEMPT_A, seq: 0, isFinal: false }),
    });
    expect(replay.replayed).toBe(true);
    expect(replay.view).toEqual(first.view);

    // Different entries, same (attempt, seq).
    const changed = [...w0.slice(0, 3), { ...w0[3]!, quantity: "99.000000" }];
    await expect(
      report({ ...run, body: win({ entries: changed, attemptRef: ATTEMPT_A, seq: 0, isFinal: false }) }),
    ).rejects.toBeInstanceOf(BinViewConflictError);
    // Different isFinal, same (attempt, seq).
    await expect(
      report({ ...run, body: win({ entries: w0, attemptRef: ATTEMPT_A, seq: 0, isFinal: true }) }),
    ).rejects.toBeInstanceOf(BinViewConflictError);
    expect(await events(run)).toBe(0);

    // Replay of a final window after completion is still a replay (no 2nd event).
    const finalBody = win({ entries: items({ prefix: "ERP-RP1", count: 1 }), attemptRef: ATTEMPT_A, seq: 1, isFinal: true });
    const fin = await report({ ...run, body: finalBody });
    const finReplay = await report({ ...run, body: finalBody });
    expect(finReplay.replayed).toBe(true);
    expect(finReplay.view).toEqual(fin.view);
    const earlyReplay = await report({ ...run, body: win({ entries: w0, attemptRef: ATTEMPT_A, seq: 0, isFinal: false }) });
    expect(earlyReplay.view).toEqual(first.view);
    expect(await events(run)).toBe(1);
  });

  it("AC6: a new attemptRef at seq 0 discards an incomplete attempt; the stale attempt is refused", async () => {
    if (skip) return;
    const run = RUN.supersede;
    await report({ ...run, body: win({ entries: items({ prefix: "ERP-SA0", count: 3 }), attemptRef: ATTEMPT_A, seq: 0, isFinal: false }) });
    await report({ ...run, body: win({ entries: items({ prefix: "ERP-SA1", count: 3 }), attemptRef: ATTEMPT_A, seq: 1, isFinal: false }) });

    const b0 = items({ prefix: "ERP-SB0", count: 2 });
    const rb0 = await report({
      ...run,
      body: win({ entries: b0, attemptRef: ATTEMPT_B, seq: 0, isFinal: false, readAt: OTHER_READ_AT }),
    });
    expect(rb0.view).toMatchObject({ windowSeq: 0, windowsRecorded: 1, complete: false });
    const s = (await stored(run))!;
    expect(s.attemptRef).toBe(ATTEMPT_B);
    expect(s.readAt).toBe(OTHER_READ_AT);
    expect(s.windowsRecorded).toBe(1);
    expect(s.entries.map((e) => e.erpnextItemRef)).toEqual(b0.map((e) => e.erpnextItemRef.name));

    // The superseded attempt's next window is stale.
    await expect(
      report({ ...run, body: win({ entries: items({ prefix: "ERP-SA2", count: 1 }), attemptRef: ATTEMPT_A, seq: 2, isFinal: true }) }),
    ).rejects.toBeInstanceOf(BinViewWindowSequenceConflictError);
  });

  it("AC6: after completion another attempt (new, superseded or v1) → window_sequence_conflict", async () => {
    if (skip) return;
    const run = RUN.supersede;
    await report({
      ...run,
      body: win({ entries: items({ prefix: "ERP-SB1", count: 1 }), attemptRef: ATTEMPT_B, seq: 1, isFinal: true, readAt: OTHER_READ_AT }),
    });
    expect(await events(run)).toBe(1);
    const s = (await stored(run))!;
    expect(s.complete).toBe(true);
    expect(s.acceptedEntryCount).toBe(3);

    const refused: ReportBody[] = [
      win({ entries: items({ prefix: "ERP-SC0", count: 1 }), attemptRef: ATTEMPT_C, seq: 0, isFinal: true }),
      win({ entries: items({ prefix: "ERP-SA0", count: 3 }), attemptRef: ATTEMPT_A, seq: 0, isFinal: false }),
      { entries: items({ prefix: "ERP-V1", count: 1 }), readAt: READ_AT },
    ];
    for (const body of refused) {
      await expect(report({ ...run, body })).rejects.toBeInstanceOf(BinViewWindowSequenceConflictError);
    }
    expect(await stored(run)).toEqual(s);
    expect(await events(run)).toBe(1);
  });

  it("AC7: a v1 body records one complete window and answers today's projection (no window fields)", async () => {
    if (skip) return;
    const run = RUN.v1;
    const body = { entries: items({ prefix: "ERP-V1X", count: 2 }), readAt: READ_AT };
    const r = await report({ ...run, body });
    expect(r.replayed).toBe(false);
    expect(Object.keys(r.view).sort()).toEqual(
      ["acceptedEntryCount", "erpnextWarehouseRef", "readAt", "recordedAt", "requestRef", "runRef"].sort(),
    );
    expect(r.view.acceptedEntryCount).toBe(2);
    expect(await events(run)).toBe(1);
    const s = (await stored(run))!;
    expect(s.attemptRef).toBeNull();
    expect(s.complete).toBe(true);
    expect(s.windows).toEqual([{ windowSeq: 0, entryCount: 2, isFinal: true, recordedAt: s.recordedAt }]);

    const replay = await report({ ...run, body });
    expect(replay.replayed).toBe(true);
    expect(replay.view).toEqual(r.view);
    await expect(
      report({ ...run, body: { entries: items({ prefix: "ERP-V1Y", count: 2 }), readAt: READ_AT } }),
    ).rejects.toBeInstanceOf(BinViewConflictError);
    expect(await events(run)).toBe(1);
  });

  it("AC7/(iv): a historical stored report without `complete` is read as complete", async () => {
    if (skip) return;
    const run = RUN.historical;
    const historical = {
      requestRef: refOf(run),
      runRef: run.runId,
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
      [run.runId, JSON.stringify(historical)],
    );
    // Same v1 report → today's O-3 echo.
    const replay = await report({
      ...run,
      body: { entries: [entry({ ref: "ERP-HIST-1", qty: "1.000000" })], readAt: READ_AT },
    });
    expect(replay.replayed).toBe(true);
    expect(replay.view).toEqual({
      requestRef: refOf(run),
      runRef: run.runId,
      erpnextWarehouseRef: "ERP-WH-017A",
      acceptedEntryCount: 1,
      readAt: READ_AT,
      recordedAt: "2026-10-01T00:00:00.000Z",
    });
    // Complete → a windowed attempt cannot supersede it.
    await expect(
      report({ ...run, body: win({ entries: items({ prefix: "ERP-HW", count: 1 }), attemptRef: ATTEMPT_A, seq: 0, isFinal: false }) }),
    ).rejects.toBeInstanceOf(BinViewWindowSequenceConflictError);
    expect(await stored(run)).toEqual(historical);
    expect(await events(run)).toBe(0);
  });

  it("empty warehouse: one empty final window 0 completes and emits once", async () => {
    if (skip) return;
    const run = RUN.empty;
    const r = await report({ ...run, body: win({ entries: [], attemptRef: ATTEMPT_A, seq: 0, isFinal: true }) });
    expect(r.view).toMatchObject({ acceptedEntryCount: 0, windowSeq: 0, windowsRecorded: 1, complete: true });
    expect(await events(run)).toBe(1);
  });

  it("AC9: a cross-tenant requestRef → non-disclosing not-found on every window, nothing written", async () => {
    if (skip) return;
    const run = RUN.crossTenant;
    await report({ ...run, body: win({ entries: items({ prefix: "ERP-XT0", count: 2 }), attemptRef: ATTEMPT_A, seq: 0, isFinal: false }) });
    const before = await stored(run);
    const bodies: ReportBody[] = [
      win({ entries: items({ prefix: "ERP-XT0", count: 2 }), attemptRef: ATTEMPT_A, seq: 0, isFinal: false }),
      win({ entries: items({ prefix: "ERP-XT1", count: 2 }), attemptRef: ATTEMPT_A, seq: 1, isFinal: false }),
      win({ entries: items({ prefix: "ERP-XT2", count: 2 }), attemptRef: ATTEMPT_A, seq: 2, isFinal: true }),
      win({ entries: items({ prefix: "ERP-XTB", count: 2 }), attemptRef: ATTEMPT_B, seq: 0, isFinal: true }),
      { entries: items({ prefix: "ERP-XTV", count: 1 }), readAt: READ_AT },
    ];
    for (const body of bodies) {
      await expect(report({ ...run, body, tenantId: TENANT_B })).rejects.toBeInstanceOf(BinViewNotFoundError);
    }
    expect(await stored(run)).toEqual(before);
    expect(await events(run)).toBe(0);
  });
  it("superseded attempt: a late window 0 retry of the superseded attempt → 409, the current attempt intact", async () => {
    if (skip) return;
    const run = RUN.staleRetry;
    const a0 = win({ entries: items({ prefix: "ERP-ST-A0", count: 2 }), attemptRef: ATTEMPT_A, seq: 0, isFinal: false });
    await report({ ...run, body: a0 });
    await report({ ...run, body: win({ entries: items({ prefix: "ERP-ST-A1", count: 2 }), attemptRef: ATTEMPT_A, seq: 1, isFinal: false }) });
    await report({ ...run, body: win({ entries: items({ prefix: "ERP-ST-B0", count: 2 }), attemptRef: ATTEMPT_B, seq: 0, isFinal: false }) });
    const current = (await stored(run))!;
    expect(current.attemptRef).toBe(ATTEMPT_B);
    expect(current.supersededAttemptRefs).toEqual([ATTEMPT_A]);

    // A-w0 again (fresh idempotency key) must not supersede B back.
    await expect(report({ ...run, body: a0 })).rejects.toBeInstanceOf(BinViewWindowSequenceConflictError);
    expect(await stored(run)).toEqual(current);
    expect(await events(run)).toBe(0);
  });

  it("superseded attempts are remembered up to the last 20 (bounded)", async () => {
    if (skip) return;
    const run = RUN.supersedeCap;
    for (let n = 1; n <= 22; n += 1) {
      await report({
        ...run,
        body: win({ entries: items({ prefix: `ERP-CAP${n}`, count: 1 }), attemptRef: attemptNo({ n }), seq: 0, isFinal: false }),
      });
    }
    const s = (await stored(run))!;
    expect(s.attemptRef).toBe(attemptNo({ n: 22 }));
    expect(s.supersededAttemptRefs).toEqual(Array.from({ length: 20 }, (_, i) => attemptNo({ n: i + 2 })));
    expect(s.supersededAttemptRefs).not.toContain(attemptNo({ n: 1 }));
  });

  it("row lock: a report locks ONLY its own run — another run's window is not blocked", async () => {
    if (skip) return;
    const holder = await env!.admin.connect();
    try {
      await holder.query("BEGIN");
      await holder.query(`SELECT id FROM erpnext_reconciliation_run WHERE id = $1 FOR UPDATE`, [RUN.lockHeld.runId]);

      // A different run's window completes while RUN.lockHeld is locked.
      const free = report({
        ...RUN.lockFree,
        body: win({ entries: items({ prefix: "ERP-LK-F", count: 1 }), attemptRef: ATTEMPT_A, seq: 0, isFinal: false }),
      });
      expect(await settlesWithin({ p: free, ms: 10_000 })).toBe("done");
      await expect(free).resolves.toMatchObject({ replayed: false });

      // The locked run's own window waits on its row lock.
      const blocked = report({
        ...RUN.lockHeld,
        body: win({ entries: items({ prefix: "ERP-LK-H", count: 1 }), attemptRef: ATTEMPT_A, seq: 0, isFinal: false }),
      });
      expect(await settlesWithin({ p: blocked, ms: 1_500 })).toBe("pending");
      await holder.query("COMMIT");
      await expect(blocked).resolves.toMatchObject({ replayed: false });
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      holder.release();
    }
  });
});
