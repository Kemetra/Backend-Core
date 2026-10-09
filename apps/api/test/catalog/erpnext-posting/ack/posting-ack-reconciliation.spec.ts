/**
 * RT-332 — the `reconciliation_required` connector outcome and the stale-version
 * `posted` guard (RT-326 decision 2).
 *
 * `reconciliation_required` means the connector found an EXISTING ERP document
 * for the work item that does not match its frozen resolution (an ERP side
 * effect already exists). Backend-Core records it as a dead-letter with
 * `rejection_category = 'reconciliation_required'`, so it shows in the existing
 * backlog views, and the recorded outcome it returns is `permanently_rejected`.
 *
 * A `posted` ack that echoes a `resolutionVersion` other than the row's current
 * frozen version posted a superseded resolution: it is recorded the same way.
 * An ack without `resolutionVersion` (an older connector) posts as before.
 *
 * Docker policy mirrors posting-ack.spec: HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../../_helpers/postgres-container";
import { ErpnextPostingService } from "../../../../src/catalog/erpnext-posting/erpnext-posting.service";
import {
  POSTING_STATUS_FIXTURE_IDS,
  POST_A_PENDING,
  seedPostingStatusFixture,
} from "../__support__/seed-posting-status";

let env: PgTestEnv | null = null;
let skip = false;

const TENANT_A = POSTING_STATUS_FIXTURE_IDS.tenantA;
const DOC = { doctype: "Sales Invoice", name: "ACC-SINV-A-0099" };
const REASON = { category: "validation" as const, message: "existing invoice item differs" };

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    await seedPostingStatusFixture(env);
  } catch (err) {
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      skip = true;
      // eslint-disable-next-line no-console
      console.warn(`[posting-ack-reconciliation.spec] Docker unavailable: ${String(err)}`);
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

/** Put the row back to pending at frozen version `version` (NULL = legacy row). */
async function resetPending(version: number | null): Promise<void> {
  await env!.admin.query(
    `UPDATE erpnext_posting_status
        SET status = 'pending', document_ref = NULL, rejection_category = NULL,
            retry_count = 0, current_resolution_version = $2
      WHERE id = $1`,
    [POST_A_PENDING, version],
  );
}

async function row(): Promise<{ status: string; category: string | null; doc: string | null }> {
  const r = await env!.admin.query<{ status: string; category: string | null; doc: string | null }>(
    `SELECT status, rejection_category AS category, document_ref AS doc
       FROM erpnext_posting_status WHERE id = $1`,
    [POST_A_PENDING],
  );
  return r.rows[0]!;
}

describe("RT-332 — reconciliation_required outcome", () => {
  it("records a dead-letter with category reconciliation_required", async () => {
    if (skip) return;
    await resetPending(1);
    const rec = await svc().ackOutcome({
      tenantId: TENANT_A,
      workItemRef: POST_A_PENDING,
      outcome: "reconciliation_required",
      documentRef: DOC,
      reason: REASON,
    });
    expect(rec.replayed).toBe(false);
    expect(rec.outcome.outcome).toBe("permanently_rejected");
    expect(rec.outcome.dlqueued).toBe(true);
    expect(rec.outcome.documentRef).toBeNull();
    expect(await row()).toEqual({
      status: "permanently_rejected",
      category: "reconciliation_required",
      doc: null,
    });
  });

  it("a repeated reconciliation_required ack is an idempotent echo", async () => {
    if (skip) return;
    const rec = await svc().ackOutcome({
      tenantId: TENANT_A,
      workItemRef: POST_A_PENDING,
      outcome: "reconciliation_required",
      documentRef: DOC,
      reason: REASON,
    });
    expect(rec.replayed).toBe(true);
    expect(rec.outcome.outcome).toBe("permanently_rejected");
  });
});

describe("RT-332 — a posted ack is checked against the frozen resolution version", () => {
  it("posted with a superseded resolutionVersion is recorded as reconciliation_required", async () => {
    if (skip) return;
    await resetPending(2);
    const rec = await svc().ackOutcome({
      tenantId: TENANT_A,
      workItemRef: POST_A_PENDING,
      outcome: "posted",
      documentRef: DOC,
      resolutionVersion: 1,
    });
    expect(rec.outcome.outcome).toBe("permanently_rejected");
    expect(await row()).toEqual({
      status: "permanently_rejected",
      category: "reconciliation_required",
      doc: null,
    });
  });

  it("posted with the current resolutionVersion is recorded as posted", async () => {
    if (skip) return;
    await resetPending(2);
    const rec = await svc().ackOutcome({
      tenantId: TENANT_A,
      workItemRef: POST_A_PENDING,
      outcome: "posted",
      documentRef: DOC,
      resolutionVersion: 2,
    });
    expect(rec.outcome.outcome).toBe("posted");
    expect((await row()).status).toBe("posted");
  });

  it("posted without resolutionVersion (older connector) is recorded as posted", async () => {
    if (skip) return;
    await resetPending(2);
    const rec = await svc().ackOutcome({
      tenantId: TENANT_A,
      workItemRef: POST_A_PENDING,
      outcome: "posted",
      documentRef: DOC,
    });
    expect(rec.outcome.outcome).toBe("posted");
  });
});
