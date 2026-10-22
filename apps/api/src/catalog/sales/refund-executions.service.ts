/**
 * RefundExecutionsService — refund executions and the return reads (Jira
 * RT-787; RT-271 R-1, R-3, R-4, R-7, R-8; `pos-sales/sales.yaml`
 * 1.13.0-draft `recordRefundExecution`, `listSaleReturns`,
 * `readReturnByProvenance`).
 *
 * `recordExecution` runs in one transaction under the tenant GUC (RLS) and the
 * `sales` row lock (`lockSaleForReversal`, the R-5 lock), in the contract's
 * order:
 *   1. the sale resolves in the caller's (tenant, store) scope and the return
 *      is a `recordReturn` return of it, else a non-disclosing 404;
 *   2. provenance replay (R-3): the same provenance and payload on the same
 *      return replays (200); a changed payload, another return, or an
 *      `executionRef` already recorded under another provenance → 409;
 *   3. the allocation is one of the return's, `paidAt` ≤ server clock + 120 s,
 *      and one `shiftRef` per return (R-9, execution side) → else 400;
 *   4. the allocation's settled executions, this one included, never exceed
 *      its amount → else 422.
 * Then the append-only insert and, for a return deferred at acceptance, the
 * R-7 posting emit by the execution that settles it. `settles_return` is
 * unique per return in the database, so the emit happens exactly once.
 * A refusal records nothing.
 */
import { Inject, Injectable } from "@nestjs/common";
import { runWithTenantContext } from "@data-pulse-2/db";
import { newId } from "@data-pulse-2/shared";
import type { Pool, PoolClient } from "pg";

import { PG_POOL } from "../../auth/auth.module";
import type {
  RecordRefundExecutionRequestDto,
  ReturnProvenanceQueryDto,
} from "./dto/record-refund-execution-request.dto";
import { sha256CanonicalHex } from "./payload-hash";
import {
  findOrdinaryReturnByProvenance,
  listOrdinaryReturnIds,
  loadRefundExecution,
  loadReturnRead,
  type RefundExecutionProjection,
  type ReturnReadProjection,
} from "./return-reads";
import { SaleNotFoundError, TerminalEventProvenanceConflictError } from "./sale-errors";
import { emitReturnPosting } from "./sale-returns.service";
import { lockSaleForReversal } from "./sale-reversal";

/** Check 3: the execution names no allocation of the return, or its evidence is refused → 400. */
export class RefundExecutionInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RefundExecutionInvalidError";
  }
}

/** Check 4: the allocation would be over-settled → 422 refund_execution_exceeds_allocation. */
export class RefundExecutionExceedsAllocationError extends Error {
  constructor() {
    super("the allocation's settled executions would exceed its amount");
    this.name = "RefundExecutionExceedsAllocationError";
  }
}

/** How far a device's `paidAt` may run ahead of the server clock. */
const PAID_AT_MAX_AHEAD_SECONDS = 120;

export interface RecordExecutionInput {
  readonly tenantId: string;
  readonly storeId: string;
  readonly actorUserId: string;
  readonly saleRef: string;
  readonly returnRef: string;
  readonly body: RecordRefundExecutionRequestDto;
}

export interface RefundExecutionResult {
  readonly projection: RefundExecutionProjection;
  /** false when a re-delivery resolved to an existing execution. */
  readonly created: boolean;
}

interface Scope {
  readonly tenantId: string;
  readonly storeId: string;
  readonly saleRef: string;
}

interface ReturnHead {
  readonly id: string;
  readonly return_total: string;
  readonly posting_deferred: boolean;
}

interface Allocation {
  readonly id: string;
}

