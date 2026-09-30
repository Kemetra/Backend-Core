/**
 * SalesService — 008 US1 capture (T035).
 *
 * Creates the immutable sale fact: a `sales` header + frozen `sale_lines`
 * snapshot, built ALONGSIDE the 005 ingestion seam (reuses tenant-context/RLS;
 * the Idempotency-Key interceptor is engaged by the controller decorator).
 *
 * Invariants enforced here:
 *   - POS total preserved VERBATIM (FR-030); the SaaS computes a per-line
 *     half-up comparison total for an ADVISORY `mismatch_flag` only — it never
 *     rewrites the POS total.
 *   - No-float money (gate A.6): amounts stay strings end-to-end; the
 *     comparison sum is computed by Postgres `numeric`, never JS number.
 *   - `mismatch_flag` is set at capture (advisory, SaaS-owned). `processed_at`
 *     is left NULL — the off-request worker (FR-071) claims unprocessed rows
 *     via the `idx_sales_unprocessed` partial index.
 *   - Dedup on `(tenant_id, source_system, external_id)` (FR-050): a
 *     re-delivery (same provenance, possibly a different Idempotency-Key)
 *     returns the SAME sale reference deterministically (FR-100), no
 *     double-apply. Cross-tenant externalId collisions are isolated (SI-001) —
 *     the dedup key includes tenant_id and RLS scopes every read/write.
 *   - Line snapshot is frozen (FR-003): `tenant_product_ref` is lineage only;
 *     a line with no resolvable product is still snapshotted and NO tenant
 *     product is auto-created (FR-004).
 *   - Provenance: `source_system` / `external_id` / SHA-256-canonical
 *     `payload_hash` retained for reconciliation (gate C).
 *
 * Every DB call runs inside `runWithTenantContext` so 003/008 RLS policies
 * apply to the app connection. The outbox producer is injected OPTIONALLY so
 * the capture integration spec can construct the service with PG_POOL only
 * (mirrors UnknownItemsService's optional enqueuer).
 */
import { Inject, Injectable, Optional } from "@nestjs/common";
import { runWithTenantContext, emit, OUTBOX_EVENT_TYPES } from "@data-pulse-2/db";
import { newId } from "@data-pulse-2/shared";
import type { Pool, PoolClient } from "pg";

import { PG_POOL } from "../../auth/auth.module";
import type { CaptureSaleRequestDto, SaleTenderDto } from "./dto/capture-sale-request.dto";
import type { RecordVoidRequestDto } from "./dto/record-void-request.dto";
import type { RecordRefundRequestDto } from "./dto/record-refund-request.dto";
import { SALE_SYNC_STATUS, type SaleSyncStatus } from "./sale-sync-status";
import { sha256CanonicalHex } from "./payload-hash";
import {
  SaleNotFoundError,
  SaleTenderMismatchError,
  SaleTenderReplayConflictError,
  SaleTendersNotVisibleError,
  TerminalEventProvenanceConflictError,
} from "./sale-errors";
import {
  lockSaleForReversal,
  mapOneVoidViolation,
  readReversalState,
  SaleAlreadyReversedError,
} from "./sale-reversal";

// Moved to ./sale-errors (RT-73); re-exported so existing importers are unchanged.
export {
  SaleNotFoundError,
  SaleTenderMismatchError,
  SaleTenderReplayConflictError,
  SaleTendersNotVisibleError,
  TerminalEventProvenanceConflictError,
} from "./sale-errors";

/**
 * Optional outbox producer seam — OBSOLETE DEAD CODE.
 *
 * Superseded by the IN-TRANSACTION `emit(client, ...)` call in `captureSale`
 * (the inventory-service precedent), which writes the `sale.captured` outbox
 * row atomically with the sale + sale_lines inserts. This post-tx enqueue seam
 * is intentionally LEFT in place (unbound — never provided in `SalesModule`)
 * only to avoid broadening this slice's scope; it is never invoked at runtime.
 */
export interface SalesOutboxProducer {
  enqueue(event: {
    tenantId: string;
    type: string;
    payload: Record<string, unknown>;
  }): Promise<void>;
}
export const SALES_OUTBOX_PRODUCER = Symbol("SALES_OUTBOX_PRODUCER");

