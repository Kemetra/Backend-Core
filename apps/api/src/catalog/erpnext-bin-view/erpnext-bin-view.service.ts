/**
 * ErpnextBinViewService — 019-T040 DP2-side bin-view feed/report runtime.
 *
 * Implements the two operations of the shipped
 * `packages/contracts/openapi/erpnext-connector/stock-view.yaml` (1.3.0-draft;
 * the multi-window rules were introduced in 1.2):
 *
 *   - `binViewPullRequests` (feed): project OPEN 017 stock runs (status='running',
 *     store has an active 014 `stock` warehouse map) into `BinViewRequest` feed
 *     items — ONE per run (`itemWindow.windowSeq` 0). A wanted Bin-view read
 *     exists only while a run is `running`; a completed run is never offered.
 *     READ-ONLY, idempotent on the opaque `since` cursor (mirrors the 015
 *     `pullPostings` feed). 019 has no posting-status-like table, so the cursor
 *     derives from RUN ordering (`run.id`, so the keyset cursor key == the sort
 *     key), NOT a sequence column. v1.2 (RT-175): every request advertises
 *     `itemWindow.maxWindows = BIN_VIEW_MAX_WINDOWS`, so a v1.2 connector MAY
 *     page its read into up to that many report windows (a v1 connector ignores
 *     the field).
 *
 *   - `reportSnapshot` (report): record the connector's point-in-time ERPNext-Bin
 *     snapshot run-scoped (lands in 019-T040-REPORT). NOT a standing Bin mirror
 *     (FR-009) — values go to `erpnext_reconciliation_run.summary.bin_view_report`
 *     via a MERGE write (never a bare overwrite — keeps the T041 counts key safe).
 *     v1.2 (RT-175, design RT-21 §4): a report MAY be one window of a
 *     connector-paged read attempt; windows are validated + accumulated under the
 *     run's row lock and `erpnext.reconciliation.requested` is emitted ONLY when
 *     the attempt completes (exactly once). A v1 body (no `window`) is treated as
 *     `{attemptRef: null, windowSeq 0, isFinal true}` — today's behaviour.
 *
 * §IX: DP2 makes NO outbound ERPNext HTTP — it EXPOSES these endpoints; the
 * connector (separate repo) CALLS them. Tenant scope comes from the connector
 * principal only (§XII); RLS scopes every read/write to `app.current_tenant`.
 *
 * `requestRef` is DERIVED deterministically (`deterministicId(NS, runId:windowSeq)`)
 * so a pulled request is stable across re-pulls + bindable on the report WITHOUT a
 * request table (Option B — zero `packages/db` surface, FR-009). There is still
 * one request per run, so the report resolves `runId:0`.
 */
import { Inject, Injectable } from "@nestjs/common";
import { emit, OUTBOX_EVENT_TYPES, runWithTenantContext } from "@data-pulse-2/db";
import { deterministicId } from "@data-pulse-2/shared";
import type { Pool, PoolClient } from "pg";

import { PG_POOL } from "../../auth/auth.module";
import {
  BIN_VIEW_MAX_WINDOWS,
  BIN_VIEW_WINDOW_MAX_ITEMS,
} from "./dto/snapshot-report.dto";

/** Max feed items per page (009/012 ceiling). */
const BIN_VIEW_FEED_MAX_PAGE = 500;
/**
 * Fixed UUID namespace for deterministic `requestRef` derivation. A constant
 * (not random) so the same (run, window) always derives the same ref.
 */
const BIN_VIEW_REQUEST_NS = "0190b1de-0000-7000-8000-0000000be019";
/**
 * How many superseded attempt ids a report remembers (most recent last), so a
 * late window 0 of a superseded attempt is refused instead of superseding the
 * current attempt back (stock-view 1.2: a stale/superseded attempt → 409).
 */
const SUPERSEDED_ATTEMPTS_KEPT = 20;
/** UUID shape guard for the opaque feed cursor (malformed → from-start, not 500). */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Raised when a `requestRef` does not resolve to a running run in the tenant. */
export class BinViewNotFoundError extends Error {
  constructor() {
    super("Bin-view request not found.");
    this.name = "BinViewNotFoundError";
  }
}

/**
 * Raised when an already-recorded report window (same attempt + windowSeq, or
 * the v1 single report) is re-reported with a DIFFERENT body (O-3 conflict →
 * 409 `idempotency_key_conflict`).
 */
