/**
 * ErpnextPostingReResolutionService — RT-333 operator re-resolution of a
 * pending posting intent (RT-326 decision 3).
 *
 * ERP Integration baseline: "If an incorrect mapping is discovered before any
 * ERP side effect, an explicit audited re-resolution may create a new
 * resolution version and controlled retry." The operator fixes the mapping,
 * then re-resolves the intent: Backend-Core writes resolution v(n+1)
 * (`resolved_by = 'operator'`) from the CURRENT maps, points the row at it and
 * re-heads its sequence so the connector is offered it again — all with an
 * `audit_events` row in the same transaction.
 *
 * Only a `pending` intent can be re-resolved: a `posted` row has an ERP side
 * effect (reconciliation, never a remap) and a dead-letter goes through repair.
 * A reversal is never re-resolved: it must credit exactly what its sale posted,
 * so its frozen refs are the sale's lineage, not the current maps. Neither is a
 * sale that already has a reversal intent — that reversal's copy is pinned to
 * the sale's current version.
 * A connector post that raced the re-resolution echoes the superseded version
 * on its ack and is recorded for reconciliation, never as posted (RT-332).
 */
import { Inject, Injectable } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";

import { runWithTenantContext } from "@data-pulse-2/db";

import { PG_POOL } from "../../auth/auth.module";
import { MembershipRepository } from "../../context/membership.repository";
import { RepairNotFoundError, type RepairPostingInput } from "./erpnext-reconciliation.service";
import { freezeOperatorResolution, insertAuditEvent, isStoreWritable } from "./posting-resolution.writer";

/** The 409: the intent is not re-resolvable in its current state. */
export class ReResolveConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReResolveConflictError";
  }
}

/** The re-resolution record returned to the operator. */
export interface RecordedReResolution {
  readonly workItemRef: string;
  readonly resolutionVersion: number;
  readonly previousResolutionVersion: number | null;
  readonly recordedAt: string;
}

interface IntentRow {
  readonly status: string;
  readonly kind: "sale_post" | "reversal";
  readonly sale_id: string;
  readonly store_id: string;
  readonly current_resolution_version: number | null;
}

@Injectable()
export class ErpnextPostingReResolutionService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(MembershipRepository) private readonly memberships: MembershipRepository,
  ) {}

  /** Re-resolve one pending posting intent from the current maps. */
  async reResolvePosting(input: RepairPostingInput): Promise<RecordedReResolution> {
    return runWithTenantContext(
      this.pool,
      { tenantId: input.tenantId, isPlatformAdmin: false },
      async (client): Promise<RecordedReResolution> => {
        const row = await this.lockIntent(client, input);
        if (row.status !== "pending") {
          throw new ReResolveConflictError(
            `only a pending posting intent can be re-resolved (this one is ${row.status})`,
          );
        }
        await assertNoReversalLineage(client, row);
        const version = await freezeOperatorResolution(client, {
          tenantId: input.tenantId,
          intentId: input.workItemRef,
          kind: row.kind,
          saleId: row.sale_id,
          storeId: row.store_id,
        });
        if (version === null) {
          throw new ReResolveConflictError("the current mappings do not resolve this posting intent");
        }
        await assertResolutionChanged(client, input.workItemRef, version, row.current_resolution_version);
        return this.record(client, input, version, row.current_resolution_version);
      },
    );
  }

  /** FOR UPDATE: serializes against a concurrent ack / repair of the same row. */
  private async lockIntent(client: PoolClient, input: RepairPostingInput): Promise<IntentRow> {
    const cur = await client.query<IntentRow>(
      `SELECT status, kind, sale_id, store_id, current_resolution_version
         FROM erpnext_posting_status
        WHERE id = $1
        FOR UPDATE`,
      [input.workItemRef],
    );
    const row = cur.rows[0];
    // A work item of a store outside the caller's scope (or of a deleted store)
    // is indistinguishable from a missing one (RT-191, non-disclosing).
    if (!row || !(await isStoreWritable(client, this.memberships, input, row.store_id))) {
      throw new RepairNotFoundError();
    }
    return row;
  }

  /** Point the row at the new version, re-head it with a fresh retry budget, and audit — same transaction. */
  private async record(
    client: PoolClient,
    input: RepairPostingInput,
    version: number,
    previous: number | null,
  ): Promise<RecordedReResolution> {
    const r = await client.query<{ updated_at: Date }>(
      `UPDATE erpnext_posting_status
          SET current_resolution_version = $2, sequence = DEFAULT, retry_count = 0,
              updated_at = now()
        WHERE id = $1
        RETURNING updated_at`,
      [input.workItemRef, version],
    );
    await insertAuditEvent(client, input.tenantId, input.actorUserId, {
      action: "erpnext_reconciliation.posting.re_resolved",
      targetType: "erpnext_posting_status",
      targetId: input.workItemRef,
      metadata: { resolution_version: version, previous_resolution_version: previous },
    });
    return {
      workItemRef: input.workItemRef,
      resolutionVersion: version,
      previousResolutionVersion: previous,
      recordedAt: r.rows[0]!.updated_at.toISOString(),
    };
  }
}

/** A reversal, or a sale a reversal intent already copies, keeps its lineage. */
async function assertNoReversalLineage(client: PoolClient, row: IntentRow): Promise<void> {
  if (row.kind === "reversal") {
    throw new ReResolveConflictError(
      "a reversal follows its sale's resolution and cannot be re-resolved",
    );
  }
  const reversal = await client.query(
    `SELECT 1 FROM erpnext_posting_status WHERE sale_id = $1 AND kind = 'reversal' LIMIT 1`,
    [row.sale_id],
  );
  if (reversal.rows.length > 0) {
    throw new ReResolveConflictError(
      "this sale already has a reversal intent pinned to its current resolution",
    );
  }
}

/**
 * The new version must differ from the current one: an identical re-freeze would
 * only turn an in-flight post of the (still correct) current version into a
 * reconciliation case. Throwing rolls the new version back.
 */
async function assertResolutionChanged(
  client: PoolClient,
  intentId: string,
  version: number,
  previous: number | null,
): Promise<void> {
  if (previous === null) return;
  const diff = await client.query<{ changed: boolean }>(
    `SELECT EXISTS (
       (SELECT sale_line_id, erpnext_item_ref, warehouse_ref
          FROM erpnext_posting_resolution WHERE intent_id = $1 AND resolution_version = $2
        EXCEPT
        SELECT sale_line_id, erpnext_item_ref, warehouse_ref
          FROM erpnext_posting_resolution WHERE intent_id = $1 AND resolution_version = $3)
       UNION ALL
       (SELECT sale_line_id, erpnext_item_ref, warehouse_ref
          FROM erpnext_posting_resolution WHERE intent_id = $1 AND resolution_version = $3
        EXCEPT
        SELECT sale_line_id, erpnext_item_ref, warehouse_ref
          FROM erpnext_posting_resolution WHERE intent_id = $1 AND resolution_version = $2)
     ) AS changed`,
    [intentId, version, previous],
  );
  if (!diff.rows[0]!.changed) {
    throw new ReResolveConflictError("the current mappings already resolve to the frozen version");
  }
}