export interface CaptureSaleInput {
  readonly tenantId: string;
  readonly storeId: string;
  readonly actorUserId: string;
  /**
   * RT-77 (RT-10 D7(i)): the envelope guard's bound device
   * (`request.posDeviceId`), stored on `sales.device_id`. Never a body field.
   */
  readonly deviceId: string;
  readonly body: CaptureSaleRequestDto;
}

/** The `toBody` wire projection of a captured sale (snake-free, no secrets). */
export interface SaleProjection {
  readonly saleRef: string;
  readonly storeId: string;
  readonly currencyCode: string;
  readonly posTotal: string;
  readonly occurredAt: string;
  readonly receivedAt: string;
  readonly businessDate: string;
  readonly processedAt: string | null;
  readonly sourceClockAt: string | null;
  readonly sourceSystem: string;
  readonly externalId: string;
  readonly mismatchFlag: boolean;
  /** 032 §7 — DP-2's server-authoritative sale-status (the terminal observes, DP-2 decides). */
  readonly syncStatus: SaleSyncStatus;
  /** RT-73: a void terminal event exists (derived; the sale row is never mutated). */
  readonly voided: boolean;
  readonly lines: ReadonlyArray<SaleLineProjection>;
  /** RT-77: how the sale was paid; empty for a tender-unknown sale (RT-10 D8). */
  readonly tenders: ReadonlyArray<SaleTenderProjection>;
}

/** RT-77: one recorded tender (contract `SaleTender`); `reference` only when set. */
export interface SaleTenderProjection {
  readonly method: "cash" | "card_external";
  readonly amount: string;
  readonly reference?: string;
}

export interface SaleLineProjection {
  /** RT-72/73: stable line identity (= sale_lines.id); a return names it. */
  readonly lineRef: string;
  readonly lineName: string;
  readonly unitPrice: string;
  readonly currencyCode: string;
  readonly quantity: string;
  readonly lineAmount: string;
  readonly taxAmount: string | null;
  readonly unit: string;
  readonly tenantProductRef: string | null;
  /** Cumulative quantity returned on the line. */
  readonly returnedQuantity: string;
  /** quantity − returnedQuantity, or 0 once the sale is voided. */
  readonly returnableQuantity: string;
}

export interface CaptureSaleResult {
  readonly projection: SaleProjection;
  /** false when a re-delivery resolved to an existing row (no INSERT). */
  readonly created: boolean;
}

export interface RecordVoidInput {
  readonly tenantId: string;
  readonly storeId: string;
  readonly actorUserId: string;
  readonly saleRef: string;
  readonly body: RecordVoidRequestDto;
}

export interface RecordRefundInput {
  readonly tenantId: string;
  readonly storeId: string;
  readonly actorUserId: string;
  readonly saleRef: string;
  readonly body: RecordRefundRequestDto;
}

/** Wire projection of a void/refund terminal event (contract `SaleTerminalEvent`). */
export interface TerminalEventProjection {
  readonly eventRef: string;
  readonly saleRef: string;
  readonly kind: "void" | "refund";
  readonly recordedAt: string;
  /** Present (non-null) only for refunds. */
  readonly posRefundAmount: string | null;
  /** Present (non-null) only for refunds. */
  readonly currencyCode: string | null;
}

export interface TerminalEventResult {
  readonly projection: TerminalEventProjection;
  /** false when a re-delivery resolved to an existing terminal event. */
  readonly created: boolean;
}

interface SaleRow {
  id: string;
  store_id: string;
  currency_code: string;
  pos_total: string;
  occurred_at: Date;
  received_at: Date;
  business_date: string;
  processed_at: Date | null;
  source_clock_at: Date | null;
  source_system: string;
  external_id: string;
  mismatch_flag: boolean | null;
  sync_status: SaleSyncStatus;
  voided: boolean;
  tender_count: number;
}

interface SaleTenderRow {
  method: "cash" | "card_external";
  amount: string;
  reference: string | null;
}

interface SaleLineRow {
  line_ref: string;
  line_name: string;
  unit_price: string;
  currency_code: string;
  quantity: string;
  line_amount: string;
  tax_amount: string | null;
  unit: string;
  tenant_product_ref: string | null;
  returned_quantity: string;
  returnable_quantity: string;
}

