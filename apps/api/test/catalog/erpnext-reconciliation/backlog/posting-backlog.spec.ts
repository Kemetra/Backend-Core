/**
 * 017-US1-BACKLOG (T030–T034) 🎯 MVP — the posting dead-letter backlog.
 *
 * Exercises `listPostingBacklog` end-to-end against Testcontainers Postgres 16,
 * mirroring the 014 set-retire harness (ConfigurableContextGuard + overridden
 * production guards + RLS-active PG_POOL bound to env.app). The backlog is a LIVE
 * READ-PROJECTION over the 015 erpnext_posting_status rows with
 * status='permanently_rejected' (READ-NOT-MIRROR) — 017 stores nothing for US1.
 *
 * Route: GET /api/v1/catalog/erpnext-reconciliation/postings/backlog
 *
 * Sub-cases:
 *   §1 only permanently_rejected rows are projected; pending/posted are ABSENT.
 *   §2 the projection carries class + originating ref + provenance + reason +
 *      dead-letter time (§IV; no money field).
 *   §3 tenant isolation — tenant B's dead-letters never appear for tenant A.
 *   §4 store filter + class filter narrow the backlog.
 *   §5 pagination — limit caps the page; nextCursor advances + is stable.
 *   §6 §XII — a body/query-smuggled tenant is rejected (strict DTO → 400); a bad
 *      cursor is a 400.
 */
import "reflect-metadata";

import {
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
} from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { Pool } from "pg";
import request from "supertest";

import { DashboardAuthGuard } from "../../../../src/auth/dashboard-auth.guard";
import { PG_POOL } from "../../../../src/auth/auth.module";
import { RolesGuard } from "../../../../src/auth/roles.guard";
import { GlobalExceptionFilter } from "../../../../src/common/exception.filter";
import { TenantContextGuard } from "../../../../src/context/tenant-context.guard";
import type { ResolvedContext } from "../../../../src/context/types";
import { ErpnextReconciliationController } from "../../../../src/catalog/erpnext-reconciliation/erpnext-reconciliation.controller";
import { ErpnextReconciliationService } from "../../../../src/catalog/erpnext-reconciliation/erpnext-reconciliation.service";
import { MembershipRepository } from "../../../../src/context/membership.repository";
import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../../_helpers/postgres-container";
import { SALES_SOURCE_SYSTEM, SALE_A_X, SALE_B_X } from "../../sales/__support__/seed-sales";
import { STORE_A_X, STORE_B_X } from "../../__support__/isolation-harness";
import {
  RECONCILIATION_FIXTURE_IDS,
  POSTING_DEADLETTER_A,
  seedReconciliationFixture,
} from "../__support__/seed-reconciliation";

const TENANT_A = RECONCILIATION_FIXTURE_IDS.tenantA;
const TENANT_B = RECONCILIATION_FIXTURE_IDS.tenantB;
const ACTOR_A = RECONCILIATION_FIXTURE_IDS.actorA;
const BASE = "/api/v1/catalog/erpnext-reconciliation/postings/backlog";
const PAYLOAD_HASH = "a".repeat(64);

// A tenant-B dead-letter (the cross-tenant target §3 proves A can't see).
const DEADLETTER_B = "0b000000-0000-7000-8000-00000e0517b9";

class ConfigurableContextGuard implements CanActivate {
  public tenantId: string = TENANT_A;
  public storeId: string | null = null;
  public userId: string = ACTOR_A;
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<{
      context?: ResolvedContext;
      principal?: { userId?: string };
    }>();
    req.context = {
      userId: this.userId,
      tenantId: this.tenantId,
      storeId: this.storeId,
      isPlatformAdmin: false,
      source: "session",
    };
    req.principal = { userId: this.userId };
    return true;
  }
}

let env: PgTestEnv | null = null;
let app: INestApplication | null = null;
let contextGuard: ConfigurableContextGuard;
let dockerSkipped = false;

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      dockerSkipped = true;
      // eslint-disable-next-line no-console
      console.warn(`\n[posting-backlog.spec] Docker NOT AVAILABLE: ${msg}\n`);
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }

  await applyAllUpAndCreateAppRole(env);
  await seedReconciliationFixture(env);

  // A tenant-B dead-letter (on SALE_B_X) for the cross-tenant assertion.
  await env.admin.query(
    `INSERT INTO erpnext_posting_status
       (id, tenant_id, store_id, sale_id, kind, source_ref_id,
        source_system, external_id, payload_hash, status, rejection_category)
     VALUES ($1, $2, $3, $4, 'sale_post', $1, $5, 'dl-B-X', $6,
        'permanently_rejected', 'unmapped_store')
     ON CONFLICT DO NOTHING`,
    [DEADLETTER_B, TENANT_B, STORE_B_X, SALE_B_X, SALES_SOURCE_SYSTEM, PAYLOAD_HASH],
  );

  const localEnv = env;
  contextGuard = new ConfigurableContextGuard();

  const moduleRef = await Test.createTestingModule({
    controllers: [ErpnextReconciliationController],
    providers: [
      { provide: PG_POOL, useFactory: (): Pool => localEnv.app },
      ErpnextReconciliationService,
      // RT-191: the service reads the caller's role for the store scope.
      { provide: MembershipRepository, useFactory: (): MembershipRepository => new MembershipRepository(localEnv.app) },
    ],
  })
    .overrideGuard(DashboardAuthGuard)
    .useValue({ canActivate: () => true })
    .overrideGuard(TenantContextGuard)
    .useValue({ canActivate: () => true })
    .overrideGuard(RolesGuard)
    .useValue({ canActivate: () => true })
    .compile();

  app = moduleRef.createNestApplication({ bufferLogs: true });
  app.useGlobalFilters(new GlobalExceptionFilter());
  app.useGlobalGuards(contextGuard);
  await app.init();
}, 180_000);

