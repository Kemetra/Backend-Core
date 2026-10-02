/**
 * T076 — 007-POLISH-AUDIT-SWEEP — Absence-guard for forbidden operations.
 *
 * Spec anchors: FR-023, FR-045, SC-003. The review-queue API MUST NOT expose
 * any force-link / override-conflict path, NOR any bulk-link / bulk-create /
 * bulk-reopen operation — neither in the OpenAPI contract (no such operationId
 * after the T010 extension) NOR as a routable endpoint (a request to a
 * plausible such route returns 404/405, never a success).
 *
 * Two halves:
 *   1. CONTRACT absence (load-only, no Docker): enumerate every operationId +
 *      path in the merged `unknown-items.yaml` and assert the forbidden set is
 *      absent; the conformance set contains ONLY the 8 allowed operationIds
 *      (5 shipped + 3 new).
 *   2. ROUTING absence (app boot, no Docker — an unmounted route 404s in the
 *      Nest router before any handler/DB is reached): POST to plausible
 *      forbidden routes → 404/405.
 *
 * No Testcontainers: the contract half is a file load; the routing half asserts
 * the ABSENCE of routes, so no handler (and no DB) is ever invoked.
 */
import "reflect-metadata";

import {
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
} from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { resolve } from "node:path";
import request from "supertest";

import { loadOpenApiContracts } from "../../../../src/openapi/loader";
import { GlobalExceptionFilter } from "../../../../src/common/exception.filter";
import { PG_POOL } from "../../../../src/auth/auth.module";
import {
  AUDIT_JOB_ENQUEUER,
  NoOpAuditJobEnqueuer,
} from "../../../../src/audit/audit-job.enqueuer";
import type { ResolvedContext } from "../../../../src/context/types";
import { UnknownItemsController } from "../../../../src/catalog/unknown-items/unknown-items.controller";
import { UnknownItemsService } from "../../../../src/catalog/unknown-items/unknown-items.service";
import { ReconciliationController } from "../../../../src/catalog/reconciliation/reconciliation.controller";
import { ReconciliationService } from "../../../../src/catalog/reconciliation/reconciliation.service";
import { DashboardAuthGuard } from "../../../../src/auth/dashboard-auth.guard";
import { PosOperatorAuthGuard } from "../../../../src/auth/pos-operator-auth.guard";
import { RolesGuard } from "../../../../src/auth/roles.guard";
import { TenantContextGuard } from "../../../../src/context/tenant-context.guard";

const CONTRACT_ID = "unknown-items";

/** The complete allowed operationId set after the 007 extension (FR-045 / SC-003). */
const ALLOWED_OPERATION_IDS = [
  // 5 shipped (005 Wave 1 + Wave 2)
  "posCaptureItem",
  "tenantAdminListUnknownItems",
  "tenantAdminDismissUnknownItem",
  "tenantAdminLinkUnknownItem",
  "tenantAdminCreateProductFromUnknownItem",
  // 3 new (007)
  "tenantAdminInspectUnknownItem",
  "tenantAdminReopenUnknownItem",
  "tenantAdminBulkDismissUnknownItems",
].sort();

/** operationId substrings that MUST NOT appear (FR-023 / FR-045). */
const FORBIDDEN_OPERATION_SUBSTRINGS = [
  "force",
  "override",
  "bulklink",
  "bulkcreate",
  "bulkreopen",
];

interface OpenApiDocument {
  paths?: Record<string, Record<string, { operationId?: string }>>;
}

function catalogContractsDir(): string {
  // This spec lives at apps/api/test/catalog/unknown-items/contract/ — SIX
  // levels under the repo root (contract → unknown-items → catalog → test →
  // api → apps). contract-007.spec.ts is one level shallower and uses five
  // `..`; this file needs SIX.
  return resolve(
    __dirname,
    "..",
    "..",
    "..",
    "..",
    "..",
    "..",
    "packages",
    "contracts",
    "openapi",
    "catalog",
  );
}

let catalogDoc: OpenApiDocument;

function allOperationIds(): string[] {
  const ids: string[] = [];
  for (const item of Object.values(catalogDoc.paths ?? {})) {
    for (const op of Object.values(item)) {
      if (typeof op.operationId === "string") ids.push(op.operationId);
    }
  }
  return ids;
}