export class BinViewConflictError extends Error {
  constructor() {
    super("This bin-view request was already reported with a different snapshot.");
    this.name = "BinViewConflictError";
  }
}

/**
 * v1.2 — a report window that does not fit the recorded attempt (409
 * `window_sequence_conflict`, deterministic, no side effects): a gap or
 * out-of-order `windowSeq`, a window after the final one, a stale/superseded
 * attempt (incl. any other attempt after one is complete), an `erpnextItemRef`
 * already reported in an earlier window of the attempt, or a `readAt` different
 * from the attempt's.
 */
export class BinViewWindowSequenceConflictError extends Error {
  constructor() {
    super("This bin-view report window does not fit the recorded read attempt.");
    this.name = "BinViewWindowSequenceConflictError";
  }
}

/** A bounded item slice of a warehouse's Bin (≤500 items per report window). */
export interface BinViewItemWindow {
  readonly windowSeq: number;
  readonly maxItems: number;
  /** v1.2 — most report windows the connector may send for this request. */
  readonly maxWindows: number;
  readonly fromItemRef: string | null;
  readonly toItemRef: string | null;
}

/** One wanted ERPNext-Bin read (DP2 → connector). Carries no bin data. */
export interface BinViewRequest {
  readonly requestRef: string;
  readonly storeId: string;
  readonly erpnextWarehouseRef: string;
  readonly runRef: string;
  readonly itemWindow: BinViewItemWindow;
  readonly itemCursor: string;
}

export interface PullRequestsInput {
  readonly tenantId: string;
  readonly since: string | null;
  readonly limit: number;
}

export interface PullRequestsResult {
  readonly items: readonly BinViewRequest[];
  readonly cursor: string | null;
  readonly nextPageToken: string | null;
}

interface RunRow {
  run_id: string;
  store_id: string;
  erpnext_warehouse_ref: string;
  started_at: string;
}

/** One reported ERPNext-Bin entry (connector → DP2). */
export interface BinEntryInput {
  readonly erpnextItemRef: { readonly doctype: "Item"; readonly name: string };
  readonly quantity: string;
  readonly stockUom: string;
}

/** v1.2 — the report window of a connector-paged read. */
export interface BinViewReportWindowInput {
  readonly attemptRef: string;
  readonly windowSeq: number;
  readonly isFinal: boolean;
}

/** The connector's point-in-time snapshot report body. */
export interface SnapshotReportBody {
  readonly entries: readonly BinEntryInput[];
  readonly window?: BinViewReportWindowInput | undefined;
  readonly readAt: string;
}

export interface ReportSnapshotInput {
  readonly tenantId: string;
  readonly requestRef: string;
  readonly body: SnapshotReportBody;
  readonly idempotencyKey: string;
}

/** The recorded-report projection (DP2 → connector). */
export interface RecordedBinView {
  readonly requestRef: string;
  readonly runRef: string;
  readonly erpnextWarehouseRef: string;
  /** Entries DP2 recorded for the acknowledged report (window). */
  readonly acceptedEntryCount: number;
  readonly readAt: string;
  readonly recordedAt: string;
  /** v1.2 — present only on a response to a windowed report. */
  readonly windowSeq?: number;
  readonly windowsRecorded?: number;
  readonly complete?: boolean;
}

export interface ReportSnapshotResult {
  readonly replayed: boolean;
  readonly view: RecordedBinView;
}

type StoredEntry = {
  readonly erpnextItemRef: string;
  readonly tenant_product_ref: string | null;
  readonly quantity: string;
  readonly stockUom: string;
};

interface StoredWindow {
  readonly windowSeq: number;
  readonly entryCount: number;
  readonly isFinal: boolean;
  readonly recordedAt: string;
}

/**
 * What lands in `run.summary.bin_view_report` (run-scoped evidence, Option B) —
 * the RT-21 §4 storage shape. `entries` stays FLAT (all windows of the attempt,
 * in window order) so readers (017 processor, RT-51) keep one list; `complete`
 * tells them whether it is the whole warehouse. `supersededAttemptRefs` is an
 * additive key (the last `SUPERSEDED_ATTEMPTS_KEPT` attempts this run discarded);
 * readers that do not know it ignore it.
 */
