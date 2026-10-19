/**
 * ConsoleCatalogModule — RT-730 (CAT-R2): the console read of the Tenant
 * Catalog (`catalog/console-catalog.yaml`, RT-729). Read only, not audited
 * per request (RT-281 O-6).
 *
 * Imports:
 *   - `AuthModule`    — `PG_POOL` + the session/token repositories the
 *                       session-only `SessionOnlyAdminGuard` uses.
 *   - `ContextModule` — `TenantContextGuard` (publishes `request.context`) and
 *                       `MembershipRepository` (the caller's role → store scope).
 */
import { Module } from "@nestjs/common";

import { AuthModule } from "../../auth/auth.module";
import { ContextModule } from "../../context/context.module";
import { ConsoleCatalogController } from "./console-catalog.controller";
import { ConsoleCatalogReadService } from "./console-catalog.service";

@Module({
  imports: [AuthModule, ContextModule],
  controllers: [ConsoleCatalogController],
  providers: [ConsoleCatalogReadService],
})
export class ConsoleCatalogModule {}