@Injectable()
export class SalesService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    // OBSOLETE: the outbox event is now emitted IN-TRANSACTION via `emit(client,
    // ...)` inside `captureSale`. This @Optional inject is dead — `SalesModule`
    // never binds `SALES_OUTBOX_PRODUCER`, so it is always `undefined`. Kept to
    // avoid broadening this slice's scope (see `SalesOutboxProducer` docstring).
    @Optional()
    @Inject(SALES_OUTBOX_PRODUCER)
    private readonly outbox?: SalesOutboxProducer,
  ) {}

  async captureSale(input: CaptureSaleInput): Promise<CaptureSaleResult> {
    const { tenantId, storeId, actorUserId, deviceId, body } = input;
    const payloadHash = sha256CanonicalHex(body);
    const tenders = body.tenders ?? [];

    const result = await runWithTenantContext(
      this.pool,
      { tenantId, isPlatformAdmin: false },
      async (client): Promise<{ saleId: string; created: boolean }> => {
        // Dedup (FR-050) is enforced atomically by the INSERT ... ON CONFLICT
        // below — a single race-safe path, no read-before-write window. A
        // re-delivery with the same provenance resolves deterministically to
        // the existing row (FR-100). The dedup key is scoped by tenant_id, so a
        // cross-tenant externalId collision is isolated (SI-001).

        // Advisory comparison total (gate A.3/A.4): half-up sum of per-line
        // amounts, computed by Postgres numeric — NEVER JS float. mismatch_flag
        // is TRUE when it differs from the POS-reported total. The POS total is
        // stored verbatim regardless (FR-030).
        const compare = await client.query<{ mismatch: boolean }>(
          `SELECT (round(SUM(amt)::numeric, 4) <> $1::numeric) AS mismatch
             FROM unnest($2::numeric[]) AS amt`,
          [body.posTotal, body.lines.map((l) => l.lineAmount)],
        );
        const mismatchFlag = compare.rows[0]?.mismatch ?? false;

        // RT-77 (RT-10 D1): tenders sum to posTotal EXACTLY, in Postgres
        // numeric (never JS float). Checked before any write, so a mismatch
        // (→ 422) records nothing — replay or not.
        if (tenders.length > 0) await assertTendersMatchTotal(client, tenders, body.posTotal);

        // UUIDv7 (time-ordered) via the shared id policy — fact tables are
        // high-write, so v7 B-tree locality matters; matches reconciliation.
        const saleId = newId();

        // business_date is the occurredAt CALENDAR DATE in the STORE's timezone
        // (FR-023) — never the client clock. Resolve the store's IANA zone under
        // tenant RLS; the principal's own store always resolves (the sales FK
        // guarantees the store exists), so a miss is a misconfigured principal —
        // fail loudly, never silently default to UTC. (Stores default to 'UTC'
        // until an operator sets a real zone, so this reproduces the prior UTC
        // behavior until then.) processed_at stays NULL — the worker claims it.
        const tz = await client.query<{ timezone: string }>(
          `SELECT timezone FROM stores WHERE id = $1`,
          [storeId],
        );
        const storeTimezone = tz.rows[0]?.timezone;
        if (!storeTimezone) {
          throw new Error("store timezone not resolvable for capture");
        }
        //
        // Atomic dedup (FR-050/100): ON CONFLICT on the
        // (tenant_id, source_system, external_id) unique index makes the write
        // race-safe — a concurrent or re-delivered identical capture does NOT
        // double-insert or surface a 500; it falls through to the deterministic
        // resolve below (zero rows returned ⇒ the row already exists).
        const inserted = await client.query<{ id: string }>(
          // 032 §7: `sync_status` is set to 'captured' IN the capture
          // transaction (server-authoritative; POS never supplies it). The
          // column also DEFAULTs to 'captured' in 0026, but it is bound
          // explicitly here so the capture write is self-documenting and does
          // not silently depend on the default. The off-request drain advances
          // it to 'synced' (see SaleProcessingProcessor).
          `INSERT INTO sales
             (id, tenant_id, store_id, currency_code, pos_total, occurred_at,
              business_date, source_clock_at, source_system, external_id,
              payload_hash, mismatch_flag, created_by, sync_status,
              device_id, tender_count)
           VALUES ($1, $2, $3, $4, $5::numeric, $6::timestamptz,
                   ($6::timestamptz AT TIME ZONE $13)::date, $7::timestamptz,
                   $8, $9, $10, $11, $12, $14, $15, $16)
           ON CONFLICT (tenant_id, source_system, external_id) DO NOTHING
           RETURNING id`,
          [
            saleId,
            tenantId,
            storeId,
            body.currencyCode,
            body.posTotal,
            body.occurredAt,
            body.sourceClockAt ?? null,
            body.sourceSystem,
            body.externalId,
            payloadHash,
            mismatchFlag,
            actorUserId,
            storeTimezone,
            SALE_SYNC_STATUS.CAPTURED,
            deviceId,
            tenders.length,
          ],
        );

        if (inserted.rows.length === 0) {
          // The provenance already exists — a prior re-delivery or a concurrent
          // racing capture won. Resolve to that row deterministically (replay,
          // no double-apply). No line inserts: the winner already wrote them.
          const winner = await client.query<{
            id: string;
            store_id: string;
            tender_count: number;
          }>(
            `SELECT id, store_id, tender_count FROM sales
              WHERE tenant_id = $1 AND source_system = $2 AND external_id = $3
              LIMIT 1`,
            [tenantId, body.sourceSystem, body.externalId],
          );
          const winnerRow = winner.rows[0];
          if (!winnerRow) {
            throw new Error("dedup conflict but no existing sale row found");
          }
          // The provenance belongs to a sale in another store of this tenant:
          // non-disclosing, exactly as before RT-77 (the store-scoped read
          // below would not find it). Checked BEFORE the tender compare so a
          // replay can never probe another store's tenders.
          if (winnerRow.store_id !== storeId) throw new SaleNotFoundError();
          // RT-77: a replay that adds, drops or changes tenders is a different
          // payload (409). Only the tender set is compared (RT-77 10509).
          await assertSameTenders(client, winnerRow, tenders);
          return { saleId: winnerRow.id, created: false };
        }

        for (const line of body.lines) {
          await client.query(
            `INSERT INTO sale_lines
               (id, sale_id, tenant_id, store_id, line_name, unit_price,
                currency_code, quantity, line_amount, tax_amount, unit,
                tenant_product_ref)
             VALUES ($1, $2, $3, $4, $5, $6::numeric, $7, $8::numeric,
                     $9::numeric, $10, $11, $12)`,
            [
              newId(),
              saleId,
              tenantId,
              storeId,
              line.lineName,
              line.unitPrice,
              line.currencyCode,
              line.quantity,
              line.lineAmount,
              line.taxAmount ?? null,
              line.unit,
              line.tenantProductRef ?? null,
            ],
          );
        }
        if (tenders.length > 0) {
          await insertTenders(client, {
            saleId,
            tenantId,
            storeId,
            currencyCode: body.currencyCode,
            tenders,
          });
        }

        // Emit the `sale.captured` outbox event IN-TRANSACTION, atomic with the
        // sale + sale_lines inserts (the inventory-service precedent). The
        // worker-side `SaleCapturedConsumer` bridges this row to the
        // "sale-processing" BullMQ queue. ONLY the created path emits — the
        // dedup-replay branch above already returned `created: false` without
        // reaching here, so a re-delivery does NOT double-emit.
        //
        // Payload is IDs-only (`sale_id` / `store_id`, both uuid) — NO money,
        // line amounts, or PII (FR-042 / FR-092), matching the consumer's Zod
        // schema. The emit runs under the same tenant GUC as the inserts (this
        // callback is inside `runWithTenantContext` with `tenantId`), so the
        // outbox RLS WITH CHECK passes. A failing emit ROLLS BACK the whole
        // capture — the sale and its event commit together or not at all.
        //
        // `correlationId` is null: `CaptureSaleInput` carries no correlation id
        // (unlike the inventory movement path), so there is none to forward.
        await emit(client, {
          eventType: OUTBOX_EVENT_TYPES.SALE_CAPTURED,
          tenantId,
          storeId,
          payload: { sale_id: saleId, store_id: storeId },
          correlationId: null,
        });

        return { saleId, created: true };
      },
    );

    const projection = await this.readSaleProjection(
      tenantId,
      storeId,
      result.saleId,
    );
    return { projection, created: result.created };
  }

  /**
   * Read a sale + its lines and build the `toBody` projection.
   *
   * Scoped by tenant AND store (spec §120/§449, FR-063): RLS enforces the
   * tenant boundary, but the `sales_tenant_read` policy is tenant-only, so the
   * store boundary is enforced here with an explicit `store_id` predicate. A
   * sale outside the caller's store reads as absent (non-disclosing 404).
   */
  async readSaleProjection(
    tenantId: string,
    storeId: string,
    saleId: string,
  ): Promise<SaleProjection> {
    return runWithTenantContext(
      this.pool,
      { tenantId, isPlatformAdmin: false },
      async (client): Promise<SaleProjection> => {
        const sale = await client.query<SaleRow>(
          // business_date::text returns the exact calendar date as a string. A
          // bare `date` column is parsed by node-pg into a JS Date at LOCAL
          // midnight, and `.toISOString()` then shifts it by the process tz —
          // corrupting the store-local date (FR-023). Casting to text avoids it.
          `SELECT id, store_id, currency_code, pos_total, occurred_at,
                  received_at, business_date::text AS business_date,
                  processed_at, source_clock_at,
                  source_system, external_id, mismatch_flag, sync_status, tender_count,
                  EXISTS (SELECT 1 FROM sale_voids v WHERE v.sale_id = sales.id) AS voided
             FROM sales WHERE id = $1 AND store_id = $2`,
          [saleId, storeId],
        );
        const row = sale.rows[0];
        if (!row) {
          // Object-level authz / non-disclosing: a sale outside the caller's
          // tenant (RLS) or store (predicate above) reads as absent.
          throw new SaleNotFoundError();
        }
        // RT-73 returnability: cumulative returned quantity per line; a voided
        // sale has nothing left to return (RT-14 D2).
        const lines = await client.query<SaleLineRow>(
          `SELECT sl.id::text AS line_ref, sl.line_name, sl.unit_price,
                  sl.currency_code, sl.quantity, sl.line_amount, sl.tax_amount,
                  sl.unit, sl.tenant_product_ref,
                  r.returned::text AS returned_quantity,
                  (CASE WHEN $2::boolean THEN 0 ELSE sl.quantity - r.returned END)
                    ::numeric(19,6)::text AS returnable_quantity
             FROM sale_lines sl
             CROSS JOIN LATERAL (
               SELECT COALESCE(SUM(rl.quantity), 0)::numeric(19,6) AS returned
                 FROM sale_return_lines rl WHERE rl.sale_line_id = sl.id
             ) r
            WHERE sl.sale_id = $1 ORDER BY sl.line_name`,
          [saleId, row.voided],
        );
        // RT-77: a tender-unknown sale (tender_count 0 — every legacy sale)
        // never touches sale_tenders, so the pre-RT-77 read path does not
        // depend on the new table's grant.
        const tenders =
          row.tender_count > 0
            ? (
                await client.query<SaleTenderRow>(
                  `SELECT method, amount::text AS amount, reference
                     FROM sale_tenders WHERE sale_id = $1 ORDER BY method`,
                  [saleId],
                )
              ).rows
            : [];
        // Same invariant as the posting feed: never answer with a partial or
        // empty list for a tender-bearing sale (empty means tender-unknown).
        if (tenders.length !== row.tender_count) {
          throw new SaleTendersNotVisibleError(saleId, row.tender_count, tenders.length);
        }
        return toBody(row, lines.rows, tenders);
      },
    );
  }

  /**
   * Record a void terminal event (US3 / T053).
   *
   * A void is a SEPARATE append-only record — the original `sales` row and its
   * `sale_lines` are NEVER mutated (§X); "voided" is derived from the presence
   * of this event. Object-safety (FR-014, SI-004): the target sale must resolve
   * within the caller's (tenant via RLS, store via predicate) scope, else a
   * non-disclosing `SaleNotFoundError` (→ 404) and NO record is written.
   *
   * Idempotent on the void's OWN `(tenant_id, source_system, external_id)`
   * provenance (FR-013): a re-delivery is a deterministic replay (no duplicate).
   * `voided_at` is the DB `now()` server clock — never client-supplied — and
   * `business_date` is its store-timezone day, persisted at insert (RT-63 P2).
   *
   * RT-14 D2 (RT-73): the sale row is locked first, so a concurrent void or
   * return on the same sale serializes behind this one. Under the lock the
   * replay check runs BEFORE the exclusivity check — a re-delivered void must
   * still replay although the sale is now voided — then a second void or a
   * void of a returned sale is `SaleAlreadyReversedError` (409).
   */
  async recordVoid(input: RecordVoidInput): Promise<TerminalEventResult> {
    const { tenantId, storeId, actorUserId, saleRef, body } = input;
    const payloadHash = sha256CanonicalHex(body);
    return runWithTenantContext(
      this.pool,
      { tenantId, isPlatformAdmin: false },
      async (client): Promise<TerminalEventResult> => {
        const sale = await lockSaleForReversal(client, saleRef, storeId);

        const existing = await findVoidByProvenance(client, tenantId, body);
        if (existing) return replayVoid(existing, saleRef);

        const state = await readReversalState(client, saleRef);
        if (state.voided || state.returned) throw new SaleAlreadyReversedError();

        let inserted;
        try {
          inserted = await client.query<{ id: string; voided_at: Date }>(
            `INSERT INTO sale_voids
               (id, sale_id, tenant_id, store_id, business_date, source_system,
                external_id, payload_hash, created_by)
             VALUES ($1, $2, $3, $4, (now() AT TIME ZONE $9)::date, $5, $6, $7, $8)
             ON CONFLICT (tenant_id, source_system, external_id) DO NOTHING
             RETURNING id, voided_at`,
            [
              newId(),
              saleRef,
              tenantId,
              storeId,
              body.sourceSystem,
              body.externalId,
              payloadHash,
              actorUserId,
              sale.timezone,
            ],
          );
        } catch (err) {
          throw mapOneVoidViolation(err);
        }

        if (inserted.rows.length === 0) {
          // The same provenance was recorded concurrently (possibly for a
          // different sale): resolve it like a replay — never echo saleRef.
          const winner = await findVoidByProvenance(client, tenantId, body);
          if (!winner) {
            throw new Error("void conflict but no existing terminal event found");
          }
          return replayVoid(winner, saleRef);
        }

        const row = inserted.rows[0]!;

        // 015 posting trigger (reversal): a void terminal event just landed.
        // Emit `erpnext.posting.requested` IN-TRANSACTION, atomic with the
        // sale_voids insert, so the void becomes eligible for a REVERSING ERPNext
        // document (012 O-4). `source_ref_id` is the VOID row's OWN id (not the
        // sale's) — the REVERSAL-CARDINALITY anchor (data-model §5), so a sale
        // both voided and refunded yields two distinct posting rows. ONLY the
        // created path emits (the dedup-replay branch returned above), so a
        // re-delivery does NOT double-emit; downstream the O-3 unique
        // (tenant_id, source_ref_id) keeps the consumer insert idempotent.
        await emit(client, {
          eventType: OUTBOX_EVENT_TYPES.ERPNEXT_POSTING_REQUESTED,
          tenantId,
          storeId,
          payload: {
            sale_id: saleRef,
            store_id: storeId,
            kind: "reversal",
            source_ref_id: row.id,
          },
          correlationId: null,
        });

        return {
          projection: toTerminalEvent("void", row.id, saleRef, row.voided_at, null, null),
          created: true,
        };
      },
    );
  }

  /**
   * Record a refund terminal event (US4 / T058).
   *
   * Same shape + invariants as `recordVoid` — a SEPARATE append-only
   * `sale_refunds` record, never mutating the sale (§X); object-safety
   * non-disclosing 404 (FR-014); idempotent on the refund's own provenance with
   * the cross-sale-collision guard (FR-013). Additionally preserves the
   * POS-reported refund amount VERBATIM (FR-012/030) — the SaaS stores it as-is
   * and never rewrites it. `refunded_at` is the DB server clock.
   */
  async recordRefund(input: RecordRefundInput): Promise<TerminalEventResult> {
    const { tenantId, storeId, actorUserId, saleRef, body } = input;
    const payloadHash = sha256CanonicalHex(body);
    return runWithTenantContext(
      this.pool,
      { tenantId, isPlatformAdmin: false },
      async (client): Promise<TerminalEventResult> => {
        const sale = await client.query<{ id: string }>(
          `SELECT id FROM sales WHERE id = $1 AND store_id = $2`,
          [saleRef, storeId],
        );
        if (!sale.rows[0]) {
          throw new SaleNotFoundError();
        }

        const eventId = newId();
        const inserted = await client.query<{
          id: string;
          refunded_at: Date;
          pos_refund_amount: string;
          currency_code: string;
        }>(
          `INSERT INTO sale_refunds
             (id, sale_id, tenant_id, store_id, pos_refund_amount, currency_code,
              source_system, external_id, payload_hash, created_by)
           VALUES ($1, $2, $3, $4, $5::numeric, $6, $7, $8, $9, $10)
           ON CONFLICT (tenant_id, source_system, external_id) DO NOTHING
           RETURNING id, refunded_at, pos_refund_amount, currency_code`,
          [
            eventId,
            saleRef,
            tenantId,
            storeId,
            body.posRefundAmount,
            body.currencyCode,
            body.sourceSystem,
            body.externalId,
            payloadHash,
            actorUserId,
          ],
        );

        if (inserted.rows.length === 0) {
          // Provenance already exists — a replay only if it points at the SAME
          // sale (FR-013); otherwise a conflict (never echo the caller's ref).
          const existing = await client.query<{
            id: string;
            sale_id: string;
            refunded_at: Date;
            pos_refund_amount: string;
            currency_code: string;
          }>(
            `SELECT id, sale_id, refunded_at, pos_refund_amount, currency_code
               FROM sale_refunds
              WHERE tenant_id = $1 AND source_system = $2 AND external_id = $3
              LIMIT 1`,
            [tenantId, body.sourceSystem, body.externalId],
          );
          const row = existing.rows[0];
          if (!row) {
            throw new Error("refund conflict but no existing terminal event found");
          }
          if (row.sale_id !== saleRef) {
            throw new TerminalEventProvenanceConflictError();
          }
          return {
            projection: toTerminalEvent(
              "refund",
              row.id,
              row.sale_id,
              row.refunded_at,
              row.pos_refund_amount,
              row.currency_code,
            ),
            created: false,
          };
        }

        const row = inserted.rows[0]!;

        // 015 posting trigger (reversal): a refund terminal event just landed.
        // Same posture as recordVoid — emit IN-TRANSACTION with source_ref_id =
        // the REFUND row's OWN id, so two partial refunds of one sale each get a
        // distinct posting row (REVERSAL-CARDINALITY, data-model §5). Created
        // path only; idempotent downstream via the O-3 unique.
        await emit(client, {
          eventType: OUTBOX_EVENT_TYPES.ERPNEXT_POSTING_REQUESTED,
          tenantId,
          storeId,
          payload: {
            sale_id: saleRef,
            store_id: storeId,
            kind: "reversal",
            source_ref_id: row.id,
          },
          correlationId: null,
        });

        return {
          projection: toTerminalEvent(
            "refund",
            row.id,
            saleRef,
            row.refunded_at,
            row.pos_refund_amount,
            row.currency_code,
          ),
          created: true,
        };
      },
    );
  }
}

