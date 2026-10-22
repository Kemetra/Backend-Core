/**
 * RT-565 — posting freshness on the console sync-ops summary
 * (console-sync-ops.yaml 1.2.0-draft; D1–D7 and §6 of
 * docs/planning/rt-565-posting-freshness-read.md).
 *
 * HTTP + Testcontainers over the REAL module graph and the NOBYPASSRLS app
 * pool (the RT-192 read-store-scope fixture: real TenantContextGuard,
 * RolesGuard, memberships, store grants and sessions; only the cookie is
 * faked by a header). Each test replaces tenant A's pending/posted rows with
 * its own; the fixture's dead letters stay (they must never count as pending).
 *
 *   §1 lastPosted.state: none / unknown (only pre-0042 rows) / known (max of
 *      the non-null posted_at, legacy rows ignored).
 *   §2 pending: count and the oldest creation instant; a retried / re-headed row
 *      keeps its created_at age; dead letters excluded; pendingCount = 0 ⇔
 *      both nulls.
 *   §3 scope: tenant RLS (tenant B invisible), store_id filter, the RT-192
 *      membership scope, a quiet store inside a busy tenant, out-of-scope 404.
 *   §4 asOf: lastPosted.at <= asOf, oldestPendingAt <= asOf, age measured
 *      against asOf, never negative.
 *   §5 consistency under concurrency: rows committed after the summary's BEGIN
 *      but before the freshness statement are seen consistently and are never
 *      later than asOf (asOf is clock_timestamp() inside the statement, D6).
 *   §6 roles / auth unchanged: owner + tenant_admin only, cookie session only.
 *
 * Docker policy: HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import "reflect-metadata";

import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import Ajv from "ajv";
import addFormats from "ajv-formats";

import { runWithTenantContext } from "@data-pulse-2/db";
import request from "supertest";

import { ROLES_METADATA_KEY } from "../../../src/auth/roles.decorator";
import { loadOpenApiContracts } from "../../../src/openapi/loader";
import { ErpnextSyncOpsController } from "../../../src/catalog/erpnext-sync-ops/erpnext-sync-ops.controller";
import { ErpnextSyncOpsModule } from "../../../src/catalog/erpnext-sync-ops/erpnext-sync-ops.module";
import {
  freshnessStores,
  readPostingFreshness,
} from "../../../src/catalog/erpnext-sync-ops/posting-freshness.read";
import { STORE_A_X, STORE_A_Y, STORE_B_X, TENANT_A, TENANT_B } from "../__support__/isolation-harness";
import {
  NON_EXISTENT,
  SES_ADMIN_SPEC,
  SES_OWNER_ALL,
  SES_OWNER_SPEC,
  SPECIFIC_SESSIONS,
  useScopedApp,
} from "../erpnext-reconciliation/__support__/read-store-scope";
import { SALE_A_X, SALE_A_Y, SALE_B_X, SALES_SOURCE_SYSTEM } from "../sales/__support__/seed-sales";

const SUMMARY = "/api/v1/catalog/erpnext-sync-ops/summary";

const scoped = useScopedApp("RT-565 posting-freshness", ErpnextSyncOpsModule);
const skip = (): boolean => scoped.skip();

beforeEach(async () => {
  if (skip()) return;
  // Every test owns tenant A's and tenant B's non-dead-letter rows.
  await scoped.env().admin.query(
    `DELETE FROM erpnext_posting_status
      WHERE tenant_id = ANY($1::uuid[]) AND status IN ('pending', 'posted')`,
    [[TENANT_A, TENANT_B]],
  );
});


interface Freshness {
  lastPosted: { state: string; at: string | null };
  pendingCount: number;
  oldestPendingAt: string | null;
  oldestPendingAgeSeconds: number | null;
}
interface SummaryBody {
  asOf: string;
  postingFreshness: Freshness;
  domains: Array<{ domain: string; headlineCount: number | null }>;
}

function get(session: string, query: Record<string, string> = {}): request.Test {
  return request(scoped.app().getHttpServer()).get(SUMMARY).set("x-test-session", session).query(query);
}

// Every 200 body is validated against the contract's SyncOpsSummary
// (1.2.0-draft), including its known ⇔ at and pendingCount ⇔ oldest invariants.
const contract = loadOpenApiContracts({
  dir: resolve(__dirname, "..", "..", "..", "..", "..", "packages", "contracts", "openapi", "erpnext-sync-ops"),
}).find((c) => c.id === "console-sync-ops")!;
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema(contract.document as object, "console-sync-ops");
const validSummary = ajv.getSchema("console-sync-ops#/components/schemas/SyncOpsSummary")!;

async function summary(session: string, query: Record<string, string> = {}): Promise<SummaryBody> {
  const body = (await get(session, query).expect(200)).body as SummaryBody;
  expect(validSummary(body) ? [] : validSummary.errors).toEqual([]);
  return body;
}

const SALE_OF: Record<string, { tenantId: string; saleId: string }> = {
  [STORE_A_X]: { tenantId: TENANT_A, saleId: SALE_A_X },
  [STORE_A_Y]: { tenantId: TENANT_A, saleId: SALE_A_Y },
  [STORE_B_X]: { tenantId: TENANT_B, saleId: SALE_B_X },
};

/** Insert one posting intent; `createdAgo` / `postedAgo` are SQL intervals before now(). */
async function intent(
  storeId: string,
  status: "pending" | "posted",
  opts: { createdAgo?: string; postedAgo?: string | null } = {},
): Promise<string> {
  const { tenantId, saleId } = SALE_OF[storeId]!;
  const id = randomUUID();
  await scoped.env().admin.query(
    `INSERT INTO erpnext_posting_status
       (id, tenant_id, store_id, sale_id, kind, source_ref_id, source_system,
        external_id, payload_hash, status, document_ref, posted_at, created_at)
     VALUES ($1, $2, $3, $4, 'sale_post', $1, $5, $6, $7, $8,
             CASE WHEN $8 = 'posted' THEN 'SINV-' || $6 END,
             CASE WHEN $9::interval IS NULL THEN NULL ELSE now() - $9::interval END,
             now() - $10::interval)`,
    [
      id,
      tenantId,
      storeId,
      saleId,
      SALES_SOURCE_SYSTEM,
      `rt565-${id}`,
      "a".repeat(64),
      status,
      status === "posted" ? (opts.postedAgo === undefined ? "1 minute" : opts.postedAgo) : null,
      opts.createdAgo ?? "1 hour",
    ],
  );
  return id;
}