interface StoredBinViewReport {
  readonly requestRef: string;
  readonly runRef: string;
  readonly erpnextWarehouseRef: string;
  /** null for a v1 (window-less) report. */
  readonly attemptRef: string | null;
  readonly readAt: string;
  readonly recordedAt: string;
  readonly complete: boolean;
  readonly windowsRecorded: number;
  readonly acceptedEntryCount: number;
  readonly windows: readonly StoredWindow[];
  readonly entries: readonly StoredEntry[];
  readonly supersededAttemptRefs: readonly string[];
}

/**
 * A stored report as read back. Historical (pre-RT-175) reports lack
 * `attemptRef`/`complete`/`windows`/`windowsRecorded`/`supersededAttemptRefs`.
 */
type RawStoredBinViewReport = Partial<StoredBinViewReport> & {
  readonly requestRef: string;
  readonly runRef: string;
  readonly erpnextWarehouseRef: string;
  readonly readAt: string;
  readonly recordedAt: string;
};

/**
 * Normalize a stored report: a historical report without `complete` is read as
 * complete (v1 compatibility (iv)) — one final window 0 of a null attempt.
 */
function normalizeStored(raw: RawStoredBinViewReport): StoredBinViewReport {
  const entries = raw.entries ?? [];
  const windows: readonly StoredWindow[] =
    Array.isArray(raw.windows) && raw.windows.length > 0
      ? raw.windows
      : [
          {
            windowSeq: 0,
            entryCount: entries.length,
            isFinal: true,
            recordedAt: raw.recordedAt,
          },
        ];
  return {
    requestRef: raw.requestRef,
    runRef: raw.runRef,
    erpnextWarehouseRef: raw.erpnextWarehouseRef,
    attemptRef: raw.attemptRef ?? null,
    readAt: raw.readAt,
    recordedAt: raw.recordedAt,
    complete: raw.complete !== false,
    windowsRecorded: windows.length,
    acceptedEntryCount: raw.acceptedEntryCount ?? entries.length,
    windows,
    entries,
    supersededAttemptRefs: raw.supersededAttemptRefs ?? [],
  };
}

/** Order-insensitive identity of a window's entries (connector ref + qty + uom). */
function entriesKey(
  entries: ReadonlyArray<{ erpnextItemRef: string; quantity: string; stockUom: string }>,
): string[] {
  return entries.map((e) => `${e.erpnextItemRef}|${e.quantity}|${e.stockUom}`).sort();
}

