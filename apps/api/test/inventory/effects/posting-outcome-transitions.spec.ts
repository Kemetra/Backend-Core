/**
 * posting-outcome-transitions.spec.ts — Jira RT-426 (RT-289 G2-3, DC-3, DC-5).
 *
 * ERP posting outcomes move the Inventory Effects their intent represents
 * between integration states, end to end through the real ack and repair paths:
 *
 *   - posted → confirmed, with erp_confirmed_at = the intent's posted_at and the
 *     confirming document;
 *   - failed_transient → stays pending; retry budget exhausted → rejected;
 *   - permanently_rejected → rejected;
 *   - reconciliation_required, a stale-resolution post, and the RT-332 upgrade
 *     of a dead-letter → reconciliation_required;
 *   - repair re_post → rejected → pending;
 *   - a duplicate ack (O-3 echo) and a conflicting ack move nothing;
 *   - an effect with no ERP intent stays not_posted;
 *   - an illegal transition refuses the ack and rolls back the posting update
 *     with it (same transaction).
 *
 * Every case proves the outcome changed ONLY integration rows: the
 * stock_movements rows (count, quantities, every column) are unchanged.
 * Tenant isolation: tenant A's outcomes never reach tenant B's effects.
 *
 * Linked effect fixtures stand in for sale effects (RT-427 activates those).
 * Layer: services + DB against the RLS-active `env.app` pool.
 * Docker policy: HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../_helpers/postgres-container";
import {
  AckConflictError,
  AckNotFoundError,
  ErpnextPostingService,
  POSTING_RETRY_BUDGET,
} from "../../../src/catalog/erpnext-posting/erpnext-posting.service";
import { ErpnextReconciliationService } from "../../../src/catalog/erpnext-reconciliation/erpnext-reconciliation.service";
import { MembershipRepository } from "../../../src/context/membership.repository";
import type { ResolvedContext } from "../../../src/context/types";
import { IllegalIntegrationTransitionError } from "../../../src/inventory/effect-integration/integration-state-machine";
import {
  ACTOR_A,
  ACTOR_B,
  PRODUCT_A_ACTIVE,
  PRODUCT_B_ACTIVE,
  STORE_A_X,
  STORE_B_X,
  TENANT_A,
  TENANT_B,
} from "../../catalog/__support__/isolation-harness";
import { SALES_SOURCE_SYSTEM, SALE_A_X, SALE_B_X } from "../../catalog/sales/__support__/seed-sales";
import { POST_A_PENDING, POST_A_REVERSAL } from "../../catalog/erpnext-posting/__support__/seed-posting-status";
import {
  POSTING_DEADLETTER_A,
  seedReconciliationFixture,
} from "../../catalog/erpnext-reconciliation/__support__/seed-reconciliation";

// ---------------------------------------------------------------------------
// Fixture ids — `e426` mnemonic, disjoint from the other corpora.
// ---------------------------------------------------------------------------

/** Two sale-line effects of SALE_A_X, represented by POST_A_PENDING. */
const EFFECT_A1 = "0a000000-0000-7000-8000-0000e426a0a1";
const EFFECT_A2 = "0a000000-0000-7000-8000-0000e426a0a2";
/** One sale-line effect represented by the dead-letter POSTING_DEADLETTER_A. */
const EFFECT_DL = "0a000000-0000-7000-8000-0000e426a0d1";
/** A tenant-A effect with no ERP intent (an adjustment). */
const EFFECT_NOT_POSTED = "0a000000-0000-7000-8000-0000e426a0e1";
/** Tenant B: a pending intent and its effect. */
const POST_B_PENDING = "0b000000-0000-7000-8000-0000e426b0f1";
const EFFECT_B1 = "0b000000-0000-7000-8000-0000e426b0b1";

const DOC = { doctype: "Sales Invoice", name: "ACC-SINV-A-0426" };
const DOC_JSON = JSON.stringify(DOC);
const OTHER_DOC = { doctype: "Sales Invoice", name: "ACC-SINV-A-0426-OTHER" };
const PAYLOAD_HASH = "b".repeat(64);

