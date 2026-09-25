/**
 * ReadDownController — 010 US1-SNAPSHOT (T035).
 *
 * Implements `posGetCatalogSnapshot` from
 * `packages/contracts/openapi/catalog/read-down.yaml`:
 *   GET /api/pos/v1/catalog/snapshot → the Resolved Sellable Store Catalogue
 *   for the device principal's (tenant_id, store_id), cursor-paginated.
 *
 * Auth / context: `@UseGuards(PosDeviceAuthGuard)` authenticates the POS
 * terminal by its `devices` PAIRING TOKEN alone — no operator session (issue
 * #488, Option B-prime) — and resolves the device principal's
 * `(tenant_id, store_id)` from the store-bound device row onto `req.context`.
 * Tenant/store come from there and are NEVER read from the body/query as
 * authority (FR-002/061). A supplied `branch_id` is validated against the
 * device's store scope; a mismatch is a NON-DISCLOSING 404 (FR-002/003/004),
 * never an explicit "wrong store". (The shared `PosOperatorAuthGuard` is NOT
 * used here: it requires an operator-session `pos_operator` scope the
 * background read-down has no way to present.)
 *
 * Audit: `@Auditable("catalog.snapshot.read")` is passive metadata read by the
 * global AuditEmitterInterceptor (FR-080 read-access audit).
 *
 * READ-ONLY — GET only, no write surface.
 */
import {
  ConflictException,
  Controller,
  Get,
  NotFoundException,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";

import { Auditable } from "../../audit/auditable.decorator";
import { PosDeviceAuthGuard } from "../../auth/pos-device-auth.guard";
import { DeviceBearer } from "../../auth/route-auth";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import type { TenantContextRequest } from "../../context/types";
import {
  BranchIdSchema,
  LimitSchema,
  PageTokenSchema,
  SinceSchema,
} from "./dto/snapshot-query.dto";
import { ReadDownCursorError } from "./read-down.cursor";
import {
  ReadDownService,
  type CatalogDeltaPage,
  type CatalogSnapshotPage,
} from "./read-down.service";

/** 409 thrown for a stale/unservable `since` cursor (contract snapshot_required). */
class SnapshotRequiredException extends ConflictException {
  constructor() {
    super("snapshot_required");
  }
}

@Controller()
export class ReadDownController {
  constructor(private readonly readDown: ReadDownService) {}

  @Get("api/pos/v1/catalog/snapshot")
  @DeviceBearer()
  @UseGuards(PosDeviceAuthGuard)
  @Auditable("catalog.snapshot.read")
  async getSnapshot(
    @Req() request: TenantContextRequest,
    @Query("branch_id", new ZodValidationPipe(BranchIdSchema))
    branchId: string | undefined,
    @Query("page_token", new ZodValidationPipe(PageTokenSchema))
    pageToken: string | undefined,
    @Query("limit", new ZodValidationPipe(LimitSchema))
    limit: number | undefined,
  ): Promise<CatalogSnapshotPage> {
    const ctx = request.context;
    if (!ctx || ctx.tenantId === null) {
      throw new UnauthorizedException("Unauthorized");
    }
    if (ctx.storeId === null) {
      // The read is store-scoped: a POS principal with no resolved store
      // cannot snapshot a catalogue (FR-005). Reuse the existing POS code.
      throw new UnauthorizedException("store_context_required");
    }
    // FR-002/003/004 — a supplied branch_id MUST match the device token's
    // resolved store scope. A mismatch reveals nothing (non-disclosing 404),
    // identical to an absent store.
    if (branchId !== undefined && branchId !== ctx.storeId) {
      throw new NotFoundException("not_found");
    }

    try {
      return await this.readDown.getSnapshot(ctx.tenantId, ctx.storeId, {
        limit,
        pageToken: pageToken ?? null,
      });
    } catch (err) {
      if (err instanceof ReadDownCursorError) {
        // A malformed / foreign-scope page_token is non-disclosing (FR-024).
        throw new NotFoundException("not_found");
      }
      throw err;
    }
  }

  @Get("api/pos/v1/catalog/deltas")
  @DeviceBearer()
  @UseGuards(PosDeviceAuthGuard)
  @Auditable("catalog.deltas.read")
  async getDeltas(
    @Req() request: TenantContextRequest,
    @Query("since", new ZodValidationPipe(SinceSchema)) since: string,
    @Query("branch_id", new ZodValidationPipe(BranchIdSchema))
    branchId: string | undefined,
    @Query("limit", new ZodValidationPipe(LimitSchema))
    limit: number | undefined,
  ): Promise<CatalogDeltaPage> {
    const ctx = request.context;
    if (!ctx || ctx.tenantId === null) {
      throw new UnauthorizedException("Unauthorized");
    }
    if (ctx.storeId === null) {
      throw new UnauthorizedException("store_context_required");
    }
    if (branchId !== undefined && branchId !== ctx.storeId) {
      throw new NotFoundException("not_found");
    }

    try {
      const result = await this.readDown.getDeltas(
        ctx.tenantId,
        ctx.storeId,
        since,
        { limit },
      );
      if (result.kind === "snapshot_required") {
        // Stale/unservable cursor → 409 re-baseline directive (FR-023).
        throw new SnapshotRequiredException();
      }
      return result.page;
    } catch (err) {
      if (err instanceof ReadDownCursorError) {
        // A malformed / foreign-scope `since` cursor is non-disclosing (FR-024).
        throw new NotFoundException("not_found");
      }
      throw err;
    }
  }
}