async function dbInstant(sql: string, params: unknown[] = []): Promise<string> {
  const r = await scoped.env().admin.query<{ t: Date }>(sql, params);
  return r.rows[0]!.t.toISOString();
}

function expectNoPending(f: Freshness): void {
  expect(f.pendingCount).toBe(0);
  expect(f.oldestPendingAt).toBeNull();
  expect(f.oldestPendingAgeSeconds).toBeNull();
}

// ---------------------------------------------------------------------------

describe("RT-565 §1 — lastPosted.state (D3)", () => {
  it("none: no posted row in scope, and 0 pending is NOT a 'current' verdict (only facts)", async () => {
    if (skip()) return;
    const body = await summary(SES_OWNER_ALL);
    expect(body.postingFreshness).toEqual({
      lastPosted: { state: "none", at: null },
      pendingCount: 0,
      oldestPendingAt: null,
      oldestPendingAgeSeconds: null,
    });
    // D5: the posting domain rule is unchanged (dead-letter driven).
    const posting = body.domains.find((d) => d.domain === "posting")!;
    expect(posting.headlineCount).toBeGreaterThan(0);
  });

  it("unknown: posted rows exist in scope but all predate 0042 (posted_at NULL)", async () => {
    if (skip()) return;
    await intent(STORE_A_X, "posted", { postedAgo: null });
    await intent(STORE_A_Y, "posted", { postedAgo: null });
    expect((await summary(SES_OWNER_ALL)).postingFreshness.lastPosted).toEqual({ state: "unknown", at: null });
  });

  it("known: the max of the non-null posted_at, legacy NULL rows ignored", async () => {
    if (skip()) return;
    await intent(STORE_A_X, "posted", { postedAgo: null });
    const older = await intent(STORE_A_X, "posted", { postedAgo: "2 hours" });
    const newer = await intent(STORE_A_Y, "posted", { postedAgo: "5 minutes" });
    const at = await dbInstant(`SELECT posted_at AS t FROM erpnext_posting_status WHERE id = $1`, [newer]);
    const body = await summary(SES_OWNER_ALL);
    expect(body.postingFreshness.lastPosted).toEqual({ state: "known", at });
    expect(older).not.toBe(newer);
  });
});