@Injectable()
export class ErpnextBinViewService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /**
   * Pull a cursor-ordered page of wanted Bin-view reads. Read-only; orders by the
   * run's `id` (keyset cursor key == sort key); offers only `running` stock runs whose store has an
   * active 014 `stock` mapping; caps at `BIN_VIEW_FEED_MAX_PAGE`. Emits one
   * request (windowSeq 0, null bounds) per run, advertising `maxWindows`.
   */
  async pullRequests(input: PullRequestsInput): Promise<PullRequestsResult> {
    const limit = Math.min(Math.max(1, input.limit), BIN_VIEW_FEED_MAX_PAGE);
    // The cursor is opaque on the wire (the DTO accepts any non-empty string), but
    // v1 encodes it as a run id (uuid). A malformed cursor is treated as
    // from-start (null) rather than a 500 on a bad `::uuid` cast — the feed is a
    // pure read, so re-baselining is harmless + idempotent.
    const since = input.since && UUID_RE.test(input.since) ? input.since : null;

    return runWithTenantContext(
      this.pool,
      { tenantId: input.tenantId, isPlatformAdmin: false },
      async (client): Promise<PullRequestsResult> => {
        // Open stock runs on a mapped store, ordered + capped, after the opaque
        // `since` cursor. RLS scopes to the connector principal's tenant. The
        // cursor is the prior page's last run id; keyset on run.id (cursor==sort).
        const rows = await client.query<RunRow>(
          `SELECT run.id AS run_id,
                  run.store_id,
                  whm.erpnext_warehouse_ref,
                  run.started_at::text AS started_at
             FROM erpnext_reconciliation_run run
             JOIN erpnext_warehouse_map whm
               ON whm.store_id = run.store_id
              AND whm.purpose = 'stock'
              AND whm.retired_at IS NULL
            WHERE run.kind = 'stock'
              AND run.status = 'running'
              AND ($1::uuid IS NULL OR run.id > $1::uuid)
            ORDER BY run.id
            LIMIT $2`,
          [since, limit],
        );

        const items: BinViewRequest[] = rows.rows.map((row) => {
          const windowSeq = 0;
          const requestRef = deterministicId(
            BIN_VIEW_REQUEST_NS,
            `${row.run_id}:${windowSeq}`,
          );
          return {
            requestRef,
            storeId: row.store_id,
            erpnextWarehouseRef: row.erpnext_warehouse_ref,
            runRef: row.run_id,
            itemWindow: {
              windowSeq,
              maxItems: BIN_VIEW_WINDOW_MAX_ITEMS,
              // v1.2 connector-paged request: windowSeq 0 + null bounds (the
              // contract's paged-request if/then) — the connector owns the
              // window boundaries.
              maxWindows: BIN_VIEW_MAX_WINDOWS,
              fromItemRef: null,
              toItemRef: null,
            },
            // Opaque advanced cursor after this request item — the run id.
            itemCursor: row.run_id,
          };
        });

        const advanced =
          rows.rows.length > 0 ? rows.rows[rows.rows.length - 1]!.run_id : null;
        const nextPageToken = rows.rows.length === limit ? advanced : null;

        return { items, cursor: advanced, nextPageToken };
      },
    );
  }

  /**
   * Record the connector's point-in-time ERPNext-Bin snapshot (or one window of
   * it) for a pulled `requestRef`. Resolves the request to its `running` stock
   * run + active 014 mapping under `FOR UPDATE` (cross-tenant/unknown →
   * non-disclosing `BinViewNotFoundError`), validates the window against the
   * recorded attempt, reverse-resolves each `erpnextItemRef` →
   * `tenant_product_ref` via the confirmed 013 map (an unmapped ref is recorded
   * with `tenant_product_ref: null`), and MERGE-writes the accumulated attempt
   * into `run.summary.bin_view_report` (Option B — NO standing Bin mirror,
   * FR-009). Exact-decimal quantity STRINGs are preserved verbatim (§III). NEVER
   * touches the 009 ledger or the 008 sale fact (§IX).
   *
   * Window rules (stock-view.yaml 1.2 `binViewReportSnapshot`), all under the
   * run's row lock. A v1 body is `{attemptRef: null, windowSeq 0, isFinal true}`:
   *   - an already-recorded window of the recorded attempt: the SAME content
   *     replays (`replayed: true`, stable body); DIFFERENT content →
   *     `BinViewConflictError` (O-3; the stored report wins, never an overwrite);
   *   - once the recorded attempt is complete, anything else →
   *     `BinViewWindowSequenceConflictError`;
   *   - `windowSeq 0` of a new attempt supersedes (discards) an incomplete one;
   *   - `windowSeq k > 0` must be the next window of the recorded incomplete
   *     attempt, share its `readAt`, and repeat none of its `erpnextItemRef`s —
   *     else `BinViewWindowSequenceConflictError` (nothing written);
   *   - completion (the final window recorded) sets `complete: true` and emits
   *     `erpnext.reconciliation.requested` in the same transaction — exactly once,
   *     because a complete attempt accepts no further window.
   */
  async reportSnapshot(input: ReportSnapshotInput): Promise<ReportSnapshotResult> {
    return runWithTenantContext(
      this.pool,
      { tenantId: input.tenantId, isPlatformAdmin: false },
      async (client): Promise<ReportSnapshotResult> => {
        const run = await this.lockRun(client, input.requestRef);
        const incoming = incomingWindow(input.body);
        const existing = existingReport(run, input.requestRef);

        // (1) O-3: an already-recorded window replays (same) or conflicts.
        const replayed = existing ? recordedWindowReplay(existing, incoming) : null;
        if (existing && replayed) {
          return { replayed: true, view: project(existing, replayed, incoming.windowed) };
        }

        // (2)+(3) completion / supersede / sequence rules — throws on misfit.
        const plan = planAttempt(existing, incoming);
        const resolved = await this.resolveProductRefs(client, incoming.entries);
        const { stored, thisWindow } = buildStored({
          requestRef: input.requestRef,
          run,
          incoming,
          plan,
          resolved,
        });
        await this.persist(client, { tenantId: input.tenantId, run, stored });
        return { replayed: false, view: project(stored, thisWindow, incoming.windowed) };
      },
    );
  }

  /**
   * Resolve `requestRef` → its running stock run on a mapped store and lock
   * ONLY that run row. (a) The requestRef is derived from (run, window=0) — one
   * request per run (v1.2 windows are report windows, not requests) — so it is
   * re-derived over the tenant's running stock runs: ids only, no summary, NO
   * lock. RLS scopes to the tenant, so a cross-tenant ref reads nothing →
   * non-disclosing not-found. (b) `FOR UPDATE` on the target row re-checks it
   * is still running (it may have completed since (a) → the same not-found).
   * Every window of one run serializes on this lock; windows of different runs
   * never block each other.
   */
  private async lockRun(client: PoolClient, requestRef: string): Promise<LockedRun> {
    const candidates = await client.query<{ run_id: string }>(
      `SELECT run.id AS run_id
         FROM erpnext_reconciliation_run run
         JOIN erpnext_warehouse_map whm
           ON whm.store_id = run.store_id
          AND whm.purpose = 'stock'
          AND whm.retired_at IS NULL
        WHERE run.kind = 'stock'
          AND run.status = 'running'`,
    );
    const runId = candidates.rows.find(
      (r) => deterministicId(BIN_VIEW_REQUEST_NS, `${r.run_id}:0`) === requestRef,
    )?.run_id;
    if (runId === undefined) throw new BinViewNotFoundError();

    const locked = await client.query<LockedRun>(
      `SELECT run.id AS run_id,
              run.store_id,
              whm.erpnext_warehouse_ref,
              run.summary
         FROM erpnext_reconciliation_run run
         JOIN erpnext_warehouse_map whm
           ON whm.store_id = run.store_id
          AND whm.purpose = 'stock'
          AND whm.retired_at IS NULL
        WHERE run.id = $1
          AND run.kind = 'stock'
          AND run.status = 'running'
        FOR UPDATE OF run`,
      [runId],
    );
    const run = locked.rows[0];
    if (!run) throw new BinViewNotFoundError();
    return run;
  }

  /**
   * Reverse-resolve erpnextItemRef → tenant_product_ref (confirmed 013 map),
   * BATCHED into ONE query (= ANY) — not N per-entry round-trips. An unmapped
   * ref records tenant_product_ref: null (the 017 run classes it erpnext_only
   * later) — never a crash. `latest mapping wins` (ORDER BY confirmed_at DESC)
   * makes the resolution deterministic if two confirmed maps share a ref.
   */
  private async resolveProductRefs(
    client: PoolClient,
    entries: readonly IncomingEntry[],
  ): Promise<StoredEntry[]> {
    const refNames = Array.from(new Set(entries.map((e) => e.erpnextItemRef)));
    const resolvedMap = new Map<string, string>();
    if (refNames.length > 0) {
      const maps = await client.query<{ erpnext_item_ref: string; tenant_product_id: string }>(
        `SELECT DISTINCT ON (erpnext_item_ref) erpnext_item_ref, tenant_product_id
           FROM erpnext_item_map
          WHERE erpnext_item_ref = ANY($1::text[])
            AND state = 'confirmed'
            AND retired_at IS NULL
          ORDER BY erpnext_item_ref, confirmed_at DESC`,
        [refNames],
      );
      for (const r of maps.rows) resolvedMap.set(r.erpnext_item_ref, r.tenant_product_id);
    }
    return entries.map((e) => ({
      erpnextItemRef: e.erpnextItemRef,
      tenant_product_ref: resolvedMap.get(e.erpnextItemRef) ?? null,
      quantity: e.quantity,
      stockUom: e.stockUom,
    }));
  }

  /**
   * MERGE write — never a bare overwrite (keeps the 017 counts key under
   * summary safe). COALESCE handles the NULL-summary first write. The
   * bin_view_report key itself is replaced by the accumulated attempt (a
   * superseded incomplete attempt is dropped here).
   *
   * 019-T041 lifecycle (shape a): once the connector's Bin snapshot is
   * COMPLETELY recorded, emit erpnext.reconciliation.requested IN-TRANSACTION
   * (atomic with the MERGE). The 017 consumer → ReconciliationRunProcessor then
   * reads this run's summary via ReportBackedBinView and completes the run
   * (running → completed) over REAL Bin data. A non-final window never emits
   * (the compare would see a partial warehouse); a replay never re-emits; a
   * complete attempt accepts no further window — so the event is emitted
   * exactly once per run.
   */
  private async persist(client: PoolClient, write: PersistInput): Promise<void> {
    const { tenantId, run, stored } = write;
    await client.query(
      `UPDATE erpnext_reconciliation_run
          SET summary = COALESCE(summary, '{}'::jsonb)
                        || jsonb_build_object('bin_view_report', $2::jsonb),
              updated_at = now()
        WHERE id = $1 AND status = 'running'`,
      [run.run_id, JSON.stringify(stored)],
    );
    if (stored.complete) {
      await emit(client, {
        eventType: OUTBOX_EVENT_TYPES.ERPNEXT_RECONCILIATION_REQUESTED,
        tenantId,
        storeId: run.store_id,
        payload: { run_id: run.run_id, store_id: run.store_id },
      });
    }
  }
}

