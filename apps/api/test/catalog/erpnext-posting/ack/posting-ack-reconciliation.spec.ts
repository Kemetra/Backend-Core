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
import {
  AckConflictError,
  ErpnextPostingService,
} from "../../../../src/catalog/erpnext-posting/erpnext-posting.service";
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
            reconciliation_document_ref = NULL, retry_count = 0,
            current_resolution_version = $2
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
    await resetPending(1);
    await svc().ackOutcome({
      tenantId: TENANT_A,
      workItemRef: POST_A_PENDING,
      outcome: "reconciliation_required",
      documentRef: DOC,
      reason: REASON,
    });
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

  it.each([
    ["the current resolutionVersion", 2],
    ["no resolutionVersion (older connector)", undefined],
  ])("posted with %s is recorded as posted", async (_label, resolutionVersion) => {
    if (skip) return;
    await resetPending(2);
    const rec = await svc().ackOutcome({
      tenantId: TENANT_A,
      workItemRef: POST_A_PENDING,
      outcome: "posted",
      documentRef: DOC,
      ...(resolutionVersion === undefined ? {} : { resolutionVersion }),
    });
    expect(rec.outcome.outcome).toBe("posted");
    expect((await row()).status).toBe("posted");
  });
});

describe("RT-332 review — reconciliation always wins over an earlier rejection", () => {
  it("a reconciliation_required ack upgrades a row rejected for another category", async () => {
    if (skip) return;
    await resetPending(1);
    await env!.admin.query(
      `UPDATE erpnext_posting_status
          SET status = 'permanently_rejected', rejection_category = 'validation'
        WHERE id = $1`,
      [POST_A_PENDING],
    );
    const rec = await svc().ackOutcome({
      tenantId: TENANT_A,
      workItemRef: POST_A_PENDING,
      outcome: "reconciliation_required",
      documentRef: DOC,
      reason: REASON,
    });
    expect(rec.replayed).toBe(false);
    expect(rec.outcome.outcome).toBe("permanently_rejected");
    expect((await row()).category).toBe("reconciliation_required");
  });

  it("a retried stale posted ack is an idempotent echo, not a conflict", async () => {
    if (skip) return;
    await resetPending(2);
    const stale = {
      tenantId: TENANT_A,
      workItemRef: POST_A_PENDING,
      outcome: "posted" as const,
      documentRef: DOC,
      resolutionVersion: 1,
    };
    await svc().ackOutcome(stale);
    const retry = await svc().ackOutcome(stale);
    expect(retry.replayed).toBe(true);
    expect(retry.outcome.outcome).toBe("permanently_rejected");
  });
});

describe("RT-332 review — the reported document is kept as reconciliation evidence", () => {
  async function evidence(): Promise<unknown> {
    const r = await env!.admin.query<{ ev: string | null }>(
      `SELECT reconciliation_document_ref AS ev FROM erpnext_posting_status WHERE id = $1`,
      [POST_A_PENDING],
    );
    const ev = r.rows[0]!.ev;
    return ev === null ? null : JSON.parse(ev);
  }

  it("a reconciliation_required ack stores the existing document reference", async () => {
    if (skip) return;
    await resetPending(1);
    await svc().ackOutcome({
      tenantId: TENANT_A,
      workItemRef: POST_A_PENDING,
      outcome: "reconciliation_required",
      documentRef: DOC,
      reason: REASON,
    });
    expect(await evidence()).toEqual(DOC);
  });

  it("a stale posted ack stores the document it posted", async () => {
    if (skip) return;
    await resetPending(2);
    await env!.admin.query(
      `UPDATE erpnext_posting_status SET reconciliation_document_ref = NULL WHERE id = $1`,
      [POST_A_PENDING],
    );
    await svc().ackOutcome({
      tenantId: TENANT_A,
      workItemRef: POST_A_PENDING,
      outcome: "posted",
      documentRef: DOC,
      resolutionVersion: 1,
    });
    expect(await evidence()).toEqual(DOC);
  });
});

describe("RT-332 review — contradictory reconciliation evidence is a conflict", () => {
  it("a retry reporting a DIFFERENT document is a 409 conflict, the first evidence stays", async () => {
    if (skip) return;
    await resetPending(1);
    await svc().ackOutcome({
      tenantId: TENANT_A,
      workItemRef: POST_A_PENDING,
      outcome: "reconciliation_required",
      documentRef: DOC,
      reason: REASON,
    });
    await expect(
      svc().ackOutcome({
        tenantId: TENANT_A,
        workItemRef: POST_A_PENDING,
        outcome: "reconciliation_required",
        documentRef: { doctype: "Sales Invoice", name: "ACC-SINV-A-0100" },
        reason: REASON,
      }),
    ).rejects.toBeInstanceOf(AckConflictError);
    const r = await env!.admin.query<{ ev: string }>(
      `SELECT reconciliation_document_ref AS ev FROM erpnext_posting_status WHERE id = $1`,
      [POST_A_PENDING],
    );
    expect(JSON.parse(r.rows[0]!.ev)).toEqual(DOC);
  });
});

describe("RT-332 review — a stale posted ack first, then a retry", () => {
  const OTHER = { doctype: "Sales Invoice", name: "ACC-SINV-A-0200" };
  const retries = [
    ["stale posted, same document → echo", "posted", DOC, "echo"],
    ["stale posted, different document → conflict", "posted", OTHER, "conflict"],
    ["reconciliation_required, same document → echo", "reconciliation_required", DOC, "echo"],
    ["reconciliation_required, different document → conflict", "reconciliation_required", OTHER, "conflict"],
  ] as const;

  it.each(retries)("%s", async (_label, outcome, documentRef, expected) => {
    if (skip) return;
    await resetPending(2);
    await svc().ackOutcome({
      tenantId: TENANT_A,
      workItemRef: POST_A_PENDING,
      outcome: "posted",
      documentRef: DOC,
      resolutionVersion: 1,
    });
    const retry = svc().ackOutcome({
      tenantId: TENANT_A,
      workItemRef: POST_A_PENDING,
      outcome,
      documentRef,
      ...(outcome === "posted" ? { resolutionVersion: 1 } : { reason: REASON }),
    });
    if (expected === "conflict") {
      await expect(retry).rejects.toBeInstanceOf(AckConflictError);
    } else {
      expect((await retry).replayed).toBe(true);
    }
    const r = await env!.admin.query<{ ev: string }>(
      `SELECT reconciliation_document_ref AS ev FROM erpnext_posting_status WHERE id = $1`,
      [POST_A_PENDING],
    );
    expect(JSON.parse(r.rows[0]!.ev)).toEqual(DOC);
  });
});

describe("RT-332 review — a stale posted ack never confirms an already-posted row", () => {
  it("is a conflict, and the row stays posted with its document", async () => {
    if (skip) return;
    await resetPending(2);
    await svc().ackOutcome({
      tenantId: TENANT_A,
      workItemRef: POST_A_PENDING,
      outcome: "posted",
      documentRef: DOC,
      resolutionVersion: 2,
    });
    await expect(
      svc().ackOutcome({
        tenantId: TENANT_A,
        workItemRef: POST_A_PENDING,
        outcome: "posted",
        documentRef: DOC,
        resolutionVersion: 1,
      }),
    ).rejects.toBeInstanceOf(AckConflictError);
    expect((await row()).status).toBe("posted");
  });
});
