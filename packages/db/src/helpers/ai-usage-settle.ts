/**
 * RT-664 — closing an AI usage reservation (AD-AI-ENT-001 D-3 Option A, D-8),
 * shared by the API (commit / release after the provider call) and the worker
 * (the TTL sweeper releases stuck reservations, T17).
 *
 * Runs inside the caller's `runWithTenantContext` transaction, under the
 * reservation's tenant: `ai_usage_ledger` and `ai_usage_counters` are FORCE
 * RLS with tenant-only policies (0055).
 *
 * Serialisation: a transaction-scoped advisory lock on the reservation id.
 * `SELECT … FOR UPDATE` cannot be used here: the ledger has no UPDATE policy
 * and the runtime role holds no UPDATE privilege on it, so a locking read
 * would see no row. The `uq_ai_usage_ledger_one_terminal` partial unique
 * index is the database backstop: at most one terminal row per reservation.
 *
 * Effects (in one transaction):
 *   - `committed` (outcome `ok` only): `reserved -= units`, `used += units`;
 *   - `released` (every other outcome, never charged): `reserved -= units`.
 * `used` only grows here; only a platform-admin `adjusted` row lowers it
 * (RT-664 owns that rule; 0055 does not enforce it).
 */
import type { PoolClient } from "pg";

type Queryable = Pick<PoolClient, "query">;

export type AiUsageTerminalKind = "committed" | "released";

/** Run metadata recorded on the terminal row (AI-09). No prompt or completion text. */
export interface AiUsageTelemetry {
  readonly requestId?: string | null;
  readonly routeKey?: string | null;
  readonly promptTemplateId?: string | null;
  readonly promptTemplateVersion?: string | null;
  readonly outputSchemaId?: string | null;
  readonly outputSchemaVersion?: string | null;
  readonly providerKey?: string | null;
  readonly modelId?: string | null;
  readonly evidenceRefIds?: readonly string[] | null;
  readonly inputTokens?: number | null;
  readonly outputTokens?: number | null;
  readonly cachedInputTokens?: number | null;
  readonly tokenCountSource?: "reported" | "estimated" | null;
  readonly providerRequestId?: string | null;
}

export interface SettleAiReservationInput {
  readonly tenantId: string;
  readonly reservationId: string;
  /** The ledger outcome; `ok` commits, anything else releases. */
  readonly outcome: string;
  readonly telemetry?: AiUsageTelemetry;
  /** The terminal row id (the caller mints it). */
  readonly entryId: string;
}

export interface SettleAiReservationResult {
  readonly kind: AiUsageTerminalKind;
  /** False when the reservation was already closed (a replay or a lost race): nothing changed. */
  readonly applied: boolean;
}

/** Advisory-lock namespace of one reservation's terminal write. */
export const AI_USAGE_RESERVATION_LOCK_NAMESPACE = "ai-usage-reservation";

interface ReservedRow {
  feature_id: string;
  counter_id: string;
  units: number;
  entitlement_version: number;
  opt_out_version: number | null;
  actor_user_id: string | null;
}