const LINKED_A = [EFFECT_A1, EFFECT_A2];
const ALL_EFFECTS = [EFFECT_A1, EFFECT_A2, EFFECT_DL, EFFECT_NOT_POSTED, EFFECT_B1];

let env: PgTestEnv | null = null;
let skip = false;

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    await seedReconciliationFixture(env);
    await seedLinkedEffects(env);
  } catch (err) {
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      skip = true;
      // eslint-disable-next-line no-console
      console.warn(`[posting-outcome-transitions.spec] Docker unavailable: ${String(err)}`);
      return;
    }
    throw err;
  }
}, 180_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

async function seedLinkedEffects(e: PgTestEnv): Promise<void> {
  const a = e.admin;
  // The repair re-offer resolves SALE_A_X: lines mapped to a confirmed item
  // (the reconciliation seed already maps STORE_A_X to a warehouse).
  await a.query(`UPDATE sale_lines SET tenant_product_ref = $1 WHERE sale_id = $2`, [
    PRODUCT_A_ACTIVE,
    SALE_A_X,
  ]);
  await a.query(
    `INSERT INTO erpnext_item_map
       (id, tenant_id, tenant_product_id, erpnext_item_ref, state, suggestion_source, confirmed_by, confirmed_at)
     VALUES (gen_random_uuid(), $1, $2, 'ERP-ITEM-426A', 'confirmed', 'manual', $3, now())
     ON CONFLICT DO NOTHING`,
    [TENANT_A, PRODUCT_A_ACTIVE, ACTOR_A],
  );

  // Tenant B: a pending intent of its own (a distinct source_ref_id).
  await a.query(
    `INSERT INTO erpnext_posting_status
       (id, tenant_id, store_id, sale_id, kind, source_ref_id,
        source_system, external_id, payload_hash, status)
     VALUES ($1, $2, $3, $4, 'sale_post', $1, $5, 'sale-B-X-426', $6, 'pending')
     ON CONFLICT DO NOTHING`,
    [POST_B_PENDING, TENANT_B, STORE_B_X, SALE_B_X, SALES_SOURCE_SYSTEM, PAYLOAD_HASH],
  );

  // The effects: retail sale-line outbound effects (event `sale`), plus a
  // not_posted adjustment. Position: the store's primary location, sellable.
  const effect = (
    id: string,
    tenant: string,
    store: string,
    product: string,
    event: "sale" | "adjustment",
    eventRef: string,
    qty: string,
  ): Promise<unknown> =>
    a.query(
      `INSERT INTO stock_movements
         (id, tenant_id, store_id, movement_type, quantity, stocking_unit,
          tenant_product_ref, source_system, external_id, occurred_at, created_by,
          origin, event_type, event_ref_id, stock_location_id, inventory_status)
       VALUES ($1, $2, $3, $4, $5, 'ea', $6, $7, $8, now(), $11,
               'retail', $9, $10,
               (SELECT id FROM stock_locations WHERE store_id = $3::uuid AND kind = 'primary'),
               'sellable')
       ON CONFLICT DO NOTHING`,
      [
        id, tenant, store, event === "sale" ? "outbound" : "adjustment", qty, product,
        event === "sale" ? SALES_SOURCE_SYSTEM : null,
        event === "sale" ? `sale_line:${id}` : null,
        event, eventRef, tenant === TENANT_A ? ACTOR_A : ACTOR_B,
      ],
    );
  await effect(EFFECT_A1, TENANT_A, STORE_A_X, PRODUCT_A_ACTIVE, "sale", SALE_A_X, "-1.0000");
  await effect(EFFECT_A2, TENANT_A, STORE_A_X, PRODUCT_A_ACTIVE, "sale", SALE_A_X, "-2.5000");
  await effect(EFFECT_DL, TENANT_A, STORE_A_X, PRODUCT_A_ACTIVE, "sale", SALE_A_X, "-4.0000");
  await effect(EFFECT_NOT_POSTED, TENANT_A, STORE_A_X, PRODUCT_A_ACTIVE, "adjustment", EFFECT_NOT_POSTED, "3.0000");
  await effect(EFFECT_B1, TENANT_B, STORE_B_X, PRODUCT_B_ACTIVE, "sale", SALE_B_X, "-1.0000");

  await a.query(
    `INSERT INTO inventory_effect_integration (effect_id, tenant_id, state, posting_status_id)
     VALUES ($1, $2, 'pending', $3), ($4, $2, 'pending', $3),
            ($5, $2, 'rejected', $6), ($7, $2, 'not_posted', NULL),
            ($8, $9, 'pending', $10)
     ON CONFLICT DO NOTHING`,
    [
      EFFECT_A1, TENANT_A, POST_A_PENDING, EFFECT_A2,
      EFFECT_DL, POSTING_DEADLETTER_A, EFFECT_NOT_POSTED,
      EFFECT_B1, TENANT_B, POST_B_PENDING,
    ],
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function posting(): ErpnextPostingService {
  if (!env) throw new Error("Docker unavailable");
  return new ErpnextPostingService(env.app);
}

function reconciliation(): ErpnextReconciliationService {
  if (!env) throw new Error("Docker unavailable");
  return new ErpnextReconciliationService(env.app, new MembershipRepository(env.app));
}

function sessionCtx(tenantId: string): ResolvedContext {
  return {
    userId: ACTOR_A,
    tenantId,
    storeId: null,
    isPlatformAdmin: false,
    source: "session",
    storeAccess: { kind: "all" },
  };
}

/** Put POST_A_PENDING back to pending and its effects back to pending. */
async function resetPending(opts: { retryCount?: number; version?: number | null } = {}): Promise<void> {
  await env!.admin.query(
    `UPDATE erpnext_posting_status
        SET rejection_message = NULL, status = 'pending', document_ref = NULL, posted_at = NULL, rejection_category = NULL,
            reconciliation_document_ref = NULL, retry_count = $2, current_resolution_version = $3
      WHERE id = $1`,
    [POST_A_PENDING, opts.retryCount ?? 0, opts.version ?? null],
  );
  await setEffects(LINKED_A, "pending", POST_A_PENDING);
}

async function setEffects(ids: readonly string[], state: string, postingId: string): Promise<void> {
  await env!.admin.query(
    `UPDATE inventory_effect_integration
        SET state = $2, posting_status_id = $3, erp_document_ref = NULL,
            erp_confirmed_at = NULL, state_reason = NULL
      WHERE effect_id = ANY($1::uuid[])`,
    [ids, state, postingId],
  );
}

interface IntegrationRow {
  effect_id: string;
  state: string;
  posting_status_id: string | null;
  erp_document_ref: string | null;
  erp_confirmed_at: Date | null;
  state_reason: string | null;
  updated_at: Date;
}

async function integration(id: string): Promise<IntegrationRow> {
  const r = await env!.admin.query<IntegrationRow>(
    `SELECT effect_id, state, posting_status_id, erp_document_ref, erp_confirmed_at,
            state_reason, updated_at
       FROM inventory_effect_integration WHERE effect_id = $1`,
    [id],
  );
  return r.rows[0]!;
}

async function integrations(ids: readonly string[]): Promise<IntegrationRow[]> {
  return Promise.all(ids.map(integration));
}

/** Every stock_movements row, serialized — the effects journal must not move. */
async function journal(): Promise<{ count: number; sum: string; rows: string }> {
  const r = await env!.admin.query<{ count: number; sum: string; rows: string }>(
    `SELECT count(*)::int AS count, COALESCE(sum(quantity), 0)::text AS sum,
            COALESCE(json_agg(m ORDER BY m.id)::text, '[]') AS rows
       FROM stock_movements m`,
  );
  return r.rows[0]!;
}

/** Run `fn` and prove it left every stock_movements row exactly as it was. */
async function journalUnchanged<T>(fn: () => Promise<T>): Promise<T> {
  const before = await journal();
  const out = await fn();
  const after = await journal();
  expect(after.count).toBe(before.count);
  expect(after.sum).toBe(before.sum);
  expect(after.rows).toBe(before.rows);
  return out;
}

async function postingRow(id: string): Promise<{ status: string; posted_at: Date | null; retry_count: number }> {
  const r = await env!.admin.query<{ status: string; posted_at: Date | null; retry_count: number }>(
    `SELECT status, posted_at, retry_count FROM erpnext_posting_status WHERE id = $1`,
    [id],
  );
  return r.rows[0]!;
}

// ---------------------------------------------------------------------------
// Specs
// ---------------------------------------------------------------------------

describe("RT-426 — posted → confirmed", () => {
  it("confirms every linked effect at posted_at with the document; nothing else moves", async () => {
    if (skip) return;
    await resetPending();
    const otherBefore = await integrations([EFFECT_DL, EFFECT_NOT_POSTED, EFFECT_B1]);

    const rec = await journalUnchanged(() =>
      posting().ackOutcome({ tenantId: TENANT_A, workItemRef: POST_A_PENDING, outcome: "posted", documentRef: DOC }),
    );
    expect(rec.replayed).toBe(false);

    const postedAt = (await postingRow(POST_A_PENDING)).posted_at;
    expect(postedAt).not.toBeNull();
    for (const row of await integrations(LINKED_A)) {
      expect(row.state).toBe("confirmed");
      expect(row.erp_confirmed_at).toEqual(postedAt);
      expect(row.erp_document_ref).toBe(DOC_JSON);
      expect(row.posting_status_id).toBe(POST_A_PENDING);
    }
    // The not_posted effect, the dead-letter's effect and tenant B's are untouched.
    expect(await integrations([EFFECT_DL, EFFECT_NOT_POSTED, EFFECT_B1])).toEqual(otherBefore);
    expect((await integration(EFFECT_NOT_POSTED)).state).toBe("not_posted");
  });

  it("a duplicate posted ack (O-3 echo) is a no-op on the effects", async () => {
    if (skip) return;
    await resetPending();
    await posting().ackOutcome({ tenantId: TENANT_A, workItemRef: POST_A_PENDING, outcome: "posted", documentRef: DOC });
    const before = await integrations(LINKED_A);

    const echo = await journalUnchanged(() =>
      posting().ackOutcome({ tenantId: TENANT_A, workItemRef: POST_A_PENDING, outcome: "posted", documentRef: DOC }),
    );
    expect(echo.replayed).toBe(true);
    expect(await integrations(LINKED_A)).toEqual(before);
  });

  it("a contradicting posted ack is a conflict and leaves the confirmed effects as they are", async () => {
    if (skip) return;
    await resetPending();
    await posting().ackOutcome({ tenantId: TENANT_A, workItemRef: POST_A_PENDING, outcome: "posted", documentRef: DOC });
    const before = await integrations(LINKED_A);

    await expect(
      posting().ackOutcome({ tenantId: TENANT_A, workItemRef: POST_A_PENDING, outcome: "posted", documentRef: OTHER_DOC }),
    ).rejects.toBeInstanceOf(AckConflictError);
    expect(await integrations(LINKED_A)).toEqual(before);
  });
});

describe("RT-426 — failed_transient, rejection and the retry budget", () => {
  it("failed_transient leaves the effects pending, untouched", async () => {
    if (skip) return;
    await resetPending();
    const before = await integrations(LINKED_A);

    const rec = await journalUnchanged(() =>
      posting().ackOutcome({ tenantId: TENANT_A, workItemRef: POST_A_PENDING, outcome: "failed_transient" }),
    );
    expect(rec.outcome.outcome).toBe("failed_transient");
    expect((await postingRow(POST_A_PENDING)).retry_count).toBe(1);
    expect(await integrations(LINKED_A)).toEqual(before);
  });

  it("failed_transient with the retry budget exhausted → rejected", async () => {
    if (skip) return;
    await resetPending({ retryCount: POSTING_RETRY_BUDGET });

    await journalUnchanged(() =>
      posting().ackOutcome({ tenantId: TENANT_A, workItemRef: POST_A_PENDING, outcome: "failed_transient" }),
    );
    for (const row of await integrations(LINKED_A)) {
      expect(row.state).toBe("rejected");
      expect(row.state_reason).toBe("retry_budget_exhausted");
      expect(row.erp_confirmed_at).toBeNull();
      expect(row.erp_document_ref).toBeNull();
    }
  });

  it("permanently_rejected → rejected, keeping the effects (DC-5)", async () => {
    if (skip) return;
    await resetPending();

    await journalUnchanged(() =>
      posting().ackOutcome({
        tenantId: TENANT_A,
        workItemRef: POST_A_PENDING,
        outcome: "permanently_rejected",
        reason: { category: "validation_error", message: "rejected by ERP" },
      }),
    );
    for (const row of await integrations(LINKED_A)) {
      expect(row.state).toBe("rejected");
      expect(row.state_reason).toBe("validation_error");
    }
  });
});

describe("RT-426 — reconciliation_required", () => {
  it("a reconciliation_required ack → reconciliation_required, keeping the ERP document as evidence", async () => {
    if (skip) return;
    await resetPending({ version: 1 });

    await journalUnchanged(() =>
      posting().ackOutcome({
        tenantId: TENANT_A,
        workItemRef: POST_A_PENDING,
        outcome: "reconciliation_required",
        documentRef: DOC,
        reason: { category: "reconciliation_required", message: "document differs" },
      }),
    );
    for (const row of await integrations(LINKED_A)) {
      expect(row.state).toBe("reconciliation_required");
      expect(row.erp_document_ref).toBe(DOC_JSON);
      expect(row.erp_confirmed_at).toBeNull();
    }
  });

  it("a post from a superseded resolution version → reconciliation_required, never confirmed", async () => {
    if (skip) return;
    await resetPending({ version: 2 });

    await journalUnchanged(() =>
      posting().ackOutcome({
        tenantId: TENANT_A,
        workItemRef: POST_A_PENDING,
        outcome: "posted",
        documentRef: DOC,
        resolutionVersion: 1,
      }),
    );
    expect((await postingRow(POST_A_PENDING)).posted_at).toBeNull();
    for (const row of await integrations(LINKED_A)) {
      expect(row.state).toBe("reconciliation_required");
      expect(row.erp_confirmed_at).toBeNull();
    }
  });

  it("a dead-lettered intent upgraded to reconciliation (RT-332) moves rejected → reconciliation_required", async () => {
    if (skip) return;
    await resetPending({ version: 1 });
    await posting().ackOutcome({
      tenantId: TENANT_A,
      workItemRef: POST_A_PENDING,
      outcome: "permanently_rejected",
      reason: { category: "other", message: "x" },
    });
    expect((await integration(EFFECT_A1)).state).toBe("rejected");

    const rec = await journalUnchanged(() =>
      posting().ackOutcome({
        tenantId: TENANT_A,
        workItemRef: POST_A_PENDING,
        outcome: "reconciliation_required",
        documentRef: DOC,
        reason: { category: "reconciliation_required", message: "document differs" },
      }),
    );
    expect(rec.replayed).toBe(false);
    for (const row of await integrations(LINKED_A)) {
      expect(row.state).toBe("reconciliation_required");
      expect(row.erp_document_ref).toBe(DOC_JSON);
    }
  });
});

describe("RT-426 — repair re_post", () => {
  it("re-offering a dead-letter moves its rejected effects back to pending", async () => {
    if (skip) return;
    await env!.admin.query(
      `UPDATE erpnext_posting_status
          SET status = 'permanently_rejected', document_ref = NULL,
              rejection_category = 'unmapped_item', retry_count = 5
        WHERE id = $1`,
      [POSTING_DEADLETTER_A],
    );
    await setEffects([EFFECT_DL], "rejected", POSTING_DEADLETTER_A);

    const res = await journalUnchanged(() =>
      reconciliation().repairPosting({
        tenantId: TENANT_A,
        context: sessionCtx(TENANT_A),
        actorUserId: ACTOR_A,
        workItemRef: POSTING_DEADLETTER_A,
      }),
    );
    expect(res.repair.outcome).toBe("eligible_again");
    const row = await integration(EFFECT_DL);
    expect(row.state).toBe("pending");
    expect(row.state_reason).toBe("repair_re_post");
    expect(row.posting_status_id).toBe(POSTING_DEADLETTER_A);
    expect(row.erp_document_ref).toBeNull();

    // The repaired intent then posts: rejected → pending → confirmed.
    await posting().ackOutcome({
      tenantId: TENANT_A,
      workItemRef: POSTING_DEADLETTER_A,
      outcome: "posted",
      documentRef: DOC,
    });
    expect((await integration(EFFECT_DL)).state).toBe("confirmed");
  });
});

describe("RT-426 — same transaction, illegal transitions, no linked effects", () => {
  it("an illegal transition refuses the ack and rolls the posting update back with it", async () => {
    if (skip) return;
    await resetPending();
    // Out of step: the intent is pending but one effect already reads rejected.
    await setEffects([EFFECT_A2], "rejected", POST_A_PENDING);
    const before = await integrations(LINKED_A);

    await expect(
      journalUnchanged(() =>
        posting().ackOutcome({ tenantId: TENANT_A, workItemRef: POST_A_PENDING, outcome: "posted", documentRef: DOC }),
      ),
    ).rejects.toBeInstanceOf(IllegalIntegrationTransitionError);

    const intent = await postingRow(POST_A_PENDING);
    expect(intent.status).toBe("pending");
    expect(intent.posted_at).toBeNull();
    expect(await integrations(LINKED_A)).toEqual(before);
  });

  it("an intent with no linked effects acks as before", async () => {
    if (skip) return;
    const rec = await journalUnchanged(() =>
      posting().ackOutcome({
        tenantId: TENANT_A,
        workItemRef: POST_A_REVERSAL,
        outcome: "posted",
        documentRef: { doctype: "Sales Invoice", name: "ACC-SINV-RET-0426" },
      }),
    );
    expect(rec.outcome.outcome).toBe("posted");
  });
});

describe("RT-426 — tenant isolation", () => {
  it("tenant A cannot ack tenant B's intent, and tenant B's effect never moves", async () => {
    if (skip) return;
    const before = await integration(EFFECT_B1);
    await expect(
      posting().ackOutcome({ tenantId: TENANT_A, workItemRef: POST_B_PENDING, outcome: "posted", documentRef: DOC }),
    ).rejects.toBeInstanceOf(AckNotFoundError);
    expect(await integration(EFFECT_B1)).toEqual(before);
  });

  it("tenant B's own ack moves only tenant B's effect", async () => {
    if (skip) return;
    const aBefore = await integrations([EFFECT_A1, EFFECT_A2, EFFECT_DL, EFFECT_NOT_POSTED]);
    await journalUnchanged(() =>
      posting().ackOutcome({
        tenantId: TENANT_B,
        workItemRef: POST_B_PENDING,
        outcome: "posted",
        documentRef: { doctype: "Sales Invoice", name: "ACC-SINV-B-0426" },
      }),
    );
    expect((await integration(EFFECT_B1)).state).toBe("confirmed");
    expect(await integrations([EFFECT_A1, EFFECT_A2, EFFECT_DL, EFFECT_NOT_POSTED])).toEqual(aBefore);
  });

  it("under RLS, tenant A reads none of tenant B's integration rows", async () => {
    if (skip) return;
    const client = await env!.app.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SELECT set_config('app.current_tenant', $1, true)`, [TENANT_A]);
      const r = await client.query<{ effect_id: string }>(
        `SELECT effect_id FROM inventory_effect_integration WHERE effect_id = ANY($1::uuid[])`,
        [ALL_EFFECTS],
      );
      await client.query("ROLLBACK");
      expect(r.rows.map((x) => x.effect_id)).not.toContain(EFFECT_B1);
      expect(r.rows).toHaveLength(ALL_EFFECTS.length - 1);
    } finally {
      client.release();
    }
  });
});
