/**
 * ReadDownModule — 010-SETUP (T002 skeleton).
 *
 * Scaffolds the new READ-ONLY catalogue publication surface that 010
 * introduces: it serves the Resolved Sellable Store Catalogue (003 §6.4) to
 * device-authenticated POS terminals as snapshot + delta, scoped to
 * `(tenant_id, store_id)` (wire term `branch_id`). It is the opposite
 * direction of 005 (capture-UP) and MUST NOT be conflated with it.
 *
 * This slice creates an EMPTY module only — no controller, no service, no
 * routes. Subsequent slices fill it in incrementally:
 *   - 010-CONTRACT  ([GATED]) — the OpenAPI read-down contract
 *                               (packages/contracts/openapi/catalog/read-down.yaml).
 *   - 010-SCHEMA    ([GATED]) — the 0015 catalogue change-log migration +
 *                               Drizzle schema + population triggers (R1/R9).
 *   - 010-US1-SNAPSHOT 🎯 MVP — adds read-down.controller.ts +
 *                               read-down.service.ts + the toBody() projection
 *                               and the first `posGetCatalogSnapshot` route.
 *   - 010-US2-DELTA          — adds the `posGetCatalogDeltas` route (shares the
 *                               controller/service → serialized after US1).
 *
 * 010-US1-SNAPSHOT adds the snapshot route surface + the import set below
 * (mirroring SalesModule / ReconciliationModule):
 *   - AuthModule    — provides PG_POOL (shared pool) + PosOperatorAuthGuard
 *                     (the device-principal guard `posCaptureItem` + the 008
 *                     sales POS routes use).
 *   - ContextModule — provides TenantContextGuard / scope resolution.
 *   - AuditModule   — registers the global AuditEmitterInterceptor that the
 *                     `@Auditable("catalog.snapshot.read")` read-access audit
 *                     (FR-080) triggers.
 * 010-US2-DELTA adds the `posGetCatalogDeltas` route to the SAME
 * controller/service (serialized after US1).
 *
 * The platform stays the catalogue authority (§IX); there is NO write surface
 * (GET only). Registered in app.module.ts at SETUP time (per the 010
 * execution-map allowed_files).
 */
import { Module } from "@nestjs/common";

import type { Pool } from "pg";

import { AuditModule } from "../../audit/audit.module";
import { AUTH_LOOKUP_POOL, AuthModule } from "../../auth/auth.module";
import { PosDeviceAuthGuard } from "../../auth/pos-device-auth.guard";
import { ContextModule } from "../../context/context.module";
import { DeviceRepository } from "../../pos-operators/device.repository";
import { ReadDownController } from "./read-down.controller";
import { ReadDownService } from "./read-down.service";

@Module({
  imports: [AuthModule, ContextModule, AuditModule],
  controllers: [ReadDownController],
  providers: [
    ReadDownService,
    // 010 read-down authenticates a POS terminal by its `devices` pairing
    // token alone (no operator session) — issue #488, Option B-prime. The
    // guard resolves `(tenant_id, store_id)` from the store-bound device row
    // via DeviceRepository, which only needs the shared admin pool (PG_POOL,
    // provided by AuthModule). Mirrors PosOperatorsModule's provider shape.
    {
      provide: DeviceRepository,
      useFactory: (pool: Pool): DeviceRepository => new DeviceRepository(pool),
      inject: [AUTH_LOOKUP_POOL],
    },
    PosDeviceAuthGuard,
  ],
  exports: [ReadDownService],
})
export class ReadDownModule {}