interface VoidProvenanceRow {
  id: string;
  sale_id: string;
  voided_at: Date;
}

async function findVoidByProvenance(
  client: PoolClient,
  tenantId: string,
  body: RecordVoidRequestDto,
): Promise<VoidProvenanceRow | null> {
  const r = await client.query<VoidProvenanceRow>(
    `SELECT id, sale_id, voided_at FROM sale_voids
      WHERE tenant_id = $1 AND source_system = $2 AND external_id = $3
      LIMIT 1`,
    [tenantId, body.sourceSystem, body.externalId],
  );
  return r.rows[0] ?? null;
}

/**
 * A void provenance is a deterministic REPLAY only if it points at the SAME
 * sale (FR-013). The unique index is (tenant, source_system, external_id) —
 * NOT scoped by sale — so the existing row may belong to a different sale;
 * that is a conflict and never discloses the other sale.
 */
function replayVoid(row: VoidProvenanceRow, saleRef: string): TerminalEventResult {
  if (row.sale_id !== saleRef) {
    throw new TerminalEventProvenanceConflictError();
  }
  return {
    projection: toTerminalEvent("void", row.id, row.sale_id, row.voided_at, null, null),
    created: false,
  };
}

function toBody(
  row: SaleRow,
  lines: ReadonlyArray<SaleLineRow>,
  tenders: ReadonlyArray<SaleTenderRow>,
): SaleProjection {
  return {
    saleRef: row.id,
    storeId: row.store_id,
    currencyCode: row.currency_code,
    posTotal: row.pos_total,
    occurredAt: row.occurred_at.toISOString(),
    receivedAt: row.received_at.toISOString(),
    businessDate:
      typeof row.business_date === "string"
        ? row.business_date
        : new Date(row.business_date).toISOString().slice(0, 10),
    processedAt: row.processed_at ? row.processed_at.toISOString() : null,
    sourceClockAt: row.source_clock_at ? row.source_clock_at.toISOString() : null,
    sourceSystem: row.source_system,
    externalId: row.external_id,
    mismatchFlag: row.mismatch_flag ?? false,
    syncStatus: row.sync_status,
    voided: row.voided,
    lines: lines.map((l) => ({
      lineRef: l.line_ref,
      lineName: l.line_name,
      unitPrice: l.unit_price,
      currencyCode: l.currency_code,
      quantity: l.quantity,
      lineAmount: l.line_amount,
      taxAmount: l.tax_amount,
      unit: l.unit,
      tenantProductRef: l.tenant_product_ref,
      returnedQuantity: l.returned_quantity,
      returnableQuantity: l.returnable_quantity,
    })),
    tenders: tenders.map((t) => ({
      method: t.method,
      amount: t.amount,
      ...(t.reference === null ? {} : { reference: t.reference }),
    })),
  };
}