/** The run row a report binds to, locked for the duration of the report. */
interface LockedRun {
  run_id: string;
  store_id: string;
  erpnext_warehouse_ref: string;
  summary: Record<string, unknown> | null;
}

/** One reported entry, flattened to the connector ref string. */
interface IncomingEntry {
  readonly erpnextItemRef: string;
  readonly quantity: string;
  readonly stockUom: string;
}

/** The report body as a window: a v1 body is `{null, 0, isFinal true}`. */
interface IncomingWindow {
  readonly attemptRef: string | null;
  readonly windowSeq: number;
  readonly isFinal: boolean;
  /** True when the body carried a `window` (v1.2 response fields apply). */
  readonly windowed: boolean;
  readonly readAt: string;
  readonly entries: readonly IncomingEntry[];
}

/** Where the window lands: the attempt it extends (null = a fresh attempt). */
interface AttemptPlan {
  readonly base: StoredBinViewReport | null;
  readonly supersededAttemptRefs: readonly string[];
}

interface BuildInput {
  readonly requestRef: string;
  readonly run: LockedRun;
  readonly incoming: IncomingWindow;
  readonly plan: AttemptPlan;
  readonly resolved: readonly StoredEntry[];
}

interface PersistInput {
  readonly tenantId: string;
  readonly run: LockedRun;
  readonly stored: StoredBinViewReport;
}

