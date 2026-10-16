/**
 * RT-539 — the receipt reprint record (`recordSaleReprint`, RT-537 D-7;
 * OD-534-2/3/7/8), run on the caller's tenant-scoped client.
 *
 * Order of the decision:
 *   1. the sale must be visible to the caller (else `not_visible`, the 404);
 *   2. `record` comes ONLY from the sale's own capturing device (a pre-RT-77
 *      sale has none), else `not_capturing_device` (the 403);
 *   3. under a per-sale advisory lock, a reprint already recorded under this
 *      client's Idempotency-Key for this sale (an idempotency-cache miss) is
 *      replayed if the request is the same, else `key_reused` (the 409). It
 *      runs before the eligibility check, so a replay is never refused because
 *      the sale changed since (a void or return after the first reprint);
 *   4. `authorize` of a `duplicate` needs `reprint.duplicate: allowed`, else
 *      `duplicate_unavailable` (the 422);
 *   5. the copy number: a `record` keeps the terminal's own number; an
 *      `authorize` gets the next number among the sale's AUTHORIZED reprints
 *      (Q-5: numbers can repeat across terminals, the audit trail is the
 *      authority), so a terminal-reported number can never push the server's
 *      sequence out of range.
 *
 * Recording a reprint changes no sale, void, return or payment fact and
 * authorizes no payout. Every decision is audited in the same transaction
 * (`sale-history.audit.ts`); a replay is not audited again (never counted
 * twice). The advisory lock (not a row lock on `sales`, which the domain role
 * only reads) serializes copy numbers and the key check per sale.
 */
import { newId } from "@data-pulse-2/shared";
import type { PoolClient } from "pg";

import { insertReprintAudit } from "./sale-history.audit";
import type { ReprintMark } from "./sale-history.projections";
import { loadDetail } from "./sale-history.reads";
import type { RecordReprintInput, ReprintOutcome, SaleReprintProjection } from "./sale-history.types";

const REPRINT_COLUMNS_SQL = "id, mode, kind, marked_voided, marked_returned, copy_number, recorded_at";

interface StoredReprintRow {
  id: string;
  mode: "authorize" | "record";
  kind: "duplicate" | "sale_record";
  marked_voided: boolean;
  marked_returned: boolean;
  copy_number: number;
  recorded_at: Date;
}

/** Decide, write and audit one reprint request inside the caller's transaction. */
export async function recordReprintInTransaction(
  client: PoolClient,
  input: RecordReprintInput,
): Promise<ReprintOutcome> {
  const outcome = await decideReprint(client, input);
  if (outcome.ok && outcome.replayed) return outcome;
  const common = {
    sale_ref: input.saleRef,
    device_id: input.deviceId,
    visibility: input.visibility.kind,
  };
  await insertReprintAudit(client, {
    tenantId: input.tenantId,
    storeId: input.storeId,
    actorUserId: input.actorUserId,
    requestId: input.requestId,
    metadata: outcome.ok
      ? {
          ...common,
          outcome: "recorded",
          mode: outcome.projection.mode,
          kind: outcome.projection.kind,
          marks: outcome.projection.marks,
          copy_number: outcome.projection.copyNumber,
        }
      : { ...common, outcome: "refused", reason: outcome.reason, mode: input.body.mode, kind: input.body.kind },
  });
  return outcome;
}

async function decideReprint(client: PoolClient, input: RecordReprintInput): Promise<ReprintOutcome> {
  const detail = await loadDetail(client, input, input.saleRef);
  if (detail === null) return { ok: false, reason: "not_visible" };
  const { body } = input;
  if (body.mode === "record" && detail.row.device_id !== input.deviceId) {
    return { ok: false, reason: "not_capturing_device" };
  }

  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`sale_reprints:${input.saleRef}`]);
  const existing = await findByKey(client, input);
  if (existing !== null) {
    return existing.same
      ? { ok: true, projection: toReprint(existing, input.saleRef), replayed: true }
      : { ok: false, reason: "key_reused" };
  }

  const { reprint } = detail.projection;
  if (isUnavailableDuplicate(input, reprint.duplicate)) return { ok: false, reason: "duplicate_unavailable" };
  const row = await insertReprint(client, input, reprint.marks);
  return { ok: true, projection: toReprint(row, input.saleRef), replayed: false };
}