@Injectable()
export class RefundExecutionsService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  recordExecution(input: RecordExecutionInput): Promise<RefundExecutionResult> {
    const { tenantId, storeId, saleRef, body } = input;
    const payloadHash = sha256CanonicalHex(body);
    return runWithTenantContext(this.pool, { tenantId, isPlatformAdmin: false }, async (client) => {
      await lockSaleForReversal(client, saleRef, storeId);
      const ret = await findReturnOfSale(client, saleRef, input.returnRef);
      const identity = { tenantId, body, returnId: ret.id, payloadHash };
      const prior = await findPriorExecution(client, identity);
      if (prior) return { projection: await loadRefundExecution(client, prior), created: false };

      const allocation = await findAllocation(client, ret.id, body.allocationRef);
      await assertEvidence(client, ret.id, body.evidence);
      const settles = await checkAmount(client, { ret, allocation, amount: body.amount });

      const executionId = await insertExecution(client, { input, ret, allocation, payloadHash, settles });
      if (executionId === null) {
        // The same provenance or executionRef was recorded concurrently under
        // another sale's lock: replay it if it is this execution, else 409.
        const winner = await findPriorExecution(client, identity);
        if (!winner) throw new TerminalEventProvenanceConflictError();
        return { projection: await loadRefundExecution(client, winner), created: false };
      }
      if (settles) {
        await emitReturnPosting(client, { tenantId, storeId, saleRef, returnId: ret.id });
      }
      return { projection: await loadRefundExecution(client, executionId), created: true };
    });
  }

  /** `listSaleReturns`: every `recordReturn` return of the sale, oldest first. */
  listSaleReturns(scope: Scope): Promise<ReturnReadProjection[]> {
    return this.read(scope, async (client) => {
      const ids = await listOrdinaryReturnIds(client, scope.saleRef);
      // One client: pg runs the queries in order; the result keeps the id order.
      return Promise.all(ids.map((id) => loadReturnRead(client, id)));
    });
  }

  /** `readReturnByProvenance`: null when no `recordReturn` return of THIS sale has it. */
  readReturnByProvenance(
    scope: Scope,
    provenance: ReturnProvenanceQueryDto,
  ): Promise<ReturnReadProjection | null> {
    return this.read(scope, async (client) => {
      const id = await findOrdinaryReturnByProvenance(client, scope.saleRef, provenance);
      return id === null ? null : loadReturnRead(client, id);
    });
  }

  /** Resolve the sale in the caller's (tenant via RLS, store via predicate) scope, then read. */
  private read<T>(scope: Scope, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return runWithTenantContext(this.pool, { tenantId: scope.tenantId, isPlatformAdmin: false }, async (client) => {
      const sale = await client.query(`SELECT 1 FROM sales WHERE id = $1 AND store_id = $2`, [
        scope.saleRef,
        scope.storeId,
      ]);
      if (sale.rowCount === 0) throw new SaleNotFoundError();
      return fn(client);
    });
  }
}

/** Check 1: a `recordReturn` return of THIS sale (a credit reversal's return is outside RT-490). */
async function findReturnOfSale(client: PoolClient, saleRef: string, returnRef: string): Promise<ReturnHead> {
  const r = await client.query<ReturnHead>(
    `SELECT r.id::text AS id, r.return_total::text AS return_total, r.posting_deferred
       FROM sale_returns r
      WHERE r.id = $1 AND r.sale_id = $2
        AND NOT EXISTS (SELECT 1 FROM sale_credit_reversals c WHERE c.return_id = r.id)`,
    [returnRef, saleRef],
  );
  const row = r.rows[0];
  if (!row) throw new SaleNotFoundError();
  return row;
}

/**
 * Check 2: the id of the execution this request replays, null when it is new.
 * The provenance or the `executionRef` already recorded with anything else is
 * a 409. A replay is never re-checked against checks 3 and 4.
 */
async function findPriorExecution(client: PoolClient, identity: ExecutionIdentity): Promise<string | null> {
  const { tenantId, body } = identity;
  const r = await client.query<StoredIdentity>(
    `SELECT id::text AS id, return_id::text AS return_id, payload_hash, execution_ref::text AS execution_ref
       FROM refund_executions
      WHERE tenant_id = $1
        AND ((source_system = $2 AND external_id = $3) OR execution_ref = $4)`,
    [tenantId, body.sourceSystem, body.externalId, body.executionRef],
  );
  if (r.rows.length === 0) return null;
  // Two rows: the provenance and the executionRef name different executions.
  if (r.rows.length !== 1) throw new TerminalEventProvenanceConflictError();
  const stored = r.rows[0]!;
  if (!isSameExecution(stored, identity)) throw new TerminalEventProvenanceConflictError();
  return stored.id;
}

interface ExecutionIdentity {
  readonly tenantId: string;
  readonly body: RecordRefundExecutionRequestDto;
  readonly returnId: string;
  readonly payloadHash: string;
}

interface StoredIdentity {
  readonly id: string;
  readonly return_id: string;
  readonly payload_hash: string;
  readonly execution_ref: string;
}