function incomingWindow(body: SnapshotReportBody): IncomingWindow {
  const w = body.window;
  return {
    attemptRef: w?.attemptRef ?? null,
    windowSeq: w?.windowSeq ?? 0,
    isFinal: w?.isFinal ?? true,
    windowed: w !== undefined,
    readAt: body.readAt,
    entries: body.entries.map((e) => ({
      erpnextItemRef: e.erpnextItemRef.name,
      quantity: e.quantity,
      stockUom: e.stockUom,
    })),
  };
}

/** The run's recorded report for this request (normalized), if any. */
function existingReport(run: LockedRun, requestRef: string): StoredBinViewReport | null {
  const raw = (run.summary as { bin_view_report?: RawStoredBinViewReport } | null)
    ?.bin_view_report;
  return raw && raw.requestRef === requestRef ? normalizeStored(raw) : null;
}

/**
 * O-3: when the incoming window is an already-recorded window of the recorded
 * attempt, return that stored window if the content is identical (a replay) or
 * throw `BinViewConflictError` if it differs. Null = not a recorded window.
 */
function recordedWindowReplay(
  existing: StoredBinViewReport,
  incoming: IncomingWindow,
): StoredWindow | null {
  const { windowSeq } = incoming;
  if (existing.attemptRef !== incoming.attemptRef || windowSeq >= existing.windowsRecorded) {
    return null;
  }
  const storedWindow = existing.windows[windowSeq]!;
  const offset = existing.windows.slice(0, windowSeq).reduce((n, w) => n + w.entryCount, 0);
  const a = entriesKey(existing.entries.slice(offset, offset + storedWindow.entryCount));
  const b = entriesKey(incoming.entries);
  const same =
    existing.readAt === incoming.readAt &&
    storedWindow.isFinal === incoming.isFinal &&
    a.length === b.length &&
    a.every((v, i) => v === b[i]);
  if (!same) throw new BinViewConflictError();
  return storedWindow;
}

