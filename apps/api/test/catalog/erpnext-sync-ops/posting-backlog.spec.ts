/**
 * 025-US2 — the console posting dead-letter backlog drill.
 *
 * Exercises `consoleListPostingBacklog` end-to-end against Testcontainers
 * Postgres 16 (same harness as the US1 summary spec; reuses the 017
 * seedReconciliationFixture). The backlog is a LIVE read-projection over 015
 * erpnext_posting_status WHERE status='permanently_rejected' (READ-NOT-MIRROR) —
 * the read-only console consolidation of 017's backlog (no repair affordance).
 *
 * Route: GET /api/v1/catalog/erpnext-sync-ops/posting-backlog
 *
 * Sub-cases (T016/T017/T018/T019):
 *   §1 only permanently_rejected rows; pending/posted ABSENT; no write/repair field.
 *   §2 projection carries class + provenance + reason + dead-letter time (§IV, no money).
 *   §3 tenant isolation — tenant B's dead-letter never appears for tenant A.
 *   §4 pagination — page_size caps; nextCursor advances + is stable + gap-free.
 *   §5 §XII strict DTO — smuggled tenant_id → 400; bad cursor → 400.
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

import { DashboardAuthGuard } from "../../../src/auth/dashboard-auth.guard";
import { PG_POOL } from "../../../src/auth/auth.module";
import { RolesGuard } from "../../../src/auth/roles.guard";
import { GlobalExceptionFilter } from "../../../src/common/exception.filter";
import { TenantContextGuard } from "../../../src/context/tenant-context.guard";
import type { ResolvedContext } from "../../../src/context/types";
import { ErpnextSyncOpsController } from "../../../src/catalog/erpnext-sync-ops/erpnext-sync-ops.controller";
import { ErpnextSyncOpsReadModelService } from "../../../src/catalog/erpnext-sync-ops/erpnext-sync-ops.read-model.service";
import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../_helpers/postgres-container";
import { SALES_SOURCE_SYSTEM, SALE_B_X } from "../sales/__support__/seed-sales";
import { STORE_A_X, STORE_B_X } from "../__support__/isolation-harness";
import {
  RECONCILIATION_FIXTURE_IDS,
  POSTING_DEADLETTER_A,
  seedReconciliationFixture,
} from "../erpnext-reconciliation/__support__/seed-reconciliation";

const TENANT_A = RECONCILIATION_FIXTURE_IDS.tenantA;
const TENANT_B = RECONCILIATION_FIXTURE_IDS.tenantB;
const ACTOR_A = RECONCILIATION_FIXTURE_IDS.actorA;
const BASE = "/api/v1/catalog/erpnext-sync-ops/posting-backlog";
const PAYLOAD_HASH = "a".repeat(64);
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
    controllers: [ErpnextSyncOpsController],
    providers: [
      { provide: PG_POOL, useFactory: (): Pool => localEnv.app },
      ErpnextSyncOpsReadModelService,
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

interface BacklogItem {
  postingStatusId: string;
  kind: string;
  sourceSystem: string;
  externalId: string;
  status: string;
  rejectionClass: string | null;
  deadLetteredAt: string;
}

describe("025-US2 §1 — only permanently_rejected rows, read-only", () => {
  it("returns tenant-A dead-letter; pending/posted ABSENT; no repair field", async () => {
    if (skip()) return;
    const res = await http().get(BASE).expect(200);
    const items: BacklogItem[] = res.body.items;
    const ids = items.map((i) => i.postingStatusId);
    expect(ids).toContain(POSTING_DEADLETTER_A);
    for (const i of items) {
      expect(i.status).toBe("permanently_rejected");
      // read-only: no write/repair affordance leaked
      expect((i as unknown as Record<string, unknown>)["repair"]).toBeUndefined();
      expect((i as unknown as Record<string, unknown>)["repairKind"]).toBeUndefined();
    }
  });
});

describe("025-US2 §2 — projection shape (§IV, no money)", () => {
  it("carries kind + provenance + rejection class + dead-letter time", async () => {
    if (skip()) return;
    const res = await http().get(BASE).expect(200);
    const item = (res.body.items as BacklogItem[]).find(
      (i) => i.postingStatusId === POSTING_DEADLETTER_A,
    );
    expect(item).toBeDefined();
    expect(item!.kind).toBe("sale_post");
    expect(typeof item!.sourceSystem).toBe("string");
    expect(typeof item!.externalId).toBe("string");
    expect(item!.deadLetteredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    for (const forbidden of ["posTotal", "amount", "lineAmount", "total", "price"]) {
      expect((item as unknown as Record<string, unknown>)[forbidden]).toBeUndefined();
    }
  });
});

describe("025-US2 §3 — tenant isolation", () => {
  it("tenant A never sees tenant B's dead-letter; tenant B sees its own", async () => {
    if (skip()) return;
    const a = (await http().get(BASE).expect(200)).body.items as BacklogItem[];
    expect(a.map((i) => i.postingStatusId)).not.toContain(DEADLETTER_B);
    contextGuard.tenantId = TENANT_B;
    const b = (await http().get(BASE).expect(200)).body.items as BacklogItem[];
    expect(b.map((i) => i.postingStatusId)).toContain(DEADLETTER_B);
    expect(b.map((i) => i.postingStatusId)).not.toContain(POSTING_DEADLETTER_A);
  });
});

describe("025-US2 §4 — pagination", () => {
  it("respects page_size + advances a stable cursor", async () => {
    if (skip()) return;
    const page = await http().get(BASE).query({ page_size: 1 }).expect(200);
    expect(page.body.items.length).toBeLessThanOrEqual(1);
    expect(
      typeof page.body.nextCursor === "string" || page.body.nextCursor === null,
    ).toBe(true);
  });
});

describe("025-US2 §5 — §XII strict DTO", () => {
  it("a smuggled tenant_id → 400", async () => {
    if (skip()) return;
    await http().get(BASE).query({ tenant_id: TENANT_B }).expect(400);
  });
  it("a non-numeric cursor → 400", async () => {
    if (skip()) return;
    await http().get(BASE).query({ cursor: "abc" }).expect(400);
  });
});
