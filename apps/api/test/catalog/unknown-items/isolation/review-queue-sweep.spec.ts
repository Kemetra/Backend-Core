/**
 * review-queue-sweep.spec.ts  (007 — T025)
 *
 * Cross-tenant / cross-store / RLS-bypass isolation sweep for the 007
 * review-queue READ surface, extended to the TERMINAL rows (dismissed +
 * resolved) the review queue exposes via `?status=` and inspect. The 005
 * `cross-tenant.spec.ts` proved this posture for PENDING rows; this sweep
 * proves it holds for the dismissed/resolved fixtures T024 added — the rows a
 * reopen / terminal-detail caller will reach.
 *
 * Per SI-001 / SI-002 / SI-004 and FR-060 (authn) / FR-061 (cross-tenant
 * impossible) / FR-062 (fail-closed → non-disclosing not-found):
 *   - cross-tenant id        → non-disclosing 404 (NotFoundException)
 *   - out-of-scope store id   → non-disclosing 404 (store-scoped actor probing
 *                               another store's terminal item in the same tenant)
 *   - RLS-bypass probe        → wrong app.current_tenant → zero rows → 404
 *
 * Wiring strategy — SERVICE-DIRECT, matching the 005 `cross-tenant.spec.ts`
 * idiom (no Nest DI / supertest). The inspect read path is exactly
 * `UnknownItemsService.findByIdForTenant`, which exists at HEAD; the sweep
 * exercises it against `env.app` (the RLS-enforced app-role pool — NOT
 * `env.admin`, which bypasses RLS and would let a cross-tenant read silently
 * succeed).
 *
 * The reopen (US7) and bulk-dismiss (US8) operations are NOT in this wave
 * (Phases 6–7). Their isolation cases are `it.skip`-tripwired below, pointing
 * at the owning slice — the 005 house style for "this assertion belongs to a
 * slice not yet in scope" (cf. the list-case skip in cross-tenant.spec.ts).
 * Authoring their service methods here would silently expand the slice.
 */
import { NotFoundException } from "@nestjs/common";

import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../../_helpers/postgres-container";
import { seedCatalogIsolationFixture } from "../../__support__/isolation-harness";
import {
  seedUnknownItemsFixture,
  UNKNOWN_ITEMS_FIXTURE_IDS,
} from "../../__support__/seed-unknown-items";
import { UnknownItemsService } from "../../../../src/catalog/unknown-items/unknown-items.service";

let env: PgTestEnv | null = null;
let dockerSkipped = false;
let service: UnknownItemsService | null = null;

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    await seedCatalogIsolationFixture(env); // parent tenants/stores/products/actors
    await seedUnknownItemsFixture(env); // 005 pending + T024 terminal rows
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      dockerSkipped = true;
      // eslint-disable-next-line no-console
      console.warn(`\n[T025 review-queue-sweep] Docker NOT AVAILABLE: ${msg}\n`);
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }
  service = new UnknownItemsService(env.app);
}, 180_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

function maybeSkip(): boolean {
  if (dockerSkipped) {
    // eslint-disable-next-line no-console
    console.warn("[T025 review-queue-sweep] skipping — Docker unavailable");
    return true;
  }
  return false;
}

const F = UNKNOWN_ITEMS_FIXTURE_IDS;

// --------------------------------------------------------------------------
// Group A — in-scope baseline: a terminal row IS readable in its own scope.
// This is the assertion a "404 because route/row missing" bug would VIOLATE —
// it anchors the sweep so the cross-scope 404s below can't pass vacuously.
// --------------------------------------------------------------------------

describe("T025 — inspect read path reaches in-scope terminal rows", () => {
  it("tenant-wide actor reads its own DISMISSED row → row returned", async () => {
    if (maybeSkip()) return;
    const row = await service!.findByIdForTenant({
      id: F.dismissedAX,
      tenantId: F.tenantA,
      storeScope: { kind: "tenant" },
    });
    expect(row.id).toBe(F.dismissedAX);
    expect(row.resolutionStatus).toBe("dismissed");
  });

  it("tenant-wide actor reads its own RESOLVED row → row returned with product reference", async () => {
    if (maybeSkip()) return;
    const row = await service!.findByIdForTenant({
      id: F.resolvedAX,
      tenantId: F.tenantA,
      storeScope: { kind: "tenant" },
    });
    expect(row.id).toBe(F.resolvedAX);
    expect(row.resolutionStatus).toBe("resolved");
    expect(row.resolvedProductId).toBe(F.resolvedProductA);
  });

  it("store-scoped actor reads a terminal row in ITS OWN store → row returned", async () => {
    if (maybeSkip()) return;
    const row = await service!.findByIdForTenant({
      id: F.dismissedAX,
      tenantId: F.tenantA,
      storeScope: { kind: "stores", storeIds: [F.storeAX] },
    });
    expect(row.id).toBe(F.dismissedAX);
  });
});