/** A tender's reference, or null — only card_external carries one. */
function tenderReference(t: SaleTenderDto): string | null {
  return t.method === "card_external" ? (t.reference ?? null) : null;
}

/** RT-77: Σ tender amounts = posTotal exactly, in Postgres numeric; else 422. */
async function assertTendersMatchTotal(
  client: PoolClient,
  tenders: ReadonlyArray<SaleTenderDto>,
  posTotal: string,
): Promise<void> {
  const r = await client.query<{ matches: boolean }>(
    `SELECT (SELECT SUM(a) FROM unnest($1::numeric[]) a) = $2::numeric AS matches`,
    [tenders.map((t) => t.amount), posTotal],
  );
  if (r.rows[0]?.matches !== true) throw new SaleTenderMismatchError();
}

/** RT-77: write the sale's tenders in its capture transaction (one row per method). */
async function insertTenders(
  client: PoolClient,
  sale: {
    readonly saleId: string;
    readonly tenantId: string;
    readonly storeId: string;
    readonly currencyCode: string;
    readonly tenders: ReadonlyArray<SaleTenderDto>;
  },
): Promise<void> {
  const { tenders } = sale;
  await client.query(
    `INSERT INTO sale_tenders
       (id, sale_id, tenant_id, store_id, method, amount, currency_code, reference)
     SELECT t.id, $1, $2, $3, t.method, t.amount, $4, t.reference
       FROM unnest($5::uuid[], $6::text[], $7::numeric[], $8::text[])
            AS t(id, method, amount, reference)`,
    [
      sale.saleId,
      sale.tenantId,
      sale.storeId,
      sale.currencyCode,
      tenders.map(() => newId()),
      tenders.map((t) => t.method),
      tenders.map((t) => t.amount),
      tenders.map(tenderReference),
    ],
  );
}

