/**
 * ReceivableService — 035 T030.
 *
 * Opens receivables from a POS settlement intent and serves the Console
 * read/list projections. Mirrors ErpnextWarehouseMapService:
 *   - one `runWithTenantContext(this.pool, {tenantId, isPlatformAdmin:false}, …)`
 *     per operation (fail-closed RLS via `app.current_tenant`);
 *   - discriminated-union results (`{kind:"ok"|"conflict"|"not_found", …}`) —
 *     the service NEVER throws HttpException; the controller maps to HTTP;
 *   - snake_case DbRow → camelCase via `toRow`;
 *   - `isPgCode(err, "23503")` catch on the composite sale FK.
 *
 * IDEMPOTENCY: settlement intent reserves a durable operation in the existing
 * PostgreSQL `idempotency_keys` table and completes that record together with
 * receivable creation in one transaction. Redis remains an HTTP replay cache,
 * never the financial deduplication boundary.
 *
 * CARVE: receivables open in state 'open' only (no `reversal_consumed`, §OQ-4).
 * The sale fact is NEVER mutated (FR-006) — this writes only `receivable` rows.
 */
import { Inject, Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";

import { runWithTenantContext } from "@data-pulse-2/db";
import { newId } from "@data-pulse-2/shared";

import { PG_POOL } from "../auth/auth.module";
import { recordSettlementReceivable } from "../observability/metrics/api.metrics";
import { decideApplication } from "./apply-payment-decision";
import type { ReceivableRow } from "./dto/receivable.dto";
import { INITIAL_RECEIVABLE_STATE, type ReceivableState } from "./receivable-state-machine";
import { insertSettlementAudit } from "./transactional-audit";

// ---------------------------------------------------------------------------
// DB row shape (snake_case) → service row (camelCase)
// ---------------------------------------------------------------------------

interface DbRow {
  id: string;
  sale_id: string;
  payer_id: string;
  outstanding_balance: string;
  state: ReceivableState;
  erpnext_payment_entry_ref: string | null;
  tax_placeholder: Record<string, unknown> | null;
  version: number;
}

const SELECT_COLS = `id, sale_id, payer_id, outstanding_balance, state,
  erpnext_payment_entry_ref, tax_placeholder, version`;

function toRow(r: DbRow): ReceivableRow {
  return {
    id: r.id,
    saleId: r.sale_id,
    payerId: r.payer_id,
    outstandingBalance: r.outstanding_balance,
    state: r.state,
    erpnextPaymentEntryRef: r.erpnext_payment_entry_ref,
    taxPlaceholder: r.tax_placeholder,
    version: r.version,
  };
}

function isPgCode(err: unknown, code: string): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === code
  );
}

// ---------------------------------------------------------------------------
// Inputs + result discriminated unions
// ---------------------------------------------------------------------------

export interface IntentPayerInput {
  readonly payerRef: string;
  readonly owedAmount: string;
  readonly claimMetadata?: Record<string, unknown> | null;
}

export interface OpenIntentInput {
  readonly tenantId: string;
  readonly storeId: string;
  readonly operation: {
    readonly idempotencyKey: string;
    readonly actorUserId: string;
    readonly requestId: string | null;
  };
  readonly saleRef: string;
  readonly payers: readonly IntentPayerInput[];
}

/** open-from-intent: ok (N receivables) | conflict (unknown payer / bad sale). */
export type OpenIntentResult =
  | { kind: "ok"; rows: ReceivableRow[] }
  | { kind: "conflict" }
  | { kind: "idempotency_conflict" };

interface DurableIntentBody {
  kind: "settlement_intent";
  saleRef: string;
  rows: DbRow[];
}

class SettlementReferenceConflictError extends Error {}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function requestHash(input: OpenIntentInput): Buffer {
  return sha256(
    canonicalJson({
      saleRef: input.saleRef,
      payers: input.payers.map((payer) => ({
        payerRef: payer.payerRef,
        owedAmount: payer.owedAmount,
        claimMetadata: payer.claimMetadata ?? null,
      })),
    }),
  );
}

function durableKey(rawKey: string): string {
  return `settlement-intent:${sha256(rawKey).toString("hex")}`;
}

function readDurableIntentBody(value: unknown): DurableIntentBody {
  const body = value as Partial<DurableIntentBody> | null;
  if (
    body?.kind !== "settlement_intent" ||
    typeof body.saleRef !== "string" ||
    !Array.isArray(body.rows)
  ) {
    throw new Error("ReceivableService.openFromIntent: invalid durable response body");
  }
  return body as DurableIntentBody;
}

export type GetResult = { kind: "ok"; row: ReceivableRow } | { kind: "not_found" };