describe("RT-565 §2 — pending count and oldest pending (D2)", () => {
  it("counts pending rows only and reports the oldest creation instant; dead letters excluded", async () => {
    if (skip()) return;
    const oldest = await intent(STORE_A_X, "pending", { createdAgo: "2 hours" });
    await intent(STORE_A_Y, "pending", { createdAgo: "10 minutes" });
    await intent(STORE_A_X, "posted");
    const at = await dbInstant(`SELECT created_at AS t FROM erpnext_posting_status WHERE id = $1`, [oldest]);
    const f = (await summary(SES_OWNER_ALL)).postingFreshness;
    expect(f.pendingCount).toBe(2);
    expect(f.oldestPendingAt).toBe(at);
    expect(f.oldestPendingAgeSeconds).toBeGreaterThanOrEqual(7200);
    expect(f.oldestPendingAgeSeconds).toBeLessThan(7200 + 60);
  });

  it("a retried / re-headed row keeps its created_at age (updated_at and retry_count do not move it)", async () => {
    if (skip()) return;
    const id = await intent(STORE_A_X, "pending", { createdAgo: "3 hours" });
    await scoped.env().admin.query(
      `UPDATE erpnext_posting_status SET retry_count = retry_count + 5, updated_at = now() WHERE id = $1`,
      [id],
    );
    const f = (await summary(SES_OWNER_ALL)).postingFreshness;
    expect(f.oldestPendingAgeSeconds).toBeGreaterThanOrEqual(3 * 3600);
  });

  it("a repaired dead letter (permanently_rejected → pending) re-enters with its original age", async () => {
    if (skip()) return;
    const r = await scoped.env().admin.query<{ id: string }>(
      `UPDATE erpnext_posting_status
          SET rejection_message = NULL, status = 'pending', rejection_category = NULL, updated_at = now(),
              created_at = now() - interval '1 day'
        WHERE id = (SELECT id FROM erpnext_posting_status
                     WHERE tenant_id = $1 AND store_id = $2 AND status = 'permanently_rejected'
                     LIMIT 1)
        RETURNING id`,
      [TENANT_A, STORE_A_X],
    );
    try {
      const f = (await summary(SES_OWNER_ALL)).postingFreshness;
      expect(f.pendingCount).toBe(1);
      expect(f.oldestPendingAgeSeconds).toBeGreaterThanOrEqual(86_400);
    } finally {
      await scoped.env().admin.query(
        `UPDATE erpnext_posting_status SET status = 'permanently_rejected', rejection_category = 'unmapped_item'
          WHERE id = $1`,
        [r.rows[0]!.id],
      );
    }
  });

  it("pendingCount = 0 ⇔ oldestPendingAt and its age are null", async () => {
    if (skip()) return;
    await intent(STORE_A_X, "posted");
    expectNoPending((await summary(SES_OWNER_ALL)).postingFreshness);
  });
});