/**
 * Sequence rules for a window that is not a replay (throws
 * `BinViewWindowSequenceConflictError` on any misfit, before anything is
 * written):
 *   - a complete attempt accepts nothing else (a window after the final one,
 *     or any other attempt, v1 or windowed);
 *   - windowSeq 0 starts a (new) attempt, superseding an incomplete one —
 *     unless it is an attempt this run already superseded (a late retry must
 *     not supersede the current attempt back);
 *   - windowSeq k > 0 must extend the recorded incomplete attempt
 *     contiguously, with the same readAt and no repeated item.
 */
function planAttempt(
  existing: StoredBinViewReport | null,
  incoming: IncomingWindow,
): AttemptPlan {
  if (existing?.complete) throw new BinViewWindowSequenceConflictError();
  const superseded = existing?.supersededAttemptRefs ?? [];
  if (incoming.windowSeq === 0) {
    if (incoming.attemptRef !== null && superseded.includes(incoming.attemptRef)) {
      throw new BinViewWindowSequenceConflictError();
    }
    const discarded = existing?.attemptRef ? [existing.attemptRef] : [];
    return {
      base: null,
      supersededAttemptRefs: [...superseded, ...discarded].slice(-SUPERSEDED_ATTEMPTS_KEPT),
    };
  }
  if (!extendsAttempt(existing, incoming)) throw new BinViewWindowSequenceConflictError();
  return { base: existing, supersededAttemptRefs: superseded };
}

/** True when `incoming` is the next disjoint window of `existing`'s attempt. */
function extendsAttempt(
  existing: StoredBinViewReport | null,
  incoming: IncomingWindow,
): existing is StoredBinViewReport {
  if (
    !existing ||
    existing.attemptRef !== incoming.attemptRef ||
    incoming.windowSeq !== existing.windowsRecorded ||
    existing.readAt !== incoming.readAt
  ) {
    return false;
  }
  const seenRefs = new Set(existing.entries.map((e) => e.erpnextItemRef));
  return !incoming.entries.some((e) => seenRefs.has(e.erpnextItemRef));
}

/** The accumulated attempt (RT-21 §4 shape) after recording this window. */
function buildStored(input: BuildInput): {
  stored: StoredBinViewReport;
  thisWindow: StoredWindow;
} {
  const { requestRef, run, incoming, plan, resolved } = input;
  const recordedAt = new Date().toISOString();
  const thisWindow: StoredWindow = {
    windowSeq: incoming.windowSeq,
    entryCount: resolved.length,
    isFinal: incoming.isFinal,
    recordedAt,
  };
  const windows = [...(plan.base?.windows ?? []), thisWindow];
  const entries = [...(plan.base?.entries ?? []), ...resolved];
  const stored: StoredBinViewReport = {
    requestRef,
    runRef: run.run_id,
    erpnextWarehouseRef: run.erpnext_warehouse_ref,
    attemptRef: incoming.attemptRef,
    readAt: incoming.readAt,
    recordedAt,
    complete: incoming.isFinal,
    windowsRecorded: windows.length,
    acceptedEntryCount: entries.length,
    windows,
    entries,
    supersededAttemptRefs: plan.supersededAttemptRefs,
  };
  return { stored, thisWindow };
}

/**
 * Project a stored report + the acknowledged window into the RecordedBinView
 * wire shape. A v1 (window-less) report gets today's exact shape; a windowed
 * report adds `windowSeq`/`windowsRecorded`/`complete` AS OF that window's
 * recording (windows are contiguous, so `windowsRecorded = windowSeq + 1` and
 * `complete = isFinal`) — keeping a replay byte-stable with the original.
 */
function project(
  stored: StoredBinViewReport,
  window: StoredWindow,
  windowed: boolean,
): RecordedBinView {
  const base: RecordedBinView = {
    requestRef: stored.requestRef,
    runRef: stored.runRef,
    erpnextWarehouseRef: stored.erpnextWarehouseRef,
    acceptedEntryCount: window.entryCount,
    readAt: stored.readAt,
    recordedAt: window.recordedAt,
  };
  if (!windowed) return base;
  return {
    ...base,
    windowSeq: window.windowSeq,
    windowsRecorded: window.windowSeq + 1,
    complete: window.isFinal,
  };
}
