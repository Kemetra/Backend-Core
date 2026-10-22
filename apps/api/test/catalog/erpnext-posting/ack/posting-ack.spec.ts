/**
 * 015-US2-ACK — connectorAckOutcome service-level Testcontainers spec
 * (T040–T043, the DB-layer behaviors; the HTTP-edge auth/idempotency-interceptor
 * proof is the companion `http/posting-ack-http-edge.spec.ts`).
 *
 * Proves the ack records the outcome on `erpnext_posting_status` ONLY (never the
 * 008 sale fact) and that the lifecycle transitions are correct + idempotent:
 *
 *   - posted          → status='posted' + document_ref stored (CHECK biconditional);
 *                       the 008 sale row is byte-for-byte unchanged (§IX);
 *   - failed_transient → re-heads `sequence` so the row RE-APPEARS on the feed past
 *                        the connector's advanced cursor, retry_count++ (the cursor
 *                        trap fix); bounded by a retry budget — at the ceiling it
 *                        flips to permanently_rejected instead of looping forever;
 *   - permanently_rejected → rejection_category stored, dlqueued=true;
 *   - O-3 service echo (FRESH key, already-terminal row):
 *       · same outcome (posted + same documentRef) → idempotent echo, no re-transition;
 *       · different/contradicting outcome           → 409 conflict, stored doc wins;
 *   - §XII: a cross-tenant workItemRef → non-disclosing not_found (RLS 0 rows).
 *
 * Drives `ErpnextPostingService.ackOutcome` directly (the HTTP idempotency-key
 * interceptor + connectorBearer guard are proven in the http-edge spec). Docker
 * policy: HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../../_helpers/postgres-container";
import {
  ErpnextPostingService,
  POSTING_RETRY_BUDGET,
  AckConflictError,
  AckNotFoundError,
} from "../../../../src/catalog/erpnext-posting/erpnext-posting.service";
import { ACTOR_A, STORE_A_X } from "../../__support__/isolation-harness";
import { SALE_A_X } from "../../sales/__support__/seed-sales";
import {
  POSTING_STATUS_FIXTURE_IDS,
  POST_A_PENDING,
  POST_B_POSTED,
  POSTED_DOCUMENT_REF,
  seedPostingStatusFixture,
} from "../__support__/seed-posting-status";

let env: PgTestEnv | null = null;
let skip = false;

const TENANT_A = POSTING_STATUS_FIXTURE_IDS.tenantA;
const DOC = { doctype: "Sales Invoice", name: "ACC-SINV-A-0001" };

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    await seedPostingStatusFixture(env);
    // Make SALE_A_X's lines resolvable (confirmed item map + warehouse map) so
    // the failed_transient re-offer assertion can see POST_A_PENDING back on the
    // feed — buildWorkItem omits a row whose lines have no resolved Item.
    const a = env.admin;
    const TPROD_AX = "01900000-0000-7000-8000-0000000a7e01";
    await a.query(
      `INSERT INTO tenant_products (id, tenant_id, name, tax_category, created_by, updated_by)
       VALUES ($1, $2, 'AX Widget', 'standard', $3, $3) ON CONFLICT (id) DO NOTHING`,
      [TPROD_AX, TENANT_A, ACTOR_A],
    );
    await a.query(`UPDATE sale_lines SET tenant_product_ref = $1 WHERE sale_id = $2`, [
      TPROD_AX,
      SALE_A_X,
    ]);
    await a.query(
      `INSERT INTO erpnext_item_map
         (id, tenant_id, tenant_product_id, erpnext_item_ref, state, suggestion_source, confirmed_by, confirmed_at)
       VALUES (gen_random_uuid(), $1, $2, 'ERP-ITEM-AX', 'confirmed', 'manual', $3, now())
       ON CONFLICT DO NOTHING`,
      [TENANT_A, TPROD_AX, ACTOR_A],
    );
    await a.query(
      `INSERT INTO erpnext_warehouse_map
         (id, tenant_id, store_id, purpose, erpnext_warehouse_ref, set_by, version)
       VALUES (gen_random_uuid(), $1, $2, 'stock', 'ERP-WH-AX', $3, 1)
       ON CONFLICT DO NOTHING`,
      [TENANT_A, STORE_A_X, ACTOR_A],
    );
  } catch (err) {
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      skip = true;
      // eslint-disable-next-line no-console
      console.warn(`[posting-ack.spec] Docker unavailable: ${String(err)}`);
      return;
    }
    throw err;
  }
}, 180_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

function svc(): ErpnextPostingService {
  if (!env) throw new Error("Docker unavailable");
  return new ErpnextPostingService(env.app);
}

/** Re-seed a pristine pending row so each transition test is independent. */
async function resetPending(id: string): Promise<void> {
  await env!.admin.query(
    `UPDATE erpnext_posting_status
        SET rejection_message = NULL, status='pending', document_ref=NULL, posted_at=NULL, rejection_category=NULL,
            retry_count=0
      WHERE id = $1`,
    [id],
  );
}

