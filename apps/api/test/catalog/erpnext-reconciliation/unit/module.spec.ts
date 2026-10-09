/**
 * 017 — module wiring unit spec (Docker-free).
 *
 * Instantiates ErpnextReconciliationModule via Test.createTestingModule (which
 * executes the @Module metadata + DI graph) with the PG_POOL + audit/auth deps
 * overridden, and asserts the controller + service resolve. This exercises
 * erpnext-reconciliation.module.ts (otherwise 0% — boot-only DI wiring) without a
 * full app boot or a database.
 */
import "reflect-metadata";

import { Test } from "@nestjs/testing";

import { PG_POOL } from "../../../../src/auth/auth.module";
import { AUDIT_JOB_ENQUEUER } from "../../../../src/audit/audit-job.enqueuer";
import { RolesGuard } from "../../../../src/auth/roles.guard";
import { ErpnextReconciliationModule } from "../../../../src/catalog/erpnext-reconciliation/erpnext-reconciliation.module";
import { ErpnextReconciliationController } from "../../../../src/catalog/erpnext-reconciliation/erpnext-reconciliation.controller";
import { ErpnextPostingReResolutionService } from "../../../../src/catalog/erpnext-reconciliation/posting-re-resolution.service";
import { ErpnextReconciliationService } from "../../../../src/catalog/erpnext-reconciliation/erpnext-reconciliation.service";
import { NegativeOnHandController } from "../../../../src/catalog/erpnext-reconciliation/negative-on-hand.controller";
import { NegativeOnHandService } from "../../../../src/catalog/erpnext-reconciliation/negative-on-hand.service";

describe("ErpnextReconciliationModule — DI wiring", () => {
  it("instantiates the module and resolves the controller + service", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ErpnextReconciliationModule],
    })
      // Override the leaf providers the imported AuthModule/AuditModule pull in,
      // so the module graph compiles without a real pool/redis/queue.
      .overrideProvider(PG_POOL)
      .useValue({})
      .overrideProvider(AUDIT_JOB_ENQUEUER)
      .useValue({ enqueue: async () => undefined })
      .compile();

    expect(moduleRef.get(ErpnextReconciliationController)).toBeInstanceOf(
      ErpnextReconciliationController,
    );
    expect(moduleRef.get(ErpnextReconciliationService)).toBeInstanceOf(
      ErpnextReconciliationService,
    );
    // RT-333 — the re-resolve route's service is wired in the same module.
    expect(moduleRef.get(ErpnextPostingReResolutionService)).toBeInstanceOf(
      ErpnextPostingReResolutionService,
    );
    // RT-177 — the read-only negative on-hand view is wired in the same module.
    expect(moduleRef.get(NegativeOnHandController)).toBeInstanceOf(NegativeOnHandController);
    expect(moduleRef.get(NegativeOnHandService)).toBeInstanceOf(NegativeOnHandService);
    // Both controllers' @UseGuards(RolesGuard) resolve it from this module.
    expect(moduleRef.get(RolesGuard)).toBeInstanceOf(RolesGuard);
    await moduleRef.close();
  });
});