// --------------------------------------------------------------------------
// Group B — cross-tenant: a terminal row is unreachable from the other tenant
// (SI-001 / FR-061), non-disclosing 404 (FR-062 / SI-004).
// --------------------------------------------------------------------------

describe("T025 — cross-tenant terminal rows are non-disclosing 404", () => {
  it("tenant A reading tenant B's DISMISSED row → 404", async () => {
    if (maybeSkip()) return;
    await expect(
      service!.findByIdForTenant({
        id: F.dismissedBX,
        tenantId: F.tenantA,
        storeScope: { kind: "tenant" },
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("tenant A reading tenant B's RESOLVED row → 404", async () => {
    if (maybeSkip()) return;
    await expect(
      service!.findByIdForTenant({
        id: F.resolvedBX,
        tenantId: F.tenantA,
        storeScope: { kind: "tenant" },
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("tenant B reading tenant A's RESOLVED row → 404 (symmetry)", async () => {
    if (maybeSkip()) return;
    await expect(
      service!.findByIdForTenant({
        id: F.resolvedAX,
        tenantId: F.tenantB,
        storeScope: { kind: "tenant" },
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

// --------------------------------------------------------------------------
// Group C — out-of-scope store: a store-scoped actor cannot read a terminal
// row in a DIFFERENT store of the SAME tenant (SI-002 / SI-004), non-disclosing.
// --------------------------------------------------------------------------

describe("T025 — out-of-scope store terminal rows are non-disclosing 404", () => {
  it("store-A-X actor reading the A-Y DISMISSED row → 404", async () => {
    if (maybeSkip()) return;
    await expect(
      service!.findByIdForTenant({
        id: F.dismissedAY,
        tenantId: F.tenantA,
        storeScope: { kind: "stores", storeIds: [F.storeAX] }, // actor scoped to X, row is in Y
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("store-A-X actor reading the A-Y RESOLVED row → 404", async () => {
    if (maybeSkip()) return;
    await expect(
      service!.findByIdForTenant({
        id: F.resolvedAY,
        tenantId: F.tenantA,
        storeScope: { kind: "stores", storeIds: [F.storeAX] },
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

// --------------------------------------------------------------------------
// Group D — RLS-bypass probe: setting the WRONG tenant context yields zero
// rows → 404 (FR-062 fail-closed). This is the malicious-override surface:
// the caller-supplied tenant context (not a body field) governs visibility,
// and a mismatch never discloses the row.
// --------------------------------------------------------------------------

describe("T025 — RLS-bypass probe fails closed", () => {
  it("reading a real tenant-A row id under tenant-B context → 404 (zero rows)", async () => {
    if (maybeSkip()) return;
    // The id is genuine (tenant A's dismissed row), but the tenant context is
    // B. RLS filters it out → NotFoundException, indistinguishable from a
    // non-existent id. No path lets the B-context read see A's row.
    await expect(
      service!.findByIdForTenant({
        id: F.dismissedAX,
        tenantId: F.tenantB,
        storeScope: { kind: "tenant" },
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

// --------------------------------------------------------------------------
// Deferred — reopen (US7, Phase 6) and bulk-dismiss (US8, Phase 7) are NOT in
// this wave. Their service methods (reopenUnknownItem / bulkDismissUnknownItems)
// do not exist yet; authoring them here would expand the slice. These tripwires
// mark the isolation cases the owning slices MUST add to this sweep.
// --------------------------------------------------------------------------

describe("T025 — reopen / bulk-dismiss isolation (deferred to US7 / US8)", () => {
  it.skip(
    "reopen of a cross-tenant dismissed row → non-disclosing 404 (owned by 007-US7-REOPEN, Phase 6)",
    () => {},
  );
  it.skip(
    "reopen by a store-scoped actor of an in-scope dismissed row → 403 forbidden (FR-042; owned by 007-US7-REOPEN)",
    () => {},
  );
  it.skip(
    "bulk-dismiss silently drops cross-tenant / out-of-scope ids → per-item not-found, no leak (owned by 007-US8-BULK-DISMISS, Phase 7)",
    () => {},
  );
});