describe("RT-565 §3 — scope: RLS, store filter, RT-192 membership scope (D4)", () => {
  it("tenant B's rows are invisible to tenant A (RLS)", async () => {
    if (skip()) return;
    await intent(STORE_B_X, "posted", { postedAgo: "1 second" });
    await intent(STORE_B_X, "pending", { createdAgo: "1 day" });
    const f = (await summary(SES_OWNER_ALL)).postingFreshness;
    expect(f.lastPosted.state).toBe("none");
    expectNoPending(f);
  });

  it("a store_id filter narrows every fact to that store (a quiet store in a busy tenant)", async () => {
    if (skip()) return;
    // Busy STORE_A_Y: recent postings and a long backlog. Quiet STORE_A_X: one old posting.
    for (let i = 0; i < 5; i += 1) await intent(STORE_A_Y, "posted", { postedAgo: `${i + 1} minutes` });
    await intent(STORE_A_Y, "pending", { createdAgo: "5 hours" });
    const quiet = await intent(STORE_A_X, "posted", { postedAgo: "3 days" });
    const quietAt = await dbInstant(`SELECT posted_at AS t FROM erpnext_posting_status WHERE id = $1`, [quiet]);

    const x = (await summary(SES_OWNER_ALL, { store_id: STORE_A_X })).postingFreshness;
    expect(x.lastPosted).toEqual({ state: "known", at: quietAt });
    expectNoPending(x);

    const y = (await summary(SES_OWNER_ALL, { store_id: STORE_A_Y })).postingFreshness;
    expect(y.pendingCount).toBe(1);
    expect(y.oldestPendingAgeSeconds).toBeGreaterThanOrEqual(5 * 3600);
  });

  it.each(SPECIFIC_SESSIONS)(
    "a specific-membership %s sees only its granted store's facts",
    async (_role, session) => {
      if (skip()) return;
      await intent(STORE_A_Y, "posted", { postedAgo: "1 minute" });
      await intent(STORE_A_Y, "pending", { createdAgo: "1 day" });
      const xPosted = await intent(STORE_A_X, "posted", { postedAgo: "2 days" });
      const xPending = await intent(STORE_A_X, "pending", { createdAgo: "30 minutes" });
      const f = (await summary(session)).postingFreshness;
      expect(f.lastPosted).toEqual({
        state: "known",
        at: await dbInstant(`SELECT posted_at AS t FROM erpnext_posting_status WHERE id = $1`, [xPosted]),
      });
      expect(f.pendingCount).toBe(1);
      expect(f.oldestPendingAt).toBe(
        await dbInstant(`SELECT created_at AS t FROM erpnext_posting_status WHERE id = $1`, [xPending]),
      );
    },
  );

  it("a specific membership with only legacy rows in scope reads unknown, not the other store's known", async () => {
    if (skip()) return;
    await intent(STORE_A_X, "posted", { postedAgo: null });
    await intent(STORE_A_Y, "posted", { postedAgo: "1 minute" });
    expect((await summary(SES_ADMIN_SPEC)).postingFreshness.lastPosted).toEqual({ state: "unknown", at: null });
    expect((await summary(SES_OWNER_ALL)).postingFreshness.lastPosted.state).toBe("known");
  });

  it("an out-of-scope store_id is the non-disclosing 404 (no freshness leaks)", async () => {
    if (skip()) return;
    for (const store_id of [STORE_A_Y, STORE_B_X, NON_EXISTENT]) {
      const res = await get(SES_OWNER_SPEC, { store_id }).expect(404);
      expect(res.body).not.toHaveProperty("postingFreshness");
      expect(res.body.error).toMatchObject({ code: "not_found", message: "Not found." });
    }
  });

  it("freshnessStores: tenant-wide null; a filter inside / outside the membership scope", () => {
    expect(freshnessStores(null, null)).toBeNull();
    expect(freshnessStores(null, [STORE_A_X])).toEqual([STORE_A_X]);
    expect(freshnessStores(STORE_A_Y, null)).toEqual([STORE_A_Y]);
    expect(freshnessStores(STORE_A_X.toUpperCase(), [STORE_A_X])).toEqual([STORE_A_X.toUpperCase()]);
    expect(freshnessStores(STORE_A_Y, [STORE_A_X])).toEqual([]);
    expect(freshnessStores(null, [])).toEqual([]);
  });
});