async function statusRow(id: string): Promise<{
  status: string;
  document_ref: string | null;
  rejection_category: string | null;
  retry_count: number;
  sequence: string;
}> {
  const r = await env!.admin.query<{
    status: string;
    document_ref: string | null;
    rejection_category: string | null;
    retry_count: number;
    sequence: string;
  }>(
    `SELECT status, document_ref, rejection_category, retry_count,
            sequence::text AS sequence
       FROM erpnext_posting_status WHERE id = $1`,
    [id],
  );
  return r.rows[0]!;
}

describe("ErpnextPostingService.ackOutcome — 015-US2-ACK", () => {
  it("posted → status='posted' + document_ref stored; sale fact untouched (§IX)", async () => {
    if (skip) return;
    await resetPending(POST_A_PENDING);
    const before = await env!.admin.query(
      `SELECT * FROM sales WHERE id = $1`,
      [SALE_A_X],
    );

    const rec = await svc().ackOutcome({
      tenantId: TENANT_A,
      workItemRef: POST_A_PENDING,
      outcome: "posted",
      documentRef: DOC,
    });
    expect(rec.replayed).toBe(false);
    expect(rec.outcome.outcome).toBe("posted");
    expect(rec.outcome.documentRef).toEqual(DOC);

    const row = await statusRow(POST_A_PENDING);
    expect(row.status).toBe("posted");
    expect(row.document_ref).toBe(JSON.stringify(DOC));

    const after = await env!.admin.query(`SELECT * FROM sales WHERE id = $1`, [
      SALE_A_X,
    ]);
    expect(after.rows[0]).toEqual(before.rows[0]); // sale fact byte-for-byte unchanged
  });

  it("failed_transient RE-HEADS the sequence so the row re-appears on the feed, retry_count++", async () => {
    if (skip) return;
    await resetPending(POST_A_PENDING);
    const seqBefore = (await statusRow(POST_A_PENDING)).sequence;

    const rec = await svc().ackOutcome({
      tenantId: TENANT_A,
      workItemRef: POST_A_PENDING,
      outcome: "failed_transient",
    });
    expect(rec.outcome.outcome).toBe("failed_transient");

    const row = await statusRow(POST_A_PENDING);
    expect(row.status).toBe("pending"); // re-offered, NOT terminal
    expect(row.retry_count).toBe(1);
    // The cursor-trap fix: a fresh, higher sequence so a connector that already
    // advanced its cursor past the old sequence sees the row again.
    expect(BigInt(row.sequence)).toBeGreaterThan(BigInt(seqBefore));

    // End-to-end: a pull from since=old-sequence re-offers the row.
    const page = await svc().pullPostings({
      tenantId: TENANT_A,
      since: BigInt(seqBefore),
      limit: 100,
    });
    expect(page.items.map((i) => i.workItemRef)).toContain(POST_A_PENDING);
  });

  it("failed_transient at the retry budget flips to permanently_rejected (bounded re-offer)", async () => {
    if (skip) return;
    await resetPending(POST_A_PENDING);
    // Drive retry_count to the ceiling, then one more failed_transient.
    await env!.admin.query(
      `UPDATE erpnext_posting_status SET retry_count = $2 WHERE id = $1`,
      [POST_A_PENDING, POSTING_RETRY_BUDGET],
    );
    const rec = await svc().ackOutcome({
      tenantId: TENANT_A,
      workItemRef: POST_A_PENDING,
      outcome: "failed_transient",
    });
    expect(rec.outcome.outcome).toBe("permanently_rejected");
    expect(rec.outcome.dlqueued).toBe(true);
    const row = await statusRow(POST_A_PENDING);
    expect(row.status).toBe("permanently_rejected");
    expect(row.rejection_category).toBe("retry_budget_exhausted");
  });

  it("permanently_rejected → rejection_category stored, dlqueued=true", async () => {
    if (skip) return;
    await resetPending(POST_A_PENDING);
    const rec = await svc().ackOutcome({
      tenantId: TENANT_A,
      workItemRef: POST_A_PENDING,
      outcome: "permanently_rejected",
      reason: { category: "unmapped_account", message: "no GL account" },
    });
    expect(rec.outcome.outcome).toBe("permanently_rejected");
    expect(rec.outcome.dlqueued).toBe(true);
    const row = await statusRow(POST_A_PENDING);
    expect(row.status).toBe("permanently_rejected");
    expect(row.rejection_category).toBe("unmapped_account");
  });

  it("O-3 echo: a fresh-key re-ack of an already-posted row with the SAME doc echoes (no re-transition)", async () => {
    if (skip) return;
    await resetPending(POST_A_PENDING);
    await svc().ackOutcome({
      tenantId: TENANT_A,
      workItemRef: POST_A_PENDING,
      outcome: "posted",
      documentRef: DOC,
    });
    // A different idempotency key reaches the service; the row is already posted.
    const rec = await svc().ackOutcome({
      tenantId: TENANT_A,
      workItemRef: POST_A_PENDING,
      outcome: "posted",
      documentRef: DOC,
    });
    expect(rec.replayed).toBe(true);
    expect(rec.outcome.documentRef).toEqual(DOC); // echoes the stored doc
  });

  it("O-3 conflict: re-acking an already-posted row with a DIFFERENT outcome → AckConflictError (stored doc wins)", async () => {
    if (skip) return;
    await resetPending(POST_A_PENDING);
    await svc().ackOutcome({
      tenantId: TENANT_A,
      workItemRef: POST_A_PENDING,
      outcome: "posted",
      documentRef: DOC,
    });
    await expect(
      svc().ackOutcome({
        tenantId: TENANT_A,
        workItemRef: POST_A_PENDING,
        outcome: "permanently_rejected",
        reason: { category: "validation", message: "late reject" },
      }),
    ).rejects.toBeInstanceOf(AckConflictError);
    // The stored doc is untouched.
    const row = await statusRow(POST_A_PENDING);
    expect(row.status).toBe("posted");
    expect(row.document_ref).toBe(JSON.stringify(DOC));
  });

  it("§XII: a cross-tenant workItemRef → non-disclosing AckNotFoundError (RLS 0 rows)", async () => {
    if (skip) return;
    // POST_B_POSTED belongs to tenant B; tenant A's context cannot see it.
    await expect(
      svc().ackOutcome({
        tenantId: TENANT_A,
        workItemRef: POST_B_POSTED,
        outcome: "posted",
        documentRef: DOC,
      }),
    ).rejects.toBeInstanceOf(AckNotFoundError);
    // Tenant B's row is unchanged (still its original posted doc).
    const row = await statusRow(POST_B_POSTED);
    expect(row.status).toBe("posted");
    expect(row.document_ref).toBe(POSTED_DOCUMENT_REF);
  });
});