beforeAll(() => {
  const contracts = loadOpenApiContracts({ dir: catalogContractsDir() });
  const c = contracts.find((x) => x.id === CONTRACT_ID);
  if (!c) throw new Error(`${CONTRACT_ID} contract not found`);
  catalogDoc = c.document as OpenApiDocument;
});

// ===========================================================================
// 1. Contract absence (load-only)
// ===========================================================================
describe("T076 / 007 — contract exposes ONLY the allowed operationIds [FR-023, FR-045, SC-003]", () => {
  it("the operationId set is exactly the 8 allowed ids (no force/override/bulk-link/bulk-create/bulk-reopen)", () => {
    const ids = allOperationIds().sort();
    expect(ids).toEqual(ALLOWED_OPERATION_IDS);
  });

  it("no operationId matches a forbidden surface (force-link / override / bulk-link / bulk-create / bulk-reopen)", () => {
    const normalized = allOperationIds().map((id) => id.toLowerCase());
    for (const forbidden of FORBIDDEN_OPERATION_SUBSTRINGS) {
      const hit = normalized.find((id) => id.includes(forbidden));
      expect(hit).toBeUndefined();
    }
  });

  it("the only bulk operation is bulk-DISMISS (FR-045 — no bulk-link/bulk-create/bulk-reopen)", () => {
    const bulkOps = allOperationIds().filter((id) =>
      id.toLowerCase().includes("bulk"),
    );
    expect(bulkOps).toEqual(["tenantAdminBulkDismissUnknownItems"]);
  });
});

// ===========================================================================
// 2. Routing absence (app boot, no DB — an unmounted route 404s pre-handler)
// ===========================================================================

class AllowContextGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<{ context?: ResolvedContext }>();
    req.context = {
      userId: "0a000000-0000-7000-8000-0000000760a1",
      tenantId: "0a000000-0000-7000-8000-0000000760t1",
      storeId: null,
      isPlatformAdmin: false,
      source: "session",
      storeAccess: { kind: "all" },
    };
    return true;
  }
}

let app: INestApplication | null = null;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    controllers: [UnknownItemsController, ReconciliationController],
    providers: [
      // No real pool is needed — every assertion below targets an UNMOUNTED
      // route, so the Nest router 404s before any handler (and any DB call).
      { provide: PG_POOL, useValue: {} },
      UnknownItemsService,
      ReconciliationService,
      { provide: AUDIT_JOB_ENQUEUER, useClass: NoOpAuditJobEnqueuer },
    ],
  })
    .overrideGuard(DashboardAuthGuard).useValue({ canActivate: () => true })
    .overrideGuard(PosOperatorAuthGuard).useValue({ canActivate: () => true })
    .overrideGuard(TenantContextGuard).useValue({ canActivate: () => true })
    .overrideGuard(RolesGuard).useValue({ canActivate: () => true })
    .compile();

  app = moduleRef.createNestApplication({ bufferLogs: true });
  app.useGlobalFilters(new GlobalExceptionFilter());
  app.useGlobalGuards(new AllowContextGuard());
  await app.init();
}, 60_000);

afterAll(async () => {
  if (app) await app.close();
}, 30_000);

function http() {
  if (!app) throw new Error("app not initialised");
  return request(app.getHttpServer());
}

const ID = "0a000000-0000-7000-8000-00000076a001";

describe("T076 / 007 — forbidden routes do not exist (404/405) [FR-023, FR-045, SC-003]", () => {
  // Each plausible forbidden route must NOT be a success — it must 404 (no such
  // route) or 405 (method not allowed). A 2xx would mean the surface exists.
  const forbiddenRoutes: Array<{ method: "post"; path: string; label: string }> = [
    { method: "post", path: `/api/v1/catalog/unknown-items/${ID}/force-link`, label: "force-link" },
    { method: "post", path: `/api/v1/catalog/unknown-items/${ID}/override-conflict`, label: "override-conflict" },
    { method: "post", path: `/api/v1/catalog/unknown-items/bulk-link`, label: "bulk-link" },
    { method: "post", path: `/api/v1/catalog/unknown-items/bulk-create`, label: "bulk-create" },
    { method: "post", path: `/api/v1/catalog/unknown-items/bulk-reopen`, label: "bulk-reopen" },
  ];

  it.each(forbiddenRoutes)("$label is not routable (404/405)", async ({ method, path }) => {
    const res = await http()[method](path).send({});
    expect([404, 405]).toContain(res.status);
  });
});