/** The stored row is this request: same return, same payload, same executionRef. */
function isSameExecution(stored: StoredIdentity, identity: ExecutionIdentity): boolean {
  if (stored.return_id !== identity.returnId) return false;
  if (stored.payload_hash !== identity.payloadHash) return false;
  return stored.execution_ref.toLowerCase() === identity.body.executionRef.toLowerCase();
}

/** Check 3a: `allocationRef` names an allocation of THIS return. */
async function findAllocation(client: PoolClient, returnId: string, allocationRef: string): Promise<Allocation> {
  const r = await client.query<Allocation>(
    `SELECT id::text AS id FROM sale_return_tenders WHERE return_id = $1 AND allocation_ref = $2`,
    [returnId, allocationRef],
  );
  const row = r.rows[0];
  if (!row) throw new RefundExecutionInvalidError("allocationRef is not an allocation of this return");
  return row;
}

/** Checks 3b and 3c: `paidAt` is not ahead of the server clock by more than 120 s; one shift per return. */
async function assertEvidence(
  client: PoolClient,
  returnId: string,
  evidence: RecordRefundExecutionRequestDto["evidence"],
): Promise<void> {
  const r = await client.query<{ in_time: boolean; other_shift: boolean }>(
    `SELECT $2::timestamptz <= clock_timestamp() + make_interval(secs => $4) AS in_time,
            EXISTS (SELECT 1 FROM refund_executions
                     WHERE return_id = $1 AND shift_ref <> $3::uuid) AS other_shift`,
    [returnId, evidence.paidAt, evidence.shiftRef, PAID_AT_MAX_AHEAD_SECONDS],
  );
  const row = r.rows[0];
  if (!row?.in_time) throw new RefundExecutionInvalidError("evidence.paidAt is ahead of the server clock");
  if (row.other_shift) {
    throw new RefundExecutionInvalidError("every execution of a return carries the same evidence.shiftRef");
  }
}

/**
 * Check 4, under the `sales` lock: the allocation's executions plus this one
 * stay within its amount. Returns whether this execution settles a return
 * deferred at acceptance (R-7): its executions then reach the return total.
 */
async function checkAmount(
  client: PoolClient,
  args: { ret: ReturnHead; allocation: Allocation; amount: string },
): Promise<boolean> {
  const r = await client.query<{ within: boolean; settles: boolean }>(
    `SELECT a.amount - COALESCE((SELECT SUM(e.amount) FROM refund_executions e
                                  WHERE e.allocation_id = a.id), 0) - $2::numeric >= 0 AS within,
            COALESCE((SELECT SUM(e.amount) FROM refund_executions e WHERE e.return_id = a.return_id), 0)
              + $2::numeric = $3::numeric AS settles
       FROM sale_return_tenders a WHERE a.id = $1`,
    [args.allocation.id, args.amount, args.ret.return_total],
  );
  const row = r.rows[0];
  if (!row?.within) throw new RefundExecutionExceedsAllocationError();
  return args.ret.posting_deferred && row.settles;
}

/** The append-only insert; null when the provenance or executionRef already exists (a race). */
async function insertExecution(
  client: PoolClient,
  args: {
    input: RecordExecutionInput;
    ret: ReturnHead;
    allocation: Allocation;
    payloadHash: string;
    settles: boolean;
  },
): Promise<string | null> {
  const { input, ret, allocation, payloadHash, settles } = args;
  const { body } = input;
  // recorded_at is clock_timestamp(), taken under the sales lock, so the
  // (recordedAt, executionRef) order is the order the executions committed.
  const r = await client.query<{ id: string }>(
    `INSERT INTO refund_executions
       (id, execution_ref, return_id, allocation_id, sale_id, tenant_id, store_id,
        allocation_ref, amount, outcome, evidence_method, paid_at, shift_ref,
        source_system, external_id, payload_hash, created_by, settles_return, recorded_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::numeric, $10, $11, $12::timestamptz, $13,
             $14, $15, $16, $17, $18, clock_timestamp())
     ON CONFLICT DO NOTHING
     RETURNING id::text AS id`,
    [
      newId(),
      body.executionRef,
      ret.id,
      allocation.id,
      input.saleRef,
      input.tenantId,
      input.storeId,
      body.allocationRef,
      body.amount,
      body.outcome,
      body.evidence.method,
      body.evidence.paidAt,
      body.evidence.shiftRef,
      body.sourceSystem,
      body.externalId,
      payloadHash,
      input.actorUserId,
      settles,
    ],
  );
  return r.rows[0]?.id ?? null;
}