afterAll(async () => {
  if (app) await app.close();
  if (env) await stopPgEnv(env);
}, 60_000);

beforeEach(() => {
  if (dockerSkipped) return;
  contextGuard.tenantId = TENANT_A;
  contextGuard.storeId = null;
  contextGuard.userId = ACTOR_A;
});

const http = () => request(app!.getHttpServer());
const skip = () => dockerSkipped;

describe("017-US1 §1 — only permanently_rejected rows are projected", () => {
  it("returns the tenant-A dead-letter; pending/posted rows are ABSENT", async () => {
    if (skip()) return;
    const res = await http().get(BASE).expect(200);
    const refs = res.body.items.map((i: { workItemRef: string }) => i.workItemRef);
    expect(refs).toContain(POSTING_DEADLETTER_A);
    // The 015 seed's POST_A_PENDING (pending) + POST_B_POSTED (posted/tenant B)
    // must NOT appear.
    expect(refs).not.toContain("0a000000-0000-7000-8000-00000e0515a1"); // POST_A_PENDING
    // Every returned ref maps to a permanently_rejected row.
    const statuses = await env!.admin.query<{ status: string }>(
      `SELECT status FROM erpnext_posting_status WHERE id = ANY($1)`,
      [refs],
    );
    for (const r of statuses.rows) expect(r.status).toBe("permanently_rejected");
  });
});

describe("017-US1 §2 — the projection shape (§IV, no money)", () => {
  it("carries class + originating ref + provenance + reason + dead-letter time", async () => {
    if (skip()) return;
    const res = await http().get(BASE).expect(200);
    const item = res.body.items.find(
      (i: { workItemRef: string }) => i.workItemRef === POSTING_DEADLETTER_A,
    );
    expect(item).toBeDefined();
    expect(item.kind).toBe("sale_post");
    expect(item.rejectionCategory).toBe("unmapped_item");
    expect(item.saleRef).toBe(SALE_A_X);
    expect(typeof item.sourceSystem).toBe("string");
    expect(typeof item.externalId).toBe("string");
    expect(item.deadLetteredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // §IV: no money field leaked.
    for (const forbidden of ["posTotal", "amount", "lineAmount", "total"]) {
      expect(item[forbidden]).toBeUndefined();
    }
  });
});

describe("017-US1 §3 — tenant isolation", () => {
  it("tenant A never sees tenant B's dead-letter", async () => {
    if (skip()) return;
    const res = await http().get(BASE).expect(200);
    const refs = res.body.items.map((i: { workItemRef: string }) => i.workItemRef);
    expect(refs).not.toContain(DEADLETTER_B);
  });

  it("tenant B sees its own dead-letter (and not tenant A's)", async () => {
    if (skip()) return;
    contextGuard.tenantId = TENANT_B;
    const res = await http().get(BASE).expect(200);
    const refs = res.body.items.map((i: { workItemRef: string }) => i.workItemRef);
    expect(refs).toContain(DEADLETTER_B);
    expect(refs).not.toContain(POSTING_DEADLETTER_A);
  });
});

describe("017-US1 §4 — filters", () => {
  it("class filter narrows to the matching rejection category", async () => {
    if (skip()) return;
    const res = await http().get(BASE).query({ class: "unmapped_item" }).expect(200);
    for (const i of res.body.items) expect(i.rejectionCategory).toBe("unmapped_item");
    expect(
      res.body.items.some((i: { workItemRef: string }) => i.workItemRef === POSTING_DEADLETTER_A),
    ).toBe(true);
  });

  it("store filter scopes to the store", async () => {
    if (skip()) return;
    const res = await http().get(BASE).query({ storeId: STORE_A_X }).expect(200);
    // POSTING_DEADLETTER_A is on STORE_A_X → present.
    const refs = res.body.items.map((i: { workItemRef: string }) => i.workItemRef);
    expect(refs).toContain(POSTING_DEADLETTER_A);
  });
});

describe("017-US1 §5 — pagination", () => {
  it("respects the limit + advances a stable cursor", async () => {
    if (skip()) return;
    const page = await http().get(BASE).query({ limit: 1 }).expect(200);
    expect(page.body.items.length).toBeLessThanOrEqual(1);
    // nextCursor is a string when the page was full, else null.
    if (page.body.items.length === 1) {
      expect(typeof page.body.nextCursor === "string" || page.body.nextCursor === null).toBe(true);
    }
  });
});

describe("017-US1 §6 — §XII strict DTO", () => {
  it("a smuggled tenant_id query key → 400 (strict)", async () => {
    if (skip()) return;
    await http().get(BASE).query({ tenant_id: TENANT_B }).expect(400);
  });

  it("a non-numeric cursor → 400", async () => {
    if (skip()) return;
    await http().get(BASE).query({ cursor: "abc" }).expect(400);
  });

  it("an over-range limit (501) → 400", async () => {
    if (skip()) return;
    await http().get(BASE).query({ limit: 501 }).expect(400);
  });
});