describe("RT-565 §4 — asOf (D6)", () => {
  it("is a required instant at or after every returned timestamp; the age is measured against it", async () => {
    if (skip()) return;
    await intent(STORE_A_X, "posted", { postedAgo: "0 seconds" });
    await intent(STORE_A_Y, "pending", { createdAgo: "90 seconds" });
    for (const query of [{}, { store_id: STORE_A_Y }]) {
      const body = await summary(SES_OWNER_ALL, query);
      const asOf = Date.parse(body.asOf);
      expect(Number.isNaN(asOf)).toBe(false);
      const f = body.postingFreshness;
      if (f.lastPosted.at !== null) expect(Date.parse(f.lastPosted.at)).toBeLessThanOrEqual(asOf);
      expect(Date.parse(f.oldestPendingAt!)).toBeLessThanOrEqual(asOf);
      const expected = Math.floor((asOf - Date.parse(f.oldestPendingAt!)) / 1000);
      // ±1 s: the wire instants are millisecond-truncated, the SQL age is not.
      expect(Math.abs(f.oldestPendingAgeSeconds! - expected)).toBeLessThanOrEqual(1);
      expect(f.oldestPendingAgeSeconds).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("RT-565 §5 — one statement, one snapshot, asOf after it (D6)", () => {
  it.each([
    ["tenant-wide", null],
    ["store-scoped", [STORE_A_X]],
  ] as const)(
    "%s: an ack and a new intent committed after BEGIN are consistent and never later than asOf",
    async (_label, stores) => {
      if (skip()) return;
      const posted = await intent(STORE_A_X, "pending", { createdAgo: "1 hour" });
      // The summary's transaction starts first: its now() predates the writes below.
      const read = await runWithTenantContext(
        scoped.env().app,
        { tenantId: TENANT_A, isPlatformAdmin: false },
        async (client) => {
          const txNow = (await client.query<{ t: Date }>(`SELECT now() AS t`)).rows[0]!.t;
          await new Promise((r) => setTimeout(r, 50));
          // Concurrent writers commit between BEGIN and the freshness statement.
          await scoped.env().admin.query(
            `UPDATE erpnext_posting_status
                SET rejection_message = NULL, status = 'posted', document_ref = 'SINV-rt565', posted_at = now(), updated_at = now()
              WHERE id = $1`,
            [posted],
          );
          const fresh = await intent(STORE_A_X, "pending", { createdAgo: "0 seconds" });
          const facts = await readPostingFreshness(client, stores === null ? null : [...stores]);
          return { txNow, fresh, facts };
        },
      );
      const asOf = Date.parse(read.facts.asOf);
      const f = read.facts.postingFreshness;
      // Both commits are visible to the one statement, consistently.
      expect(f.lastPosted.state).toBe("known");
      expect(f.pendingCount).toBe(1);
      expect(f.oldestPendingAt).not.toBeNull();
      // Every returned instant is at or before asOf, which is later than the
      // transaction's now() (a now()-based asOf would be earlier than both writes).
      expect(Date.parse(f.lastPosted.at!)).toBeLessThanOrEqual(asOf);
      expect(Date.parse(f.oldestPendingAt!)).toBeLessThanOrEqual(asOf);
      expect(Date.parse(f.lastPosted.at!)).toBeGreaterThan(read.txNow.getTime());
      expect(f.oldestPendingAgeSeconds).toBeGreaterThanOrEqual(0);
    },
  );
});

describe("RT-565 §6 — roles and auth unchanged (D4)", () => {
  it("the summary stays @Roles('owner', 'tenant_admin')", () => {
    const meta = Reflect.getMetadata(ROLES_METADATA_KEY, ErpnextSyncOpsController.prototype.getSummary) as {
      any: string[];
    };
    expect([...meta.any].sort()).toEqual(["owner", "tenant_admin"]);
  });

  // The guard chain (DashboardAuthGuard → TenantContextGuard → RolesGuard) is
  // unchanged by RT-565; machine-credential rejection stays covered by the
  // dashboard guard's own specs.
  it("no session is rejected before any freshness is read", async () => {
    if (skip()) return;
    const res = await request(scoped.app().getHttpServer()).get(SUMMARY).expect(401);
    expect(res.body).not.toHaveProperty("postingFreshness");
  });
});