/** An `authorize` for a duplicate the sale cannot have (incomplete facts, or voided). */
function isUnavailableDuplicate(input: RecordReprintInput, duplicate: string): boolean {
  return input.body.mode === "authorize" && input.body.kind === "duplicate" && duplicate !== "allowed";
}

async function insertReprint(
  client: PoolClient,
  input: RecordReprintInput,
  marks: ReadonlyArray<ReprintMark>,
): Promise<StoredReprintRow> {
  const { body } = input;
  // The schema requires localCopyNumber with `record` and forbids it with `authorize` (Q-5).
  const copyNumber = body.localCopyNumber ?? (await nextAuthorizedCopyNumber(client, input));
  const inserted = await client.query<StoredReprintRow>(
    `INSERT INTO sale_reprints
       (id, sale_id, tenant_id, store_id, mode, kind, marked_voided, marked_returned,
        copy_number, printed_at, created_by, device_id, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::timestamptz, $11, $12, $13)
     RETURNING ${REPRINT_COLUMNS_SQL}`,
    [
      newId(),
      input.saleRef,
      input.tenantId,
      input.storeId,
      body.mode,
      body.kind,
      marks.includes("voided"),
      marks.includes("returned"),
      copyNumber,
      body.printedAt,
      input.actorUserId,
      input.deviceId,
      input.idempotencyKey,
    ],
  );
  return inserted.rows[0]!;
}

/**
 * The reprint already recorded under this client's key for this sale, if any,
 * and whether this request is the same one (mode, kind, printed instant and,
 * for a `record`, the copy number). The instant is compared in Postgres, at
 * its stored microsecond precision.
 */
async function findByKey(
  client: PoolClient,
  input: RecordReprintInput,
): Promise<(StoredReprintRow & { same: boolean }) | null> {
  const { body } = input;
  const r = await client.query<StoredReprintRow & { same: boolean }>(
    `SELECT ${REPRINT_COLUMNS_SQL},
            (mode = $6 AND kind = $7 AND printed_at = $8::timestamptz
             AND ($6 = 'authorize' OR copy_number = $9::int)) AS same
       FROM sale_reprints
      WHERE tenant_id = $1 AND store_id = $2 AND sale_id = $3 AND created_by = $4 AND idempotency_key = $5`,
    [
      input.tenantId,
      input.storeId,
      input.saleRef,
      input.actorUserId,
      input.idempotencyKey,
      body.mode,
      body.kind,
      body.printedAt,
      body.localCopyNumber ?? null,
    ],
  );
  return r.rows[0] ?? null;
}

/** Q-5: the server's next number among the sale's authorized reprints. */
async function nextAuthorizedCopyNumber(client: PoolClient, input: RecordReprintInput): Promise<number> {
  const r = await client.query<{ next: number }>(
    `SELECT COALESCE(MAX(copy_number) FILTER (WHERE mode = 'authorize'), 0) + 1 AS next
       FROM sale_reprints WHERE sale_id = $1 AND tenant_id = $2 AND store_id = $3`,
    [input.saleRef, input.tenantId, input.storeId],
  );
  return r.rows[0]?.next ?? 1;
}

function toReprint(row: StoredReprintRow, saleRef: string): SaleReprintProjection {
  const marks: ReprintMark[] = [];
  if (row.marked_voided) marks.push("voided");
  if (row.marked_returned) marks.push("returned");
  return {
    reprintRef: row.id,
    saleRef,
    mode: row.mode,
    kind: row.kind,
    marks,
    copyNumber: row.copy_number,
    recordedAt: row.recorded_at.toISOString(),
  };
}