async function lockReservation(client: Queryable, reservationId: string): Promise<void> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1 || ':' || $2::text, 0))`, [
    AI_USAGE_RESERVATION_LOCK_NAMESPACE,
    reservationId,
  ]);
}

async function existingTerminal(client: Queryable, input: SettleAiReservationInput): Promise<AiUsageTerminalKind | null> {
  // Repeats the partial index predicate so the lookup uses uq_ai_usage_ledger_one_terminal.
  const r = await client.query<{ entry_kind: AiUsageTerminalKind }>(
    `SELECT entry_kind FROM ai_usage_ledger
      WHERE reservation_id = $1::uuid AND tenant_id = $2::uuid
        AND entry_kind IN ('committed', 'released')`,
    [input.reservationId, input.tenantId],
  );
  return r.rows[0]?.entry_kind ?? null;
}

function telemetryParams(t: AiUsageTelemetry | undefined): unknown[] {
  return [
    t?.requestId ?? null,
    t?.routeKey ?? null,
    t?.promptTemplateId ?? null,
    t?.promptTemplateVersion ?? null,
    t?.outputSchemaId ?? null,
    t?.outputSchemaVersion ?? null,
    t?.providerKey ?? null,
    t?.modelId ?? null,
    t?.evidenceRefIds === undefined || t.evidenceRefIds === null ? null : [...t.evidenceRefIds],
    t?.inputTokens ?? null,
    t?.outputTokens ?? null,
    t?.cachedInputTokens ?? null,
    t?.tokenCountSource ?? null,
    t?.providerRequestId ?? null,
  ];
}

/** A token source only when at least one count is present (0055 `ai_usage_ledger_tokens_sourced`). */
function normalizedTelemetry(t: AiUsageTelemetry | undefined): AiUsageTelemetry | undefined {
  if (t === undefined) return undefined;
  const counted = [t.inputTokens, t.outputTokens, t.cachedInputTokens].some((n) => n !== undefined && n !== null);
  return counted ? { ...t, tokenCountSource: t.tokenCountSource ?? "estimated" } : { ...t, tokenCountSource: null };
}

async function insertTerminal(
  client: Queryable,
  input: SettleAiReservationInput,
  reserved: ReservedRow,
  kind: AiUsageTerminalKind,
): Promise<void> {
  await client.query(
    `INSERT INTO ai_usage_ledger
       (id, tenant_id, reservation_id, entry_kind, feature_id, counter_id, units, entitlement_version,
        opt_out_version, actor_user_id, outcome,
        request_id, route_key, prompt_template_id, prompt_template_version, output_schema_id,
        output_schema_version, provider_key, model_id, evidence_ref_ids, input_tokens, output_tokens,
        cached_input_tokens, token_count_source, provider_request_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
             $12, $13, $14, $15, $16, $17, $18, $19, $20::text[], $21, $22, $23, $24, $25)`,
    [
      input.entryId,
      input.tenantId,
      input.reservationId,
      kind,
      reserved.feature_id,
      reserved.counter_id,
      reserved.units,
      reserved.entitlement_version,
      reserved.opt_out_version,
      reserved.actor_user_id,
      input.outcome,
      ...telemetryParams(normalizedTelemetry(input.telemetry)),
    ],
  );
}

async function moveCounter(client: Queryable, tenantId: string, reserved: ReservedRow, kind: AiUsageTerminalKind): Promise<void> {
  const charged = kind === "committed" ? reserved.units : 0;
  const r = await client.query(
    `UPDATE ai_usage_counters
        SET reserved = reserved - $3, used = used + $4
      WHERE id = $1::uuid AND tenant_id = $2::uuid`,
    [reserved.counter_id, tenantId, reserved.units, charged],
  );
  if (r.rowCount !== 1) throw new Error("ai usage counter of the reservation is not visible");
}

/**
 * Close one reservation: commit for outcome `ok`, release otherwise. Null when
 * the tenant has no such reservation. A reservation already closed is left as
 * it is (`applied: false`): a late commit after the sweeper released it is
 * not charged.
 */
export async function settleAiReservation(
  client: Queryable,
  input: SettleAiReservationInput,
): Promise<SettleAiReservationResult | null> {
  await lockReservation(client, input.reservationId);
  const r = await client.query<ReservedRow>(
    `SELECT feature_id, counter_id, units, entitlement_version, opt_out_version, actor_user_id
       FROM ai_usage_ledger
      WHERE id = $1::uuid AND tenant_id = $2::uuid AND entry_kind = 'reserved'`,
    [input.reservationId, input.tenantId],
  );
  const reserved = r.rows[0];
  if (reserved === undefined) return null;
  const closed = await existingTerminal(client, input);
  if (closed !== null) return { kind: closed, applied: false };
  const kind: AiUsageTerminalKind = input.outcome === "ok" ? "committed" : "released";
  await insertTerminal(client, input, reserved, kind);
  await moveCounter(client, input.tenantId, reserved, kind);
  return { kind, applied: true };
}

export interface ExpiredAiReservationQuery {
  readonly tenantId: string;
  /** How far back past expiry to look (bounds the `idx_ai_usage_ledger_reserved_expiry` scan). */
  readonly lookbackSeconds: number;
  readonly limit: number;
}

/**
 * The tenant's still-open reservations whose TTL has passed, oldest first,
 * within the lookback window. Uses `idx_ai_usage_ledger_reserved_expiry`
 * and anti-joins `uq_ai_usage_ledger_one_terminal`.
 */
export async function listExpiredAiReservations(client: Queryable, query: ExpiredAiReservationQuery): Promise<string[]> {
  const r = await client.query<{ id: string }>(
    `SELECT r.id
       FROM ai_usage_ledger r
      WHERE r.tenant_id = $1::uuid
        AND r.entry_kind = 'reserved'
        AND r.expires_at <= now()
        AND r.expires_at > now() - make_interval(secs => $2)
        AND NOT EXISTS (
          SELECT 1 FROM ai_usage_ledger t
           WHERE t.reservation_id = r.id
             AND t.entry_kind IN ('committed', 'released'))
      ORDER BY r.expires_at, r.id
      LIMIT $3`,
    [query.tenantId, query.lookbackSeconds, query.limit],
  );
  return r.rows.map((row) => row.id);
}