/**
 * RT-77: a provenance replay must carry the tender set that was recorded —
 * compared as a set by (method, numeric amount, reference), so "10.5" and
 * "10.5000" are the same tender. A difference is a different payload (409).
 * The stored `tender_count` settles the common cases without reading
 * sale_tenders: both empty (every legacy replay) is the same payload, and a
 * different count is a conflict.
 */
async function assertSameTenders(
  client: PoolClient,
  winner: { readonly id: string; readonly tender_count: number },
  tenders: ReadonlyArray<SaleTenderDto>,
): Promise<void> {
  if (winner.tender_count !== tenders.length) throw new SaleTenderReplayConflictError();
  if (tenders.length === 0) return;
  const saleId = winner.id;
  const r = await client.query<{ same: boolean }>(
    `WITH req AS (
       SELECT * FROM unnest($2::text[], $3::numeric[], $4::text[]) AS r(method, amount, reference)
     ), stored AS (
       SELECT method, amount::numeric AS amount, reference FROM sale_tenders WHERE sale_id = $1
     )
     SELECT NOT EXISTS (
       (SELECT method, amount, reference FROM req
        EXCEPT SELECT method, amount, reference FROM stored)
       UNION ALL
       (SELECT method, amount, reference FROM stored
        EXCEPT SELECT method, amount, reference FROM req)
     ) AS same`,
    [
      saleId,
      tenders.map((t) => t.method),
      tenders.map((t) => t.amount),
      tenders.map(tenderReference),
    ],
  );
  if (r.rows[0]?.same !== true) throw new SaleTenderReplayConflictError();
}

/** Build the `SaleTerminalEvent` wire projection for a void/refund event. */
function toTerminalEvent(
  kind: "void" | "refund",
  eventRef: string,
  saleRef: string,
  recordedAt: Date,
  posRefundAmount: string | null,
  currencyCode: string | null,
): TerminalEventProjection {
  return {
    eventRef,
    saleRef,
    kind,
    recordedAt: recordedAt.toISOString(),
    posRefundAmount,
    currencyCode,
  };
}