export interface ApplyPaymentInput {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly requestId: string | null;
  readonly receivableRef: string;
  readonly amount: string;
  readonly version: number;
  readonly note?: string | null;
}

/**
 * apply-payment (7-C): ok (updated receivable) | not_found (RLS-filtered /
 * fabricated id) | conflict (stale version / already terminal / over-application).
 */
export type ApplyPaymentResult =
  | { kind: "ok"; row: ReceivableRow }
  | { kind: "not_found" }
  | { kind: "conflict" };

export interface ListInput {
  readonly tenantId: string;
  readonly storeId?: string;
  readonly state?: ReceivableState;
  readonly payerRef?: string;
  readonly cursor: string | null;
  readonly limit: number;
}

export interface ReceivablePage {
  readonly items: ReceivableRow[];
  readonly nextCursor: string | null;
}

const LIST_MAX_PAGE = 200;

@Injectable()
export class ReceivableService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /**
   * Open one receivable per payer from a captured sale's settlement intent, in
   * ONE transaction (all-or-nothing). Each payer is scope-checked in-tenant
   * first (RLS-filtered SELECT) — an unknown / cross-tenant payer is a
   * deterministic `conflict` (the contract's 409 unknown-payer; the POS route
   * has NO 404), never a silent post to the wrong account. A composite-FK
   * violation on the sale (unknown / cross-tenant sale) raises 23503 and is
   * likewise collapsed to `conflict` (the POS route has no 404). The sale is
   * never mutated.
   */
  async openFromIntent(input: OpenIntentInput): Promise<OpenIntentResult> {
    const fingerprint = requestHash(input);
    const operationKey = durableKey(input.operation.idempotencyKey);

    try {
      const result = await runWithTenantContext(
        this.pool,
        { tenantId: input.tenantId, isPlatformAdmin: false },
        async (client): Promise<OpenIntentResult> => {
          // Reserve the operation before creating any financial fact. The
          // idempotency row and receivables share this transaction, so neither
          // can commit without the other. The UNIQUE constraint serializes
          // concurrent requests with the same operation identity.
          const reservation = await client.query<{ id: string }>(
            `INSERT INTO idempotency_keys
               (id, tenant_id, store_id, client_id, key, request_hash,
                response_status, response_body, expires_at)
             VALUES ($1, $2, $3, $4, $5, $6, 201, $7::jsonb, 'infinity')
             ON CONFLICT (tenant_id, store_id, client_id, key) DO NOTHING
             RETURNING id`,
            [
              newId(),
              input.tenantId,
              input.storeId,
              input.operation.actorUserId,
              operationKey,
              fingerprint,
              JSON.stringify({ state: "pending" }),
            ],
          );

          if (reservation.rows.length === 0) {
            const existing = await client.query<{
              request_hash: Buffer;
              response_body: unknown;
            }>(
              `SELECT request_hash, response_body
                 FROM idempotency_keys
                WHERE tenant_id = $1
                  AND store_id = $2
                  AND client_id = $3
                  AND key = $4
                FOR UPDATE`,
              [
                input.tenantId,
                input.storeId,
                input.operation.actorUserId,
                operationKey,
              ],
            );
            const prior = existing.rows[0];
            if (!prior) {
              throw new Error(
                "ReceivableService.openFromIntent: idempotency conflict row disappeared",
              );
            }
            if (!prior.request_hash.equals(fingerprint)) {
              return { kind: "idempotency_conflict" };
            }
            const persisted = readDurableIntentBody(prior.response_body);
            return { kind: "ok", rows: persisted.rows.map(toRow) };
          }

          // Validate all references while the reservation is still uncommitted.
          // A validation conflict is thrown so runWithTenantContext rolls the
          // reservation back together with every other write.
          if (!(await this.saleInScope(client, input.saleRef, input.storeId))) {
            throw new SettlementReferenceConflictError();
          }
          for (const payer of input.payers) {
            const ok = await this.payerInScope(client, payer.payerRef, input.storeId);
            if (!ok) throw new SettlementReferenceConflictError();
          }

          const dbRows: DbRow[] = [];
          for (const payer of input.payers) {
            const inserted = await client.query<DbRow>(
              `INSERT INTO receivable
                 (id, tenant_id, store_id, sale_id, payer_id,
                  outstanding_balance, state, tax_placeholder, version)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0)
               RETURNING ${SELECT_COLS}`,
              [
                newId(),
                input.tenantId,
                input.storeId,
                input.saleRef,
                payer.payerRef,
                payer.owedAmount,
                INITIAL_RECEIVABLE_STATE,
                null,
              ],
            );
            const row = inserted.rows[0];
            if (!row) {
              throw new Error("ReceivableService.openFromIntent: insert returned no row");
            }
            dbRows.push(row);
          }

          const durableBody: DurableIntentBody = {
            kind: "settlement_intent",
            saleRef: input.saleRef,
            rows: dbRows,
          };
          const completed = await client.query(
            `UPDATE idempotency_keys
                SET response_body = $1::jsonb
              WHERE tenant_id = $2
                AND store_id = $3
                AND client_id = $4
                AND key = $5`,
            [
              JSON.stringify(durableBody),
              input.tenantId,
              input.storeId,
              input.operation.actorUserId,
              operationKey,
            ],
          );
          if (completed.rowCount !== 1) {
            throw new Error(
              "ReceivableService.openFromIntent: durable result update failed",
            );
          }

          await insertSettlementAudit(client, {
            tenantId: input.tenantId,
            storeId: input.storeId,
            actorUserId: input.operation.actorUserId,
            requestId: input.operation.requestId,
            action: "settlement.intent.recorded",
            targetType: "sales",
            targetId: input.saleRef,
            metadata: { receivable_ids: dbRows.map((row) => row.id) },
          });

          return { kind: "ok", rows: dbRows.map(toRow) };
        },
      );
      if (result.kind === "ok") recordSettlementReceivable();
      return result;
    } catch (err: unknown) {
      if (err instanceof SettlementReferenceConflictError || isPgCode(err, "23503")) {
        return { kind: "conflict" };
      }
      throw err;
    }
  }

  /**
   * Apply a payment/cash against one receivable (7-C, DP-2-owned operational
   * truth) in ONE tx. Version-guarded (§III): the row is read FOR UPDATE with
   * the caller's expected version; a missing row is `not_found`, a wrong
   * version OR an already-terminal (settled/flagged) row is `conflict`. The
   * pure `decideApplication` computes the new balance + state; over-application
   * (amount > balance) is a deterministic `conflict` (no truncation, the
   * contract's 409) with NO write. On success: insert a `payment_application`
   * ledger row (store_id derived from the receivable, never the body) + UPDATE
   * the balance/state/version++. Idempotency is the HTTP interceptor's job;
   * this is the single-shot writer.
   */
  async applyPayment(input: ApplyPaymentInput): Promise<ApplyPaymentResult> {
    const result = await runWithTenantContext(
      this.pool,
      { tenantId: input.tenantId, isPlatformAdmin: false },
      async (client): Promise<ApplyPaymentResult> => {
        // Lock the receivable row (RLS-filtered → cross-tenant returns 0 rows).
        const current = await client.query<DbRow & { store_id: string }>(
          `SELECT ${SELECT_COLS}, store_id
             FROM receivable WHERE id = $1::uuid FOR UPDATE`,
          [input.receivableRef],
        );
        const row = current.rows[0];
        if (!row) return { kind: "not_found" };

        // Stale version OR already-terminal receivable → conflict (no write).
        if (
          row.version !== input.version ||
          row.state === "settled" ||
          row.state === "flagged"
        ) {
          return { kind: "conflict" };
        }

        const decision = decideApplication({
          outstandingBalance: row.outstanding_balance,
          amount: input.amount,
          currentState: row.state,
        });
        if (decision.kind === "over_application") {
          return { kind: "conflict" };
        }

        // Append the cash-application ledger row (store_id from the receivable).
        await client.query(
          `INSERT INTO payment_application
             (id, tenant_id, store_id, receivable_id, applied_amount, note)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            newId(),
            input.tenantId,
            row.store_id,
            input.receivableRef,
            input.amount,
            input.note ?? null,
          ],
        );

        // Reduce the balance + advance state, version++ (optimistic guard again).
        const updated = await client.query<DbRow>(
          `UPDATE receivable
              SET outstanding_balance = $2,
                  state               = $3,
                  version             = version + 1,
                  updated_at          = now()
            WHERE id = $1::uuid AND version = $4
           RETURNING ${SELECT_COLS}`,
          [input.receivableRef, decision.newBalance, decision.newState, input.version],
        );
        // The FOR UPDATE lock makes a 0-row result here impossible, but guard.
        const updatedRow = updated.rows[0];
        if (!updatedRow) return { kind: "conflict" };
        await insertSettlementAudit(client, {
          tenantId: input.tenantId,
          storeId: row.store_id,
          actorUserId: input.actorUserId,
          requestId: input.requestId,
          action: "settlement.payment.applied",
          targetType: "receivable",
          targetId: input.receivableRef,
          metadata: { payment_amount: input.amount, version: updatedRow.version },
        });
        return { kind: "ok", row: toRow(updatedRow) };
      },
    );
    // Post-commit signal — one increment per successful cash application (035 §7).
    if (result.kind === "ok") recordSettlementReceivable();
    return result;
  }

  /** Read one receivable's projection — RLS-filtered (cross-tenant → not_found). */
  async getOne(input: { tenantId: string; receivableRef: string }): Promise<GetResult> {
    return runWithTenantContext(
      this.pool,
      { tenantId: input.tenantId, isPlatformAdmin: false },
      async (client): Promise<GetResult> => {
        const r = await client.query<DbRow>(
          `SELECT ${SELECT_COLS} FROM receivable WHERE id = $1::uuid LIMIT 1`,
          [input.receivableRef],
        );
        return r.rows[0] ? { kind: "ok", row: toRow(r.rows[0]) } : { kind: "not_found" };
      },
    );
  }

  /**
   * List the tenant's receivables, newest-first, keyset paginated. Optional
   * store_id / state / payer_ref filters. Scope (tenant) is the GUC; store is a
   * column value + the filter `WHERE`. `nextCursor` is the last id when the page
   * is full, else null.
   */
  async list(input: ListInput): Promise<ReceivablePage> {
    const limit = Math.min(Math.max(1, input.limit), LIST_MAX_PAGE);
    return runWithTenantContext(
      this.pool,
      { tenantId: input.tenantId, isPlatformAdmin: false },
      async (client): Promise<ReceivablePage> => {
        const r = await client.query<DbRow>(
          `SELECT ${SELECT_COLS} FROM receivable
            WHERE ($1::uuid IS NULL OR store_id = $1::uuid)
              AND ($2::text IS NULL OR state = $2::text)
              AND ($3::uuid IS NULL OR payer_id = $3::uuid)
              AND ($4::uuid IS NULL OR id < $4::uuid)
            ORDER BY id DESC
            LIMIT $5`,
          [
            input.storeId ?? null,
            input.state ?? null,
            input.payerRef ?? null,
            input.cursor,
            limit,
          ],
        );
        const items = r.rows.map(toRow);
        const last = r.rows[r.rows.length - 1];
        const nextCursor = r.rows.length === limit && last ? last.id : null;
        return { items, nextCursor };
      },
    );
  }

  /**
   * Assert a supplied filter `store_id` resolves in the session tenant — under
   * RLS a cross-tenant / out-of-scope id returns no row. Returns false → the
   * controller raises a non-disclosing 404 (contract parameter prose). Null is
   * always in scope.
   */
  async storeInScope(tenantId: string, storeId?: string): Promise<boolean> {
    if (!storeId) return true;
    return runWithTenantContext(
      this.pool,
      { tenantId, isPlatformAdmin: false },
      async (client) => {
        const r = await client.query<{ id: string }>(
          `SELECT id FROM stores WHERE id = $1::uuid LIMIT 1`,
          [storeId],
        );
        return r.rows.length > 0;
      },
    );
  }

  /** Same non-disclosing scope check for a filter `payer_ref`. */
  async payerRefInScope(tenantId: string, payerRef?: string): Promise<boolean> {
    if (!payerRef) return true;
    return runWithTenantContext(
      this.pool,
      { tenantId, isPlatformAdmin: false },
      async (client) => this.payerInScope(client, payerRef),
    );
  }

  /** RLS-filtered sale lookup with explicit store binding. */
  private async saleInScope(
    client: PoolClient,
    saleRef: string,
    storeId: string,
  ): Promise<boolean> {
    const r = await client.query<{ id: string }>(
      `SELECT id FROM sales
        WHERE id = $1::uuid AND store_id = $2::uuid
        LIMIT 1`,
      [saleRef, storeId],
    );
    return r.rows.length > 0;
  }

  /**
   * RLS-filtered existence check for a payer account in the active tenant,
   * scoped to a store. A payer is in-scope for `storeId` iff it is tenant-wide
   * (`store_id IS NULL`) OR scoped to that exact store — a store-X intent may
   * NOT name a store-Y-scoped payer in the same tenant (Codex #579: payer-scope
   * must respect store, not just tenant). When `storeId` is omitted (filter
   * checks), any in-tenant payer is in scope.
   */
  private async payerInScope(
    client: PoolClient,
    payerRef: string,
    storeId?: string,
  ): Promise<boolean> {
    const r = await client.query<{ id: string }>(
      `SELECT id FROM payer_account
        WHERE id = $1::uuid
          AND ($2::uuid IS NULL OR store_id IS NULL OR store_id = $2::uuid)
        LIMIT 1`,
      [payerRef, storeId ?? null],
    );
    return r.rows.length > 0;
  }
}
